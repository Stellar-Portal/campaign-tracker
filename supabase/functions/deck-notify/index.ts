// deck-notify (runs every 2 minutes from pg_cron): posts one Slack message per deck view once the
// viewer has been gone for 3 minutes: who, which deck and link, time spent, slides seen, top slide,
// links opened. Needs the SLACK_DECKS_WEBHOOK secret (a Slack incoming-webhook URL); without it, it does nothing.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

function serviceKey(): string {
  const raw = Deno.env.get("SUPABASE_SECRET_KEYS");
  if (raw) { try { const k = JSON.parse(raw); const v = k.default ?? Object.values(k)[0]; if (v) return String(v); } catch { /* ignore */ } }
  return Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
}
const db = createClient(Deno.env.get("SUPABASE_URL")!, serviceKey(), { auth: { persistSession: false } });
const HOOK = Deno.env.get("SLACK_DECKS_WEBHOOK") ?? "";
const OS = "https://stellar-portal.github.io/campaign-tracker/#/decks/";
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });
const dur = (ms: number) => { const s = Math.round((ms || 0) / 1000); return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`; };
const slack = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

Deno.serve(async (req) => {
  const { data: secret } = await db.rpc("deck_secret");
  if (req.headers.get("x-deck-secret") !== secret) return json({ error: "Not allowed" }, 403);
  if (!HOOK) return json({ skipped: "SLACK_DECKS_WEBHOOK isn't set" });
  const cutoff = new Date(Date.now() - 3 * 60_000).toISOString();
  const { data: sess } = await db.from("deck_sessions")
    .select("id,deck_id,link_id,email,verified,started_at,last_seen_at,total_ms,slide_count,device,browser,timezone")
    .is("notified_at", null).gte("started_at", new Date(Date.now() - 2 * 86400_000).toISOString()).lt("started_at", cutoff)
    .order("started_at").limit(25);
  const done = (sess ?? []).filter((s) => (s.last_seen_at ?? s.started_at) < cutoff);
  let sent = 0;
  for (const s of done) {
    const [{ data: deck }, { data: link }, { data: per }, { data: clicks }, { count: before }] = await Promise.all([
      db.from("decks").select("title").eq("id", s.deck_id).maybeSingle(),
      db.from("deck_links").select("label").eq("id", s.link_id).maybeSingle(),
      db.from("deck_session_slides").select("n,ms").eq("session_id", s.id),
      db.from("deck_clicks").select("n,url").eq("session_id", s.id),
      s.email ? db.from("deck_sessions").select("id", { count: "exact", head: true }).eq("deck_id", s.deck_id).eq("email", s.email).lt("started_at", s.started_at) : Promise.resolve({ count: 0 }),
    ]);
    const seen = (per ?? []).filter((p) => p.ms > 0);
    const top = [...seen].sort((a, b) => b.ms - a.ms)[0];
    const who = s.email ? `*${slack(s.email)}*${s.verified ? " ✓" : ""}` : "*Someone without an email*";
    const repeat = s.email && (before ?? 0) > 0 ? ` (view ${(before ?? 0) + 1})` : s.email ? " · first view" : "";
    const lines = [
      `👀 ${who} viewed *${slack(deck?.title ?? "a deck")}*${link?.label ? ` via "${slack(link.label)}"` : ""}${repeat}`,
      `${dur(s.total_ms)} · ${seen.length}/${s.slide_count || "?"} slides${top ? ` · most time on slide ${top.n} (${dur(top.ms)})` : ""}`,
      clicks?.length ? `Opened: ${clicks.map((c) => `slide ${c.n} → ${slack(c.url.replace(/^https?:\/\/(www\.)?/, "").split(/[?#]/)[0].slice(0, 60))}`).join(", ")}` : "",
      `${[s.device, s.browser, s.timezone?.split("/").pop()?.replace(/_/g, " ")].filter(Boolean).join(" · ")} · <${OS}${s.deck_id}|Open in Stellar OS>`,
    ].filter(Boolean);
    const r = await fetch(HOOK, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: lines.join("\n"), unfurl_links: false }) });
    if (!r.ok) { console.error("deck-notify slack", r.status, await r.text()); break; }
    await db.from("deck_sessions").update({ notified_at: new Date().toISOString() }).eq("id", s.id);
    sent++;
  }
  return json({ sent });
});
