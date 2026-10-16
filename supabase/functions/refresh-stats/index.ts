// refresh-stats: collects today's numbers for posts and sounds.
//
// Two ways it runs:
// 1. Daily (no user signed in): called by a schedule every 5 minutes in the early morning.
//    Each run handles the next batch of videos that don't have today's numbers yet, so it
//    can never collect the same video twice in a day, however often it's called.
// 2. "Refresh now" (a signed-in team member): refreshes one campaign right away,
//    skipping videos checked in the last hour.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import { ytVideos, ytChannels, videoStats, channelFollowers } from "./youtube.ts";

function serviceKey(): string {
  const raw = Deno.env.get("SUPABASE_SECRET_KEYS");
  if (raw) {
    try { const k = JSON.parse(raw); const v = k.default ?? Object.values(k)[0]; if (v) return String(v); } catch { /* ignore */ }
  }
  return Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
}
const db = createClient(Deno.env.get("SUPABASE_URL")!, serviceKey(), { auth: { persistSession: false } });
const SC_KEY = Deno.env.get("SCRAPECREATORS_API_KEY") ?? "";
const CONCURRENCY = 6;
const TIME_BUDGET_MS = 110_000; // stay well inside the Edge Function time limit
const MANUAL_LIMIT = 300;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
const todayCph = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Copenhagen" }).format(new Date());

class NotFound extends Error {}

