// Invoice plan: the parts a campaign's budget will be invoiced in (e.g. 6,000 = 3 × 2,000, monthly or upfront).
// Shown as a card on the campaign page (team only; clients never see it). The database does the sums and the daily
// job (06:15 UTC) either sends the request to finance by itself or reminds the campaign people.
import { money } from "./money.js?v=20261126b";
import { confirmDialog } from "./dialog.js?v=20261126b";

const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const r2 = (v) => Math.round(v * 100) / 100;
const num = (v) => { const x = parseFloat(String(v ?? "").replace(/[^0-9.\-]/g, "")); return Number.isFinite(x) ? x : null; };
const plain = (v) => Number(v).toLocaleString("en", { maximumFractionDigits: 2 });
const todayIso = () => new Date().toISOString().slice(0, 10);
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const shortDay = (d) => {
  const dt = new Date(`${String(d).slice(0, 10)}T00:00:00`);
  return dt.toLocaleDateString("en-GB", { day: "numeric", month: "short", ...(dt.getFullYear() === new Date().getFullYear() ? {} : { year: "numeric" }) });
};
export const isOpen = (p) => p.status === "upcoming" || p.status === "due";   // no live invoice request yet

export async function loadPlan(sb, campaignId) {
  const { data, error } = await sb.rpc("campaign_invoice_plan", { p_campaign: campaignId });
  return error ? null : data;
}

// Equal parts, every month or all on one day. The database adds them after any parts already there.
export async function makePlan(sb, campaignId, { total, parts, every, start, label }) {
  const { data, error } = await sb.rpc("invoice_plan_split", { p_campaign: campaignId, p_total: total, p_parts: parts, p_every: every, p_start: start, p_label: label || "Part", p_replace: false });
  if (error) throw error;
  return data;
}

// "3 × 2,000 · Dec, Jan, Feb": what a split will make (same rounding as the database: the last part takes the rest).
export function previewSplit(total, n, every, startIso) {
  if (!(total > 0) || !(n >= 1) || !startIso || !/^\d{4}-\d{2}-\d{2}$/.test(startIso)) return "";
  const base = r2(total / n), last = r2(total - base * (n - 1));
  if (!(base > 0)) return "";
  const amounts = n === 1 ? plain(total) : last === base ? `${n} × ${plain(base)}` : `${n - 1} × ${plain(base)} + ${plain(last)}`;
  if (every !== "month") return `${amounts} · all on ${shortDay(startIso)}`;
  const m0 = Number(startIso.slice(5, 7)) - 1, names = Array.from({ length: n }, (_, i) => MONTHS[(m0 + i) % 12]);
  return `${amounts} · ${n > 6 ? `${names.slice(0, 5).join(", ")}, … ${names[n - 1]}` : names.join(", ")}`;
}

const BOLT = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M13 3 5 14h6l-1 7 8-11h-6z"/></svg>';
const BELL = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9a6 6 0 0 1 12 0c0 6 2 7.5 2 7.5H4S6 15 6 9zM10 20a2 2 0 0 0 4 0"/></svg>';
const PILL = { upcoming: "Upcoming", due: "Due", requested: "Requested", returned: "Sent back", invoiced: "Invoiced", paid: "Paid" };

