-- Creator payment details live on the roster card (2026-11-24). Additive only.
-- Every creator on a payout sheet gets a roster card automatically, so their PayPal details are saved once and
-- used for every campaign. Creators can fill them in themselves through a one-time link (creator-details function).

alter table public.creators
  add column if not exists payout_method text check (payout_method in ('paypal', 'wise')),
  add column if not exists paypal_username text,
  add column if not exists wise_email text,
  add column if not exists legal_name text,
  add column if not exists residence_country text,
  add column if not exists payout_note text,
  add column if not exists payout_updated_at timestamptz,
  add column if not exists payout_updated_by text;   -- a team email, or 'the creator' (one-time link) or 'form import'

-- One-time links a creator uses to fill in their own details. Only a SHA-256 of the token is kept.
create table if not exists public.creator_detail_links (
  id uuid primary key default gen_random_uuid(),
  creator_id uuid not null references public.creators(id) on delete cascade,
  token_hash text not null unique,
  created_by text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '30 days',
  used_at timestamptz
);
create index if not exists creator_detail_links_creator on public.creator_detail_links(creator_id);
alter table public.creator_detail_links enable row level security;
create policy "team can read" on public.creator_detail_links for select to authenticated using (private.is_team_member());
grant select on public.creator_detail_links to authenticated;
revoke all on public.creator_detail_links from anon;
revoke insert, update, delete, truncate, references, trigger on public.creator_detail_links from authenticated;

