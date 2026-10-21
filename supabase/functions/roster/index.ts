// roster: Stellar's creator roster. Adds a creator (from a profile link, a video link or a handle) on
// TikTok, Instagram, YouTube, X or Twitch, and keeps their topline stats fresh from their recent posts.
// Cost per refresh: TikTok 3 ScrapeCreators credits (profile + two pages of videos), Instagram 1 (profile
// with its 12 latest posts), X 1 (profile only), Twitch 1 (profile with recent broadcasts), YouTube free
// (Google's official API, a few of the 10,000 daily units).
//
// Body:
//   { action: "add", input, platform? } team member: add to the roster (or re-add) and refresh now;
//                                     platform is only needed for a bare @handle (default TikTok)
//   { action: "refresh", creator_id } team member: refresh one creator now
//   {}                                schedule: refresh roster creators not checked for 7 days (a few per run)
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
const YT_KEY = Deno.env.get("YOUTUBE_API_KEY") ?? "";
const PLATFORMS = ["tiktok", "instagram", "youtube", "twitter", "twitch"] as const;
type Platform = typeof PLATFORMS[number];

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

// A profile link, a video/post link, or a handle (+ platform) → { platform, handle }.
async function resolveInput(input: string, platformHint?: string): Promise<{ platform: Platform; handle: string }> {
  const raw = String(input ?? "").trim();
  if (!raw) throw new Error("Paste a profile link, a video link or a handle");
  const looksLikeUrl = /^https?:\/\//i.test(raw) || /^(www\.|m\.|vm\.|vt\.)?(tiktok|instagram|youtube|youtu|x|twitter|twitch)\.(com|be|tv)\//i.test(raw);
  if (!looksLikeUrl) {
    const p = (PLATFORMS as readonly string[]).includes(String(platformHint)) ? platformHint as Platform : "tiktok";
    const handle = raw.replace(/^@/, "").trim();
    if (!/^[\w.\-]{1,100}$/.test(handle)) throw new Error("That doesn't look like a handle");
    return { platform: p, handle: p === "youtube" ? handle : handle.toLowerCase() };
  }
  const u = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  const host = u.hostname.toLowerCase().replace(/^(www|m|mobile)\./, "");
  const seg = u.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (/(^|\.)tiktok\.com$/.test(host)) {
    const at = u.pathname.match(/\/@([^/?#]+)/);
    if (at && !/\/video\//.test(u.pathname)) return { platform: "tiktok", handle: decodeURIComponent(at[1]).toLowerCase() };
    const j = await sc("/v2/tiktok/video", { url: u.toString() });
    const h = j?.aweme_detail?.author?.unique_id;
    if (!h) throw new NotFound("Couldn't find the creator of that video");
    return { platform: "tiktok", handle: String(h).toLowerCase() };
  }
  if (host === "instagram.com") {
    if (!seg[0] || ["p", "reel", "reels", "tv", "stories", "explore"].includes(seg[0])) throw new Error("Paste the Instagram profile link (instagram.com/name) or the @handle");
    return { platform: "instagram", handle: seg[0].toLowerCase() };
  }
  if (host === "x.com" || host === "twitter.com") {
    if (!seg[0] || ["i", "home", "search", "hashtag"].includes(seg[0])) throw new Error("Paste the X profile link (x.com/name) or the @handle");
    return { platform: "twitter", handle: seg[0].toLowerCase() };
  }
  if (host === "twitch.tv") {
    if (!seg[0] || ["videos", "directory"].includes(seg[0])) throw new Error("Paste the Twitch channel link (twitch.tv/name)");
    return { platform: "twitch", handle: seg[0].toLowerCase() };
  }
  if (host === "youtube.com" || host === "youtu.be") {
    if (seg[0]?.startsWith("@")) return { platform: "youtube", handle: seg[0].slice(1) };
    if (seg[0] === "channel" && seg[1]) return { platform: "youtube", handle: seg[1] };   // UC… channel id
    const v = host === "youtu.be" ? seg[0] : u.searchParams.get("v") ?? (["shorts", "live", "embed"].includes(seg[0]) ? seg[1] : null);
    if (v) {
      const j = await yt("videos", { part: "snippet", id: v });
      const ch = j?.items?.[0]?.snippet?.channelId;
      if (!ch) throw new NotFound("Couldn't find that YouTube video");
      return { platform: "youtube", handle: ch };
    }
    throw new Error("Paste the YouTube channel link (youtube.com/@name) or a video link");
  }
  throw new Error("Paste a TikTok, Instagram, YouTube, X or Twitch link");
}

async function yt(path: string, params: Record<string, string>): Promise<any> {
  if (!YT_KEY) throw new Error("YouTube key is missing: add YOUTUBE_API_KEY in Supabase → Edge Functions → Secrets");
  const r = await fetch(`https://www.googleapis.com/youtube/v3/${path}?${new URLSearchParams({ ...params, key: YT_KEY })}`, { signal: AbortSignal.timeout(20_000) });
  const j = await r.json().catch(() => null);
  if (!r.ok) throw new Error(j?.error?.errors?.[0]?.reason === "quotaExceeded" ? "YouTube's free daily allowance is used up; try again tomorrow" : `YouTube replied ${r.status}: ${String(j?.error?.message ?? "").slice(0, 120)}`);
  return j;
}

async function saveCover(id: string, url: string | null): Promise<string | null> {
  if (!url) return null;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(15_000), headers: { "User-Agent": "Mozilla/5.0" } });
    if (!r.ok) return null;
    const type = r.headers.get("content-type") ?? "image/jpeg";
    if (type.includes("heic")) return null;
    const path = `rv/${id.replace(/[^\w-]/g, "_")}.${type.includes("webp") ? "webp" : type.includes("png") ? "png" : "jpg"}`;
    const { error } = await db.storage.from("covers").upload(path, await r.arrayBuffer(), { contentType: type, upsert: true });
    return error ? null : path;
  } catch { return null; }
}

// TikTok's avatar links expire after a few days: keep a copy in the public "avatars" bucket.
async function saveAvatar(key: string, url: string | null): Promise<string | null> {
  if (!url) return null;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!r.ok) return url;
    const type = r.headers.get("content-type") ?? "image/jpeg";
    if (!/jpe?g|png|webp/.test(type)) return url;
    const safe = key.replace(/[^\w-]/g, "_");
    const path = `${/^\d+$/.test(key) ? "tt/" : ""}${safe}.${type.includes("webp") ? "webp" : type.includes("png") ? "png" : "jpg"}`;
    const { error } = await db.storage.from("avatars").upload(path, await r.arrayBuffer(), { contentType: type, upsert: true });
    if (error) return url;
    return `${db.storage.from("avatars").getPublicUrl(path).data.publicUrl}?v=${Date.now().toString(36)}`;
  } catch { return url; }
}