// ---------- the card ----------
export async function mountInvoicePlan(box, sb, c, { toast, requestInvoice, onChange } = {}) {
  if (!box) return;
  let plan = null;
  const load = async () => { plan = await loadPlan(sb, c.id); if (box.isConnected) draw(); };
  const changed = async () => { await load(); onChange?.(); };

  function draw() {
    if (!plan) { box.innerHTML = ""; return; }
    const parts = plan.parts ?? [];
    if (!parts.length) {
      if (!(Number(plan.budget) > 0) || c.status === "finished") { box.innerHTML = ""; return; }
      box.innerHTML = `<div class="ip ip-empty"><span>Invoice in parts? Plan them here.</span><button type="button" class="link-btn" data-ip="split">Split…</button></div>`;
      box.querySelector("[data-ip=split]").onclick = () => splitDialog(sb, c, plan, { toast, onDone: changed });
      return;
    }
    const cur = (p) => p.currency || plan.currency;
    const diff = plan.difference == null ? null : Number(plan.difference);
    const sum = diff == null ? `${money(plan.total, plan.currency)} planned`
      : Math.abs(diff) < 0.5 ? `${money(plan.total, plan.currency)} of ${money(plan.budget, plan.currency)} budget`
      : diff > 0 ? `<span class="ip-warn">${esc(money(diff, plan.currency))} left to plan</span>` : `<span class="ip-warn">${esc(money(-diff, plan.currency))} over budget</span>`;
    const pill = (p) => {
      const t = `${PILL[p.status] ?? p.status}${p.request_ref != null && !isOpen(p) ? ` #${p.request_ref}` : ""}`;
      return p.request_id && !isOpen(p) ? `<a class="inv-pill s-${esc(p.status)}" href="#/invoices">${esc(t)}</a>` : `<span class="inv-pill s-${esc(p.status)}">${esc(t)}</span>`;
    };
    const auto = (p) => !isOpen(p) || !p.due_on ? ""
      : p.auto_request ? `<span class="ip-auto" role="img" title="Sends to finance by itself" aria-label="Sends to finance by itself">${BOLT}</span>`
      : `<span class="ip-auto" role="img" title="Reminds you" aria-label="Reminds you">${BELL}</span>`;
    box.innerHTML = `<section class="ip" aria-label="Invoice plan">
      <div class="ip-head"><b>Invoice plan</b><span class="ip-sum">${sum}${plan.other_currency ? ` <span class="ip-other" title="Parts in another currency aren't counted in this total">· other currency</span>` : ""}</span></div>
      <div class="ip-rows">${parts.map((p) => `<div class="ip-row s-${esc(p.status)}">
        <span class="ip-label">${esc(p.label || "Part")}</span>
        <span class="ip-amt">${esc(money(p.amount, cur(p)))}</span>
        <span class="ip-date${p.due_on ? "" : " muted"}">${p.due_on ? esc(shortDay(p.due_on)) : "When ready"}</span>
        <span class="ip-state">${pill(p)}${auto(p)}</span>
        <span class="ip-acts">${isOpen(p) ? `<button type="button" class="ip-req" data-ip-req="${esc(p.id)}">Request now</button>` : ""}<button type="button" class="link-btn" data-ip-edit="${esc(p.id)}">Edit</button>${["invoiced", "paid"].includes(p.status) ? "" : `<button type="button" class="link-btn" data-ip-del="${esc(p.id)}">Remove</button>`}</span>
      </div>`).join("")}</div>
      <div class="ip-foot"><button type="button" class="link-btn" data-ip="add">Add a part</button><button type="button" class="link-btn" data-ip="split">Split…</button></div>
    </section>`;
    const part = (id) => parts.find((p) => p.id === id);
    box.querySelectorAll("[data-ip-req]").forEach((b) => (b.onclick = () => requestInvoice?.(b.dataset.ipReq)));
    box.querySelectorAll("[data-ip-edit]").forEach((b) => (b.onclick = () => partDialog(sb, c, plan, part(b.dataset.ipEdit), { toast, onDone: changed })));
    box.querySelectorAll("[data-ip-del]").forEach((b) => (b.onclick = async () => {
      const p = part(b.dataset.ipDel);
      const ok = await confirmDialog({ title: "Remove this part?", body: `${esc(p.label || "Part")} · ${esc(money(p.amount, cur(p)))}.${p.request_id && !isOpen(p) ? " Its invoice request stays where it is." : ""}`, confirm: "Remove" });
      if (!ok) return;
      b.disabled = true;
      const { error } = await sb.from("invoice_plan_parts").delete().eq("id", p.id);
      if (error) { b.disabled = false; toast?.(error.message); return; }
      toast?.("Part removed");
      changed();
    }));
    box.querySelector("[data-ip=add]").onclick = () => partDialog(sb, c, plan, null, { toast, onDone: changed });
    box.querySelector("[data-ip=split]").onclick = () => splitDialog(sb, c, plan, { toast, onDone: changed });
  }
  await load();
}

