// paypal-payouts: creator payments from Stellar OS through PayPal Payouts (team only).
//   check  {campaign_id?, verify?}  which mode is on, which keys exist (names only), whether the caller may pay
//                                   for that campaign; verify:true also asks PayPal for a token (moves no money).
//   send   {campaign_id, items:[{row_id, email}]}  one PayPal batch for rows that are "Posted · to pay".
//   sync   {campaign_id?}           reads PayPal's status for open payments; also run by pg_cron (x-deck-secret).
//   cancel {payment_id}             takes back a payment the creator hasn't claimed yet (money returns to Stellar).
// Rules: only the campaign's runners/DRI (team_members.name in campaign_runner / comms_owner) or admins may pay;
// the campaign needs a PO number, which goes into every payment's note; a row is never paid twice (unique index);
// creator costs may not go over the creator budget. private.settings.paypal_mode = off | sandbox | live decides
// whether anything can be sent at all, and with which keys.
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
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" } });

// ---------- PayPal keys and modes ----------
type Env = "live" | "sandbox";
const first = (...names: string[]) => { for (const n of names) { const v = Deno.env.get(n); if (v) return v.trim(); } return ""; };
const KEYS: Record<Env, { id: string; secret: string; base: string }> = {
  live: {
    id: first("PAYPAL_CLIENT_ID", "PAYPAL_LIVE_CLIENT_ID"),
    secret: first("PAYPAL_CLIENT_SECRET", "PAYPAL_SECRET", "PAYPAL_API_KEY", "PAYPAL_SECRET_KEY", "PAYPAL_LIVE_CLIENT_SECRET", "PAYPAL_LIVE_SECRET"),
    base: "https://api-m.paypal.com",
  },
  sandbox: {
    id: first("PAYPAL_SANDBOX_CLIENT_ID"),
    secret: first("PAYPAL_SANDBOX_CLIENT_SECRET", "PAYPAL_SANDBOX_SECRET", "PAYPAL_SANDBOX_API_KEY"),
    base: "https://api-m.sandbox.paypal.com",
  },
};
const hasKeys = (env: Env) => !!(KEYS[env].id && KEYS[env].secret);
async function mode(): Promise<"off" | Env> {
  const { data } = await db.rpc("paypal_mode");
  return data === "live" || data === "sandbox" ? data : "off";
}
const tokens: Partial<Record<Env, { t: string; exp: number; scope: string }>> = {};
async function token(env: Env): Promise<{ t: string; scope: string }> {
  const c = tokens[env];
  if (c && c.exp > Date.now() + 60_000) return c;
  const k = KEYS[env];
  const r = await fetch(`${k.base}/v1/oauth2/token`, {
    method: "POST",
    headers: { Authorization: `Basic ${btoa(`${k.id}:${k.secret}`)}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials",
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new Error(`PayPal didn't accept the ${env === "live" ? "live" : "test"} keys (${j.error_description ?? j.error ?? r.status}).`);
  tokens[env] = { t: j.access_token, exp: Date.now() + (Number(j.expires_in) || 3000) * 1000, scope: String(j.scope ?? "") };
  return tokens[env]!;
}
async function paypal(env: Env, method: string, path: string, body?: unknown, requestId?: string) {
  const { t } = await token(env);
  const headers: Record<string, string> = { Authorization: `Bearer ${t}`, "Content-Type": "application/json" };
  if (requestId) headers["PayPal-Request-Id"] = requestId;
  const r = await fetch(`${KEYS[env].base}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, ok: r.ok, body: j };
}
const ppError = (j: any) => {
  const d = Array.isArray(j?.details) && j.details[0] ? ` (${j.details[0].issue ?? ""}${j.details[0].field ? ` ${j.details[0].field}` : ""})` : "";
  return String(j?.message ?? j?.name ?? "PayPal said no").slice(0, 300) + d;
};

// ---------- who is calling ----------
async function caller(req: Request) {
  const jwt = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!jwt.startsWith("ey")) return null;
  const { data } = await db.auth.getUser(jwt);
  const email = data.user?.email?.toLowerCase();
  if (!email) return null;
  const { data: tm } = await db.from("team_members").select("email,name,role").ilike("email", email).maybeSingle();
  return tm ? { email, name: String(tm.name ?? ""), role: String(tm.role ?? "member") } : null;
}
const splitPeople = (v: unknown) => String(v ?? "").split(/\s*(?:,|&|\+|\/|\band\b)\s*/i).map((x) => x.trim().toLowerCase()).filter(Boolean);
const mayPay = (who: { name: string; role: string }, camp: any) =>
  who.role === "admin" || (!!who.name && [...splitPeople(camp.campaign_runner), ...splitPeople(camp.comms_owner)].includes(who.name.toLowerCase()));

// ---------- money helpers ----------
const ZERO_DECIMALS = new Set(["JPY", "HUF", "TWD"]);
const roundFor = (v: number, cur: string) => (ZERO_DECIMALS.has(cur) ? Math.round(v) : Math.round(v * 100) / 100);
const fmt = (v: number, cur: string) => (ZERO_DECIMALS.has(cur) ? String(Math.round(v)) : v.toFixed(2));
const rowTotal = (r: any) => (r.amount != null ? Number(r.amount) : r.price_per_video != null ? Number(r.price_per_video) * (r.videos ?? 0) : 0);
const EMAIL = /^[^\s@<>()",;]+@[^\s@<>()",;]+\.[a-z]{2,}$/i;
const OPEN = ["queued", "pending", "success", "unclaimed", "onhold"];
const WAITING = ["queued", "pending", "unclaimed", "onhold"];
const today = () => new Date().toISOString().slice(0, 10);
const noteFor = (c: any) => `Stellar · PO ${c.po_number} · ${c.artist ?? ""}${c.song ? ` – ${c.song}` : ""}`.slice(0, 200);

// ---------- send ----------
async function send(who: any, body: any) {
  const m = await mode();
  if (m === "off") return json({ error: "Paying through PayPal isn't switched on yet." }, 403);
  if (!hasKeys(m)) return json({ error: m === "live" ? "The PayPal keys are missing in Supabase." : "The PayPal test keys are missing in Supabase." }, 500);
  const cid = String(body.campaign_id ?? "");
  const items: { row_id: string; email: string }[] = Array.isArray(body.items) ? body.items.slice(0, 500) : [];
  if (!cid || !items.length) return json({ error: "Pick at least one creator to pay." }, 400);
  const { data: camp } = await db.from("campaigns").select("id,artist,song,po_number,currency,budget,spend_cap_percent,campaign_runner,comms_owner").eq("id", cid).maybeSingle();
  if (!camp) return json({ error: "Campaign not found." }, 404);
  if (!mayPay(who, camp)) return json({ error: "Only the people running this campaign (or an admin) can pay its creators." }, 403);
  const po = String(camp.po_number ?? "").trim();
  if (!po) return json({ error: "Add this campaign's PO number first: every payment carries it." }, 400);
  const cur = String(camp.currency || "USD").toUpperCase();

  const { data: allRows } = await db.from("payout_rows").select("id,creator_id,handle,videos,price_per_video,amount,status").eq("campaign_id", cid);
  const byId = new Map((allRows ?? []).map((r: any) => [r.id, r]));
  const ids = [...new Set(items.map((i) => String(i.row_id)))];
  const { data: open } = await db.from("payout_payments").select("row_id").in("row_id", ids).in("status", OPEN);
  const busy = new Set((open ?? []).map((p: any) => p.row_id));
  const problems: string[] = [];
  const pay: { row: any; email: string; amount: number }[] = [];
  for (const id of ids) {
    const row = byId.get(id), email = String(items.find((i) => String(i.row_id) === id)?.email ?? "").trim().toLowerCase();
    if (!row) { problems.push("A creator isn't on this campaign's payout sheet any more."); continue; }
    const h = row.handle ?? "A creator";
    if (busy.has(id)) { problems.push(`${h} is already paid or on the way.`); continue; }
    if (row.status !== "posted") { problems.push(`${h} isn't marked "Posted · to pay".`); continue; }
    const amount = roundFor(rowTotal(row), cur);
    if (!(amount > 0)) { problems.push(`${h} has no amount.`); continue; }
    if (!EMAIL.test(email)) { problems.push(`${h} needs a valid PayPal email.`); continue; }
    pay.push({ row, email, amount });
  }
  if (problems.length) return json({ error: problems.join(" ") }, 400);
  if (camp.budget != null) {
    const cap = Number(camp.budget) * Number(camp.spend_cap_percent ?? 30) / 100;
    const spent = (allRows ?? []).reduce((s: number, r: any) => s + rowTotal(r), 0);
    if (spent > cap + 0.005) return json({ error: `Creator costs (${fmt(spent, cur)} ${cur}) are over the creator budget (${fmt(cap, cur)} ${cur}). Fix the sheet or raise the % first.` }, 400);
  }
  const { data: inv } = await db.from("invoice_requests").select("ref,invoice_number,economic_invoice_number,status,amount,currency").eq("campaign_id", cid).neq("status", "cancelled");
  const note = noteFor(camp);
  const total = roundFor(pay.reduce((s, p) => s + p.amount, 0), cur);
  const { data: batch, error: bErr } = await db.from("payout_batches").insert({
    campaign_id: cid, env: m, currency: cur, total, item_count: pay.length, po_number: po, invoices: inv ?? [], note, sent_by: who.email,
  }).select().single();
  if (bErr) return json({ error: bErr.message }, 500);
  const { data: rowsIn, error: pErr } = await db.from("payout_payments").insert(pay.map((p) => ({
    batch_id: batch.id, campaign_id: cid, row_id: p.row.id, creator_id: p.row.creator_id, handle: p.row.handle, recipient: p.email,
    amount: p.amount, currency: cur, po_number: po, note, env: m, sent_by: who.email,
  }))).select("id,row_id");
  if (pErr) {
    await db.from("payout_batches").delete().eq("id", batch.id);
    return json({ error: /duplicate|unique/i.test(pErr.message) ? "Someone is already paying one of these creators. Reload the page." : pErr.message }, 409);
  }
  // Remember the PayPal addresses for next time.
  for (const p of pay) {
    await db.from("payout_rows").update({ paypal_email: p.email }).eq("id", p.row.id);
    if (p.row.creator_id) await db.from("creators").update({ paypal_email: p.email }).eq("id", p.row.creator_id);
  }
  const itemId = new Map((rowsIn ?? []).map((x: any) => [x.row_id, x.id]));
  const res = await submit(batch, pay.map((p) => ({ id: itemId.get(p.row.id), email: p.email, amount: p.amount })), camp);
  return json(res, res.error ? 502 : 200);
}

const isDuplicate = (j: any) => /sender_batch_id already exists|SENDER_BATCH_ID/i.test(JSON.stringify(j ?? {})) && /already|duplicate/i.test(JSON.stringify(j ?? {}));
const originalBatchId = (j: any): string | null => {
  const t = JSON.stringify(j ?? {});
  const m = t.match(/\/v1\/payments\/payouts\/([A-Z0-9]{8,})/) ?? t.match(/"payout_batch_id"\s*:\s*"([A-Z0-9]{8,})"/);
  return m ? m[1] : null;
};
// Hand a batch to PayPal. Retrying with the same sender_batch_id / PayPal-Request-Id never pays twice.
function payloadFor(batch: any, items: { id: string; email: string; amount: number }[], camp: any) {
  const cur = batch.currency;
  return {
    sender_batch_header: {
      sender_batch_id: batch.id,
      email_subject: "You have a payment from Stellar",
      email_message: `Payment for ${camp.artist ?? "your campaign"}${camp.song ? ` – ${camp.song}` : ""} (PO ${batch.po_number}). Thank you!`.slice(0, 1000),
    },
    items: items.map((i) => ({
      recipient_type: "EMAIL", receiver: i.email, amount: { value: fmt(i.amount, cur), currency: cur },
      note: batch.note, sender_item_id: i.id, recipient_wallet: "PAYPAL",
    })),
  };
}
async function submit(batch: any, items: { id: string; email: string; amount: number }[], camp: any) {
  const cur = batch.currency;
  const payload = payloadFor(batch, items, camp);
  let r;
  try { r = await paypal(batch.env, "POST", "/v1/payments/payouts", payload, batch.id); }
  catch (e) { await db.from("payout_batches").update({ error: String((e as Error).message).slice(0, 300), checked_at: new Date().toISOString() }).eq("id", batch.id); return { batch_id: batch.id, status: "queued", note: "PayPal didn't answer; we'll try again in a few minutes." }; }
  if (r.ok && r.body?.batch_header?.payout_batch_id) {
    const st = String(r.body.batch_header.batch_status ?? "PENDING").toLowerCase();
    await db.from("payout_batches").update({ paypal_batch_id: r.body.batch_header.payout_batch_id, status: st, error: null, checked_at: new Date().toISOString() }).eq("id", batch.id);
    await db.from("payout_payments").update({ status: "pending", updated_at: new Date().toISOString() }).eq("batch_id", batch.id).eq("status", "queued");
    return { batch_id: batch.id, paypal_batch_id: r.body.batch_header.payout_batch_id, status: "pending", count: items.length, total: batch.total, currency: cur };
  }
  // PayPal already has this batch (we sent it before but never heard back): follow its link to the original, never mark it failed.
  if (isDuplicate(r.body)) {
    const orig = originalBatchId(r.body);
    if (orig) {
      await db.from("payout_batches").update({ paypal_batch_id: orig, status: "pending", error: null, checked_at: new Date().toISOString() }).eq("id", batch.id);
      await db.from("payout_payments").update({ status: "pending", updated_at: new Date().toISOString() }).eq("batch_id", batch.id).eq("status", "queued");
      return { batch_id: batch.id, paypal_batch_id: orig, status: "pending", count: items.length, total: batch.total, currency: cur };
    }
    const msg = "PayPal already has this batch. Check PayPal's activity before paying again: it may have been paid.";
    await db.from("payout_batches").update({ status: "error", error: msg, checked_at: new Date().toISOString() }).eq("id", batch.id);
    await db.from("payout_payments").update({ error: msg, updated_at: new Date().toISOString() }).eq("batch_id", batch.id).eq("status", "queued");
    return { batch_id: batch.id, status: "queued", note: "PayPal already has this batch. Check PayPal's activity before doing anything else." };
  }
  if (r.status >= 500) {
    await db.from("payout_batches").update({ error: ppError(r.body), checked_at: new Date().toISOString() }).eq("id", batch.id);
    return { batch_id: batch.id, status: "queued", note: "PayPal is having trouble; we'll try again in a few minutes." };
  }
  // PayPal refused the whole batch (e.g. not enough money in the account): nothing was paid.
  const msg = ppError(r.body);
  await db.from("payout_batches").update({ status: "failed", error: msg, checked_at: new Date().toISOString() }).eq("id", batch.id);
  await db.from("payout_payments").update({ status: "failed", error: msg, updated_at: new Date().toISOString() }).eq("batch_id", batch.id);
  return { error: `PayPal didn't send anything: ${msg}` };
}

// ---------- sync ----------
async function syncBatch(b: any) {
  const now = new Date().toISOString();
  if (!b.paypal_batch_id) {
    // Never reached PayPal (or we never heard back): try again for an hour, then leave it to a person.
    if (Date.now() - new Date(b.created_at).getTime() > 3600_000) {
      // It may still have gone through, so the creators stay blocked from a second payment until a person checks PayPal.
      const msg = "PayPal never confirmed this batch. Check PayPal's activity: it may have been paid.";
      await db.from("payout_batches").update({ status: "error", error: msg, checked_at: now }).eq("id", b.id);
      await db.from("payout_payments").update({ error: msg, updated_at: now }).eq("batch_id", b.id).eq("status", "queued");
      return;
    }
    const { data: items } = await db.from("payout_payments").select("id,recipient,amount").eq("batch_id", b.id);
    const { data: camp } = await db.from("campaigns").select("artist,song").eq("id", b.campaign_id).maybeSingle();
    await submit(b, (items ?? []).map((i: any) => ({ id: i.id, email: i.recipient, amount: Number(i.amount) })), camp ?? {});
    return;
  }
  const r = await paypal(b.env, "GET", `/v1/payments/payouts/${encodeURIComponent(b.paypal_batch_id)}?page_size=1000&page=1`);
  if (!r.ok) { await db.from("payout_batches").update({ error: ppError(r.body), checked_at: now }).eq("id", b.id); return; }
  await db.from("payout_batches").update({ status: String(r.body?.batch_header?.batch_status ?? b.status).toLowerCase(), error: null, checked_at: now }).eq("id", b.id);
  const { data: mine } = await db.from("payout_payments").select("id,row_id,status").eq("batch_id", b.id);
  const byId = new Map((mine ?? []).map((p: any) => [p.id, p]));
  for (const it of r.body?.items ?? []) {
    const p = byId.get(it?.payout_item?.sender_item_id);
    if (!p) continue;
    const st = String(it.transaction_status ?? "PENDING").toLowerCase();
    const err = it.errors?.message ?? it.errors?.name ?? null;
    await db.from("payout_payments").update({
      status: st, paypal_item_id: it.payout_item_id ?? null, transaction_id: it.transaction_id ?? null,
      fee: it.payout_item_fee?.value != null ? Number(it.payout_item_fee.value) : null, error: err ? String(err).slice(0, 300) : null, updated_at: now,
    }).eq("id", p.id);
    if (st === "success" && p.status !== "success" && p.row_id) {
      await db.from("payout_rows").update({ status: "paid", paid_on: today(), paid_via: "paypal" }).eq("id", p.row_id).neq("status", "paid");
    }
    // Money came back after it had been marked paid (refund, reversal): the creator is to pay again.
    if (p.status === "success" && ["returned", "refunded", "reversed"].includes(st) && p.row_id) {
      await db.from("payout_rows").update({ status: "posted", paid_on: null, paid_via: null }).eq("id", p.row_id).eq("status", "paid");
    }
  }
}
async function sync(campaignId?: string) {
  let q = db.from("payout_payments").select("batch_id").in("status", WAITING).limit(500);
  if (campaignId) q = q.eq("campaign_id", campaignId);
  const { data } = await q;
  const ids = [...new Set((data ?? []).map((x: any) => x.batch_id))];
  if (!ids.length) return { checked: 0 };
  const { data: batches } = await db.from("payout_batches").select("*").in("id", ids);
  let n = 0;
  for (const b of batches ?? []) {
    if (!hasKeys(b.env) || (b.status === "error" && !b.paypal_batch_id)) continue;
    try { await syncBatch(b); n++; } catch (e) { await db.from("payout_batches").update({ error: String((e as Error).message).slice(0, 300) }).eq("id", b.id); }
  }
  return { checked: n };
}

// ---------- cancel an unclaimed payment ----------
async function cancel(who: any, body: any) {
  const { data: p } = await db.from("payout_payments").select("id,env,status,paypal_item_id,campaign_id").eq("id", String(body.payment_id ?? "")).maybeSingle();
  if (!p) return json({ error: "Payment not found." }, 404);
  const { data: camp } = await db.from("campaigns").select("campaign_runner,comms_owner").eq("id", p.campaign_id).maybeSingle();
  if (!mayPay(who, camp ?? {})) return json({ error: "Only the people running this campaign (or an admin) can do this." }, 403);
  if (p.status !== "unclaimed" || !p.paypal_item_id) return json({ error: "Only payments the creator hasn't claimed yet can be taken back." }, 400);
  const r = await paypal(p.env, "POST", `/v1/payments/payouts-item/${encodeURIComponent(p.paypal_item_id)}/cancel`);
  if (!r.ok) return json({ error: /Processed status/i.test(ppError(r.body)) ? "PayPal is still processing this batch. Try again in a few minutes." : `PayPal said: ${ppError(r.body)}` }, 502);
  const st = String(r.body?.transaction_status ?? "RETURNED").toLowerCase();
  await db.from("payout_payments").update({ status: st, updated_at: new Date().toISOString() }).eq("id", p.id);
  return json({ ok: true, status: st });
}

// ---------- self-test with PayPal's TEST money (sandbox keys only; nothing is stored) ----------
// Sends the same kind of batch the OS sends, sends it again with the same id (must not pay twice), reads the
// status back and takes back one unclaimed payment. Run from SQL with the cron secret.
async function selftest(body: any) {
  if (!hasKeys("sandbox")) return { error: "No sandbox keys" };
  if (body.cancel_item) {   // take back an unclaimed TEST payment from an earlier self-test
    const c = await paypal("sandbox", "POST", `/v1/payments/payouts-item/${encodeURIComponent(String(body.cancel_item))}/cancel`);
    return { take_back: { status: c.status, now: c.body?.transaction_status, error: c.ok ? null : ppError(c.body) } };
  }
  const id = crypto.randomUUID();
  const receivers: string[] = (Array.isArray(body.receivers) && body.receivers.length ? body.receivers : ["stellar-test-creator-1@example.com", "stellar-test-creator-2@example.com"]).slice(0, 5).map(String);
  const batch = { id, env: "sandbox", currency: "USD", po_number: "#ST0000", note: "Stellar · PO #ST0000 · Test Artist – Test Song" };
  const items = receivers.map((e, i) => ({ id: crypto.randomUUID(), email: e, amount: 1.5 + i }));
  const payload = payloadFor(batch, items, { artist: "Test Artist", song: "Test Song" });
  const out: Record<string, unknown> = {};
  const r1 = await paypal("sandbox", "POST", "/v1/payments/payouts", payload, id);
  out.send = { status: r1.status, batch: r1.body?.batch_header?.payout_batch_id, batch_status: r1.body?.batch_header?.batch_status, error: r1.ok ? null : ppError(r1.body) };
  if (!r1.ok) return out;
  const r2 = await paypal("sandbox", "POST", "/v1/payments/payouts", payload, id);
  out.resend_same_id = { status: r2.status, refused_as_duplicate: isDuplicate(r2.body), points_to_original: originalBatchId(r2.body) === r1.body.batch_header.payout_batch_id,
    answer: { name: r2.body?.name, message: r2.body?.message, details: r2.body?.details, links: r2.body?.links } };
  let last: any = null;
  for (let i = 0; i < 8; i++) {
    await new Promise((res) => setTimeout(res, 5000));
    last = await paypal("sandbox", "GET", `/v1/payments/payouts/${r1.body.batch_header.payout_batch_id}?page_size=100&page=1`);
    if (!(last.body?.items ?? []).some((it: any) => it.transaction_status === "PENDING")) break;
  }
  out.status = { batch_status: last?.body?.batch_header?.batch_status, items: (last?.body?.items ?? []).map((it: any) => ({
    receiver: it.payout_item?.receiver, amount: it.payout_item?.amount, note: it.payout_item?.note, ours: items.some((x) => x.id === it.payout_item?.sender_item_id),
    status: it.transaction_status, fee: it.payout_item_fee?.value, error: it.errors?.name ?? null, item: it.payout_item_id })) };
  const un = (last?.body?.items ?? []).find((it: any) => it.transaction_status === "UNCLAIMED");
  if (un) {
    const c = await paypal("sandbox", "POST", `/v1/payments/payouts-item/${un.payout_item_id}/cancel`);
    out.take_back = { status: c.status, now: c.body?.transaction_status, error: c.ok ? null : ppError(c.body) };
  }
  return out;
}

// ---------- check: mode, keys (names only), may this person pay; verify = ask PayPal for a token ----------
async function check(who: any, body: any) {
  const m = await mode();
  let allowed: boolean | null = null;
  if (who && body.campaign_id) {
    const { data: camp } = await db.from("campaigns").select("campaign_runner,comms_owner").eq("id", String(body.campaign_id)).maybeSingle();
    allowed = camp ? mayPay(who, camp) : false;
  }
  const out: Record<string, unknown> = {
    mode: m, ready: m !== "off" && hasKeys(m), allowed, live_keys: hasKeys("live"), test_keys: hasKeys("sandbox"),
    key_names: Object.keys(Deno.env.toObject()).filter((k) => /paypal/i.test(k)).sort(),
  };
  if (body.verify && (!who || who.role === "admin")) {
    for (const env of ["live", "sandbox"] as Env[]) {
      if (!hasKeys(env)) continue;
      try { const t = await token(env); out[`${env}_ok`] = true; out[`${env}_payouts`] = /payouts/i.test(t.scope); }
      catch (e) { out[`${env}_ok`] = false; out[`${env}_error`] = (e as Error).message; }
    }
  }
  return out;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Not found" }, 404);
  const body = await req.json().catch(() => ({}));
  // pg_cron: status check only.
  const cronSecret = req.headers.get("x-deck-secret");
  if (cronSecret) {
    const { data: secret } = await db.rpc("deck_secret");
    if (cronSecret !== secret) return json({ error: "Not allowed" }, 403);
    if (body.action === "check") return json(await check(null, { verify: true }));   // keys check from SQL; moves no money
    if (body.action === "selftest") return json(await selftest(body));               // sandbox only, test money
    return json(await sync());
  }
  const who = await caller(req);
  if (!who) return json({ error: "Sign in to Stellar OS first." }, 401);
  try {
    if (body.action === "check") return json(await check(who, body));
    if (body.action === "send") return await send(who, body);
    if (body.action === "sync") return json(await sync(body.campaign_id ? String(body.campaign_id) : undefined));
    if (body.action === "cancel") return await cancel(who, body);
    return json({ error: "Unknown action" }, 400);
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});
