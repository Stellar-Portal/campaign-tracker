// creator-details: the public side of a one-time "payment details" link (payment-details.html#t=<token>).
// A creator opens the link Stellar sent them and fills in their name, country and PayPal details once; they are
// saved on their roster card and used for every future campaign. No login. Only a SHA-256 of the token is stored
// (creator_detail_links), each link works once and for 30 days, and requests are rate-limited per hashed IP.
//   status {token}                                   -> { state: open | used | gone, handle, platform }
//   submit {token, legal_name, country, paypal_email, paypal_username?}
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

function serviceKey(): string {
  const raw = Deno.env.get("SUPABASE_SECRET_KEYS");
  if (raw) { try { const k = JSON.parse(raw); const v = k.default ?? Object.values(k)[0]; if (v) return String(v); } catch { /* ignore */ } }
  return Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
}
const db = createClient(Deno.env.get("SUPABASE_URL")!, serviceKey(), { auth: { persistSession: false } });
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" } });
const sha = async (t: string) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(t)))).map((b) => b.toString(16).padStart(2, "0")).join("");
const ipKey = async (req: Request) => sha("ip:" + ((req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || "unknown"));
const EMAIL = /^[^\s@<>()",;]+@[^\s@<>()",;]+\.[a-z]{2,}$/i;
const clean = (v: unknown, max: number) => String(v ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);

async function linkFor(token: unknown) {
  const t = String(token ?? "").trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(t)) return null;
  const { data } = await db.from("creator_detail_links").select("id,creator_id,expires_at,used_at").eq("token_hash", await sha(t)).maybeSingle();
  return data ?? null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Not found" }, 404);
  const body = await req.json().catch(() => ({}));
  try {
    if (!(await db.rpc("deck_rate_ok", { p_key: "cd:" + (await ipKey(req)), p_limit: 30, p_seconds: 600 })).data) return json({ error: "Too many tries. Please wait a few minutes." }, 429);
    const link = await linkFor(body.token);
    if (!link || new Date(link.expires_at).getTime() < Date.now()) return json({ state: "gone" });
    if (link.used_at) return json({ state: "used" });
    const { data: c } = await db.from("creators").select("id,username,platform").eq("id", link.creator_id).maybeSingle();
    if (!c) return json({ state: "gone" });

    if (body.action === "status") return json({ state: "open", handle: c.username, platform: c.platform });

    if (body.action === "submit") {
      const name = clean(body.legal_name, 120), country = clean(body.country, 2).toUpperCase();
      const email = clean(body.paypal_email, 200).toLowerCase();
      const user = clean(body.paypal_username, 80).replace(/^(https?:\/\/)?(www\.)?paypal\.me\//i, "").replace(/^@/, "").replace(/\/.*$/, "");
      const problems: string[] = [];
      if (name.length < 2) problems.push("your full name");
      if (!/^[A-Z]{2}$/.test(country)) problems.push("the country you live in");
      if (!EMAIL.test(email)) problems.push("a valid PayPal email");
      if (user && !/^[A-Za-z0-9._-]{1,40}$/.test(user)) problems.push("a PayPal username with letters and numbers only");
      if (problems.length) return json({ error: `Please add ${problems.join(", ")}.` }, 400);
      // One use only: claim the link first, so two quick submits can't both write.
      const { data: claimed } = await db.from("creator_detail_links").update({ used_at: new Date().toISOString() }).eq("id", link.id).is("used_at", null).select("id");
      if (!claimed?.length) return json({ state: "used" });
      const { error } = await db.from("creators").update({
        legal_name: name, residence_country: country, paypal_email: email, paypal_username: user || null,
        payout_method: "paypal", payout_updated_at: new Date().toISOString(), payout_updated_by: "the creator",
      }).eq("id", c.id);
      if (error) {
        await db.from("creator_detail_links").update({ used_at: null }).eq("id", link.id);
        return json({ error: "Couldn't save. Please try again." }, 500);
      }
      return json({ ok: true });
    }
    return json({ error: "Unknown action" }, 400);
  } catch (e) {
    console.error("creator-details", String((e as Error).message));
    return json({ error: "Something went wrong. Please try again." }, 500);
  }
});
