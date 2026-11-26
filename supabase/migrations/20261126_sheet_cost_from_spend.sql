-- Campaign Overview sheet: "Campaign Cost" / "Margin" from real spend (applied 2026-11-26).
-- cost = exactly campaign_summary.spend: creator_costs.agreed_price + payout_rows
-- coalesce(amount, videos * price_per_video, 0), every payout row whatever its status.
-- cost_lines = creator cost lines + payout rows that have a known amount, so a payout sheet
-- that only has "contacted" rows without a price never overwrites the sheet's typed cost with 0.
-- No currency conversion (payout_rows has no currency column: amounts are in the campaign currency).

create or replace view public.campaign_sheet_rows with (security_invoker = true) as
select c.id, c.artist, c.song, c.client, c.comms_owner, c.campaign_runner, c.start_date, c.end_date,
  c.budget, c.currency, c.invoiced, c.status, c.notes, c.created_by, c.created_at, c.updated_at,
  c.po_number, c.release_type, c.invoicing_entity, c.client_country, c.client_market,
  c.client_contact_name, c.client_contact_email, c.label_type, c.under_nda, c.campaign_type,
  c.folders_by_market,
  coalesce((select sum(k.agreed_price) from public.creator_costs k where k.campaign_id = c.id), 0::numeric)
    + coalesce((select sum(coalesce(r.amount, r.videos::numeric * r.price_per_video, 0::numeric))
                from public.payout_rows r where r.campaign_id = c.id), 0::numeric) as cost,
  (select count(*) from public.creator_costs k where k.campaign_id = c.id)
    + (select count(*) from public.payout_rows r where r.campaign_id = c.id
         and coalesce(r.amount, r.videos::numeric * r.price_per_video) is not null) as cost_lines,
  coalesce((select jsonb_agg(jsonb_build_object('market', mk.sheet_column, 'region', mk.region,
              'amount', coalesce(m.amount, round(c.budget * m.share_percent / 100::numeric, 2))) order by mk."position")
            from public.campaign_markets m join public.markets mk on mk.name = m.market
            where m.campaign_id = c.id), '[]'::jsonb) as allocations
from public.campaigns c;

-- Queue kind: cost_only = only Campaign Cost / Margin changed since the last push, so sheet-sync
-- may send just those two cells (and not overwrite other cells someone just edited in the sheet).
-- Inert until sheet-sync reads it; any campaign / market change sets it back to false (full push).
alter table public.campaign_sheet_sync add column if not exists cost_only boolean not null default false;

create or replace function private.queue_sheet_sync()
returns trigger language plpgsql security definer set search_path = '' as $$
declare cid uuid;
begin
  cid := case when tg_op = 'DELETE' then old.campaign_id else new.campaign_id end;
  if exists (select 1 from public.campaigns where id = cid) then
    insert into public.campaign_sheet_sync (campaign_id, due_at, cost_only) values (cid, now() + interval '5 seconds', false)
    on conflict (campaign_id) do update set due_at = now() + interval '5 seconds', attempts = 0, cost_only = false;
  end if;
  return null;
end $$;

create or replace function private.queue_sheet_sync_campaign()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.campaign_sheet_sync (campaign_id, due_at, cost_only) values (new.id, now() + interval '5 seconds', false)
  on conflict (campaign_id) do update set due_at = now() + interval '5 seconds', attempts = 0, cost_only = false;
  return null;
end $$;

-- payout_rows → sheet: only when the row's amount (or its campaign) really changes.
create or replace function private.queue_sheet_sync_spend()
returns trigger language plpgsql security definer set search_path = '' as $$
declare ids uuid[];
begin
  if tg_op = 'INSERT' then ids := array[new.campaign_id];
  elsif tg_op = 'DELETE' then ids := array[old.campaign_id];
  else
    if new.campaign_id is distinct from old.campaign_id then ids := array[old.campaign_id, new.campaign_id];
    elsif coalesce(new.amount, new.videos::numeric * new.price_per_video, 0)
          is distinct from coalesce(old.amount, old.videos::numeric * old.price_per_video, 0)
       or (coalesce(new.amount, new.videos::numeric * new.price_per_video) is null)
          is distinct from (coalesce(old.amount, old.videos::numeric * old.price_per_video) is null)
    then ids := array[new.campaign_id];
    else return null;
    end if;
  end if;
  insert into public.campaign_sheet_sync as s (campaign_id, due_at, cost_only)
    select x, now() + interval '5 seconds', false from unnest(ids) x
    where exists (select 1 from public.campaigns c where c.id = x)
  on conflict (campaign_id) do update set
    due_at = now() + interval '5 seconds', attempts = 0,
    cost_only = case when s.due_at is not null then s.cost_only          -- something already waiting: keep its kind
                     when s.synced_at is not null and s.last_error is null then true
                     else false end;
  return null;
end $$;
revoke execute on function private.queue_sheet_sync_spend() from public, anon, authenticated;

create or replace trigger payout_rows_sheet_sync
  after insert or delete or update of amount, videos, price_per_video, campaign_id on public.payout_rows
  for each row execute function private.queue_sheet_sync_spend();
