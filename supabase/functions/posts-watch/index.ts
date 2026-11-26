// posts-watch: spots new posts cheaply (pending item 1).
// Once a day (cron, nightly window) it reads the newest videos of every creator on the payout sheet of each active
// campaign that has a sound, and adds the videos that use the campaign's sound to the creator's folder, the same way
// a pasted link is added (link_jobs + link_job_items, then process-links does the rest).
// Cost: ScrapeCreators GET /v3/tiktok/profile/videos?handle=..&sort_by=latest = 1 credit per creator per day (one page, ~10 videos).
// A creator on several campaigns is fetched once. Capped at MAX_CREATORS per run so a 10-minute cron spreads the day's work.
// Auth: cron = header x-deck-secret (same as paypal-payouts / deck-notify); a signed-in team member may run {campaign_id}
// for one campaign ("check now"; {dry_run:true} reads but adds nothing). Master switch: private.settings.posts_watch
// (off | on) through posts_watch_mode(); when off, nothing is fetched.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import { GAP_MS, MANUAL_GAP_MS, failedCheckedAt, isDue, normHandle, pickFolder, pickMatches, startMs, validHandle, videoIdOf, videoList } from "./match.ts";

function serviceKey(): string {
  const raw = Deno.env.get("SUPABASE_SECRET_KEYS");
  if (raw) {
    try { const k = JSON.parse(raw); const v = k.default ?? Object.values(k)[0]; if (v) return String(v); } catch { /* ignore */ }
  }
  return Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
}
const db = createClient(Deno.env.get("SUPABASE_URL")!, serviceKey(), { auth: { persistSession: false } });
const SC_KEY = Deno.env.get("SCRAPECREATORS_API_KEY") ?? "";
const MAX_CREATORS = 40;
const CONCURRENCY = 4;
const TIME_BUDGET_MS = 100_000;
const AUTO = "Stellar OS (auto)";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" } });

async function teamMember(req: Request): Promise<string | null> {
  const jwt = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!jwt.startsWith("ey")) return null;
  const { data } = await db.auth.getUser(jwt);
  const email = data.user?.email?.toLowerCase();
  if (!email) return null;
  const { data: tm } = await db.from("team_members").select("email").ilike("email", email).maybeSingle();
  return tm ? email : null;
}

class NotFound extends Error {}
async function newestVideos(handle: string): Promise<any[]> {
  const r = await fetch(`https://api.scrapecreators.com/v3/tiktok/profile/videos?${new URLSearchParams({ handle, sort_by: "latest" })}`, {
    headers: { "x-api-key": SC_KEY }, signal: AbortSignal.timeout(40_000),
  });
  const text = await r.text();
  let j: any = null;
  try { j = JSON.parse(text); } catch { /* not JSON */ }
  if (r.status === 404) throw new NotFound("Creator not found (wrong handle, or the account is private or deleted)");
  if (!r.ok || j?.success === false) throw new Error(`ScrapeCreators ${r.status}: ${String(j?.message ?? j?.error ?? text).slice(0, 160)}`);
  return videoList(j);
}

const copenhagenDay = (offsetDays = 0) => {
  const d = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Copenhagen" }).format(new Date());
  return new Date(Date.parse(`${d}T00:00:00Z`) + offsetDays * 86400_000).toISOString().slice(0, 10);
};

type Camp = { id: string; start_date: string | null; end_date: string | null; sounds: Set<string> };
type Watch = { id: string; handle: string; camps: Set<string> };