// One post, whatever the platform. created = unix seconds.
type Item = { id: string; url: string; created: number | null; pinned?: boolean; views: number | null; likes: number | null; comments: number | null; shares: number | null; cover?: string | null; coverUrl?: string | null; region?: string | null };
type Snapshot = { key: string; platform: Platform; username: string; display_name: string | null; avatar: string | null; bio: string | null; verified: boolean;
  followers: number | null; extra?: Record<string, unknown>; items: Item[]; country?: string | null; basis: "views" | "followers"; videoError?: string | null };

// Posts per week. When every post we could read is from the last 28 days, the creator posts more than
// we can see, so the rate comes from the time those posts span instead of the 28-day count.
function postsPerWeek(recent: Item[], in28: number, span: number | null) {
  if (in28 >= 3 && in28 === recent.length && span && span > 0) return Math.round(((recent.length - 1) / span) * 7 * 10) / 10;
  if (in28 >= 2) return in28 / 4;
  return span && span > 0 ? Math.round((recent.length / span) * 7 * 10) / 10 : null;
}

// Topline numbers from recent posts. Engagement per view where views exist (TikTok, YouTube, Twitch),
// per follower on Instagram and X, where most posts have no view count.
function statsOf(snap: Snapshot) {
  const recent = snap.items.filter((x) => !x.pinned && x.created).sort((a, b) => b.created! - a.created!).slice(0, 30);
  const withViews = recent.filter((x) => x.views != null);
  const sum = (xs: Item[], k: "views" | "likes" | "comments" | "shares") => xs.reduce((t, x) => t + (x[k] ?? 0), 0);
  const nowSec = Date.now() / 1000;
  const in28 = recent.filter((x) => nowSec - x.created! <= 28 * 86400).length;
  const span = recent.length > 1 ? (recent[0].created! - recent.at(-1)!.created!) / 86400 : null;
  const inter = (xs: Item[]) => sum(xs, "likes") + sum(xs, "comments") + sum(xs, "shares");
  const engagement = snap.basis === "views"
    ? (sum(withViews, "views") ? inter(withViews) / sum(withViews, "views") : null)
    : (snap.followers && recent.length ? inter(recent) / recent.length / snap.followers : null);
  return {
    followers: snap.followers, ...(snap.extra ?? {}),
    sample: recent.length, views_sample: withViews.length, engagement_basis: snap.basis,
    median_views: median(withViews.map((x) => x.views!)), avg_views: withViews.length ? Math.round(sum(withViews, "views") / withViews.length) : null,
    median_likes: median(recent.filter((x) => x.likes != null).map((x) => x.likes!)), median_comments: median(recent.filter((x) => x.comments != null).map((x) => x.comments!)),
    median_shares: recent.some((x) => x.shares != null) ? median(recent.filter((x) => x.shares != null).map((x) => x.shares!)) : null,
    engagement,
    posts_per_week: postsPerWeek(recent, in28, span),
    last_post: recent[0]?.created ? new Date(recent[0].created * 1000).toISOString() : (snap.extra?.last_post as string ?? null),
  };
}

