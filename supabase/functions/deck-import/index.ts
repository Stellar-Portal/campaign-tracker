// deck-import (team only): reads a Figma Slides file and builds a deck version.
//   { action: "build", url | file_key, deck_id?, new_deck?, title?, width, height, slides: [{ node, links: [{url,label,x,y,w,h}], videos: [{name,x,y,w,h,clip?:{x,y,w,h,r},overlays?:[{node,x,y,w,h}]}] }] }
//       Boxes are in slide pixels. A video's clip is the part a parent frame (e.g. a phone mockup) leaves visible.
//       creates a new deck version: Figma renders each slide as an image (REST /images), links and video
//       boxes become %-positioned spots, and TikTok videos (ID read from the Snaptik layer name) are
//       downloaded once through ScrapeCreators (about 1 credit each) into the private deck-media bucket.
//       Figma's REST API can't list what's inside a Slides file, so the slide list comes from the caller.
//   { action: "meta", url }     file name and version (to spot changes since the last import)
//   { action: "probe", path }   read-only Figma GET, for setup checks
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

function serviceKey(): string {
  const raw = Deno.env.get("SUPABASE_SECRET_KEYS");
  if (raw) { try { const k = JSON.parse(raw); const v = k.default ?? Object.values(k)[0]; if (v) return String(v); } catch { /* ignore */ } }
  return Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
}
const db = createClient(Deno.env.get("SUPABASE_URL")!, serviceKey(), { auth: { persistSession: false } });
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-deck-secret, x-plugin-key", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...cors, "Content-Type": "application/json" } });
const FIGMA = "https://api.figma.com/v1";
const figmaToken = () => Deno.env.get("FIGMA_TOKEN") ?? "";

async function who(req: Request): Promise<string | null> {
  // The "Send to Stellar OS" Figma button sends the team member's personal key.
  const pk = req.headers.get("x-plugin-key");
  if (pk) { if (!/^sos_[0-9a-f]{48}$/.test(pk)) return null; const { data } = await db.rpc("deck_plugin_user", { p_key: pk }); return data ?? null; }
  const sec = req.headers.get("x-deck-secret");
  if (sec) { const { data } = await db.rpc("deck_secret"); return sec === data ? "system" : null; }
  const jwt = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!jwt.startsWith("ey")) return null;
  const { data } = await db.auth.getUser(jwt);
  const email = data.user?.email?.toLowerCase();
  if (!email) return null;
  const { data: m } = await db.from("team_members").select("email").eq("email", email).maybeSingle();
  return m ? email : null;
}
const fileKey = (url: string) => url.match(/figma\.com\/(?:deck|slides|design|file|proto)\/([0-9a-zA-Z]{10,})/)?.[1] ?? null;

async function figma(path: string) {
  const r = await fetch(FIGMA + path, { headers: { "X-Figma-Token": figmaToken() } });
  const text = await r.text();
  if (!r.ok) { const e = new Error(`Figma ${r.status}: ${text.slice(0, 200)}`); (e as any).status = r.status; throw e; }
  return JSON.parse(text);
}

const SC_KEY = Deno.env.get("SCRAPECREATORS_API_KEY") ?? "";
const num = (v: unknown, lo = 0, hi = 100000) => Math.min(hi, Math.max(lo, Number(v) || 0));
const pct = (v: number, of: number) => Math.round((v / of) * 100000) / 1000;

