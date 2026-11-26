-- Invoice plan (applied 2026-11-26). Replaces this morning's monthly retainer.
-- A plan = the parts a campaign's budget will be invoiced in (e.g. 6,000 = 2,000 x 3 monthly, all upfront, per song).
--   public.invoice_plan_parts        one row per part; request_id links the invoice request made for it.
--   public.invoice_plan_part_status  view: each part + its request's ref/status + computed status.
--   public.campaign_invoice_plan_state view: one row per campaign (for money flags in bulk).
--   public.campaign_invoice_plan(p_campaign)  jsonb for the campaign page.
--   public.invoice_plan_split(...)   makes equal parts (monthly or all on one day).
--   private.run_invoice_plan(p_today) daily (pg_cron 'invoice-plan', 06:15 UTC): due parts of active campaigns
--     get their request made by itself (auto_request) or the campaign people get one alert (reminded_at).
-- The old retainer columns (campaigns.retainer_amount/_day/_until, invoice_requests.retainer_month) and
-- private.create_retainer_requests() stay (additive rule) but are UNUSED. Its cron job 'retainer-requests' still runs and does
-- nothing (no campaign has a retainer); unschedule it with Sam's OK: select cron.unschedule('retainer-requests');
-- invoice_plan_split appends parts; the app removes old upcoming parts itself (p_replace is ignored).
-- A plan alone is not a money trail: campaigns_keep_money_trail is unchanged (invoiced parts already have a
-- non-cancelled invoice request, which blocks the delete).