async function fetchTikTok(handle: string): Promise<Snapshot> {
  const p = await sc("/v1/tiktok/profile", { handle });
  const u = p?.user ?? p?.userInfo?.user ?? {};
  const s = p?.stats ?? p?.userInfo?.stats ?? {};
  if (!u?.id && !u?.uniqueId) throw new NotFound("Creator not found");
  const videos: any[] = [];
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
  const username = String(u.uniqueId ?? handle).toLowerCase();
  const items: Item[] = videos.map((a: any) => {
    const st = a.statistics ?? a.stats ?? {};
    const id = String(a.aweme_id ?? a.id);
    return {
      id, url: `https://www.tiktok.com/@${username}/video/${id}`,
      created: num(a.create_time ?? a.createTime), pinned: !!(a.is_top || a.isPinned),
      views: num(st.play_count ?? st.playCount), likes: num(st.digg_count ?? st.diggCount),
      comments: num(st.comment_count ?? st.commentCount), shares: num(st.share_count ?? st.shareCount),
      cover: first(a.video?.cover) ?? first(a.video?.origin_cover) ?? a.video?.cover ?? null,
      region: a.region ?? a.author?.region ?? null,
    };
  });
  return {
    key: String(u.id ?? u.uniqueId), platform: "tiktok", username, display_name: u.nickname ?? null,
    avatar: u.avatarLarger ?? u.avatarMedium ?? u.avatarThumb ?? null, bio: u.signature ?? null, verified: !!u.verified,
    followers: num(s.followerCount ?? s.follower_count),
    extra: { following: num(s.followingCount), total_likes: num(s.heartCount ?? s.heart), video_count: num(s.videoCount) },
    items, country: items.find((x) => x.region)?.region ?? null, basis: "views", videoError,
  };
}

async function fetchInstagram(handle: string): Promise<Snapshot> {
  const j = await sc("/v1/instagram/profile", { handle });
  const u = j?.data?.user;
  if (!u?.id) throw new NotFound(j?.message ?? "Instagram account not found (wrong handle, or private)");
  const edges = u.edge_owner_to_timeline_media?.edges ?? [];
  const items: Item[] = edges.map((e: any) => e.node).filter(Boolean).map((n: any) => ({
    id: `ig_${n.id}`, url: `https://www.instagram.com/${n.product_type === "clips" ? "reel" : "p"}/${n.shortcode}/`,
    created: num(n.taken_at_timestamp), pinned: false,
    views: n.is_video ? num(n.video_play_count ?? n.video_view_count) : null,
    likes: n.like_and_view_counts_disabled ? null : num(n.edge_media_preview_like?.count ?? n.edge_liked_by?.count),
    comments: num(n.edge_media_to_comment?.count ?? n.comment_count), shares: null,
    cover: n.thumbnail_src ?? n.display_url ?? null,
  }));
  // Pinned posts come first on the profile and are older than the posts after them: leave them out.
  for (let i = 0; i < Math.min(3, items.length); i++) {
    const newerLater = items.slice(i + 1).some((x) => (x.created ?? 0) > (items[i].created ?? 0));
    if (newerLater) items[i].pinned = true;
  }
  return {
    key: `ig:${u.id}`, platform: "instagram", username: String(u.username ?? handle).toLowerCase(), display_name: u.full_name || null,
    avatar: u.profile_pic_url_hd ?? u.profile_pic_url ?? null, bio: u.biography ?? null, verified: !!u.is_verified,
    followers: num(u.edge_followed_by?.count), extra: { following: num(u.edge_follow?.count), video_count: num(u.edge_owner_to_timeline_media?.count), category: u.category_name ?? null },
    items, basis: "followers", videoError: u.is_private ? "This account is private, so its posts can't be read" : null,
  };
}

