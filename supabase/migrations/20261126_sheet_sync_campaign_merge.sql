-- Merge of two same-day edits to private.queue_sheet_sync_campaign() (applied 2026-11-26):
-- * campaign_wrapup: a wrap-up-only edit doesn't queue a sheet push;
-- * sheet_cost_from_spend: every campaign push is a full push (cost_only = false);
-- * monthly retainers: retainer_* columns aren't in the sheet either, so an edit of only those
--   doesn't queue a push. A no-op update still queues (as before).
-- Anyone replacing this function again must keep all three.
create or replace function private.queue_sheet_sync_campaign()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  n jsonb; o jsonb;
  quiet constant text[] := array['wrapup', 'retainer_amount', 'retainer_day', 'retainer_until'];
begin
  if tg_op = 'UPDATE' then
    n := to_jsonb(new); o := to_jsonb(old);
    if exists (select 1 from unnest(quiet) k where n -> k is distinct from o -> k)
       and (n - quiet - 'updated_at') = (o - quiet - 'updated_at') then
      return null;   -- only columns the sheet doesn't have changed
    end if;
  end if;
  insert into public.campaign_sheet_sync (campaign_id, due_at, cost_only) values (new.id, now() + interval '5 seconds', false)
  on conflict (campaign_id) do update set due_at = now() + interval '5 seconds', attempts = 0, cost_only = false;
  return null;
end $$;
