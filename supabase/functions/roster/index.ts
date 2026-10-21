// roster: Stellar's creator roster. Adds a TikTok creator (from a profile link, a video link or a handle)
// and keeps their topline stats fresh from their recent videos, via ScrapeCreators (1 credit per call:
// one profile call + two pages of recent videos per refresh, so 3 credits a week per roster creator).
//
// Body:
//   { action: "add", input }          team member: add to the roster (or re-add) and refresh now
//   { action: "refresh", creator_id } team member: refresh one creator now
//   {}                                schedule: refresh roster creators not checked for 7 days (a few per run)
//   { action: "probe", handle }       internal check: raw response shapes
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
const SC_KEY = Deno.env.get("SCRAPECREATORS_API_KEY") ?? "";
const TIME_BUDGET_MS = 110_000;
const RECENT = 12;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

async function teamMember(req: Request): Promise<string | null> {
  const jwt = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!jwt.startsWith("ey")) return null;
  const { data } = await db.auth.getUser(jwt);
  const email = data.user?.email?.toLowerCase();
  if (!email) return null;
  const { data: m } = await db.from("team_members").select("email").eq("email", email).maybeSingle();
  return m ? email : null;
}

class NotFound extends Error {}
async function sc(path: string, params: Record<string, string>): Promise<any> {
  if (!SC_KEY) throw new Error("ScrapeCreators key is missing in Supabase secrets");
  const q = new URLSearchParams(params);
  const r = await fetch(`https://api.scrapecreators.com${path}?${q}`, { headers: { "x-api-key": SC_KEY }, signal: AbortSignal.timeout(40_000) });
  const text = await r.text();
  let j: any = null;
  try { j = JSON.parse(text); } catch { /* not JSON */ }
  if (r.status === 404) throw new NotFound("Creator not found (wrong handle, or the account is private or deleted)");
  if (!r.ok || j?.success === false) throw new Error(`ScrapeCreators ${r.status}: ${String(j?.message ?? j?.error ?? text).slice(0, 160)}`);
  return j;
}