// ---------- shared dialog bits ----------
function makeDialog(cls, html) {
  const d = document.createElement("dialog");
  d.className = `po-dialog ip-dialog ${cls}`;
  d.innerHTML = `<form method="dialog" novalidate>${html}</form>`;
  document.body.append(d);
  d.addEventListener("click", (e) => { if (e.target === d) d.close(); });
  d.onclose = () => d.remove();
  const err = d.querySelector(".ip-err");
  const fail = (m) => { err.hidden = !m; err.textContent = m ?? ""; };
  return { d, f: d.querySelector("form"), fail };
}

// Add a part, or edit one (label, amount, date, send by itself, note).
function partDialog(sb, c, plan, part, { toast, onDone }) {
  const locked = !!part && !isOpen(part);   // it has an invoice request: the amount stays
  const cur = part?.currency || plan.currency;
  const { d, f, fail } = makeDialog("ip-part", `
    <h2>${part ? "Edit part" : "Add a part"}</h2>
    <label>Label <input name="label" maxlength="80" value="${esc(part?.label ?? "")}" placeholder="e.g. December 2026" autocomplete="off"></label>
    <div class="ip-grid">
      <label>Amount <span class="ip-cur">${esc(cur)}</span><input name="amount" inputmode="decimal" value="${part ? esc(part.amount) : ""}"${locked ? " disabled" : ""}></label>
      <label>Invoice on <input name="due_on" type="date" value="${esc(part?.due_on ?? "")}"></label>
    </div>
    ${locked ? `<p class="ip-quiet">The amount is locked because this part has an invoice request.</p>` : ""}
    <label class="ip-switch"><span>Send to finance by itself on the date</span><span class="switch"><input type="checkbox" name="auto"${part ? (part.auto_request ? " checked" : "") : " checked"}><span></span></span></label>
    <label>Note <textarea name="note" rows="2" maxlength="500">${esc(part?.note ?? "")}</textarea></label>
    <p class="small error ip-err" role="alert" hidden></p>
    <div class="actions"><button type="submit" value="ok" class="primary">${part ? "Save" : "Add part"}</button><button type="submit" value="cancel" formnovalidate>Cancel</button></div>`);
  const sync = () => { f.auto.disabled = !f.due_on.value; };
  f.due_on.addEventListener("input", sync); sync();
  let saving = false;
  f.onsubmit = async (e) => {
    if (e.submitter?.value !== "ok") return;
    e.preventDefault();
    if (saving) return;
    const amount = locked ? Number(part.amount) : num(f.amount.value);
    if (!(amount > 0)) { fail("Enter an amount more than 0."); return; }
    fail("");
    const row = { label: f.label.value.trim() || null, due_on: f.due_on.value || null, auto_request: f.auto.checked, note: f.note.value.trim() || null };
    if (!locked) row.amount = amount;
    const btn = e.submitter; btn.disabled = true; saving = true;
    const { error } = part
      ? await sb.from("invoice_plan_parts").update(row).eq("id", part.id)
      : await sb.from("invoice_plan_parts").insert({ ...row, campaign_id: c.id, position: Math.max(0, ...plan.parts.map((p) => Number(p.position) || 0)) + 1 });
    if (error) { btn.disabled = false; saving = false; fail(error.message); return; }
    d.close(); toast?.(part ? "Part saved" : "Part added"); onDone?.();
  };
  d.showModal();
  f.label.focus();
}

