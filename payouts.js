// Payouts: the PayPal payout sheet, built into each campaign (team only; clients never see it).
// A campaign has sections (a set of deliverables, e.g. "20x Edits" at $50 each) and one row per creator:
// who sources and pays them, videos, price, status (contacted → waiting for draft → drafted →
// waiting for payment → paid) and whether they posted, read from the tracker's posts.
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const nf = new Intl.NumberFormat("en", { maximumFractionDigits: 2 });
const money = (v, cur) => {
  if (v == null || Number.isNaN(v)) return "–";
  try { return new Intl.NumberFormat("en", { style: "currency", currency: cur || "USD", minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(v); }
  catch { return `${nf.format(v)} ${cur ?? ""}`.trim(); }
};
const num = (v) => { const t = String(v ?? "").replace(/[^0-9.,-]/g, "").replace(/,(?=\d{3}\b)/g, "").replace(",", "."); const x = parseFloat(t); return Number.isFinite(x) ? x : null; };
const today = () => new Date().toISOString().slice(0, 10);
const dayLabel = (d) => (d ? new Date(`${d}T00:00:00`).toLocaleDateString("en-GB", { day: "numeric", month: "short" }) : "");
const handleKey = (h) => String(h ?? "").trim().replace(/^@/, "").replace(/^https?:\/\/(www\.)?tiktok\.com\/@/i, "").split(/[/?]/)[0].toLowerCase();

export const STATUS = [
  ["contacted", "Contacted"],
  ["waiting_draft", "Waiting for draft"],
  ["drafted", "Drafted"],
  ["waiting_payment", "Waiting for payment"],
  ["paid", "Paid"],
];
const statusName = (s) => (STATUS.find(([k]) => k === s) ?? [s, s])[1];
const VIA = [["paypal", "PayPal"], ["wise", "Wise"], ["bank", "Bank"]];
const rowTotal = (r) => (r.amount != null ? Number(r.amount) : r.price_per_video != null ? Number(r.price_per_video) * (r.videos ?? 0) : 0);

// ---------- the Payouts tab on a campaign ----------
export async function renderCampaignPayouts(el, sb, { campaign, toast, isCurrent }) {
  el.innerHTML = `<p class="muted">Loading payouts…</p>`;
  const cid = campaign.id, cur = campaign.currency || "USD";
  const [secRes, rowRes, postRes, campRes, teamRes, peopleRes] = await Promise.all([
    sb.from("payout_sections").select("*").eq("campaign_id", cid).order("position").order("created_at"),
    sb.from("payout_rows").select("*").eq("campaign_id", cid).order("position").order("created_at"),
    sb.from("posts").select("creator_id,status,creator:creators(username)").eq("campaign_id", cid),
    sb.from("campaigns").select("budget,spend_cap_percent").eq("id", cid).maybeSingle(),
    sb.from("team_members").select("name"),
    sb.from("payout_rows").select("handled_by").not("handled_by", "is", null).limit(1000),
  ]);
  const me = (await sb.auth.getSession()).data.session?.user?.email ?? null;
  if (!isCurrent()) return;
  const err = secRes.error ?? rowRes.error ?? campRes.error;
  if (err) { el.innerHTML = `<p class="error">${esc(err.message)}</p>`; return; }
  const sections = secRes.data, rows = rowRes.data;
  const budget = campRes.data?.budget != null ? Number(campRes.data.budget) : null;
  let capPct = Number(campRes.data?.spend_cap_percent ?? 30);
  const people = [...new Set([...(teamRes.data ?? []).map((t) => t.name), ...(peopleRes.data ?? []).map((r) => r.handled_by)].filter((x) => x && x !== "Admin"))].sort();
  // Posts in the tracker per creator handle, so "Posted" fills itself in.
  const postedBy = new Map();
  for (const p of postRes.data ?? []) {
    const k = handleKey(p.creator?.username);
    if (k && p.status !== "removed") postedBy.set(k, (postedBy.get(k) ?? 0) + 1);
  }
  const postedOf = (r) => postedBy.get(handleKey(r.handle)) ?? 0;
  const isPosted = (r) => r.posted_manual || (postedOf(r) > 0 && postedOf(r) >= Math.max(1, r.videos ?? 1));
  const st = { filter: "all", confirm: null };

  // Posted but still marked as an earlier step: move them to "Waiting for payment".
  async function autoBump() {
    const bump = rows.filter((r) => isPosted(r) && ["contacted", "waiting_draft", "drafted"].includes(r.status));
    if (!bump.length) return;
    const { error } = await sb.from("payout_rows").update({ status: "waiting_payment" }).in("id", bump.map((r) => r.id));
    if (!error) bump.forEach((r) => (r.status = "waiting_payment"));
  }
  await autoBump();

  const spent = () => rows.reduce((s, r) => s + rowTotal(r), 0);
  const visible = (r) => st.filter === "all" || (st.filter === "topay" && r.status === "waiting_payment") || (st.filter === "draft" && ["contacted", "waiting_draft"].includes(r.status))
    || (st.filter === "notposted" && !isPosted(r) && r.status !== "paid");

  async function save(table, id, patch) {
    const { error } = await sb.from(table).update(patch).eq("id", id);
    if (error) toast(`Couldn't save: ${error.message}`);
    return !error;
  }

  // The only budget on this tab: the creator budget, a share of what's invoiced (30% by default).
  const creatorBudget = () => (budget != null ? budget * capPct / 100 : null);
  function summaryHtml() {
    const s = spent(), cap = creatorBudget();
    const toPay = rows.filter((r) => r.status === "waiting_payment");
    const left = cap != null ? cap - s : null;
    return `
      <div class="po2-main"><div class="n">${cap != null ? money(cap, cur) : "–"}</div>
        <div class="l">Creator budget · <label class="po-cap"><input type="number" id="po-cap" min="0" max="100" step="1" value="${capPct}" aria-label="Creator budget, percent of the invoiced budget">%</label> of ${money(budget, cur)}</div></div>
      <div><div class="n">${money(s, cur)}</div><div class="l">Spent${cap ? ` · ${Math.round((s / cap) * 100)}%` : ""}</div></div>
      <div class="${left != null && left < 0 ? "po2-over" : ""}"><div class="n">${left != null ? money(Math.abs(left), cur) : "–"}</div><div class="l">${left != null && left < 0 ? "Over budget" : "Left to spend"}</div></div>
      <div><div class="n">${money(toPay.reduce((a, r) => a + rowTotal(r), 0), cur)}</div><div class="l">To pay · ${toPay.length} creator${toPay.length === 1 ? "" : "s"}</div></div>
      ${cap != null ? `<span class="po2-bar" aria-hidden="true"><i style="width:${Math.min(100, (s / (cap || 1)) * 100)}%"></i></span>` : ""}`;
  }

  function rowHtml(r) {
    const posted = postedOf(r), need = Math.max(1, r.videos ?? 1);
    const total = rowTotal(r);
    return `<tr data-row="${r.id}" class="po-st-${r.status}">
      <td class="po-who"><input class="po-in po-handle" data-f="handle" value="${esc(r.handle)}" aria-label="Creator handle">
        <a class="po-open" href="https://www.tiktok.com/@${esc(handleKey(r.handle))}" target="_blank" rel="noopener" title="Open profile" aria-label="Open ${esc(r.handle)}'s profile">↗</a></td>
      <td><input class="po-in" data-f="handled_by" list="po-people" value="${esc(r.handled_by ?? "")}" placeholder="Who" aria-label="Sourced and paid by"></td>
      <td class="num"><input class="po-in num" data-f="videos" inputmode="numeric" value="${r.videos ?? ""}" aria-label="Videos"></td>
      <td class="num"><input class="po-in num" data-f="price_per_video" inputmode="decimal" value="${r.price_per_video != null ? nf.format(r.price_per_video) : ""}" placeholder="–" aria-label="Price per video"></td>
      <td class="num"><input class="po-in num po-total" data-f="amount" inputmode="decimal" value="${total ? nf.format(total) : ""}" placeholder="–" aria-label="Total"></td>
      <td><select class="po-status s-${r.status}" data-f="status" aria-label="Status">${STATUS.map(([k, l]) => `<option value="${k}"${k === r.status ? " selected" : ""}>${l}</option>`).join("")}</select></td>
      <td class="po-posted">${posted ? `<span class="po-count${posted >= need ? " ok" : ""}" title="Posts by this creator tracked in this campaign">${posted >= need ? "✓ " : ""}${posted}/${need}</span>`
        : `<label class="po-check" title="Tick if they posted somewhere the tracker doesn't follow"><input type="checkbox" data-f="posted_manual"${r.posted_manual ? " checked" : ""}><span class="sr">Posted</span></label>`}</td>
      <td class="po-paid">${r.status === "paid" ? `<select class="po-via" data-f="paid_via" aria-label="Paid via">${VIA.map(([k, l]) => `<option value="${k}"${k === (r.paid_via ?? "paypal") ? " selected" : ""}>${l}</option>`).join("")}</select><span class="muted small">${esc(dayLabel(r.paid_on))}</span>` : `<span class="muted">–</span>`}</td>
      <td><input class="po-in" data-f="notes" value="${esc(r.notes ?? "")}" placeholder="" aria-label="Notes"></td>
      <td class="po-x"><button type="button" class="link-btn" data-del="${r.id}" aria-label="Remove ${esc(r.handle)}">${st.confirm === r.id ? "Remove?" : "×"}</button></td>
    </tr>`;
  }

  function sectionHtml(s) {
    const mine = rows.filter((r) => (r.section_id ?? null) === (s?.id ?? null));
    const shown = mine.filter(visible);
    const sp = mine.reduce((a, r) => a + rowTotal(r), 0);
    return `<section class="po-sec" data-sec="${s?.id ?? ""}">
      <div class="po-sec-head">
        ${s ? `<input class="po-sec-name" data-sf="name" value="${esc(s.name)}" aria-label="Section name">` : `<h3>${sections.length ? "Not in a section" : "Creators"}</h3>`}
        <div class="po-sec-sum">
          <span>${mine.length} creator${mine.length === 1 ? "" : "s"}</span>
          <span><b>${money(sp, cur)}</b></span>
          ${s ? `<button type="button" class="link-btn muted" data-delsec="${s.id}">${st.confirm === s.id ? "Delete section?" : "Delete"}</button>` : ""}
        </div>
      </div>
      <div class="po-tablewrap"><table class="po-table">
        <colgroup><col class="c-who"><col class="c-by"><col class="c-n"><col class="c-m"><col class="c-m"><col class="c-st"><col class="c-p"><col class="c-paid"><col class="c-notes"><col class="c-x"></colgroup>
        <thead><tr><th>Creator</th><th>Sourced &amp; paid by</th><th class="num">Videos</th><th class="num">Per video</th><th class="num">Total</th><th>Status</th><th>Posted</th><th>Paid</th><th>Notes</th><th></th></tr></thead>
        <tbody>${shown.map(rowHtml).join("") || `<tr class="po-empty"><td colspan="10" class="muted small">${mine.length ? "No creators match this filter." : "No creators yet."}</td></tr>`}</tbody>
      </table></div>
      <form class="po-add" data-addto="${s?.id ?? ""}"><input name="h" placeholder="+ Add creator: @handle or profile link" aria-label="Add creator"><button type="submit">Add</button></form>
    </section>`;
  }

  function draw() {
    const hasLoose = rows.some((r) => !r.section_id) || !sections.length;
    el.innerHTML = `
      <div class="po2-sum" id="po-sum">${summaryHtml()}</div>
      <div class="po2-tools">
        <div class="po2-filter" role="tablist" aria-label="Show">
          ${[["all", "All creators"], ["topay", "To pay"], ["draft", "Waiting for draft"], ["notposted", "Not posted"]].map(([k, l]) => `<button type="button" role="tab" data-filter="${k}" aria-selected="${st.filter === k}">${l}</button>`).join("")}
        </div>
        <span class="po-tools-r">
          <button type="button" class="link-btn" id="po-paste">Paste from sheet</button>
          <button type="button" class="link-btn" id="po-newsec">+ New section</button>
        </span>
      </div>
      <datalist id="po-people">${people.map((p) => `<option value="${esc(p)}">`).join("")}</datalist>
      ${!rows.length && !sections.length ? emptyGuide(cur) : `${sections.map(sectionHtml).join("")}
      ${hasLoose ? sectionHtml(null) : ""}`}
      <p class="muted small po-note">Clients never see payouts. "Posted" counts the creator's posts in the tracker (tick the box for posts it doesn't follow); posted creators move to "Waiting for payment" by themselves.</p>`;
    bind();
    el.querySelector("#po-start")?.addEventListener("click", () => el.querySelector("#po-newsec").click());
    el.querySelector("#po-start-paste")?.addEventListener("click", () => el.querySelector("#po-paste").click());
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

  function bind() {
    bindCap();
    el.querySelectorAll("[data-filter]").forEach((b) => (b.onclick = () => { st.filter = b.dataset.filter; draw(); }));
    el.querySelector("#po-newsec").onclick = async () => {
      const { data, error } = await sb.from("payout_sections").insert({ campaign_id: cid, name: "New section", deliverable: "video", position: sections.length }).select().single();
      if (error) return toast(error.message);
      sections.push(data); draw();
      el.querySelector(`.po-sec[data-sec="${data.id}"] .po-sec-name`)?.select();
    };
    el.querySelector("#po-paste").onclick = () => pasteDialog();
    el.querySelectorAll(".po-sec").forEach((box) => {
      const secId = box.dataset.sec || null;
      bindSectionButtons(box);
      box.querySelectorAll("[data-sf]").forEach((inp) => (inp.onchange = async () => {
        const f = inp.dataset.sf, s = sections.find((x) => x.id === secId);
        const v = f === "name" ? inp.value.trim() || "Untitled section" : f === "deliverable" ? inp.value.trim() || "video" : num(inp.value);
        if (f === "deliverables" && v != null) inp.value = Math.round(v);
        if (await save("payout_sections", secId, { [f]: f === "deliverables" && v != null ? Math.round(v) : v })) { s[f] = v; refreshSection(secId); }
      }));
      box.querySelector(".po-add").onsubmit = async (e) => {
        e.preventDefault();
        const inp = e.currentTarget.h, h = handleKey(inp.value);
        if (!h) return;
        const last = rows.filter((r) => (r.section_id ?? null) === secId).at(-1);
        const { data, error } = await sb.from("payout_rows").insert({
          campaign_id: cid, section_id: secId, handle: `@${h}`, handled_by: last?.handled_by ?? null,
          price_per_video: last?.price_per_video ?? sections.find((x) => x.id === secId)?.unit_price ?? null, videos: 1,
          position: rows.length, created_by: me ?? null,
        }).select().single();
        if (error) return toast(error.message);
        if (data.price_per_video != null) data.amount = Number(data.price_per_video);
        if (data.amount != null && !(await withinBudget(rowTotal(data)))) { await sb.from("payout_rows").delete().eq("id", data.id); return; }
        if (data.amount != null) await save("payout_rows", data.id, { amount: data.amount });
        rows.push(data); await autoBump(); draw();
        el.querySelector(`.po-sec[data-sec="${secId ?? ""}"] .po-add input`)?.focus();
      };
    });
    el.querySelectorAll("tr[data-row]").forEach((tr) => {
      const r = rows.find((x) => x.id === tr.dataset.row);
      tr.querySelectorAll("[data-f]").forEach((inp) => (inp.onchange = () => editRow(r, inp, tr)));
      tr.querySelector("[data-del]").onclick = async (e) => {
        if (st.confirm !== r.id) { st.confirm = r.id; e.currentTarget.textContent = "Remove?"; return; }
        const { error } = await sb.from("payout_rows").delete().eq("id", r.id);
        if (error) return toast(error.message);
        rows.splice(rows.indexOf(r), 1); st.confirm = null; draw();
      };
    });
  }

  // Creator spend may never go over the creator budget (raise the % above if a campaign needs more).
  async function withinBudget(extra = 0) {
    const cap = creatorBudget();
    if (cap == null) return true;
    const after = spent() + extra;
    if (after <= cap + 0.005) return true;
    toast(`That would take creator spend to ${money(after, cur)}, over the creator budget of ${money(cap, cur)}. Raise the % if this campaign needs more.`);
    return false;
  }

  async function editRow(r, inp, tr) {
    const f = inp.dataset.f;
    const before = rowTotal(r), prev = { ...r };
    const patch = {};
    if (f === "posted_manual") patch.posted_manual = inp.checked;
    else if (f === "status") {
      patch.status = inp.value;
      if (inp.value === "paid") { patch.paid_on = r.paid_on ?? today(); patch.paid_via = r.paid_via ?? "paypal"; }
      else { patch.paid_on = null; patch.paid_via = null; }
    } else if (f === "paid_via") patch.paid_via = inp.value;
    else if (f === "handle") { const h = handleKey(inp.value); if (!h) { inp.value = r.handle; return; } patch.handle = `@${h}`; }
    else if (f === "handled_by" || f === "notes") patch[f] = inp.value.trim() || null;
    else if (f === "videos") {
      patch.videos = Math.max(0, Math.round(num(inp.value) ?? 0));
      if (r.price_per_video != null) patch.amount = patch.videos * Number(r.price_per_video);
    } else if (f === "price_per_video") {
      patch.price_per_video = num(inp.value);
      if (patch.price_per_video != null) patch.amount = patch.price_per_video * (r.videos ?? 1);
    } else if (f === "amount") patch.amount = num(inp.value);
    if (patch.posted_manual && ["contacted", "waiting_draft", "drafted"].includes(r.status)) patch.status = "waiting_payment";

    Object.assign(r, patch);
    if (rowTotal(r) > before && !(await withinBudget(0))) { Object.assign(r, prev); refreshRow(tr, r); return; }
    if (!(await save("payout_rows", r.id, patch))) { Object.assign(r, prev); refreshRow(tr, r); return; }
    if (f === "handle") { tr.querySelector(".po-open").href = `https://www.tiktok.com/@${handleKey(r.handle)}`; }
    if (["status", "posted_manual", "videos", "handle"].includes(f) || patch.status) {
      if (st.filter !== "all" && !visible(r)) { draw(); return; }
      refreshRow(tr, r);
    } else if (["price_per_video", "amount"].includes(f)) {
      const t = tr.querySelector(".po-total"); if (t && f !== "amount") t.value = rowTotal(r) ? nf.format(rowTotal(r)) : "";
    }
    refreshSummary(); refreshSection(r.section_id ?? null);
  }
  function refreshRow(tr, r) {
    const tmp = document.createElement("tbody"); tmp.innerHTML = rowHtml(r);
    const fresh = tmp.firstElementChild; tr.replaceWith(fresh);
    fresh.querySelectorAll("[data-f]").forEach((inp) => (inp.onchange = () => editRow(r, inp, fresh)));
    fresh.querySelector("[data-del]").onclick = async (e) => {
      if (st.confirm !== r.id) { st.confirm = r.id; e.currentTarget.textContent = "Remove?"; return; }
      const { error } = await sb.from("payout_rows").delete().eq("id", r.id);
      if (error) return toast(error.message);
      rows.splice(rows.indexOf(r), 1); st.confirm = null; draw();
    };
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
      if (creatorBudget() != null && spent() + add > creatorBudget() + 0.005) { toast(`These rows add ${money(add, cur)} and would take creator spend over the creator budget of ${money(creatorBudget(), cur)}. Raise the % first if this campaign needs more.`); draw(); return; }
      const ins = parsed.map((r, i) => ({ ...r, campaign_id: cid, section_id: secId, position: rows.length + i, created_by: me ?? null }));
      const { data, error } = await sb.from("payout_rows").insert(ins).select();
      if (error) return toast(error.message);
      rows.push(...data); await autoBump(); toast(`Added ${data.length} creators`); draw();
    };
    d.showModal();
    f.t.focus();
  }

  draw();
}

// What an empty campaign shows: how to start, and an example of a filled-in payout sheet.
function emptyGuide(cur) {
  const ex = [
    ["@likekyuuna_s", "Nana", 1, 400, "Waiting for draft", "waiting_draft", "0/1", ""],
    ["@rubyra6", "Nana", 1, 200, "Waiting for payment", "waiting_payment", "✓ 1/1", ""],
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
    if (posted && status !== "paid") status = "waiting_payment";
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
  const [rowRes, campRes, secRes] = await Promise.all([
    sb.from("payout_rows").select("id,campaign_id,section_id,handle,handled_by,videos,price_per_video,amount,status,paid_on"),
    sb.from("campaign_summary").select("id,artist,song,budget,currency,status"),
    sb.from("payout_sections").select("id,name"),
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
  const st = { who: (() => { try { return localStorage.getItem("po-who") ?? ""; } catch { return ""; } })() };
  if (st.who && !people.includes(st.who)) st.who = "";

  const draw = () => {
    const mine = rows.filter((r) => !st.who || r.handled_by === st.who);
    const toPay = mine.filter((r) => r.status === "waiting_payment").sort((a, b) => (camps[a.campaign_id]?.artist ?? "").localeCompare(camps[b.campaign_id]?.artist ?? ""));
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
          : `<p class="muted" style="margin:0">No creators are waiting for payment${st.who ? ` for ${esc(st.who)}` : ""}.</p>`}
      </section>
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
    app.querySelector("#po-who").onchange = (e) => { st.who = e.target.value; try { localStorage.setItem("po-who", st.who); } catch { /* ignore */ } draw(); };
    app.querySelectorAll("[data-go]").forEach((tr) => (tr.onclick = () => go(tr.dataset.go)));
  };
  draw();
}