// TikTok lists several versions of each image; most are HEIC, which browsers can't show. Prefer JPEG.
const first = (o: any): string | null => {
  if (typeof o === "string") return o;
  const list: string[] = o?.url_list ?? [];
  return list.find((u) => /\.jpe?g(\?|$)/i.test(u)) ?? list.at(-1) ?? null;
};
const num = (v: unknown) => (v == null || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
const median = (xs: number[]) => {
  const s = xs.filter((x) => x != null && Number.isFinite(x)).sort((a, b) => a - b);
  if (!s.length) return null;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

// "https://www.tiktok.com/@name", "@name", "name", or a video link → handle
async function resolveHandle(input: string): Promise<string> {
  const raw = String(input ?? "").trim();
  if (!raw) throw new Error("Paste a TikTok profile link, a video link or a handle");
  if (/^https?:\/\//i.test(raw) || /tiktok\.com/i.test(raw)) {
    const u = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    if (!/(^|\.)tiktok\.com$/i.test(u.hostname)) throw new Error("Only TikTok creators can be added for now");
    const at = u.pathname.match(/\/@([^/?#]+)/);
    if (at && !/\/video\//.test(u.pathname)) return decodeURIComponent(at[1]).toLowerCase();
    // A video link (or a short vm./vt. link): find its author.
    const j = await sc("/v2/tiktok/video", { url: u.toString() });
    const h = j?.aweme_detail?.author?.unique_id;
    if (!h) throw new NotFound("Couldn't find the creator of that video");
    return String(h).toLowerCase();
  }
  return raw.replace(/^@/, "").toLowerCase();
}

async function saveCover(id: string, url: string | null): Promise<string | null> {
  if (!url) return null;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!r.ok) return null;
    const type = r.headers.get("content-type") ?? "image/jpeg";
    if (type.includes("heic")) return null;
    const path = `rv/${id}.${type.includes("webp") ? "webp" : "jpg"}`;
    const { error } = await db.storage.from("covers").upload(path, await r.arrayBuffer(), { contentType: type, upsert: true });
    return error ? null : path;
  } catch { return null; }
}

// TikTok's avatar links expire after a few days: keep a copy in the public "avatars" bucket.
async function saveAvatar(userId: string, url: string | null): Promise<string | null> {
  if (!url) return null;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!r.ok) return url;
    const type = r.headers.get("content-type") ?? "image/jpeg";
    if (!/jpe?g|png|webp/.test(type)) return url;
    const path = `tt/${userId}.${type.includes("webp") ? "webp" : type.includes("png") ? "png" : "jpg"}`;
    const { error } = await db.storage.from("avatars").upload(path, await r.arrayBuffer(), { contentType: type, upsert: true });
    if (error) return url;
    return `${db.storage.from("avatars").getPublicUrl(path).data.publicUrl}?v=${Date.now().toString(36)}`;
  } catch { return url; }
}

// Profile + recent videos → the creator row, with topline stats.
async function refreshCreator(handle: string, opts: { addedBy?: string | null; add?: boolean } = {}) {
  const now = new Date().toISOString();
  const p = await sc("/v1/tiktok/profile", { handle });
  const u = p?.user ?? p?.userInfo?.user ?? {};
  const s = p?.stats ?? p?.userInfo?.stats ?? {};
  if (!u?.id && !u?.uniqueId) throw new NotFound("Creator not found");
  let videos: any[] = [];
  let videoError: string | null = null;
  try {
    // 10 videos per page: read two pages (about 20 recent videos) for steadier medians.
    let cursor: string | undefined;
    const seen = new Set<string>();
    for (let page = 0; page < 2; page++) {
      const v = await sc("/v3/tiktok/profile/videos", { handle, sort_by: "latest", ...(cursor ? { max_cursor: cursor } : {}) });
      const list = (v?.aweme_list ?? v?.videos ?? v?.itemList ?? []).filter((x: any) => (x?.aweme_id || x?.id) && !seen.has(String(x.aweme_id ?? x.id)));
      list.forEach((x: any) => seen.add(String(x.aweme_id ?? x.id)));
      videos.push(...list);
      if (!v?.has_more || !v?.max_cursor || !list.length) break;
      cursor = String(v.max_cursor);
    }
  } catch (e) { if (!videos.length) videoError = String((e as Error).message).slice(0, 200); }

  const items = videos.map((a: any) => {
    const st = a.statistics ?? a.stats ?? {};
    return {
      id: String(a.aweme_id ?? a.id),
      created: num(a.create_time ?? a.createTime),
      pinned: !!(a.is_top || a.isPinned),
      views: num(st.play_count ?? st.playCount), likes: num(st.digg_count ?? st.diggCount),
      comments: num(st.comment_count ?? st.commentCount), shares: num(st.share_count ?? st.shareCount),
      cover: first(a.video?.cover) ?? first(a.video?.origin_cover) ?? a.video?.cover ?? null,
      region: a.region ?? a.author?.region ?? null,
    };
  }).filter((x) => x.created).sort((a, b) => (b.created! - a.created!));
  // Pinned videos are old hits shown first on the profile: leave them out of "recent" numbers.
  const recent = items.filter((x) => !x.pinned).slice(0, 30);
  const views = recent.map((x) => x.views ?? 0);
  const sum = (k: "views" | "likes" | "comments" | "shares") => recent.reduce((t, x) => t + (x[k] ?? 0), 0);
  const nowSec = Date.now() / 1000;
  const in28 = recent.filter((x) => nowSec - x.created! <= 28 * 86400).length;
  const span = recent.length > 1 ? (recent[0].created! - recent.at(-1)!.created!) / 86400 : null;
  const stats = {
    followers: num(s.followerCount ?? s.follower_count),
    following: num(s.followingCount),
    total_likes: num(s.heartCount ?? s.heart),
    video_count: num(s.videoCount),
    sample: recent.length,
    median_views: median(views), avg_views: recent.length ? Math.round(sum("views") / recent.length) : null,
    median_likes: median(recent.map((x) => x.likes ?? 0)), median_comments: median(recent.map((x) => x.comments ?? 0)),
    median_shares: median(recent.map((x) => x.shares ?? 0)),
    engagement: sum("views") ? (sum("likes") + sum("comments") + sum("shares")) / sum("views") : null,
    posts_per_week: in28 >= 2 ? in28 / 4 : span && span > 0 ? Math.round((recent.length / span) * 7 * 10) / 10 : null,
    last_post: recent[0]?.created ? new Date(recent[0].created * 1000).toISOString() : null,
  };
  const latest = items.filter((x) => !x.pinned).slice(0, RECENT);
  const recentVideos = [];
  for (const x of latest) {
    recentVideos.push({
      id: x.id, url: `https://www.tiktok.com/@${handle}/video/${x.id}`, cover_path: await saveCover(x.id, x.cover),
      views: x.views, likes: x.likes, comments: x.comments, shares: x.shares,
      posted: x.created ? new Date(x.created * 1000).toISOString() : null,
    });
  }
  const row: Record<string, unknown> = {
    tiktok_user_id: String(u.id ?? u.uniqueId), platform: "tiktok",
    username: String(u.uniqueId ?? handle).toLowerCase(), display_name: u.nickname ?? null,
    avatar_url: await saveAvatar(String(u.id ?? u.uniqueId), u.avatarLarger ?? u.avatarMedium ?? u.avatarThumb ?? null), bio: u.signature ?? null,
    follower_count: stats.followers, is_verified: !!u.verified,
    profile_stats: stats, recent_videos: recentVideos, stats_checked_at: now, stats_error: videoError,
  };
  const region = items.find((x) => x.region)?.region;
  if (region) row.country_code = String(region).toUpperCase();
  if (opts.add) {
    // Keep the original "added" date and person when an existing roster creator is added again.
    const { data: prev } = await db.from("creators").select("on_roster,roster_added_at").eq("tiktok_user_id", row.tiktok_user_id).maybeSingle();
    row.on_roster = true;
    if (!prev?.on_roster || !prev?.roster_added_at) { row.roster_added_at = now; row.roster_added_by = opts.addedBy ?? null; }
  }
  const { data, error } = await db.from("creators").upsert(row, { onConflict: "tiktok_user_id" }).select("id,on_roster,roster_added_at").single();
  if (error) throw new Error(error.message);
  return { id: data.id, username: row.username, stats, video_error: videoError };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const { data: secret } = await db.rpc("trending_cron_secret");
  const internal = !!secret && req.headers.get("x-cron-secret") === secret;
  const member = internal ? null : await teamMember(req);
  if (!internal && !member) return json({ error: "Sign in as a Stellar team member." }, 401);
  let body: any = {};
  try { body = await req.json(); } catch { /* schedule sends {} */ }
  try {
    if (body?.action === "probe" && internal) {
      const p = await sc("/v1/tiktok/profile", { handle: String(body.handle) });
      const v = await sc("/v3/tiktok/profile/videos", { handle: String(body.handle), sort_by: "latest" });
      const a = (v?.aweme_list ?? [])[0] ?? {};
      return json({ profile_keys: Object.keys(p ?? {}), user_keys: Object.keys(p?.user ?? {}), stats: p?.stats, videos_keys: Object.keys(v ?? {}), n: (v?.aweme_list ?? []).length,
        video_keys: Object.keys(a), video_stats: a.statistics, has_more: v?.has_more, cursor: v?.max_cursor, region: a.region, author_region: a.author?.region, is_top: a.is_top });
    }
    if (body?.action === "add") {
      const handle = await resolveHandle(body.input);
      return json(await refreshCreator(handle, { add: true, addedBy: member }));
    }
    if (body?.action === "refresh") {
      const { data: c } = await db.from("creators").select("username,platform").eq("id", body.creator_id).maybeSingle();
      if (!c) return json({ error: "Creator not found" }, 404);
      if (c.platform !== "tiktok") return json({ error: "Only TikTok creators can be refreshed for now" }, 400);
      return json(await refreshCreator(c.username));
    }
    if (body?.action) return json({ error: "Unknown action" }, 400);
    // Schedule: roster creators whose numbers are a week old, oldest first, within the time budget.
    const started = Date.now();
    const weekAgo = new Date(Date.now() - 6.5 * 86_400_000).toISOString();
    const { data: due } = await db.from("creators").select("id,username").eq("on_roster", true).eq("platform", "tiktok")
      .or(`stats_checked_at.is.null,stats_checked_at.lt.${weekAgo}`).order("stats_checked_at", { ascending: true, nullsFirst: true }).limit(25);
    let ok = 0; const errors: string[] = [];
    for (const c of due ?? []) {
      if (Date.now() - started > TIME_BUDGET_MS) break;
      try { await refreshCreator(c.username); ok++; } catch (e) {
        errors.push(`${c.username}: ${String((e as Error).message).slice(0, 120)}`);
        await db.from("creators").update({ stats_checked_at: new Date().toISOString(), stats_error: String((e as Error).message).slice(0, 200) }).eq("id", c.id);
      }
    }
    return json({ refreshed: ok, due: (due ?? []).length, errors });
  } catch (e) {
    const status = e instanceof NotFound ? 404 : 502;
    return json({ error: String((e as Error).message).slice(0, 300) }, status);
  }
});
