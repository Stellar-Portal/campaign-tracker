-- Clients section: client groups (Warner Music Group…), clients (per team, e.g. "Warner Brasil"),
-- their people and their invoicing companies. Campaigns link to a client with campaigns.client_id;
-- campaigns.client (text) stays as it is because the Campaign Overview sheet sync uses it.

create table public.client_groups (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) between 1 and 120),
  email_domains text[] not null default '{}',   -- shared domains (umusic.com) match viewers to the group
  created_at timestamptz not null default now()
);
create unique index client_groups_name_key on public.client_groups (lower(name));

create table public.clients (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) between 1 and 120),
  group_id uuid references public.client_groups(id) on delete set null,
  label_type text check (label_type in ('Major','Indie','Other')),
  market text check (market in ('West','Central','East')),
  country text check (country ~ '^[A-Z]{2}$'),
  aliases text[] not null default '{}',          -- other spellings used in the sheet ("Warner Brazil")
  email_domains text[] not null default '{}',    -- domains only this client uses (because.tv)
  website text,
  notes text,
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index clients_name_key on public.clients (lower(name));
create index clients_group_idx on public.clients (group_id);

create table public.client_contacts (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  name text,
  email text,
  role text,
  market text check (market in ('West','Central','East')),
  phone text,
  notes text,
  created_at timestamptz not null default now(),
  check (coalesce(trim(name), '') <> '' or coalesce(trim(email), '') <> '')
);
create index client_contacts_client_idx on public.client_contacts (client_id);
create index client_contacts_email_idx on public.client_contacts (lower(email));

create table public.client_entities (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  legal_name text not null check (length(trim(legal_name)) between 1 and 200),
  country text check (country ~ '^[A-Z]{2}$'),
  address text,
  vat_number text,
  invoice_email text,
  payment_terms integer check (payment_terms between 0 and 365),
  currency text check (currency ~ '^[A-Z]{3}$'),
  uses_portal boolean not null default false,
  portal_name text,
  notes text,
  created_at timestamptz not null default now()
);
create index client_entities_client_idx on public.client_entities (client_id);

alter table public.campaigns add column client_id uuid references public.clients(id) on delete set null;
create index campaigns_client_idx on public.campaigns (client_id);

-- RLS: team only
alter table public.client_groups enable row level security;
alter table public.clients enable row level security;
alter table public.client_contacts enable row level security;
alter table public.client_entities enable row level security;
do $$ declare t text; begin
  foreach t in array array['client_groups','clients','client_contacts','client_entities'] loop
    execute format('create policy "team reads %1$s" on public.%1$I for select to authenticated using ((select private.is_team_member()))', t);
    execute format('create policy "team adds %1$s" on public.%1$I for insert to authenticated with check ((select private.is_team_member()))', t);
    execute format('create policy "team changes %1$s" on public.%1$I for update to authenticated using ((select private.is_team_member())) with check ((select private.is_team_member()))', t);
    execute format('create policy "team removes %1$s" on public.%1$I for delete to authenticated using ((select private.is_team_member()))', t);
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
  end loop;
end $$;

create trigger clients_updated_at before update on public.clients for each row execute function private.set_updated_at();

-- Find a client by its name or one of its other spellings.
create or replace function private.find_client(p text) returns uuid
language sql stable security definer set search_path = '' as $$
  select c.id from public.clients c
  where lower(trim(c.name)) = lower(trim(p))
     or exists (select 1 from unnest(c.aliases) a where lower(trim(a)) = lower(trim(p)))
  order by (lower(trim(c.name)) = lower(trim(p))) desc
  limit 1
$$;

-- A campaign whose client text changes (form or sheet edit) without a client picked gets linked by name.
create or replace function private.campaign_link_client() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if coalesce(trim(new.client), '') = '' then return new; end if;
  if tg_op = 'INSERT' and new.client_id is null then
    new.client_id := private.find_client(new.client);
  elsif tg_op = 'UPDATE' and new.client is distinct from old.client and new.client_id is not distinct from old.client_id then
    new.client_id := private.find_client(new.client);
  end if;
  return new;
end $$;
create trigger campaigns_link_client before insert or update of client, client_id on public.campaigns
  for each row execute function private.campaign_link_client();

-- Link campaigns that have no client yet (after a client or spelling is added). Returns how many were linked.
create or replace function public.link_campaign_clients() returns integer
language plpgsql security definer set search_path = '' as $$
declare n integer;
begin
  if not private.is_team_member() then raise exception 'Team only'; end if;
  update public.campaigns c set client_id = private.find_client(c.client)
   where c.client_id is null and private.find_client(c.client) is not null;
  get diagnostics n = row_count;
  return n;
end $$;

-- Merge one client into another: people, invoicing companies and campaigns move over,
-- and the merged client's name becomes another spelling of the one kept.
create or replace function public.merge_clients(p_from uuid, p_into uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare f public.clients;
begin
  if not private.is_team_member() then raise exception 'Team only'; end if;
  if p_from = p_into then raise exception 'Pick a different client'; end if;
  select * into f from public.clients where id = p_from;
  if not found or not exists (select 1 from public.clients where id = p_into) then raise exception 'Client not found'; end if;
  update public.client_contacts set client_id = p_into where client_id = p_from
    and (email is null or lower(email) not in (select lower(email) from public.client_contacts where client_id = p_into and email is not null));
  update public.client_entities set client_id = p_into where client_id = p_from
    and lower(legal_name) not in (select lower(legal_name) from public.client_entities where client_id = p_into);
  update public.campaigns set client_id = p_into where client_id = p_from;
  update public.clients k set
    aliases = (select coalesce(array_agg(distinct a), '{}') from unnest(k.aliases || f.aliases || f.name) a where lower(a) <> lower(k.name)),
    email_domains = (select coalesce(array_agg(distinct d), '{}') from unnest(k.email_domains || f.email_domains) d),
    group_id = coalesce(k.group_id, f.group_id), label_type = coalesce(k.label_type, f.label_type),
    market = coalesce(k.market, f.market), country = coalesce(k.country, f.country),
    notes = nullif(concat_ws(E'\n', k.notes, f.notes), '')
  where k.id = p_into;
  delete from public.clients where id = p_from;
  return p_into;
end $$;

revoke all on function public.link_campaign_clients() from public, anon;
revoke all on function public.merge_clients(uuid, uuid) from public, anon;
grant execute on function public.link_campaign_clients() to authenticated;
grant execute on function public.merge_clients(uuid, uuid) to authenticated;