async function scGet(path: string): Promise<any> {
  if (!SC_KEY) throw new Error("ScrapeCreators key is missing in Supabase secrets");
  const r = await fetch(`https://api.scrapecreators.com${path}`, { headers: { "x-api-key": SC_KEY } });
  const text = await r.text();
  let j: any = null;
  try { j = JSON.parse(text); } catch { /* not JSON */ }
  if (r.status === 404) throw new NotFound("Not found");
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${String(j?.message ?? text).slice(0, 120)}`);
  return j;
}

async function refreshVideo(videoId: string, url: string, statDate: string) {
  const now = new Date().toISOString();
  try {
    const j = await scGet(`/v2/tiktok/video?url=${encodeURIComponent(url)}`);
    const a = j?.aweme_detail;
    if (!a?.aweme_id) throw new NotFound("Video not found");
    const s = a.statistics ?? {};
    await db.from("post_daily_stats").upsert({
      tiktok_video_id: videoId, stat_date: statDate,
      plays: s.play_count ?? null, likes: s.digg_count ?? null,
      comments: s.comment_count ?? null, shares: s.share_count ?? null, captured_at: now,
    }, { onConflict: "tiktok_video_id,stat_date" });
    await db.from("posts").update({ last_checked_at: now, last_refresh_attempt_at: now, last_refresh_error: null }).eq("tiktok_video_id", videoId);
    // Keep follower counts fresh too; it comes free with the same lookup.
    const au = a.author;
    if (au?.uid && au.follower_count != null) {
      await db.from("creators").update({ follower_count: au.follower_count }).eq("tiktok_user_id", String(au.uid));
    }
    return "ok";
  } catch (e) {
    if (e instanceof NotFound) {
      await db.from("posts").update({ status: "unavailable", last_refresh_attempt_at: now, last_refresh_error: "Video no longer available (deleted or private)" }).eq("tiktok_video_id", videoId);
      return "unavailable";
    }
    await db.from("posts").update({ last_refresh_attempt_at: now, last_refresh_error: String((e as Error).message).slice(0, 200) }).eq("tiktok_video_id", videoId);
    return "error";
  }
}

// YouTube videos ("yt:" ids) in one go: Google's API takes 50 ids per call, so no per-video lookups.
async function refreshYouTube(videoIds: string[], statDate: string): Promise<Record<string, number>> {
  const tally: Record<string, number> = {};
  if (!videoIds.length) return tally;
  const now = new Date().toISOString();
  const raw = videoIds.map((v) => v.slice(3));
  let found: Map<string, any>;
  try { found = await ytVideos(raw); } catch (e) {
    await db.from("posts").update({ last_refresh_attempt_at: now, last_refresh_error: String((e as Error).message).slice(0, 200) }).in("tiktok_video_id", videoIds);
    tally.error = videoIds.length;
    return tally;
  }
  for (const id of raw) {
    const v = found.get(id), key = `yt:${id}`;
    if (!v) {
      await db.from("posts").update({ status: "unavailable", last_refresh_attempt_at: now, last_refresh_error: "Video no longer available (deleted or private)" }).eq("tiktok_video_id", key);
      tally.unavailable = (tally.unavailable ?? 0) + 1;
      continue;
    }
    await db.from("post_daily_stats").upsert({ tiktok_video_id: key, stat_date: statDate, ...videoStats(v), captured_at: now }, { onConflict: "tiktok_video_id,stat_date" });
    await db.from("posts").update({ last_checked_at: now, last_refresh_attempt_at: now, last_refresh_error: null }).eq("tiktok_video_id", key);
    tally.ok = (tally.ok ?? 0) + 1;
  }
  // Subscriber counts, one call per 50 channels.
  try {
    const chIds = [...new Set([...found.values()].map((v) => v.snippet?.channelId).filter(Boolean))];
    const chans = await ytChannels(chIds);
    for (const [cid, c] of chans) {
      const f = channelFollowers(c);
      if (f != null) await db.from("creators").update({ follower_count: f }).eq("tiktok_user_id", `yt:${cid}`);
    }
  } catch { /* follower counts can wait for tomorrow */ }
  return tally;
}
const isYT = (id: string) => id.startsWith("yt:");
const merge = (a: Record<string, number>, b: Record<string, number>) => { for (const k in b) a[k] = (a[k] ?? 0) + b[k]; return a; };

async function refreshSound(id: string, soundId: string, statDate: string) {
  const now = new Date().toISOString();
  try {
    const j = await scGet(`/v1/tiktok/song?clipId=${encodeURIComponent(soundId)}`);
    const m = j?.music_info ?? {};
    await db.from("sound_daily_stats").upsert({ sound_id: id, stat_date: statDate, video_count: m.user_count ?? null, captured_at: now }, { onConflict: "sound_id,stat_date" });
    const update: Record<string, unknown> = { last_checked_at: now };
    if (m.matched_song?.title) update.matched_song_title = m.matched_song.title;
    if (m.matched_song?.author) update.matched_song_author = m.matched_song.author;
    await db.from("sounds").update(update).eq("id", id);
    return "ok";
  } catch {
    await db.from("sounds").update({ last_checked_at: now }).eq("id", id);
    return "error";
  }
}

async function runPool<T>(items: T[], fn: (t: T) => Promise<string>, deadline: number) {
  const tally: Record<string, number> = {};
  const queue = [...items];
  const worker = async () => {
    for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
      if (Date.now() > deadline) { tally.deferred = (tally.deferred ?? 0) + 1 + queue.length; queue.length = 0; return; }
      const r = await fn(next);
      tally[r] = (tally[r] ?? 0) + 1;
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return tally;
}

async function teamMemberFrom(req: Request): Promise<string | null> {
  const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!token || !token.startsWith("ey")) return null; // publishable/anon keys aren't user sessions
  const { data } = await db.auth.getUser(token);
  const email = data.user?.email?.toLowerCase();
  if (!email) return null;
  const { data: member } = await db.from("team_members").select("email").eq("email", email).maybeSingle();
  return member ? email : null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const started = Date.now();
  const deadline = started + TIME_BUDGET_MS;
  const statDate = todayCph();
  let body: any = {};
  try { body = await req.json(); } catch { /* empty body is fine */ }

  const member = await teamMemberFrom(req);

  // "Refresh now" for one campaign
  if (body?.campaign_id) {
    if (!member) return json({ error: "Sign in as a team member to refresh a campaign." }, 401);
    const hourAgo = new Date(Date.now() - 3600_000).toISOString();
    const { data: posts, error } = await db.from("posts").select("tiktok_video_id,url,last_checked_at")
      .eq("campaign_id", body.campaign_id).eq("status", "active");
    if (error) return json({ error: error.message }, 500);
    const seen = new Set<string>();
    const due = (posts ?? []).filter((p) => {
      if (seen.has(p.tiktok_video_id)) return false;
      seen.add(p.tiktok_video_id);
      return !p.last_checked_at || p.last_checked_at < hourAgo;
    });
    const skipped = seen.size - due.length;
    const batch = due.slice(0, MANUAL_LIMIT);
    const videos = merge(await runPool(batch.filter((p) => !isYT(p.tiktok_video_id)), (p) => refreshVideo(p.tiktok_video_id, p.url, statDate), deadline),
      await refreshYouTube(batch.filter((p) => isYT(p.tiktok_video_id)).map((p) => p.tiktok_video_id), statDate));

    const { data: links } = await db.from("campaign_sounds").select("sound:sounds(id,tiktok_sound_id,last_checked_at)").eq("campaign_id", body.campaign_id);
    const soundsDue = (links ?? []).map((l: any) => l.sound).filter((s: any) => s && (!s.last_checked_at || s.last_checked_at < hourAgo));
    const sounds = await runPool(soundsDue, (s: any) => refreshSound(s.id, s.tiktok_sound_id, statDate), deadline);

    console.log("manual refresh", body.campaign_id, "by", member, JSON.stringify({ videos, sounds, skipped }));
    return json({ mode: "manual", stat_date: statDate, videos, sounds, skipped_recent: skipped, left_for_daily_run: Math.max(0, due.length - batch.length) });
  }

  // Daily run: next batch of whatever still lacks today's numbers
  const { data: soundsDue } = await db.rpc("sounds_due_for_refresh", { max_rows: 100 });
  const sounds = await runPool(soundsDue ?? [], (s: any) => refreshSound(s.id, s.tiktok_sound_id, statDate), deadline);
  const { data: videosDue, error } = await db.rpc("videos_due_for_refresh", { max_rows: 600 });
  if (error) { console.error("videos_due_for_refresh failed", error.message); return json({ error: error.message }, 500); }
  const due = (videosDue ?? []) as { tiktok_video_id: string; url: string }[];
  const videos = merge(await refreshYouTube(due.filter((v) => isYT(v.tiktok_video_id)).map((v) => v.tiktok_video_id), statDate),
    await runPool(due.filter((v) => !isYT(v.tiktok_video_id)), (v) => refreshVideo(v.tiktok_video_id, v.url, statDate), deadline));

  const summary = { mode: "daily", stat_date: statDate, sounds, videos, seconds: Math.round((Date.now() - started) / 1000) };
  if ((videosDue ?? []).length || (soundsDue ?? []).length) console.log("daily refresh", JSON.stringify(summary));
  return json(summary);
});
