-- Applied 2026-11-24 (Sam said yes).
-- Note: applied with "create or replace trigger" instead of the plain "create trigger" below.
-- A campaign with a money trail (invoices that aren't cancelled, creators marked paid) is archived, never deleted.
-- PayPal payments already block it through their foreign key. A campaign made by mistake (no money trail) can still be deleted.
-- The OS already checks this before deleting (moneyTrail/archiveInstead in app.js); this is the database backstop.
create or replace function private.campaigns_keep_money_trail() returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from public.invoice_requests where campaign_id = old.id and status <> 'cancelled')
     or exists (select 1 from public.payout_rows where campaign_id = old.id and status = 'paid') then
    raise exception 'This campaign has invoices or paid creators, so it can''t be deleted. Mark it Completed to archive it.'
      using errcode = 'P0001';
  end if;
  return old;
end $$;
create trigger campaigns_keep_money_trail before delete on public.campaigns for each row execute function private.campaigns_keep_money_trail();
