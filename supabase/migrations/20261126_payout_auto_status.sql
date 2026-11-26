-- Automatic payout statuses from the creator page (applied 2026-11-26).
-- Only ever forward, never past waiting_payment, never touches posted/paid.
-- contacted < waiting_draft < drafted < waiting_payment < posted < paid
--   creator page first opened         → at least waiting_draft
--   draft sent (creator_drafts insert) → at least drafted
--   draft approved (status → approved) → at least waiting_payment
-- Rows are matched by campaign_id + creator_id (every row of that creator on that campaign).
-- Logged by the existing payout_rows_log trigger (actor empty = automatic). Never blocks the write.

create or replace function private.payout_status_rank(p text)
returns int language sql immutable set search_path = '' as $$
  select case p when 'contacted' then 1 when 'waiting_draft' then 2 when 'drafted' then 3
                when 'waiting_payment' then 4 when 'posted' then 5 when 'paid' then 6 else 0 end
$$;

create or replace function private.payout_advance(p_campaign uuid, p_creator uuid, p_to text)
returns int language plpgsql security definer set search_path = '' as $$
declare n int;
begin
  if p_campaign is null or p_creator is null or p_to not in ('waiting_draft', 'drafted', 'waiting_payment') then return 0; end if;
  update public.payout_rows r set status = p_to
   where r.campaign_id = p_campaign and r.creator_id = p_creator
     and r.status in ('contacted', 'waiting_draft', 'drafted')
     and private.payout_status_rank(r.status) < private.payout_status_rank(p_to);
  get diagnostics n = row_count;
  return n;
end $$;

create or replace function private.portal_link_opened_status()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  begin
    perform private.payout_advance(new.campaign_id, new.creator_id, 'waiting_draft');
  exception when others then raise warning 'portal_link_opened_status: %', sqlerrm;
  end;
  return null;
end $$;

create or replace function private.draft_payout_status()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  begin
    if tg_op = 'INSERT' and new.status = 'submitted' then
      perform private.payout_advance(new.campaign_id, new.creator_id, 'drafted');
    elsif tg_op = 'UPDATE' and new.status = 'approved' and old.status is distinct from 'approved' then
      perform private.payout_advance(new.campaign_id, new.creator_id, 'waiting_payment');
    end if;
  exception when others then raise warning 'draft_payout_status: %', sqlerrm;
  end;
  return null;
end $$;

revoke execute on function private.payout_advance(uuid, uuid, text) from public, anon, authenticated;
revoke execute on function private.portal_link_opened_status() from public, anon, authenticated;
revoke execute on function private.draft_payout_status() from public, anon, authenticated;

create or replace trigger creator_portal_links_payout_status
  after update of opened_at on public.creator_portal_links
  for each row when (old.opened_at is null and new.opened_at is not null)
  execute function private.portal_link_opened_status();

create or replace trigger creator_drafts_payout_status
  after insert or update of status on public.creator_drafts
  for each row execute function private.draft_payout_status();
