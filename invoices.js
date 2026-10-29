// Invoicing: campaign managers request an invoice from the campaign page; finance works through the
// requests here, sends the invoice from e-conomic and records it; payment is recorded when the label pays.
// Statuses: requested → invoiced → paid (or returned to the requester / cancelled).
import { confirmDialog } from "./dialog.js?v=20261029c";

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

// ---------- the request form (from a campaign page) ----------
export async function requestInvoiceDialog(sb, c, { toast, onDone }) {
  if (c.invoicing_entity === undefined) {
    const { data } = await sb.from("campaigns").select("invoicing_entity,client").eq("id", c.id).maybeSingle();
    c = { ...c, invoicing_entity: data?.invoicing_entity ?? null, client: c.client ?? data?.client };
  }
  const [mk, open] = await Promise.all([
    sb.from("campaign_markets").select("market,share_percent,amount").eq("campaign_id", c.id),
    sb.from("invoice_requests").select("amount,status").eq("campaign_id", c.id).in("status", ["requested", "returned", "invoiced", "paid"]),
  ]);
  const already = (open.data ?? []).reduce((t, r) => t + Number(r.amount), 0);
  const budget = c.budget != null ? Number(c.budget) : null;
  const left = budget != null ? Math.max(0, budget - already) : null;
  const lines = (mk.data ?? []).map((m) => ({ market: m.market, amount: m.amount != null ? Number(m.amount) : budget != null && m.share_percent != null ? Math.round(budget * m.share_percent) / 100 : null }));
  const d = document.createElement("dialog");
  d.className = "po-dialog inv-dialog";
  d.innerHTML = `<form method="dialog">
    <h2>Request an invoice</h2>
    <p class="muted small" style="margin:0 0 6px">${esc(c.artist)}${c.song ? ` – ${esc(c.song)}` : ""}. Finance gets it in their review queue and sends the invoice from e-conomic.</p>
    ${already ? `<p class="small inv-warn">${money(already, c.currency)} of this campaign's ${money(budget, c.currency)} budget is already requested or invoiced.</p>` : ""}
    <div class="inv-form">
      <label>Client <input name="client" value="${esc(c.client ?? "")}" required></label>
      <label>Invoicing entity <input name="entity" value="${esc(c.invoicing_entity ?? "")}" placeholder="Company name on the invoice"></label>
      <label>PO number <input name="po" value="${esc(c.po_number ?? "")}" placeholder="If the client gave one"></label>
      <label>Amount <span class="inv-amt"><input name="amount" inputmode="decimal" value="${left ?? ""}" required><select name="cur">${["USD", "EUR", "GBP", "DKK", "SEK", "JPY", "AUD", "SGD", "BRL", "MXN"].map((x) => `<option${x === (c.currency || "USD") ? " selected" : ""}>${x}</option>`).join("")}</select></span></label>
      <label class="inv-check"><input type="checkbox" name="portal"> The client uses its own supplier portal</label>
      <label class="inv-portal" hidden>Portal <input name="portalname" placeholder="e.g. Uniport (Universal), Coupa, Ariba"></label>
    </div>
    ${lines.length > 1 ? `<div class="inv-lines"><b class="small">Split by market</b> <span class="muted small">one line per market on the invoice</span>
      ${lines.map((l, i) => `<div class="inv-line"><span>${esc(l.market)}</span><input data-line="${i}" inputmode="decimal" value="${l.amount ?? ""}" aria-label="${esc(l.market)} amount"></div>`).join("")}</div>` : ""}
    <label>Notes for finance <textarea name="notes" rows="3" placeholder="Anything finance should know: billing contact, deposit, special wording…"></textarea></label>
    <p class="small error" id="inv-err" hidden></p>
    <div class="actions"><button type="submit" value="ok" class="primary">Send to finance</button><button type="submit" value="cancel" formnovalidate>Cancel</button></div>
  </form>`;
  document.body.append(d);
  const f = d.querySelector("form"), err = d.querySelector("#inv-err");
  f.portal.onchange = () => { d.querySelector(".inv-portal").hidden = !f.portal.checked; };
  f.onsubmit = async (e) => {
    if (e.submitter?.value !== "ok") return;
    e.preventDefault();
    const amount = num(f.amount.value);
    if (!amount || amount <= 0) { err.hidden = false; err.textContent = "Enter the amount to invoice."; return; }
    const ls = lines.map((l, i) => ({ market: l.market, amount: num(d.querySelector(`[data-line="${i}"]`)?.value) })).filter((l) => l.amount);
    if (ls.length > 1 && Math.abs(ls.reduce((t, l) => t + l.amount, 0) - amount) > 0.5) { err.hidden = false; err.textContent = `The market lines add up to ${money(ls.reduce((t, l) => t + l.amount, 0), f.cur.value)}, not ${money(amount, f.cur.value)}.`; return; }
    const btn = f.querySelector("[value=ok]"); btn.disabled = true;
    const { error } = await sb.from("invoice_requests").insert({
      campaign_id: c.id, amount, currency: f.cur.value, po_number: f.po.value.trim() || null,
      client: f.client.value.trim() || null, invoicing_entity: f.entity.value.trim() || null, lines: ls.length > 1 ? ls : [],
      uses_portal: f.portal.checked, portal_name: f.portal.checked ? f.portalname.value.trim() || null : null, notes: f.notes.value.trim() || null,
    });
    btn.disabled = false;
    if (error) { err.hidden = false; err.textContent = error.message; return; }
    d.close(); d.remove(); toast("Invoice request sent to finance"); onDone?.();
  };
  d.onclose = () => d.remove();
  d.showModal();
}

// ---------- the Invoices page ----------
export async function renderInvoices(app, sb, { isCurrent, go, toast }) {
  app.innerHTML = `<p class="muted pad">Loading invoices…</p>`;
  const [who, reqRes, campRes] = await Promise.all([
    me(sb),
    sb.from("invoice_requests").select("*").order("requested_at", { ascending: false }),
    sb.from("campaigns").select("id,artist,song,client_market"),
  ]);
  if (!isCurrent()) return;
  if (reqRes.error) { app.innerHTML = `<p class="error">${esc(reqRes.error.message)}</p>`; return; }
  const camps = Object.fromEntries((campRes.data ?? []).map((c) => [c.id, c]));
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
      <div class="tabs an-tabs" role="tablist">${tabs.map(([k, l]) => `<button type="button" role="tab" data-itab="${k}" aria-selected="${st.tab === k}">${l}${k === "review" && review.length ? ` <span class="inv-count">${review.length}</span>` : ""}</button>`).join("")}</div>
      ${!list.length ? `<div class="panel" style="margin-top:18px"><p class="muted" style="margin:0">${st.tab === "review" ? "No requests waiting. Campaign managers request invoices from a campaign's page (<b>Request invoice</b>)." : "Nothing here yet."}</p></div>` : `
      <div class="inv-split">
        <div class="inv-list">${list.map((r) => `<button type="button" class="inv-item${r.id === st.sel ? " on" : ""}" data-sel="${r.id}">
            <span class="inv-item-top"><span class="muted small">${refOf(r)} · ${esc(ago(r.requested_at))}</span>${statusPill(r)}</span>
            <b>${esc(r.client || "No client")}</b><span class="inv-item-sub">${esc(name(r))}</span>
            <span class="inv-item-bot"><span class="muted small">${r.invoice_number ? `#${esc(r.invoice_number)}` : r.uses_portal ? "Supplier portal" : "Email"}${r.due_date && r.status === "invoiced" ? ` · due ${esc(day(r.due_date))}` : ""}</span><b>${money(r.amount, r.currency)}</b></span>
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
    return `<div class="inv-card">
      <div class="inv-d-head"><div><span class="muted small">${refOf(r)}</span><h2>${esc(r.client || "No client")}</h2><a href="#/c/${esc(r.campaign_id)}" class="small">${esc(name(r))}</a></div>${statusPill(r)}</div>
      <div class="inv-amount">${money(r.amount, r.currency)}</div>
      <dl class="inv-dl">
        ${field("Invoicing entity", esc(r.invoicing_entity))}
        ${field("PO number", esc(r.po_number))}
        ${field("Client market", esc((c?.client_market ?? "").replace(/^Stellar /, "")))}
        ${field("Delivery", r.uses_portal ? `Supplier portal${r.portal_name ? `: ${esc(r.portal_name)}` : ""}` : "Email from e-conomic")}
        ${field("Requested by", `${esc(r.requested_by)} · ${esc(day(r.requested_at))}`)}
        ${field("Invoice", r.invoice_number ? `#${esc(r.invoice_number)} · ${esc(day(r.invoice_date))}` : "")}
        ${field("Due", r.due_date && r.status !== "requested" ? `${esc(day(r.due_date))}${overdue(r) ? ' <span class="inv-pill overdue">Overdue</span>' : ""}` : "")}
        ${field("Paid", r.paid_on ? `${esc(day(r.paid_on))}${r.paid_amount != null && Number(r.paid_amount) !== Number(r.amount) ? ` · ${money(r.paid_amount, r.currency)}` : ""}` : "")}
      </dl>
      ${r.lines?.length ? `<div class="inv-d-lines"><b class="small">Invoice lines</b>${r.lines.map((l) => `<div><span>Social campaign – ${esc(c?.song ?? c?.artist ?? "")}${c?.song ? ` (${esc(c.artist)})` : ""}, ${esc(l.market)}</span><b>${money(l.amount, r.currency)}</b></div>`).join("")}</div>` : ""}
      ${r.notes ? `<div class="inv-note"><b class="small">Notes from ${esc(r.requested_by.split("@")[0])}</b><p>${esc(r.notes)}</p></div>` : ""}
      ${r.finance_note ? `<div class="inv-note fin"><b class="small">Finance</b><p>${esc(r.finance_note)}</p></div>` : ""}
      <div class="inv-actions">
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
