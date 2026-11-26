-- posts-watch (pending item 1): once a day, look at the newest videos of the creators on each active campaign's
-- payout sheet and add the ones that use the campaign's sound. Costs ScrapeCreators credits, so it ships OFF.
-- Switch: private.settings.posts_watch = off | on, read by the function through posts_watch_mode() (service role only).
insert into private.settings(key, value) values ('posts_watch', 'off') on conflict (key) do nothing;
create or replace function public.posts_watch_mode() returns text language sql security definer set search_path = '' stable
  as $$ select coalesce((select value from private.settings where key = 'posts_watch'), 'off') $$;
revoke all on function public.posts_watch_mode() from public, anon, authenticated;
grant execute on function public.posts_watch_mode() to service_role;

-- One row per creator: when their newest videos were last fetched (so a creator on several campaigns costs one fetch a day).
create table if not exists public.posts_watch_checks (
  creator_id uuid primary key references public.creators(id) on delete cascade,
  checked_at timestamptz not null default now(),
  videos_seen integer not null default 0,
  added integer not null default 0,
  fails integer not null default 0,
  error text
);
alter table public.posts_watch_checks enable row level security;
create policy "team can read" on public.posts_watch_checks for select to authenticated using (private.is_team_member());
grant select on public.posts_watch_checks to authenticated;
revoke all on public.posts_watch_checks from anon;
revoke insert, update, delete, truncate, references, trigger on public.posts_watch_checks from authenticated;

-- NOT scheduled yet (Sam must OK the credits). To start, set the switch to 'on' and run once:
--   update private.settings set value = 'on' where key = 'posts_watch';
--   select cron.schedule('posts-watch', '*/10 1-4 * * *', $$
--     select net.http_post(url := 'https://vmzbpuootzchpdnvtfhb.supabase.co/functions/v1/posts-watch', body := '{}'::jsonb,
--       headers := jsonb_build_object('Content-Type', 'application/json', 'x-deck-secret', public.deck_secret()), timeout_milliseconds := 150000);
--   $$);
-- To stop: select cron.unschedule('posts-watch'); and/or set the switch back to 'off'.
