// Campaign page tools: "Duplicate…" (a new draft built from an existing campaign) and the wrap-up checklist
// (what is still open when a campaign ends). Team pages only; nothing here is ever sent to clients.
import { money } from "./money.js?v=20261126b";
import { confirmDialog } from "./dialog.js?v=20261126b";

const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const day = (d) => (d ? new Date(`${String(d).slice(0, 10)}T00:00:00`).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "");
const rpcError = (e) => e?.message ?? String(e ?? "Something went wrong");

// ---------- Duplicate ----------
// Artist and song are editable (a new song is the usual reason to copy); the checklist says what comes along.
export async function duplicateCampaignDialog(sb, c, { toast, onCreated } = {}) {
  const { data: pv, error } = await sb.rpc("duplicate_campaign_preview", { p_from: c.id });
  if (error || !pv) { toast?.(error ? rpcError(error) : "Couldn't read this campaign."); return; }
  const n = (k) => Number(pv[k] ?? 0);
  const items = [
    { k: "basics", on: true, label: "Client, company, contact, type and team", count: null },
    { k: "folders", on: true, label: "Folders", count: n("folders") },
    { k: "sounds", on: false, label: "Sounds", count: n("sounds") },
    { k: "payout_structure", on: true, label: "Payout sections and prices", count: n("sections") },
    { k: "creators", on: false, label: "Creators on the payout sheet", count: n("creators"), also: n("folder_creators"), note: "statuses start again" },
    { k: "portal", on: true, label: "Creator page settings", count: null, title: "Drafts on or off, client review, brief and message" },
    { k: "budget", on: false, label: "Budget and market split", count: pv.budget != null || n("markets") ? 1 : 0, extra: pv.budget != null ? money(pv.budget, pv.currency) : "" },
  ];
  const d = document.createElement("dialog");
  d.className = "po-dialog dup-dialog";
  d.innerHTML = `<form method="dialog">
    <h2>Duplicate campaign</h2>
    <div class="dup-names">
      <label>Artist <input name="artist" value="${esc(pv.artist)}" maxlength="120" autocomplete="off"></label>
      <label>Song <input name="song" value="${esc(pv.song)}" maxlength="160" autocomplete="off" placeholder="Song or project"></label>
    </div>
    <div class="dup-list">${items.map((it) => {
      const off = it.count === 0 && !(it.also > 0);
      const tail = it.k === "budget" ? [it.extra, n("markets") ? plural(n("markets"), "market", "markets") : ""].filter(Boolean).join(" · ")
        : it.count != null ? String(it.count) : "";
      return `<label class="dup-item${off ? " off" : ""}"${it.title ? ` title="${esc(it.title)}"` : ""}><input type="checkbox" name="${it.k}"${it.on && !off ? " checked" : ""}${off ? " disabled" : ""}>
        <span>${esc(it.label)}${tail ? ` <b class="dup-n">· ${esc(tail)}</b>` : ""}${it.note && !off ? ` <span class="muted">(${esc(it.note)})</span>` : ""}</span></label>`;
    }).join("")}</div>
    <p class="muted small dup-quiet">PO, dates, videos, invoices, payments and chat aren't copied.</p>
    <p class="small error" id="dup-err" role="alert"></p>
    <div class="actions"><button type="submit" value="go" class="primary">Duplicate</button><button type="submit" value="cancel" formnovalidate>Cancel</button></div>
  </form>`;
  document.body.append(d);
  const f = d.querySelector("form"), err = d.querySelector("#dup-err");
  // Creators need their sections to land in the right place: ticking one ticks the other.
  const structure = f.elements.payout_structure, creators = f.elements.creators;
  creators.onchange = () => { if (creators.checked && !structure.disabled) structure.checked = true; };
  structure.onchange = () => { if (!structure.checked && creators.checked && !creators.disabled) creators.checked = false; };
  let running = false;
  f.onsubmit = async (e) => {
    if (e.submitter?.value !== "go") return;
    e.preventDefault();
    if (running) return;
    const artist = f.artist.value.trim();
    if (!artist) { err.textContent = "Add the artist's name."; f.artist.focus(); return; }
    running = true;
    const b = e.submitter; b.disabled = true; b.textContent = "Duplicating…"; err.textContent = "";
    const opts = Object.fromEntries(items.map((it) => [it.k, !!f.elements[it.k].checked]));
    const { data: id, error: e2 } = await sb.rpc("duplicate_campaign", { p_from: c.id, p_opts: { ...opts, artist, song: f.song.value.trim() } });
    if (e2 || !id) {
      running = false; b.disabled = false; b.textContent = "Duplicate";
      err.textContent = rpcError(e2) || "Couldn't duplicate. Try again.";
      return;
    }
    d.close();
    toast?.(`${artist}${f.song.value.trim() ? ` – ${f.song.value.trim()}` : ""} created as a draft`);
    onCreated?.(id);
  };
  d.addEventListener("click", (e) => { if (e.target === d) d.close(); });
  d.onclose = () => d.remove();
  d.showModal();
  f.song.focus(); f.song.select();
}