async function run(body: any, manual: boolean) {
  if (!SC_KEY) return { error: "ScrapeCreators key is missing in Supabase secrets" };
  const dry = !!body.dry_run;
  const t0 = Date.now();

  // 1. Campaigns to watch: active (not ended more than 2 days ago) with a sound. A manual check takes the one asked for.
  let q = db.from("campaigns").select("id,status,start_date,end_date");
  q = manual ? q.eq("id", String(body.campaign_id)) : q.eq("status", "active");
  const { data: rawCamps, error: ce } = await q;
  if (ce) return { error: ce.message };
  const cutoff = copenhagenDay(-2);
  const open = (rawCamps ?? []).filter((c) => manual || !c.end_date || c.end_date >= cutoff);
  if (!open.length) return { campaigns: 0, creators_due: 0, checked: 0, added: 0 };
  const ids = open.map((c) => c.id as string);

  const { data: cs } = await db.from("campaign_sounds").select("campaign_id,sound_id").in("campaign_id", ids);
  const { data: snd } = (cs ?? []).length
    ? await db.from("sounds").select("id,tiktok_sound_id").in("id", [...new Set((cs ?? []).map((x) => x.sound_id as string))])
    : { data: [] as any[] };
  const tt = new Map((snd ?? []).map((s) => [s.id as string, String(s.tiktok_sound_id ?? "")]));
  const camps = new Map<string, Camp>();
  for (const c of open) camps.set(c.id as string, { id: c.id as string, start_date: c.start_date as string | null, end_date: c.end_date as string | null, sounds: new Set() });
  for (const x of cs ?? []) { const t = tt.get(x.sound_id as string); if (t) camps.get(x.campaign_id as string)?.sounds.add(t); }
  for (const [id, c] of camps) if (!c.sounds.size) camps.delete(id);   // no sound, nothing to match
  if (!camps.size) return { campaigns: 0, creators_due: 0, checked: 0, added: 0 };

  // 2. Creators on those payout sheets (TikTok, with a handle), each once.
  const { data: rows } = await db.from("payout_rows").select("campaign_id,creator_id,handle,platform").in("campaign_id", [...camps.keys()]);
  const wanted = (rows ?? []).filter((r) => normHandle(r.handle) && (!r.platform || r.platform === "tiktok"));
  const byId = new Map<string, any>();
  const cIds = [...new Set(wanted.map((r) => r.creator_id as string).filter(Boolean))];
  if (cIds.length) for (const c of (await db.from("creators").select("id,username,platform").in("id", cIds)).data ?? []) byId.set(c.id as string, c);
  const loose = [...new Set(wanted.filter((r) => !r.creator_id).map((r) => normHandle(r.handle)))].filter(validHandle);
  const byName = new Map<string, any>();
  if (loose.length) for (const c of (await db.from("creators").select("id,username,platform").eq("platform", "tiktok").in("username", loose)).data ?? []) byName.set(String(c.username).toLowerCase(), c);
  const watch = new Map<string, Watch>();
  for (const r of wanted) {
    const c = r.creator_id ? byId.get(r.creator_id as string) : byName.get(normHandle(r.handle));
    if (!c || (c.platform && c.platform !== "tiktok")) continue;
    const handle = normHandle(c.username);
    if (!validHandle(handle)) continue;
    const w = watch.get(c.id as string) ?? { id: c.id as string, handle, camps: new Set<string>() };
    w.camps.add(r.campaign_id as string);
    watch.set(c.id as string, w);
  }

  // 3. Who is due (once a day; a manual check may repeat after an hour), oldest check first, capped.
  const { data: checks } = watch.size ? await db.from("posts_watch_checks").select("creator_id,checked_at,fails").in("creator_id", [...watch.keys()]) : { data: [] as any[] };
  const last = new Map((checks ?? []).map((c) => [c.creator_id as string, c]));
  const gap = manual ? MANUAL_GAP_MS : GAP_MS;
  const due = [...watch.values()].filter((w) => isDue(last.get(w.id)?.checked_at, gap))
    .sort((a, b) => String(last.get(a.id)?.checked_at ?? "").localeCompare(String(last.get(b.id)?.checked_at ?? "")))
    .slice(0, MAX_CREATORS);

  const summary = { campaigns: camps.size, creators: watch.size, creators_due: due.length, checked: 0, added: 0, errors: [] as string[], found: [] as { handle: string; campaign_id: string; urls: string[] }[], dry_run: dry };
  const queue = [...due];
  const worker = async () => {
    for (let w = queue.shift(); w; w = queue.shift()) {
      if (Date.now() - t0 > TIME_BUDGET_MS) return;    // the rest stay due for the next run
      const prev = last.get(w.id);
      const now = new Date();
      // Claim first (so a second run doesn't fetch the same creator), then fix up with the result.
      await db.from("posts_watch_checks").upsert({ creator_id: w.id, checked_at: now.toISOString(), fails: prev?.fails ?? 0 }, { onConflict: "creator_id" });
      try {
        const videos = await newestVideos(w.handle);
        summary.checked++;
        let added = 0, soundInfo = 0;
        const vids = videos.map(videoIdOf).filter(Boolean) as string[];
        for (const campId of w.camps) {
          const camp = camps.get(campId)!;
          const { data: have } = vids.length ? await db.from("posts").select("tiktok_video_id").eq("campaign_id", campId).in("tiktok_video_id", vids) : { data: [] as any[] };
          const known = new Set((have ?? []).map((p) => String(p.tiktok_video_id)));
          const { matches, withSound } = pickMatches(videos, { sounds: camp.sounds, since: startMs(camp.start_date), known, handle: w.handle });
          soundInfo = Math.max(soundInfo, withSound);
          if (!matches.length) continue;
          summary.found.push({ handle: w.handle, campaign_id: campId, urls: matches.map((m) => m.url) });
          if (dry) continue;
          const [{ data: fc }, { data: pf }] = await Promise.all([
            db.from("campaign_folder_creators").select("folder_id").eq("campaign_id", campId).eq("creator_id", w.id),
            db.from("posts").select("folder_id").eq("campaign_id", campId).eq("creator_id", w.id),
          ]);
          const folder = pickFolder((fc ?? []).map((x) => x.folder_id as string | null), (pf ?? []).map((x) => x.folder_id as string | null));
          const { data: job, error: je } = await db.from("link_jobs").insert({ campaign_id: campId, folder_id: folder, submitted_by: AUTO }).select("id").single();
          if (je || !job) { summary.errors.push(`${w.handle}: couldn't make the job (${je?.message ?? "no row"})`); continue; }
          // One insert for all of this creator's links: the database trigger starts process-links once per job.
          const { error: ie } = await db.from("link_job_items").insert(matches.map((m) => ({ job_id: job.id, url: m.url })));
          if (ie) summary.errors.push(`${w.handle}: couldn't add links (${ie.message})`); else added += matches.length;
        }
        summary.added += added;
        await db.from("posts_watch_checks").upsert({
          creator_id: w.id, checked_at: now.toISOString(), videos_seen: videos.length, added, fails: 0,
          error: videos.length && !soundInfo ? "The video list had no sound info" : null,
        }, { onConflict: "creator_id" });
        if (videos.length && !soundInfo) summary.errors.push(`${w.handle}: the video list had no sound info`);
      } catch (e) {
        const fails = (prev?.fails ?? 0) + 1;
        const msg = String((e as Error).message).slice(0, 200);
        summary.errors.push(`${w.handle}: ${msg}`);
        await db.from("posts_watch_checks").upsert({ creator_id: w.id, checked_at: failedCheckedAt(fails - 1), fails, error: msg }, { onConflict: "creator_id" });
      }
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return summary;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Not found" }, 404);
  const body = await req.json().catch(() => ({}));
  let manual = false;
  const cronSecret = req.headers.get("x-deck-secret");
  if (cronSecret) {
    const { data: secret } = await db.rpc("deck_secret");
    if (!secret || cronSecret !== secret) return json({ error: "Not allowed" }, 403);
  } else {
    if (!(await teamMember(req))) return json({ error: "Sign in to Stellar OS first." }, 401);
    if (!UUID.test(String(body.campaign_id ?? ""))) return json({ error: "campaign_id is needed" }, 400);
    manual = true;
  }
  const { data: mode } = await db.rpc("posts_watch_mode");
  if (mode !== "on") return json({ off: true });
  try {
    return json(await run(body, manual));
  } catch (e) {
    return json({ error: String((e as Error).message).slice(0, 200) }, 500);
  }
});
