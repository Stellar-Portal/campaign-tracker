// vendor-form: the client's vendor form (vendor-form.html#t=<token>), replacing vendor.stellartrigger.com.
// Team (signed in):  link {campaign_id}                       -> one-time link to copy
//                    send {campaign_id, email, note?}           -> same, emailed from invoice@stellarmusic.dk (Resend)
// Client (no login): status {token} / submit {token, ...answers, signature}
// On submit the answers become the client, its invoicing company and its invoice contact in Clients, and fill the
// campaign (client, exact invoicing company, country, market, contact), which then syncs to the Campaign Overview
// sheet. A note goes into the campaign's team chat. Only a SHA-256 of each token is stored; links work once, 60 days.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

function serviceKey(): string {
  const raw = Deno.env.get("SUPABASE_SECRET_KEYS");
  if (raw) { try { const k = JSON.parse(raw); const v = k.default ?? Object.values(k)[0]; if (v) return String(v); } catch { /* ignore */ } }
  return Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
}
const db = createClient(Deno.env.get("SUPABASE_URL")!, serviceKey(), { auth: { persistSession: false } });
const OS = (Deno.env.get("STELLAR_OS_URL") || "https://os.stellarmusic.dk/").replace(/\/?$/, "/");
const FROM = Deno.env.get("VENDOR_EMAIL_FROM") || "Stellar Invoicing <invoice@stellarmusic.dk>";
const REPLY_TO = "invoice@stellarmusic.dk";
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" } });
const sha = async (t: string) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(t)))).map((b) => b.toString(16).padStart(2, "0")).join("");
const ipKey = async (req: Request) => sha("ip:" + ((req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || "unknown"));
const EMAIL = /^[^\s@<>()",;]+@[^\s@<>()",;]+\.[a-z]{2,}$/i;
const clean = (v: unknown, max: number) => String(v ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
const htmlEsc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
const normId = (v: string) => v.replace(/[\s.\-_/]/g, "").toUpperCase();

// West = the Americas, East = Asia (not the Middle East) and Oceania, Central = everything else.
const WEST = new Set("AG AI AR AW BB BL BM BO BQ BR BS BZ CA CL CO CR CU CW DM DO EC FK GD GF GL GP GT GY HN HT JM KN KY LC MF MQ MS MX NI PA PE PM PR PY SR SV SX TC TT US UY VC VE VG VI".split(" "));
const EAST = new Set("AF AS AU BD BN BT CC CK CN CX FJ FM GU HK ID IN JP KG KH KI KP KR KZ LA LK MH MM MN MO MP MV MY NC NF NP NR NU NZ PF PG PH PK PN PW SB SG TH TJ TK TL TM TO TV TW UZ VN VU WF WS".split(" "));
const marketOf = (cc: string) => (WEST.has(cc) ? "West" : EAST.has(cc) ? "East" : "Central");
const FREE_MAIL = /^(gmail|googlemail|yahoo|hotmail|outlook|live|icloud|me|aol|proton|protonmail|gmx|mail|yandex|qq|163)\./i;

async function caller(req: Request) {
  const jwt = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!jwt.startsWith("ey")) return null;
  const { data } = await db.auth.getUser(jwt);
  const email = data.user?.email?.toLowerCase();
  if (!email) return null;
  const { data: tm } = await db.from("team_members").select("email,name").ilike("email", email).maybeSingle();
  return tm ? { email, name: String(tm.name ?? "") } : null;
}

async function makeLink(who: any, campaignId: string | null, sentTo: string | null, note: string | null) {
  const token = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
  const { data, error } = await db.from("vendor_requests").insert({
    campaign_id: campaignId, token_hash: await sha(token), sent_to: sentTo, note, sent_by: who.email,
  }).select("id").single();
  if (error) throw new Error(error.message);
  return { id: data.id, url: `${OS}vendor-form#t=${token}` };
}

async function sendEmail(to: string, url: string, camp: any, note: string | null, who: any) {
  const key = Deno.env.get("RESEND_API_KEY");
  if (!key) return { ok: false, error: "Email isn't set up (RESEND_API_KEY missing). Copy the link instead." };
  const what = camp ? `${camp.artist ?? ""}${camp.song ? ` – ${camp.song}` : ""}` : "";
  const subject = `Vendor form${what ? `: ${what}` : ""} · Stellar`;
  const text = `Hi,\n\nTo set up invoicing${what ? ` for ${what}` : ""}, please fill in our vendor form. It takes about two minutes:\n${url}\n\n${note ? `${note}\n\n` : ""}Questions? Just reply to this email.\n\nStellar${who.name ? ` · ${who.name}` : ""}`;
  const html = `<div style="font-family:Inter,Arial,sans-serif;color:#1d1d1f;font-size:15px;line-height:1.55;max-width:520px">
    <p>Hi,</p><p>To set up invoicing${what ? ` for <b>${htmlEsc(what)}</b>` : ""}, please fill in our vendor form. It takes about two minutes.</p>
    <p style="margin:24px 0"><a href="${url}" style="background:#0626c7;color:#fff;text-decoration:none;padding:12px 22px;border-radius:999px;font-weight:600;display:inline-block">Fill in the vendor form</a></p>
    ${note ? `<p style="white-space:pre-line">${htmlEsc(note)}</p>` : ""}
    <p style="color:#6e6e73;font-size:13px">Questions? Just reply to this email.<br>Stellar${who.name ? ` · ${htmlEsc(who.name)}` : ""}</p></div>`;
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: FROM, to: [to], reply_to: REPLY_TO, subject, text, html }),
  });
  if (r.ok) return { ok: true };
  const j = await r.json().catch(() => ({}));
  return { ok: false, error: String(j?.message ?? `Email failed (${r.status})`).slice(0, 300) };
}