-- Fold one creator record into another (same person): everything moves over, details fill gaps, the first one goes.
create or replace function private.merge_creator(p_from uuid, p_into uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare o public.creators;
begin
  if p_from is null or p_into is null or p_from = p_into then return; end if;
  select * into o from public.creators where id = p_from;
  if o.id is null then return; end if;
  update public.creators n set
    on_roster = n.on_roster or o.on_roster,
    roster_added_at = coalesce(n.roster_added_at, o.roster_added_at),
    roster_added_by = coalesce(n.roster_added_by, o.roster_added_by),
    roster_notes = coalesce(n.roster_notes, o.roster_notes),
    contact_email = coalesce(n.contact_email, o.contact_email),
    paypal_email = coalesce(n.paypal_email, o.paypal_email),
    paypal_username = coalesce(n.paypal_username, o.paypal_username),
    wise_email = coalesce(n.wise_email, o.wise_email),
    payout_method = coalesce(n.payout_method, o.payout_method),
    legal_name = coalesce(n.legal_name, o.legal_name),
    residence_country = coalesce(n.residence_country, o.residence_country),
    payout_note = coalesce(n.payout_note, o.payout_note),
    payout_updated_at = greatest(n.payout_updated_at, o.payout_updated_at),
    payout_updated_by = coalesce(n.payout_updated_by, o.payout_updated_by),
    display_name = coalesce(n.display_name, o.display_name),
    country_code = coalesce(n.country_code, o.country_code)
  where n.id = p_into;
  insert into public.roster_list_members (list_id, creator_id, added_by, added_at)
    select list_id, p_into, added_by, added_at from public.roster_list_members where creator_id = p_from on conflict do nothing;
  delete from public.roster_list_members where creator_id = p_from;
  delete from public.campaign_folder_creators f where f.creator_id = p_from and exists (
    select 1 from public.campaign_folder_creators g where g.creator_id = p_into and g.campaign_id = f.campaign_id and g.folder_id is not distinct from f.folder_id);
  update public.campaign_folder_creators set creator_id = p_into where creator_id = p_from;
  update public.payout_rows set creator_id = p_into where creator_id = p_from;
  update public.creator_costs set creator_id = p_into where creator_id = p_from;
  update public.posts set creator_id = p_into where creator_id = p_from;
  update public.payout_payments set creator_id = p_into where creator_id = p_from;
  update public.creator_detail_links set creator_id = p_into where creator_id = p_from;
  delete from public.creators where id = p_from;
end $$;
revoke all on function private.merge_creator(uuid, uuid) from public, anon, authenticated;

-- The import placeholder merge now uses the same routine (so payment details and payments move too).
create or replace function private.creators_merge_import() returns trigger
language plpgsql security definer set search_path = '' as $$
declare oid uuid;
begin
  if new.tiktok_user_id is null then return null; end if;
  select id into oid from public.creators
   where tiktok_user_id is null and id <> new.id and platform = new.platform and lower(username) = lower(new.username)
   order by created_at limit 1;
  if oid is not null then perform private.merge_creator(oid, new.id); end if;
  return null;
end $$;

-- "Same person" on a payout sheet: fold a creator without fetched numbers into the right one (team only).
create or replace function public.merge_creators(p_from uuid, p_into uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not private.is_team_member() then raise exception 'Not allowed'; end if;
  if not exists (select 1 from public.creators where id = p_into) then raise exception 'Creator not found'; end if;
  if not exists (select 1 from public.creators where id = p_from and tiktok_user_id is null) then
    raise exception 'Only a creator whose numbers were never fetched can be folded into another.';
  end if;
  perform private.merge_creator(p_from, p_into);
end $$;
revoke all on function public.merge_creators(uuid, uuid) from public, anon;
grant execute on function public.merge_creators(uuid, uuid) to authenticated;

-- Everyone on a payout sheet has a roster card: link the row to the creator with that handle, or make a card.
create or replace function private.payout_rows_roster() returns trigger
language plpgsql security definer set search_path = '' as $$
declare k text; pf text; cid uuid;
begin
  if new.creator_id is null then
    k := lower(regexp_replace(btrim(coalesce(new.handle, '')), '^@+', ''));
    pf := coalesce(nullif(new.platform, ''), 'tiktok');
    if pf not in ('tiktok', 'youtube', 'instagram', 'twitter', 'twitch') then pf := 'tiktok'; end if;
    if k ~ '^[a-z0-9._-]{1,60}$' then
      select id into cid from public.creators where lower(username) = k and platform = pf
        order by (tiktok_user_id is not null) desc, created_at limit 1;
      if cid is null then
        insert into public.creators (username, platform, on_roster, roster_added_at, roster_added_by)
          values (k, pf, true, now(), 'payout sheet') returning id into cid;
      end if;
      new.creator_id := cid;
    end if;
  end if;
  if new.creator_id is not null then
    update public.creators set on_roster = true, roster_added_at = coalesce(roster_added_at, now()), roster_added_by = coalesce(roster_added_by, 'payout sheet')
      where id = new.creator_id and not on_roster;
  end if;
  return new;
end $$;
create or replace trigger payout_rows_roster before insert or update of handle, creator_id, platform on public.payout_rows
  for each row execute function private.payout_rows_roster();

-- A one-time link for a creator to fill in their own payment details (team only). Returns the token once.
create or replace function public.make_creator_details_link(p_creator uuid) returns text
language plpgsql security definer set search_path = '' as $$
declare t text;
begin
  if not private.is_team_member() then raise exception 'Not allowed'; end if;
  if not exists (select 1 from public.creators where id = p_creator) then raise exception 'Creator not found'; end if;
  t := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
  -- Earlier unused links for this creator stop working: only the newest one is valid.
  update public.creator_detail_links set expires_at = least(expires_at, now()) where creator_id = p_creator and used_at is null;
  insert into public.creator_detail_links (creator_id, token_hash, created_by)
    values (p_creator, encode(sha256(convert_to(t, 'UTF8')), 'hex'), coalesce(auth.jwt() ->> 'email', 'team'));
  return t;
end $$;
revoke all on function public.make_creator_details_link(uuid) from public, anon;
grant execute on function public.make_creator_details_link(uuid) to authenticated;

-- Creators already on payout sheets join the roster.
update public.creators c set on_roster = true, roster_added_at = coalesce(c.roster_added_at, now()), roster_added_by = coalesce(c.roster_added_by, 'payout sheet')
  where not c.on_roster and exists (select 1 from public.payout_rows r where r.creator_id = c.id);
