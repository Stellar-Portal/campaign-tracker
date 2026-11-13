// deck-view: the public side of tracked deck links. No login; everything is checked here.
//   { action: "status", token }                      is this link live? (gate shows or "not active")
//   { action: "code", token, email }                 email a 6-digit code (links with "check their email" on)
//   { action: "open", token, email?, code?, pass?, tz? } start a viewing session → slides, links, videos
//   { action: "track", session, sig, slides, clicks } merge time per slide (running totals) and link clicks
//   { action: "help", token, email }                 the code didn't arrive: ask the team (Slack + Decks) to let them in
//   { action: "help_status", id, sig }               has the team let them in yet? → a viewer pass when they have
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
const REOPEN_MINUTES = 30;   // reopening the same link within this time continues the same view

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

// A pass remembers the viewer's email for one link on their device, so opening the same link again
// skips the gate. Every other link asks again (Sam's rule: once per link). Passes made before passes
// carried the link (no "l") are accepted for their deck.
async function makePass(deckId: string, linkId: string, email: string, verified: boolean) {
  const body = b64u(new TextEncoder().encode(JSON.stringify({ d: deckId, l: linkId, e: email, v: verified ? 1 : 0, x: Date.now() + PASS_DAYS * 86400_000 })));
  return `${body}.${await sign("pass:" + body)}`;
}
async function readPass(pass: unknown, deckId: string, linkId: string): Promise<{ email: string; verified: boolean } | null> {
  if (typeof pass !== "string" || !pass.includes(".")) return null;
  const [body, sig] = pass.split(".");
  if (!(await checkSig("pass:" + body, sig))) return null;
  try { const p = JSON.parse(fromB64u(body)); return (p.l ? p.l === linkId : p.d === deckId) && p.x > Date.now() && EMAIL.test(p.e) ? { email: p.e, verified: p.v === 1 } : null; } catch { return null; }
}

// One-time email codes (needs the RESEND_API_KEY secret; without it, links fall back to a plain email gate).
const RESEND = Deno.env.get("RESEND_API_KEY") ?? "";
const FROM = Deno.env.get("DECK_EMAIL_FROM") ?? "Stellar <noreply@stellarmusic.dk>";
const codesOn = () => !!RESEND;
async function sendCode(linkId: string, email: string, title: string) {
  const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000).padStart(6, "0");
  await db.from("deck_email_codes").insert({ link_id: linkId, email, code_hash: await sha(`code:${linkId}:${email}:${code}`) });
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST", headers: { Authorization: `Bearer ${RESEND}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: FROM, to: [email], subject: `${code} is your code for ${title}`,
      text: `Your code to view "${title}" from Stellar is ${code}.\n\nIt works for 15 minutes. If you didn't ask for it, you can ignore this email.\n\nStellar Marketing ApS · Studiestræde 14A, 4., 1455 København K, Denmark`,
      html: `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;font-size:15px;color:#1d1d1f;max-width:440px"><p>Your code to view <b>${title.replace(/[<>&"]/g, "")}</b> from Stellar:</p><p style="font-size:32px;font-weight:700;letter-spacing:6px;color:#0626c7;margin:16px 0">${code}</p><p style="color:#6e6e73">It works for 15 minutes. If you didn't ask for it, you can ignore this email.</p><p style="color:#6e6e73;font-size:12px;margin-top:28px">Stellar Marketing ApS · Studiestræde 14A, 4., 1455 København K, Denmark</p></div>` }),
  });
  if (!r.ok) { console.error("deck-view resend", r.status, (await r.text()).slice(0, 200)); throw new Error("send"); }
}
async function checkCode(linkId: string, email: string, code: unknown): Promise<boolean> {
  if (typeof code !== "string" || !/^\d{6}$/.test(code.trim())) return false;
  // Any code still valid for this link and email works, not only the newest: an email that turns up late
  // (e.g. from the spam folder) after a new code was asked for still opens the deck.
  const { data: rows } = await db.from("deck_email_codes").select("id,code_hash,attempts,expires_at,used_at").eq("link_id", linkId).eq("email", email)
    .is("used_at", null).gt("expires_at", new Date().toISOString()).lt("attempts", 5).order("created_at", { ascending: false }).limit(6);
  if (!rows?.length) return false;
  const hash = await sha(`code:${linkId}:${email}:${code.trim()}`);
  const hit = rows.find((r) => r.code_hash === hash);
  if (!hit) { for (const r of rows) await db.from("deck_email_codes").update({ attempts: r.attempts + 1 }).eq("id", r.id); return false; }
  await db.from("deck_email_codes").update({ used_at: new Date().toISOString() }).in("id", rows.map((r) => r.id));
  return true;
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
  const { data: link } = await db.from("deck_links").select("id,deck_id,enabled,expires_at,require_email,verify_email,allow_download,recipient_email").eq("token", token).maybeSingle();
  if (!link || !link.enabled) return { error: "This link isn't active." };
  if (link.expires_at && new Date(link.expires_at) < new Date()) return { error: "This link has expired." };
  const { data: deck } = await db.from("decks").select("id,title,current_version_id").eq("id", link.deck_id).maybeSingle();
  if (!deck?.current_version_id) return { error: "This deck isn't ready yet." };
  return { link, deck };
}

