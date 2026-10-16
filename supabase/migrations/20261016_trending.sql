-- Trending: songs and artists breaking out per country, from Chartmetric charts.
-- The chartmetric-sync Edge Function fills trend_chart_rows once a day; trend_compute_scores()
-- turns those rows into one score per track, country and day (trend_scores).

-- 1. Countries we follow. Add a row (or flip enabled) to follow another market.
create table public.trend_countries (
  code text primary key check (code ~ '^[A-Z]{2}$' or code = 'GLOBAL'),
  name text not null,
  region text not null check (region in ('Asia','LATAM','US','Europe','Other','Global')),
  enabled boolean not null default true,
  position int not null default 0
);
insert into public.trend_countries (code, name, region, position) values
  ('US','United States','US',1),
  ('JP','Japan','Asia',10),('KR','South Korea','Asia',11),('TW','Taiwan','Asia',12),('HK','Hong Kong','Asia',13),
  ('ID','Indonesia','Asia',14),('TH','Thailand','Asia',15),('PH','Philippines','Asia',16),('VN','Vietnam','Asia',17),
  ('MY','Malaysia','Asia',18),('SG','Singapore','Asia',19),('IN','India','Asia',20),
  ('MX','Mexico','LATAM',30),('BR','Brazil','LATAM',31),('AR','Argentina','LATAM',32),('CO','Colombia','LATAM',33),
  ('CL','Chile','LATAM',34),('PE','Peru','LATAM',35),('EC','Ecuador','LATAM',36),('UY','Uruguay','LATAM',37),
  ('CR','Costa Rica','LATAM',38),('GT','Guatemala','LATAM',39),('DO','Dominican Republic','LATAM',40),
  ('GLOBAL','Global','Global',99);

-- 2. Raw chart rows, one per chart position per day. raw keeps Chartmetric's full row.
create table public.trend_chart_rows (
  source text not null check (source in ('spotify','shazam','tiktok_breakout','tiktok_popular','applemusic','youtube')),
  country text not null,
  chart_date date not null,
  rank int not null,
  track_key text not null,          -- 'cm:<chartmetric track id>' or 'n:<normalised title|artist>' when there is no id
  cm_track bigint,
  title text,
  artist_names text[],
  cm_artist_ids bigint[],
  isrc text,
  image_url text,
  pre_rank int,                     -- previous position; null = new on the chart
  rank_change int,                  -- positive = climbed
  peak_rank int,
  extra jsonb not null default '{}'::jsonb,   -- e.g. shazam count, tiktok views
  raw jsonb,
  captured_at timestamptz not null default now(),
  primary key (source, country, chart_date, rank)
);
create index on public.trend_chart_rows (country, chart_date);
create index on public.trend_chart_rows (track_key);

-- 3. One score per track, country and day.
create table public.trend_scores (
  score_date date not null,
  country text not null,
  track_key text not null,
  cm_track bigint,
  title text,
  artist_names text[],
  cm_artist_ids bigint[],
  isrc text,
  image_url text,
  score numeric not null,
  platforms text[] not null,        -- where it is on the chart today
  rising text[] not null,           -- where it is new or climbing
  breakout boolean not null default false,
  detail jsonb not null default '{}'::jsonb,  -- per platform: rank, pre_rank, change
  primary key (score_date, country, track_key)
);
create index on public.trend_scores (score_date, score desc);

-- 4. Artist audience (TikTok / Instagram / YouTube), loaded on demand and kept 30 days.
create table public.trend_artist_audience (
  cm_artist bigint not null,
  platform text not null check (platform in ('tiktok','instagram','youtube')),
  data jsonb,
  error text,
  fetched_at timestamptz not null default now(),
  primary key (cm_artist, platform)
);

-- 5. Run log, so the page can say when data was last collected and what failed.
create table public.trend_runs (
  id bigint generated always as identity primary key,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  run_date date,
  calls int not null default 0,
  rows_saved int not null default 0,
  errors jsonb not null default '[]'::jsonb,
  note text
);

