-- Campaign wrap-up checklist. Applied 2026-11-26 via apply_migration "campaign_wrapup".
-- campaigns.wrapup = manual ticks keyed by item id: {"final_report_sent": {"done_by": "...", "done_at": "..."}}.
-- campaign_wrapup(p) = automatic checks from data + the manual ticks. campaign_wrapup_tick sets/removes one.

alter table public.campaigns add column if not exists wrapup jsonb not null default '{}'::jsonb;

-- A wrap-up tick changes nothing the sheet shows, so it must not queue a sheet push: a queued push
-- makes "the platform wins" and would throw away a sheet edit made in the same few minutes.
-- Only skips when wrapup changed and nothing else (besides updated_at); every other update queues as before.
create or replace function private.queue_sheet_sync_campaign()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
begin
  if tg_op = 'UPDATE' and new.wrapup is distinct from old.wrapup
     and (to_jsonb(new) - 'wrapup' - 'updated_at') = (to_jsonb(old) - 'wrapup' - 'updated_at') then
    return null;
  end if;
  insert into public.campaign_sheet_sync (campaign_id, due_at) values (new.id, now() + interval '5 seconds')
  on conflict (campaign_id) do update set due_at = now() + interval '5 seconds', attempts = 0;
  return null;
end $function$;

create or replace function public.campaign_wrapup(p_campaign uuid)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  c public.campaigns;
  manual_ids constant text[] := array['final_report_sent', 'client_feedback', 'case_study', 'drafts_cleanup_ok'];
  v_cur text;
  pr record; inv record; dr record;
  v_links int; v_artist_links int;
  auto jsonb; manual jsonb := '{}'::jsonb; k text;
  n_ok int := 0; n_auto int := 0; n_manual int := 0;
  v_videos_ok boolean; v_paid_ok boolean; v_inv_ok boolean; v_invpaid_ok boolean;
