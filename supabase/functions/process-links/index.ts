// process-links: turns a batch of pasted TikTok links into posts.
// Called by the database (pg_net) right after a team member inserts link_job_items.
// Body: { "job_id": "<uuid>" }. It only processes jobs that are still "pending",
// so calling it twice, or by anyone else, can't double-process or touch other data.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

// Newer projects expose secret keys as SUPABASE_SECRET_KEYS (JSON); older ones as SUPABASE_SERVICE_ROLE_KEY.
function serviceKey(): string {
  const raw = Deno.env.get("SUPABASE_SECRET_KEYS");
  if (raw) {
    try { const k = JSON.parse(raw); const v = k.default ?? Object.values(k)[0]; if (v) return String(v); } catch { /* ignore */ }
  }
  return Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
}
const db = createClient(Deno.env.get("SUPABASE_URL")!, serviceKey(), { auth: { persistSession: false } });
const SC_KEY = Deno.env.get("SCRAPECREATORS_API_KEY") ?? "";
const CONCURRENCY = 4;
const TIKTOK_HOST = /^(?:www\.|m\.|vm\.|vt\.)?tiktok\.com$/i;

type Item = { id: string; url: string };
type Job = { id: string; campaign_id: string; folder_id: string | null; submitted_by: string | null };

// TikTok lists several versions of each image; most are HEIC, which browsers can't show. Prefer JPEG.
const first = (o: any): string | null => {
  const list: string[] = o?.url_list ?? [];
  return list.find((u) => /\.jpe?g(\?|$)/i.test(u)) ?? list.at(-1) ?? null;
};
// Stellar's day is the Copenhagen calendar day (matches the daily refresh).
const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Copenhagen" }).format(new Date());

function checkUrl(raw: string): { ok: true; url: string; videoId: string | null } | { ok: false; error: string } {
  let u: URL;
  try { u = new URL(raw.trim()); } catch { return { ok: false, error: "Not a valid link" }; }
  if (!TIKTOK_HOST.test(u.hostname)) return { ok: false, error: "Not a TikTok link" };
  const m = u.pathname.match(/\/video\/(\d+)/);
  const short = /^(vm|vt)\./i.test(u.hostname) || u.pathname.startsWith("/t/");
  if (!m && !short) return { ok: false, error: "Not a TikTok video link" };
  return { ok: true, url: u.toString(), videoId: m?.[1] ?? null };
}

async function lookup(url: string): Promise<any> {
  if (!SC_KEY) throw new Error("ScrapeCreators key is missing in Supabase secrets");
  const r = await fetch(`https://api.scrapecreators.com/v2/tiktok/video?url=${encodeURIComponent(url)}`, {
    headers: { "x-api-key": SC_KEY },
  });
  const text = await r.text();
  let j: any = null;
  try { j = JSON.parse(text); } catch { /* not JSON */ }
  if (!r.ok || !j?.aweme_detail?.aweme_id) {
    if (r.status === 404) throw new Error("Video not found (deleted or private?)");
    throw new Error(`Lookup failed (HTTP ${r.status}): ${String(j?.message ?? text).slice(0, 120)}`);
  }
  return j.aweme_detail;
}

async function saveCover(videoId: string, coverUrl: string | null): Promise<string | null> {
  if (!coverUrl) return null;
  try {
    const r = await fetch(coverUrl);
    if (!r.ok) return null;
    const type = r.headers.get("content-type") ?? "image/jpeg";
    if (type.includes("heic")) return null; // browsers can't display HEIC; better no cover than a broken one
    const ext = type.includes("webp") ? "webp" : type.includes("png") ? "png" : "jpg";
    const path = `${videoId}.${ext}`;
    const { error } = await db.storage.from("covers").upload(path, await r.arrayBuffer(), { contentType: type, upsert: true });
    return error ? null : path;
  } catch {
    return null;
  }
}

async function alreadyInCampaign(campaignId: string, videoId: string): Promise<string | null> {
  const { data } = await db.from("posts").select("id").eq("campaign_id", campaignId).eq("tiktok_video_id", videoId).maybeSingle();
  return data?.id ?? null;
}

async function finishItem(id: string, status: string, error: string | null, postId: string | null) {
  await db.from("link_job_items").update({ status, error, post_id: postId, processed_at: new Date().toISOString() }).eq("id", id);
}

