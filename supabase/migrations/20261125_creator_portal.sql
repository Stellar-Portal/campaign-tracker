-- Creator portal (applied 2026-11-25): one personal link per creator per folder. Drafts in, review (team, then the
-- client if switched on), posted TikTok links in, payment details in, all through the same page (creator.html).
insert into private.settings(key, value) values ('portal_secret', encode(extensions.gen_random_bytes(32), 'hex')) on conflict (key) do nothing;
alter table public.campaigns
  add column if not exists portal_drafts boolean not null default true,
  add column if not exists portal_client_review boolean not null default false,
  add column if not exists portal_brief text,
  add column if not exists portal_message text;
alter table public.creators add column if not exists whatsapp text;
create table if not exists public.creator_portal_links (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.campaigns(id) on delete cascade,
  folder_id uuid references public.campaign_folders(id) on delete cascade,
  creator_id uuid not null references public.creators(id) on delete cascade,
  created_by text, created_at timestamptz not null default now(),
  revoked_at timestamptz, opened_at timestamptz, last_seen_at timestamptz,
  unique nulls not distinct (campaign_id, folder_id, creator_id)
);
create table if not exists public.creator_drafts (
  id uuid primary key default gen_random_uuid(),
  link_id uuid not null references public.creator_portal_links(id) on delete cascade,
  campaign_id uuid not null references public.campaigns(id) on delete cascade,
  folder_id uuid references public.campaign_folders(id) on delete set null,
  creator_id uuid not null references public.creators(id) on delete cascade,
  file_path text not null, file_name text, size_bytes bigint, mime text,
  creator_note text, replaces_id uuid references public.creator_drafts(id) on delete set null,
  status text not null default 'submitted' check (status in ('submitted','changes','team_ok','approved','client_changes','withdrawn')),
  team_note text, reviewed_by text, reviewed_at timestamptz,
  client_note text, client_reviewed_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists creator_drafts_campaign_idx on public.creator_drafts(campaign_id, status);
create index if not exists creator_drafts_link_idx on public.creator_drafts(link_id);
create table if not exists public.creator_portal_posts (
  id uuid primary key default gen_random_uuid(),
  link_id uuid not null references public.creator_portal_links(id) on delete cascade,
  campaign_id uuid not null references public.campaigns(id) on delete cascade,
  folder_id uuid references public.campaign_folders(id) on delete set null,
  creator_id uuid not null references public.creators(id) on delete cascade,
  url text not null, job_item_id uuid references public.link_job_items(id) on delete set null,
  created_at timestamptz not null default now()
);
alter table public.creator_portal_links enable row level security;
alter table public.creator_drafts enable row level security;
alter table public.creator_portal_posts enable row level security;
create policy "team reads portal links" on public.creator_portal_links for select to authenticated using (private.is_team_member());
create policy "team updates portal links" on public.creator_portal_links for update to authenticated using (private.is_team_member()) with check (private.is_team_member());
create policy "team reads drafts" on public.creator_drafts for select to authenticated using (private.is_team_member());
create policy "team reviews drafts" on public.creator_drafts for update to authenticated using (private.is_team_member()) with check (private.is_team_member());
create policy "team reads portal posts" on public.creator_portal_posts for select to authenticated using (private.is_team_member());
grant select, update on public.creator_portal_links, public.creator_drafts to authenticated;
grant select on public.creator_portal_posts to authenticated;
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('drafts', 'drafts', false, 524288000, array['video/mp4','video/quicktime','video/webm','video/x-m4v','video/3gpp'])
on conflict (id) do nothing;
create policy "team reads drafts files" on storage.objects for select to authenticated using (bucket_id = 'drafts' and private.is_team_member());
create or replace function private.portal_token(p_id uuid) returns text
language sql stable security definer set search_path = '' as $$
  select p_id::text || '.' || left(encode(extensions.hmac(p_id::text, (select value from private.settings where key = 'portal_secret'), 'sha256'), 'hex'), 32)
$$;
revoke all on function private.portal_token(uuid) from public;
create or replace function public.creator_portal_links_for(p_campaign uuid, p_folder uuid, p_creators uuid[])
returns table (link_id uuid, folder_id uuid, creator_id uuid, token text)
language plpgsql security definer set search_path = '' as $$
declare me text := lower(coalesce(auth.jwt() ->> 'email', ''));
begin
  if not private.is_team_member() then raise exception 'Team only'; end if;
  insert into public.creator_portal_links (campaign_id, folder_id, creator_id, created_by)
  select p_campaign, p_folder, c, me from unnest(p_creators) c
  on conflict (campaign_id, folder_id, creator_id) do update set revoked_at = null;
  return query select l.id, l.folder_id, l.creator_id, private.portal_token(l.id)
    from public.creator_portal_links l
    where l.campaign_id = p_campaign and l.folder_id is not distinct from p_folder and l.creator_id = any(p_creators);
end $$;
revoke all on function public.creator_portal_links_for(uuid, uuid, uuid[]) from public, anon;
grant execute on function public.creator_portal_links_for(uuid, uuid, uuid[]) to authenticated;
create or replace function public.creator_portal_check(p_token text) returns uuid
language plpgsql stable security definer set search_path = '' as $$
declare lid uuid;
begin
  begin lid := split_part(p_token, '.', 1)::uuid; exception when others then return null; end;
  if private.portal_token(lid) <> p_token then return null; end if;
  if not exists (select 1 from public.creator_portal_links where id = lid and revoked_at is null) then return null; end if;
  return lid;
end $$;
revoke all on function public.creator_portal_check(text) from public, anon, authenticated;
grant execute on function public.creator_portal_check(text) to service_role;
