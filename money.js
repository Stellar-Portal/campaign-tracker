// Money flags: the OS compares what was sold (budget), what was invoiced and who we invoice, and raises a flag
// to the right person by itself. Shown on the campaign page and on the Invoices page ("Needs attention").
// Also the vendor form dialog (send the client a one-time form from invoice@stellarmusic.dk, or copy the link).

const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
export const money = (v, cur) => {
  if (v == null || v === "") return "–";
  try { return new Intl.NumberFormat("en", { style: "currency", currency: cur || "USD", minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(v); }
  catch { return `${Number(v).toLocaleString("en")} ${cur ?? ""}`.trim(); }
};
const day = (d) => (d ? new Date(`${String(d).slice(0, 10)}T00:00:00`).toLocaleDateString("en-GB", { day: "numeric", month: "short" }) : "");
const today = () => new Date().toISOString().slice(0, 10);
const LIVE = ["requested", "returned", "invoiced", "paid"];
const DAY = 86400000;

// Everything the flags need, for one campaign or all of them.
export async function loadMoney(sb, campaignId = null) {
  let cq = sb.from("campaigns").select("id,artist,song,status,budget,currency,client,client_id,client_entity_id,client_contact_email,comms_owner,created_at,start_date");
  let iq = sb.from("invoice_requests").select("id,campaign_id,status,amount,currency,client_entity_id,invoice_number,due_date,finance_note");
  let vq = sb.from("vendor_requests").select("id,campaign_id,sent_to,emailed,email_error,created_at,expires_at,opened_at,submitted_at,sent_by").order("created_at", { ascending: false });
  if (campaignId) { cq = cq.eq("id", campaignId); iq = iq.eq("campaign_id", campaignId); vq = vq.eq("campaign_id", campaignId); }
  const [c, i, v] = await Promise.all([cq, iq, vq]);
  const by = (rows) => { const m = {}; for (const r of rows ?? []) (m[r.campaign_id] ??= []).push(r); return m; };
  return { campaigns: c.data ?? [], invoices: by(i.data), vendors: by(v.data) };
}

// The flags for one campaign: { key, who: "dri" | "finance", text, act }.
export function flagsFor(c, invs = [], vendors = []) {
  const out = [];
  const live = invs.filter((r) => LIVE.includes(r.status));
  const billed = live.filter((r) => ["invoiced", "paid"].includes(r.status));
  const old = Date.now() - Date.parse(c.created_at ?? Date.now()) > 7 * DAY;
  const budget = c.budget != null ? Number(c.budget) : null;
  const openForm = vendors.find((v) => !v.submitted_at && Date.parse(v.expires_at) > Date.now());

  // 1. Who do we invoice? (the campaign or one of its invoice requests has no exact invoicing company)
  if (!c.client_entity_id || live.some((r) => !r.client_entity_id)) {
    out.push(openForm
      ? { key: "company", who: "dri", text: `Vendor form ${openForm.sent_to ? `sent to ${esc(openForm.sent_to)}` : "link made"} ${esc(day(openForm.created_at))}${openForm.opened_at ? ", opened" : ""}, not filled in yet.`, act: "vendor" }
      : { key: "company", who: "dri", text: c.client_entity_id ? "An invoice request doesn't say which company to invoice yet." : "We don't know which company to invoice yet.", act: c.client_entity_id ? "invoices" : "vendor" });
  }
  // 2. Not invoiced yet (active or a week old, has a budget, no request).
  if (budget > 0 && !live.length && (c.status !== "draft" || old)) {
    out.push({ key: "invoice", who: "dri", text: "Not invoiced yet.", act: "request" });
  }
  // 3. Finance sent a request back.
  for (const r of live.filter((x) => x.status === "returned")) out.push({ key: "returned", who: "dri", text: `Finance sent the invoice request back${r.finance_note ? `: “${esc(r.finance_note)}”` : "."}`, act: "invoices" });
  // 4. Budget and invoices don't match (only when everything is in the campaign's currency).
  if (budget != null && billed.length && billed.every((r) => r.currency === (c.currency || "USD"))) {
    const inv = billed.reduce((t, r) => t + Number(r.amount), 0), pending = live.filter((r) => ["requested", "returned"].includes(r.status)).reduce((t, r) => t + Number(r.amount), 0);
    if (inv - budget > 1) out.push({ key: "credit", who: "finance", text: `Invoiced ${money(inv, c.currency)}, but the budget is now ${money(budget, c.currency)}: needs a credit note of ${money(inv - budget, c.currency)}.`, act: "invoices" });
    else if (budget - inv - pending > 1) out.push({ key: "more", who: "dri", text: `Only ${money(inv, c.currency)} of the ${money(budget, c.currency)} budget is invoiced${pending ? ` (${money(pending, c.currency)} more requested)` : ""}.`, act: "request" });
  }
  // 5. Client hasn't paid by the due date.
  for (const r of live.filter((x) => x.status === "invoiced" && x.due_date && x.due_date < today())) out.push({ key: "overdue", who: "finance", text: `Invoice ${r.invoice_number ? `#${esc(r.invoice_number)} ` : ""}was due ${esc(day(r.due_date))} and isn't marked paid.`, act: "invoices" });
  return out;
}

// The banner on a campaign page.
export async function mountMoneyFlags(box, sb, c, { toast, requestInvoice, refresh }) {
  if (!box) return;
  const m = await loadMoney(sb, c.id);
  const camp = m.campaigns[0];
  if (!box.isConnected || !camp) return;
  const flags = flagsFor(camp, m.invoices[c.id], m.vendors[c.id]);
  if (!flags.length) { box.innerHTML = ""; return; }
  const btn = (f) => f.act === "vendor" ? `<button type="button" data-mf="vendor">Vendor form</button>`
    : f.act === "request" ? `<button type="button" data-mf="request">Request invoice</button>`
    : `<a href="#/invoices" class="mf-link">Open in Invoices</a>`;
  box.innerHTML = `<div class="mflags" role="status">${flags.map((f) => `<div class="mflag ${f.who}">
    <span class="mf-who">${f.who === "finance" ? "Finance" : "To do"}</span><span class="mf-text">${f.text}</span>${btn(f)}</div>`).join("")}</div>`;
  box.querySelectorAll('[data-mf="vendor"]').forEach((b) => (b.onclick = () => vendorFormDialog(sb, camp, { toast, onDone: () => mountMoneyFlags(box, sb, c, { toast, requestInvoice, refresh }) })));
  box.querySelectorAll('[data-mf="request"]').forEach((b) => (b.onclick = () => requestInvoice?.()));
}

// "Vendor form": email the client a one-time form from invoice@stellarmusic.dk, or copy the link.
export async function vendorFormDialog(sb, c, { toast, onDone } = {}) {
  const { data: past } = await sb.from("vendor_requests").select("sent_to,emailed,email_error,created_at,opened_at,submitted_at,sent_by").eq("campaign_id", c.id).order("created_at", { ascending: false }).limit(5);
  const state = (v) => v.submitted_at ? "filled in" : v.opened_at ? "opened, not filled in yet" : v.email_error ? "email failed" : "not opened yet";
  const d = document.createElement("dialog");
  d.className = "po-dialog vf-dialog";
  d.innerHTML = `<form method="dialog">
    <h2>Vendor form</h2>
    <p class="muted small" style="margin:0 0 12px">The client fills in their company, ID number, address and invoice contact once. It saves to Clients and fills this campaign${c.artist ? ` (${esc(c.artist)}${c.song ? ` – ${esc(c.song)}` : ""})` : ""} by itself.</p>
    <label>Send it to <input name="to" type="email" value="${esc(c.client_contact_email ?? "")}" placeholder="name@company.com" autocomplete="off"></label>
    <label>Message <span class="muted small" style="font-weight:400">optional, added to the email</span><textarea name="note" rows="3" maxlength="1000" placeholder="e.g. Great speaking today. Here's our vendor form so we can send the invoice."></textarea></label>
    <p class="muted small" style="margin:-4px 0 0">Sent from invoice@stellarmusic.dk. Replies go to that inbox.</p>
    ${past?.length ? `<div class="vf-past"><b class="small">Sent before</b>${past.map((v) => `<div class="small"><span>${esc(v.sent_to || "Link copied")} · ${esc(day(v.created_at))}</span><span class="${v.submitted_at ? "vf-ok" : "muted"}">${esc(state(v))}</span></div>`).join("")}</div>` : ""}
    <p class="small error" id="vf-err" role="alert"></p>
    <div class="actions"><button type="submit" value="send" class="primary">Send email</button><button type="button" id="vf-copy">Copy link instead</button><button type="submit" value="cancel" formnovalidate>Cancel</button></div>
  </form>`;
  document.body.append(d);
  const f = d.querySelector("form"), err = d.querySelector("#vf-err");
  const call = async (body) => {
    const { data, error } = await sb.functions.invoke("vendor-form", { body: { campaign_id: c.id, ...body } });
    let msg = data?.error;
    if (!msg && error) msg = (await error.context?.json?.().catch(() => null))?.error ?? error.message;
    return { data, msg };
  };
  f.onsubmit = async (e) => {
    if (e.submitter?.value !== "send") return;
    e.preventDefault();
    const to = f.to.value.trim();
    if (!/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(to)) { err.textContent = "Add the email address of the person you're talking to."; f.to.focus(); return; }
    const b = e.submitter; b.disabled = true; b.textContent = "Sending…"; err.textContent = "";
    const { data, msg } = await call({ action: "send", email: to, note: f.note.value.trim() });
    b.disabled = false; b.textContent = "Send email";
    if (!data?.url) { err.textContent = msg ?? "Couldn't send. Try again."; return; }
    if (!data.emailed) {
      try { await navigator.clipboard.writeText(data.url); } catch { /* ignore */ }
      err.textContent = `The email didn't go out (${data.error ?? "unknown error"}). The link is copied: paste it in an email yourself.`;
      return;
    }
    d.close(); toast?.(`Vendor form sent to ${to}`); onDone?.();
  };
  d.querySelector("#vf-copy").onclick = async () => {
    const { data, msg } = await call({ action: "link" });
    if (!data?.url) { err.textContent = msg ?? "Couldn't make the link."; return; }
    try { await navigator.clipboard.writeText(data.url); d.close(); toast?.("Link copied. It works once, for 60 days."); onDone?.(); }
    catch { err.textContent = data.url; }
  };
  d.addEventListener("click", (e) => { if (e.target === d) d.close(); });
  d.onclose = () => d.remove();
  d.showModal();
  (f.to.value ? f.note : f.to).focus();
}

// Pick the exact invoicing company among a client's companies (used on invoice requests).
export async function entitiesOf(sb, clientId) {
  if (!clientId) return [];
  const { data } = await sb.from("client_entities").select("id,legal_name,vat_number,country,city,address,invoice_email,economic_numbers,uses_portal,portal_name,attention")
    .or(`client_id.eq.${clientId},also_clients.cs.{${clientId}}`).order("legal_name");
  return data ?? [];
}