async function tiktokMp4(id: string): Promise<ArrayBuffer> {
  if (!SC_KEY) throw new Error("ScrapeCreators key is missing");
  const r = await fetch(`https://api.scrapecreators.com/v2/tiktok/video?url=${encodeURIComponent(`https://www.tiktok.com/@i/video/${id}`)}`, { headers: { "x-api-key": SC_KEY } });
  const j = await r.json().catch(() => null);
  const v = j?.aweme_detail?.video;
  if (!r.ok || !v) throw new Error(r.status === 404 ? "TikTok video not found (deleted or private?)" : `TikTok lookup failed (${r.status})`);
  const urls: string[] = [...(v.play_addr?.url_list ?? []), ...(v.download_addr?.url_list ?? [])];
  for (const u of urls) {
    try {
      const f = await fetch(u, { headers: { "User-Agent": "Mozilla/5.0", Referer: "https://www.tiktok.com/" }, signal: AbortSignal.timeout(40_000) });
      if (f.ok && /video|octet/.test(f.headers.get("content-type") ?? "")) { const b = await f.arrayBuffer(); if (b.byteLength > 10_000) return b; }
    } catch { /* try the next copy */ }
  }
  throw new Error("Couldn't download the TikTok video");
}

async function build(body: any, user: string) {
  const key = /^[0-9a-zA-Z]{10,128}$/.test(String(body.file_key ?? "")) ? String(body.file_key) : fileKey(String(body.url ?? ""));
  if (!key) throw Object.assign(new Error("That doesn't look like a Figma link."), { status: 422 });
  const url = fileKey(String(body.url ?? "")) === key ? String(body.url) : `https://www.figma.com/deck/${key}`;
  const W = num(body.width, 1, 20000) || 1920, H = num(body.height, 1, 20000) || 1080;
  const input = (Array.isArray(body.slides) ? body.slides : []).filter((s: any) => /^[\d:;I-]+$/.test(String(s?.node ?? ""))).slice(0, 200);
  if (!input.length) throw Object.assign(new Error("No slides to import."), { status: 422 });
  const meta = (await figma(`/files/${key}/meta`)).file;

  let deckId = body.deck_id as string | undefined;
  if (!deckId && !body.new_deck) {
    // Sending the same Figma file again updates its deck (a new version) instead of making a second deck.
    const { data } = await db.from("deck_versions").select("deck_id").eq("figma_file_key", key).order("created_at", { ascending: false }).limit(1).maybeSingle();
    deckId = data?.deck_id;
  }
  let deckTitle = "";
  if (deckId) {
    const { data } = await db.from("decks").select("id,title").eq("id", deckId).maybeSingle();
    if (!data) throw Object.assign(new Error("Deck not found."), { status: 422 });
    deckTitle = data.title;
  } else {
    deckTitle = String(body.title || meta.name).slice(0, 200);
    const { data, error } = await db.from("decks").insert({ title: deckTitle, figma_url: url.slice(0, 500), created_by: user }).select("id").single();
    if (error) throw error;
    deckId = data.id;
  }
  const { data: last } = await db.from("deck_versions").select("version").eq("deck_id", deckId).order("version", { ascending: false }).limit(1).maybeSingle();
  const { data: ver, error: verr } = await db.from("deck_versions").insert({
    deck_id: deckId, version: (last?.version ?? 0) + 1, source: "figma", figma_file_key: key, figma_version: meta.version,
    status: "importing", slide_count: input.length, created_by: user,
  }).select("id,version").single();
  if (verr) throw verr;
  const base = `${deckId}/${ver.id}`;
  const problems: string[] = [];
  // Videos already saved for this deck (downloaded before, or uploaded by hand) are reused, not fetched again.
  const { data: olderVersions } = await db.from("deck_versions").select("id").eq("deck_id", deckId).neq("id", ver.id);
  const { data: saved } = olderVersions?.length
    ? await db.from("deck_spots").select("tiktok_id,layer_name,video_path").in("version_id", olderVersions.map((v) => v.id)).eq("kind", "video").eq("status", "ready").not("video_path", "is", null)
    : { data: [] as any[] };
  const reuse = (tiktok: string | null, name: string) => (saved ?? []).find((v) => (tiktok && v.tiktok_id === tiktok) || (!tiktok && v.layer_name === name))?.video_path ?? null;
  try {
    // 1. Slide images, rendered by Figma, 10 per request.
    const urls: Record<string, string> = {};
    for (let i = 0; i < input.length; i += 10) {
      const ids = input.slice(i, i + 10).map((s: any) => s.node).join(",");
      const r = await figma(`/images/${key}?ids=${encodeURIComponent(ids)}&format=jpg&scale=1.5&use_absolute_bounds=true`);
      Object.assign(urls, r.images ?? {});
    }
    // 2. Layers above a video (phone bezels, captions) as transparent PNGs, drawn back on top of the playing video.
    const overIds = [...new Set(input.flatMap((s: any) => (Array.isArray(s.videos) ? s.videos : []).flatMap((v: any) => (Array.isArray(v.overlays) ? v.overlays : []).map((o: any) => String(o.node ?? "")))))]
      .filter((id) => /^[\d:;I-]+$/.test(id)).slice(0, 100);
    const overUrls: Record<string, string> = {};
    for (let i = 0; i < overIds.length; i += 10) {
      const r = await figma(`/images/${key}?ids=${encodeURIComponent(overIds.slice(i, i + 10).join(","))}&format=png&scale=1.5&use_absolute_bounds=true`);
      Object.assign(overUrls, r.images ?? {});
    }
    const overPaths: Record<string, string> = {};
    for (const id of overIds) {
      if (!overUrls[id]) continue;
      const img = await fetch(overUrls[id]);
      if (!img.ok) continue;
      const path = `${base}/over-${id.replace(/[^\w-]/g, "_")}.png`;
      const { error } = await db.storage.from("deck-media").upload(path, await img.arrayBuffer(), { contentType: "image/png", upsert: true });
      if (!error) overPaths[id] = path;
    }
    const slideRows: any[] = [], spotRows: any[] = [];
    for (let i = 0; i < input.length; i++) {
      const s = input[i], n = i + 1, src = urls[s.node];
      let path: string | null = null;
      if (src) {
        const img = await fetch(src);
        if (img.ok) {
          path = `${base}/slide-${n}.jpg`;
          const { error } = await db.storage.from("deck-media").upload(path, await img.arrayBuffer(), { contentType: "image/jpeg", upsert: true });
          if (error) { path = null; problems.push(`Slide ${n}: image couldn't be saved`); }
        }
      }
      if (!path) problems.push(`Slide ${n}: Figma didn't render an image`);
      slideRows.push({ version_id: ver.id, n, title: String(s.title ?? "").slice(0, 200) || null, image_path: path, width: W, height: H });
      for (const l of (Array.isArray(s.links) ? s.links : []).slice(0, 50)) {
        if (!/^https?:\/\//i.test(String(l.url ?? ""))) continue;
        spotRows.push({ version_id: ver.id, n, kind: "link", url: String(l.url).slice(0, 2000), label: String(l.label ?? "").slice(0, 120) || null,
          x: pct(num(l.x, -W, W), W), y: pct(num(l.y, -H, H), H), w: pct(num(l.w, 0, W), W), h: pct(num(l.h, 0, H), H), status: "ready" });
      }
      for (const [j, v] of (Array.isArray(s.videos) ? s.videos : []).slice(0, 20).entries()) {
        const name = String(v.name ?? "").slice(0, 300);
        const tiktok = name.match(/(\d{15,20})/)?.[1] ?? null;
        const row: any = { version_id: ver.id, n, kind: "video", layer_name: name, tiktok_id: tiktok,
          x: pct(num(v.x, -W, W), W), y: pct(num(v.y, -H, H), H), w: pct(num(v.w, 0, W), W), h: pct(num(v.h, 0, H), H), status: "missing" };
        const c = v.clip;
        if (c && typeof c === "object") row.clip = { x: pct(num(c.x, -W, W), W), y: pct(num(c.y, -H, H), H), w: pct(num(c.w, 0, W), W), h: pct(num(c.h, 0, H), H), r: pct(num(c.r, 0, W), W) };
        const over = (Array.isArray(v.overlays) ? v.overlays : []).filter((o: any) => overPaths[String(o.node)])
          .map((o: any) => ({ path: overPaths[String(o.node)], x: pct(num(o.x, -W, W), W), y: pct(num(o.y, -H, H), H), w: pct(num(o.w, 0, W), W), h: pct(num(o.h, 0, H), H) }));
        if (over.length) row.overlays = over;
        const again = reuse(tiktok, name);
        if (again) { row.video_path = again; row.status = "ready"; }
        else if (!tiktok) row.note = "No TikTok ID in the video's layer name. Add the video file or its TikTok link.";
        else {
          try {
            const mp4 = await tiktokMp4(tiktok);
            row.video_path = `${base}/video-${n}-${j + 1}.mp4`;
            const { error } = await db.storage.from("deck-media").upload(row.video_path, mp4, { contentType: "video/mp4", upsert: true });
            if (error) throw new Error("Couldn't save the video file");
            row.status = "ready";
          } catch (e) { row.video_path = null; row.note = String((e as Error).message); }
        }
        if (row.status !== "ready") problems.push(`Slide ${n}: video "${name.slice(0, 40)}" needs attention`);
        spotRows.push(row);
      }
    }
    const { error: e1 } = await db.from("deck_slides").insert(slideRows);
    if (e1) throw e1;
    if (spotRows.length) { const { error: e2 } = await db.from("deck_spots").insert(spotRows); if (e2) throw e2; }
    await db.from("deck_versions").update({ status: "ready", note: problems.join("\n") || null }).eq("id", ver.id);
    await db.from("decks").update({ current_version_id: ver.id, figma_url: url.slice(0, 500), updated_at: new Date().toISOString() }).eq("id", deckId);
    return { deck_id: deckId, title: deckTitle, version_id: ver.id, version: ver.version, slides: slideRows.length, links: spotRows.filter((r) => r.kind === "link").length, videos: spotRows.filter((r) => r.kind === "video").length, problems };
  } catch (e) {
    await db.from("deck_versions").update({ status: "failed", note: String((e as Error).message).slice(0, 500) }).eq("id", ver.id);
    throw e;
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const user = await who(req);
    if (!user) return json({ error: "Sign in as a Stellar team member." }, 401);
    if (!figmaToken()) return json({ error: "The Figma token isn't set up yet (FIGMA_TOKEN)." }, 400);
    const body = await req.json().catch(() => ({}));
    if (body.action === "meta") {
      const key = fileKey(String(body.url ?? ""));
      if (!key) return json({ error: "That doesn't look like a Figma link." }, 400);
      const m = (await figma(`/files/${key}/meta`)).file;
      return json({ name: m.name, version: m.version, editorType: m.editorType, last_touched_at: m.last_touched_at });
    }
    if (body.action === "build") return json(await build(body, user));
    if (body.action === "probe") {
      // Read-only GET against Figma for setup checks; only file and image reads are allowed.
      const path = String(body.path ?? "");
      if (!/^\/(files|images)\/[0-9a-zA-Z]{10,}[^\s]*$/.test(path)) return json({ error: "Bad path" }, 400);
      try { const r = await figma(path); return json({ ok: true, body: JSON.stringify(r).slice(0, 20000) }); }
      catch (e) { return json({ ok: false, status: (e as any).status, error: String((e as Error).message).slice(0, 300) }); }
    }
    return json({ error: "Unknown action" }, 400);
  } catch (e) {
    const status = (e as any).status;
    if (status === 403) return json({ error: "Figma refused the token. It may have expired or lack file access." }, 400);
    if (status === 404) return json({ error: "Figma couldn't find that file. Check the link and that the token's account can open it." }, 400);
    if (status === 422) return json({ error: (e as Error).message }, 400);
    return json({ error: String((e as Error).message ?? e).slice(0, 300) }, 500);
  }
});
