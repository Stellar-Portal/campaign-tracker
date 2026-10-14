// share: the data behind a report.
//
// Two callers:
// - A client with a link (share.html#t=<token>). No login: the token is the key. The link's
//   settings decide what is returned, and anything switched off is left out here, on the server,
//   so it never reaches the browser at all.
// - A signed-in Stellar team member ({ artist }). Gets the same report with everything on.
//
// It never returns budgets, spend, margins, creator prices or creators' payment details.
// There is deliberately no setting that could turn those on.
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

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" } });

const COVER_TTL = 6 * 3600;
const FIRST_COVERS = 48;

// Every visibility switch, and its default. Unknown keys are ignored.
const DEFAULTS = {
  overview: true, overview_chart: true,
  sounds: true,
  songs: true, songs_chart: true,
  countries: true, countries_chart: true,
  posts: true, posts_country_filter: true,
  show_country: true, show_followers: true,
};
type Settings = typeof DEFAULTS & { hidden_campaigns: string[] };
function readSettings(raw: any): Settings {
  const s: any = { ...DEFAULTS, hidden_campaigns: [] };
  if (raw && typeof raw === "object") {
    for (const k of Object.keys(DEFAULTS)) if (typeof raw[k] === "boolean") s[k] = raw[k];
    if (Array.isArray(raw.hidden_campaigns)) s.hidden_campaigns = raw.hidden_campaigns.map(String);
  }
  if (!s.show_country) { s.countries = false; s.countries_chart = false; s.posts_country_filter = false; }
  if (!s.countries) s.countries_chart = false;
  if (!s.songs) s.songs_chart = false;
  if (!s.overview) s.overview_chart = false;
  return s;
}

async function inChunks<T>(items: T[], size: number, fn: (chunk: T[]) => Promise<any[]>) {
  const out: any[] = [];
  for (let i = 0; i < items.length; i += size) out.push(...(await fn(items.slice(i, i + size))));
  return out;
}

const likeEscape = (s: string) => s.trim().replace(/[%_\\]/g, (c) => "\\" + c);

async function teamMember(req: Request): Promise<string | null> {
  const jwt = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!jwt.startsWith("ey")) return null; // publishable keys aren't user sessions
  const { data } = await db.auth.getUser(jwt);
  const email = data.user?.email?.toLowerCase();
  if (!email) return null;
  const { data: m } = await db.from("team_members").select("email").eq("email", email).maybeSingle();
  return m ? email : null;
}

// Which campaigns a request may see, and with which settings.
async function scopeFor(req: Request, body: any) {
  const token = String(body?.token ?? "");
  if (token) {
    if (!/^[0-9a-f]{40,128}$/i.test(token)) return null;
    const { data: link } = await db.from("share_links").select("artist,campaign_id,expires_at,revoked,settings").eq("token", token).maybeSingle();
    if (!link || link.revoked || (link.expires_at && new Date(link.expires_at) < new Date())) return null;
    const settings = readSettings(link.settings);
    let q = db.from("campaigns").select("id,artist,song,start_date,end_date,status,created_at").neq("status", "draft");
    q = link.artist ? q.ilike("artist", likeEscape(link.artist)) : q.eq("id", link.campaign_id);
    const { data } = await q.order("created_at");
    const all = data ?? [];
    const campaigns = all.filter((c) => !settings.hidden_campaigns.includes(c.id));
    return { mode: "client" as const, artist: link.artist ?? all[0]?.artist ?? "", campaigns, settings };
  }
  if (body?.artist) {
    const email = await teamMember(req);
    if (!email) return "forbidden" as const;
    // The team sees drafts too, so they can check a report before switching a campaign on.
    const { data } = await db.from("campaigns").select("id,artist,song,start_date,end_date,status,created_at")
      .ilike("artist", likeEscape(String(body.artist))).order("created_at");
    return { mode: "team" as const, artist: String(body.artist).trim(), campaigns: data ?? [], settings: readSettings({}) };
  }
  return null;
}