create table if not exists public.invoice_plan_parts (
  id           uuid primary key default gen_random_uuid(),
  campaign_id  uuid not null references public.campaigns(id) on delete cascade,
  "position"   int  not null default 0,
  label        text,
  amount       numeric not null check (amount > 0),
  currency     text check (currency is null or currency ~ '^[A-Z]{3}$'),   -- null = the campaign's currency
  due_on       date,                                                      -- null = when ready
  auto_request boolean not null default true,
  request_id   uuid references public.invoice_requests(id) on delete set null,
  reminded_at  timestamptz,      -- when the daily job last acted on the part (alert sent); reset when due_on changes
  note         text,
  created_by   text default lower(coalesce(auth.jwt() ->> 'email', '')),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create unique index if not exists invoice_plan_parts_request on public.invoice_plan_parts (request_id) where request_id is not null;
create index if not exists invoice_plan_parts_campaign on public.invoice_plan_parts (campaign_id, "position");
create index if not exists invoice_plan_parts_due on public.invoice_plan_parts (due_on) where request_id is null;

alter table public.invoice_plan_parts enable row level security;
create policy "team manages invoice plan" on public.invoice_plan_parts for all to authenticated
  using ((select private.is_team_member())) with check ((select private.is_team_member()));
revoke all on public.invoice_plan_parts from anon, authenticated;
grant select, insert, update, delete on public.invoice_plan_parts to authenticated;

create trigger invoice_plan_parts_updated_at before update on public.invoice_plan_parts
  for each row execute function private.set_updated_at();

-- Backstop: a part whose request is invoiced or paid can't be deleted, moved to another campaign, change its amount
-- or currency, or be unlinked. A part with a live request (requested/returned) can't be pointed at another request
-- (stops a double request when two people, or a person and the daily job, request the same part).
-- A linked request must belong to the same campaign.
create or replace function private.invoice_plan_parts_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare o_ref bigint; o_status text; n_campaign uuid;
begin
  if tg_op in ('UPDATE', 'DELETE') and old.request_id is not null then
    select ref, status into o_ref, o_status from public.invoice_requests where id = old.request_id;
  end if;
  if tg_op = 'DELETE' then
    if o_status in ('invoiced', 'paid') then
      raise exception 'This part is already invoiced (request #%), so it can''t be removed.', o_ref using errcode = 'P0001';
    end if;
    return old;
  end if;
  if new.request_id is not null and new.request_id is distinct from (case when tg_op = 'UPDATE' then old.request_id end) then
    select campaign_id into n_campaign from public.invoice_requests where id = new.request_id;
    if n_campaign is distinct from new.campaign_id then
      raise exception 'That invoice request belongs to another campaign.' using errcode = 'P0001';
    end if;
  end if;
  if tg_op = 'UPDATE' then
    if o_status in ('invoiced', 'paid') and (new.amount <> old.amount
        or coalesce(new.currency, '') <> coalesce(old.currency, '')
        or new.campaign_id <> old.campaign_id
        or new.request_id is distinct from old.request_id) then
      raise exception 'This part is already invoiced (request #%), so its amount can''t change.', o_ref using errcode = 'P0001';
    end if;
    if o_status in ('requested', 'returned') and new.request_id is distinct from old.request_id then
      raise exception 'This part already has invoice request #%. Cancel that one first.', o_ref using errcode = 'P0001';
    end if;
    if new.due_on is distinct from old.due_on and new.reminded_at is not distinct from old.reminded_at then
      new.reminded_at := null;   -- a new date gets a new reminder
    end if;
  end if;
  return new;
end $$;
revoke execute on function private.invoice_plan_parts_guard() from public, anon, authenticated;
create trigger invoice_plan_parts_guard before insert or update or delete on public.invoice_plan_parts
  for each row execute function private.invoice_plan_parts_guard();

-- Each part with its request and status: upcoming | due | requested | returned | invoiced | paid.
-- A cancelled request counts as not requested. due = due_on today or earlier and nothing live requested.
create or replace view public.invoice_plan_part_status with (security_invoker = true) as
select p.id, p.campaign_id, p."position", p.label, p.amount, p.currency,
       coalesce(p.currency, nullif(c.currency, ''), 'USD') as effective_currency,
       p.due_on, p.auto_request, p.note, p.reminded_at, p.request_id,
       r.ref as request_ref, r.status as request_status,
       case when r.status in ('requested', 'returned', 'invoiced', 'paid') then r.status
            when p.due_on <= (now() at time zone 'utc')::date then 'due'
            else 'upcoming' end as status
  from public.invoice_plan_parts p
  join public.campaigns c on c.id = p.campaign_id
  left join public.invoice_requests r on r.id = p.request_id;
revoke all on public.invoice_plan_part_status from anon, authenticated;
grant select on public.invoice_plan_part_status to authenticated;

-- One row per campaign with a plan (for money flags on lists).
-- invoice_later = the plan has parts, none is due, and every part not yet requested has a date in the future
--   (parts "when ready" (no date) don't hold the flag back).
-- upcoming_total = parts still upcoming, in the campaign's currency (the "budget not fully invoiced" flag can subtract it).
create or replace view public.campaign_invoice_plan_state with (security_invoker = true) as
select s.campaign_id,
       count(*)::int as parts,
       count(*) filter (where s.status = 'due')::int as due_parts,
       min(s.due_on) filter (where s.status in ('upcoming', 'due')) as next_due_on,
       coalesce(sum(s.amount) filter (where s.status = 'upcoming' and s.effective_currency = coalesce(nullif(c.currency, ''), 'USD')), 0) as upcoming_total,
       coalesce(sum(s.amount) filter (where s.effective_currency = coalesce(nullif(c.currency, ''), 'USD')), 0) as total,
       (count(*) filter (where s.status = 'due') = 0
        and count(*) filter (where s.status = 'upcoming') > 0
        and count(*) filter (where s.status = 'upcoming' and s.due_on is null) = 0) as invoice_later
  from public.invoice_plan_part_status s
  join public.campaigns c on c.id = s.campaign_id
 group by s.campaign_id;
revoke all on public.campaign_invoice_plan_state from anon, authenticated;
grant select on public.campaign_invoice_plan_state to authenticated;

-- The plan for the campaign page.
create or replace function public.campaign_invoice_plan(p_campaign uuid) returns jsonb
language plpgsql stable security invoker set search_path = '' as $$
declare c record; v jsonb; tot numeric; nxt uuid; st record;
begin
  if not private.is_team_member() then raise exception 'Team only' using errcode = '42501'; end if;
  select id, budget, coalesce(nullif(currency, ''), 'USD') as currency into c from public.campaigns where id = p_campaign;
  if c.id is null then return null; end if;
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', id, 'position', "position", 'label', label, 'amount', amount, 'currency', currency,
           'due_on', due_on, 'auto_request', auto_request, 'note', note, 'request_id', request_id,
           'request_ref', request_ref, 'request_status', request_status, 'status', status)
         order by "position", due_on nulls last, id), '[]'::jsonb),
         coalesce(sum(amount) filter (where effective_currency = c.currency), 0)
    into v, tot
    from public.invoice_plan_part_status where campaign_id = p_campaign;
  select id into nxt from public.invoice_plan_part_status
   where campaign_id = p_campaign and status in ('upcoming', 'due')
   order by due_on nulls last, "position", id limit 1;
  select * into st from public.campaign_invoice_plan_state where campaign_id = p_campaign;
  return jsonb_build_object('parts', v, 'total', tot, 'budget', c.budget, 'currency', c.currency,
    'difference', case when c.budget is null then null else c.budget - tot end,
    'next_part_id', nxt,
    'other_currency', exists (select 1 from public.invoice_plan_part_status where campaign_id = p_campaign and effective_currency <> c.currency),
    'invoice_later', coalesce(st.invoice_later, false));
