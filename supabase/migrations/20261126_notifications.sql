-- In-app alerts for team members (applied 2026-11-26).
-- public.notifications: one row per person per alert. Team members read and mark read only their own.
-- Nobody but the database (security definer triggers / service role) creates them.
-- Every alert trigger is AFTER and wrapped in an exception handler: an alert never blocks the write.

create table if not exists public.notifications (
  id          uuid primary key default gen_random_uuid(),
  email       text not null,                    -- team member (lower case)
  kind        text not null,                    -- draft_submitted | draft_client_decision | mention | invoice_requested | invoice_status | vendor_form | deck_access | creator_post
  campaign_id uuid references public.campaigns(id) on delete cascade,
  title       text not null,
  body        text,
  link        text,                             -- in-app hash, e.g. '#/c/<id>/creators'
  created_at  timestamptz not null default now(),
  read_at     timestamptz,
  emailed_at  timestamptz,                      -- set by the (future) email sender
  actor       text                              -- who caused it (email), null = creator/client/automatic
);
create index if not exists notifications_email_created on public.notifications (email, created_at desc);
create index if not exists notifications_unread on public.notifications (email) where read_at is null;
create index if not exists notifications_to_email on public.notifications (created_at) where emailed_at is null and read_at is null;
create index if not exists notifications_campaign on public.notifications (campaign_id);

alter table public.notifications enable row level security;
revoke all on public.notifications from anon, authenticated;
grant select, update (read_at) on public.notifications to authenticated;

create policy "own notifications read" on public.notifications for select to authenticated
  using ((select private.is_team_member()) and email = lower(coalesce(auth.jwt() ->> 'email', '')));
create policy "own notifications mark read" on public.notifications for update to authenticated
  using ((select private.is_team_member()) and email = lower(coalesce(auth.jwt() ->> 'email', '')))
  with check (email = lower(coalesce(auth.jwt() ->> 'email', '')));

-- Realtime (same publication as campaign_messages; Realtime applies the select policy per subscriber).
do $$ begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'notifications') then
    alter publication supabase_realtime add table public.notifications;
  end if;
end $$;

-- Email sending switch for the future sender (Sam turns it on).
insert into private.settings (key, value)
  select 'notify_email', 'off' where not exists (select 1 from private.settings where key = 'notify_email');

-- ---------- helpers ----------
-- Insert one alert per team member in p_emails, skipping unknown addresses and the actor themself.
create or replace function private.notify(p_emails text[], p_kind text, p_campaign uuid, p_title text, p_body text, p_link text, p_actor text)
returns int language plpgsql security definer set search_path = '' as $$
declare n int;
begin
  insert into public.notifications (email, kind, campaign_id, title, body, link, actor)
  select t.email, p_kind, p_campaign, left(coalesce(p_title, ''), 200), left(p_body, 600), p_link, nullif(lower(btrim(p_actor)), '')
  from public.team_members t
  where t.email in (select lower(btrim(e)) from unnest(coalesce(p_emails, '{}')) e where e is not null)
    and t.email <> coalesce(lower(btrim(p_actor)), '');
  get diagnostics n = row_count;
  return n;
end $$;

-- DRI (comms_owner) + runners (comma-separated campaign_runner) → team emails, by name, case-insensitive.
create or replace function private.campaign_people(p_campaign uuid)
returns text[] language sql stable security definer set search_path = '' as $$
  select coalesce(array_agg(distinct t.email), '{}')
  from public.campaigns c
  cross join lateral unnest(array[coalesce(c.comms_owner, '')] || string_to_array(coalesce(c.campaign_runner, ''), ',')) as p(name)
  join public.team_members t on lower(btrim(t.name)) = lower(btrim(p.name))
  where c.id = p_campaign and btrim(p.name) <> '' and coalesce(t.name, '') <> ''
$$;

create or replace function private.campaign_label(p_campaign uuid)
returns text language sql stable security definer set search_path = '' as $$
  select concat_ws(' – ', nullif(btrim(artist), ''), nullif(btrim(song), '')) from public.campaigns where id = p_campaign
$$;

create or replace function private.creator_handle(p_creator uuid)
returns text language sql stable security definer set search_path = '' as $$
  select coalesce('@' || ltrim(nullif(btrim(username), ''), '@'), 'A creator') from public.creators where id = p_creator
$$;

create or replace function private.team_name(p_email text)
returns text language sql stable security definer set search_path = '' as $$
  select coalesce((select nullif(btrim(name), '') from public.team_members where email = lower(btrim(p_email))), p_email)
$$;