async function fetchYouTube(handle: string): Promise<Snapshot> {
  const isId = /^UC[\w-]{22}$/.test(handle);
  const cj = await yt("channels", { part: "snippet,statistics,contentDetails", ...(isId ? { id: handle } : { forHandle: `@${handle.replace(/^@/, "")}` }) });
  const c = cj?.items?.[0];
  if (!c) throw new NotFound("YouTube channel not found");
  const uploads = c.contentDetails?.relatedPlaylists?.uploads;
  let items: Item[] = [];
  if (uploads) {
    const pl = await yt("playlistItems", { part: "contentDetails", playlistId: uploads, maxResults: "20" });
    const ids = (pl?.items ?? []).map((x: any) => x.contentDetails?.videoId).filter(Boolean);
    if (ids.length) {
      const vj = await yt("videos", { part: "snippet,statistics", id: ids.join(","), maxResults: "50" });
      items = (vj?.items ?? []).map((v: any) => {
        const t = v.snippet?.thumbnails ?? {};
        return {
          id: `yt_${v.id}`, url: `https://www.youtube.com/watch?v=${v.id}`,
          created: v.snippet?.publishedAt ? Math.floor(Date.parse(v.snippet.publishedAt) / 1000) : null,
          views: num(v.statistics?.viewCount), likes: num(v.statistics?.likeCount), comments: num(v.statistics?.commentCount), shares: null,
          coverUrl: t.high?.url ?? t.medium?.url ?? t.default?.url ?? null,
        };
      });
    }
  }
  const sn = c.snippet ?? {};
  const custom = String(sn.customUrl ?? "").replace(/^@/, "");
  return {
    key: `yt:${c.id}`, platform: "youtube", username: custom || c.id, display_name: sn.title ?? null,
    avatar: sn.thumbnails?.high?.url ?? sn.thumbnails?.medium?.url ?? sn.thumbnails?.default?.url ?? null, bio: sn.description ?? null, verified: false,
    followers: c.statistics?.hiddenSubscriberCount ? null : num(c.statistics?.subscriberCount),
    extra: { video_count: num(c.statistics?.videoCount), total_views: num(c.statistics?.viewCount) },
    items, country: sn.country ?? null, basis: "views",
  };
}

async function fetchTwitter(handle: string): Promise<Snapshot> {
  const j = await sc("/v1/twitter/profile", { handle });
  if (j?.message && !j?.legacy && !j?.rest_id && !j?.data) throw new NotFound(String(j.message));
  const r = j?.data?.user?.result ?? j?.data?.user_result?.result ?? j?.user ?? j;
  const l = r?.legacy ?? r ?? {};
  const id = r?.rest_id ?? r?.id_str ?? l?.id_str ?? r?.id;
  if (!id) throw new NotFound("X account not found");
  const pic = String(r?.avatar?.image_url ?? l.profile_image_url_https ?? "").replace("_normal.", "_400x400.") || null;
  return {
    key: `x:${id}`, platform: "twitter", username: String(r?.core?.screen_name ?? l.screen_name ?? handle).toLowerCase(),
    display_name: r?.core?.name ?? l.name ?? null, avatar: pic, bio: r?.legacy?.description ?? l.description ?? null,
    verified: !!(r?.is_blue_verified || l.verified), followers: num(l.followers_count ?? r?.followers_count),
    extra: { following: num(l.friends_count), video_count: num(l.statuses_count), total_likes: num(l.favourites_count) },
    items: [], basis: "followers", videoError: null,
  };
}

async function fetchTwitch(handle: string): Promise<Snapshot> {
  const j = await sc("/v1/twitch/profile", { handle });
  if (!j?.id) throw new NotFound(j?.message ?? "Twitch channel not found");
  const items: Item[] = (j.allVideos ?? []).map((v: any) => ({
    id: `twitch_${v.id}`, url: `https://www.twitch.tv/videos/${v.id}`,
    created: v.publishedAt || v.createdAt ? Math.floor(Date.parse(v.publishedAt ?? v.createdAt) / 1000) : null,
    views: num(v.viewCount), likes: null, comments: null, shares: null,
    cover: v.previewThumbnailURL ?? v.thumbnailURLs?.[0] ?? null,
  }));
  return {
    key: `twitch:${j.id}`, platform: "twitch", username: String(j.handle ?? handle).toLowerCase(), display_name: j.displayName ?? null,
    avatar: j.profileImageURL ? String(j.profileImageURL).replace(/-\d+x\d+\./, "-300x300.") : null, bio: j.description ?? null, verified: !!j.isPartner,
    followers: num(j.followers), extra: { partner: !!j.isPartner, last_post: j.lastBroadcast?.startedAt ?? null, last_stream_title: j.lastBroadcast?.title ?? null },
    items, basis: "views",
  };
}

