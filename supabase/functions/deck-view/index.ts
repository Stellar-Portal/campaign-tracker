// deck-view: the public side of tracked deck links. No login; everything is checked here.
//   { action: "status", token }                      is this link live? (gate shows or "not active")
//   { action: "open", token, email?, pass?, tz? }   start a viewing session → slides, links, videos
//   { action: "track", session, sig, slides, clicks } merge time per slide (running totals) and link clicks
// Slides and videos live in the private deck-media bucket and are handed out as links that expire in
// 2 hours. Viewer passes (so returning viewers skip the gate) and session ids are signed with a secret
// only this function can read. Signed-in Stellar team members can view without being tracked.
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
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store", "X-Robots-Tag": "noindex" } });
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,24}$/;
const PASS_DAYS = 180;

let secretCache: CryptoKey | null = null;
async function key(): Promise<CryptoKey> {
  if (secretCache) return secretCache;
  const { data } = await db.rpc("deck_secret");
  secretCache = await crypto.subtle.importKey("raw", new TextEncoder().encode(String(data)), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
  return secretCache;
}
const b64u = (buf: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64u = (s: string) => new TextDecoder().decode(Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0)));
async function sign(text: string) { return b64u(await crypto.subtle.sign("HMAC", await key(), new TextEncoder().encode(text))); }
async function checkSig(text: string, sig: string) { return typeof sig === "string" && sig.length > 20 && (await sign(text)) === sig; }
async function sha(text: string) { return b64u(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))).slice(0, 22); }

// A pass remembers the email for this deck so a returning viewer skips the gate.
async function makePass(deckId: string, email: string) {
  const body = b64u(new TextEncoder().encode(JSON.stringify({ d: deckId, e: email, x: Date.now() + PASS_DAYS * 86400_000 })));
  return `${body}.${await sign("pass:" + body)}`;
}
async function readPass(pass: unknown, deckId: string): Promise<string | null> {
  if (typeof pass !== "string" || !pass.includes(".")) return null;
  const [body, sig] = pass.split(".");
  if (!(await checkSig("pass:" + body, sig))) return null;
  try { const p = JSON.parse(fromB64u(body)); return p.d === deckId && p.x > Date.now() && EMAIL.test(p.e) ? p.e : null; } catch { return null; }
}

async function isTeam(req: Request): Promise<boolean> {
  const jwt = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!jwt.startsWith("ey") || jwt.split(".").length !== 3) return false;
  try {
    const { data } = await db.auth.getUser(jwt);
    const email = data.user?.email?.toLowerCase();
    if (!email) return false;
    const { data: m } = await db.from("team_members").select("email").eq("email", email).maybeSingle();
    return !!m;
  } catch { return false; }
}

