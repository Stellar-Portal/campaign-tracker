// YouTube Data API v3 (Google's official API): public numbers for any public video or channel.
// Free: 10,000 quota units a day; videos.list and channels.list cost 1 unit per call of up to 50 ids.
// Needs the Supabase secret YOUTUBE_API_KEY (Google Cloud → APIs & Services → Credentials → API key,
// with "YouTube Data API v3" enabled).
// The same file lives in process-links/ and refresh-stats/ (each Edge Function is deployed on its own).
const YT_KEY = Deno.env.get("YOUTUBE_API_KEY") ?? "";
const API = "https://www.googleapis.com/youtube/v3";

// The 11-character video id from any YouTube link: watch?v=, youtu.be/, /shorts/, /live/, /embed/.
export function youtubeId(raw: string): string | null {
  let u: URL;
  try { u = new URL(raw.trim()); } catch { return null; }
  const host = u.hostname.toLowerCase();
  const ok = (id: string | null | undefined) => (id && /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null);
  if (host === "youtu.be") return ok(u.pathname.split("/")[1]);
  if (!/(^|\.)youtube\.com$/.test(host)) return null;
  const v = u.searchParams.get("v");
  if (v) return ok(v);
  const m = u.pathname.match(/^\/(?:shorts|live|embed|v)\/([^/?#]+)/);
  return ok(m?.[1]);
}
export const isYouTubeLink = (raw: string) => { try { return /(^|\.)youtube\.com$|^youtu\.be$/i.test(new URL(raw.trim()).hostname); } catch { return false; } };

async function ytGet(path: string, params: Record<string, string>): Promise<any> {
  if (!YT_KEY) throw new Error("YouTube key is missing: add YOUTUBE_API_KEY in Supabase → Edge Functions → Secrets");
  const q = new URLSearchParams({ ...params, key: YT_KEY });
  const r = await fetch(`${API}/${path}?${q}`, { signal: AbortSignal.timeout(20_000) });
  const j = await r.json().catch(() => null);
  if (!r.ok) {
    const reason = j?.error?.errors?.[0]?.reason ?? "";
    if (reason === "quotaExceeded") throw new Error("YouTube's free daily allowance is used up; numbers resume tomorrow");
    throw new Error(`YouTube replied ${r.status}: ${String(j?.error?.message ?? "").slice(0, 120)}`);
  }
  return j;
}
async function byIds(path: string, part: string, ids: string[]): Promise<Map<string, any>> {
  const out = new Map<string, any>();
  const uniq = [...new Set(ids.filter(Boolean))];
  for (let i = 0; i < uniq.length; i += 50) {
    const j = await ytGet(path, { part, id: uniq.slice(i, i + 50).join(","), maxResults: "50" });
    for (const it of j?.items ?? []) out.set(it.id, it);
  }
  return out;
}
// Videos that come back missing are deleted or private.
export const ytVideos = (ids: string[]) => byIds("videos", "snippet,statistics", ids);
export const ytChannels = (ids: string[]) => byIds("channels", "snippet,statistics", ids);

const n = (v: unknown) => (v == null || v === "" ? null : Number(v));
export const videoStats = (v: any) => ({
  plays: n(v?.statistics?.viewCount), likes: n(v?.statistics?.likeCount),
  comments: n(v?.statistics?.commentCount), shares: null,   // YouTube doesn't publish share counts
});
export const channelFollowers = (c: any) => (c?.statistics?.hiddenSubscriberCount ? null : n(c?.statistics?.subscriberCount));
// Best thumbnail: maxres → standard → high → medium.
export const bestThumb = (t: any) => t?.maxres?.url ?? t?.standard?.url ?? t?.high?.url ?? t?.medium?.url ?? t?.default?.url ?? null;
