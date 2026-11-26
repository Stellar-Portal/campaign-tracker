// notify-email (pg_cron, every 5 minutes; header x-deck-secret like deck-notify): emails each team member the alerts
// they haven't read after 10 minutes, as ONE short email per person. Does nothing unless
// private.settings notify_email = 'on' (read with public.notify_email_mode(), service role only).
// Needs RESEND_API_KEY; sender DECK_EMAIL_FROM (default Stellar <noreply@stellarmusic.dk>); links go to STELLAR_OS_URL
// (default https://os.stellarmusic.dk/). Sets notifications.emailed_at only after Resend accepted the email.
// Body {dry:true} lists who would get what and sends nothing.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

function serviceKey(): string {
  const raw = Deno.env.get("SUPABASE_SECRET_KEYS");
  if (raw) { try { const k = JSON.parse(raw); const v = k.default ?? Object.values(k)[0]; if (v) return String(v); } catch { /* ignore */ } }
  return Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
}
const db = createClient(Deno.env.get("SUPABASE_URL")!, serviceKey(), { auth: { persistSession: false } });
const RESEND = Deno.env.get("RESEND_API_KEY") ?? "";
const FROM = Deno.env.get("DECK_EMAIL_FROM") ?? "Stellar <noreply@stellarmusic.dk>";
const OS = (Deno.env.get("STELLAR_OS_URL") || "https://os.stellarmusic.dk/").replace(/\/?$/, "/");
const WAIT_MIN = 10;          // an alert is emailed only if it is still unread after this long
const MAX_AGE_DAYS = 3;       // older ones are never emailed (e.g. when the switch is turned on later)
const MAX_PER_EMAIL = 8;      // lines in one email; the rest is "and N more"
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });
const html = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
const linkOf = (h: unknown) => OS + (/^#\/[A-Za-z0-9_\-\/]*$/.test(String(h ?? "")) ? String(h) : "#/me");

Deno.serve(async (req) => {
  const { data: secret } = await db.rpc("deck_secret");
  if (!secret || req.headers.get("x-deck-secret") !== secret) return json({ error: "Not allowed" }, 403);
  const body = await req.json().catch(() => ({}));
  const { data: mode } = await db.rpc("notify_email_mode");
  if (mode !== "on") return json({ skipped: "notify_email is off" });
  if (!RESEND && !body.dry) return json({ skipped: "RESEND_API_KEY isn't set" });

  const { data: rows, error } = await db.from("notifications").select("id,email,title,body,link,created_at")
    .is("emailed_at", null).is("read_at", null)
    .lt("created_at", new Date(Date.now() - WAIT_MIN * 60_000).toISOString())
    .gt("created_at", new Date(Date.now() - MAX_AGE_DAYS * 86400_000).toISOString())
    .order("created_at").limit(300);
  if (error) return json({ error: error.message }, 500);
  const byPerson = new Map<string, typeof rows>();
  for (const r of rows ?? []) { const k = String(r.email).toLowerCase(); byPerson.set(k, [...(byPerson.get(k) ?? []), r]); }

  const plan: { to: string; n: number }[] = [];
  let sent = 0, failed = 0;
  for (const [to, list] of byPerson) {
    plan.push({ to, n: list!.length });
    if (body.dry) continue;
    const shown = list!.slice(0, MAX_PER_EMAIL), more = list!.length - shown.length;
    const subject = list!.length === 1 ? String(list![0].title).slice(0, 120) : `${list!.length} things need a look in Stellar OS`;
    const text = [
      list!.length === 1 ? "You have one alert you haven't opened:" : `You have ${list!.length} alerts you haven't opened:`, "",
      ...shown.map((r) => `- ${r.title}${r.body ? `\n  ${String(r.body).replace(/\s+/g, " ").slice(0, 160)}` : ""}\n  ${linkOf(r.link)}`),
      ...(more > 0 ? ["", `...and ${more} more: ${OS}#/me`] : []),
      "", "Stellar OS · you get this because the alerts stayed unread for 10 minutes.",
    ].join("\n");
    const htmlBody = `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;font-size:15px;color:#1d1d1f;max-width:520px">
<p style="margin:0 0 14px">${list!.length === 1 ? "You have one alert you haven't opened:" : `You have ${list!.length} alerts you haven't opened:`}</p>
${shown.map((r) => `<p style="margin:0 0 12px"><a href="${html(linkOf(r.link))}" style="color:#0626c7;font-weight:600;text-decoration:none">${html(r.title)}</a>${r.body ? `<br><span style="color:#6e6e73">${html(String(r.body).replace(/\s+/g, " ").slice(0, 160))}</span>` : ""}</p>`).join("")}
${more > 0 ? `<p style="margin:0 0 12px"><a href="${html(OS)}#/me" style="color:#0626c7">and ${more} more</a></p>` : ""}
<p style="color:#6e6e73;font-size:12px;margin-top:24px">Stellar OS · you get this because the alerts stayed unread for 10 minutes.</p></div>`;
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST", headers: { Authorization: `Bearer ${RESEND}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: FROM, to: [to], subject, text, html: htmlBody }),
    });
    if (!r.ok) { failed++; console.error("notify-email resend", r.status, (await r.text()).slice(0, 200)); continue; }
    await db.from("notifications").update({ emailed_at: new Date().toISOString() }).in("id", list!.map((x) => x.id));
    sent++;
  }
  return json(body.dry ? { dry: true, people: plan } : { sent, failed });
});
