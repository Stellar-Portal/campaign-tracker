-- Creator scorecard: one row per creator. Applied 2026-11-26 via apply_migration "creator_scorecard" (cost-per-1k fix re-applied as "creator_scorecard_cost").
-- security_invoker: the RLS of creators, posts, payout_rows, campaigns, creator_drafts, post_daily_stats
-- and fx_rates applies (team only). Never exposed by the share function.
-- Money: payout_rows in the campaign's currency (null = USD), converted with the latest ECB rate in
-- fx_rates (amount / per_usd, the same as app.js and analytics.js). Older creator_costs rows are not
-- counted (they have their own currency and can sit next to payout rows for the same creator).
-- Views: latest plays per video (same as post_latest_stats), all posts the creator has in the tracker.

create index if not exists payout_rows_creator_id_idx on public.payout_rows (creator_id);
create index if not exists creator_drafts_creator_idx on public.creator_drafts (creator_id);
create index if not exists creator_drafts_replaces_idx on public.creator_drafts (replaces_id) where replaces_id is not null;

create or replace view public.creator_scorecard with (security_invoker = true) as
with pr as not materialized (
  select r.creator_id, r.campaign_id, r.status,
         coalesce(r.amount, r.videos::numeric * r.price_per_video, 0) as amt,
         coalesce(nullif(c.currency, ''), 'USD') as cur
  from public.payout_rows r
  join public.campaigns c on c.id = r.campaign_id
  where r.creator_id is not null
),
paid_cur as (
  select pr.creator_id, pr.cur, sum(pr.amt) as amt
  from pr where pr.status = 'paid'
  group by pr.creator_id, pr.cur
),
paid as (
  select pc.creator_id,
         sum(case when pc.cur = 'USD' then pc.amt else pc.amt / fx.per_usd end) as paid_total_usd,
         jsonb_object_agg(pc.cur, pc.amt) as paid_by_currency,
         bool_or(pc.cur <> 'USD' and fx.per_usd is null) as paid_fx_missing
  from paid_cur pc
  left join public.fx_rates fx on fx.currency = pc.cur and fx.per_usd > 0
  group by pc.creator_id
),
pv as materialized (
  -- Latest plays per video = post_latest_stats, but as a top-1 lookup on the
  -- (tiktok_video_id, stat_date) primary key so it scales with posts, not with daily rows.
  -- Computed once (materialized) because four parts below use it.
  select p.creator_id, p.campaign_id, p.id as post_id,
         coalesce(p.published_at, p.created_at) as posted_at,
         coalesce(s.plays, 0) as views
  from public.posts p
  left join lateral (
    select d.plays from public.post_daily_stats d
    where d.tiktok_video_id = p.tiktok_video_id
    order by d.stat_date desc limit 1
  ) s on true
  where p.creator_id is not null
),
post_agg as (
  select pv.creator_id, count(*) as videos, sum(pv.views) as views
  from pv group by pv.creator_id
),
cost as (
  -- Cost per 1k views only over campaigns where the creator was paid AND has views in the tracker,
  -- so a paid campaign without tracked videos doesn't inflate it.
  select pu.creator_id, sum(pu.usd) as paid_usd, sum(cv.views) as views, bool_or(pu.fx_missing) as fx_missing
  from (select pr.creator_id, pr.campaign_id,
               sum(case when pr.cur = 'USD' then pr.amt else pr.amt / fx.per_usd end) as usd,
               bool_or(pr.cur <> 'USD' and fx.per_usd is null) as fx_missing
        from pr left join public.fx_rates fx on fx.currency = pr.cur and fx.per_usd > 0
        where pr.status = 'paid'
        group by pr.creator_id, pr.campaign_id) pu
  join (select creator_id, campaign_id, sum(views) as views from pv group by creator_id, campaign_id) cv
    on cv.creator_id = pu.creator_id and cv.campaign_id = pu.campaign_id
  where cv.views > 0
  group by pu.creator_id
),
camps as (
  select creator_id, campaign_id from pr
  union
  select creator_id, campaign_id from pv
),
camp_agg as (
  select x.creator_id, count(*) as campaigns,
         max(coalesce(c.start_date, c.created_at::date)) as last_campaign_at
  from camps x join public.campaigns c on c.id = x.campaign_id
  group by x.creator_id
),
replaced as (
  select distinct replaces_id as id from public.creator_drafts where replaces_id is not null
),
drafts as not materialized (
  -- Sent = every draft except one the creator withdrew before anyone looked at it.
  -- Got changes = current status changes/client_changes, or it was replaced by a new upload
  -- (the portal only sets replaces_id when the old draft was sent back for changes).
  select d.creator_id, d.campaign_id, d.created_at,
         (d.status <> 'withdrawn' or d.reviewed_at is not null or rp.id is not null) as sent,
         (d.status in ('changes', 'client_changes') or rp.id is not null) as got_changes
  from public.creator_drafts d
  left join replaced rp on rp.id = d.id
),
draft_agg as (
  select creator_id,
         count(*) filter (where sent) as drafts_sent,
         count(*) filter (where sent and got_changes) as drafts_changes
  from drafts group by creator_id
),
draft_to_post as (
  -- Per campaign: first draft upload -> first post published on/after it; then the average.
  select fp.creator_id, avg(extract(epoch from (fp.first_post - fp.first_draft)) / 86400.0) as avg_days
  from (
    select f.creator_id, f.campaign_id, f.first_draft, min(pv.posted_at) as first_post
    from (select creator_id, campaign_id, min(created_at) as first_draft
          from drafts where sent group by creator_id, campaign_id) f
    join pv on pv.creator_id = f.creator_id and pv.campaign_id = f.campaign_id and pv.posted_at >= f.first_draft
    group by f.creator_id, f.campaign_id, f.first_draft
  ) fp
  group by fp.creator_id
)
select cr.id as creator_id,
       cr.username,
       cr.display_name,
       cr.platform,
       cr.avatar_url,
       cr.on_roster,
       coalesce(ca.campaigns, 0) as campaigns,
       coalesce(pa.videos, 0) as videos,
       coalesce(pa.views, 0) as views,
       round(coalesce(p.paid_total_usd, 0), 2) as paid_total_usd,
       coalesce(p.paid_by_currency, '{}'::jsonb) as paid_by_currency,
       coalesce(p.paid_fx_missing, false) as paid_fx_missing,
       coalesce(co.views, 0) as views_paid_campaigns,
       case when co.views > 0 and co.paid_usd is not null
            then round(co.paid_usd / co.views * 1000, 4) end as cost_per_1k_views_usd,
       coalesce(da.drafts_sent, 0) as drafts_sent,
       coalesce(da.drafts_changes, 0) as drafts_changes,
       case when coalesce(da.drafts_sent, 0) > 0 then round(da.drafts_changes::numeric / da.drafts_sent, 3) end as change_rate,
       round(dp.avg_days::numeric, 1) as avg_days_draft_to_post,
       ca.last_campaign_at
from public.creators cr
left join camp_agg ca on ca.creator_id = cr.id
left join post_agg pa on pa.creator_id = cr.id
left join paid p on p.creator_id = cr.id
left join cost co on co.creator_id = cr.id
left join draft_agg da on da.creator_id = cr.id
left join draft_to_post dp on dp.creator_id = cr.id;

revoke all on public.creator_scorecard from anon, public;
grant select on public.creator_scorecard to authenticated;