// ---------- Wrap-up checklist ----------
const MANUAL = [
  ["final_report_sent", "Final report sent to the client"],
  ["client_feedback", "Client feedback collected"],
  ["case_study", "Case study done"],
  ["drafts_cleanup_ok", "OK to delete draft videos"],
];

// The campaign is over (end date passed) or archived: then the checklist shows up by itself.
export const wrapupDue = (c) => c.status === "finished" || (!!c.end_date && String(c.end_date).slice(0, 10) < new Date().toISOString().slice(0, 10));

// One line per auto item: the gap in plain words and where to go to fix it. null = doesn't apply (hidden).
function autoRows(a, c) {
  const rows = [];
  const add = (key, label, item, gap, act) => { if (item && item.ok !== null && item.ok !== undefined) rows.push({ key, label, ok: !!item.ok, gap: item.ok ? "" : gap, act }); };
  const v = a.videos_in, p = a.creators_paid, i = a.invoiced, ip = a.invoices_paid, dr = a.drafts_waiting, rl = a.report_link, en = a.ended;
  add("videos_in", "All videos are in", v,
    v?.videos_total > 0 ? `${plural(v.videos_total - v.videos_done, "video", "videos")} still to come (${v.videos_done} of ${v.videos_total} in)` : `${plural((v?.rows_total ?? 0) - (v?.rows_done ?? 0), "creator hasn't", "creators haven't")} posted yet`,
    { tab: "payouts", text: "Payouts" });
  add("creators_paid", "All creators paid", p, `${plural(p?.unpaid ?? 0, "creator", "creators")} not paid yet · ${money(p?.unpaid_amount, p?.currency)}`, { tab: "payouts", text: "Payouts" });
  add("invoiced", "Fully invoiced", i,
    i?.other_currency_requests > 0 ? "Some invoices are in another currency: check the total by hand"
      : !i?.requests ? "Not invoiced yet" : `${money(i?.left, i?.currency)} not invoiced yet`,
    { href: "#/invoices", text: "Invoices" });
  add("invoices_paid", "Invoices paid by the client", ip,
    `${plural(ip?.open ?? 0, "invoice", "invoices")} not paid yet${ip?.not_sent ? ` (${ip.not_sent} not sent yet)` : ""}`, { href: "#/invoices", text: "Invoices" });
  add("drafts_waiting", "No drafts waiting", dr,
    [dr?.for_team && `${plural(dr.for_team, "draft", "drafts")} waiting for us`, dr?.for_client && `${plural(dr.for_client, "draft", "drafts")} waiting for the client`].filter(Boolean).join(" · "),
    { tab: "creators", text: "Creators" });
  add("report_link", "Client link made", rl, "No client link yet", { share: true, text: "Share" });
  add("ended", "Campaign has ended", en, en?.end_date ? `Ends ${day(en.end_date)}` : "No end date set", { href: `#/c/${c.id}/edit`, text: "Edit" });
  add("finished", "Marked as completed", a.finished, "Not marked as completed yet", null);
  return rows;
}

