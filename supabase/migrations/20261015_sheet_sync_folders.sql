-- Campaign Overview sheet sync, PO numbers, market splits and campaign folders.
-- Applied 15 Oct 2026 as several migrations (markets_list, campaign_sheet_fields, campaign_folders,
-- sheet_sync_queue, status_on_hold, sheet_sync_config, share_series_folders, campaign_summary_po).

-- 1. Markets: the fixed list, matching the sheet's "Budget Allocations" columns.
create table public.markets (
  name text primary key,
  region text not null check (region in ('West','Central','East','Other')),
  position int not null
);
insert into public.markets (name, region, position) values
  ('US','West',1),('Brazil','West',2),('Mexico','West',3),('All LATAM','West',4),('Canada','West',5),
  ('UK','Central',6),('Germany','Central',7),('France','Central',8),('Africa','Central',9),('Other','Central',10),
  ('Japan','East',11),('Korea','East',12),('China','East',13),('India','East',14),('SEA','East',15),
  ('Global','Other',16);
alter table public.markets enable row level security;
create policy "team members read" on public.markets for select to authenticated using ((select private.is_team_member()));
grant select on public.markets to authenticated, service_role;

-- 2. Campaign fields the sheet needs.
alter table public.campaigns
  add column po_number text,
  add column release_type text check (release_type in ('New Release','Catalogue','Other')),
  add column invoicing_entity text,
  add column client_country text,
  add column client_market text check (client_market in ('Stellar West','Stellar Central','Stellar East')),
  add column client_contact_name text,
  add column client_contact_email text,
  add column label_type text check (label_type in ('Major','Indie','Other')),
  add column under_nda boolean,
  add column campaign_type text,
  add column folders_by_market boolean not null default true;
alter table public.campaigns drop constraint campaigns_status_check;
alter table public.campaigns add constraint campaigns_status_check check (status in ('draft','active','on_hold','finished'));
create unique index campaigns_artist_song_po_key on public.campaigns (lower(artist), lower(coalesce(song,'')), lower(po_number)) where po_number is not null;

-- 3. Market splits: by % or by figure (both kept; the form fills in the other one).
alter table public.campaign_markets
  add column amount numeric check (amount >= 0),
  add constraint campaign_markets_market_fkey foreign key (market) references public.markets(name) on update cascade;

-- 4. Folders inside a campaign (one per market, or named by hand, e.g. per creative).
create table public.campaign_folders (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.campaigns(id) on delete cascade,
  name text not null check (length(trim(name)) > 0),
  market text references public.markets(name) on update cascade,
  position int not null default 0,
  hidden boolean not null default false,  -- hidden from the client report's folder tabs; numbers still count
  created_at timestamptz not null default now(),
  unique (campaign_id, name)
);
create index on public.campaign_folders (campaign_id);
alter table public.campaign_folders enable row level security;
create policy "team members only" on public.campaign_folders for all to authenticated
  using ((select private.is_team_member())) with check ((select private.is_team_member()));
grant select, insert, update, delete on public.campaign_folders to authenticated, service_role;

alter table public.posts add column folder_id uuid references public.campaign_folders(id) on delete set null;
create index on public.posts (folder_id);
alter table public.link_jobs add column folder_id uuid references public.campaign_folders(id) on delete set null;
alter table public.share_links add column folder_id uuid references public.campaign_folders(id) on delete cascade;

-- A post's folder must belong to the same campaign.
create or replace function private.check_post_folder() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.folder_id is not null and not exists (
    select 1 from public.campaign_folders f where f.id = new.folder_id and f.campaign_id = new.campaign_id) then
    raise exception 'That folder belongs to another campaign';
  end if;
  return new;
end $$;
create trigger posts_folder_check before insert or update of folder_id, campaign_id on public.posts
  for each row execute function private.check_post_folder();

-- 5. (Not applied) a save_campaign() function was planned here; the form saves markets and
--    folders itself instead (app.js: renderForm, syncMarketFolders).