async function signCovers(paths: string[]) {
  const signed = await inChunks(paths, 200, async (chunk) => {
    const { data } = await db.storage.from("covers").createSignedUrls(chunk, COVER_TTL);
    return data ?? [];
  });
  return Object.fromEntries(signed.filter((s) => s.signedUrl).map((s) => [s.path, s.signedUrl]));
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  let body: any = {};
  try { body = await req.json(); } catch { /* ignore */ }

  const scope = await scopeFor(req, body);
  if (scope === "forbidden") return json({ error: "Sign in as a Stellar team member to see this report." }, 401);
  if (!scope) return json({ error: "This link isn't active. Ask Stellar for a new one." }, 404);
  const s = scope.settings;
  const ids = scope.campaigns.map((c) => c.id);

  // One video's day-by-day numbers, for the post preview window.
  if (body.post) {
    if (scope.mode === "client" && !s.posts) return json({ daily: [] });
    const vid = String(body.post);
    const { data: owned } = await db.from("posts").select("id").in("campaign_id", ids).eq("tiktok_video_id", vid).limit(1);
    if (!owned?.length) return json({ daily: [] });
    const { data } = await db.from("post_daily_stats").select("stat_date,plays,likes,comments,shares").eq("tiktok_video_id", vid).order("stat_date");
    return json({ daily: data ?? [] });
  }

  // More covers for posts the page is about to show
  if (Array.isArray(body.covers)) {
    if (scope.mode === "client" && !s.posts) return json({ covers: {} });
    const wanted = body.covers.slice(0, 200).map(String);
    const { data } = await db.from("posts").select("tiktok_video_id,cover_path").in("campaign_id", ids).in("tiktok_video_id", wanted);
    const byPath = await signCovers((data ?? []).map((p) => p.cover_path).filter(Boolean));
    return json({ covers: Object.fromEntries((data ?? []).filter((p) => byPath[p.cover_path]).map((p) => [p.tiktok_video_id, byPath[p.cover_path]])) });
  }

  const publicSettings = scope.mode === "client" ? (({ hidden_campaigns, ...rest }) => rest)(s) : null;
  const campaignsOut = scope.campaigns.map((c) => ({ id: c.id, song: c.song, start_date: c.start_date, end_date: c.end_date, status: c.status }));
  if (!ids.length) return json({ mode: scope.mode, artist: scope.artist, campaigns: [], posts: [], series: [], sounds: [], covers: {}, settings: publicSettings });

  const posts: any[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db.from("posts")
      .select("campaign_id,tiktok_video_id,url,caption,published_at,country_code,cover_path,sound_id,creator:creators(username,display_name,follower_count,avatar_url,country_code,is_verified)")
      .in("campaign_id", ids).eq("status", "active").order("created_at").range(from, from + 999);
    if (error) return json({ error: error.message }, 500);
    posts.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }

  const videoIds = [...new Set(posts.map((p) => p.tiktok_video_id))];
  const latest = Object.fromEntries((await inChunks(videoIds, 200, async (chunk) => {
    const { data } = await db.from("post_latest_stats").select("tiktok_video_id,plays,likes,comments,shares,stat_date").in("tiktok_video_id", chunk);
    return data ?? [];
  })).map((r) => [r.tiktok_video_id, r]));

  const { data: seriesRaw } = await db.rpc("share_series", { campaign_ids: ids });
  // Without countries, collapse the daily rows so no country code is sent at all.
  let series = seriesRaw ?? [];
  if (!s.show_country) {
    const merged = new Map<string, any>();
    for (const r of series) {
      const k = `${r.stat_date}|${r.campaign_id}`;
      const m = merged.get(k) ?? { stat_date: r.stat_date, campaign_id: r.campaign_id, country_code: null, plays: 0, likes: 0, comments: 0, shares: 0 };
      for (const f of ["plays", "likes", "comments", "shares"]) m[f] += Number(r[f] ?? 0);
      merged.set(k, m);
    }
    series = [...merged.values()];
  }

  let sounds: any[] = [];
  if (s.sounds || scope.mode === "team") {
    const { data: links } = await db.from("campaign_sounds").select("campaign_id,sound:sounds(id,title,author,matched_song_title,sound_url)").in("campaign_id", ids);
    const soundMap = new Map<string, any>();
    for (const l of links ?? []) if (l.sound) soundMap.set(l.sound.id, { ...l.sound, campaign_ids: [...(soundMap.get(l.sound.id)?.campaign_ids ?? []), l.campaign_id] });
    const soundIds = [...soundMap.keys()];
    const soundDaily = soundIds.length
      ? (await db.from("sound_daily_stats").select("sound_id,stat_date,video_count").in("sound_id", soundIds).order("stat_date")).data ?? []
      : [];
    sounds = soundIds.map((id) => ({ ...soundMap.get(id), daily: soundDaily.filter((d) => d.sound_id === id).map((d) => ({ d: d.stat_date, n: d.video_count })) }));
  }
  const soundTitle = Object.fromEntries(sounds.map((x) => [x.id, x.title]));

  let outPosts = posts.map((p) => {
    const st = latest[p.tiktok_video_id] ?? {};
    return {
      campaign_id: p.campaign_id, video_id: p.tiktok_video_id, url: p.url, caption: p.caption, published_at: p.published_at,
      country: s.show_country ? (p.creator?.country_code ?? p.country_code ?? null) : null,
      sound_id: p.sound_id, sound_title: soundTitle[p.sound_id] ?? null,
      creator: p.creator ? {
        username: p.creator.username, name: p.creator.display_name, verified: p.creator.is_verified, avatar: p.creator.avatar_url,
        followers: s.show_followers ? p.creator.follower_count : null,
      } : null,
      plays: st.plays ?? null, likes: st.likes ?? null, comments: st.comments ?? null, shares: st.shares ?? null, stats_date: st.stat_date ?? null,
      has_cover: !!p.cover_path, _cover: p.cover_path,
    };
  });

  // Follower total for the overview, worked out here so hidden follower counts never leave the server.
  const followerTotal = s.show_followers
    ? Object.values(Object.fromEntries(posts.filter((p) => p.creator).map((p) => [p.creator.username, p.creator.follower_count ?? 0]))).reduce((a: number, b: any) => a + Number(b), 0)
    : null;
  const creatorCount = new Set(posts.map((p) => p.creator?.username).filter(Boolean)).size;
  const postCount = posts.length;

  // Sign covers for the most-viewed posts now; the page asks for the rest as it scrolls.
  let covers: Record<string, string> = {};
  if (s.posts || scope.mode === "team") {
    const top = [...outPosts].sort((a, b) => (b.plays ?? -1) - (a.plays ?? -1)).slice(0, FIRST_COVERS);
    const signed = await signCovers(top.map((p) => p._cover).filter(Boolean));
    covers = Object.fromEntries(top.filter((p) => signed[p._cover]).map((p) => [p.video_id, signed[p._cover]]));
  }
  for (const p of outPosts) delete (p as any)._cover;
  if (scope.mode === "client" && !s.posts) outPosts = [];

  return json({
    mode: scope.mode,
    artist: scope.artist,
    campaigns: campaignsOut,
    posts: outPosts,
    post_count: postCount,
    creator_count: creatorCount,
    follower_total: followerTotal,
    series,
    sounds: scope.mode === "client" && !s.sounds ? [] : sounds,
    covers,
    settings: publicSettings,
    generated_at: new Date().toISOString(),
  });
});