// Draws the card into `box`. force = opened from the ⋯ menu (also shown while the campaign is still running).
export async function mountWrapup(box, sb, c, { toast, force = false, open = false, onJump, onShare, onFinished } = {}) {
  if (!box) return;
  if (!force && !wrapupDue(c)) { box.innerHTML = ""; return; }
  let data = null;
  const load = async (call) => {
    const { data: r, error } = await call;
    if (error || !r) { if (force) toast?.(rpcError(error)); return null; }
    return r;
  };
  data = await load(sb.rpc("campaign_wrapup", { p_campaign: c.id }));
  if (!box.isConnected || !data) return;

  const draw = (opened) => {
    const rows = autoRows(data.auto ?? {}, c), s = data.summary ?? {};
    const done = (s.auto_ok ?? 0) + (s.manual_done ?? 0), total = (s.auto_total ?? 0) + (s.manual_total ?? 0);
    const othersOk = rows.filter((r) => r.key !== "finished").every((r) => r.ok) && (s.manual_done ?? 0) === (s.manual_total ?? 0);
    const act = (r) => {
      if (!r.act) return "";
      if (r.act.tab) return `<button type="button" class="link-btn" data-wu-jump="${esc(r.act.tab)}">${esc(r.act.text)}</button>`;
      if (r.act.share) return `<button type="button" class="link-btn" data-wu-share>${esc(r.act.text)}</button>`;
      return `<a class="mf-link" href="${esc(r.act.href)}">${esc(r.act.text)}</a>`;
    };
    box.innerHTML = `<details class="wrapup"${opened ? " open" : ""}>
      <summary><span class="wu-title">Wrap-up</span><span class="wu-count${s.all_done ? " all" : ""}">${done} of ${total}</span></summary>
      <div class="wu-rows">
        ${rows.map((r) => `<div class="wu-row${r.ok ? " done" : ""}">
          <span class="wu-mark" aria-hidden="true">${r.ok ? "✓" : ""}</span>
          <span class="wu-text">${esc(r.ok ? r.label : r.gap)}${r.ok ? "" : ` <span class="sr"> (${esc(r.label)})</span>`}</span>
          ${r.ok ? "" : r.key === "finished" ? (othersOk ? `<button type="button" class="primary wu-fin" data-wu-fin>Mark as completed</button>` : "") : act(r)}
        </div>`).join("")}
        <div class="wu-by-hand">By hand</div>
        ${MANUAL.map(([k, label]) => {
          const m = data.manual?.[k] ?? {};
          const tip = m.done ? `${m.done_by ? `Ticked by ${m.done_by}` : "Ticked"}${m.done_at ? ` on ${day(m.done_at)}` : ""}` : "";
          return `<label class="wu-row wu-manual${m.done ? " done" : ""}"${tip ? ` title="${esc(tip)}"` : ""}><input type="checkbox" data-wu-tick="${k}"${m.done ? " checked" : ""}><span class="wu-text">${esc(label)}</span></label>`;
        }).join("")}
      </div>
    </details>`;
    const det = box.querySelector("details");
    box.querySelectorAll("[data-wu-jump]").forEach((b) => (b.onclick = () => onJump?.(b.dataset.wuJump)));
    box.querySelectorAll("[data-wu-share]").forEach((b) => (b.onclick = () => onShare?.()));
    box.querySelectorAll("[data-wu-tick]").forEach((cb) => (cb.onchange = async () => {
      box.querySelectorAll("[data-wu-tick]").forEach((x) => (x.disabled = true));
      const r = await load(sb.rpc("campaign_wrapup_tick", { p_campaign: c.id, p_item: cb.dataset.wuTick, p_done: cb.checked }));
      if (r) data = r; else toast?.("Couldn't save that. Try again.");
      draw(det.open);
    }));
    box.querySelector("[data-wu-fin]")?.addEventListener("click", async (e) => {
      const btn = e.currentTarget;
      const ans = await confirmDialog({ title: `Mark ${c.artist} as completed?`, body: esc("Everything on the checklist is done. Completed campaigns move to the archive."), confirm: "Mark as completed", danger: false });
      if (!ans) return;
      btn.disabled = true;
      const { error } = await sb.from("campaigns").update({ status: "finished" }).eq("id", c.id);
      if (error) { btn.disabled = false; toast?.(error.message); return; }
      toast?.(`${c.artist} marked as completed`);
      onFinished?.();
    });
  };
  draw(open);
  if (open) box.scrollIntoView({ behavior: "smooth", block: "nearest" });
}