async function processItem(item: Item, job: Job) {
  const checked = checkUrl(item.url);
  if (!checked.ok) return finishItem(item.id, "failed", checked.error, null);

  if (checked.videoId) {
    const existing = await alreadyInCampaign(job.campaign_id, checked.videoId);
    if (existing) return finishItem(item.id, "duplicate", "Already in this campaign", existing);
  }

  let a: any;
  try { a = await lookup(checked.url); } catch (e) { return finishItem(item.id, "failed", String((e as Error).message), null); }

  const videoId = String(a.aweme_id);
  const existing = await alreadyInCampaign(job.campaign_id, videoId);
  if (existing) return finishItem(item.id, "duplicate", "Already in this campaign", existing);

  // Creator, created automatically from the video's author
  const au = a.author ?? {};
  let creatorId: string | null = null;
  if (au.uid) {
    const { data, error } = await db.from("creators").upsert({
      tiktok_user_id: String(au.uid),
      username: au.unique_id ?? String(au.uid),
      display_name: au.nickname ?? null,
      avatar_url: first(au.avatar_larger) ?? first(au.avatar_medium) ?? first(au.avatar_thumb),
      bio: au.signature ?? null,
      follower_count: au.follower_count ?? null,
      is_verified: (au.verification_type ?? 0) > 0 || !!au.custom_verify || !!au.enterprise_verify_reason,
      country_code: au.region ?? null,
    }, { onConflict: "tiktok_user_id" }).select("id").single();
    if (error) return finishItem(item.id, "failed", `Could not save creator: ${error.message}`, null);
    creatorId = data.id;
  }

  // Sound, linked to the campaign
  const m = a.music ?? {};
  const soundTikTokId = m.id_str ?? (m.id != null ? String(m.id) : null);
  let soundId: string | null = null;
  if (soundTikTokId) {
    const slug = String(m.title ?? "sound").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "sound";
    const { data, error } = await db.from("sounds").upsert({
      tiktok_sound_id: soundTikTokId,
      title: m.title ?? null,
      author: m.author ?? m.owner_nickname ?? null,
      matched_song_title: m.matched_song?.title ?? null,
      matched_song_author: m.matched_song?.author ?? null,
      cover_url: first(m.cover_large) ?? first(m.cover_medium) ?? first(m.cover_thumb),
      sound_url: `https://www.tiktok.com/music/${slug}-${soundTikTokId}`,
    }, { onConflict: "tiktok_sound_id" }).select("id").single();
    if (!error && data) {
      soundId = data.id;
      await db.from("campaign_sounds").upsert({ campaign_id: job.campaign_id, sound_id: soundId }, { onConflict: "campaign_id,sound_id", ignoreDuplicates: true });
    }
  }

  const coverPath = await saveCover(videoId, first(a.video?.cover) ?? first(a.video?.origin_cover));
  const username = au.unique_id ?? "user";
  const now = new Date().toISOString();

  const { data: post, error: postErr } = await db.from("posts").insert({
    campaign_id: job.campaign_id,
    folder_id: job.folder_id ?? null,
    creator_id: creatorId,
    sound_id: soundId,
    tiktok_video_id: videoId,
    url: `https://www.tiktok.com/@${username}/video/${videoId}`,
    caption: a.desc ?? null,
    published_at: a.create_time ? new Date(Number(a.create_time) * 1000).toISOString() : null,
    country_code: a.region ?? null,
    cover_path: coverPath,
    added_by: job.submitted_by,
    last_checked_at: now,
  }).select("id").single();
  if (postErr) {
    if ((postErr as any).code === "23505") {
      return finishItem(item.id, "duplicate", "Already in this campaign", await alreadyInCampaign(job.campaign_id, videoId));
    }
    return finishItem(item.id, "failed", `Could not save post: ${postErr.message}`, null);
  }

  const s = a.statistics ?? {};
  await db.from("post_daily_stats").upsert({
    tiktok_video_id: videoId,
    stat_date: today(),
    plays: s.play_count ?? null,
    likes: s.digg_count ?? null,
    comments: s.comment_count ?? null,
    shares: s.share_count ?? null,
    captured_at: now,
  }, { onConflict: "tiktok_video_id,stat_date" });

  return finishItem(item.id, "success", null, post.id);
}

async function runJob(job: Job) {
  const { data: items } = await db.from("link_job_items").select("id,url").eq("job_id", job.id).eq("status", "pending");
  const queue = [...(items ?? [])] as Item[];
  await db.from("link_jobs").update({ total: queue.length }).eq("id", job.id);

  const worker = async () => {
    for (let next = queue.shift(); next; next = queue.shift()) {
      try { await processItem(next, job); }
      catch (e) { await finishItem(next.id, "failed", `Unexpected error: ${String((e as Error).message).slice(0, 150)}`, null); }
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  const { data: done } = await db.from("link_job_items").select("status").eq("job_id", job.id);
  const count = (st: string) => (done ?? []).filter((d) => d.status === st).length;
  console.log("job done", job.id, "success", count("success"), "failed", count("failed"), "duplicate", count("duplicate"));
  await db.from("link_jobs").update({
    status: "done",
    succeeded: count("success"),
    failed: count("failed"),
    finished_at: new Date().toISOString(),
  }).eq("id", job.id);
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  let jobId: string | undefined;
  try { jobId = (await req.json())?.job_id; } catch { /* bad body */ }
  if (!jobId || !/^[0-9a-f-]{36}$/i.test(jobId)) return Response.json({ error: "job_id required" }, { status: 400 });

  // Claim the job atomically: only a pending job moves to running.
  const { data: job, error } = await db.from("link_jobs").update({ status: "running" })
    .eq("id", jobId).eq("status", "pending").select("id,campaign_id,folder_id,submitted_by").maybeSingle();
  if (error) {
    console.error("claim failed", error.message, "| keys present:", ["SUPABASE_SECRET_KEYS", "SUPABASE_SERVICE_ROLE_KEY"].filter((k) => !!Deno.env.get(k)).join(","));
    return Response.json({ error: "could not claim job" }, { status: 500 });
  }
  if (!job) {
    console.log("job skipped (not pending or not visible)", jobId, "| keys present:", ["SUPABASE_SECRET_KEYS", "SUPABASE_SERVICE_ROLE_KEY"].filter((k) => !!Deno.env.get(k)).join(","));
    return Response.json({ skipped: true }, { status: 200 });
  }

  EdgeRuntime.waitUntil(runJob(job as Job));
  return Response.json({ accepted: true, job_id: jobId }, { status: 202 });
});
