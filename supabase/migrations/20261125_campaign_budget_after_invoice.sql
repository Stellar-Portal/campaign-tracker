-- When a campaign's budget changes after it was invoiced, post a note in the campaign chat that tags finance
-- (team_members.role = 'finance'). Applied 2026-11-25.
create or replace function private.budget_change_note() returns trigger
language plpgsql security definer set search_path = public, private as $$
declare
  v_inv numeric; v_n int; v_tags text; v_cur text := coalesce(new.currency, 'USD');
  fmt constant text := 'FM999G999G999G990D00';
begin
  if new.budget is not distinct from old.budget then return new; end if;
  select coalesce(sum(amount), 0), count(*) into v_inv, v_n
    from invoice_requests where campaign_id = new.id and status in ('invoiced', 'paid');
  if v_n = 0 then return new; end if;
  select string_agg('@' || name, ' ' order by name) into v_tags
    from team_members where role = 'finance' and coalesce(name, '') <> '';
  begin
    insert into campaign_messages (campaign_id, author_email, body)
    values (new.id, 'Stellar OS', concat_ws(' ', v_tags,
      format('The budget changed from %s to %s %s after this campaign was invoiced (%s %s invoiced so far).',
        trim(to_char(coalesce(old.budget, 0), fmt)), trim(to_char(coalesce(new.budget, 0), fmt)), v_cur,
        trim(to_char(v_inv, fmt)), v_cur),
      case when coalesce(new.budget, 0) < v_inv then 'A credit note for the difference may be needed.'
           else 'The difference still needs an invoice request.' end));
  exception when others then null; -- a chat note never blocks a budget save
  end;
  return new;
end $$;
revoke all on function private.budget_change_note() from public;

create or replace trigger campaigns_budget_after_invoice
  after update of budget on public.campaigns
  for each row execute function private.budget_change_note();