// Split into equal parts, every month or all at once.
export function splitDialog(sb, c, plan, { toast, onDone }) {
  const parts = plan?.parts ?? [], open = parts.filter(isOpen);
  const cur = plan?.currency || c.currency || "USD";
  const budget = plan?.budget != null ? Number(plan.budget) : null;
  const planned = Number(plan?.total ?? 0);
  const openTotal = open.filter((p) => (p.currency || cur) === cur).reduce((t, p) => t + Number(p.amount), 0);
  const defTotal = (replace) => {
    if (budget == null) return "";
    const left = r2(budget - planned + (replace ? openTotal : 0));
    return String(left > 0 ? left : budget);
  };
  const { d, f, fail } = makeDialog("ip-split", `
    <h2>Split into parts</h2>
    <div class="ip-grid">
      <label>Total <span class="ip-cur">${esc(cur)}</span><input name="total" inputmode="decimal" value="${esc(defTotal(false))}"></label>
      <label>Number of parts <input name="parts" type="number" min="1" max="60" step="1" value="3"></label>
      <label>Invoice <select name="every"><option value="month">Every month</option><option value="none">All at once</option></select></label>
      <label>Starting <input name="start" type="date" value="${esc(String(c.start_date ?? "").slice(0, 10) || todayIso())}"></label>
    </div>
    <label class="ip-labelrow" hidden>Label <input name="label" value="Part" maxlength="40" autocomplete="off"></label>
    ${open.length ? `<label class="inv-check ip-replace"><input type="checkbox" name="replace"> Replace the upcoming parts</label>` : ""}
    <p class="ip-preview" aria-live="polite"></p>
    <p class="small error ip-err" role="alert" hidden></p>
    <div class="actions"><button type="submit" value="ok" class="primary">Make the plan</button><button type="submit" value="cancel" formnovalidate>Cancel</button></div>`);
  let totalTouched = false;
  const prev = d.querySelector(".ip-preview");
  const draw = () => {
    d.querySelector(".ip-labelrow").hidden = f.every.value !== "none";
    prev.textContent = previewSplit(num(f.total.value), parseInt(f.parts.value, 10), f.every.value, f.start.value);
  };
  f.total.addEventListener("input", () => { totalTouched = true; draw(); });
  f.replace?.addEventListener("change", () => { if (!totalTouched) f.total.value = defTotal(f.replace.checked); draw(); });
  for (const el of [f.parts, f.every, f.start]) el.addEventListener("input", draw);
  draw();
  let saving = false;
  f.onsubmit = async (e) => {
    if (e.submitter?.value !== "ok") return;
    e.preventDefault();
    if (saving) return;
    const total = num(f.total.value), n = parseInt(f.parts.value, 10);
    if (!(total > 0)) { fail("Enter the total to split."); return; }
    if (!(n >= 1 && n <= 60)) { fail("Pick between 1 and 60 parts."); return; }
    if (!f.start.value) { fail("Pick the starting date."); return; }
    fail("");
    const replace = !!f.replace?.checked && open.length > 0;
    if (replace) {
      const ok = await confirmDialog({ title: "Replace the upcoming parts?", body: `${open.length} upcoming ${open.length === 1 ? "part" : "parts"} (${esc(money(openTotal, cur))}) will be removed first. Parts that already have an invoice request stay.`, confirm: "Replace" });
      if (!ok) return;
    }
    const btn = e.submitter; btn.disabled = true; saving = true;
    if (replace) {
      const del = await sb.from("invoice_plan_parts").delete().in("id", open.map((p) => p.id));
      if (del.error) { btn.disabled = false; saving = false; fail(del.error.message); return; }
    }
    try {
      await makePlan(sb, c.id, { total, parts: n, every: f.every.value, start: f.start.value, label: f.label.value.trim() });
    } catch (x) {
      btn.disabled = false; saving = false;
      fail(`${x?.message ?? "Couldn't make the plan."}${replace ? " The upcoming parts were already removed." : ""}`);
      if (replace) onDone?.();
      return;
    }
    d.close(); toast?.(`${n} ${n === 1 ? "part" : "parts"} planned`); onDone?.();
  };
  d.showModal();
  f.parts.focus(); f.parts.select();
}
