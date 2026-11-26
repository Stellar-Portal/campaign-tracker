-- Monthly retainers (applied 2026-11-26).
-- campaigns.retainer_amount / retainer_day (1–28) / retainer_until: an active campaign with an amount and a day
-- gets one invoice request per month, made by private.create_retainer_requests() (pg_cron 'retainer-requests',
-- 06:15 UTC daily, plain SQL, no HTTP). Finance is told by the invoice_requests_notify trigger (no second alert).
-- Backstop against doubles: invoice_requests.retainer_month + unique (campaign_id, retainer_month).
-- retainer_* edits don't queue a sheet push (private.queue_sheet_sync_campaign, see 20261126_sheet_sync_campaign_merge.sql).

alter table public.campaigns
  add column if not exists retainer_amount numeric,
  add column if not exists retainer_day    int,
  add column if not exists retainer_until  date;
alter table public.campaigns
  add constraint campaigns_retainer_amount_pos check (retainer_amount is null or retainer_amount > 0),
  add constraint campaigns_retainer_day_range check (retainer_day is null or retainer_day between 1 and 28);

alter table public.invoice_requests add column if not exists retainer_month date;   -- first day of the month billed
create unique index if not exists invoice_requests_retainer_month
  on public.invoice_requests (campaign_id, retainer_month) where retainer_month is not null;

-- Inserting an invoice request used to touch campaigns.invoiced even when it didn't change, which queued a
-- full sheet push for every request. Now it only writes when the value really changes.
create or replace function public.sync_campaign_invoiced()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v boolean; cid uuid := coalesce(new.campaign_id, old.campaign_id);
begin
  v := exists (select 1 from public.invoice_requests r where r.campaign_id = cid and r.status in ('invoiced', 'paid'));
  update public.campaigns c set invoiced = v where c.id = cid and c.invoiced is distinct from v;
  if tg_op = 'UPDATE' and old.campaign_id is distinct from new.campaign_id then
    v := exists (select 1 from public.invoice_requests r where r.campaign_id = old.campaign_id and r.status in ('invoiced', 'paid'));
    update public.campaigns c set invoiced = v where c.id = old.campaign_id and c.invoiced is distinct from v;
  end if;
  return null;
end $$;

-- Runs daily. Makes this month's request on retainer_day, or up to 3 days later if a run was missed.
create or replace function private.create_retainer_requests(p_today date default (now() at time zone 'UTC')::date)
returns int language plpgsql security definer set search_path = '' as $$
declare
  c record; e record;
  v_month date := date_trunc('month', p_today)::date;
  v_note text := 'Monthly retainer · ' || to_char(p_today, 'FMMonth YYYY');
  v_lines jsonb; v_alloc jsonb; v_id uuid; made int := 0;
begin
  for c in
    select * from public.campaigns
     where status = 'active' and retainer_amount > 0 and retainer_day between 1 and 28
       and p_today between make_date(extract(year from p_today)::int, extract(month from p_today)::int, retainer_day)
                       and make_date(extract(year from p_today)::int, extract(month from p_today)::int, retainer_day) + 3
       and (retainer_until is null or p_today <= retainer_until)
  loop
    begin
      if exists (select 1 from public.invoice_requests r where r.campaign_id = c.id
                  and (r.retainer_month = v_month or r.notes = v_note)) then
        continue;
      end if;
      select * into e from public.client_entities where id = c.client_entity_id;
      -- The campaign's market split, scaled to the retainer amount (last line takes the rounding).
      with m as (
        select mk.name, mk.region, mk."position",
               coalesce(cm.amount, c.budget * cm.share_percent / 100) as base
          from public.campaign_markets cm join public.markets mk on mk.name = cm.market
         where cm.campaign_id = c.id
      ), w as (
        select name, region, "position", base, sum(base) over () as total,
               row_number() over (order by "position" desc) as rn_last
          from m where base > 0
      ), l as (
        select name, region, "position",
               case when rn_last = 1
                    then c.retainer_amount - coalesce(sum(round(c.retainer_amount * base / total, 2)) over (order by "position" rows between unbounded preceding and 1 preceding), 0)
                    else round(c.retainer_amount * base / total, 2) end as amount
          from w where total > 0
      )
      select coalesce(jsonb_agg(jsonb_build_object('market', name, 'amount', amount) order by "position"), '[]'::jsonb),
             (select jsonb_agg(jsonb_build_object('region', region, 'amount', a) order by region)
                from (select region, sum(amount) a from l group by region) g)
        into v_lines, v_alloc
        from l;

      insert into public.invoice_requests (
        campaign_id, status, amount, currency, payment_terms, po_number, client, invoicing_entity, client_entity_id,
        lines, uses_portal, portal_name, notes, requested_by,
        responsible, artist, song, label_type, territory, contact_name, contact_email, send_via, allocation, retainer_month)
      values (
        c.id, 'requested', c.retainer_amount, coalesce(nullif(c.currency, ''), 'USD'),
        case when e.payment_terms between 0 and 180 then e.payment_terms else 30 end,
        c.po_number, c.client, coalesce(nullif(c.invoicing_entity, ''), e.legal_name), c.client_entity_id,
        coalesce(v_lines, '[]'::jsonb), coalesce(e.uses_portal, false), case when e.uses_portal then e.portal_name end,
        v_note, 'Stellar OS (monthly)',
        c.comms_owner, c.artist, c.song, c.label_type, nullif(regexp_replace(coalesce(c.client_market, ''), '^Stellar\s+', ''), ''),
        c.client_contact_name, c.client_contact_email, case when e.uses_portal then e.portal_name end, v_alloc, v_month)
      on conflict (campaign_id, retainer_month) where retainer_month is not null do nothing
      returning id into v_id;
      if v_id is not null then made := made + 1; end if;
      v_id := null;
    exception when others then
      raise warning 'create_retainer_requests %: %', c.id, sqlerrm;   -- one bad campaign never stops the others
    end;
  end loop;
  return made;
end $$;
revoke execute on function private.create_retainer_requests(date) from public, anon, authenticated;

do $$ begin
  if exists (select 1 from cron.job where jobname = 'retainer-requests') then
    perform cron.unschedule('retainer-requests');
  end if;
  perform cron.schedule('retainer-requests', '15 6 * * *', 'select private.create_retainer_requests()');
end $$;
