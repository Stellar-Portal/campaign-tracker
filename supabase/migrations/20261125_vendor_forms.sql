-- Vendor forms and the exact invoicing company (2026-11-25). Additive only.
-- A campaign can be created before we know who to invoice. "Send vendor form" emails the client a one-time link
-- (from invoice@stellarmusic.dk) or copies it; their answers create/fill the client, its invoicing company and contact
-- in Clients, and fill the campaign (which then syncs to the Campaign Overview sheet).

-- Exactly which invoicing company (e.g. which of Universal's companies) a campaign and an invoice are for.
alter table public.campaigns add column if not exists client_entity_id uuid references public.client_entities(id) on delete set null;
alter table public.invoice_requests add column if not exists client_entity_id uuid references public.client_entities(id) on delete set null;
create index if not exists campaigns_client_entity on public.campaigns(client_entity_id);

-- Structured address and where the details came from.
alter table public.client_entities
  add column if not exists street text,
  add column if not exists zip text,
  add column if not exists city text,
  add column if not exists source text,            -- 'vendor form', 'sheet', 'team'
  add column if not exists updated_at timestamptz;

-- One-time vendor form links. Only a SHA-256 of the token is kept.
create table if not exists public.vendor_requests (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid references public.campaigns(id) on delete set null,
  token_hash text not null unique,
  sent_to text,                                    -- empty when the link was only copied
  note text,
  sent_by text not null,
  emailed boolean not null default false,
  email_error text,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '60 days',
  opened_at timestamptz,
  submitted_at timestamptz,
  answers jsonb,                                   -- what they filled in (company, ID number, address, contact, campaign, print name, notes)
  signature text,                                  -- their drawn signature (PNG data URL)
  client_id uuid references public.clients(id) on delete set null,
  entity_id uuid references public.client_entities(id) on delete set null
);
create index if not exists vendor_requests_campaign on public.vendor_requests(campaign_id);
alter table public.vendor_requests enable row level security;
create policy "team can read" on public.vendor_requests for select to authenticated using (private.is_team_member());
grant select on public.vendor_requests to authenticated;
revoke all on public.vendor_requests from anon;
revoke insert, update, delete, truncate, references, trigger on public.vendor_requests from authenticated;

-- (applied as campaign_entity_link) Keep the exact invoicing company and the sheet's "Invoicing Entity" text in step:
-- picking a company sets the text; a changed text (e.g. edited in the sheet) is matched back to a company by name.
create or replace function private.campaigns_link_entity() returns trigger
language plpgsql security definer set search_path = '' as $$
declare eid uuid; ename text;
begin
  if tg_op = 'UPDATE' and new.client_entity_id is distinct from old.client_entity_id and new.client_entity_id is not null then
    select legal_name into ename from public.client_entities where id = new.client_entity_id;
    if ename is not null then new.invoicing_entity := ename; end if;
  elsif tg_op = 'INSERT' and new.client_entity_id is not null then
    select legal_name into ename from public.client_entities where id = new.client_entity_id;
    if ename is not null then new.invoicing_entity := ename; end if;
  elsif tg_op = 'INSERT' or new.invoicing_entity is distinct from old.invoicing_entity or new.client_id is distinct from old.client_id then
    if coalesce(btrim(new.invoicing_entity), '') = '' then
      new.client_entity_id := null;
    else
      select e.id into eid from public.client_entities e
        where lower(btrim(e.legal_name)) = lower(btrim(new.invoicing_entity))
        order by (e.client_id is not distinct from new.client_id) desc, e.created_at limit 1;
      new.client_entity_id := eid;
    end if;
  end if;
  return new;
end $$;
create or replace trigger campaigns_link_entity before insert or update of invoicing_entity, client_id, client_entity_id on public.campaigns
  for each row execute function private.campaigns_link_entity();
-- Backfill (run once): campaigns and their invoice requests linked by exact company name.