end $$;
revoke execute on function public.campaign_invoice_plan(uuid) from public, anon;
grant execute on function public.campaign_invoice_plan(uuid) to authenticated;

-- Equal parts. p_every 'month' = one part a month from p_start, labelled "December 2026"; 'none' = all on p_start
-- (upfront), labelled "<p_label> 1".. (just p_label when there's one part). The last part takes the rounding.
-- p_replace removes the parts that have no live request first (requested/invoiced/paid parts are never touched);
-- otherwise the new parts are added after the existing ones. p_total is what the new parts add up to.
create or replace function public.invoice_plan_split(p_campaign uuid, p_total numeric, p_parts int, p_every text,
  p_start date, p_label text default 'Part', p_replace boolean default false) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare i int; d date; base numeric; amt numeric; pos0 int; lbl text := coalesce(nullif(btrim(p_label), ''), 'Part');
begin
  if not private.is_team_member() then raise exception 'Team only' using errcode = '42501'; end if;
  if p_total is null or p_total <= 0 then raise exception 'The total has to be more than 0.' using errcode = 'P0001'; end if;
  if p_parts is null or p_parts < 1 or p_parts > 60 then raise exception 'Pick between 1 and 60 parts.' using errcode = 'P0001'; end if;
  if p_every is null or p_every not in ('month', 'none') then raise exception 'Every has to be month or none.' using errcode = 'P0001'; end if;
  if p_start is null then raise exception 'Pick a start date.' using errcode = 'P0001'; end if;
  if not exists (select 1 from public.campaigns where id = p_campaign) then raise exception 'Campaign not found.' using errcode = 'P0001'; end if;
  base := round(p_total / p_parts, 2);
  if base <= 0 then raise exception 'The parts would be 0. Use fewer parts.' using errcode = 'P0001'; end if;

  -- p_replace: the app removes the old upcoming parts itself (a person's action) before calling this.
  select coalesce(max("position"), 0) into pos0 from public.invoice_plan_parts where campaign_id = p_campaign;

  for i in 1..p_parts loop
    d := case when p_every = 'month' then (p_start + make_interval(months => i - 1))::date else p_start end;
    amt := case when i = p_parts then p_total - base * (p_parts - 1) else base end;
    insert into public.invoice_plan_parts (campaign_id, "position", label, amount, due_on)
    values (p_campaign, pos0 + i,
            case when p_every = 'month' then to_char(d, 'FMMonth YYYY')
                 when p_parts = 1 then lbl else lbl || ' ' || i end,
            amt, d);
  end loop;
  return public.campaign_invoice_plan(p_campaign);
end $$;
revoke execute on function public.invoice_plan_split(uuid, numeric, int, text, date, text, boolean) from public, anon;
grant execute on function public.invoice_plan_split(uuid, numeric, int, text, date, text, boolean) to authenticated;

-- The campaign's market split scaled to an amount (last line takes the rounding); same rules as the retainer job.
create or replace function private.plan_market_split(p_campaign uuid, p_amount numeric, out lines jsonb, out allocation jsonb)
language sql stable security definer set search_path = '' as $$
  with c as (select budget from public.campaigns where id = p_campaign),
  m as (
    select mk.name, mk.region, mk."position", coalesce(cm.amount, (select budget from c) * cm.share_percent / 100) as base
      from public.campaign_markets cm join public.markets mk on mk.name = cm.market
     where cm.campaign_id = p_campaign
  ), w as (
    select name, region, "position", base, sum(base) over () as total,
           row_number() over (order by "position" desc) as rn_last
      from m where base > 0
  ), l as (
    select name, region, "position",
           case when rn_last = 1
                then p_amount - coalesce(sum(round(p_amount * base / total, 2)) over (order by "position" rows between unbounded preceding and 1 preceding), 0)
                else round(p_amount * base / total, 2) end as amount
      from w where total > 0
  )
  select coalesce((select jsonb_agg(jsonb_build_object('market', name, 'amount', amount) order by "position") from l), '[]'::jsonb),
         (select jsonb_agg(jsonb_build_object('region', region, 'amount', a) order by region)
            from (select region, sum(amount) a from l group by region) g)
$$;
revoke execute on function private.plan_market_split(uuid, numeric) from public, anon, authenticated;

-- Daily. Parts of ACTIVE campaigns due today or up to 3 days late (missed runs), with no request linked and no
-- alert sent yet. Older parts stay "due" for people to handle (no surprise bulk requests).
--   auto_request: makes the invoice request like the retainer job did (template fields from the campaign and its
--     company, market split scaled to the part), notes "Invoice plan · <label>", requested_by 'Stellar OS (plan)',
--     and links the part; finance is told by invoice_requests_notify. If the request would take the campaign's
--     live requests over its budget (same currency), it is NOT made and the campaign people get the alert instead.
--   otherwise: one alert to the campaign people (kind invoice_plan_due), reminded_at set.
-- A part whose request was cancelled keeps that request_id, so it is never re-requested by itself.
-- Parts are locked (skip locked) so two runs at once can't request the same part; the unique request_id index
-- and the guard trigger are the backstop against a person linking a request at the same moment.
create or replace function private.run_invoice_plan(p_today date default (now() at time zone 'utc')::date)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  p record; c record; e record; sp record;
  v_cur text; v_id uuid; v_live numeric; v_over boolean;
  made int := 0; reminded int := 0;
begin
  for p in
    select pp.* from public.invoice_plan_parts pp
      join public.campaigns cc on cc.id = pp.campaign_id
     where pp.request_id is null and pp.reminded_at is null
       and pp.due_on between p_today - 3 and p_today
       and cc.status = 'active'
     order by pp.campaign_id, pp.due_on, pp."position"
     for update of pp skip locked
  loop
    begin
      select * into c from public.campaigns where id = p.campaign_id;
      v_cur := coalesce(p.currency, nullif(c.currency, ''), 'USD');
      select coalesce(sum(amount), 0) into v_live from public.invoice_requests
       where campaign_id = c.id and status <> 'cancelled' and currency = v_cur;
      v_over := c.budget is not null and v_cur = coalesce(nullif(c.currency, ''), 'USD') and v_live + p.amount > c.budget + 1;

      if p.auto_request and not v_over then
        select * into e from public.client_entities where id = c.client_entity_id;
        select * into sp from private.plan_market_split(c.id, p.amount);
        insert into public.invoice_requests (
          campaign_id, status, amount, currency, payment_terms, po_number, client, invoicing_entity, client_entity_id,
          lines, uses_portal, portal_name, notes, requested_by,
          responsible, artist, song, label_type, territory, contact_name, contact_email, send_via, allocation)
        values (
          c.id, 'requested', p.amount, v_cur,
          case when e.payment_terms between 0 and 180 then e.payment_terms else 30 end,
          c.po_number, c.client, coalesce(nullif(c.invoicing_entity, ''), e.legal_name), c.client_entity_id,
          coalesce(sp.lines, '[]'::jsonb), coalesce(e.uses_portal, false), case when e.uses_portal then e.portal_name end,
          'Invoice plan · ' || coalesce(nullif(btrim(p.label), ''), 'part ' || p."position"), 'Stellar OS (plan)',
          c.comms_owner, c.artist, c.song, c.label_type, nullif(regexp_replace(coalesce(c.client_market, ''), '^Stellar\s+', ''), ''),
          c.client_contact_name, c.client_contact_email, case when e.uses_portal then e.portal_name end, sp.allocation)
        returning id into v_id;
        update public.invoice_plan_parts set request_id = v_id, reminded_at = now() where id = p.id;
        made := made + 1;
      else
        perform private.notify(private.campaign_people(c.id), 'invoice_plan_due', c.id,
          'Invoice due: ' || coalesce(nullif(btrim(p.label), ''), 'part ' || p."position")
            || coalesce(' · ' || private.campaign_label(c.id), ''),
          concat_ws(' · ', trim(to_char(p.amount, 'FM999G999G999G990D00')) || ' ' || v_cur,
            case when v_over then 'Not requested by itself: it would take the invoices over the budget'
                 when p.auto_request then null
                 else 'Send the invoice request when it''s ready' end),
          '#/c/' || c.id, null);
        update public.invoice_plan_parts set reminded_at = now() where id = p.id;
        reminded := reminded + 1;
      end if;
      v_id := null;
    exception when others then
      raise warning 'run_invoice_plan part %: %', p.id, sqlerrm;   -- one bad part never stops the others
    end;
  end loop;
  return jsonb_build_object('requested', made, 'reminded', reminded);
end $$;
revoke execute on function private.run_invoice_plan(date) from public, anon, authenticated;

-- Cron: stop the retainer job (no campaign uses it), run the plan job at the same time.
do $$ begin
  if not exists (select 1 from cron.job where jobname = 'invoice-plan') then
    perform cron.schedule('invoice-plan', '15 6 * * *', 'select private.run_invoice_plan()');
  end if;
end $$;
