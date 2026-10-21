// chartmetric-sync: the data behind the Trending section.
//
// 1. Daily charts (schedule, every 5 minutes in the early morning, or "Collect now" by a team member):
//    for every followed country, fetches the latest Spotify daily chart and Shazam chart from Chartmetric,
//    stores them in trend_chart_rows and scores them (trend_compute_scores). trend_fetch_log records each
//    chart fetched per day, so each run continues where the last one stopped and no chart is paid for
//    twice in a day. (TikTok's weekly charts stopped updating in May 2026, so they're no longer fetched.)
// 2. Momentum signals (same runs, after the charts): for the day's 40 strongest candidate songs, each
//    song's daily Spotify streams and the number of TikTok videos using it, from Chartmetric's track stats
//    (2 calls per song). The 7-day growth of both feeds the score, so a song can rise on Spotify or TikTok
//    without being on a chart. Kept in trend_track_signals; each song is fetched at most once a day.
// 3. Artist audience ({action:"audience", cm_artist, platform}, team members only): TikTok, Instagram
//    or YouTube audience for one artist, kept 30 days in trend_artist_audience.
//
// Needs the Supabase secret CHARTMETRIC_REFRESH_TOKEN (Chartmetric API refresh token).
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

function serviceKey(): string {
  const raw = Deno.env.get("SUPABASE_SECRET_KEYS");
  if (raw) {
    try { const k = JSON.parse(raw); const v = k.default ?? Object.values(k)[0]; if (v) return String(v); } catch { /* ignore */ }
  }
  return Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
}
const db = createClient(Deno.env.get("SUPABASE_URL")!, serviceKey(), { auth: { persistSession: false } });
const REFRESH = Deno.env.get("CHARTMETRIC_REFRESH_TOKEN") ?? "";
const API = "https://api.chartmetric.com";
const TIME_BUDGET_MS = 120_000;
const AUDIENCE_DAYS = 30;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
const todayCph = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Copenhagen" }).format(new Date());
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------- Chartmetric ----------
let token = "", tokenUntil = 0, calls = 0;
async function cmToken(): Promise<string> {
  if (token && Date.now() < tokenUntil) return token;
  if (!REFRESH) throw new Error("Chartmetric key is missing: add CHARTMETRIC_REFRESH_TOKEN in Supabase → Edge Functions → Secrets");
  const r = await fetch(`${API}/api/token`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ refreshtoken: REFRESH }) });
  const j = await r.json().catch(() => null);
  if (!r.ok || !j?.token) throw new Error(`Chartmetric sign-in failed (HTTP ${r.status}): ${String(j?.error ?? j?.message ?? "").slice(0, 120)}`);
  token = j.token;
  tokenUntil = Date.now() + (Number(j.expires_in ?? 3600) - 120) * 1000;
  return token;
}
class NoData extends Error {}
async function cmGet(path: string, params: Record<string, string | number | boolean | undefined>): Promise<any> {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") q.set(k, String(v));
  for (let attempt = 0; attempt < 3; attempt++) {
    calls++;
    const r = await fetch(`${API}${path}?${q}`, { headers: { Authorization: `Bearer ${await cmToken()}` }, signal: AbortSignal.timeout(30_000) })
      .catch((e) => { throw new Error(e?.name === "TimeoutError" ? "Chartmetric took over 30 s; will retry on the next run" : String(e?.message ?? e)); });
    if (r.status === 429) {
      // Rate limited: wait as long as Chartmetric asks (capped), then try again.
      const wait = Number(r.headers.get("retry-after")) || Number(r.headers.get("x-ratelimit-reset")) || 2;
      await sleep(Math.min(10, wait) * 1000);
      continue;
    }
    if (r.status === 401) { token = ""; continue; }
    const text = await r.text();
    let j: any = null;
    try { j = JSON.parse(text); } catch { /* not JSON */ }
    if (r.status === 404 || r.status === 400 && /no data|not found|invalid country|not available/i.test(text)) throw new NoData(String(j?.error ?? "No chart"));
    if (r.status === 402) throw new Error("Chartmetric says the subscription doesn't cover this (HTTP 402)");
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${String(j?.error ?? j?.message ?? text).slice(0, 160)}`);
    return j;
  }
  throw new Error("Chartmetric kept rate-limiting; will retry on the next run");
}

// ---------- normalising chart rows ----------
// Different charts name the same song slightly differently ("Song (feat. X)", "Song - Sped Up"),
// so tracks are matched across platforms on a cleaned title + first artist.
const clean = (s: unknown) => String(s ?? "").toLowerCase()
  .normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
  .replace(/\s*[\(\[][^\)\]]*(feat|ft\.|with|remix|sped|slowed|version|edit|remaster)[^\)\]]*[\)\]]/g, "")
  .replace(/\s+-\s+.*(sped|slowed|remix|version|edit|remaster).*$/g, "")
  .replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const asArr = (v: unknown): any[] => (Array.isArray(v) ? v : v == null || v === "" ? [] : typeof v === "string" ? v.split(/\s*,\s*/) : [v]);
const num = (v: unknown) => { const x = Number(v); return Number.isFinite(x) ? x : null; };
const dateOnly = (v: unknown) => { const m = String(v ?? "").match(/^\d{4}-\d{2}-\d{2}/); return m ? m[0] : null; };

type Row = {
  source: string; country: string; chart_date: string; rank: number; track_key: string; cm_track: number | null;
  title: string | null; artist_names: string[]; cm_artist_ids: number[]; isrc: string | null; image_url: string | null;
  pre_rank: number | null; rank_change: number | null; peak_rank: number | null; extra: Record<string, unknown>; raw: unknown;
};
function makeRow(source: string, country: string, fallbackDate: string, r: any): Row | null {
  const rank = num(r.rank);
  if (!rank) return null;
  let names: string[], ids: number[], pre: number | null, date: string | null, cmTrack: number | null, extra: Record<string, unknown> = {};
  if (source.startsWith("tiktok")) {
    names = asArr(r.artists).map((a: any) => a?.name).filter(Boolean);
    ids = asArr(r.artists).map((a: any) => num(a?.id)).filter((x): x is number => x != null);
    // rankDiff: places moved since last week (positive = climbed); missing = new on the chart.
    const diff = num(r.rankDiff);
    pre = diff == null ? null : rank + diff;
    date = dateOnly(r.chartedDate);
    cmTrack = null; // TikTok chart ids aren't confirmed to be Chartmetric track ids, so they're kept in raw only
    extra = { tiktok_top_videos_views: r.targetExtras?.tiktokTopVideosViews ?? null, spotify_plays: r.targetExtras?.spotifyPlays ?? null, shazams: r.targetExtras?.shazamCount ?? null, genre: r.genre ?? null };
  } else {
    names = asArr(r.artist_names ?? r.spotify_artist_names ?? r.itunes_artist_names).map(String).filter(Boolean);
    ids = asArr(r.cm_artist).map(num).filter((x): x is number => x != null);
    // Spotify's pre_rank from Chartmetric just repeats today's rank (seen Oct 2026), so Spotify movement is
    // worked out in trend_compute_scores from the chart stored the day before. Shazam's pre_rank is real.
    pre = num(r.pre_rank);
    const stats = Array.isArray(r.rankStats) ? r.rankStats : [];
    // The chart's date is the newest entry in its rank history.
    date = stats.map((s: any) => dateOnly(s?.timestp)).filter(Boolean).sort().pop() ?? dateOnly(r.added_at) ?? dateOnly(r.timestp) ?? dateOnly(r.chart_date);
    cmTrack = num(r.cm_track);
    extra = { velocity: r.velocity ?? null, time_on_chart: r.time_on_chart ?? null, shazams: r.num_of_shazams ?? null, countries_charting: r.countries_charting_count ?? null };
  }
  const title = r.name ?? null;
  const key = `n:${clean(title)}|${clean(names[0] ?? "")}`;
  if (key === "n:|") return null;
  return {
    source, country, chart_date: date ?? fallbackDate, rank, track_key: key, cm_track: cmTrack,
    title, artist_names: names, cm_artist_ids: ids, isrc: r.isrc ?? null,
    image_url: r.image_url ?? r.imageUrl ?? null,
    pre_rank: pre, rank_change: pre == null ? null : pre - rank, peak_rank: num(r.peak_rank), extra, raw: r,
  };
}

// The charts we collect, per country.
const SOURCES: { source: string; fetch: (country: string) => Promise<any[]> }[] = [
  { source: "spotify", fetch: async (c) => {
      // Daily top chart by streams; up to 200 rows over a few pages.
      const out: any[] = [];
      for (let offset = 0; offset < 200; ) {
        const j = await cmGet("/api/charts/spotify", { country_code: c === "GLOBAL" ? "GLOBAL" : c, type: "regional", interval: "daily", latest: true, offset });
        const page = j?.obj?.data ?? j?.obj ?? [];
        if (!Array.isArray(page) || !page.length) break;
        if (out.length && num(page[0]?.rank) != null && num(page[0].rank)! <= num(out[out.length - 1]?.rank)!) break;   // offset ignored: same page again
        out.push(...page);
        offset += page.length;
        if (page.length < 50) break;
      }
      return out;
    } },
  { source: "shazam", fetch: async (c) => {
      const j = await cmGet("/api/charts/shazam", { country_code: c, latest: true });
      const d = j?.obj?.data ?? j?.obj ?? [];
      return Array.isArray(d) ? d : [];
    } },
];

async function fetchOne(runDate: string, source: (typeof SOURCES)[number], country: string) {
  try {
    const raw = await source.fetch(country);
    const rows = raw.map((r) => makeRow(source.source, country, runDate, r)).filter((x): x is Row => !!x);
    // One row per rank and date (Chartmetric occasionally repeats a position).
    const uniq = [...new Map(rows.map((r) => [`${r.chart_date}|${r.rank}`, r])).values()];
    for (let i = 0; i < uniq.length; i += 200) {
      const { error } = await db.from("trend_chart_rows").upsert(uniq.slice(i, i + 200), { onConflict: "source,country,chart_date,rank" });
      if (error) throw new Error(error.message);
    }
    const chartDate = uniq.map((r) => r.chart_date).sort().pop() ?? null;
    await db.from("trend_fetch_log").upsert({ run_date: runDate, source: source.source, country, status: uniq.length ? "ok" : "empty", rows: uniq.length, chart_date: chartDate, error: null, fetched_at: new Date().toISOString() }, { onConflict: "run_date,source,country" });
    return { rows: uniq.length, chartDate };
  } catch (e) {
    const empty = e instanceof NoData;
    const msg = String((e as Error).message).slice(0, 300);
    // Errors are retried on the next run (only "ok"/"empty" count as done); missing charts are not.
    await db.from("trend_fetch_log").upsert({ run_date: runDate, source: source.source, country, status: empty ? "empty" : "error", rows: 0, error: msg, fetched_at: new Date().toISOString() }, { onConflict: "run_date,source,country" });
    if (/key is missing|sign-in failed|subscription/i.test(msg)) throw e; // no point carrying on
    return { rows: 0, chartDate: null, error: msg };
  }
}

async function syncCharts(force: boolean) {
  const started = Date.now();
  const runDate = todayCph();
  const { data: countries, error } = await db.from("trend_countries").select("code").eq("enabled", true).order("position");
  if (error) throw new Error(error.message);
  const { data: done } = await db.from("trend_fetch_log").select("source,country,status,fetched_at").eq("run_date", runDate);
  const doneSet = new Set((done ?? []).filter((d) => d.status !== "error" || (force ? false : Date.now() - Date.parse(d.fetched_at) < 20 * 60_000)).map((d) => `${d.source}|${d.country}`));
  const todo: [(typeof SOURCES)[number], string][] = [];
  for (const c of countries ?? []) for (const s of SOURCES) if (!doneSet.has(`${s.source}|${c.code}`)) todo.push([s, c.code]);

  const { data: run } = await db.from("trend_runs").insert({ run_date: runDate, note: force ? "manual" : "schedule" }).select("id").single();
  let saved = 0; const errors: string[] = [];
  let i = 0;
  try {
    for (; i < todo.length && Date.now() - started < TIME_BUDGET_MS; i++) {
      const [s, c] = todo[i];
      const r = await fetchOne(runDate, s, c);
      saved += r.rows;
      if ((r as any).error) errors.push(`${s.source} ${c}: ${(r as any).error}`);
    }
  } catch (e) {
    // A problem with the account itself (key, subscription): record it on the run so it shows, then stop.
    errors.unshift(String((e as Error).message).slice(0, 300));
    await db.from("trend_runs").update({ finished_at: new Date().toISOString(), calls, rows_saved: saved, errors, note: `${force ? "manual" : "schedule"}; stopped: ${errors[0]}` }).eq("id", run?.id);
    throw e;
  }
  // Scores are per run day; each chart's latest date within the last 2 days counts (Spotify's daily chart
  // is dated the day before Shazam's).
  const remaining = todo.length - i;
  let scored = 0, sig = { fetched: 0, left: 0 };
  if (remaining === 0) {
    // Charts are done: score them, pick the day's candidates, fetch their momentum, then score again.
    if (saved > 0) await db.rpc("trend_compute_scores", { p_date: runDate });
    sig = await syncSignals(runDate, started);
    if (sig.fetched > 0) saved += sig.fetched;
  }
  if (saved > 0 || remaining === 0) {
    const { data: n, error: e } = await db.rpc("trend_compute_scores", { p_date: runDate });
    if (e) errors.push(`scoring ${runDate}: ${e.message}`); else scored = Number(n ?? 0);
  }
  await db.from("trend_runs").update({ finished_at: new Date().toISOString(), calls, rows_saved: saved, errors: errors.slice(0, 50), note: `${force ? "manual" : "schedule"}; ${i} charts fetched, ${remaining} left, ${sig.fetched} songs' momentum fetched (${sig.left} left), ${scored} scores` }).eq("id", run?.id);
  return { charts_fetched: i, charts_left: remaining, signals_fetched: sig.fetched, signals_left: sig.left, rows_saved: saved, scored, calls, errors: errors.slice(0, 10) };
}

// ---------- momentum signals: Spotify streams and TikTok videos per song ----------
const CANDIDATES = 40;
// Chartmetric's track stats are running totals (Spotify streams to date, TikTok videos to date). Days can
// be missing and the TikTok count can dip when videos are deleted, so growth compares the totals 7 and 14
// days back (read off the series, between the nearest days on either side).
function weekOverWeek(points: { timestp: string; value: number }[]) {
  const pts = points.filter((p) => p && Number.isFinite(Number(p.value)) && dateOnly(p.timestp))
    .map((p) => ({ t: Date.parse(dateOnly(p.timestp)! + "T00:00:00Z") / 86_400_000, v: Number(p.value) }))
    .sort((a, b) => a.t - b.t);
  const none = { last7: null as number | null, prev7: null as number | null, growth: null as number | null, latest: pts.at(-1)?.v ?? null, isNew: false };
  if (pts.length < 2) return none;
  const at = (t: number) => {
    if (t < pts[0].t || t > pts[pts.length - 1].t) return null;
    for (let i = 1; i < pts.length; i++) if (pts[i].t >= t) {
      const a = pts[i - 1], b = pts[i];
      return b.t === a.t ? b.v : a.v + (b.v - a.v) * ((t - a.t) / (b.t - a.t));
    }
    return pts[pts.length - 1].v;
  };
  const L = pts[pts.length - 1].t, now = pts[pts.length - 1].v;
  const t7 = at(L - 7), t14 = at(L - 14);
  if (t7 == null) {
    // Less than a week of history (a new song): the rate so far, scaled to a week.
    const span = L - pts[0].t;
    if (span < 2) return none;
    return { ...none, last7: Math.max(0, Math.round(((now - pts[0].v) / span) * 7)), isNew: true };
  }
  const last7 = Math.max(0, Math.round(now - t7));
  const prev7 = t14 == null ? null : Math.max(0, Math.round(t7 - t14));
  return { ...none, last7, prev7, growth: prev7 && prev7 > 0 ? last7 / prev7 - 1 : null };
}
async function trackStat(cmTrack: number, platform: "spotify" | "tiktok", type: string, since: string) {
  try {
    const j = await cmGet(`/api/track/${cmTrack}/${platform}/stats/most-history`, { type, since });
    const obj = Array.isArray(j?.obj) ? j.obj[0] : j?.obj;
    return { data: Array.isArray(obj?.data) ? obj.data : [], error: null as string | null };
  } catch (e) {
    return { data: [], error: e instanceof NoData ? "no data" : String((e as Error).message).slice(0, 160) };
  }
}
async function syncSignals(runDate: string, started: number) {
  // Candidates: today's highest-scoring songs (best score across countries) that have a Chartmetric id.
  const { data: top } = await db.from("trend_scores").select("cm_track,score").eq("score_date", runDate).not("cm_track", "is", null).order("score", { ascending: false }).limit(400);
  const best = new Map<number, number>();
  for (const r of top ?? []) if (!best.has(Number(r.cm_track))) best.set(Number(r.cm_track), Number(r.score));
  const candidates = [...best.keys()].slice(0, CANDIDATES);
  if (!candidates.length) return { fetched: 0, left: 0 };
  const { data: done } = await db.from("trend_track_signals").select("cm_track").eq("signal_date", runDate).in("cm_track", candidates);
  const doneSet = new Set((done ?? []).map((d) => Number(d.cm_track)));
  // At most 40 songs a day, even if fresh momentum lifts new songs into the top 40 later in the morning.
  const { count: doneToday } = await db.from("trend_track_signals").select("cm_track", { count: "exact", head: true }).eq("signal_date", runDate);
  const todo = candidates.filter((c) => !doneSet.has(c)).slice(0, Math.max(0, CANDIDATES - (doneToday ?? 0)));
  const since = new Date(Date.parse(runDate + "T12:00:00Z") - 21 * 86_400_000).toISOString().slice(0, 10);
  let fetched = 0;
  for (const id of todo) {
    if (Date.now() - started > TIME_BUDGET_MS) break;
    const [sp, tt] = await Promise.all([trackStat(id, "spotify", "streams", since), trackStat(id, "tiktok", "posts", since)]);
    const s = weekOverWeek(sp.data), t = weekOverWeek(tt.data);
    const totalPosts = t.latest;
    await db.from("trend_track_signals").upsert({
      cm_track: id, signal_date: runDate,
      spotify_streams_7d: s.last7, spotify_streams_prev7d: s.prev7, spotify_growth: s.growth, spotify_total: s.latest, spotify_new: s.isNew,
      tiktok_posts_7d: t.last7, tiktok_posts_prev7d: t.prev7, tiktok_growth: t.growth, tiktok_posts_total: totalPosts, tiktok_new: t.isNew,
      error: [sp.error && `Spotify: ${sp.error}`, tt.error && `TikTok: ${tt.error}`].filter(Boolean).join("; ") || null,
      fetched_at: new Date().toISOString(),
    }, { onConflict: "cm_track,signal_date" });
    fetched++;
  }
  return { fetched, left: todo.length - fetched };
}

// ---------- artist audience ----------
const AUDIENCE_PATH: Record<string, string> = {
  tiktok: "tiktok-audience-stats",
  instagram: "instagram-audience-stats",
  youtube: "youtube-audience-stats",
};
async function audience(cmArtist: number, platform: string, refresh: boolean) {
  if (!AUDIENCE_PATH[platform]) throw new Error("Unknown platform");
  if (!refresh) {
    const { data: cached } = await db.from("trend_artist_audience").select("*").eq("cm_artist", cmArtist).eq("platform", platform).maybeSingle();
    if (cached && Date.now() - Date.parse(cached.fetched_at) < AUDIENCE_DAYS * 86_400_000) return { ...cached, cached: true };
  }
  let data: unknown = null, error: string | null = null;
  try {
    const j = await cmGet(`/api/artist/${cmArtist}/${AUDIENCE_PATH[platform]}`, {});
    data = j?.obj ?? j;
  } catch (e) {
    error = e instanceof NoData ? "Chartmetric has no audience data for this artist on this platform." : String((e as Error).message).slice(0, 300);
  }
  const row = { cm_artist: cmArtist, platform, data, error, fetched_at: new Date().toISOString() };
  await db.from("trend_artist_audience").upsert(row, { onConflict: "cm_artist,platform" });
  return { ...row, cached: false };
}

// ---------- access ----------
async function teamMember(req: Request): Promise<boolean> {
  const jwt = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!jwt.startsWith("ey")) return false;
  const { data } = await db.auth.getUser(jwt);
  const email = data.user?.email?.toLowerCase();
  if (!email) return false;
  const { data: m } = await db.from("team_members").select("email").eq("email", email).maybeSingle();
  return !!m;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  let body: any = {};
  try { body = await req.json(); } catch { /* scheduled calls send {} */ }
  const { data: secret } = await db.rpc("trending_cron_secret");
  const fromCron = !!secret && req.headers.get("x-cron-secret") === secret;
  const member = fromCron ? false : await teamMember(req);
  if (!fromCron && !member) return json({ error: "Not allowed" }, 401);
  try {
    if (body?.action === "probe_track" && fromCron) {
      const id = Number(body.cm_track);
      const since = new Date(Date.now() - 21 * 86_400_000).toISOString().slice(0, 10);
      const [sp, tt] = await Promise.all([trackStat(id, "spotify", "streams", since), trackStat(id, "tiktok", "posts", since)]);
      return json({ spotify: sp.data.slice(-16), spotify_error: sp.error, tiktok: tt.data.slice(-16), tiktok_error: tt.error,
        spotify_wow: weekOverWeek(sp.data), tiktok_wow: weekOverWeek(tt.data) });
    }
    if (body?.action === "audience") {
      if (!member) return json({ error: "Not allowed" }, 401);
      const id = Number(body.cm_artist);
      if (!Number.isInteger(id) || id < 2) return json({ error: "Missing artist" }, 400);
      return json(await audience(id, String(body.platform ?? "tiktok"), !!body.refresh));
    }
    return json(await syncCharts(member && !!body?.force));
  } catch (e) {
    return json({ error: String((e as Error).message) }, 502);
  }
});