-- Team-only access, same as every other table.
do $$
declare t text;
begin
  foreach t in array array['trend_countries','trend_chart_rows','trend_scores','trend_artist_audience','trend_runs'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy "team members read" on public.%I for select to authenticated using ((select private.is_team_member()))', t);
    execute format('grant select on public.%I to authenticated', t);
    execute format('grant all on public.%I to service_role', t);
  end loop;
end $$;
create policy "team members edit countries" on public.trend_countries for update to authenticated
  using ((select private.is_team_member())) with check ((select private.is_team_member()));
grant update (enabled) on public.trend_countries to authenticated;

-- 6. Scoring. Transparent on purpose, so the team can explain any number to a client:
--   Spotify (streams):    up to 40 — new entry 25, otherwise 1 point per place climbed (max 25), + up to 15 for position
--   Shazam (curiosity):   up to 40 — same rules
--   TikTok breakout:      30 for being on the weekly breakout chart, + up to 10 for position
--   TikTok popular:       up to 15 — new entry 10, otherwise climbing, + position
--   Rising on 2+ platforms: +20, on 3+: +35 (the cross-platform signal)
-- "Breakout" = rising on 2+ platforms, or on TikTok breakout and new/climbing on Spotify or Shazam.
-- TikTok charts are weekly, so the latest weekly chart within 7 days counts for each day.
create or replace function public.trend_compute_scores(p_date date)
returns int language sql security definer set search_path = public as $$
  with latest as (
    -- daily charts on the day itself; weekly TikTok charts: newest within 7 days
    select distinct on (source, country, track_key) *
    from trend_chart_rows
    where (source in ('spotify','shazam','applemusic','youtube') and chart_date = p_date)
       or (source in ('tiktok_breakout','tiktok_popular') and chart_date between p_date - 7 and p_date)
    order by source, country, track_key, chart_date desc, rank
  ),
  pts as (
    select *,
      case source
        when 'spotify' then least(25, coalesce(case when pre_rank is null then 25 else greatest(0, pre_rank - rank) end, 0)) + greatest(0, 15 - rank / 14.0)
        when 'shazam'  then least(25, coalesce(case when pre_rank is null then 25 else greatest(0, pre_rank - rank) end, 0)) + greatest(0, 15 - rank / 14.0)
        when 'tiktok_breakout' then 30 + greatest(0, 10 - rank / 10.0)
        when 'tiktok_popular'  then least(10, case when pre_rank is null then 10 else greatest(0, pre_rank - rank) end) + greatest(0, 5 - rank / 20.0)
        else least(15, case when pre_rank is null then 10 else greatest(0, pre_rank - rank) end)
      end as points,
      (pre_rank is null or rank < pre_rank or source = 'tiktok_breakout') as is_rising
    from latest
  ),
  per_track as (
    select country, track_key,
      max(cm_track) as cm_track,
      (array_agg(title order by source))[1] as title,
      -- names and ids from the same row, so they stay paired
      -- (arrays of arrays can't be picked with [1], so they go through jsonb)
      (array_agg(to_jsonb(artist_names) order by cardinality(cm_artist_ids) desc nulls last, cardinality(artist_names) desc nulls last))[1] as names_j,
      (array_agg(to_jsonb(cm_artist_ids) order by cardinality(cm_artist_ids) desc nulls last))[1] as ids_j,
      max(isrc) as isrc,
      (array_agg(image_url order by (image_url is null), source))[1] as image_url,
      sum(points) as base,
      array_agg(distinct split_part(source, '_', 1)) as platforms,
      coalesce(array_agg(distinct split_part(source, '_', 1)) filter (where is_rising), '{}') as rising,
      bool_or(source = 'tiktok_breakout') as on_tt_breakout,
      bool_or(is_rising and source in ('spotify','shazam')) as rising_stream_or_shazam,
      jsonb_object_agg(source, jsonb_build_object('rank', rank, 'pre_rank', pre_rank, 'change', rank_change, 'date', chart_date)) as detail
    from pts group by country, track_key
  ),
  ins as (
    insert into trend_scores (score_date, country, track_key, cm_track, title, artist_names, cm_artist_ids, isrc, image_url, score, platforms, rising, breakout, detail)
    select p_date, country, track_key, cm_track, title,
      array(select jsonb_array_elements_text(names_j)),
      array(select jsonb_array_elements_text(ids_j)::bigint),
      isrc, image_url,
      round(base + case when cardinality(rising) >= 3 then 35 when cardinality(rising) = 2 then 20 else 0 end, 1),
      platforms, rising,
      cardinality(rising) >= 2 or (on_tt_breakout and rising_stream_or_shazam),
      detail
    from per_track
    on conflict (score_date, country, track_key) do update set
      cm_track = excluded.cm_track, title = excluded.title, artist_names = excluded.artist_names,
      cm_artist_ids = excluded.cm_artist_ids, isrc = excluded.isrc, image_url = excluded.image_url,
      score = excluded.score, platforms = excluded.platforms, rising = excluded.rising,
      breakout = excluded.breakout, detail = excluded.detail
    returning 1
  )
  select count(*)::int from ins;
$$;
revoke all on function public.trend_compute_scores(date) from public, anon, authenticated;
grant execute on function public.trend_compute_scores(date) to service_role;

-- 7. Artists ranked by momentum: the sum of their tracks' scores over the last 7 days,
--    with how many countries they are trending in.
create or replace view public.trend_artist_momentum with (security_invoker = true) as
  with recent as (
    select s.*, c.region from trend_scores s join trend_countries c on c.code = s.country
    where s.score_date >= (select max(score_date) from trend_scores) - 6 and s.country <> 'GLOBAL'
  ),
  exploded as (
    select r.*, a.cm_artist, a.artist_name
    from recent r
    cross join lateral unnest(coalesce(r.cm_artist_ids, '{}'), coalesce(r.artist_names, '{}')) as a(cm_artist, artist_name)
    where a.cm_artist is not null
  )
  select cm_artist, max(artist_name) as artist_name, region, country,
    sum(score) as momentum, count(distinct track_key) as tracks, bool_or(breakout) as breakout,
    max(score_date) as last_seen
  from exploded group by cm_artist, region, country;
grant select on public.trend_artist_momentum to authenticated;

-- 8. One row per chart fetched per day, so each daily run picks up where the last one stopped
--    and never pays for the same chart twice in a day. (Applied as trending_fetch_log.)
create table public.trend_fetch_log (
  run_date date not null,
  source text not null,
  country text not null,
  status text not null check (status in ('ok','empty','error')),
  rows int not null default 0,
  chart_date date,
  error text,
  fetched_at timestamptz not null default now(),
  primary key (run_date, source, country)
);
alter table public.trend_fetch_log enable row level security;
create policy "team members read" on public.trend_fetch_log for select to authenticated using ((select private.is_team_member()));
grant select on public.trend_fetch_log to authenticated;
grant all on public.trend_fetch_log to service_role;

-- 9. Secret the schedule sends (kept in private.settings, never in this repo).
insert into private.settings (key, value)
values ('trending_cron_secret', replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''))
on conflict (key) do nothing;
create or replace function public.trending_cron_secret() returns text
language sql security definer set search_path = '' as $$
  select value from private.settings where key = 'trending_cron_secret';
$$;
revoke execute on function public.trending_cron_secret() from public, anon, authenticated;
grant execute on function public.trending_cron_secret() to service_role;

-- 10. Schedule: every 5 minutes, 04:00–05:55 UTC. Each run continues where the last stopped.
select cron.schedule('trending-charts', '*/5 4-5 * * *', $cmd$
  select net.http_post(
    url := 'https://vmzbpuootzchpdnvtfhb.supabase.co/functions/v1/chartmetric-sync',
    body := '{}'::jsonb,
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', public.trending_cron_secret()),
    timeout_milliseconds := 150000);
$cmd$);
