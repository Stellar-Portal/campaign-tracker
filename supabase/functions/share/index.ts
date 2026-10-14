// share: the data behind a client link (share.html#t=<token>).
// No login: the token is the key. It returns only what a client should see:
// campaigns, posts, creators, sounds and their numbers. Never budgets, costs, margins
// or creators' payment details.
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

async function inChunks<T>(items: T[], size: number, fn: (chunk: T[]) => Promise<any[]>) {
  const out: any[] = [];
  for (let i = 0; i < items.length; i += size) out.push(...(await fn(items.slice(i, i + size))));
  return out;
}

async function campaignsFor(token: string) {
  if (!/^[0-9a-f]{40,128}$/i.test(token)) return null;
  const { data: link } = await db.from("share_links").select("artist,campaign_id,expires_at,revoked").eq("token", token).maybeSingle();
  if (!link || link.revoked || (link.expires_at && new Date(link.expires_at) < new Date())) return null;
  let q = db.from("campaigns").select("id,artist,song,start_date,end_date,status,created_at").neq("status", "draft");
  q = link.artist ? q.ilike("artist", link.artist.trim().replace(/[%_\\]/g, (c: string) => "\\" + c)) : q.eq("id", link.campaign_id);
  const { data: campaigns } = await q.order("created_at");
  return { artist: link.artist ?? campaigns?.[0]?.artist ?? "", campaigns: campaigns ?? [] };
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

  const scope = await campaignsFor(String(body?.token ?? ""));
  if (!scope) return json({ error: "This link isn't active. Ask Stellar for a new one." }, 404);
  const ids = scope.campaigns.map((c) => c.id);

  // More covers for posts the page is about to show
  if (Array.isArray(body.covers)) {
    const wanted = body.covers.slice(0, 200).map(String);
    const { data } = await db.from("posts").select("tiktok_video_id,cover_path").in("campaign_id", ids).in("tiktok_video_id", wanted);
    const byPath = await signCovers((data ?? []).map((p) => p.cover_path).filter(Boolean));
    return json({ covers: Object.fromEntries((data ?? []).filter((p) => byPath[p.cover_path]).map((p) => [p.tiktok_video_id, byPath[p.cover_path]])) });
  }

  if (!ids.length) return json({ artist: scope.artist, campaigns: [], posts: [], series: [], sounds: [], covers: {} });

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
  })).map((s) => [s.tiktok_video_id, s]));

  const { data: series } = await db.rpc("share_series", { campaign_ids: ids });

  const { data: links } = await db.from("campaign_sounds").select("campaign_id,sound:sounds(id,title,author,matched_song_title,sound_url)").in("campaign_id", ids);
  const soundMap = new Map<string, any>();
  for (const l of links ?? []) if (l.sound) soundMap.set(l.sound.id, { ...l.sound, campaign_ids: [...(soundMap.get(l.sound.id)?.campaign_ids ?? []), l.campaign_id] });
  const soundIds = [...soundMap.keys()];
  const soundDaily = soundIds.length
    ? (await db.from("sound_daily_stats").select("sound_id,stat_date,video_count").in("sound_id", soundIds).order("stat_date")).data ?? []
    : [];
  const sounds = soundIds.map((id) => ({ ...soundMap.get(id), daily: soundDaily.filter((d) => d.sound_id === id).map((d) => ({ d: d.stat_date, n: d.video_count })) }));

  const outPosts = posts.map((p) => {
    const s = latest[p.tiktok_video_id] ?? {};
    return {
      campaign_id: p.campaign_id, video_id: p.tiktok_video_id, url: p.url, caption: p.caption, published_at: p.published_at,
      country: p.creator?.country_code ?? p.country_code ?? null, sound_id: p.sound_id,
      creator: p.creator ? { username: p.creator.username, name: p.creator.display_name, followers: p.creator.follower_count, verified: p.creator.is_verified } : null,
      plays: s.plays ?? null, likes: s.likes ?? null, comments: s.comments ?? null, shares: s.shares ?? null, stats_date: s.stat_date ?? null,
      has_cover: !!p.cover_path, _cover: p.cover_path,
    };
  });

  // Sign covers for the most-viewed posts now; the page asks for the rest as it scrolls.
  const top = [...outPosts].sort((a, b) => (b.plays ?? -1) - (a.plays ?? -1)).slice(0, FIRST_COVERS);
  const signed = await signCovers(top.map((p) => p._cover).filter(Boolean));
  const covers = Object.fromEntries(top.filter((p) => signed[p._cover]).map((p) => [p.video_id, signed[p._cover]]));
  for (const p of outPosts) delete (p as any)._cover;

  return json({
    artist: scope.artist,
    campaigns: scope.campaigns.map((c) => ({ id: c.id, song: c.song, start_date: c.start_date, end_date: c.end_date, status: c.status })),
    posts: outPosts,
    series: series ?? [],
    sounds,
    covers,
    generated_at: new Date().toISOString(),
  });
});