-- 6. Sheet sync state and queue (one row per campaign).
create table public.campaign_sheet_sync (
  campaign_id uuid primary key references public.campaigns(id) on delete cascade,
  due_at timestamptz,            -- null = nothing waiting
  attempts int not null default 0,
  sheet_row int,
  sheet_key text,                -- the Artist|Song|PO last written, so renames update the same row
  synced_at timestamptz,
  last_error text
);
alter table public.campaign_sheet_sync enable row level security;
create policy "team members read" on public.campaign_sheet_sync for select to authenticated using ((select private.is_team_member()));
grant select on public.campaign_sheet_sync to authenticated;
grant select, insert, update on public.campaign_sheet_sync to service_role;

create or replace function private.queue_sheet_sync() returns trigger
language plpgsql security definer set search_path = '' as $$
declare cid uuid;
begin
  cid := case when tg_op = 'DELETE' then old.campaign_id else new.campaign_id end;
  if exists (select 1 from public.campaigns where id = cid) then
    insert into public.campaign_sheet_sync (campaign_id, due_at) values (cid, now() + interval '5 seconds')
    on conflict (campaign_id) do update set due_at = now() + interval '5 seconds', attempts = 0;
  end if;
  return null;
end $$;
create or replace function private.queue_sheet_sync_campaign() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.campaign_sheet_sync (campaign_id, due_at) values (new.id, now() + interval '5 seconds')
  on conflict (campaign_id) do update set due_at = now() + interval '5 seconds', attempts = 0;
  return null;
end $$;
create trigger campaigns_sheet_sync after insert or update on public.campaigns
  for each row execute function private.queue_sheet_sync_campaign();
create trigger campaign_markets_sheet_sync after insert or update or delete on public.campaign_markets
  for each row execute function private.queue_sheet_sync();
create trigger creator_costs_sheet_sync after insert or update or delete on public.creator_costs
  for each row execute function private.queue_sheet_sync();

-- The function claims due rows so two runs never write the same campaign at once.
create or replace function public.claim_sheet_sync(n int default 20)
returns setof public.campaign_sheet_sync language sql security definer set search_path = '' as $$
  update public.campaign_sheet_sync s set due_at = null
  where s.campaign_id in (
    select campaign_id from public.campaign_sheet_sync where due_at <= now()
    order by due_at limit n for update skip locked)
  returning s.*;
$$;
revoke execute on function public.claim_sheet_sync(int) from public, anon, authenticated;
grant execute on function public.claim_sheet_sync(int) to service_role;

-- Everything the sheet row needs, in one place.
create or replace view public.campaign_sheet_rows with (security_invoker = true) as
select c.*,
  coalesce((select sum(agreed_price) from public.creator_costs k where k.campaign_id = c.id), 0) as cost,
  (select count(*) from public.creator_costs k where k.campaign_id = c.id) as cost_lines,
  coalesce((select jsonb_agg(jsonb_build_object('market', m.market, 'region', mk.region,
            'amount', coalesce(m.amount, round(c.budget * m.share_percent / 100, 2))) order by mk.position)
     from public.campaign_markets m join public.markets mk on mk.name = m.market
     where m.campaign_id = c.id), '[]'::jsonb) as allocations
from public.campaigns c;
grant select on public.campaign_sheet_rows to service_role;

-- 7. Where the sheet lives. The secret is set directly in the database, never committed.
create table private.settings (key text primary key, value text not null);
-- insert into private.settings values ('sheet_sync_secret', '<secret>'), ('sheet_sync_url', '<Apps Script /exec URL>');
create or replace function public.sheet_sync_config() returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_object_agg(key, value) from private.settings where key like 'sheet_sync_%';
$$;
revoke execute on function public.sheet_sync_config() from public, anon, authenticated;
grant execute on function public.sheet_sync_config() to service_role;

-- 8. Every minute, if something is waiting, call sheet-sync.
-- select cron.schedule('sheet-sync', '* * * * *', $$ select net.http_post(url := '.../functions/v1/sheet-sync', body := '{}'::jsonb,
--   headers := '{"Content-Type": "application/json"}'::jsonb, timeout_milliseconds := 60000)
--   where exists (select 1 from public.campaign_sheet_sync where due_at <= now()); $$);

-- 9. Daily series per campaign, folder and country, for reports (share function).
-- See share_series_by_folder(campaign_ids uuid[], only_folder uuid) in the database; same as share_series plus folder_id.

-- 10. campaign_summary gained po_number and folders_by_market (appended columns).
