-- Duplicate a campaign (team only). Applied 2026-11-26 via apply_migration "duplicate_campaign".
-- Security invoker: RLS on every table applies and all the usual triggers fire (client/entity link,
-- activity log, sheet-sync queue, payout roster link). The copy has no PO number, so sheet-sync
-- never writes it to the sheet (syncOne stops at "Add a PO number ...") and pullEdits can't match it
-- (sheet rows are matched by campaign-id tag or artist+song+PO).
-- Never copied: po_number, dates, notes, posts, invoice requests, payments, chat, share links,
-- creator portal links, drafts, wrap-up ticks.
-- p_opts (booleans; a missing key = false, except basics = true):
--   basics, folders, sounds, payout_structure, creators, portal, budget
--   plus optional text overrides "artist", "song".

create or replace function public.duplicate_campaign(p_from uuid, p_opts jsonb default '{}'::jsonb)
returns uuid
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  o jsonb := coalesce(p_opts, '{}'::jsonb);
  src public.campaigns;
  v_id uuid;
  v_email text := lower(coalesce(auth.jwt() ->> 'email', ''));
  v_artist text;
  v_song text;
  b_basics boolean := coalesce((o ->> 'basics')::boolean, true);
  b_folders boolean := coalesce((o ->> 'folders')::boolean, false);
  b_sounds boolean := coalesce((o ->> 'sounds')::boolean, false);
  b_struct boolean := coalesce((o ->> 'payout_structure')::boolean, false);
  b_creators boolean := coalesce((o ->> 'creators')::boolean, false);
  b_portal boolean := coalesce((o ->> 'portal')::boolean, false);
  b_budget boolean := coalesce((o ->> 'budget')::boolean, false);
  v_fmap jsonb := '{}'::jsonb;  -- old folder id -> new folder id
  v_smap jsonb := '{}'::jsonb;  -- old section id -> new section id