begin
  if not private.is_team_member() then
    raise exception 'Only the Stellar team can see this.' using errcode = '42501';
  end if;
  select * into c from public.campaigns where id = p_campaign;
  if not found then
    raise exception 'That campaign was not found.' using errcode = 'P0002';
  end if;
  v_cur := coalesce(nullif(c.currency, ''), 'USD');

  select count(*) as rows_total,
         count(*) filter (where status in ('posted', 'paid')) as rows_done,
         coalesce(sum(coalesce(videos, 0)), 0) as videos_total,
         coalesce(sum(coalesce(videos, 0)) filter (where status in ('posted', 'paid')), 0) as videos_done,
         count(*) filter (where status <> 'paid') as unpaid,
         coalesce(sum(coalesce(amount, videos::numeric * price_per_video, 0)) filter (where status <> 'paid'), 0) as unpaid_amount
    into pr from public.payout_rows where campaign_id = p_campaign;

  select count(*) as n,
         coalesce(sum(amount), 0) as invoiced,
         coalesce(sum(amount) filter (where currency = v_cur), 0) as invoiced_same_cur,
         count(*) filter (where currency <> v_cur) as other_cur,
         count(*) filter (where status <> 'paid') as open,
         count(*) filter (where status in ('requested', 'returned')) as not_sent
    into inv from public.invoice_requests where campaign_id = p_campaign and status <> 'cancelled';

  select count(*) filter (where status = 'submitted') as for_team,
         count(*) filter (where status = 'team_ok') as for_client
    into dr from public.creator_drafts where campaign_id = p_campaign;

  select count(*) into v_links from public.share_links
    where campaign_id = p_campaign and not revoked and (expires_at is null or expires_at > now());
  select count(*) into v_artist_links from public.share_links
    where campaign_id is null and not revoked and (expires_at is null or expires_at > now())
      and lower(btrim(artist)) = lower(btrim(c.artist));

  v_videos_ok := case when pr.rows_total = 0 then null else pr.rows_done = pr.rows_total end;
  v_paid_ok := case when pr.rows_total = 0 then null else pr.unpaid = 0 end;
  v_inv_ok := case when coalesce(c.budget, 0) = 0 then null
                   when inv.other_cur > 0 then false
                   else inv.invoiced_same_cur >= c.budget - 0.005 end;
  v_invpaid_ok := case when inv.n = 0 then null else inv.open = 0 end;

  auto := jsonb_build_object(
    'videos_in', jsonb_build_object('ok', v_videos_ok,
       'rows_done', pr.rows_done, 'rows_total', pr.rows_total,
       'videos_done', pr.videos_done, 'videos_total', pr.videos_total),
    'creators_paid', jsonb_build_object('ok', v_paid_ok,
       'unpaid', pr.unpaid, 'unpaid_amount', pr.unpaid_amount, 'currency', v_cur),
    'invoiced', jsonb_build_object('ok', v_inv_ok,
       'budget', c.budget, 'currency', v_cur,
       'invoiced', inv.invoiced_same_cur,
       'left', case when c.budget is null then null else c.budget - inv.invoiced_same_cur end,
       'over', coalesce(inv.invoiced_same_cur > c.budget + 0.005, false),
       'other_currency_requests', inv.other_cur, 'requests', inv.n),
    'invoices_paid', jsonb_build_object('ok', v_invpaid_ok,
       'open', inv.open, 'not_sent', inv.not_sent, 'requests', inv.n),
    'drafts_waiting', jsonb_build_object('ok', (dr.for_team + dr.for_client) = 0,
       'for_team', dr.for_team, 'for_client', dr.for_client),
    'report_link', jsonb_build_object('ok', (v_links + v_artist_links) > 0,
       'campaign_links', v_links, 'artist_links', v_artist_links),
    'ended', jsonb_build_object('ok', coalesce(c.end_date < current_date, false), 'end_date', c.end_date),
    'finished', jsonb_build_object('ok', c.status = 'finished', 'status', c.status)
  );

  select count(*) filter (where (v.value ->> 'ok')::boolean), count(*) filter (where v.value ->> 'ok' is not null)
    into n_ok, n_auto from jsonb_each(auto) v;

  foreach k in array manual_ids loop
    manual := manual || jsonb_build_object(k, jsonb_build_object(
      'done', c.wrapup ? k,
      'done_by', c.wrapup -> k ->> 'done_by',
      'done_at', c.wrapup -> k ->> 'done_at'));
    if c.wrapup ? k then n_manual := n_manual + 1; end if;
  end loop;

  return jsonb_build_object(
    'campaign_id', c.id,
    'auto', auto,
    'manual', manual,
    'summary', jsonb_build_object(
      'auto_ok', n_ok, 'auto_total', n_auto,
      'manual_done', n_manual, 'manual_total', array_length(manual_ids, 1),
      'all_done', n_ok = n_auto and n_manual = array_length(manual_ids, 1))
  );
end
$$;

create or replace function public.campaign_wrapup_tick(p_campaign uuid, p_item text, p_done boolean)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare v_email text := lower(coalesce(auth.jwt() ->> 'email', ''));
begin
  if not private.is_team_member() then
    raise exception 'Only the Stellar team can change this.' using errcode = '42501';
  end if;
  if p_item is null or p_item <> all (array['final_report_sent', 'client_feedback', 'case_study', 'drafts_cleanup_ok']) then
    raise exception 'Unknown wrap-up item.' using errcode = '22023';
  end if;
  if not exists (select 1 from public.campaigns where id = p_campaign) then
    raise exception 'That campaign was not found.' using errcode = 'P0002';
  end if;
  -- Only writes when something changes: a second click keeps the first tick's name and time,
  -- and an untick of an unticked item is a no-op.
  update public.campaigns
     set wrapup = case when coalesce(p_done, false)
                       then wrapup || jsonb_build_object(p_item, jsonb_build_object('done_by', v_email, 'done_at', now()))
                       else wrapup - p_item end
   where id = p_campaign and (wrapup ? p_item) is distinct from coalesce(p_done, false);
  return public.campaign_wrapup(p_campaign);
end
$$;

revoke all on function public.campaign_wrapup(uuid) from public, anon;
revoke all on function public.campaign_wrapup_tick(uuid, text, boolean) from public, anon;
grant execute on function public.campaign_wrapup(uuid) to authenticated;
grant execute on function public.campaign_wrapup_tick(uuid, text, boolean) to authenticated;