async function content(versionId: string) {
  const [{ data: slides }, { data: spots }] = await Promise.all([
    db.from("deck_slides").select("n,image_path,width,height,title").eq("version_id", versionId).order("n"),
    db.from("deck_spots").select("id,n,kind,url,label,x,y,w,h,clip,overlays,video_path,status").eq("version_id", versionId).order("n"),
  ]);
  const paths = [...(slides ?? []).map((s) => s.image_path), ...(spots ?? []).flatMap((s) => [s.video_path, ...((s.overlays ?? []) as any[]).map((o) => o.path)])].filter(Boolean) as string[];
  const signed: Record<string, string> = {};
  for (let i = 0; i < paths.length; i += 100) {
    const { data } = await db.storage.from("deck-media").createSignedUrls(paths.slice(i, i + 100), 7200);
    for (const s of data ?? []) if (s.signedUrl && s.path) signed[s.path] = s.signedUrl;
  }
  return {
    slides: (slides ?? []).map((s) => ({ n: s.n, url: signed[s.image_path ?? ""] ?? null, w: s.width, h: s.height })),
    spots: (spots ?? []).filter((s) => s.kind === "link" ? !!s.url : s.status === "ready" && s.video_path)
      .map((s) => ({ n: s.n, kind: s.kind, url: s.kind === "video" ? signed[s.video_path!] ?? null : s.url, label: s.label, x: +s.x, y: +s.y, w: +s.w, h: +s.h, clip: s.clip ?? null,
        overlays: ((s.overlays ?? []) as any[]).map((o) => ({ url: signed[o.path] ?? null, x: +o.x, y: +o.y, w: +o.w, h: +o.h })).filter((o) => o.url) })),
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
      return json({ live: true, require_email: (r.link.require_email || r.link.verify_email) && !r.link.recipient_email, verify: r.link.verify_email && codesOn() });
    }

    if (body.action === "code") {
      const r = await liveLink(body.token);
      if ("error" in r) return json({ error: r.error }, 404);
      const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
      if (!EMAIL.test(email)) return json({ error: "Enter a valid email address." }, 400);
      if (!r.link.verify_email || !codesOn()) return json({ error: "This link doesn't use codes." }, 400);
      const okIp = (await db.rpc("deck_rate_ok", { p_key: "c:" + (await ipKey(req)), p_limit: 8, p_seconds: 900 })).data;
      const okMail = (await db.rpc("deck_rate_ok", { p_key: "ce:" + (await sha(email)), p_limit: 4, p_seconds: 900 })).data;
      if (!okIp || !okMail) return json({ error: "Too many codes asked for. Please wait a few minutes." }, 429);
      try { await sendCode(r.link.id, email, r.deck.title); } catch { return json({ error: "We couldn't send the code. Check the address and try again." }, 502); }
      return json({ ok: true });
    }

    if (body.action === "help") {
      const r = await liveLink(body.token);
      if ("error" in r) return json({ error: r.error }, 404);
      const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
      if (!EMAIL.test(email)) return json({ error: "Enter a valid email address." }, 400);
      if (!r.link.verify_email || !codesOn()) return json({ error: "This link doesn't use codes." }, 400);
      // The same person asking again within a day waits on the same request.
      const { data: open } = await db.from("deck_access_requests").select("id,status").eq("link_id", r.link.id).eq("email", email)
        .in("status", ["pending", "approved"]).gte("created_at", new Date(Date.now() - 86400_000).toISOString()).order("created_at", { ascending: false }).limit(1).maybeSingle();
      if (open) return json({ id: open.id, sig: await sign("help:" + open.id) });
      const okIp = (await db.rpc("deck_rate_ok", { p_key: "h:" + (await ipKey(req)), p_limit: 4, p_seconds: 3600 })).data;
      const okMail = (await db.rpc("deck_rate_ok", { p_key: "he:" + (await sha(email)), p_limit: 2, p_seconds: 3600 })).data;
      if (!okIp || !okMail) return json({ error: "Too many requests. Please wait a while, or contact Stellar directly." }, 429);
      const { data: row, error } = await db.from("deck_access_requests").insert({ deck_id: r.deck.id, link_id: r.link.id, email }).select("id").single();
      if (error) throw error;
      const hook = Deno.env.get("SLACK_DECKS_WEBHOOK");
      if (hook) {
        const { data: lk } = await db.from("deck_links").select("label").eq("id", r.link.id).maybeSingle();
        const os = (Deno.env.get("STELLAR_OS_URL") || "https://stellar-portal.github.io/campaign-tracker/").replace(/\/?$/, "/");
        const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
        const text = `🔑 *${esc(email)}* didn't get their code for *${esc(r.deck.title)}*${lk?.label ? ` via "${esc(lk.label)}"` : ""} and is waiting to be let in. <${os}#/decks/${r.deck.id}|Let them in or decline in Stellar OS>`;
        await fetch(hook, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text, unfurl_links: false }) }).catch(() => null);
      }
      return json({ id: row.id, sig: await sign("help:" + row.id) });
    }

    if (body.action === "help_status") {
      const id = String(body.id ?? "");
      if (!/^[0-9a-f-]{36}$/.test(id) || !(await checkSig("help:" + id, body.sig))) return json({ error: "Not allowed" }, 403);
      if (!(await db.rpc("deck_rate_ok", { p_key: "hs:" + id, p_limit: 40, p_seconds: 60 })).data) return json({ error: "Too many checks" }, 429);
      const { data: q } = await db.from("deck_access_requests").select("id,deck_id,link_id,email,status,decided_at").eq("id", id).maybeSingle();
      if (!q) return json({ status: "gone" });
      if (q.status !== "approved") return json({ status: q.status });
      if (Date.now() - new Date(q.decided_at).getTime() > 86400_000) return json({ status: "gone" });
      // A team member vouched for this person: the pass counts as checked, like a code would.
      return json({ status: "approved", email: q.email, pass: await makePass(q.deck_id, q.link_id, q.email, true) });
    }

    if (body.action === "open") {
      if (!(await db.rpc("deck_rate_ok", { p_key: "o:" + (await ipKey(req)), p_limit: 30, p_seconds: 600 })).data) return json({ error: "Too many tries. Please wait a few minutes." }, 429);
      const r = await liveLink(body.token);
      if ("error" in r) return json({ error: r.error }, 404);
      const { link, deck } = r;
      const team = await isTeam(req);
      const needCode = link.verify_email && codesOn() && !link.recipient_email && !team;
      const pass = await readPass(body.pass, deck.id, link.id);
      let email: string | null = link.recipient_email ?? (pass && (!needCode || pass.verified) ? pass.email : null);
      let verified = !!(pass?.verified && email === pass.email);
      if (!email && typeof body.email === "string" && EMAIL.test(body.email.trim())) {
        const typed = body.email.trim().toLowerCase();
        if (needCode) {
          if (!(await checkCode(link.id, typed, body.code))) return json({ error: "That code isn't right, or it has expired. Check the email or ask for a new code.", gate: true, code: true }, 400);
          verified = true;
        }
        email = typed;
      }
      if (!email && (link.require_email || needCode) && !team) return json({ error: "Enter a valid email address to view the deck.", gate: true }, 400);
      const c = await content(deck.current_version_id);
      const base = { title: deck.title, ...c, pass: email && !link.recipient_email ? await makePass(deck.id, link.id, email, verified) : null };
      if (team) return json({ ...base, session: null, team: true });
      // Reopening the same link within 30 minutes of the last activity (a reload, a sleeping tab woken up,
      // a second click on the link) continues that visit: no new view and no second Slack message. The page
      // gets the times already recorded so its running totals carry on from there.
      if (email) {
        const { data: prev } = await db.from("deck_sessions").select("id").eq("link_id", link.id).eq("email", email)
          .gte("last_seen_at", new Date(Date.now() - REOPEN_MINUTES * 60_000).toISOString()).order("last_seen_at", { ascending: false }).limit(1).maybeSingle();
        if (prev) {
          const { data: rows } = await db.from("deck_session_slides").select("n,ms").eq("session_id", prev.id);
          await db.from("deck_sessions").update({ last_seen_at: new Date().toISOString(), ...(verified ? { verified: true } : {}) }).eq("id", prev.id);
          return json({ ...base, session: { id: prev.id, sig: await sign("session:" + prev.id), base: Object.fromEntries((rows ?? []).map((x) => [x.n, Number(x.ms)])) } });
        }
      }
      const ua = req.headers.get("user-agent") ?? "";
      const { data: s, error } = await db.from("deck_sessions").insert({
        deck_id: deck.id, link_id: link.id, version_id: deck.current_version_id, email, verified,
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