function device(ua: string) {
  const mobile = /Mobi|iPhone|Android.+Mobile/i.test(ua), tablet = /iPad|Tablet|Android(?!.*Mobile)/i.test(ua);
  const browser = /Edg\//.test(ua) ? "Edge" : /OPR\//.test(ua) ? "Opera" : /Chrome\//.test(ua) ? "Chrome" : /Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : "Other";
  const os = /iPhone|iPad|iOS/.test(ua) ? "iOS" : /Android/.test(ua) ? "Android" : /Mac OS X/.test(ua) ? "macOS" : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : "Other";
  return { device: tablet ? "Tablet" : mobile ? "Mobile" : "Desktop", browser, os };
}
// Approximate country from the edge network's headers; the IP itself is never stored.
const countryOf = (req: Request) => (req.headers.get("cf-ipcountry") ?? req.headers.get("x-country-code") ?? req.headers.get("x-vercel-ip-country") ?? "").toUpperCase().slice(0, 2) || null;
const ipKey = async (req: Request) => sha("ip:" + ((req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || "unknown"));

async function liveLink(token: unknown) {
  if (typeof token !== "string" || !/^[a-f0-9]{24,64}$/.test(token)) return { error: "This link isn't valid." };
  const { data: link } = await db.from("deck_links").select("id,deck_id,enabled,expires_at,require_email,allow_download,recipient_email").eq("token", token).maybeSingle();
  if (!link || !link.enabled) return { error: "This link isn't active." };
  if (link.expires_at && new Date(link.expires_at) < new Date()) return { error: "This link has expired." };
  const { data: deck } = await db.from("decks").select("id,title,current_version_id").eq("id", link.deck_id).maybeSingle();
  if (!deck?.current_version_id) return { error: "This deck isn't ready yet." };
  return { link, deck };
}

async function content(versionId: string) {
  const [{ data: slides }, { data: spots }] = await Promise.all([
    db.from("deck_slides").select("n,image_path,width,height,title").eq("version_id", versionId).order("n"),
    db.from("deck_spots").select("id,n,kind,url,label,x,y,w,h,video_path,status").eq("version_id", versionId).order("n"),
  ]);
  const paths = [...(slides ?? []).map((s) => s.image_path), ...(spots ?? []).map((s) => s.video_path)].filter(Boolean) as string[];
  const signed: Record<string, string> = {};
  for (let i = 0; i < paths.length; i += 100) {
    const { data } = await db.storage.from("deck-media").createSignedUrls(paths.slice(i, i + 100), 7200);
    for (const s of data ?? []) if (s.signedUrl && s.path) signed[s.path] = s.signedUrl;
  }
  return {
    slides: (slides ?? []).map((s) => ({ n: s.n, url: signed[s.image_path ?? ""] ?? null, w: s.width, h: s.height })),
    spots: (spots ?? []).filter((s) => s.kind === "link" ? !!s.url : s.status === "ready" && s.video_path)
      .map((s) => ({ n: s.n, kind: s.kind, url: s.kind === "video" ? signed[s.video_path!] ?? null : s.url, label: s.label, x: +s.x, y: +s.y, w: +s.w, h: +s.h })),
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Not allowed" }, 405);
  let body: any = {};
  try { body = JSON.parse(await req.text()); } catch { return json({ error: "Bad request" }, 400); }
  try {
    if (body.action === "track") {
      const sid = String(body.session ?? "");
      if (!/^[0-9a-f-]{36}$/.test(sid) || !(await checkSig("session:" + sid, body.sig))) return json({ error: "Not allowed" }, 403);
      if (!(await db.rpc("deck_rate_ok", { p_key: "t:" + sid, p_limit: 60, p_seconds: 60 })).data) return json({ error: "Too many updates" }, 429);
      const slides = body.slides && typeof body.slides === "object" && !Array.isArray(body.slides) ? body.slides : {};
      if (Object.keys(slides).length > 400) return json({ error: "Bad request" }, 400);
      const clicks = Array.isArray(body.clicks) ? body.clicks.slice(0, 50) : [];
      const { error } = await db.rpc("deck_merge", { p_session: sid, p_slides: slides, p_clicks: clicks });
      if (error) return json({ error: "Couldn't save" }, 500);
      return json({ ok: true });
    }

    if (body.action === "status") {
      const r = await liveLink(body.token);
      if ("error" in r) return json({ live: false, message: r.error });
      return json({ live: true, require_email: r.link.require_email && !r.link.recipient_email });
    }

    if (body.action === "open") {
      if (!(await db.rpc("deck_rate_ok", { p_key: "o:" + (await ipKey(req)), p_limit: 30, p_seconds: 600 })).data) return json({ error: "Too many tries. Please wait a few minutes." }, 429);
      const r = await liveLink(body.token);
      if ("error" in r) return json({ error: r.error }, 404);
      const { link, deck } = r;
      const team = await isTeam(req);
      let email: string | null = link.recipient_email ?? (await readPass(body.pass, deck.id));
      if (!email && typeof body.email === "string" && EMAIL.test(body.email.trim())) email = body.email.trim().toLowerCase();
      if (!email && link.require_email && !team) return json({ error: "Enter a valid email address to view the deck.", gate: true }, 400);
      const c = await content(deck.current_version_id);
      const base = { title: deck.title, ...c, pass: email && !link.recipient_email ? await makePass(deck.id, email) : null };
      if (team) return json({ ...base, session: null, team: true });
      const ua = req.headers.get("user-agent") ?? "";
      const { data: s, error } = await db.from("deck_sessions").insert({
        deck_id: deck.id, link_id: link.id, version_id: deck.current_version_id, email,
        slide_count: c.slides.length, ...device(ua), country: countryOf(req),
        timezone: typeof body.tz === "string" ? body.tz.slice(0, 64) : null,
      }).select("id").single();
      if (error) return json({ error: "Couldn't open the deck. Please try again." }, 500);
      return json({ ...base, session: { id: s.id, sig: await sign("session:" + s.id) } });
    }
    return json({ error: "Unknown action" }, 400);
  } catch (e) {
    console.error("deck-view", String((e as Error).message));
    return json({ error: "Something went wrong. Please try again." }, 500);
  }
});
