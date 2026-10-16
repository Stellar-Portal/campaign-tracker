-- Trending scoring, after the first real Chartmetric data (16 Oct 2026):
-- * Each chart's latest date within the last 2 days counts for a run day (Spotify's daily chart is
--   dated the day before Shazam's, so exact-date matching split them apart).
-- * Spotify movement comes from the chart we stored the previous day: Chartmetric's Spotify pre_rank
--   just repeats today's rank. With no earlier chart stored yet, Spotify movement is unknown (no points),
--   not "new entry".
create or replace function public.trend_compute_scores(p_date date)
 returns integer
 language sql
 security definer
 set search_path to 'public'
as $function$
  with latest_date as (
    select source, country, max(chart_date) as d
    from trend_chart_rows
    where (source in ('spotify','shazam','applemusic','youtube') and chart_date between p_date - 2 and p_date)
       or (source in ('tiktok_breakout','tiktok_popular') and chart_date between p_date - 7 and p_date)
    group by source, country
  ),
  latest as (
    select distinct on (r.source, r.country, r.track_key) r.*
    from trend_chart_rows r join latest_date ld on ld.source = r.source and ld.country = r.country and ld.d = r.chart_date
    order by r.source, r.country, r.track_key, r.rank
  ),
  prev_date as (
    select ld.source, ld.country, (select max(p.chart_date) from trend_chart_rows p
                                    where p.source = ld.source and p.country = ld.country
                                      and p.chart_date < ld.d and p.chart_date >= ld.d - 3) as d
    from latest_date ld where ld.source = 'spotify'
  ),
  fixed as (
    select l.*,
      case when l.source <> 'spotify' then l.pre_rank
           when pd.d is null then l.rank                       -- no earlier chart stored: movement unknown
           else (select min(p.rank) from trend_chart_rows p
                 where p.source = l.source and p.country = l.country and p.chart_date = pd.d and p.track_key = l.track_key)
      end as pre_eff
    from latest l left join prev_date pd on pd.source = l.source and pd.country = l.country
  ),
  pts as (
    select *,
      case source
        when 'spotify' then least(25, coalesce(case when pre_eff is null then 25 else greatest(0, pre_eff - rank) end, 0)) + greatest(0, 15 - rank / 14.0)
        when 'shazam'  then least(25, coalesce(case when pre_eff is null then 25 else greatest(0, pre_eff - rank) end, 0)) + greatest(0, 15 - rank / 14.0)
        when 'tiktok_breakout' then 30 + greatest(0, 10 - rank / 10.0)
        when 'tiktok_popular'  then least(10, case when pre_eff is null then 10 else greatest(0, pre_eff - rank) end) + greatest(0, 5 - rank / 20.0)
        else least(15, case when pre_eff is null then 10 else greatest(0, pre_eff - rank) end)
      end as points,
      (pre_eff is null or rank < pre_eff or source = 'tiktok_breakout') as is_rising
    from fixed
  ),
  per_track as (
    select country, track_key,
      max(cm_track) as cm_track,
      (array_agg(title order by source))[1] as title,
      (array_agg(to_jsonb(artist_names) order by cardinality(cm_artist_ids) desc nulls last, cardinality(artist_names) desc nulls last))[1] as names_j,
      (array_agg(to_jsonb(cm_artist_ids) order by cardinality(cm_artist_ids) desc nulls last))[1] as ids_j,
      max(isrc) as isrc,
      (array_agg(image_url order by (image_url is null), source))[1] as image_url,
      sum(points) as base,
      array_agg(distinct split_part(source, '_', 1)) as platforms,
      coalesce(array_agg(distinct split_part(source, '_', 1)) filter (where is_rising), '{}') as rising,
      bool_or(source = 'tiktok_breakout') as on_tt_breakout,
      bool_or(is_rising and source in ('spotify','shazam')) as rising_stream_or_shazam,
      jsonb_object_agg(source, jsonb_build_object('rank', rank, 'pre_rank', pre_eff, 'change', case when pre_eff is null then null else pre_eff - rank end, 'date', chart_date)) as detail
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
$function$;