begin
  if not private.is_team_member() then
    raise exception 'Only the Stellar team can duplicate campaigns.' using errcode = '42501';
  end if;
  select * into src from public.campaigns where id = p_from;
  if not found then
    raise exception 'That campaign was not found.' using errcode = 'P0002';
  end if;

  v_artist := coalesce(nullif(btrim(o ->> 'artist'), ''), src.artist);
  v_song := case when o ? 'song' then nullif(btrim(o ->> 'song'), '') else src.song end;

  insert into public.campaigns (
    artist, song, status, created_by,
    client, client_id, client_entity_id, invoicing_entity, client_contact_name, client_contact_email,
    client_country, client_market, label_type, under_nda, release_type, campaign_type,
    comms_owner, campaign_runner, currency, folders_by_market, split_mode, spend_cap_percent,
    portal_drafts, portal_client_review, portal_brief, portal_message,
    budget
  ) values (
    v_artist, v_song, 'draft', nullif(v_email, ''),
    case when b_basics then src.client end,
    case when b_basics then src.client_id end,
    case when b_basics then src.client_entity_id end,
    case when b_basics then src.invoicing_entity end,
    case when b_basics then src.client_contact_name end,
    case when b_basics then src.client_contact_email end,
    case when b_basics then src.client_country end,
    case when b_basics then src.client_market end,
    case when b_basics then src.label_type end,
    case when b_basics then src.under_nda end,
    case when b_basics then src.release_type end,
    case when b_basics then src.campaign_type end,
    case when b_basics then src.comms_owner end,
    case when b_basics then src.campaign_runner end,
    case when b_basics or b_budget then src.currency end,  -- a copied budget keeps its currency
    case when b_basics then src.folders_by_market else true end,
    case when b_basics or b_budget then src.split_mode end,
    case when b_basics then src.spend_cap_percent else 30 end,
    case when b_portal then src.portal_drafts else true end,
    case when b_portal then src.portal_client_review else false end,
    case when b_portal then src.portal_brief end,
    case when b_portal then src.portal_message end,
    case when b_budget then src.budget end
  ) returning id into v_id;

  -- Folders (no posts); remember old -> new ids.
  if b_folders then
    with src_f as materialized (
      select f.id as old_id, gen_random_uuid() as new_id, f.name, f.market, f.position, f.hidden
      from public.campaign_folders f where f.campaign_id = p_from
    ), ins as (
      insert into public.campaign_folders (id, campaign_id, name, market, position, hidden)
      select new_id, v_id, name, market, position, hidden from src_f
      returning id
    )
    select coalesce(jsonb_object_agg(old_id::text, new_id::text), '{}'::jsonb) into v_fmap from src_f;
  end if;

  if b_sounds then
    insert into public.campaign_sounds (campaign_id, sound_id)
    select v_id, s.sound_id from public.campaign_sounds s where s.campaign_id = p_from;
  end if;

  -- Payout sections; remember old -> new ids (also needed to place copied creators).
  if b_struct then
    with src_s as materialized (
      select s.id as old_id, gen_random_uuid() as new_id, s.name, s.deliverable, s.deliverables, s.unit_price, s.position
      from public.payout_sections s where s.campaign_id = p_from
    ), ins as (
      insert into public.payout_sections (id, campaign_id, name, deliverable, deliverables, unit_price, position)
      select new_id, v_id, name, deliverable, deliverables, unit_price, position from src_s
      returning id
    )
    select coalesce(jsonb_object_agg(old_id::text, new_id::text), '{}'::jsonb) into v_smap from src_s;
  end if;

  if b_creators then
    -- Fresh rows: status contacted; no paid_on / paid_via / posted_manual / paypal_email / notes.
    -- A row whose section wasn't copied lands unsectioned.
    insert into public.payout_rows (campaign_id, section_id, creator_id, handle, platform, handled_by,
                                    videos, price_per_video, amount, status, position, created_by)
    select v_id, (v_smap ->> r.section_id::text)::uuid, r.creator_id, r.handle, r.platform, r.handled_by,
           r.videos, r.price_per_video, r.amount, 'contacted', r.position, nullif(v_email, '')
    from public.payout_rows r
    where r.campaign_id = p_from
    order by r.position, r.created_at;

    -- Creators added to folders by profile link: the campaign-wide ones always, folder ones only
    -- when folders were copied.
    insert into public.campaign_folder_creators (campaign_id, folder_id, creator_id, added_by)
    select v_id, (v_fmap ->> fc.folder_id::text)::uuid, fc.creator_id, nullif(v_email, '')
    from public.campaign_folder_creators fc
    where fc.campaign_id = p_from and (fc.folder_id is null or v_fmap ? fc.folder_id::text)
    on conflict do nothing;
  end if;

  if b_budget then
    insert into public.campaign_markets (campaign_id, market, share_percent, amount)
    select v_id, cm.market, cm.share_percent, cm.amount from public.campaign_markets cm where cm.campaign_id = p_from;
  end if;

  return v_id;
end
$$;

revoke all on function public.duplicate_campaign(uuid, jsonb) from public, anon;
grant execute on function public.duplicate_campaign(uuid, jsonb) to authenticated;

-- What a duplicate would copy (counts for the dialog). Team only.
create or replace function public.duplicate_campaign_preview(p_from uuid)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare r jsonb;
begin
  if not private.is_team_member() then
    raise exception 'Only the Stellar team can see this.' using errcode = '42501';
  end if;
  select jsonb_build_object(
    'artist', c.artist,
    'song', c.song,
    'folders', (select count(*) from public.campaign_folders where campaign_id = c.id),
    'sounds', (select count(*) from public.campaign_sounds where campaign_id = c.id),
    'sections', (select count(*) from public.payout_sections where campaign_id = c.id),
    'creators', (select count(*) from public.payout_rows where campaign_id = c.id),
    'folder_creators', (select count(*) from public.campaign_folder_creators where campaign_id = c.id),
    'markets', (select count(*) from public.campaign_markets where campaign_id = c.id),
    'budget', c.budget,
    'currency', c.currency,
    'has_client', (c.client is not null or c.client_id is not null),
    'has_portal_text', (c.portal_brief is not null or c.portal_message is not null)
  ) into r
  from public.campaigns c where c.id = p_from;
  if r is null then
    raise exception 'That campaign was not found.' using errcode = 'P0002';
  end if;
  return r;
end
$$;

revoke all on function public.duplicate_campaign_preview(uuid) from public, anon;
grant execute on function public.duplicate_campaign_preview(uuid) to authenticated;
