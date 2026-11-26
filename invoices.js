// Invoicing: campaign managers request an invoice from the campaign page; finance works through the
// requests here, sends the invoice from e-conomic and records it; payment is recorded when the label pays.
// Statuses: requested → invoiced → paid (or returned to the requester / cancelled).
import { confirmDialog } from "./dialog.js?v=20261126b";
import { entitiesOf, loadMoney, flagsFor } from "./money.js?v=20261126b";
import { loadPlan, isOpen } from "./invoice-plan.js?v=20261126b";

const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const money = (v, cur) => {
  if (v == null || v === "") return "–";
  try { return new Intl.NumberFormat("en", { style: "currency", currency: cur || "USD", minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(v); }
  catch { return `${Number(v).toLocaleString("en")} ${cur ?? ""}`.trim(); }
};
const num = (v) => { const x = parseFloat(String(v ?? "").replace(/[^0-9.\-]/g, "")); return Number.isFinite(x) ? x : null; };
const today = () => new Date().toISOString().slice(0, 10);
const addDays = (d, n) => { const t = new Date(`${d}T00:00:00Z`); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
const day = (d) => (d ? new Date(`${String(d).slice(0, 10)}T00:00:00`).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "");
const ago = (iso) => { const s = (Date.now() - Date.parse(iso)) / 1000; return s < 3600 ? `${Math.max(1, Math.round(s / 60))} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : day(iso); };
const refOf = (r) => `REQ-${String(r.ref).padStart(4, "0")}`;
export const overdue = (r) => r.status === "invoiced" && r.due_date && r.due_date < today();
export const STATUS = { requested: "To review", returned: "Sent back", invoiced: "Invoiced", paid: "Paid", cancelled: "Cancelled" };
export const statusPill = (r) => overdue(r) ? `<span class="inv-pill overdue">Overdue</span>` : `<span class="inv-pill s-${r.status}">${STATUS[r.status] ?? r.status}</span>`;

async function me(sb) {
  const email = (await sb.auth.getSession()).data.session?.user?.email?.toLowerCase() ?? null;
  const { data } = await sb.from("team_members").select("email,name,role").eq("email", email).maybeSingle();
  return { email, name: data?.name ?? email, role: data?.role ?? "member", finance: ["admin", "finance"].includes(data?.role) };
}

// ---------- the request, in the shape of the email template finance has always been sent ----------
const REGIONS = ["West", "Central", "East"];
const VIA = ["UNIPORT", "ARIBA", "FIT", "E-MAIL"];
const LABELS = ["Major", "Indie", "Other"];
const plainNum = (v) => Number(v).toLocaleString("en", { maximumFractionDigits: 2 });
const r2 = (v) => Math.round(v * 100) / 100;
export const byWho = (s) => (/^Stellar OS \(plan\)/i.test(String(s ?? "")) ? "Automatic (invoice plan)" : /^Stellar OS \(monthly\)/i.test(String(s ?? "")) ? "Automatic (monthly)" : s);

// The client's own PO lives in client_po (po_number is Stellar's PO).
export const splitNotes = (r) => ({ clientPo: r?.client_po ?? "", notes: String(r?.notes ?? "").trim() });

// The campaign's markets scaled to the amount being invoiced (the last one takes the rounding), and the same grouped by region.
function splitByMarket(rows, regionOf, budget, amount) {
  const base = rows.map((m) => ({ market: m.market, v: m.amount != null ? Number(m.amount) : budget != null && m.share_percent != null ? (budget * Number(m.share_percent)) / 100 : 0 })).filter((x) => x.v > 0);
  const total = base.reduce((t, x) => t + x.v, 0);
  if (!total || !(amount > 0)) return { lines: [], regions: {} };
  let used = 0;
  const lines = base.map((x, i) => { const a = i === base.length - 1 ? r2(amount - used) : r2((amount * x.v) / total); used += a; return { market: x.market, amount: a }; });
  const regions = {};
  for (const l of lines) { const k = regionOf[l.market] ?? "Other"; regions[k] = r2((regions[k] ?? 0) + l.amount); }
  return { lines, regions };
}
const regionList = (obj) => [...REGIONS, ...Object.keys(obj).filter((k) => !REGIONS.includes(k))].filter((k) => Number(obj[k]) > 0).map((k) => ({ region: k, amount: Number(obj[k]) }));
export const allocText = (alloc) => {
  const a = (Array.isArray(alloc) ? alloc : []).filter((x) => Number(x.amount) > 0);
  return a.length ? `${a.map((x) => `${plainNum(x.amount)} ${x.region}`).join(" / ")} = ${plainNum(a.reduce((t, x) => t + Number(x.amount), 0))}` : "";
};
// Exactly the template's lines. "Client PO" and "Project" are left out when there is none.
export function emailText(x) {
  const L = [], add = (k, v, optional) => { if (v || !optional) L.push(`${k}: ${v ?? ""}`.trimEnd()); };
  add("Campaign responsible", x.responsible);
  add("Client PO", x.client_po, true);
  add("Artist", x.artist);
  add("Song", x.song);
  add("Client", x.client);
  add("Major / Indie / Other", x.label_type);
  add("Budget", x.amount ? `${plainNum(x.amount)} ${x.currency ?? ""}`.trim() : "");
  add("Client Territory", x.territory);
  add("Budget Allocation", allocText(x.allocation));
  add("Project", x.project, true);
  add("Client contact name", x.contact_name);
  add("Client contact email", x.contact_email);
  add("Invoice to be sent through", x.send_via);
  return L.join("\n");
}
async function copyText(text, toast, msg) {
  try { await navigator.clipboard.writeText(text); toast?.(msg); } catch { toast?.("Couldn't copy. Select the text and copy it yourself."); }
}
const viaFrom = (ent) => {
  if (!ent?.uses_portal) return { via: "E-MAIL", other: "" };
  const n = String(ent.portal_name ?? "").trim(), hit = VIA.find((v) => v !== "E-MAIL" && n.toUpperCase().includes(v));
  return hit ? { via: hit, other: "" } : { via: "Other", other: n };
};

// ---------- the request form (from a campaign page) ----------
export async function requestInvoiceDialog(sb, c, { toast, onDone, partId = null }) {
  const { data: cr } = await sb.from("campaigns").select("artist,song,client,client_id,client_entity_id,invoicing_entity,po_number,budget,currency,comms_owner,campaign_runner,label_type,client_market,client_contact_name,client_contact_email").eq("id", c.id).maybeSingle();
  c = { ...c, ...(cr ?? {}) };
  const [ents, mk, mkts, open, cl, plan] = await Promise.all([
    entitiesOf(sb, c.client_id),
    sb.from("campaign_markets").select("market,share_percent,amount").eq("campaign_id", c.id),
    sb.from("markets").select("name,region"),
    sb.from("invoice_requests").select("amount,currency,status").eq("campaign_id", c.id).in("status", ["requested", "returned", "invoiced", "paid"]),
    c.client_id ? sb.from("clients").select("market").eq("id", c.client_id).maybeSingle() : { data: null },
    loadPlan(sb, c.id),
  ]);
  const regionOf = Object.fromEntries((mkts.data ?? []).map((m) => [m.name, m.region]));
  const cur0 = c.currency || "USD", budget = c.budget != null ? Number(c.budget) : null;
  const already = (open.data ?? []).filter((r) => (r.currency || cur0) === cur0).reduce((t, r) => t + Number(r.amount), 0);
  const otherCur = (open.data ?? []).filter((r) => (r.currency || cur0) !== cur0).length;
  const left = budget != null ? Math.max(0, r2(budget - already)) : null;   // "Request the rest"
  const ent0 = ents.find((e) => e.id === c.client_entity_id) ?? null;
  const terr0 = String(c.client_market ?? "").replace(/^Stellar\s+/i, ""), terrClient = String(cl.data?.market ?? "");
  const via0 = viaFrom(ent0);
  const who = [...new Set([c.comms_owner, ...String(c.campaign_runner ?? "").split(",")].map((x) => String(x ?? "").trim()).filter(Boolean))].join(", ");
  // The invoice plan: parts that have no live request yet. The one asked for (or the next one) is preselected.
  const CURS = ["USD", "EUR", "GBP", "DKK", "SEK", "JPY", "AUD", "SGD", "BRL", "MXN"];
  const openParts = (plan?.parts ?? []).filter(isOpen);
  const part0 = openParts.find((p) => p.id === partId) ?? openParts.find((p) => p.id === plan?.next_part_id) ?? null;
  const partCur = (p) => (CURS.includes(p?.currency) ? p.currency : cur0);
  const noPartAmount = already ? (left || null) : budget;
  const st = {
    amount: part0 ? Number(part0.amount) : noPartAmount, cur: part0 ? partCur(part0) : cur0, partId: part0?.id ?? null,
    po: c.po_number ?? "", client_po: "", project: "", notes: "",
    responsible: who, entity_id: ent0?.id ?? "", entity: ents.length ? "" : (c.invoicing_entity ?? ""),
    label: LABELS.includes(c.label_type) ? c.label_type : "", territory: REGIONS.includes(terr0) ? terr0 : REGIONS.includes(terrClient) ? terrClient : "",
    contact_name: c.client_contact_name ?? "", contact_email: c.client_contact_email ?? "",
    via: via0.via, via_other: via0.other, alloc: {}, allocTouched: false, touched: new Set(), shown: new Set(),
  };
  const mrows = mk.data ?? [];
  const autoAlloc = () => { st.alloc = Object.fromEntries(Object.entries(splitByMarket(mrows, regionOf, budget, st.amount).regions).map(([k, v]) => [k, String(v)])); };
  autoAlloc();
  const regionKeys = () => [...REGIONS, ...Object.keys(st.alloc).filter((k) => !REGIONS.includes(k))];
  const entOf = () => ents.find((e) => e.id === st.entity_id) ?? null;
  const fallback = () => { const e = entOf(); return { name: c.client_contact_name || e?.attention || "", email: c.client_contact_email || e?.invoice_email || "" }; };
  const sumAlloc = () => regionKeys().reduce((t, k) => t + (num(st.alloc[k]) ?? 0), 0);
  const miss = (k) => k === "responsible" ? !st.responsible.trim() : k === "entity" ? !(st.entity_id || st.entity.trim()) : k === "label" ? !st.label : k === "territory" ? !st.territory
    : k === "alloc" ? sumAlloc() <= 0 : k === "contact_name" ? !st.contact_name.trim() : k === "contact_email" ? !st.contact_email.trim() : false;
  if (!st.contact_name && !st.contact_email) { const fb = fallback(); st.contact_name = fb.name; st.contact_email = fb.email; }
  const FIELDS = [["responsible", "Campaign responsible"], ["entity", "Client (full legal name)"], ["label", "Major / Indie / Other"], ["territory", "Client territory"], ["alloc", "Budget allocation"],
    ["contact_name", "Client contact name"], ["contact_email", "Client contact email"], ["via", "Invoice to be sent through"], ["po", "Our PO"]];
  FIELDS.forEach(([k]) => { if (miss(k)) st.shown.add(k); });

  const sel = (name, opts, val, blank) => `<select name="${name}" aria-label="${name}">${blank ? `<option value="">${esc(blank)}</option>` : ""}${opts.map((o) => `<option${o === val ? " selected" : ""}>${esc(o)}</option>`).join("")}</select>`;
  const input = (k) => {
    if (k === "responsible" || k === "contact_name" || k === "po") return `<input name="${k}" value="${esc(st[k])}" autocomplete="off">`;
    if (k === "contact_email") return `<input name="contact_email" type="email" value="${esc(st.contact_email)}" autocomplete="off">`;
    if (k === "entity") return ents.length
      ? `<select name="entity_id" aria-label="Client"><option value="">Not sure yet: pick it later, or send the vendor form</option>${ents.map((x) => `<option value="${x.id}"${x.id === st.entity_id ? " selected" : ""}>${esc(x.legal_name)}${[x.city, x.country].filter(Boolean).length ? ` (${esc([x.city, x.country].filter(Boolean).join(", "))})` : ""}${(x.economic_numbers ?? []).length ? ` · e-conomic ${esc(x.economic_numbers.join(", "))}` : ""}</option>`).join("")}</select>`
      : `<input name="entity" value="${esc(st.entity)}" placeholder="Full legal name, no abbreviations" autocomplete="off">`;
    if (k === "label") return sel("label", LABELS, st.label, "Choose…");
    if (k === "territory") return sel("territory", REGIONS, st.territory, "Choose…");
    if (k === "alloc") return `<span class="inv-alloc">${regionKeys().map((r) => `<label><span>${esc(r)}</span><input data-alloc="${esc(r)}" inputmode="decimal" value="${esc(st.alloc[r] ?? "")}" aria-label="${esc(r)} amount"></label>`).join("")}</span><span class="inv-quiet" id="inv-alloc-sum"></span>`;
    if (k === "via") return `<span class="inv-via">${sel("via", [...VIA, "Other"], st.via)}<input name="via_other" value="${esc(st.via_other)}" placeholder="Which portal?"${st.via === "Other" ? "" : " hidden"}></span>`;
    return "";
  };
  const show = (k) => {
    const e = entOf();
    if (k === "entity") return e ? `${esc(e.legal_name)}${[e.city, e.country].filter(Boolean).length ? ` <span class="muted small">${esc([e.city, e.country].filter(Boolean).join(", "))}</span>` : ""}` : esc(st.entity);
    if (k === "alloc") return esc(allocText(regionList(Object.fromEntries(regionKeys().map((r) => [r, num(st.alloc[r]) ?? 0]))))) || "–";
    if (k === "via") return esc(st.via === "Other" ? st.via_other || "Other" : st.via);
    const v = k === "label" ? st.label : st[k];
    return esc(v) || "–";
  };
  const row = ([k, label]) => {
    if (k === "po" && !st.shown.has("po") && !st.po) return "";
    const isIn = st.shown.has(k);
    return `<div class="inv-sr${isIn && miss(k) ? " miss" : ""}" data-k="${k}"><dt>${esc(label)}</dt><dd>${isIn ? input(k) : show(k)}</dd></div>`;
  };

  const d = document.createElement("dialog");
  d.className = "po-dialog inv-dialog";
  d.innerHTML = `<form method="dialog">
    <h2>Request an invoice</h2>
    <p class="muted small" style="margin:0 0 10px">${esc(c.artist)}${c.song ? ` – ${esc(c.song)}` : ""}</p>
    ${openParts.length ? `<label>For <select name="plan_part" aria-label="Part of the invoice plan">${openParts.map((p) => `<option value="${esc(p.id)}"${p.id === st.partId ? " selected" : ""}>${esc(p.label || "Part")} · ${esc(money(p.amount, p.currency || cur0))}${p.due_on ? ` · ${esc(day(p.due_on))}` : ""}</option>`).join("")}<option value=""${st.partId ? "" : " selected"}>Not part of the plan</option></select></label>` : ""}
    <label>Budget <span class="inv-amt"><input name="amount" inputmode="decimal" value="${st.amount ?? ""}" required><select name="cur">${CURS.map((x) => `<option${x === st.cur ? " selected" : ""}>${x}</option>`).join("")}</select></span></label>
    ${already && budget != null ? `<p class="inv-quiet" id="inv-already">${esc(money(already, cur0))} of ${esc(money(budget, cur0))} already requested</p>` : ""}
    ${otherCur ? `<p class="inv-quiet">${otherCur} earlier request${otherCur > 1 ? "s are" : " is"} in another currency: check what's left by hand.</p>` : ""}
    <div class="inv-sum-head"><b class="small">Details for finance</b><button type="button" class="link-btn small" id="inv-edit">Edit</button></div>
    <dl class="inv-sum" id="inv-fields"></dl>
    <div class="inv-opt"><label>Client PO <span class="muted small" style="font-weight:400">if any</span><input name="client_po" autocomplete="off"></label><label>Project <span class="muted small" style="font-weight:400">if any</span><input name="project" autocomplete="off"></label></div>
    <label>Notes for finance <textarea name="notes" rows="2" placeholder="Anything finance should know"></textarea></label>
    <p class="small error" id="inv-err" hidden></p>
    <div class="actions"><button type="submit" value="ok" class="primary">Send to finance</button><button type="button" id="inv-copy">Copy as email</button><button type="submit" value="cancel" formnovalidate>Cancel</button></div>
  </form>`;
  document.body.append(d);
  const f = d.querySelector("form"), err = d.querySelector("#inv-err"), box = d.querySelector("#inv-fields");
  const fail = (m) => { err.hidden = !m; err.textContent = m ?? ""; };
  const drawFields = () => {
    box.innerHTML = FIELDS.map(row).join("");
    d.querySelector("#inv-edit").hidden = FIELDS.every(([k]) => st.shown.has(k));
    sumLine();
  };
  const sumLine = () => {
    const s = box.querySelector("#inv-alloc-sum"), amt = num(f.amount.value);
    if (s) s.textContent = sumAlloc() ? `= ${plainNum(sumAlloc())}${amt && Math.abs(sumAlloc() - amt) > 0.5 ? ` (budget is ${plainNum(amt)})` : ""}` : "";
  };
  // One listener for every field in the list (the list is redrawn when a choice changes what is known).
  const take = (el, changed) => {
    const n = el.name, k = el.dataset.alloc;
    if (k) { st.alloc[k] = el.value; st.allocTouched = true; st.touched.add("alloc"); }
    else if (n === "entity_id") {
      st.entity_id = el.value; st.touched.add("entity");
      const e = entOf(), v = viaFrom(e);
      if (!st.touched.has("via")) { st.via = v.via; st.via_other = v.other; }
      if (!st.touched.has("contact_name") && !st.touched.has("contact_email")) { const fb = fallback(); st.contact_name = fb.name; st.contact_email = fb.email; }
    } else if (n === "label" || n === "territory" || n === "responsible" || n === "contact_name" || n === "contact_email" || n === "po" || n === "entity") { st[n] = el.value; st.touched.add(n); }
    else if (n === "via") { st.via = el.value; st.touched.add("via"); }
    else if (n === "via_other") { st.via_other = el.value; st.touched.add("via"); }
    else return;
    if (changed && (n === "entity_id" || n === "via")) { drawFields(); return; }
    const kk = k ? "alloc" : n === "entity_id" ? "entity" : n === "via_other" ? "via" : n;
    box.querySelector(`[data-k="${kk}"]`)?.classList.toggle("miss", miss(kk));
    if (k) sumLine();
  };
  box.addEventListener("input", (e) => take(e.target, false));
  box.addEventListener("change", (e) => take(e.target, true));
  d.querySelector("#inv-edit").onclick = () => { FIELDS.forEach(([k]) => st.shown.add(k)); drawFields(); };
  f.amount.addEventListener("input", () => { st.amount = num(f.amount.value); if (!st.allocTouched) { autoAlloc(); drawFields(); } else sumLine(); });
  f.cur.addEventListener("change", () => { st.cur = f.cur.value; });
  drawFields();

  const asRequest = () => {
    const e = entOf();
    return { responsible: st.responsible.trim(), client_po: f.client_po.value.trim(), artist: c.artist, song: c.song, client: e?.legal_name ?? (st.entity.trim() || c.client || ""), label_type: st.label, amount: num(f.amount.value), currency: f.cur.value,
      territory: st.territory, allocation: regionList(Object.fromEntries(regionKeys().map((r) => [r, num(st.alloc[r]) ?? 0]))), project: f.project.value.trim(),
      contact_name: st.contact_name.trim(), contact_email: st.contact_email.trim(), send_via: st.via === "Other" ? st.via_other.trim() || "Other" : st.via };
  };
  d.querySelector("#inv-copy").onclick = () => copyText(emailText(asRequest()), toast, "Copied. Paste it into an email.");

  // Choosing a part fills in its amount; "Not part of the plan" goes back to the usual amount.
  f.elements.plan_part?.addEventListener("change", () => {
    const p = openParts.find((x) => x.id === f.elements.plan_part.value) ?? null;
    st.partId = p?.id ?? null;
    f.amount.value = (p ? Number(p.amount) : noPartAmount) ?? "";
    f.cur.value = p ? partCur(p) : cur0; st.cur = f.cur.value;
    st.amount = num(f.amount.value);
    if (!st.allocTouched) { autoAlloc(); drawFields(); } else sumLine();
  });

  let sending = false;
  f.onsubmit = async (e) => {
    if (e.submitter?.value !== "ok") return;
    e.preventDefault();
    const amount = num(f.amount.value);
    if (!amount || amount <= 0) { fail("Enter the amount to invoice."); return; }
    const alloc = regionList(Object.fromEntries(regionKeys().map((r) => [r, num(st.alloc[r]) ?? 0])));
    if (alloc.length && Math.abs(alloc.reduce((t, x) => t + x.amount, 0) - amount) > 0.5) { fail(`The allocation adds up to ${money(alloc.reduce((t, x) => t + x.amount, 0), f.cur.value)}, not ${money(amount, f.cur.value)}.`); return; }
    fail("");
    if (sending) return;
    const btn = f.querySelector("[value=ok]"); btn.disabled = true; sending = true;
    const ent = entOf(), x = asRequest();
    const lines = st.allocTouched ? [] : splitByMarket(mrows, regionOf, budget, amount).lines;
    const viaName = x.send_via, portal = viaName && viaName !== "E-MAIL";
    const part = openParts.find((p) => p.id === st.partId) ?? null;
    const ins = sb.from("invoice_requests").insert({
      campaign_id: c.id, amount, currency: f.cur.value, po_number: st.po.trim() || null,
      client: c.client || x.client || null, client_entity_id: ent?.id ?? null,
      invoicing_entity: ent ? ent.legal_name : (st.entity.trim() || null), lines: lines.length > 1 ? lines : [],
      uses_portal: !!portal, portal_name: portal ? viaName : null, send_via: viaName || null,
      client_po: x.client_po || null, notes: f.notes.value.trim() || null,
      responsible: x.responsible || null, artist: c.artist ?? null, song: c.song ?? null, label_type: x.label_type || null, territory: x.territory || null, project: x.project || null,
      contact_name: x.contact_name || null, contact_email: x.contact_email || null, allocation: alloc.length ? alloc : null,
    });
    const { data: made, error } = part ? await ins.select("id").single() : await ins;
    // Stays disabled after a success (the dialog closes), so a second click can't send a second request.
    if (error) { btn.disabled = false; sending = false; fail(error.message); return; }
    if (part) {
      // Tie the request to its part. If that fails (someone got there first), the new request is cancelled again.
      let link = sb.from("invoice_plan_parts").update({ request_id: made?.id }).eq("id", part.id);
      link = part.request_id ? link.eq("request_id", part.request_id) : link.is("request_id", null);
      const { data: linked, error: le } = await link.select("id");
      if (le || !linked?.length) {
        if (made?.id) await sb.from("invoice_requests").update({ status: "cancelled" }).eq("id", made.id);
        btn.disabled = false; sending = false;
        fail(`The request wasn't sent. ${le ? le.message : "Someone already requested this part."} Close this and look at the invoice plan.`);
        return;
      }
    }
    // The campaign learns what was filled in here (company, label, market, contact); it syncs to the sheet's columns.
    const learn = {};
    if (ent && !c.client_entity_id) learn.client_entity_id = ent.id;
    if (st.touched.has("label") && st.label && !c.label_type) learn.label_type = st.label;
    if (st.touched.has("territory") && st.territory && !c.client_market) learn.client_market = `Stellar ${st.territory}`;
    if (st.touched.has("contact_name") && st.contact_name.trim() && !c.client_contact_name) learn.client_contact_name = st.contact_name.trim();
    if (st.touched.has("contact_email") && st.contact_email.trim() && !c.client_contact_email) learn.client_contact_email = st.contact_email.trim();
    if (Object.keys(learn).length) await sb.from("campaigns").update(learn).eq("id", c.id);
    d.close(); d.remove(); toast(ent || st.entity.trim() ? (part ? `Invoice request sent to finance for ${part.label || "the part"}` : "Invoice request sent to finance") : "Invoice request sent. Pick the invoicing company when you know it (or send the vendor form)."); onDone?.();
  };
  d.onclose = () => d.remove();
  d.showModal();
}