async function requestFor(token: unknown) {
  const t = String(token ?? "").trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(t)) return null;
  const { data } = await db.from("vendor_requests").select("*").eq("token_hash", await sha(t)).maybeSingle();
  return data ?? null;
}

async function submit(r: any, b: any) {
  const a = {
    company: clean(b.company, 200), company_id: clean(b.company_id, 60), street: clean(b.street, 200), zip: clean(b.zip, 20),
    city: clean(b.city, 100), country: clean(b.country, 2).toUpperCase(), contact_name: clean(b.contact_name, 120),
    contact_email: clean(b.contact_email, 200).toLowerCase(), stellar_contact: clean(b.stellar_contact, 120),
    artists: clean(b.artists, 300), songs: clean(b.songs, 300), print_name: clean(b.print_name, 120), notes: clean(b.notes, 2000),
  };
  const sig = String(b.signature ?? "");
  const miss: string[] = [];
  if (a.company.length < 2) miss.push("company name");
  if (!a.company_id) miss.push("company ID number");
  if (!a.street) miss.push("street");
  if (!a.zip) miss.push("zip code");
  if (!a.city) miss.push("city");
  if (!/^[A-Z]{2}$/.test(a.country)) miss.push("country");
  if (a.contact_name.length < 2) miss.push("contact name");
  if (!EMAIL.test(a.contact_email)) miss.push("a valid contact email");
  if (!a.stellar_contact) miss.push("your Stellar contact");
  if (!a.artists) miss.push("artist(s)");
  if (!a.songs) miss.push("song(s)");
  if (a.print_name.length < 2) miss.push("print name");
  if (!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(sig) || sig.length < 500 || sig.length > 400_000) miss.push("your signature");
  if (miss.length) return json({ error: `Please add ${miss.join(", ")}.` }, 400);

  // One use only: claim the link first.
  const { data: claimed } = await db.from("vendor_requests").update({ submitted_at: new Date().toISOString() }).eq("id", r.id).is("submitted_at", null).select("id");
  if (!claimed?.length) return json({ state: "done" });
  try {
    const { data: camp } = r.campaign_id ? await db.from("campaigns").select("id,client,client_id,client_market,client_contact_name,client_contact_email").eq("id", r.campaign_id).maybeSingle() : { data: null };
    const idKey = normId(a.company_id), market = marketOf(a.country), domain = a.contact_email.split("@")[1] ?? "";
    // 1. Which client: the campaign's, else the one with this company ID, else the one with this email domain, else a new one.
    let clientId: string | null = camp?.client_id ?? null;
    const { data: ents } = await db.from("client_entities").select("id,client_id,vat_number,legal_name");
    const sameId = (ents ?? []).filter((e: any) => e.vat_number && normId(e.vat_number) === idKey);
    if (!clientId && sameId.length) clientId = sameId[0].client_id;
    if (!clientId && domain && !FREE_MAIL.test(domain)) {
      const { data: byDom } = await db.from("clients").select("id").contains("email_domains", [domain]);
      if (byDom?.length === 1) clientId = byDom[0].id;
    }
    if (!clientId) {
      const { data: nc, error } = await db.from("clients").insert({
        name: a.company, market, country: a.country, email_domains: domain && !FREE_MAIL.test(domain) ? [domain] : [], created_by: "vendor form",
        notes: "Added from a vendor form.",
      }).select("id").single();
      if (error) throw error;
      clientId = nc.id;
    }
    // 2. The invoicing company under that client (same ID number or same name), updated or added.
    const mine = (ents ?? []).filter((e: any) => e.client_id === clientId);
    const hit = mine.find((e: any) => e.vat_number && normId(e.vat_number) === idKey) ?? mine.find((e: any) => String(e.legal_name ?? "").trim().toLowerCase() === a.company.toLowerCase());
    const entity = {
      client_id: clientId, legal_name: a.company, vat_number: a.company_id, street: a.street, zip: a.zip, city: a.city, country: a.country,
      address: `${a.street}, ${a.zip} ${a.city}, ${a.country}`, invoice_email: a.contact_email, source: "vendor form", updated_at: new Date().toISOString(),
    };
    let entityId: string;
    if (hit) { const { error } = await db.from("client_entities").update(entity).eq("id", hit.id); if (error) throw error; entityId = hit.id; }
    else { const { data: ne, error } = await db.from("client_entities").insert(entity).select("id").single(); if (error) throw error; entityId = ne.id; }
    // 3. The invoice contact.
    const { data: ct } = await db.from("client_contacts").select("id").eq("client_id", clientId).ilike("email", a.contact_email).maybeSingle();
    if (ct) await db.from("client_contacts").update({ name: a.contact_name, role: "Invoices" }).eq("id", ct.id);
    else await db.from("client_contacts").insert({ client_id: clientId, name: a.contact_name, email: a.contact_email, role: "Invoices", market });
    // 4. The campaign (syncs to the sheet). Invoicing details are the client's own words, so they win; the rest only fills gaps.
    if (camp) {
      const { data: cl } = await db.from("clients").select("name").eq("id", clientId).maybeSingle();
      await db.from("campaigns").update({
        client_id: clientId, client: camp.client || cl?.name || a.company, client_entity_id: entityId, client_country: a.country,
        client_market: camp.client_market || `Stellar ${market}`,
        client_contact_name: camp.client_contact_name || a.contact_name, client_contact_email: camp.client_contact_email || a.contact_email,
      }).eq("id", camp.id);
      await db.from("campaign_messages").insert({ campaign_id: camp.id, author_email: "Vendor form",
        body: `${a.contact_name} filled in the vendor form for ${a.company} (${a.company_id}). The invoicing company, address and contact are saved in Clients.${a.notes ? ` Their note: "${a.notes}"` : ""}` });
    }
    await db.from("vendor_requests").update({ answers: a, signature: sig, client_id: clientId, entity_id: entityId }).eq("id", r.id);
    return json({ ok: true });
  } catch (e) {
    console.error("vendor-form submit", String((e as Error).message));
    await db.from("vendor_requests").update({ submitted_at: null }).eq("id", r.id);
    return json({ error: "Couldn't save. Please try again." }, 500);
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Not found" }, 404);
  const body = await req.json().catch(() => ({}));
  try {
    if (body.action === "link" || body.action === "send") {
      const who = await caller(req);
      if (!who) return json({ error: "Sign in to Stellar OS first." }, 401);
      const cid = body.campaign_id ? String(body.campaign_id) : null;
      const { data: camp } = cid ? await db.from("campaigns").select("id,artist,song").eq("id", cid).maybeSingle() : { data: null };
      if (cid && !camp) return json({ error: "Campaign not found." }, 404);
      if (body.action === "link") return json(await makeLink(who, cid, null, null));
      const to = clean(body.email, 200).toLowerCase(), note = clean(body.note, 1000) || null;
      if (!EMAIL.test(to)) return json({ error: "That email address doesn't look right." }, 400);
      const link = await makeLink(who, cid, to, note);
      const sent = await sendEmail(to, link.url, camp, note, who);
      await db.from("vendor_requests").update({ emailed: sent.ok, email_error: sent.ok ? null : sent.error }).eq("id", link.id);
      return json({ ...link, emailed: sent.ok, error: sent.ok ? undefined : sent.error });
    }
    if (!(await db.rpc("deck_rate_ok", { p_key: "vf:" + (await ipKey(req)), p_limit: 30, p_seconds: 600 })).data) return json({ error: "Too many tries. Please wait a few minutes." }, 429);
    const r = await requestFor(body.token);
    if (!r || new Date(r.expires_at).getTime() < Date.now()) return json({ state: "gone" });
    if (r.submitted_at) return json({ state: "done" });
    if (body.action === "status") {
      if (!r.opened_at) await db.from("vendor_requests").update({ opened_at: new Date().toISOString() }).eq("id", r.id);
      const { data: camp } = r.campaign_id ? await db.from("campaigns").select("artist,song,comms_owner").eq("id", r.campaign_id).maybeSingle() : { data: null };
      const { data: sender } = await db.from("team_members").select("name").ilike("email", r.sent_by).maybeSingle();
      return json({ state: "open", artist: camp?.artist ?? "", song: camp?.song ?? "", contact: sender?.name || camp?.comms_owner || "" });
    }
    if (body.action === "submit") return await submit(r, body);
    return json({ error: "Unknown action" }, 400);
  } catch (e) {
    console.error("vendor-form", String((e as Error).message));
    return json({ error: "Something went wrong. Please try again." }, 500);
  }
});