-- ---------- triggers ----------
create or replace function private.notify_draft()
returns trigger language plpgsql security definer set search_path = '' as $$
declare h text; lbl text; fol text;
begin
  begin
    h := coalesce(private.creator_handle(new.creator_id), 'A creator');
    lbl := private.campaign_label(new.campaign_id);
    select name into fol from public.campaign_folders where id = new.folder_id;
    if tg_op = 'INSERT' and new.status = 'submitted' then
      perform private.notify(private.campaign_people(new.campaign_id), 'draft_submitted', new.campaign_id,
        h || case when new.replaces_id is not null then ' sent a new draft' else ' sent a draft' end,
        concat_ws(' · ', lbl, fol), '#/c/' || new.campaign_id || '/creators', null);
    elsif tg_op = 'UPDATE' and old.status = 'team_ok' and new.status in ('approved', 'client_changes')
          and new.client_reviewed_at is distinct from old.client_reviewed_at then
      perform private.notify(private.campaign_people(new.campaign_id), 'draft_client_decision', new.campaign_id,
        case when new.status = 'approved' then 'The client approved ' || h || '''s draft'
             else 'The client asked ' || h || ' for changes' end,
        concat_ws(' · ', lbl, fol, nullif(btrim(new.client_note), '')), '#/c/' || new.campaign_id || '/creators', null);
    end if;
  exception when others then raise warning 'notify_draft: %', sqlerrm;
  end;
  return null;
end $$;
create or replace trigger creator_drafts_notify
  after insert or update of status on public.creator_drafts
  for each row execute function private.notify_draft();

-- "@Full Name" (as the chat's autocomplete writes it), case-insensitive, followed by a non-letter or the end.
create or replace function private.notify_mentions()
returns trigger language plpgsql security definer set search_path = '' as $$
declare who text[]; b text;
begin
  begin
    if new.deleted_at is null and position('@' in new.body) > 0 then
      b := lower(new.body);
      select array_agg(t.email) into who from public.team_members t
       where coalesce(btrim(t.name), '') <> ''
         and b ~ ('(^|[^[:alnum:]_])@' || regexp_replace(lower(btrim(t.name)), '([^[:alnum:][:space:]])', '\\\1', 'g') || '($|[^[:alnum:]_])');
      if who is not null then
        perform private.notify(who, 'mention', new.campaign_id,
          private.team_name(new.author_email) || ' mentioned you' || coalesce(' · ' || private.campaign_label(new.campaign_id), ''),
          left(new.body, 300), '#/c/' || new.campaign_id, new.author_email);
      end if;
    end if;
  exception when others then raise warning 'notify_mentions: %', sqlerrm;
  end;
  return null;
end $$;
create or replace trigger campaign_messages_notify
  after insert on public.campaign_messages
  for each row execute function private.notify_mentions();

-- New request (or a sent-back one sent again) → finance (role 'finance'). Status → returned / invoiced / paid → the requester
-- (or, when the requester isn't a team member, e.g. 'Stellar OS (monthly)', the campaign's DRI + runners).
create or replace function private.notify_invoice()
returns trigger language plpgsql security definer set search_path = '' as $$
declare lbl text; amt text; to_whom text[];
begin
  begin
    lbl := private.campaign_label(new.campaign_id);
    amt := trim(to_char(new.amount, 'FM999G999G999G990D00')) || ' ' || coalesce(new.currency, '');
    if tg_op = 'INSERT' then
      perform private.notify((select array_agg(email) from public.team_members where role = 'finance'),
        'invoice_requested', new.campaign_id, 'New invoice request #' || new.ref || coalesce(' · ' || lbl, ''),
        concat_ws(' · ', amt, 'from ' || private.team_name(new.requested_by), nullif(btrim(new.notes), '')),
        '#/invoices', case when new.requested_by like '%@%' then new.requested_by else private.actor_email() end);
    elsif new.status is distinct from old.status and old.status = 'returned' and new.status = 'requested' then
      perform private.notify((select array_agg(email) from public.team_members where role = 'finance'),
        'invoice_requested', new.campaign_id, 'Invoice request #' || new.ref || ' was sent again' || coalesce(' · ' || lbl, ''),
        concat_ws(' · ', amt, 'from ' || private.team_name(new.requested_by), nullif(btrim(new.notes), '')),
        '#/invoices', private.actor_email());
    elsif new.status is distinct from old.status and new.status in ('returned', 'invoiced', 'paid') then
      if exists (select 1 from public.team_members where email = lower(btrim(new.requested_by))) then
        to_whom := array[lower(btrim(new.requested_by))];
      else
        to_whom := private.campaign_people(new.campaign_id);
      end if;
      perform private.notify(to_whom, 'invoice_status', new.campaign_id,
        'Invoice request #' || new.ref || case new.status when 'returned' then ' was sent back' when 'invoiced' then ' was invoiced' else ' was paid' end
          || coalesce(' · ' || lbl, ''),
        concat_ws(' · ', amt, case when new.status = 'returned' then nullif(btrim(new.finance_note), '') end,
                  case when new.status = 'invoiced' and new.invoice_number is not null then 'Invoice ' || new.invoice_number end),
        '#/invoices', private.actor_email());
    end if;
  exception when others then raise warning 'notify_invoice: %', sqlerrm;
  end;
  return null;
end $$;
create or replace trigger invoice_requests_notify
  after insert or update of status on public.invoice_requests
  for each row execute function private.notify_invoice();

-- Vendor form: "submitted" = answers written (the function claims submitted_at first and resets it on failure,
-- then writes answers only after everything is saved).
create or replace function private.notify_vendor_form()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  begin
    if old.answers is null and new.answers is not null then
      perform private.notify(private.campaign_people(new.campaign_id) || array[lower(coalesce(new.sent_by, ''))], 'vendor_form', new.campaign_id,
        'Vendor form filled in' || coalesce(': ' || nullif(btrim(new.answers ->> 'company'), ''), ''),
        concat_ws(' · ', private.campaign_label(new.campaign_id), nullif(btrim(new.answers ->> 'contact_name'), '')),
        case when new.campaign_id is not null then '#/c/' || new.campaign_id
             when new.entity_id is not null then '#/clients/co/' || new.entity_id else '#/clients' end,
        null);
    end if;
  exception when others then raise warning 'notify_vendor_form: %', sqlerrm;
  end;
  return null;
end $$;
create or replace trigger vendor_requests_notify
  after update of answers on public.vendor_requests
  for each row execute function private.notify_vendor_form();

-- "Ask Stellar to let you in" → the deck's creator.
create or replace function private.notify_deck_access()
returns trigger language plpgsql security definer set search_path = '' as $$
declare d record;
begin
  begin
    select title, created_by into d from public.decks where id = new.deck_id;
    if new.status = 'pending' and d.created_by is not null then
      perform private.notify(array[d.created_by], 'deck_access', null,
        new.email || ' asked to be let in', d.title, '#/decks/' || new.deck_id, null);
    end if;
  exception when others then raise warning 'notify_deck_access: %', sqlerrm;
  end;
  return null;
end $$;
create or replace trigger deck_access_requests_notify
  after insert on public.deck_access_requests
  for each row execute function private.notify_deck_access();

-- A creator sent their post link from their creator page.
create or replace function private.notify_creator_post()
returns trigger language plpgsql security definer set search_path = '' as $$
declare fol text;
begin
  begin
    select name into fol from public.campaign_folders where id = new.folder_id;
    perform private.notify(private.campaign_people(new.campaign_id), 'creator_post', new.campaign_id,
      coalesce(private.creator_handle(new.creator_id), 'A creator') || ' sent their video link',
      concat_ws(' · ', private.campaign_label(new.campaign_id), fol), '#/c/' || new.campaign_id, null);
  exception when others then raise warning 'notify_creator_post: %', sqlerrm;
  end;
  return null;
end $$;
create or replace trigger creator_portal_posts_notify
  after insert on public.creator_portal_posts
  for each row execute function private.notify_creator_post();

revoke execute on function private.notify(text[], text, uuid, text, text, text, text) from public, anon, authenticated;
revoke execute on function private.campaign_people(uuid) from public, anon, authenticated;
revoke execute on function private.campaign_label(uuid) from public, anon, authenticated;
revoke execute on function private.creator_handle(uuid) from public, anon, authenticated;
revoke execute on function private.team_name(text) from public, anon, authenticated;
revoke execute on function private.notify_draft() from public, anon, authenticated;
revoke execute on function private.notify_mentions() from public, anon, authenticated;
revoke execute on function private.notify_invoice() from public, anon, authenticated;
revoke execute on function private.notify_vendor_form() from public, anon, authenticated;
revoke execute on function private.notify_deck_access() from public, anon, authenticated;
revoke execute on function private.notify_creator_post() from public, anon, authenticated;

-- ---------- RPC ----------
-- Mark my alerts read: given ids, or all of mine when p_ids is null. Runs as the caller (RLS applies).
create or replace function public.notifications_mark_read(p_ids uuid[] default null)
returns int language plpgsql security invoker set search_path = '' as $$
declare n int;
begin
  update public.notifications set read_at = now()
   where read_at is null
     and email = lower(coalesce(auth.jwt() ->> 'email', ''))
     and (p_ids is null or id = any (p_ids));
  get diagnostics n = row_count;
  return n;
end $$;
revoke execute on function public.notifications_mark_read(uuid[]) from public, anon;
grant execute on function public.notifications_mark_read(uuid[]) to authenticated;