// ---------- the Invoices page ----------
export async function renderInvoices(app, sb, { isCurrent, go, toast }) {
  app.innerHTML = `<p class="muted pad">Loading invoices…</p>`;
  const [who, reqRes, campRes, entRes, moneyRes] = await Promise.all([
    me(sb),
    sb.from("invoice_requests").select("*").order("requested_at", { ascending: false }),
    sb.from("campaigns").select("id,artist,song,client_market,client_id,client_entity_id"),
    sb.from("client_entities").select("id,client_id,also_clients,legal_name,vat_number,address,city,country,invoice_email,economic_numbers"),
    loadMoney(sb),
  ]);
  if (!isCurrent()) return;
  if (reqRes.error) { app.innerHTML = `<p class="error">${esc(reqRes.error.message)}</p>`; return; }
  const camps = Object.fromEntries((campRes.data ?? []).map((c) => [c.id, c]));
  const ents = entRes.data ?? [], entOf = (id) => ents.find((e) => e.id === id) ?? null;
  // Every campaign's open money flags (money.js), finance's first.
  const attention = moneyRes.campaigns.flatMap((c) => flagsFor(c, moneyRes.invoices[c.id], moneyRes.vendors[c.id], moneyRes.plans[c.id]).map((f) => ({ ...f, c })))
    .sort((a, b) => (a.who === b.who ? 0 : a.who === (who.finance ? "finance" : "dri") ? -1 : 1));
  const attentionHtml = () => !attention.length ? "" : `<details class="panel inv-att"${attention.some((a) => a.who === "finance") && who.finance ? " open" : ""}>
    <summary><b>Needs attention</b> <span class="inv-count">${attention.length}</span><span class="muted small"> · flags the OS raises by itself; they clear when the numbers line up</span></summary>
    <div class="inv-att-list">${attention.map((a) => `<a href="#/c/${esc(a.c.id)}" class="inv-att-row"><span class="mf-who ${a.who}">${a.who === "finance" ? "Finance" : "DRI"}</span><b>${esc(a.c.artist ?? "Untitled")}${a.c.song ? ` – ${esc(a.c.song)}` : ""}</b><span>${a.text}</span><span class="muted small">${esc(a.c.comms_owner ?? "")}</span></a>`).join("")}</div>
  </details>`;
  const rows = reqRes.data;
  const tabs = [["review", "To review"], ["invoiced", "Invoiced"], ["paid", "Paid"], ["mine", "My requests"], ["all", "All"]];
  const st = { tab: (() => { try { return localStorage.getItem("inv-tab") || (who.finance ? "review" : "mine"); } catch { return who.finance ? "review" : "mine"; } })(), sel: null };
  const inTab = (r) => st.tab === "review" ? ["requested", "returned"].includes(r.status) : st.tab === "invoiced" ? r.status === "invoiced" : st.tab === "paid" ? r.status === "paid"
    : st.tab === "mine" ? r.requested_by === who.email && r.status !== "cancelled" : true;
  const sum = (xs) => { const by = {}; for (const r of xs) by[r.currency] = (by[r.currency] ?? 0) + Number(r.amount); return Object.entries(by).map(([c, v]) => money(v, c)).join(" + ") || "–"; };
  const name = (r) => { const c = camps[r.campaign_id]; return c ? `${c.artist ?? "Untitled"}${c.song ? ` – ${c.song}` : ""}` : "Deleted campaign"; };

  function draw() {
    const review = rows.filter((r) => r.status === "requested"), out = rows.filter((r) => r.status === "invoiced"), late = out.filter(overdue);
    const list = rows.filter(inTab);
    if (!st.sel || !list.some((r) => r.id === st.sel)) st.sel = list[0]?.id ?? null;
    const sel = rows.find((r) => r.id === st.sel);
    app.innerHTML = `
      <div class="page-head"><div><h1>Invoices</h1>
        <p class="muted small" style="margin:6px 0 0">Requests from campaign managers → sent from e-conomic → paid by the client</p></div>
        <div class="actions" style="margin:0">${who.role === "admin" ? `<button type="button" id="inv-team">Team &amp; roles</button>` : ""}</div></div>
      <div class="an-hero inv-hero">
        <div class="an-hero-card main"><div class="l">To review</div><div class="n">${review.length}</div><div class="d">${review.length ? `${sum(review)} waiting for finance` : "Nothing waiting"}</div></div>
        <div class="an-hero-card"><div class="l">Outstanding</div><div class="n inv-n">${sum(out)}</div><div class="d">${out.length} invoice${out.length === 1 ? "" : "s"} awaiting payment</div></div>
        <div class="an-hero-card${late.length ? " inv-late" : ""}"><div class="l">Overdue</div><div class="n">${late.length}</div><div class="d">${late.length ? `${sum(late)} past the due date` : "Nothing overdue"}</div></div>
      </div>
      ${attentionHtml()}
      <div class="tabs an-tabs" role="tablist">${tabs.map(([k, l]) => `<button type="button" role="tab" data-itab="${k}" aria-selected="${st.tab === k}">${l}${k === "review" && review.length ? ` <span class="inv-count">${review.length}</span>` : ""}</button>`).join("")}</div>
      ${!list.length ? `<div class="panel" style="margin-top:18px"><p class="muted" style="margin:0">${st.tab === "review" ? "No requests waiting. Campaign managers request invoices from a campaign's page (<b>Request invoice</b>)." : "Nothing here yet."}</p></div>` : `
      <div class="inv-split">
        <div class="inv-list">${list.map((r) => `<button type="button" class="inv-item${r.id === st.sel ? " on" : ""}" data-sel="${r.id}">
            <span class="inv-item-top"><span class="muted small">${refOf(r)} · ${esc(ago(r.requested_at))}</span>${statusPill(r)}</span>
            <b>${esc(r.client || "No client")}</b><span class="inv-item-sub">${esc(name(r))}</span>
            <span class="inv-item-bot"><span class="muted small">${r.invoice_number ? `#${esc(r.invoice_number)}` : esc(r.send_via || (r.uses_portal ? "Supplier portal" : "Email"))}${r.due_date && r.status === "invoiced" ? ` · due ${esc(day(r.due_date))}` : ""}</span><b>${money(r.amount, r.currency)}</b></span>
          </button>`).join("")}</div>
        <div class="inv-detail" id="inv-detail">${sel ? detailHtml(sel) : ""}</div>
      </div>`}`;
    app.querySelectorAll("[data-itab]").forEach((b) => (b.onclick = () => { st.tab = b.dataset.itab; st.sel = null; try { localStorage.setItem("inv-tab", st.tab); } catch { /* ignore */ } draw(); }));
    app.querySelectorAll("[data-sel]").forEach((b) => (b.onclick = () => { st.sel = b.dataset.sel; draw(); if (innerWidth < 900) document.getElementById("inv-detail")?.scrollIntoView({ behavior: "smooth" }); }));
    app.querySelector("#inv-team")?.addEventListener("click", teamDialog);
    if (sel) bindDetail(sel);
  }

  function detailHtml(r) {
    const c = camps[r.campaign_id], canFin = who.finance, mine = r.requested_by === who.email;
    const field = (k, v) => (v ? `<div><dt>${k}</dt><dd>${v}</dd></div>` : "");
    const sn = splitNotes(r);
    return `<div class="inv-card">
      <div class="inv-d-head"><div><span class="muted small">${refOf(r)}</span><h2>${esc(r.client || "No client")}</h2><a href="#/c/${esc(r.campaign_id)}" class="small">${esc(name(r))}</a></div>${statusPill(r)}</div>
      <div class="inv-amount">${money(r.amount, r.currency)}</div>
      <dl class="inv-dl">
        ${(() => {
          const e = entOf(r.client_entity_id);
          if (e) return field("Invoicing company", `<a href="#/clients/co/${esc(e.id)}">${esc(e.legal_name)}</a>${(e.economic_numbers ?? []).length ? `<br><span class="muted small">e-conomic ${esc(e.economic_numbers.join(", "))}</span>` : ""}${e.vat_number ? `<br><span class="muted small">ID ${esc(e.vat_number)}</span>` : ""}${e.address ? `<br><span class="muted small">${esc(e.address)}</span>` : ""}${e.invoice_email ? `<br><span class="muted small">${esc(e.invoice_email)}</span>` : ""}`);
          const opts = ents.filter((x) => c?.client_id && (x.client_id === c.client_id || (x.also_clients ?? []).includes(c.client_id)));
          if ((canFin || mine) && r.status !== "cancelled" && opts.length) return field("Invoicing company", `<select id="inv-ent" aria-label="Invoicing company"><option value="">Pick the company${r.invoicing_entity ? ` (they wrote: ${esc(r.invoicing_entity)})` : ""}</option>${opts.map((x) => `<option value="${x.id}">${esc(x.legal_name)}${[x.city, x.country].filter(Boolean).length ? ` (${esc([x.city, x.country].filter(Boolean).join(", "))})` : ""}${(x.economic_numbers ?? []).length ? ` · e-conomic ${esc(x.economic_numbers.join(", "))}` : ""}</option>`).join("")}</select>`);
          return field("Invoicing company", r.invoicing_entity ? esc(r.invoicing_entity) : `<span class="inv-warn">Not known yet: send the vendor form from the campaign page</span>`);
        })()}
        ${field("Campaign responsible", esc(r.responsible))}
        ${field("Client PO", esc(sn.clientPo))}
        ${field("Our PO", esc(r.po_number))}
        ${field("Major / Indie / Other", esc(r.label_type))}
        ${field("Client territory", esc(r.territory || (c?.client_market ?? "").replace(/^Stellar /, "")))}
        ${field("Budget allocation", esc(allocText(r.allocation)))}
        ${field("Project", esc(r.project))}
        ${field("Client contact", [r.contact_name, r.contact_email].filter(Boolean).map(esc).join(" · "))}
        ${field("Invoice to be sent through", r.send_via ? esc(r.send_via) : r.uses_portal ? `Supplier portal${r.portal_name ? `: ${esc(r.portal_name)}` : ""}` : "Email from e-conomic")}
        ${field("Requested by", `${esc(byWho(r.requested_by))} · ${esc(day(r.requested_at))}`)}
        ${field("Invoice", r.invoice_number ? `#${esc(r.invoice_number)} · ${esc(day(r.invoice_date))}` : "")}
        ${field("Due", r.due_date && r.status !== "requested" ? `${esc(day(r.due_date))}${overdue(r) ? ' <span class="inv-pill overdue">Overdue</span>' : ""}` : "")}
        ${field("Paid", r.paid_on ? `${esc(day(r.paid_on))}${r.paid_amount != null && Number(r.paid_amount) !== Number(r.amount) ? ` · ${money(r.paid_amount, r.currency)}` : ""}` : "")}
      </dl>
      ${r.lines?.length ? `<div class="inv-d-lines"><b class="small">Invoice lines</b>${r.lines.map((l) => `<div><span>Social campaign – ${esc(c?.song ?? c?.artist ?? "")}${c?.song ? ` (${esc(c.artist)})` : ""}, ${esc(l.market)}</span><b>${money(l.amount, r.currency)}</b></div>`).join("")}</div>` : ""}
      ${sn.notes ? `<div class="inv-note"><b class="small">Notes from ${esc(byWho(r.requested_by).split("@")[0])}</b><p>${esc(sn.notes)}</p></div>` : ""}
      ${r.finance_note ? `<div class="inv-note fin"><b class="small">Finance</b><p>${esc(r.finance_note)}</p></div>` : ""}
      <div class="inv-actions">
        <div class="inv-do-row"><button type="button" class="link-btn small" id="inv-copy-email">Copy as email</button></div>
        ${canFin && r.status === "requested" ? `
          <form class="inv-do" id="inv-mark">
            <b>Sent from e-conomic?</b> <span class="muted small">Record it here once the invoice has gone out.</span>
            <div class="inv-do-row"><label>Invoice number <input name="no" required placeholder="e.g. 1184"></label>
              <label>Invoice date <input type="date" name="date" value="${today()}" required></label>
              <label>Due date <input type="date" name="due" value="${addDays(today(), 30)}" required></label></div>
            <div class="inv-do-row"><button type="submit" class="primary">Mark as invoiced</button><button type="button" id="inv-return">Send back…</button></div>
          </form>` : ""}
        ${canFin && r.status === "invoiced" ? `
          ${r.uses_portal ? `<label class="inv-check"><input type="checkbox" id="inv-portal"${r.portal_uploaded_at ? " checked" : ""}> Uploaded to ${esc(r.portal_name || "the supplier portal")}${r.portal_uploaded_at ? ` <span class="muted small">${esc(day(r.portal_uploaded_at))}</span>` : ""}</label>` : ""}
          <form class="inv-do" id="inv-paid">
            <b>Payment received?</b>
            <div class="inv-do-row"><label>Paid on <input type="date" name="date" value="${today()}" required></label>
              <label>Amount received <input name="amt" inputmode="decimal" value="${Number(r.amount)}"></label></div>
            <div class="inv-do-row"><button type="submit" class="primary">Mark as paid</button></div>
          </form>` : ""}
        ${canFin && r.status === "paid" ? `<button type="button" class="link-btn small" id="inv-unpay">Undo paid</button>` : ""}
        ${(mine || canFin) && ["requested", "returned"].includes(r.status) ? `<div class="inv-do-row">${mine && r.status === "returned" ? `<button type="button" class="primary" id="inv-resubmit">Resubmit to finance</button>` : ""}<button type="button" class="danger-lite" id="inv-cancel">Cancel request</button></div>` : ""}
        ${!canFin && r.status === "requested" ? `<p class="muted small">Waiting for finance.</p>` : ""}
      </div>
    </div>`;
  }

  async function save(r, patch, msg) {
    const { error } = await sb.from("invoice_requests").update(patch).eq("id", r.id);
    if (error) { toast(error.message); return false; }
    Object.assign(r, patch); if (msg) toast(msg); draw(); return true;
  }

  function bindDetail(r) {
    app.querySelector("#inv-copy-email")?.addEventListener("click", () => {
      const e = entOf(r.client_entity_id), sn = splitNotes(r);
      copyText(emailText({ ...r, client_po: sn.clientPo, client: e?.legal_name ?? r.invoicing_entity ?? r.client }), toast, "Copied. Paste it into an email.");
    });
    app.querySelector("#inv-ent")?.addEventListener("change", async (e) => {
      const ent = entOf(e.target.value);
      if (!ent) return;
      if (await save(r, { client_entity_id: ent.id, invoicing_entity: ent.legal_name }, `Invoicing company: ${ent.legal_name}`)) {
        const c = camps[r.campaign_id];
        if (c && !c.client_entity_id) { await sb.from("campaigns").update({ client_entity_id: ent.id }).eq("id", c.id); c.client_entity_id = ent.id; }
      }
    });
    const mark = app.querySelector("#inv-mark");
    if (mark) {
      // The due date comes from the invoice in e-conomic; it starts at 30 days after the invoice date.
      let dueTouched = false;
      mark.due.onchange = () => { dueTouched = true; };
      mark.date.onchange = () => { if (!dueTouched && mark.date.value) mark.due.value = addDays(mark.date.value, 30); };
      mark.onsubmit = (e) => { e.preventDefault(); save(r, { status: "invoiced", invoice_number: mark.no.value.trim(), invoice_date: mark.date.value, due_date: mark.due.value, invoiced_by: who.email, invoiced_at: new Date().toISOString() }, "Marked as invoiced"); };
    }
    app.querySelector("#inv-return")?.addEventListener("click", async () => {
      const note = await noteDialog("Send back to the requester", "Say what needs changing. They'll see it on the request and can resubmit.");
      if (note) save(r, { status: "returned", finance_note: note }, "Sent back");
    });
    const paid = app.querySelector("#inv-paid");
    if (paid) paid.onsubmit = (e) => { e.preventDefault(); save(r, { status: "paid", paid_on: paid.date.value, paid_amount: num(paid.amt.value), marked_paid_by: who.email }, "Marked as paid"); };
    app.querySelector("#inv-portal")?.addEventListener("change", (e) => save(r, { portal_uploaded_at: e.target.checked ? new Date().toISOString() : null }, e.target.checked ? "Marked as uploaded" : null));
    app.querySelector("#inv-unpay")?.addEventListener("click", () => save(r, { status: "invoiced", paid_on: null, paid_amount: null, marked_paid_by: null }, "Back to invoiced"));
    app.querySelector("#inv-resubmit")?.addEventListener("click", () => save(r, { status: "requested" }, "Resubmitted to finance"));
    app.querySelector("#inv-cancel")?.addEventListener("click", async () => {
      if (await confirmDialog({ title: `Cancel ${refOf(r)}?`, body: "Finance won't invoice it. You can request a new invoice from the campaign page.", confirm: "Cancel request" })) save(r, { status: "cancelled" }, "Request cancelled");
    });
  }

  function noteDialog(title, hint) {
    return new Promise((resolve) => {
      const d = document.createElement("dialog"); d.className = "po-dialog";
      d.innerHTML = `<form method="dialog"><h2>${esc(title)}</h2><p class="muted small">${esc(hint)}</p><textarea name="t" rows="4" required></textarea>
        <div class="actions"><button type="submit" value="ok" class="primary">Send back</button><button type="submit" value="cancel" formnovalidate>Cancel</button></div></form>`;
      document.body.append(d);
      d.onclose = () => { const v = d.returnValue === "ok" ? d.querySelector("textarea").value.trim() : ""; d.remove(); resolve(v || null); };
      d.showModal();
    });
  }

  async function teamDialog() {
    const { data: team } = await sb.from("team_members").select("email,name,role").order("name");
    const d = document.createElement("dialog"); d.className = "po-dialog inv-team";
    const roleSel = (v, email) => `<select data-role="${esc(email)}">${[["member", "Campaign manager"], ["finance", "Finance"], ["admin", "Admin"]].map(([k, l]) => `<option value="${k}"${k === v ? " selected" : ""}>${l}</option>`).join("")}</select>`;
    d.innerHTML = `<form method="dialog"><h2>Team &amp; roles</h2>
      <p class="muted small">Finance and admins handle invoices. Campaign managers request them. Only people on this list can sign in.</p>
      <div class="inv-team-list">${(team ?? []).map((t) => `<div><span><b>${esc(t.name ?? t.email)}</b><span class="muted small">${esc(t.email)}</span></span>${roleSel(t.role, t.email)}</div>`).join("")}</div>
      <h3 style="margin:18px 0 6px">Add someone</h3>
      <div class="inv-do-row"><input name="name" placeholder="Name"><input name="email" type="email" placeholder="name@stellarmusic.dk">${roleSel("member", "")}<button type="button" id="tm-add">Add</button></div>
      <p class="small" id="tm-msg"></p>
      <div class="actions"><button type="submit" value="done" class="primary">Done</button></div></form>`;
    document.body.append(d);
    const msg = d.querySelector("#tm-msg");
    const set = async (email, name, role) => {
      const { error } = await sb.rpc("set_team_member", { p_email: email, p_name: name, p_role: role });
      msg.textContent = error ? error.message : "Saved"; msg.className = `small ${error ? "error" : "muted"}`;
      return !error;
    };
    d.querySelectorAll(".inv-team-list [data-role]").forEach((s) => (s.onchange = () => set(s.dataset.role, null, s.value)));
    d.querySelector("#tm-add").onclick = async () => {
      const f = d.querySelector("form"), email = f.email.value.trim().toLowerCase();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { msg.textContent = "Enter a valid email"; msg.className = "small error"; return; }
      if (await set(email, f.name.value.trim(), d.querySelector('select[data-role=""]').value)) { d.close(); teamDialog(); }
    };
    d.onclose = () => d.remove();
    d.showModal();
  }

  draw();
}