const FETCH: Record<Platform, (h: string) => Promise<Snapshot>> = { tiktok: fetchTikTok, instagram: fetchInstagram, youtube: fetchYouTube, twitter: fetchTwitter, twitch: fetchTwitch };

// Fetch → the creator row, with topline stats and the latest posts (covers kept in storage).
async function refreshCreator(platform: Platform, handle: string, opts: { addedBy?: string | null; add?: boolean } = {}) {
  const now = new Date().toISOString();
  const snap = await FETCH[platform](handle);
  const stats = statsOf(snap);
  const latest = snap.items.filter((x) => !x.pinned && x.created).sort((a, b) => b.created! - a.created!).slice(0, RECENT);
  const recentVideos = [];
  for (const x of latest) {
    recentVideos.push({
      id: x.id, url: x.url, cover_path: x.cover ? await saveCover(x.id, x.cover) : null, cover_url: x.coverUrl ?? null,
      views: x.views, likes: x.likes, comments: x.comments, shares: x.shares,
      posted: x.created ? new Date(x.created * 1000).toISOString() : null,
    });
  }
  const row: Record<string, unknown> = {
    tiktok_user_id: snap.key, platform: snap.platform, username: snap.username, display_name: snap.display_name,
    avatar_url: await saveAvatar(snap.key, snap.avatar), bio: snap.bio,
    follower_count: snap.followers, is_verified: snap.verified,
    profile_stats: stats, recent_videos: recentVideos, stats_checked_at: now, stats_error: snap.videoError ?? null,
  };
  if (snap.country) row.country_code = String(snap.country).toUpperCase().slice(0, 2);
  if (opts.add) {
    // Keep the original "added" date and person when an existing roster creator is added again.
    const { data: prev } = await db.from("creators").select("on_roster,roster_added_at").eq("tiktok_user_id", snap.key).maybeSingle();
    row.on_roster = true;
    if (!prev?.on_roster || !prev?.roster_added_at) { row.roster_added_at = now; row.roster_added_by = opts.addedBy ?? null; }
  }
  const { data, error } = await db.from("creators").upsert(row, { onConflict: "tiktok_user_id" }).select("id").single();
  if (error) throw new Error(error.message);
  return { id: data.id, platform: snap.platform, username: snap.username, stats, video_error: snap.videoError ?? null };
}

// The handle to refresh an existing row with: YouTube rows use their channel id (handles can change).
const refreshHandle = (c: { platform: string; username: string; tiktok_user_id: string }) =>
  c.platform === "youtube" ? c.tiktok_user_id.replace(/^yt:/, "") : c.username;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const { data: secret } = await db.rpc("trending_cron_secret");
  const internal = !!secret && req.headers.get("x-cron-secret") === secret;
  const member = internal ? null : await teamMember(req);
  if (!internal && !member) return json({ error: "Sign in as a Stellar team member." }, 401);
  let body: any = {};
  try { body = await req.json(); } catch { /* schedule sends {} */ }
  try {
    if (body?.action === "add") {
      const { platform, handle } = await resolveInput(body.input, body.platform);
      return json(await refreshCreator(platform, handle, { add: true, addedBy: member }));
    }
    if (body?.action === "refresh") {
      const { data: c } = await db.from("creators").select("username,platform,tiktok_user_id").eq("id", body.creator_id).maybeSingle();
      if (!c) return json({ error: "Creator not found" }, 404);
      return json(await refreshCreator((c.platform ?? "tiktok") as Platform, refreshHandle(c)));
    }
    if (body?.action) return json({ error: "Unknown action" }, 400);
    // Schedule: roster creators whose numbers are a week old, oldest first, within the time budget.
    const started = Date.now();
    const weekAgo = new Date(Date.now() - 6.5 * 86_400_000).toISOString();
    const { data: due } = await db.from("creators").select("id,username,platform,tiktok_user_id").eq("on_roster", true)
      .or(`stats_checked_at.is.null,stats_checked_at.lt.${weekAgo}`).order("stats_checked_at", { ascending: true, nullsFirst: true }).limit(25);
    let ok = 0; const errors: string[] = [];
    for (const c of due ?? []) {
      if (Date.now() - started > TIME_BUDGET_MS) break;
      try { await refreshCreator((c.platform ?? "tiktok") as Platform, refreshHandle(c)); ok++; } catch (e) {
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
