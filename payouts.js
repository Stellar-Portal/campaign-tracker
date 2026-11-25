// Payouts: the PayPal payout sheet, built into each campaign (team only; clients never see it).
// "Pay with PayPal" sends the ticked "Posted · to pay" creators as one PayPal batch through the paypal-payouts function;
// every payment carries the campaign's PO number, and payout_payments keeps where each one stands.
import { confirmDialog } from "./dialog.js?v=20261125a";
// A campaign has sections (a set of deliverables, e.g. "20x Edits" at $50 each) and one row per creator:
// who sources and pays them, videos, price, status (contacted → waiting for draft → drafted →
// waiting to post → posted (to pay) → paid) and their posting progress, read from the tracker's posts.
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const nf = new Intl.NumberFormat("en", { maximumFractionDigits: 2 });
const money = (v, cur) => {
  if (v == null || Number.isNaN(v)) return "–";
  try { return new Intl.NumberFormat("en", { style: "currency", currency: cur || "USD", minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(v); }
  catch { return `${nf.format(v)} ${cur ?? ""}`.trim(); }
};
const num = (v) => { const t = String(v ?? "").replace(/[^0-9.,-]/g, "").replace(/,(?=\d{3}\b)/g, "").replace(",", "."); const x = parseFloat(t); return Number.isFinite(x) ? x : null; };
const today = () => new Date().toISOString().slice(0, 10);
// A one-time link a creator uses to fill in their payment details; saved on their roster card.
export async function copyDetailsLink(sb, creatorId, toast) {
  const { data, error } = await sb.rpc("make_creator_details_link", { p_creator: creatorId });
  if (error || !data) return toast?.(error?.message ?? "Couldn't make the link");
  const url = `${location.origin}${location.pathname.replace(/[^/]*$/, "")}payment-details.html#t=${data}`;
  try { await navigator.clipboard.writeText(url); toast?.("Link copied. Send it to the creator: it works once, for 30 days."); }
  catch { toast?.(url); }
}
const SEND_ICON = `<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3 10h11M10 5l5 5-5 5"/></svg>`;
const dayLabel = (d) => (d ? new Date(`${d}T00:00:00`).toLocaleDateString("en-GB", { day: "numeric", month: "short" }) : "");
const handleKey = (h) => String(h ?? "").trim().replace(/^@/, "").replace(/^https?:\/\/(www\.)?tiktok\.com\/@/i, "").split(/[/?]/)[0].toLowerCase();

export const STATUS = [
  ["contacted", "Contacted"],
  ["waiting_draft", "Waiting for draft"],
  ["drafted", "Drafted"],
  ["waiting_payment", "Waiting to post"],   // the stored key predates the rename; the step is "waiting to post"
  ["posted", "Posted · to pay"],
  ["paid", "Paid"],
];
const statusName = (s) => (STATUS.find(([k]) => k === s) ?? [s, s])[1];
const VIA = [["paypal", "PayPal"], ["wise", "Wise"], ["bank", "Bank"]];
const rowTotal = (r) => (r.amount != null ? Number(r.amount) : r.price_per_video != null ? Number(r.price_per_video) * (r.videos ?? 0) : 0);
const EARLY = ["contacted", "waiting_draft", "drafted"];
// How alike two handles are: 0 (nothing) to 1 (same). Catches "@alfiann" vs "@alfiann1920".
function likeness(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.length >= 4 && b.length >= 4 && (a.startsWith(b) || b.startsWith(a))) return 0.9;
  if (a.length >= 5 && b.length >= 5 && (a.includes(b) || b.includes(a))) return 0.8;
  const m = a.length, n = b.length, d = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 1; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return 1 - d[m][n] / Math.max(m, n);
}
// "Ana, Sam & Dan" → ["Ana", "Sam", "Dan"]
export const splitPeople = (v) => String(v ?? "").split(/\s*(?:,|&|\+|\/|\band\b)\s*/i).map((x) => x.trim()).filter(Boolean);

// ---------- the Payouts tab on a campaign ----------
export async function renderCampaignPayouts(el, sb, { campaign, toast, isCurrent }) {
  el.innerHTML = `<p class="muted">Loading payouts…</p>`;
  const cid = campaign.id, cur = campaign.currency || "USD";
  const [secRes, rowRes, postRes, campRes, teamRes, payRes, invRes, ppRes] = await Promise.all([
    sb.from("payout_sections").select("*").eq("campaign_id", cid).order("position").order("created_at"),
    sb.from("payout_rows").select("*").eq("campaign_id", cid).order("position").order("created_at"),
    sb.from("posts").select("creator_id,status,creator:creators(id,username,display_name,avatar_url,follower_count,platform)").eq("campaign_id", cid),
    sb.from("campaigns").select("budget,spend_cap_percent,campaign_runner,comms_owner,po_number,artist,song").eq("id", cid).maybeSingle(),
    sb.from("team_members").select("name"),
    sb.from("payout_payments").select("*").eq("campaign_id", cid).order("created_at", { ascending: false }),
    sb.from("invoice_requests").select("ref,invoice_number,status,amount,currency").eq("campaign_id", cid).neq("status", "cancelled").order("requested_at"),
    sb.functions.invoke("paypal-payouts", { body: { action: "check", campaign_id: cid } }).catch(() => ({ data: null })),
  ]);
  const me = (await sb.auth.getSession()).data.session?.user?.email ?? null;
  if (!isCurrent()) return;
  const err = secRes.error ?? rowRes.error ?? campRes.error;
  if (err) { el.innerHTML = `<p class="error">${esc(err.message)}</p>`; return; }
  const sections = secRes.data, rows = rowRes.data;
  let payments = payRes.data ?? [];
  const invoices = invRes.data ?? [];
  const pp = ppRes?.data && !ppRes.data.error ? ppRes.data : { mode: "off", ready: false, allowed: false };
  const camp = campRes.data ?? {};
  // Payment details saved on these creators' roster cards (filled in once, used for every campaign).
  const creatorPay = new Map();
  { const ids = [...new Set(rows.map((r) => r.creator_id).filter(Boolean))];
    if (ids.length) { const { data } = await sb.from("creators").select("id,paypal_email,payout_method,wise_email").in("id", ids); for (const c of data ?? []) creatorPay.set(c.id, c); } }
  const budget = campRes.data?.budget != null ? Number(campRes.data.budget) : null;
  let capPct = Number(campRes.data?.spend_cap_percent ?? 30);
  // Who can source and pay creators here: the people running this campaign (and its DRI).
  const runners = [...new Set([...splitPeople(campRes.data?.campaign_runner), ...splitPeople(campRes.data?.comms_owner)])];
  const everyone = [...new Set((teamRes.data ?? []).map((t) => t.name).filter((x) => x && x !== "Admin"))].sort();
  const people = runners.length ? runners : everyone;

  // Creators with videos in this campaign, and how many each has posted.
  const creators = new Map();
  for (const p of postRes.data ?? []) {
    if (!p.creator || p.status === "removed") continue;
    const id = p.creator.id ?? `u:${handleKey(p.creator.username)}`;
    const c = creators.get(id) ?? { ...p.creator, id, key: handleKey(p.creator.username), posts: 0 };
    c.posts++; creators.set(id, c);
  }
  const byHandle = new Map([...creators.values()].map((c) => [c.key, c]));
  const creatorOf = (r) => (r.creator_id && creators.get(r.creator_id)) || byHandle.get(handleKey(r.handle)) || null;
  const postedOf = (r) => creatorOf(r)?.posts ?? 0;
  const isDone = (r) => r.posted_manual || ((r.videos ?? 0) > 0 && postedOf(r) >= r.videos);
  const st = { filter: "all", confirm: null, dismissed: new Set(), adding: null, sel: new Set() };

  // ---------- PayPal ----------
  // The newest PayPal payment for a row decides what its "Paid" cell shows.
  const WAITING = ["queued", "pending", "unclaimed", "onhold"];
  const lastPayment = (r) => payments.find((p) => p.row_id === r.id) ?? null;
  const onTheWay = (r) => { const p = lastPayment(r); return !!p && (WAITING.includes(p.status) || p.status === "success"); };
  const payable = (r) => r.status === "posted" && rowTotal(r) > 0 && !onTheWay(r);
  // The roster card wins (it's what the creator last told us), then whatever was used on this sheet before.
  const emailOf = (r) => (r.creator_id && creatorPay.get(r.creator_id)?.paypal_email) || r.paypal_email || "";
  const PAY_LABEL = { queued: "Sending to PayPal…", pending: "Sending to PayPal…", unclaimed: "Waiting for them to claim it", onhold: "On hold at PayPal",
    success: "Paid through PayPal", failed: "PayPal payment failed", returned: "Money came back", blocked: "Blocked by PayPal", refunded: "Refunded",
    reversed: "Reversed", denied: "Refused by PayPal", canceled: "Taken back" };
  const payLabel = (s, p) => (s === "queued" && p?.error ? "Check PayPal first" : PAY_LABEL[s] ?? s);
  const payTone = (s, p) => (s === "success" ? "good" : s === "queued" && p?.error ? "bad" : WAITING.includes(s) ? "wait" : "bad");

  // Keep each row in step with the tracker: link exact handle matches, and move the status along
  // as videos come in (or back, if a video is removed).
  async function sync() {
    const link = rows.filter((r) => !r.creator_id && byHandle.get(handleKey(r.handle)) && !String(byHandle.get(handleKey(r.handle)).id).startsWith("u:"));
    for (const r of link) { const c = byHandle.get(handleKey(r.handle)); r.creator_id = c.id; await sb.from("payout_rows").update({ creator_id: c.id }).eq("id", r.id); }
    const toPosted = rows.filter((r) => isDone(r) && [...EARLY, "waiting_payment"].includes(r.status));
    const toWaiting = rows.filter((r) => !isDone(r) && ((postedOf(r) > 0 && EARLY.includes(r.status)) || r.status === "posted"));
    if (toPosted.length && !(await sb.from("payout_rows").update({ status: "posted" }).in("id", toPosted.map((r) => r.id))).error) toPosted.forEach((r) => (r.status = "posted"));
    if (toWaiting.length && !(await sb.from("payout_rows").update({ status: "waiting_payment" }).in("id", toWaiting.map((r) => r.id))).error) toWaiting.forEach((r) => (r.status = "waiting_payment"));
  }
  await sync();

  const spent = () => rows.reduce((s, r) => s + rowTotal(r), 0);
  const visible = (r) => st.filter === "all" || (st.filter === "topay" && r.status === "posted") || (st.filter === "draft" && ["contacted", "waiting_draft"].includes(r.status))
    || (st.filter === "notposted" && !isDone(r) && r.status !== "paid");

  async function save(table, id, patch) {
    const { error } = await sb.from(table).update(patch).eq("id", id);
    if (error) toast(`Couldn't save: ${error.message}`);
    return !error;
  }

  // Suggestions: a row whose handle doesn't match anyone in the tracker, but someone's is close.
  function suggestions() {
    const linked = new Set(rows.map((r) => r.creator_id).filter(Boolean));
    const free = [...creators.values()].filter((c) => !linked.has(c.id));
    const out = [];
    for (const r of rows) {
      if (creatorOf(r) || st.dismissed.has(r.id)) continue;
      const k = handleKey(r.handle);
      const best = free.map((c) => ({ c, s: likeness(k, c.key) })).filter((x) => x.s >= 0.6).sort((a, b) => b.s - a.s)[0];
      if (best) out.push({ r, c: best.c });
    }
    return out;
  }
  function suggestHtml() {
    const sg = suggestions();
    if (!sg.length) return "";
    return `<div class="po-suggest" role="status">
      <b>Match creators to their videos</b>
      ${sg.map(({ r, c }) => `<div class="po-sg">
        <span>${esc(r.handle)} on the sheet looks like <b>@${esc(c.username)}</b>${c.display_name ? ` <span class="muted">(${esc(c.display_name)})</span>` : ""}, who has ${c.posts} video${c.posts === 1 ? "" : "s"} in this campaign.</span>
        <span class="po-sg-act"><button type="button" class="primary small-btn" data-sglink="${r.id}" data-c="${c.id}">Same person</button><button type="button" class="link-btn" data-sgno="${r.id}">Not them</button></span>
      </div>`).join("")}
    </div>`;
  }

  // The only budget on this tab: the creator budget, a share of what's invoiced (30% by default).
  // What isn't spent on creators stays with Stellar, so the margin is the invoiced budget minus creator costs.
  const creatorBudget = () => (budget != null ? budget * capPct / 100 : null);
  function summaryHtml() {
    const s = spent(), cap = creatorBudget();
    const toPay = rows.filter((r) => r.status === "posted");
    const left = cap != null ? cap - s : null;
    const margin = budget != null ? budget - s : null;
    return `
      <div class="po2-main"><div class="n">${cap != null ? money(cap, cur) : "–"}</div>
        <div class="l">Creator budget · <label class="po-cap"><input type="number" id="po-cap" min="0" max="100" step="1" value="${capPct}" aria-label="Creator budget, percent of the invoiced budget">%</label> of ${money(budget, cur)} invoiced</div></div>
      <div class="po2-cost"><div class="n">${money(s, cur)}</div><div class="l">Creator costs${budget ? ` · ${Math.round((s / budget) * 100)}% of budget` : ""}</div></div>
      <div class="${left != null && left < 0 ? "po2-over" : ""}"><div class="n">${left != null ? money(Math.abs(left), cur) : "–"}</div><div class="l">${left != null && left < 0 ? "Over the creator budget" : "Left to spend"}</div></div>
      <div><div class="n">${money(toPay.reduce((a, r) => a + rowTotal(r), 0), cur)}</div><div class="l">To pay · ${toPay.length} creator${toPay.length === 1 ? "" : "s"}</div></div>
      <div class="po2-margin"><div class="n">${margin != null ? money(margin, cur) : "–"}</div><div class="l">Margin${budget ? ` · ${Math.round((margin / budget) * 100)}%` : ""}</div></div>
      ${cap != null ? `<span class="po2-bar" aria-hidden="true"><i style="width:${Math.min(100, (s / (cap || 1)) * 100)}%"></i></span>` : ""}`;
  }

  const whoOptions = (v) => {
    const list = v && !people.includes(v) ? [...people, v] : people;
    return `<option value="">Who?</option>${list.map((p) => `<option${p === v ? " selected" : ""}>${esc(p)}</option>`).join("")}`;
  };
  function progressHtml(r) {
    const posted = postedOf(r), need = r.videos ?? 0;
    if (r.posted_manual) return `<span class="po-prog done" title="Marked as posted">✓ Posted</span> <button type="button" class="link-btn small" data-unmanual="${r.id}">Undo</button>`;
    const pctDone = need ? Math.min(100, (posted / need) * 100) : 0;
    return `<span class="po-prog${need && posted >= need ? " done" : ""}" title="Videos by this creator tracked in this campaign">
        <span class="po-prog-n">${posted}/${need || "–"}</span><span class="po-prog-bar"><i style="width:${pctDone}%"></i></span></span>
      ${need && posted < need ? `<button type="button" class="link-btn small po-manual" data-manual="${r.id}" title="They posted somewhere the tracker doesn't follow">Mark posted</button>` : ""}`;
  }
  // "Paid" cell: a tick box to pick the creator for PayPal, or where their PayPal payment stands.
  function paidCell(r) {
    const p = lastPayment(r);
    if (p && (WAITING.includes(p.status) || (p.status === "success" && r.status !== "paid"))) {
      return `<span class="pp-st ${payTone(p.status, p)}" title="${esc(`${money(Number(p.amount), p.currency)} to ${p.recipient}${p.error ? ` · ${p.error}` : ""}`)}">${esc(payLabel(p.status, p))}</span>`
        + (p.status === "unclaimed" && pp.allowed ? ` <button type="button" class="link-btn small" data-ppcancel="${p.id}">Take back</button>` : "");
    }
    if (!payable(r)) return null;
    const failed = p && !WAITING.includes(p.status) && p.status !== "success";
    return `<label class="pp-pick"><input type="checkbox" data-ppsel="${r.id}"${st.sel.has(r.id) ? " checked" : ""}> <span>Pay</span></label>`
      + (failed ? ` <span class="pp-st bad" title="${esc(p.error ?? "")}">${esc(payLabel(p.status))}</span>` : "");
  }
  function rowHtml(r) {
    const total = rowTotal(r), c = creatorOf(r);
    return `<tr data-row="${r.id}" class="po-st-${r.status}">
      <td class="po-who">
        <span class="po-av">${c?.avatar_url ? `<img src="${esc(c.avatar_url)}" alt="" referrerpolicy="no-referrer" data-fail="remove">` : ""}<span>${esc((handleKey(r.handle) || "?").charAt(0).toUpperCase())}</span></span>
        <input class="po-in po-handle" data-f="handle" value="${esc(r.handle)}" aria-label="Creator handle">
        ${c ? `<span class="po-ok" title="Matched to @${esc(c.username)}'s videos in this campaign">✓</span>` : ""}
        <a class="po-open" href="https://www.tiktok.com/@${esc(handleKey(r.handle))}" target="_blank" rel="noopener" title="Open profile" aria-label="Open ${esc(r.handle)}'s profile">↗</a></td>
      <td><select class="po-in po-who-sel" data-f="handled_by" aria-label="Sourced and paid by">${whoOptions(r.handled_by)}</select></td>
      <td class="num"><input class="po-in num" data-f="videos" inputmode="numeric" value="${r.videos ?? ""}" placeholder="–" aria-label="Videos"></td>
      <td class="num"><input class="po-in num" data-f="price_per_video" inputmode="decimal" value="${r.price_per_video != null ? nf.format(r.price_per_video) : ""}" placeholder="–" aria-label="Price per video"></td>
      <td class="num"><input class="po-in num po-total po-cost" data-f="amount" inputmode="decimal" value="${total ? nf.format(total) : ""}" placeholder="–" aria-label="Total"></td>
      <td><select class="po-status s-${r.status}" data-f="status" aria-label="Status">${STATUS.map(([k, l]) => `<option value="${k}"${k === r.status ? " selected" : ""}>${l}</option>`).join("")}</select></td>
      <td class="po-posted">${progressHtml(r)}</td>
      <td class="po-paid">${paidCell(r) ?? (r.status === "paid" ? `<select class="po-via" data-f="paid_via" aria-label="Paid via">${VIA.map(([k, l]) => `<option value="${k}"${k === (r.paid_via ?? "paypal") ? " selected" : ""}>${l}</option>`).join("")}</select><span class="muted small">${esc(dayLabel(r.paid_on))}</span>` : `<span class="muted">–</span>`)}</td>
      <td><input class="po-in" data-f="notes" value="${esc(r.notes ?? "")}" placeholder="" aria-label="Notes"></td>
      <td class="po-x"><button type="button" class="link-btn" data-del="${r.id}" aria-label="Remove ${esc(r.handle)}">${st.confirm === r.id ? "Remove?" : "×"}</button></td>
    </tr>`;
  }

  function addRowHtml(secId) {
    const open = st.adding === (secId ?? "");
    return `<tr class="po-addrow"><td colspan="10">
      ${open ? `<form class="po-add" data-addto="${secId ?? ""}">
          <input name="h" list="po-known" placeholder="@handle or TikTok profile link" aria-label="Creator to add" autocomplete="off">
          <button type="submit" class="primary">Add creator</button>
          <button type="button" class="link-btn" data-addcancel>Cancel</button>
          <span class="po-add-msg muted small" aria-live="polite">We check the account exists, so it matches their videos later.</span>
        </form>`
      : `<button type="button" class="po-addbtn" data-addopen="${secId ?? ""}"><span>+</span> Add creator</button>`}
    </td></tr>`;
  }

  function sectionHtml(s) {
    const mine = rows.filter((r) => (r.section_id ?? null) === (s?.id ?? null));
    const shown = mine.filter(visible);
    const sp = mine.reduce((a, r) => a + rowTotal(r), 0);
    const vids = mine.reduce((a, r) => a + (r.videos ?? 0), 0), posted = mine.reduce((a, r) => a + Math.min(postedOf(r), r.videos ?? 0), 0);
    return `<section class="po-sec" data-sec="${s?.id ?? ""}">
      <div class="po-sec-head">
        ${s ? `<input class="po-sec-name" data-sf="name" value="${esc(s.name)}" aria-label="Section name">` : `<h3>${sections.length ? "Not in a section" : "Creators"}</h3>`}
        <div class="po-sec-sum">
          <span>${mine.length} creator${mine.length === 1 ? "" : "s"}</span>
          ${vids ? `<span>${posted}/${vids} videos posted</span>` : ""}
          <span class="po-cost"><b>${money(sp, cur)}</b></span>
          ${s ? `<button type="button" class="link-btn muted" data-delsec="${s.id}">${st.confirm === s.id ? "Delete section?" : "Delete"}</button>` : ""}
        </div>
      </div>
      <div class="po-tablewrap"><table class="po-table">
        <colgroup><col class="c-who"><col class="c-by"><col class="c-n"><col class="c-m"><col class="c-m"><col class="c-st"><col class="c-p"><col class="c-paid"><col class="c-notes"><col class="c-x"></colgroup>
        <thead><tr><th>Creator</th><th>Sourced &amp; paid by</th><th class="num">Videos</th><th class="num">Per video</th><th class="num">Total</th><th>Status</th><th>Posting</th><th>Paid</th><th>Notes</th><th></th></tr></thead>
        <tbody>${shown.map(rowHtml).join("") || (mine.length ? `<tr class="po-empty"><td colspan="10" class="muted small">No creators match this filter.</td></tr>` : "")}${addRowHtml(s?.id ?? null)}</tbody>
      </table></div>
    </section>`;
  }

  function draw() {
    const hasLoose = rows.some((r) => !r.section_id) || !sections.length;
    const known = [...creators.values()].filter((c) => !rows.some((r) => creatorOf(r)?.id === c.id));
    el.innerHTML = `
      <div class="po2-sum" id="po-sum">${summaryHtml()}</div>
      <div id="po-suggest">${suggestHtml()}</div>
      <div class="po2-tools">
        <div class="po2-filter" role="tablist" aria-label="Show">
          ${[["all", "All creators"], ["topay", "To pay"], ["draft", "Waiting for draft"], ["notposted", "Not posted yet"]].map(([k, l]) => `<button type="button" role="tab" data-filter="${k}" aria-selected="${st.filter === k}">${l}</button>`).join("")}
        </div>
        <span class="po-tools-r">
          ${rows.some(payable) ? `<button type="button" class="primary small-btn pp-btn" id="pp-open">${SEND_ICON}Pay with PayPal${st.sel.size ? ` · ${st.sel.size}` : ""}</button>` : ""}
          <button type="button" class="link-btn" id="po-paste">Paste from sheet</button>
          <button type="button" class="link-btn" id="po-newsec">+ New section</button>
        </span>
      </div>
      <datalist id="po-known">${known.map((c) => `<option value="@${esc(c.username)}">${esc(c.display_name ?? "")} · ${c.posts} video${c.posts === 1 ? "" : "s"} in this campaign</option>`).join("")}</datalist>
      ${!rows.length && !sections.length ? emptyGuide(cur) : `${sections.map(sectionHtml).join("")}
      ${hasLoose ? sectionHtml(null) : ""}`}
      <p class="muted small po-note">Clients never see payouts. Fill in any two of videos, price per video and total, and the third is worked out. "Posting" counts the creator's videos in the tracker; when all their videos are up they move to "Posted · to pay" by themselves.${runners.length ? "" : " Tip: set who runs this campaign (Edit campaign) to shorten the \"Sourced & paid by\" list."}</p>
      ${historyHtml()}`;
    bind();
    el.querySelector("#po-start")?.addEventListener("click", () => el.querySelector("#po-newsec").click());
    el.querySelector("#po-start-paste")?.addEventListener("click", () => el.querySelector("#po-paste").click());
    el.querySelector(".po-add input")?.focus();
  }
  const refreshSummary = () => { const s = el.querySelector("#po-sum"); if (s) { s.innerHTML = summaryHtml(); bindCap(); } };
  function refreshSection(secId) {
    const box = el.querySelector(`.po-sec[data-sec="${secId ?? ""}"]`);
    const s = sections.find((x) => x.id === secId) ?? null;
    if (!box) return;
    const tmp = document.createElement("div"); tmp.innerHTML = sectionHtml(s);
    box.querySelector(".po-sec-sum").innerHTML = tmp.querySelector(".po-sec-sum").innerHTML;
    bindSectionButtons(box);
  }

  function bindCap() {
    const c = el.querySelector("#po-cap");
    if (c) c.onchange = async () => {
      const v = Math.min(100, Math.max(0, num(c.value) ?? 30));
      if (await save("campaigns", cid, { spend_cap_percent: v })) { capPct = v; draw(); }
    };
  }
  function bindSectionButtons(box) {
    box.querySelectorAll("[data-delsec]").forEach((b) => (b.onclick = async () => {
      const id = b.dataset.delsec;
      if (st.confirm !== id) { st.confirm = id; b.textContent = "Delete section?"; return; }
      const { error } = await sb.from("payout_sections").delete().eq("id", id);
      if (error) return toast(error.message);
      sections.splice(sections.findIndex((x) => x.id === id), 1);
      rows.forEach((r) => { if (r.section_id === id) r.section_id = null; });
      st.confirm = null; draw();
    }));
  }

  // Find the real account behind what was typed: a creator already in this campaign, one already
  // known to the OS, or (costs a few ScrapeCreators credits) a fresh look-up on TikTok.
  async function resolveCreator(raw) {
    const k = handleKey(raw);
    if (byHandle.get(k)) return byHandle.get(k);
    const { data: known } = await sb.from("creators").select("id,username,display_name,avatar_url").eq("platform", "tiktok").ilike("username", k).maybeSingle();
    if (known) return known;
    const { data, error } = await sb.functions.invoke("roster", { body: { action: "lookup", input: /^https?:/i.test(raw.trim()) ? raw.trim() : `@${k}`, platform: "tiktok" } });
    if (error || data?.error) throw new Error(data?.error ?? "Couldn't check that account right now");
    return data;
  }
  async function addCreator(form, secId, force = false) {
    const inp = form.h, msg = form.querySelector(".po-add-msg"), btn = form.querySelector("[type=submit]");
    const h = handleKey(inp.value);
    if (!h) return inp.focus();
    btn.disabled = true; msg.className = "po-add-msg muted small"; msg.textContent = force ? "Adding…" : `Checking @${h}…`;
    let c = null;
    if (!force) {
      try { c = await resolveCreator(inp.value); }
      catch (e) {
        btn.disabled = false; msg.className = "po-add-msg small bad";
        msg.innerHTML = `${esc(e.message)}. <button type="button" class="link-btn" data-force>Add @${esc(h)} anyway</button>`;
        msg.querySelector("[data-force]").onclick = () => addCreator(form, secId, true);
        return;
      }
    }
    const last = rows.filter((r) => (r.section_id ?? null) === secId).at(-1);
    const { data, error } = await sb.from("payout_rows").insert({
      campaign_id: cid, section_id: secId, handle: `@${c ? handleKey(c.username) : h}`, creator_id: c?.id ?? null,
      handled_by: last?.handled_by ?? (people.length === 1 ? people[0] : null),
      price_per_video: last?.price_per_video ?? null, videos: null, amount: null,
      position: rows.length, created_by: me ?? null,
    }).select().single();
    btn.disabled = false;
    if (error) { msg.textContent = error.message; return; }
    if (data.amount != null && !(await withinBudget(rowTotal(data)))) { await sb.from("payout_rows").delete().eq("id", data.id); return; }
    if (c && !creators.has(c.id)) { /* known account, no videos yet */ }
    rows.push(data); await sync(); draw();
    toast(c ? `Added @${handleKey(c.username)}${c.display_name ? ` (${c.display_name})` : ""}` : `Added @${h}`);
  }

  function bind() {
    bindCap();
    el.querySelector("#pp-open")?.addEventListener("click", () => payDialog());
    el.querySelectorAll("[data-ppcancel]").forEach((b) => (b.onclick = () => takeBack(b.dataset.ppcancel)));
    el.querySelectorAll("[data-filter]").forEach((b) => (b.onclick = () => { st.filter = b.dataset.filter; draw(); }));
    el.querySelector("#po-newsec").onclick = async () => {
      const { data, error } = await sb.from("payout_sections").insert({ campaign_id: cid, name: "New section", deliverable: "video", position: sections.length }).select().single();
      if (error) return toast(error.message);
      sections.push(data); draw();
      el.querySelector(`.po-sec[data-sec="${data.id}"] .po-sec-name`)?.select();
    };
    el.querySelector("#po-paste").onclick = () => pasteDialog();
    el.querySelectorAll("[data-sglink]").forEach((b) => (b.onclick = async () => {
      const r = rows.find((x) => x.id === b.dataset.sglink), c = creators.get(b.dataset.c);
      const patch = { creator_id: c.id, handle: `@${handleKey(c.username)}` }, was = r.creator_id;
      if (await save("payout_rows", r.id, patch)) {
        Object.assign(r, patch);
        // The card the sheet made for the misspelt handle folds into the right creator (details and all).
        if (was && was !== c.id) await sb.rpc("merge_creators", { p_from: was, p_into: c.id });   // refused (fine) if that card has real numbers
        await sync(); toast(`Matched to @${c.username}`); draw();
      }
    }));
    el.querySelectorAll("[data-sgno]").forEach((b) => (b.onclick = () => { st.dismissed.add(b.dataset.sgno); el.querySelector("#po-suggest").innerHTML = suggestHtml(); bind(); }));
    el.querySelectorAll(".po-sec").forEach((box) => {
      const secId = box.dataset.sec || null;
      bindSectionButtons(box);
      box.querySelectorAll("[data-sf]").forEach((inp) => (inp.onchange = async () => {
        const s = sections.find((x) => x.id === secId);
        const v = inp.value.trim() || "Untitled section";
        if (await save("payout_sections", secId, { name: v })) { s.name = v; refreshSection(secId); }
      }));
      box.querySelector("[data-addopen]")?.addEventListener("click", () => { st.adding = secId ?? ""; draw(); });
      box.querySelector("[data-addcancel]")?.addEventListener("click", () => { st.adding = null; draw(); });
      const form = box.querySelector(".po-add");
      if (form) {
        form.onsubmit = (e) => { e.preventDefault(); addCreator(form, secId); };
        form.h.onkeydown = (e) => { if (e.key === "Escape") { st.adding = null; draw(); } };
      }
    });
    el.querySelectorAll("tr[data-row]").forEach((tr) => bindRow(tr, rows.find((x) => x.id === tr.dataset.row)));
  }
  function bindRow(tr, r) {
    tr.querySelectorAll("[data-f]").forEach((inp) => (inp.onchange = () => editRow(r, inp, tr)));
    tr.querySelector("[data-ppsel]")?.addEventListener("change", (e) => {
      if (e.target.checked) st.sel.add(r.id); else st.sel.delete(r.id);
      const b = el.querySelector("#pp-open"); if (b) b.innerHTML = `${SEND_ICON}Pay with PayPal${st.sel.size ? ` · ${st.sel.size}` : ""}`;
    });
    tr.querySelector("[data-ppcancel]")?.addEventListener("click", (e) => takeBack(e.currentTarget.dataset.ppcancel));
    tr.querySelector("[data-manual]")?.addEventListener("click", () => setManual(r, tr, true));
    tr.querySelector("[data-unmanual]")?.addEventListener("click", () => setManual(r, tr, false));
    tr.querySelector("[data-del]").onclick = async (e) => {
      if (st.confirm !== r.id) { st.confirm = r.id; e.currentTarget.textContent = "Remove?"; return; }
      const { error } = await sb.from("payout_rows").delete().eq("id", r.id);
      if (error) return toast(error.message);
      rows.splice(rows.indexOf(r), 1); st.confirm = null; draw();
    };
  }
  async function setManual(r, tr, on) {
    if (!(await save("payout_rows", r.id, { posted_manual: on }))) return;
    r.posted_manual = on; await sync(); refreshRow(tr, r); refreshSummary(); refreshSection(r.section_id ?? null);
  }

  // Creator spend may never go over the creator budget (raise the % above if a campaign needs more).
  async function withinBudget(extra = 0) {
    const cap = creatorBudget();
    if (cap == null) return true;
    const after = spent() + extra;
    if (after <= cap + 0.005) return true;
    toast(`That would take creator costs to ${money(after, cur)}, over the creator budget of ${money(cap, cur)}. Raise the % if this campaign needs more.`);
    return false;
  }

  // Videos × price = total. Whichever two were filled in last decide the third.
  const MONEY_FIELDS = ["videos", "price_per_video", "amount"];
  const has = (r, f) => r[f] != null && r[f] !== "";
  function orderOf(r) {
    if (!r._order) r._order = has(r, "videos") && has(r, "price_per_video") ? ["price_per_video", "videos", "amount"] : has(r, "amount") && has(r, "videos") ? ["amount", "videos", "price_per_video"] : ["price_per_video", "videos", "amount"];
    return r._order;
  }
  function solve(r, f) {
    const order = [f, ...orderOf(r).filter((x) => x !== f)];
    r._order = order;
    const [a, b, target] = order;
    const out = {};
    if (!has(r, a) || !has(r, b)) return out;
    const v = Number(r.videos), p = Number(r.price_per_video), t = Number(r.amount);
    if (target === "amount") out.amount = Math.round(v * p * 100) / 100;
    if (target === "price_per_video" && v > 0) out.price_per_video = Math.round((t / v) * 100) / 100;
    if (target === "videos" && p > 0) out.videos = Math.max(0, Math.round(t / p));
    return out;
  }

  async function editRow(r, inp, tr) {
    const f = inp.dataset.f;
    const before = rowTotal(r), prev = { ...r };
    const patch = {};
    if (f === "status") {
      patch.status = inp.value;
      if (inp.value === "paid") { patch.paid_on = r.paid_on ?? today(); patch.paid_via = r.paid_via ?? "paypal"; }
      else { patch.paid_on = null; patch.paid_via = null; }
    } else if (f === "paid_via") patch.paid_via = inp.value;
    else if (f === "handle") {
      const h = handleKey(inp.value); if (!h) { inp.value = r.handle; return; }
      patch.handle = `@${h}`; patch.creator_id = byHandle.get(h)?.id ?? null;
    }
    else if (f === "handled_by" || f === "notes") patch[f] = inp.value.trim() || null;
    else if (MONEY_FIELDS.includes(f)) {
      const v = num(inp.value);
      patch[f] = f === "videos" && v != null ? Math.max(0, Math.round(v)) : v;
      Object.assign(r, patch);
      Object.assign(patch, solve(r, f));
    }
    Object.assign(r, patch);
    if (rowTotal(r) > before && !(await withinBudget(0))) { Object.assign(r, prev); refreshRow(tr, r); return; }
    if (!(await save("payout_rows", r.id, patch))) { Object.assign(r, prev); refreshRow(tr, r); return; }
    if (["videos", "handle"].includes(f) || "videos" in patch) await sync();
    if (st.filter !== "all" && !visible(r)) { draw(); return; }
    if (f === "handle") { draw(); return; }
    refreshRow(tr, r, f);
    refreshSummary(); refreshSection(r.section_id ?? null);
  }
  function refreshRow(tr, r, focusField) {
    const tmp = document.createElement("tbody"); tmp.innerHTML = rowHtml(r);
    const fresh = tmp.firstElementChild; tr.replaceWith(fresh);
    bindRow(fresh, r);
    // Keep the keyboard where it was (e.g. tabbing from videos to price).
    if (focusField && document.activeElement === document.body) fresh.querySelector(`[data-f="${focusField}"]`)?.closest("td")?.nextElementSibling?.querySelector("input,select")?.focus();
  }

  // ---------- PayPal: history, review-and-send, status checks ----------
  function historyHtml() {
    if (!payments.length) return "";
    return `<section class="pp-hist"><h3>PayPal payments</h3>
      <div class="po-tablewrap"><table class="pp-table"><thead><tr><th>Sent</th><th>Creator</th><th>PayPal email</th><th class="num">Amount</th><th>Status</th><th>PO</th><th>Sent by</th></tr></thead>
      <tbody>${payments.map((p) => `<tr>
        <td>${esc(new Date(p.created_at).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }))}</td>
        <td><b>${esc(p.handle ?? "")}</b></td><td class="muted">${esc(p.recipient)}</td>
        <td class="num">${money(Number(p.amount), p.currency)}</td>
        <td><span class="pp-st ${payTone(p.status, p)}"${p.error ? ` title="${esc(p.error)}"` : ""}>${esc(payLabel(p.status, p))}</span>${p.env === "sandbox" ? ' <span class="pp-test">Test</span>' : ""}</td>
        <td>${esc(p.po_number)}</td><td class="muted">${esc(p.sent_by)}</td></tr>`).join("")}</tbody></table></div></section>`;
  }
  async function reloadPayments() {
    const [{ data: ps }, { data: rs }] = await Promise.all([
      sb.from("payout_payments").select("*").eq("campaign_id", cid).order("created_at", { ascending: false }),
      sb.from("payout_rows").select("id,status,paid_on,paid_via,paypal_email").eq("campaign_id", cid),
    ]);
    if (!isCurrent() || !el.isConnected) return false;
    payments = ps ?? payments;
    for (const x of rs ?? []) { const r = rows.find((y) => y.id === x.id); if (r) Object.assign(r, x); }
    for (const id of [...st.sel]) { const r = rows.find((y) => y.id === id); if (!r || !payable(r)) st.sel.delete(id); }
    draw();
    return true;
  }
  // While payments are on their way, ask PayPal every 20 seconds (only while this tab is open).
  let polling = false;
  async function poll() {
    if (polling) return;
    polling = true;
    while (payments.some((p) => ["queued", "pending"].includes(p.status))) {
      await new Promise((res) => setTimeout(res, 20000));
      if (!isCurrent() || !el.isConnected) break;
      await sb.functions.invoke("paypal-payouts", { body: { action: "sync", campaign_id: cid } }).catch(() => null);
      if (!(await reloadPayments())) break;
    }
    polling = false;
  }
  async function takeBack(id) {
    const p = payments.find((x) => x.id === id);
    if (!p) return;
    const ans = await confirmDialog({ title: `Take back ${money(Number(p.amount), p.currency)} from ${p.handle ?? p.recipient}?`,
      body: "They haven't claimed it yet. PayPal returns the money to Stellar's account and the creator moves back to \"Posted · to pay\", so you can pay them again (e.g. to the right email).", confirm: "Take it back" });
    if (!ans) return;
    const { data, error } = await sb.functions.invoke("paypal-payouts", { body: { action: "cancel", payment_id: id } });
    if (error || data?.error) return toast(data?.error ?? "Couldn't reach PayPal. Try again.");
    toast("Taken back. The money is on its way back to Stellar's PayPal.");
    reloadPayments();
  }
  function payDialog() {
    const cand = rows.filter(payable);
    if (!cand.length) return toast("Nobody is waiting to be paid.");
    const picked = new Set(st.sel.size ? [...st.sel] : cand.map((r) => r.id));
    const po = String(camp.po_number ?? "").trim();
    const cap = creatorBudget();
    const note = `Stellar · PO ${po || "–"} · ${camp.artist ?? ""}${camp.song ? ` – ${camp.song}` : ""}`;
    const blockers = [];
    if (pp.mode === "off") blockers.push("Paying through PayPal isn't switched on yet. Sam switches it on after the test round.");
    else if (!pp.ready) blockers.push("The PayPal keys for this mode are missing in Supabase.");
    if (pp.allowed === false) blockers.push(`Only the people running this campaign${runners.length ? ` (${esc(runners.join(", "))})` : ""} or an admin can send payments.`);
    if (!po) blockers.push("This campaign has no PO number yet. Add it with Edit campaign: every payment carries it.");
    const d = document.createElement("dialog");
    d.className = "po-dialog pp-dialog";
    d.innerHTML = `<form method="dialog">
      <h2>Pay with PayPal</h2>
      ${pp.mode === "sandbox" ? `<p class="pp-mode test">Test mode: this uses PayPal's test money. Nobody really gets paid.</p>` : pp.mode === "live" ? `<p class="pp-mode live">This sends real money from Stellar's PayPal account.</p>` : ""}
      ${blockers.map((b) => `<p class="pp-block">${b}</p>`).join("")}
      <div class="pp-list">
        <div class="pp-li pp-head"><span></span><span>Creator</span><span>PayPal email</span><span class="num">Amount</span></div>
        ${cand.map((r) => `<label class="pp-li" data-r="${r.id}">
          <input type="checkbox" name="pick" value="${r.id}"${picked.has(r.id) ? " checked" : ""} aria-label="Pay ${esc(r.handle)}">
          <span class="pp-h"><b>${esc(r.handle)}</b>${r.videos ? ` <span class="muted small">${r.videos} video${r.videos === 1 ? "" : "s"}</span>` : ""}
            ${creatorPay.get(r.creator_id)?.payout_method === "wise" ? `<br><span class="small pp-warn">Prefers Wise${creatorPay.get(r.creator_id)?.wise_email ? `: ${esc(creatorPay.get(r.creator_id).wise_email)}` : ""}</span>` : ""}
            ${!emailOf(r) && r.creator_id ? `<br><button type="button" class="link-btn small" data-pplink="${r.creator_id}">Copy a link for them to fill in</button>` : ""}</span>
          <input type="email" class="pp-email" name="email-${r.id}" value="${esc(emailOf(r))}" placeholder="their PayPal email" autocomplete="off" aria-label="${esc(r.handle)}'s PayPal email">
          <span class="num pp-amt">${money(rowTotal(r), cur)}</span></label>`).join("")}
      </div>
      <div class="pp-facts">
        <div><span class="muted">Note on each payment</span><b>${esc(note)}</b></div>
        <div><span class="muted">Paid from the budget of</span><b>${invoices.length ? invoices.map((i) => esc(i.invoice_number ? `Invoice ${i.invoice_number}` : `Invoice request #${i.ref}`) + ` <span class="muted small">(${esc(i.status)})</span>`).join(", ") : `<span class="pp-warn">No invoice requested for this campaign yet</span>`}</b></div>
        ${cap != null ? `<div><span class="muted">Creator budget left</span><b id="pp-left"></b></div>` : ""}
      </div>
      <p class="small bad" id="pp-err" role="alert"></p>
      <div class="actions"><button type="button" class="primary" id="pp-send" disabled>Send</button><button type="submit" value="cancel">Cancel</button></div>
    </form>`;
    document.body.append(d);
    const f = d.querySelector("form"), btn = d.querySelector("#pp-send"), errEl = d.querySelector("#pp-err");
    const EMAIL = /^[^\s@<>()",;]+@[^\s@<>()",;]+\.[a-z]{2,}$/i;
    const chosen = () => cand.filter((r) => f.querySelector(`[name=pick][value="${r.id}"]`).checked);
    const refresh = () => {
      const ch = chosen(), tot = ch.reduce((a, r) => a + rowTotal(r), 0);
      const missing = ch.filter((r) => !EMAIL.test(f[`email-${r.id}`].value.trim()));
      cand.forEach((r) => f[`email-${r.id}`].classList.toggle("bad-in", f.querySelector(`[name=pick][value="${r.id}"]`).checked && !EMAIL.test(f[`email-${r.id}`].value.trim())));
      // Paying doesn't add spend (it's already on the sheet); this shows what's left once these leave.
      const left = d.querySelector("#pp-left"); if (left) left.textContent = money(cap - spent(), cur);
      btn.disabled = !!blockers.length || !ch.length || !!missing.length;
      btn.textContent = ch.length ? `Send ${money(tot, cur)} to ${ch.length} creator${ch.length === 1 ? "" : "s"}` : "Send";
      errEl.textContent = missing.length ? `Add a PayPal email for ${missing.map((r) => r.handle).join(", ")}.` : "";
    };
    f.addEventListener("input", refresh); f.addEventListener("change", refresh); refresh();
    d.querySelectorAll("[data-pplink]").forEach((b) => (b.onclick = (e) => { e.preventDefault(); copyDetailsLink(sb, b.dataset.pplink, toast); }));
    d.addEventListener("click", (e) => { if (e.target === d) d.close(); });
    d.onclose = () => d.remove();
    btn.onclick = async () => {
      const ch = chosen();
      btn.disabled = true; btn.textContent = "Sending…"; errEl.textContent = "";
      const items = ch.map((r) => ({ row_id: r.id, email: f[`email-${r.id}`].value.trim() }));
      const { data, error } = await sb.functions.invoke("paypal-payouts", { body: { action: "send", campaign_id: cid, items } });
      if (error || data?.error) {
        let msg = data?.error;
        if (!msg && error?.context?.json) msg = (await error.context.json().catch(() => ({}))).error;
        errEl.textContent = msg ?? "Couldn't reach PayPal. Nothing was sent; try again.";
        btn.disabled = false; btn.textContent = "Try again";
        reloadPayments();
        return;
      }
      d.close();
      for (const it of items) { const r = rows.find((x) => x.id === it.row_id); if (r) r.paypal_email = it.email; st.sel.delete(it.row_id); }
      toast(data?.note ?? `Sent to PayPal: ${ch.length} payment${ch.length === 1 ? "" : "s"}. Creators show as Paid once PayPal confirms.`);
      await reloadPayments(); poll();
    };
    d.showModal();
    (blockers.length ? d.querySelector("[type=submit]") : cand.map((r) => f[`email-${r.id}`]).find((i) => !i.value) ?? btn).focus();
  }

  // Paste rows copied from the Google payout sheet (one creator per line, columns in the sheet's order).
  function pasteDialog() {
    const d = document.createElement("dialog");
    d.className = "po-dialog";
    d.innerHTML = `<form method="dialog">
      <h2>Paste from the payout sheet</h2>
      <p class="muted small">In the Google sheet, select a section's creator rows (from the handle column to the notes column) and copy them. Columns: creator, sourced &amp; paid by, amount per video, amount in total, no. of videos, money sent, posted, notes (c, wd, wp, drafted).</p>
      <label>Section <select name="sec">${sections.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join("")}<option value="__new">New section…</option><option value="">Not in a section</option></select></label>
      <label class="po-newname">Section name <input name="newname" placeholder="e.g. 20x Edits"></label>
      <label>Rows <textarea name="t" rows="8" placeholder="Paste here"></textarea></label>
      <p class="small" id="po-prev"></p>
      <div class="actions"><button type="submit" value="ok" class="primary" id="po-go" disabled>Add creators</button><button type="submit" value="cancel">Cancel</button></div>
    </form>`;
    document.body.append(d);
    const f = d.querySelector("form"), prev = d.querySelector("#po-prev"), go = d.querySelector("#po-go"), nn = d.querySelector(".po-newname");
    const syncSec = () => { nn.hidden = f.sec.value !== "__new"; };
    if (!sections.length) f.sec.value = "__new";
    syncSec(); f.sec.onchange = syncSec;
    let parsed = [];
    f.t.oninput = () => {
      parsed = parseSheet(f.t.value);
      const tot = parsed.reduce((a, r) => a + (r.amount ?? 0), 0);
      prev.textContent = parsed.length ? `${parsed.length} creator${parsed.length === 1 ? "" : "s"} · ${money(tot, cur)} in total` : f.t.value.trim() ? "No creator rows found." : "";
      go.disabled = !parsed.length;
    };
    d.onclose = async () => {
      const ok = d.returnValue === "ok" && parsed.length;
      const secVal = f.sec.value, name = f.newname.value.trim();
      d.remove();
      if (!ok) return;
      let secId = secVal || null;
      if (secVal === "__new") {
        const { data, error } = await sb.from("payout_sections").insert({ campaign_id: cid, name: name || "Imported", position: sections.length }).select().single();
        if (error) return toast(error.message);
        sections.push(data); secId = data.id;
      }
      const add = parsed.reduce((a, r) => a + (r.amount ?? 0), 0);
      if (creatorBudget() != null && spent() + add > creatorBudget() + 0.005) { toast(`These rows add ${money(add, cur)} and would take creator costs over the creator budget of ${money(creatorBudget(), cur)}. Raise the % first if this campaign needs more.`); draw(); return; }
      const ins = parsed.map((r, i) => ({ ...r, campaign_id: cid, section_id: secId, position: rows.length + i, created_by: me ?? null }));
      const { data, error } = await sb.from("payout_rows").insert(ins).select();
      if (error) return toast(error.message);
      rows.push(...data); await sync(); toast(`Added ${data.length} creators`); draw();
    };
    d.showModal();
    f.t.focus();
  }

  draw();
  poll();
}

// What an empty campaign shows: how to start, and an example of a filled-in payout sheet.
function emptyGuide(cur) {
  const ex = [
    ["@likekyuuna_s", "Nana", 1, 400, "Waiting for draft", "waiting_draft", "0/1", ""],
    ["@rubyra6", "Nana", 1, 200, "Posted · to pay", "posted", "✓ 1/1", ""],
    ["@atdpark", "Nana", 1, 70, "Paid", "paid", "✓ 1/1", "PayPal · 18 Oct"],
    ["@gabisthatyouu", "Dan", 1, 200, "Contacted", "contacted", "0/1", ""],
  ];
  return `<section class="po-empty-guide">
    <h2 style="margin:0 0 6px">No payout sheet for this campaign yet</h2>
    <p class="muted" style="margin:0 0 14px">It replaces this campaign's tab in the PayPal Payout Sheet. Two ways to start:</p>
    <ol class="po-steps">
      <li><b>Create a section</b> for each set of deliverables, e.g. "20x Edits", then add creators one by one with their @handle or profile link.</li>
      <li><b>Or paste from the sheet</b>: in the Google sheet, select a section's creator rows (from the handle to the notes column), copy, and paste them here.</li>
    </ol>
    <div class="actions" style="margin:12px 0 22px"><button type="button" class="primary" id="po-start">Create a section</button><button type="button" id="po-start-paste">Paste from sheet</button></div>
    <div class="po-example" aria-label="Example">
      <div class="po-sec-head"><span class="badge">Example</span><h3>7–10x FOM Challenge</h3>
        <div class="po-sec-sum"><span>4 creators</span><span><b>${money(870, cur)}</b></span></div></div>
      <div class="table-wrap"><table class="po-table po-table-ex">
        <thead><tr><th>Creator</th><th>Sourced &amp; paid by</th><th class="num">Videos</th><th class="num">Total</th><th>Status</th><th>Posted</th><th>Paid</th></tr></thead>
        <tbody>${ex.map(([h, by, v, t, sl, sk, p, paid]) => `<tr><td><b>${h}</b></td><td>${by}</td><td class="num">${v}</td><td class="num"><b>${money(t, cur)}</b></td>
          <td><span class="po-status s-${sk} po-pill">${sl}</span></td><td><span class="po-count${p.startsWith("✓") ? " ok" : ""}">${p}</span></td><td class="muted small">${paid || "–"}</td></tr>`).join("")}</tbody>
      </table></div>
    </div>
  </section>`;
}

// Parse lines copied from Google Sheets (tab-separated): handle, who, per video, total, videos, sent, posted, note.
export function parseSheet(text) {
  const out = [];
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const c = line.split("\t").map((x) => x.trim());
    const h = handleKey(c[0]);
    if (!h || /^(expenses|campaign bud|revenue|margin|total)/i.test(c[0]) || /^https?:/i.test(c[0]) || h.includes(" ")) continue;
    const per = num(c[2]), tot = num(c[3]), vids = num(c[4]);
    const sent = /^(true|yes|y|x|✓|☑)$/i.test(c[5] ?? ""), posted = /^(true|yes|y|x|✓|☑)$/i.test(c[6] ?? "");
    const note = (c[7] ?? "").trim();
    const code = note.toLowerCase();
    let status = code === "c" || code === "contacted" ? "contacted" : code === "wd" ? "waiting_draft" : code === "wp" ? "waiting_payment" : /^draft/.test(code) ? "drafted" : "contacted";
    if (posted && status !== "paid") status = "posted";
    if (sent) status = "paid";
    const videos = vids != null ? Math.round(vids) : 1;
    out.push({
      handle: `@${h}`, handled_by: c[1] || null, videos,
      price_per_video: per, amount: tot ?? (per != null ? per * videos : null),
      status, posted_manual: posted, paid_on: sent ? today() : null, paid_via: sent ? "paypal" : null,
      notes: ["c", "wd", "wp", "drafted", "drafrted", "contacted"].includes(code) ? null : note || null,
    });
  }
  return out;
}

// ---------- the Payouts page (sidebar): what to pay across campaigns ----------
export async function renderPayoutsHome(app, sb, { isCurrent, go }) {
  app.innerHTML = `<p class="muted pad">Loading payouts…</p>`;
  const [rowRes, campRes, secRes, payRes, batchRes] = await Promise.all([
    sb.from("payout_rows").select("id,campaign_id,section_id,handle,handled_by,videos,price_per_video,amount,status,paid_on"),
    sb.from("campaign_summary").select("id,artist,song,budget,currency,status,po_number"),
    sb.from("payout_sections").select("id,name"),
    sb.from("payout_payments").select("id,batch_id,campaign_id,handle,recipient,amount,currency,po_number,status,error,env,sent_by,created_at").order("created_at", { ascending: false }).limit(1000),
    sb.from("payout_batches").select("id,invoices"),
  ]);
  if (!isCurrent()) return;
  const err = rowRes.error ?? campRes.error;
  if (err) { app.innerHTML = `<p class="error">${esc(err.message)}</p>`; return; }
  const { data: caps } = await sb.from("campaigns").select("id,spend_cap_percent,client_market");
  if (!isCurrent()) return;
  const capOf = Object.fromEntries((caps ?? []).map((c) => [c.id, c]));
  const camps = Object.fromEntries(campRes.data.map((c) => [c.id, c]));
  const secName = Object.fromEntries((secRes.data ?? []).map((s) => [s.id, s.name]));
  const rows = rowRes.data;
  const people = [...new Set(rows.map((r) => r.handled_by).filter(Boolean))].sort();
  const st = { who: (() => { try { return localStorage.getItem("po-who") ?? ""; } catch { return ""; } })(), q: "" };
  const payments = payRes.data ?? [];
  const invOf = Object.fromEntries((batchRes.data ?? []).map((b) => [b.id, (b.invoices ?? []).map((i) => (i.invoice_number ? `Invoice ${i.invoice_number}` : `Request #${i.ref}`)).join(", ")]));
  const PAY_LABEL = { queued: "Sending…", pending: "Sending…", unclaimed: "Waiting for them to claim it", onhold: "On hold", success: "Paid", failed: "Failed", returned: "Money came back",
    blocked: "Blocked", refunded: "Refunded", reversed: "Reversed", denied: "Refused", canceled: "Taken back" };
  const tone = (x, p) => (x === "success" ? "good" : x === "queued" && p?.error ? "bad" : ["queued", "pending", "unclaimed", "onhold"].includes(x) ? "wait" : "bad");
  if (st.who && !people.includes(st.who)) st.who = "";

  const draw = () => {
    const mine = rows.filter((r) => !st.who || r.handled_by === st.who);
    const toPay = mine.filter((r) => r.status === "posted").sort((a, b) => (camps[a.campaign_id]?.artist ?? "").localeCompare(camps[b.campaign_id]?.artist ?? ""));
    const byCamp = new Map();
    for (const r of mine) { const a = byCamp.get(r.campaign_id) ?? []; a.push(r); byCamp.set(r.campaign_id, a); }
    const cur = (cid) => camps[cid]?.currency || "USD";
    const totalsByCur = {};
    for (const r of toPay) totalsByCur[cur(r.campaign_id)] = (totalsByCur[cur(r.campaign_id)] ?? 0) + rowTotal(r);
    app.innerHTML = `
      <div class="page-head"><div><h1>Payouts</h1>
        <p class="muted small" style="margin:6px 0 0">Creator payouts across campaigns. Each campaign's payout sheet is under its Payouts tab.</p></div></div>
      <div class="filters">
        <select id="po-who" style="width:auto" aria-label="Sourced and paid by"><option value="">Everyone</option>${people.map((p) => `<option${p === st.who ? " selected" : ""}>${esc(p)}</option>`).join("")}</select>
      </div>
      <section class="panel" style="margin-bottom:20px">
        <div class="page-head" style="margin-bottom:8px"><h2 style="margin:0">To pay</h2>
          <span class="muted">${Object.entries(totalsByCur).map(([c, v]) => money(v, c)).join(" + ") || "Nothing waiting"}</span></div>
        ${toPay.length ? `<div class="table-wrap"><table>
          <thead><tr><th>Creator</th><th>Campaign</th><th>Section</th><th>Paid by</th><th class="num">Videos</th><th class="num">Amount</th></tr></thead>
          <tbody>${toPay.map((r) => `<tr class="row-link" data-go="#/c/${r.campaign_id}/payouts">
            <td><b>${esc(r.handle)}</b></td><td>${esc(camps[r.campaign_id]?.artist ?? "")} <span class="muted">${esc(camps[r.campaign_id]?.song ?? "")}</span></td>
            <td class="muted">${esc(secName[r.section_id] ?? "")}</td><td>${esc(r.handled_by ?? "")}</td><td class="num">${r.videos ?? ""}</td><td class="num">${money(rowTotal(r), cur(r.campaign_id))}</td></tr>`).join("")}</tbody></table></div>`
          : `<p class="muted" style="margin:0">Nobody has finished posting and is waiting to be paid${st.who ? ` for ${esc(st.who)}` : ""}.</p>`}
      </section>
      ${paymentsHtml()}
      <section class="panel">
        <h2>Campaigns</h2>
        ${byCamp.size ? `<div class="table-wrap"><table>
          <thead><tr><th>Campaign</th><th>Region</th><th class="num">Creators</th><th class="num">Paid</th><th class="num">Creator spend</th><th class="num">Budget</th><th class="num">Spend vs cap</th></tr></thead>
          <tbody>${[...byCamp.entries()].sort((a, b) => (camps[a[0]]?.artist ?? "").localeCompare(camps[b[0]]?.artist ?? "")).map(([cid, rs]) => {
            const c = camps[cid] ?? {}, sp = rs.reduce((a, r) => a + rowTotal(r), 0), cap = capOf[cid]?.spend_cap_percent ?? 30;
            const pct = c.budget ? Math.round((sp / c.budget) * 100) : null;
            return `<tr class="row-link" data-go="#/c/${cid}/payouts">
              <td><b>${esc(c.artist ?? "")}</b> <span class="muted">${esc(c.song ?? "")}</span></td>
              <td class="muted">${esc((capOf[cid]?.client_market ?? "").replace(/^Stellar /, ""))}</td>
              <td class="num">${rs.length}</td><td class="num">${rs.filter((r) => r.status === "paid").length}</td>
              <td class="num">${money(sp, c.currency)}</td><td class="num">${money(c.budget, c.currency)}</td>
              <td class="num">${pct != null ? `<span class="po-pct ${pct > cap ? "bad" : "good"}">${pct}% / ${cap}%</span>` : "–"}</td></tr>`;
          }).join("")}</tbody></table></div>` : `<p class="muted" style="margin:0">No payout sheets yet. Open a campaign and use its Payouts tab.</p>`}
      </section>`;
    const q = app.querySelector("#pp-q");
    if (q) q.oninput = () => { st.q = q.value; const box = app.querySelector("#pp-rows"); if (box) { box.innerHTML = payRows(); bindGo(box); } };
    app.querySelector("#po-who").onchange = (e) => { st.who = e.target.value; try { localStorage.setItem("po-who", st.who); } catch { /* ignore */ } draw(); };
    bindGo(app);
  };
  const bindGo = (root) => root.querySelectorAll("[data-go]").forEach((tr) => (tr.onclick = () => go(tr.dataset.go)));
  // Every PayPal payment, with the PO and the invoice(s) whose budget it comes out of.
  function payRows() {
    const q = st.q.trim().toLowerCase();
    const list = payments.filter((p) => !q || [p.handle, p.recipient, p.po_number, camps[p.campaign_id]?.artist, camps[p.campaign_id]?.song, invOf[p.batch_id]].some((v) => String(v ?? "").toLowerCase().includes(q)));
    if (!list.length) return `<tr><td colspan="8" class="muted">No payments match.</td></tr>`;
    return list.map((p) => { const c = camps[p.campaign_id] ?? {}; return `<tr class="row-link" data-go="#/c/${p.campaign_id}/payouts">
      <td>${esc(new Date(p.created_at).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }))}</td>
      <td><b>${esc(p.handle ?? p.recipient)}</b></td>
      <td>${esc(c.artist ?? "")} <span class="muted">${esc(c.song ?? "")}</span></td>
      <td><b>${esc(p.po_number)}</b></td><td class="muted">${esc(invOf[p.batch_id] || "No invoice yet")}</td>
      <td class="muted">${esc((capOf[p.campaign_id]?.client_market ?? "").replace(/^Stellar /, ""))}</td>
      <td class="num">${money(Number(p.amount), p.currency)}</td>
      <td><span class="pp-st ${tone(p.status, p)}"${p.error ? ` title="${esc(p.error)}"` : ""}>${esc(p.status === "queued" && p.error ? "Check PayPal first" : PAY_LABEL[p.status] ?? p.status)}</span>${p.env === "sandbox" ? ' <span class="pp-test">Test</span>' : ""}</td></tr>`; }).join("");
  }
  function paymentsHtml() {
    if (!payments.length) return "";
    return `<section class="panel" style="margin-bottom:20px">
      <div class="page-head" style="margin-bottom:8px"><h2 style="margin:0">Sent with PayPal</h2>
        <input type="search" id="pp-q" class="pp-q" placeholder="Search PO, invoice, creator, campaign…" aria-label="Search payments" value="${esc(st.q)}"></div>
      <div class="table-wrap"><table>
        <thead><tr><th>Sent</th><th>Creator</th><th>Campaign</th><th>PO</th><th>Invoice</th><th>Region</th><th class="num">Amount</th><th>Status</th></tr></thead>
        <tbody id="pp-rows">${payRows()}</tbody></table></div></section>`;
  }
  draw();
}
