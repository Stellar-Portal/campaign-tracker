import { createClient } from "./vendor/supabase.esm.js";
import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from "./config.js?v=20261015e";
import { mountReport, renderWall, openPostModal, flag, regionName, ago, engagement, ICON, copyLink, pct } from "./report.js?v=20261015e";
import { INVOICING_ENTITIES, CLIENT_COUNTRIES, CLIENT_MARKETS, CAMPAIGN_TYPES, RELEASE_TYPES, LABEL_TYPES, STATUSES, statusLabel, normalisePO } from "./sheet-lists.js?v=20261015e";

const sb = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
const app = document.getElementById("app");
const who = document.getElementById("who");
let routeToken = 0; // bumps on every navigation so stale timers and fetches stop

// ---------- helpers ----------
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const nf = new Intl.NumberFormat("en");
const cf = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });
const n = (v) => (v == null ? "–" : nf.format(v));
const compact = (v) => (v == null ? "–" : cf.format(v));
const money = (v, cur) => {
  if (v == null) return "–";
  try { return new Intl.NumberFormat("en", { style: "currency", currency: cur || "EUR", minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(v); }
  catch { return `${nf.format(v)} ${cur ?? ""}`.trim(); }
};
const cpv = (v, cur) => {
  if (v == null || Number(v) === 0) return "–";
  try { return new Intl.NumberFormat("en", { style: "currency", currency: cur || "EUR", maximumFractionDigits: 4 }).format(v); }
  catch { return String(v); }
};
const date = (d) => (d ? new Date(d).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "");
const toast = (msg) => {
  const t = document.getElementById("toast");
  t.textContent = msg; t.classList.add("show");
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove("show"), 2600);
};
const fail = (err) => `<p class="error">${esc(err?.message ?? err)}</p>`;
const go = (hash) => { location.hash = hash; };

// Supabase returns at most 1,000 rows per request, so page through bigger results.
async function fetchAll(build, pageSize = 1000) {
  const out = [];
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await build().range(from, from + pageSize - 1);
    if (error) throw error;
    out.push(...data);
    if (data.length < pageSize) return out;
  }
}
async function inChunks(ids, size, fn) {
  const out = [];
  for (let i = 0; i < ids.length; i += size) out.push(...(await fn(ids.slice(i, i + size))));
  return out;
}

// ---------- auth ----------
async function renderLogin(message) {
  who.innerHTML = "";
  document.body.classList.add("signin");
  app.innerHTML = `
    <section class="login on-blue">
      <img class="logo" src="assets/stellar-blue.png" alt="Stellar" width="160" height="44">
      <h1>Stellar <em>OS</em></h1>
      <p class="small">For the Stellar team. Ask Sam for an account if you don't have one.</p>
      <form id="login">
        <div><label for="email">Work email</label><input id="email" type="email" autocomplete="username" required></div>
        <div><label for="password">Password</label><input id="password" type="password" autocomplete="current-password" required></div>
        <div id="login-msg">${message ? fail(message) : ""}</div>
        <div class="actions"><button class="primary" type="submit">Sign in</button></div>
      </form>
    </section>`;
  document.getElementById("login").addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = e.submitter; btn.disabled = true;
    const { error } = await sb.auth.signInWithPassword({
      email: document.getElementById("email").value.trim(),
      password: document.getElementById("password").value,
    });
    btn.disabled = false;
    if (error) document.getElementById("login-msg").innerHTML = fail(error.message === "Invalid login credentials" ? "That email and password don't match an account." : error);
  });
}

async function signedInUser() {
  const { data } = await sb.auth.getSession();
  return data.session?.user ?? null;
}

async function isTeamMember() {
  const { data, error } = await sb.from("team_members").select("email").limit(1);
  return !error && data.length > 0;
}

function renderWho(user) {
  who.innerHTML = `<span class="email" title="${esc(user.email)}">${esc(user.email)}</span><button id="signout" type="button">Sign out</button>`;
  document.getElementById("signout").onclick = async () => { await sb.auth.signOut(); };
}

// ---------- Stellar OS navigation ----------
const NAV_ICON = {
  overview: '<path d="M4 5h16M4 10h16M4 15h10M4 20h7"/>',
  tracker: '<path d="M4 19V9M10 19V5M16 19v-7M22 19H2"/>',
  payouts: '<path d="M3 7h18v10H3zM3 11h18M7 15h3"/>',
  creators: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0M16 4.5a3.5 3.5 0 0 1 0 7M18 14a6.5 6.5 0 0 1 3.5 6"/>',
  invoices: '<path d="M6 3h9l4 4v14H6zM14 3v5h5M9 13h7M9 17h5"/>',
  analytics: '<path d="M3 20l5-7 4 4 8-11"/><path d="M16 6h4v4"/>',
};
const NAV = [
  ["Campaigns", [
    { key: "overview", href: "#/", label: "Campaign overview", icon: "overview" },
    { key: "campaigns", href: "#/campaigns", label: "Tracker", icon: "tracker" },
  ]],
  ["Money", [
    { key: "payouts", href: "#/payouts", label: "PayPal payouts", icon: "payouts", soon: true },
    { key: "creator-payments", href: "#/creator-payments", label: "Creator payments", icon: "creators", soon: true },
    { key: "invoices", href: "#/invoices", label: "Invoices", icon: "invoices", soon: true },
  ]],
  ["Insights", [
    { key: "analytics", href: "#/analytics", label: "Analytics", icon: "analytics", soon: true },
  ]],
];
function renderNav(active) {
  document.getElementById("nav").innerHTML = NAV.map(([group, items]) => `
    <div class="nav-group"><div class="nav-label">${esc(group)}</div>
      ${items.map((it) => `<a href="${it.href}" class="nav-item${it.key === active ? " on" : ""}"${it.key === active ? ' aria-current="page"' : ""}>
        <svg viewBox="0 0 24 24" aria-hidden="true">${NAV_ICON[it.icon]}</svg><span>${esc(it.label)}</span>${it.soon ? '<i class="soon">Soon</i>' : ""}</a>`).join("")}
    </div>`).join("");
  document.querySelector('.nav-item.on')?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
}

// Sections that are planned but not built yet: say what they'll do.
const SOON = {
  payouts: ["PayPal payouts", "Replaces the PayPal payout sheet.", ["Who to pay this week, per campaign and creator", "PayPal batch file ready to upload", "Paid status written back to the campaign and its creator costs"]],
  "creator-payments": ["Creator payments", "Every creator deal in one place.", ["Agreed price per creator and campaign, in any currency", "What's paid and what's still owed", "Payment details kept private to the team"]],
  invoices: ["Invoices", "Client invoicing per PO number.", ["Draft, sent and paid, matching the Campaign Overview invoicing columns", "Linked to the campaign's price and invoicing entity", "Reminders for anything overdue"]],
  analytics: ["Analytics", "Performance across every campaign.", ["Cost per view by market, client and DRI", "Best-performing creators and sounds", "Month and year totals"]],
};
function renderSoon(key) {
  const [title, lead, points] = SOON[key];
  app.innerHTML = `<div class="page-head"><div><h1>${esc(title)}</h1><p class="voice muted" style="margin:8px 0 0;font-size:20px">${esc(lead)}</p></div></div>
    <section class="panel soon-panel"><span class="badge">Coming soon</span>
      <p>This part of Stellar OS isn't built yet. What it will do:</p>
      <ul>${points.map((x) => `<li>${esc(x)}</li>`).join("")}</ul></section>`;
}

// ---------- Campaign overview: the backlog sheet, linked to the tracker ----------
// The sheet ("Copy of CAMPAIGN OVERVIEW FY26/27") is mirrored into overview_snapshot every 5 minutes.
// Each row is matched to a tracker campaign by Artist + Song + PO (or the row the tracker last wrote).
const SHEET_URL = "https://docs.google.com/spreadsheets/d/1e3ce1Q7uW5iH4FQqN9Oo_Dw5Y51UcBx87nOAz1wp6Tk/edit#gid=1649746959";
const normKey = (...v) => v.map((x) => String(x ?? "").trim().toLowerCase().replace(/\s+/g, " ")).join("|");
const blankCell = (v) => { const t = String(v ?? "").trim(); return t === "" || t === "Select"; };
const sheetNumber = (v) => { const t = String(v ?? "").replace(/[^\d.\-]/g, ""); return t && !isNaN(Number(t)) ? Number(t) : null; };
const OV_STATUS = { Upcoming: "draft", Active: "active", "On Hold": "on_hold", Completed: "finished" };
const ALLOC_COLUMNS = ["US", "Brazil", "Mexico", "All LATAM", "Canada", "UK", "Germany", "France", "Africa", "Other", "Japan", "Korea", "China", "India", "SEA", "Global"];

// "01/07" (and "01/07/26") → an ISO date, picking the year that puts it closest to today.
function sheetDate(v) {
  const m = String(v ?? "").trim().match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/);
  if (!m) return null;
  const d = Number(m[1]), mo = Number(m[2]);
  if (d < 1 || d > 31 || mo < 1 || mo > 12) return null;
  const pad = (x) => String(x).padStart(2, "0");
  if (m[3]) return `${m[3].length === 2 ? "20" + m[3] : m[3]}-${pad(mo)}-${pad(d)}`;
  const now = new Date(), y = now.getFullYear();
  const best = [y - 1, y, y + 1].map((yy) => `${yy}-${pad(mo)}-${pad(d)}`).sort((a, b) => Math.abs(Date.parse(a) - now) - Math.abs(Date.parse(b) - now))[0];
  return best;
}
// "2 weeks", "3 months", "10 days" → an end date after the start
function endFromDuration(start, v) {
  const m = String(v ?? "").toLowerCase().match(/(\d+)\s*(day|week|month)/);
  if (!start || !m) return null;
  const k = Number(m[1]), dt = new Date(start + "T00:00:00Z");
  if (m[2] === "day") dt.setUTCDate(dt.getUTCDate() + k - 1);
  else if (m[2] === "week") dt.setUTCDate(dt.getUTCDate() + k * 7 - 1);
  else { dt.setUTCMonth(dt.getUTCMonth() + k); dt.setUTCDate(dt.getUTCDate() - 1); }
  return dt.toISOString().slice(0, 10);
}

// Turn a sheet row into the campaign form's fields, for "Create in tracker".
function prefillFromRow(r) {
  const g = (h) => (blankCell(r.f[h]) ? null : String(r.f[h]).trim());
  const start = sheetDate(g("Start Date"));
  const cur = (g("Currency") ?? "").toUpperCase().replace("JYP", "JPY");
  const markets = ALLOC_COLUMNS.map((m) => ({ market: m, amount: sheetNumber(r.f[m]) })).filter((x) => x.amount);
  return {
    campaign: {
      artist: g("Artist Name"), song: g("Song Name (s) or Project Name"), po_number: g("Stellar PO no."),
      status: OV_STATUS[g("Status")] ?? "draft", release_type: RELEASE_TYPES.includes(g("Type (NR or Cat)")) ? g("Type (NR or Cat)") : null,
      client: g("Client"), invoicing_entity: g("Invoicing Entity"), client_country: g("Client Location (Country)"),
      client_market: CLIENT_MARKETS.includes(g("Client Market")) ? g("Client Market") : null,
      client_contact_name: g("Client Contact Name"), client_contact_email: g("Client Contact eMail"),
      label_type: LABEL_TYPES.includes(g("Major / Indie / Other")) ? g("Major / Indie / Other") : null,
      under_nda: g("Under NDA?") === "Yes" ? true : g("Under NDA?") === "No" ? false : null,
      comms_owner: g("Stellar DRI"), campaign_type: g("Campaign Type"),
      start_date: start, end_date: endFromDuration(start, g("Duration")),
      budget: sheetNumber(g("Price")), currency: /^[A-Z]{3}$/.test(cur) ? cur : null,
      notes: g("Comments"), folders_by_market: true, invoiced: g("Invoice Status") === "Invoiced",
    },
    markets,
    sheetRow: r.row,
  };
}

async function renderOverview(token) {
  app.innerHTML = `<p class="muted pad">Loading the campaign overview…</p>`;
  const [snap, camps, syncs] = await Promise.all([
    sb.from("overview_snapshot").select("*").eq("id", 1).maybeSingle(),
    fetchAll(() => sb.from("campaign_summary").select("id,artist,song,po_number,status,total_plays,live_posts").order("created_at")).catch(() => []),
    sb.from("campaign_sheet_sync").select("campaign_id,sheet_row,last_error"),
  ]);
  if (token !== routeToken) return;
  const s = snap.data ?? {};
  const headers = s.headers ?? [];
  // Section of each column (row 1 of the sheet is merged across each section).
  let sec = "";
  const sectionOf = (s.sections ?? []).map((x) => (sec = String(x || "").trim() || sec));
  const firstIndex = {};
  headers.forEach((h, i) => { if (!(h in firstIndex)) firstIndex[h] = i; });
  const rows = (s.rows ?? []).map((r) => {
    const f = {};
    for (const h in firstIndex) f[h] = r.values[firstIndex[h]];
    return { row: r.row, values: r.values, f };
  });
  const byKey = new Map((camps ?? []).filter((c) => c.po_number).map((c) => [normKey(c.artist, c.song, c.po_number), c]));
  const byRow = new Map((syncs.data ?? []).filter((x) => x.sheet_row).map((x) => [x.sheet_row, (camps ?? []).find((c) => c.id === x.campaign_id)]));
  for (const r of rows) r.camp = byKey.get(normKey(r.f["Artist Name"], r.f["Song Name (s) or Project Name"], r.f["Stellar PO no."])) ?? byRow.get(r.row) ?? null;
  const linked = new Set(rows.map((r) => r.camp?.id).filter(Boolean));
  const notInSheet = (camps ?? []).filter((c) => !linked.has(c.id));

  const v = (r, h) => (blankCell(r.f[h]) ? "" : String(r.f[h]).trim());
  const uniq = (h) => [...new Set(rows.map((r) => v(r, h)).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const st = { q: "", status: sessionStorageGet("ov-status") ?? "", dri: "", market: "", invoice: "", tracker: "", sort: "sheet" };
  const totalsBy = (list) => {
    const t = {};
    const k = {};
    for (const r of list) {
      const p = sheetNumber(r.f["Price"]); const c = v(r, "Currency").toUpperCase().replace("JYP", "JPY");
      if (p && c) { t[c] = (t[c] ?? 0) + p; k[c] = (k[c] ?? 0) + 1; }
    }
    // Most-used currency first; amounts in different currencies are never added together.
    return Object.entries(t).sort((a, b) => k[b[0]] - k[a[0]] || b[1] - a[1]);
  };
  const fmtMoney = ([c, x]) => `${esc(c)} ${Math.round(x).toLocaleString("en-GB")}`;
  const moneyLine = (pairs) => pairs.length ? `${fmtMoney(pairs[0])}${pairs.length > 1 ? `<span class="ov-more">${pairs.slice(1).map(fmtMoney).join(" · ")}</span>` : ""}` : "–";
  const ago = s.synced_at ? timeAgo(s.synced_at) : null;

  app.innerHTML = `
    <div class="page-head">
      <div><h1>Campaign overview</h1>
        <p class="muted small" style="margin:6px 0 0" id="ov-sync">${s.sheet ? `From <a href="${SHEET_URL}" target="_blank" rel="noopener">${esc(s.sheet)}</a>` : "From the Campaign Overview sheet"}${ago ? ` · updated ${esc(ago)}` : ""}${s.last_error && (!s.synced_at || s.last_attempt_at > s.synced_at) ? ` · <span class="warn-note">last refresh failed: ${esc(s.last_error)}</span>` : ""}</p></div>
      <div class="actions" style="margin:0">
        <button type="button" id="ov-refresh">Refresh from sheet</button>
        <a class="btn primary" href="#/new">New campaign</a>
      </div>
    </div>
    ${!rows.length ? `<div class="panel"><p>${s.synced_at ? "The sheet has no campaigns yet." : "The overview hasn't been read from the sheet yet. Click <b>Refresh from sheet</b>; if that fails, the sheet script needs its latest version deployed."}</p></div>` : `
    <div class="stats ov-stats" id="ov-stats"></div>
    <div class="filters">
      <input id="ov-q" type="search" placeholder="Search artist, song, client, PO or contact" aria-label="Search the overview">
      <select id="ov-status" aria-label="Status"><option value="">All statuses</option>${uniq("Status").map((x) => `<option>${esc(x)}</option>`).join("")}</select>
      <select id="ov-dri" aria-label="Stellar DRI"><option value="">All DRIs</option>${uniq("Stellar DRI").map((x) => `<option>${esc(x)}</option>`).join("")}</select>
      <select id="ov-market" aria-label="Client market"><option value="">All client markets</option>${uniq("Client Market").map((x) => `<option>${esc(x)}</option>`).join("")}</select>
      <select id="ov-invoice" aria-label="Invoice status"><option value="">Invoiced or not</option>${uniq("Invoice Status").map((x) => `<option>${esc(x)}</option>`).join("")}</select>
      <select id="ov-tracker" aria-label="In the tracker"><option value="">In the tracker or not</option><option value="yes">In the tracker</option><option value="no">Not in the tracker</option></select>
      <select id="ov-sort" aria-label="Sort"><option value="sheet">Sheet order</option><option value="newest">Newest first</option><option value="start">Start date</option><option value="price">Highest price</option></select>
    </div>
    <div id="ov-list"></div>`}
    ${notInSheet.length ? `<div class="panel ov-missing"><h3>In the tracker, not in the sheet yet</h3>
      <p class="small muted">These campaigns are sent to the sheet once they have a PO number.</p>
      <ul>${notInSheet.map((c) => `<li><a href="#/c/${esc(c.id)}">${esc(c.artist)}${c.song ? ` – ${esc(c.song)}` : ""}</a> <span class="muted small">${c.po_number ? esc(c.po_number) + " · on its way" : "no PO number"}</span></li>`).join("")}</ul></div>` : ""}`;

  document.getElementById("ov-refresh").onclick = async (e) => {
    const b = e.currentTarget; b.disabled = true; b.textContent = "Reading the sheet…";
    const { data, error } = await sb.functions.invoke("sheet-sync", { body: { action: "pull_overview" } });
    if (token !== routeToken) return;
    if (error || data?.error) { b.disabled = false; b.textContent = "Refresh from sheet"; toast(`Couldn't read the sheet: ${data?.error ?? error.message}`); return; }
    toast(`Read ${data.rows} campaigns from the sheet`);
    renderOverview(++routeToken);
  };
  if (!rows.length) return;

  const listEl = document.getElementById("ov-list");
  const open = new Set();
  const filtered = () => {
    const q = st.q.trim().toLowerCase();
    let list = rows.filter((r) =>
      (!st.status || v(r, "Status") === st.status) && (!st.dri || v(r, "Stellar DRI") === st.dri) &&
      (!st.market || v(r, "Client Market") === st.market) && (!st.invoice || v(r, "Invoice Status") === st.invoice) &&
      (!st.tracker || (st.tracker === "yes") === !!r.camp) &&
      (!q || ["Artist Name", "Song Name (s) or Project Name", "Client", "Stellar PO no.", "Client Contact Name", "Client Contact eMail", "Invoicing Entity"].some((h) => v(r, h).toLowerCase().includes(q))));
    if (st.sort === "newest") list = [...list].reverse();
    if (st.sort === "start") list = [...list].sort((a, b) => String(sheetDate(v(b, "Start Date")) ?? "").localeCompare(String(sheetDate(v(a, "Start Date")) ?? "")));
    if (st.sort === "price") list = [...list].sort((a, b) => (sheetNumber(v(b, "Price")) ?? 0) - (sheetNumber(v(a, "Price")) ?? 0));
    return list;
  };
  const statusChip = (x) => x ? `<span class="status ${esc((OV_STATUS[x] ?? "").replace("draft", "upcoming"))}">${esc(x)}</span>` : `<span class="muted small">–</span>`;
  const detail = (r) => {
    const groups = [];
    headers.forEach((h, i) => {
      if (!h || h === "#" || blankCell(r.values[i])) return;
      const name = sectionOf[i] || "Details";
      let g = groups.find((x) => x.name === name);
      if (!g) groups.push((g = { name, items: [] }));
      g.items.push([h, r.values[i]]);
    });
    return `<div class="ov-detail">${groups.map((g) => `<div class="ov-group"><h4>${esc(g.name.replace(/^\d+\.\s*/, ""))}</h4><dl>${g.items.map(([h, x]) => `<dt>${esc(h)}</dt><dd>${esc(x)}</dd>`).join("")}</dl></div>`).join("")}
      <p class="small muted" style="grid-column:1/-1;margin:0">Row ${r.row} of the sheet. ${r.camp ? "Sections 1–4 and the budget allocations are kept up to date by the tracker; edit them in the tracker." : "Edit this row in the sheet, or create it in the tracker to manage it from here."}</p></div>`;
  };
  function drawStats(list) {
    const active = list.filter((r) => v(r, "Status") === "Active");
    const notInv = list.filter((r) => v(r, "Invoice Status") && v(r, "Invoice Status") !== "Invoiced");
    document.getElementById("ov-stats").innerHTML = `
      <div class="stat"><div class="n">${n(list.length)}</div><div class="l">Campaigns${list.length !== rows.length ? ` of ${n(rows.length)}` : ""}</div></div>
      <div class="stat"><div class="n">${n(active.length)}</div><div class="l">Active</div></div>
      <div class="stat money"><div class="n ov-money">${moneyLine(totalsBy(list))}</div><div class="l">Total price</div></div>
      <div class="stat money"><div class="n ov-money">${moneyLine(totalsBy(notInv))}</div><div class="l">Not invoiced yet (${n(notInv.length)})</div></div>
      <div class="stat"><div class="n">${n(list.filter((r) => r.camp).length)}</div><div class="l">In the tracker</div></div>`;
  }
  function draw() {
    const list = filtered();
    drawStats(list);
    if (!list.length) { listEl.innerHTML = `<div class="panel"><p>No campaigns match these filters.</p></div>`; return; }
    listEl.innerHTML = `<div class="table-wrap ov-table"><table>
      <thead><tr><th>Status</th><th>Artist and song</th><th>Client</th><th>DRI</th><th>Market</th><th>Start</th><th class="num">Price</th><th>Invoice</th><th>Tracker</th></tr></thead>
      <tbody>${list.map((r) => `
        <tr class="ov-row${open.has(r.row) ? " open" : ""}" data-row="${r.row}" tabindex="0" aria-expanded="${open.has(r.row)}">
          <td>${statusChip(v(r, "Status"))}</td>
          <td><div class="artist">${esc(v(r, "Artist Name") || "–")}</div><div class="song small">${esc(v(r, "Song Name (s) or Project Name"))}</div>${v(r, "Stellar PO no.") ? `<div class="muted small ov-po">${esc(v(r, "Stellar PO no."))}</div>` : ""}</td>
          <td><div>${esc(v(r, "Client"))}</div><div class="muted small">${esc(v(r, "Client Market"))}</div></td>
          <td>${esc(v(r, "Stellar DRI"))}</td>
          <td class="small">${esc(v(r, "Campaign Market"))}</td>
          <td class="small">${esc(v(r, "Start Date"))}${v(r, "Duration") ? `<div class="muted">${esc(v(r, "Duration"))}</div>` : ""}</td>
          <td class="num">${v(r, "Price") ? `${esc(v(r, "Price"))} <span class="muted small">${esc(v(r, "Currency"))}</span>` : "–"}</td>
          <td class="small">${v(r, "Invoice Status") === "Invoiced" ? `<span class="status finished">Invoiced</span>` : esc(v(r, "Invoice Status"))}${v(r, "Paid") === "Paid" ? ` <span class="status active">Paid</span>` : ""}</td>
          <td>${r.camp
            ? `<a class="btn small-btn" href="#/c/${esc(r.camp.id)}" data-stop>Open</a><div class="muted small">${r.camp.live_posts ? `${compact(r.camp.total_plays)} plays` : "no posts yet"}</div>`
            : `<button type="button" class="small-btn" data-create="${r.row}">Create</button>`}</td>
        </tr>
        ${open.has(r.row) ? `<tr class="ov-detail-row"><td colspan="9">${detail(r)}</td></tr>` : ""}`).join("")}</tbody></table></div>`;
    listEl.querySelectorAll(".ov-row").forEach((tr) => {
      const toggle = () => { const k = Number(tr.dataset.row); if (open.has(k)) open.delete(k); else open.add(k); draw(); };
      tr.onclick = (e) => { if (e.target.closest("[data-stop],[data-create]")) return; toggle(); };
      tr.onkeydown = (e) => { if (e.key === "Enter" && e.target === tr) toggle(); };
    });
    listEl.querySelectorAll("[data-create]").forEach((b) => (b.onclick = () => {
      const r = rows.find((x) => x.row === Number(b.dataset.create));
      sessionStorageSet("prefill", JSON.stringify(prefillFromRow(r)));
      go("#/new");
    }));
  }
  const bind = (elId, key) => { const el = document.getElementById(elId); el.value = st[key]; el.oninput = () => { st[key] = el.value; if (key === "status") sessionStorageSet("ov-status", el.value); draw(); }; };
  bind("ov-q", "q"); bind("ov-status", "status"); bind("ov-dri", "dri"); bind("ov-market", "market"); bind("ov-invoice", "invoice"); bind("ov-tracker", "tracker"); bind("ov-sort", "sort");
  draw();
}

// ---------- campaign list ----------
async function renderList(token) {
  app.innerHTML = `
    <div class="page-head">
      <div><h1>Campaigns</h1><p class="voice muted" id="summary" style="margin:8px 0 0;font-size:20px">&nbsp;</p></div>
      <a class="btn primary" href="#/new">New campaign</a>
    </div>
    <div class="filters">
      <input id="q" type="search" placeholder="Search artist, song, PO, client or owner" aria-label="Search campaigns">
      <select id="st" aria-label="Status">
        <option value="active">Active</option><option value="draft">Upcoming</option><option value="on_hold">On hold</option>
        <option value="finished">Completed</option><option value="">All</option>
      </select>
    </div>
    <div id="list"><p class="muted">Loading campaigns…</p></div>`;
  let rows;
  try { rows = await fetchAll(() => sb.from("campaign_summary").select("*").order("created_at", { ascending: false })); }
  catch (e) { document.getElementById("list").innerHTML = fail(e); return; }
  if (token !== routeToken) return;

  const live = rows.filter((r) => r.status === "active");
  document.getElementById("summary").textContent = live.length
    ? `${live.length} active, ${compact(live.reduce((s, r) => s + Number(r.total_plays || 0), 0))} plays between them`
    : "No active campaigns right now";
  const q = document.getElementById("q"), st = document.getElementById("st");
  const saved = sessionStorageGet("list-status");
  if (saved != null) st.value = saved;
  const draw = () => {
    const term = q.value.trim().toLowerCase();
    const shown = rows.filter((r) => (!st.value || r.status === st.value) &&
      (!term || [r.artist, r.song, r.po_number, r.client, r.campaign_runner, r.comms_owner].some((v) => (v ?? "").toLowerCase().includes(term))));
    document.getElementById("list").innerHTML = shown.length === 0
      ? `<div class="panel"><p>${rows.length === 0 ? "No campaigns yet. Create the first one to start adding links." : "No campaigns match these filters."}</p></div>`
      : `<div class="table-wrap"><table>
          <thead><tr><th>Artist and song</th><th>Client</th><th>Runner</th><th>Dates</th><th class="num">Budget</th><th class="num">Spend</th><th class="num">Live posts</th><th class="num">Plays</th><th class="num">Cost per view</th><th>Status</th></tr></thead>
          <tbody>${shown.map((r) => `
            <tr data-id="${esc(r.id)}" tabindex="0">
              <td><div class="artist">${esc(r.artist)}</div><div class="song small">${esc(r.song)}${r.po_number ? ` <span class="po">${esc(r.po_number)}</span>` : ""}</div></td>
              <td>${esc(r.client)}</td>
              <td>${esc(r.campaign_runner)}</td>
              <td class="small">${esc(date(r.start_date))}${r.end_date ? ` to ${esc(date(r.end_date))}` : ""}</td>
              <td class="num">${money(r.budget, r.currency)}</td>
              <td class="num">${Number(r.spend) ? money(r.spend, r.currency) : "–"}</td>
              <td class="num">${n(r.live_posts)}</td>
              <td class="num plays-cell">${compact(r.total_plays)}</td>
              <td class="num">${cpv(r.cost_per_view, r.currency)}</td>
              <td><span class="status ${esc(r.status)}">${esc(statusLabel(r.status))}</span>${r.invoiced ? ` <span class="status finished">invoiced</span>` : ""}</td>
            </tr>`).join("")}</tbody></table></div>`;
    document.querySelectorAll("tbody tr").forEach((tr) => {
      tr.onclick = () => go(`#/c/${tr.dataset.id}`);
      tr.onkeydown = (e) => { if (e.key === "Enter") go(`#/c/${tr.dataset.id}`); };
    });
  };
  q.oninput = draw;
  st.onchange = () => { sessionStorageSet("list-status", st.value); draw(); };
  draw();
}
function sessionStorageGet(k) { try { return sessionStorage.getItem(k); } catch { return null; } }
function sessionStorageSet(k, v) { try { sessionStorage.setItem(k, v); } catch { /* ignore */ } }

// ---------- campaign form ----------
const CURRENCIES = ["USD", "EUR", "GBP", "AUD", "JPY", "DKK", "SGD", "IDR", "THB", "PHP", "MYR", "VND", "BRL", "MXN", "COP", "ARS", "CLP"];
let MARKETS = null;   // [{ name, region, position }], the sheet's allocation columns
async function marketList() {
  if (!MARKETS) {
    const { data } = await sb.from("markets").select("name,region,position,sheet_column").order("position");
    MARKETS = data ?? [];
  }
  return MARKETS;
}

async function renderForm(token, id) {
  let c = { status: "active", currency: "USD", invoiced: false, folders_by_market: true };
  let rows = [];
  let sync = null;
  let fromSheet = null;
  if (!id) {
    // "Create in tracker" on the Campaign overview hands over the sheet row's values.
    try { fromSheet = JSON.parse(sessionStorageGet("prefill") ?? "null"); } catch { fromSheet = null; }
    sessionStorageSet("prefill", "null");
    if (fromSheet) {
      c = { ...c, ...Object.fromEntries(Object.entries(fromSheet.campaign).filter(([, x]) => x !== null && x !== undefined)) };
      rows = fromSheet.markets ?? [];
    }
  }
  const allMarkets = await marketList();
  if (id) {
    const [{ data, error }, m, s] = await Promise.all([
      sb.from("campaigns").select("*").eq("id", id).single(),
      sb.from("campaign_markets").select("market,share_percent,amount").eq("campaign_id", id),
      sb.from("campaign_sheet_sync").select("*").eq("campaign_id", id).maybeSingle(),
    ]);
    if (token !== routeToken) return;
    if (error) { app.innerHTML = fail(error); return; }
    c = data; rows = m.data ?? []; sync = s.data;
  }
  if (token !== routeToken) return;
  const v = (k) => esc(c[k] ?? "");
  const opt = (list, cur, blank = "Choose…") => `<option value="">${blank}</option>${list.map((x) => {
    const [val, label] = Array.isArray(x) ? x : [x, x];
    return `<option value="${esc(val)}" ${cur === val ? "selected" : ""}>${esc(label)}</option>`;
  }).join("")}`;
  const list = (idName, items) => `<datalist id="${idName}">${items.map((x) => `<option value="${esc(x)}">`).join("")}</datalist>`;
  // Splits are entered one way for the whole campaign: % of the budget, or amounts.
  let mode = rows.some((r) => r.amount != null) && !rows.some((r) => r.share_percent != null) ? "amount" : "percent";

  app.innerHTML = `
    <div class="page-head"><h1>${id ? "Edit campaign" : "New campaign"}</h1></div>
    ${fromSheet ? `<p class="panel small prefill-note">Filled in from row ${esc(fromSheet.sheetRow)} of the Campaign Overview sheet. Check the details, then create it: the tracker will keep that same row up to date.</p>` : ""}
    <form id="cf" class="panel form-sections" novalidate>
      <h2>Campaign</h2>
      <div class="form-grid">
        <div><label for="artist">Artist</label><input id="artist" required value="${v("artist")}"></div>
        <div><label for="song">Song or project</label><input id="song" value="${v("song")}"></div>
        <div><label for="po_number">PO number</label><input id="po_number" placeholder="#ST2109" value="${v("po_number")}" autocomplete="off">
          <p class="hint" id="po-hint">Shared with the Campaign Overview sheet. Artist, song and PO together identify the campaign.</p></div>
        <div><label for="status">Status</label><select id="status">${opt(STATUSES, c.status, "").replace('<option value=""></option>', "")}</select></div>
        <div><label for="campaign_type">Campaign type</label><input id="campaign_type" list="ctypes" value="${v("campaign_type")}" placeholder="Phase 1">${list("ctypes", CAMPAIGN_TYPES)}</div>
        <div><label for="release_type">New release or catalogue</label><select id="release_type">${opt(RELEASE_TYPES, c.release_type)}</select></div>
        <div><label for="start_date">Start date</label><input id="start_date" type="date" value="${v("start_date")}"></div>
        <div><label for="end_date">End date</label><input id="end_date" type="date" value="${v("end_date")}">
          <p class="hint">Leave empty for an ongoing campaign.</p></div>
        <div><label for="budget">Price (budget)</label><input id="budget" type="number" min="0" step="0.01" value="${v("budget")}"></div>
        <div><label for="currency">Currency</label><input id="currency" list="currencies" maxlength="3" value="${v("currency")}">${list("currencies", CURRENCIES)}</div>
        <div><label for="comms_owner">Stellar DRI</label><input id="comms_owner" value="${v("comms_owner")}"></div>
        <div><label for="campaign_runner">Campaign runner</label><input id="campaign_runner" value="${v("campaign_runner")}"></div>
      </div>

      <h2>Client</h2>
      <div class="form-grid">
        <div><label for="client">Client</label><input id="client" placeholder="Label or brand" value="${v("client")}"></div>
        <div><label for="invoicing_entity">Invoicing entity</label><input id="invoicing_entity" list="entities" value="${v("invoicing_entity")}">${list("entities", INVOICING_ENTITIES)}</div>
        <div><label for="client_country">Client location</label><input id="client_country" list="ccountries" value="${v("client_country")}" placeholder="US">${list("ccountries", CLIENT_COUNTRIES)}</div>
        <div><label for="client_market">Client market</label><select id="client_market">${opt(CLIENT_MARKETS, c.client_market)}</select></div>
        <div><label for="client_contact_name">Contact name</label><input id="client_contact_name" value="${v("client_contact_name")}"></div>
        <div><label for="client_contact_email">Contact email</label><input id="client_contact_email" type="email" value="${v("client_contact_email")}"></div>
        <div><label for="label_type">Major, indie or other</label><select id="label_type">${opt(LABEL_TYPES, c.label_type)}</select></div>
        <div><label for="under_nda">Under NDA</label><select id="under_nda">${opt([["yes", "Yes"], ["no", "No"]], c.under_nda === true ? "yes" : c.under_nda === false ? "no" : "")}</select></div>
      </div>

      <h2>Markets</h2>
      <div class="split-head">
        <p class="muted small" style="margin:0">Add each market and its share of the budget. Countries add up into their column in the sheet, e.g. Indonesia and Philippines both count towards SEA.</p>
        <div class="seg" role="group" aria-label="Enter splits as">
          <button type="button" data-mode="percent">%</button><button type="button" data-mode="amount">Amount</button>
        </div>
      </div>
      <div id="markets"></div>
      <div class="split-foot"><button type="button" id="add-market">Add market</button><span class="small muted" id="split-total"></span></div>
      <label class="check folder-opt"><input id="folders_by_market" type="checkbox" ${c.folders_by_market ? "checked" : ""}>
        <span>Create a folder for each market<br><span class="muted small">Untick to organise posts your own way, for example by creative. You can add folders on the campaign page.</span></span></label>

      <h2>Notes</h2>
      <div class="form-grid">
        <div class="field-wide"><label class="check"><input id="invoiced" type="checkbox" ${c.invoiced ? "checked" : ""}> Invoiced</label></div>
        <div class="field-wide"><label for="notes" class="sr">Notes</label><textarea id="notes" style="min-height:80px" placeholder="Anything the team should know">${v("notes")}</textarea></div>
      </div>
      ${sheetLine(sync, c)}
      <div id="form-msg"></div>
      <div class="actions">
        <button class="primary" type="submit">${id ? "Save changes" : "Create campaign"}</button>
        <a class="btn" href="${id ? `#/c/${esc(id)}` : "#/campaigns"}">Cancel</a>
        ${id ? `<button type="button" id="delete" class="danger" style="margin-left:auto">Delete campaign</button>` : ""}
      </div>
    </form>`;

  const box = document.getElementById("markets");
  const $ = (k) => document.getElementById(k);
  const budget = () => ($("budget").value === "" ? null : Number($("budget").value));
  const cur = () => $("currency").value.trim().toUpperCase() || "";
  const fmt = (x) => Number(x).toLocaleString("en-GB", { maximumFractionDigits: 2 });

  const addRow = (m = {}) => {
    const row = document.createElement("div");
    row.className = "markets-row";
    const val = mode === "percent" ? (m.share_percent ?? (m.amount != null && budget() ? +(m.amount / budget() * 100).toFixed(2) : ""))
      : (m.amount ?? (m.share_percent != null && budget() != null ? +(budget() * m.share_percent / 100).toFixed(2) : ""));
    const groups = [["West", "West"], ["Central", "Central"], ["East", "East"], ["Other", "Global"]];
    row.innerHTML = `<select aria-label="Market"><option value="">Choose a market</option>${groups.map(([r, label]) => `<optgroup label="${label}">${allMarkets.filter((x) => x.region === r).map((x) =>
        `<option value="${esc(x.name)}" ${m.market === x.name ? "selected" : ""}>${esc(x.name)}${x.sheet_column && x.sheet_column !== x.name ? ` (${esc(x.sheet_column)})` : ""}</option>`).join("")}</optgroup>`).join("")}</select>
      <input aria-label="${mode === "percent" ? "Share in percent" : "Amount"}" type="number" min="0" ${mode === "percent" ? 'max="100"' : ""} step="0.01" placeholder="${mode === "percent" ? "%" : "Amount"}" value="${esc(val)}">
      <span class="small muted other"></span>
      <button type="button" class="link-btn danger">Remove</button>`;
    row.querySelector("button").onclick = () => { row.remove(); totals(); };
    row.querySelectorAll("input,select").forEach((i) => (i.oninput = totals));
    box.appendChild(row);
  };
  const readRows = () => [...box.querySelectorAll(".markets-row")].map((r) => {
    const market = r.querySelector("select").value;
    const raw = r.querySelector("input").value;
    const x = raw === "" ? null : Number(raw);
    const b = budget();
    return mode === "percent"
      ? { market, share_percent: x, amount: x != null && b != null ? Math.round(b * x) / 100 : null, _row: r }
      : { market, amount: x, share_percent: x != null && b ? Math.round((x / b) * 10000) / 100 : null, _row: r };
  });
  function totals() {
    const rs = readRows();
    for (const r of rs) {
      r._row.querySelector(".other").textContent = mode === "percent"
        ? (r.amount != null ? `${fmt(r.amount)} ${cur()}` : "")
        : (r.share_percent != null ? `${fmt(r.share_percent)}%` : "");
    }
    const pct = rs.reduce((s, r) => s + (r.share_percent ?? 0), 0);
    const amt = rs.reduce((s, r) => s + (r.amount ?? 0), 0);
    $("split-total").textContent = !rs.length ? "" : mode === "percent"
      ? `${fmt(pct)}% allocated${budget() != null ? ` · ${fmt(amt)} of ${fmt(budget())} ${cur()}` : ""}`
      : `${fmt(amt)}${budget() != null ? ` of ${fmt(budget())}` : ""} ${cur()} allocated${budget() ? ` · ${fmt(pct)}%` : ""}`;
  }
  const setMode = (m) => {
    const current = readRows().filter((r) => r.market || r.share_percent != null || r.amount != null);
    mode = m;
    document.querySelectorAll("[data-mode]").forEach((b) => b.setAttribute("aria-pressed", b.dataset.mode === mode));
    box.innerHTML = "";
    current.forEach(addRow);
    totals();
  };
  document.querySelectorAll("[data-mode]").forEach((b) => (b.onclick = () => setMode(b.dataset.mode)));
  document.querySelectorAll("[data-mode]").forEach((b) => b.setAttribute("aria-pressed", b.dataset.mode === mode));
  rows.sort((a, b) => allMarkets.findIndex((x) => x.name === a.market) - allMarkets.findIndex((x) => x.name === b.market)).forEach(addRow);
  if (!rows.length) addRow();
  totals();
  $("add-market").onclick = () => addRow();
  if (!id) suggestPO();
  $("po_number").onblur = () => { const po = normalisePO($("po_number").value); if (po) $("po_number").value = po; };
  $("budget").oninput = totals;
  $("currency").oninput = totals;

  $("cf").addEventListener("submit", async (e) => {
    e.preventDefault();
    const msg = $("form-msg");
    const val = (k) => $(k).value.trim();
    const currency = cur();
    if (!val("artist")) { msg.innerHTML = fail("Add the artist's name."); $("artist").focus(); return; }
    if (currency && !/^[A-Z]{3}$/.test(currency)) { msg.innerHTML = fail("Currency must be a three-letter code, such as EUR or USD."); return; }
    if (val("start_date") && val("end_date") && val("end_date") < val("start_date")) { msg.innerHTML = fail("The end date is before the start date."); return; }
    const ms = readRows().filter((r) => r.market || r.share_percent != null || r.amount != null);
    if (ms.some((r) => !r.market)) { msg.innerHTML = fail("Choose a market for each row, or remove the empty row."); return; }
    if (new Set(ms.map((r) => r.market)).size !== ms.length) { msg.innerHTML = fail("Each market can only be listed once."); return; }
    const pct = ms.reduce((s, r) => s + (r.share_percent ?? 0), 0);
    const amt = ms.reduce((s, r) => s + (r.amount ?? 0), 0);
    if (mode === "percent" && pct > 100.001) { msg.innerHTML = fail(`Market shares add up to ${fmt(pct)}%. They can't be more than 100%.`); return; }
    if (mode === "amount" && budget() != null && amt > budget() + 0.001) { msg.innerHTML = fail(`Market amounts add up to ${fmt(amt)}, more than the ${fmt(budget())} budget.`); return; }

    const record = {
      artist: val("artist"), song: val("song") || null, po_number: normalisePO(val("po_number")),
      status: val("status"), campaign_type: val("campaign_type") || null, release_type: val("release_type") || null,
      start_date: val("start_date") || null, end_date: val("end_date") || null,
      budget: budget(), currency: currency || null,
      comms_owner: val("comms_owner") || null, campaign_runner: val("campaign_runner") || null,
      client: val("client") || null, invoicing_entity: val("invoicing_entity") || null, client_country: val("client_country") || null,
      client_market: val("client_market") || null, client_contact_name: val("client_contact_name") || null,
      client_contact_email: val("client_contact_email") || null, label_type: val("label_type") || null,
      under_nda: val("under_nda") === "yes" ? true : val("under_nda") === "no" ? false : null,
      folders_by_market: $("folders_by_market").checked,
      invoiced: $("invoiced").checked, notes: val("notes") || null,
    };
    const btn = e.submitter ?? document.querySelector("#cf button[type=submit]"); btn.disabled = true;
    const failWith = (err) => {
      btn.disabled = false;
      msg.innerHTML = fail(err?.code === "23505" ? "Another campaign already has this artist, song and PO number." : err);
    };
    const res = id
      ? await sb.from("campaigns").update(record).eq("id", id).select("id").single()
      : await sb.from("campaigns").insert(record).select("id").single();
    if (res.error) return failWith(res.error);
    const cid = res.data.id;

    // Market splits: remove the ones taken off, then save the rest.
    const keep = ms.map((r) => r.market);
    let del = sb.from("campaign_markets").delete().eq("campaign_id", cid);
    if (keep.length) del = del.not("market", "in", `(${keep.map((k) => `"${k}"`).join(",")})`);
    const d = await del;
    if (d.error) return failWith(d.error);
    if (ms.length) {
      const up = await sb.from("campaign_markets").upsert(ms.map(({ market, share_percent, amount }) => ({ campaign_id: cid, market, share_percent, amount })), { onConflict: "campaign_id,market" });
      if (up.error) return failWith(up.error);
    }
    if (record.folders_by_market) {
      const err = await syncMarketFolders(cid, keep, allMarkets);
      if (err) return failWith(err);
    }
    toast(id ? "Changes saved" : "Campaign created");
    go(`#/c/${cid}`);
  });

  const del = $("delete");
  if (del) del.onclick = async () => {
    if (!confirm(`Delete "${c.artist}${c.song ? ` – ${c.song}` : ""}" and all its posts? This can't be undone. Its row in the Campaign Overview sheet stays as it is.`)) return;
    const { error } = await sb.from("campaigns").delete().eq("id", id);
    if (error) { $("form-msg").innerHTML = fail(error); return; }
    toast("Campaign deleted"); go("#/campaigns");
  };
}

// One folder per market: add folders for new markets; remove folders for markets taken off,
// but only when they're empty and have no client link.
async function syncMarketFolders(cid, keep, allMarkets) {
  const { data: folders, error } = await sb.from("campaign_folders").select("id,name,market").eq("campaign_id", cid);
  if (error) return error;
  const have = new Set((folders ?? []).flatMap((f) => [f.market, f.name]).filter(Boolean));
  const add = keep.filter((m) => !have.has(m)).map((m) => ({ campaign_id: cid, name: m, market: m, position: allMarkets.find((x) => x.name === m)?.position ?? 0 }));
  if (add.length) {
    const r = await sb.from("campaign_folders").insert(add);
    if (r.error) return r.error;
  }
  const gone = (folders ?? []).filter((f) => f.market && !keep.includes(f.market));
  for (const f of gone) {
    const [{ count }, { data: links }] = await Promise.all([
      sb.from("posts").select("id", { count: "exact", head: true }).eq("folder_id", f.id),
      sb.from("share_links").select("id").eq("folder_id", f.id).eq("revoked", false).limit(1),
    ]);
    if (!count && !links?.length) await sb.from("campaign_folders").delete().eq("id", f.id);
  }
  return null;
}

// New campaigns: fill in the next free PO number (one above the highest in the sheet and the tracker).
async function suggestPO() {
  const input = document.getElementById("po_number"), hint = document.getElementById("po-hint");
  if (!input || input.value) return;
  input.placeholder = "Finding the next PO…";
  const { data, error } = await sb.functions.invoke("sheet-sync", { body: { action: "next_po" } });
  if (!document.body.contains(input)) return;
  input.placeholder = "#ST2109";
  if (error || !data?.po) return;
  if (!input.value) {
    input.value = data.po;
    hint.textContent = data.sheet_error
      ? `Suggested from the tracker only (couldn't read the sheet). Check it's free before saving.`
      : `Next free PO after ${data.po.replace(/\d+$/, (d) => d - 1)} in the Campaign Overview sheet. Change it if you need to.`;
  }
}

// Where this campaign stands in the Campaign Overview sheet.
function sheetLine(sync, c) {
  if (!c?.id) return `<p class="sheet-line small muted">Saving adds this campaign to the Campaign Overview sheet once it has a PO number.</p>`;
  if (!c.po_number) return `<p class="sheet-line small muted">Not in the Campaign Overview sheet yet: add a PO number to send it.</p>`;
  if (!sync) return "";
  if (sync.due_at && !sync.synced_at) return `<p class="sheet-line small muted">Sending to the Campaign Overview sheet…</p>`;
  if (sync.last_error && !(sync.last_error.startsWith("Columns not found") && sync.synced_at)) return `<p class="sheet-line small warn-note">Campaign Overview sheet: ${esc(sync.last_error)}${sync.due_at ? " Trying again shortly." : ""}</p>`;
  if (sync.synced_at) return `<p class="sheet-line small muted">In the Campaign Overview sheet, row ${esc(sync.sheet_row)}. Updated ${esc(timeAgo(sync.synced_at))}${sync.due_at ? "; new changes are on their way" : ""}.</p>`;
  return "";
}

// ---------- campaign dashboard ----------
async function renderCampaign(token, id) {
  app.innerHTML = `<p class="muted pad">Loading campaign…</p>`;
  const { data: c, error } = await sb.from("campaign_summary").select("*").eq("id", id).maybeSingle();
  if (token !== routeToken) return;
  if (error || !c) { app.innerHTML = fail(error ?? "This campaign doesn't exist or was deleted."); return; }

  const [markets, daily, latest, sync] = await Promise.all([
    sb.from("campaign_markets").select("market,share_percent,amount").eq("campaign_id", id),
    sb.from("campaign_daily_stats").select("*").eq("campaign_id", id).order("stat_date"),
    sb.from("posts").select("last_checked_at").eq("campaign_id", id).not("last_checked_at", "is", null).order("last_checked_at", { ascending: false }).limit(1),
    sb.from("campaign_sheet_sync").select("*").eq("campaign_id", id).maybeSingle(),
  ]);
  if (token !== routeToken) return;
  const all = await marketList();
  const mk = (markets.data ?? []).sort((a, b) => all.findIndex((x) => x.name === a.market) - all.findIndex((x) => x.name === b.market))
    .map((m) => `${m.market}${m.amount != null ? ` ${money(m.amount, c.currency)}` : m.share_percent != null ? ` ${m.share_percent}%` : ""}`).join(", ");
  const lastChecked = latest.data?.[0]?.last_checked_at;

  app.innerHTML = `
    <section class="band on-blue">
      <div class="hero">
        <div>
          <a href="#/campaigns" class="back">All campaigns</a>
          <h1>${esc(c.artist)}</h1>
          ${c.song ? `<div class="voice">${esc(c.song)}</div>` : ""}
          <div class="meta">
            <span class="status">${esc(statusLabel(c.status))}</span>${c.po_number ? `<span>PO ${esc(c.po_number)}</span>` : ""}
            ${c.client ? `<span>Client: ${esc(c.client)}</span>` : ""}
            ${c.campaign_runner ? `<span>Runner: ${esc(c.campaign_runner)}</span>` : ""}
            ${c.comms_owner ? `<span>DRI: ${esc(c.comms_owner)}</span>` : ""}
            ${c.start_date ? `<span>${esc(date(c.start_date))}${c.end_date ? ` to ${esc(date(c.end_date))}` : ""}</span>` : ""}
            ${mk ? `<span>Markets: ${esc(mk)}</span>` : ""}
          </div>
          ${sheetLine(sync.data, c)}
          <div class="actions">
            <a class="btn primary" href="#/c/${esc(id)}/add">Add links</a>
            <button type="button" id="refresh">Refresh numbers</button>
            <a class="btn" href="#/report/${encodeURIComponent(c.artist.trim())}">Client view</a>
            <button type="button" id="share-btn" aria-expanded="false" aria-controls="share-panel">Share with client</button>
            <a class="btn" href="#/c/${esc(id)}/edit">Edit details</a>
            <span class="updated" id="updated">${lastChecked ? `Numbers from ${esc(timeAgo(lastChecked))}` : ""}</span>
          </div>
        </div>
        <div class="plays-big"><div class="n">${n(c.total_plays)}</div><div class="l">plays across ${n(c.live_posts)} live post${c.live_posts === 1 ? "" : "s"}</div></div>
      </div>
    </section>
    <section id="share-panel" class="panel share-panel" hidden></section>
    <div class="stats">
      <div class="stat"><div class="n">${compact(c.total_likes)}</div><div class="l">Likes</div></div>
      <div class="stat"><div class="n">${compact(c.total_comments)}</div><div class="l">Comments</div></div>
      <div class="stat"><div class="n">${compact(c.total_shares)}</div><div class="l">Shares</div></div>
      <div class="stat money"><div class="n">${money(c.budget, c.currency)}</div><div class="l">Budget</div></div>
      <div class="stat money"><div class="n">${money(c.spend, c.currency)}</div><div class="l">Spend</div></div>
      <div class="stat money"><div class="n">${c.budget != null ? money(c.margin, c.currency) : "–"}</div><div class="l">Margin</div></div>
      <div class="stat money"><div class="n">${cpv(c.cost_per_view, c.currency)}</div><div class="l">Cost per view</div></div>
    </div>
    <div class="section-head"><h2>Plays per day</h2></div>
    <div id="chart"></div>
    <div class="section-head"><h2>Sounds</h2></div>
    <div id="sounds"><p class="muted">Loading sounds…</p></div>
    <div class="section-head">
      <h2>Posts</h2>
      <div class="posts-tools">
        <div class="seg" role="group" aria-label="Layout"><button type="button" data-pview="folders">Folders</button><button type="button" data-pview="grid">All posts</button></div>
        <button type="button" id="new-folder">New folder</button>
        <button type="button" id="pick-toggle" aria-pressed="false">Select posts</button>
        <label class="small" style="display:flex;gap:8px;align-items:center;margin:0">Sort by
          <select id="sort" style="width:auto"><option value="plays">Most plays</option><option value="newest">Newest first</option><option value="added">Recently added</option></select>
        </label>
      </div>
    </div>
    <div id="folders" class="folders"></div>
    <section id="folder-panel" class="panel share-panel" hidden></section>
    <div id="pick-bar" class="pick-bar" hidden></div>
    <div id="posts"><p class="muted">Loading posts…</p></div>`;

  drawChart(document.getElementById("chart"), daily.data ?? []);
  loadSounds(token, id);
  loadPosts(token, id, c);
  document.getElementById("share-btn").onclick = (e) => toggleSharePanel(e.currentTarget, c);

  document.getElementById("refresh").onclick = async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true; btn.textContent = "Refreshing…";
    document.getElementById("updated").textContent = "Getting the latest numbers from TikTok. This can take a minute.";
    const { data, error } = await sb.functions.invoke("refresh-stats", { body: { campaign_id: id } });
    if (token !== routeToken) return;
    if (error || data?.error) {
      btn.disabled = false; btn.textContent = "Refresh numbers";
      document.getElementById("updated").textContent = `Couldn't refresh: ${data?.error ?? error.message}`;
      return;
    }
    const ok = data.videos?.ok ?? 0, gone = data.videos?.unavailable ?? 0;
    toast(ok || gone
      ? `Updated ${ok} post${ok === 1 ? "" : "s"}${gone ? `, ${gone} no longer on TikTok` : ""}${data.skipped_recent ? `. ${data.skipped_recent} were already up to date` : ""}`
      : "Everything was updated in the last hour already");
    renderCampaign(++routeToken, id);
  };
}

// ---------- client link ----------
// One link per artist: the client sees every non-draft campaign for that artist, with no money.
const shareUrl = (t) => new URL(`share.html#t=${t}`, location.origin + location.pathname).toString();
const sameArtist = (a, b) => (a ?? "").trim().toLowerCase() === (b ?? "").trim().toLowerCase();

async function toggleSharePanel(btn, c) {
  const panel = document.getElementById("share-panel");
  const open = panel.hidden;
  panel.hidden = !open;
  btn.setAttribute("aria-expanded", open);
  if (open) await drawSharePanel(panel, c);
}

async function drawSharePanel(panel, c) {
  panel.innerHTML = `<p class="muted small">Checking for an existing link…</p>`;
  const [{ data: links, error }, { data: camps }] = await Promise.all([
    sb.from("share_links").select("id,artist,token,created_at,created_by,settings").eq("revoked", false).not("artist", "is", null).order("created_at", { ascending: false }),
    sb.from("campaigns").select("id,artist,song,status").order("created_at"),
  ]);
  if (error) { panel.innerHTML = fail(error); return; }
  const link = (links ?? []).find((l) => sameArtist(l.artist, c.artist));
  const shown = (camps ?? []).filter((x) => sameArtist(x.artist, c.artist) && x.status !== "draft");
  const hidden = new Set(link?.settings?.hidden_campaigns ?? []);
  const visible = shown.filter((x) => !hidden.has(x.id));
  const what = `The client sees ${visible.length === 1 ? (visible[0].song ? `the ${esc(visible[0].song)} campaign` : "1 campaign") : `${visible.length} of ${esc(c.artist)}'s campaigns`}, with whatever you switch on below. Upcoming campaigns aren't shown until they go active. <b>Budgets, spend, margins and creator costs are never shown.</b>`;
  const draftNote = c.status === "draft" ? `<p class="small warn-note">This campaign is upcoming, so it won't appear on the client link until you set it to active.</p>` : "";
  if (!link) {
    panel.innerHTML = `<h2>Share with client</h2><p class="small">${what}</p>${draftNote}
      <div class="actions"><button type="button" class="primary" id="share-create">Create client link</button></div>`;
    document.getElementById("share-create").onclick = async (e) => {
      e.currentTarget.disabled = true;
      const { error: err } = await sb.from("share_links").insert({ artist: c.artist.trim() });
      if (err) { panel.insertAdjacentHTML("beforeend", fail(err)); e.currentTarget.disabled = false; return; }
      toast("Client link created");
      drawSharePanel(panel, c);
    };
    return;
  }
  const url = shareUrl(link.token);
  panel.innerHTML = `<h2>Client link for ${esc(c.artist)}</h2><p class="small">${what}</p>${draftNote}
    <div class="share-row"><input id="share-url" readonly value="${esc(url)}" aria-label="Client link">
      <button type="button" class="primary" id="share-copy">Copy link</button>
      <a class="btn" href="${esc(url)}" target="_blank" rel="noopener">Open</a></div>
    <p class="muted small">Created ${esc(date(link.created_at))}${link.created_by ? ` by ${esc(link.created_by)}` : ""}.
      <button type="button" class="link-btn danger small" id="share-off">Turn off this link</button></p>
    <div class="settings" id="share-settings"></div>`;
  drawLinkSettings(document.getElementById("share-settings"), link, (camps ?? []).filter((x) => sameArtist(x.artist, c.artist)));
  const input = document.getElementById("share-url");
  input.onfocus = () => input.select();
  document.getElementById("share-copy").onclick = async () => {
    try { await navigator.clipboard.writeText(url); toast("Link copied"); }
    catch { input.select(); toast("Press Cmd+C to copy"); }
  };
  document.getElementById("share-off").onclick = async () => {
    if (!confirm(`Turn off the client link for ${c.artist}? Anyone with it will see "This link isn't active". You can create a new one afterwards.`)) return;
    const { error: err } = await sb.from("share_links").update({ revoked: true }).eq("id", link.id);
    if (err) { toast(err.message); return; }
    toast("Link turned off");
    drawSharePanel(panel, c);
  };
}

// What a client link shows. Missing keys mean "on"; the share function enforces these on the server.
const LINK_DEFAULTS = { overview: true, overview_chart: true, sounds: true, songs: true, songs_chart: true, countries: true, countries_chart: true, posts: true, posts_country_filter: true, show_country: true, show_followers: true, folders: true };
function drawLinkSettings(el, link, camps) {
  const S = { ...LINK_DEFAULTS, ...(link.settings ?? {}), hidden_campaigns: [...(link.settings?.hidden_campaigns ?? [])] };
  const row = (key, label, { sub = false, parent = null, off = false, note = "" } = {}) => {
    const disabled = (parent && !S[parent]) || (key !== "show_country" && ["countries", "countries_chart", "posts_country_filter"].includes(key) && !S.show_country);
    return `<label class="row${sub ? " sub" : ""}"><span>${label}${note ? ` <span class="muted small">${note}</span>` : ""}</span>
      <span class="switch"><input type="checkbox" data-key="${key}" ${S[key] && !disabled && !off ? "checked" : ""} ${disabled ? "disabled" : ""}><span></span></span></label>`;
  };
  el.innerHTML = `
    <h2 style="margin-bottom:2px">Link settings</h2>
    <p class="muted small" style="margin-top:0">Changes apply to the link straight away. Anything switched off is never sent to the client's browser.</p>
    <h3>Analytics</h3>
    ${row("overview", "Overview numbers")}
    ${row("overview_chart", "Overview chart", { sub: true, parent: "overview" })}
    ${row("sounds", "Sound analytics")}
    ${row("songs", "Song analytics")}
    ${row("songs_chart", "Songs chart", { sub: true, parent: "songs" })}
    ${link.folder_id ? "" : row("folders", "Market and folder breakdown", { note: "folders hidden from clients are never named" })}
    ${row("countries", "Country analytics")}
    ${row("countries_chart", "Countries chart", { sub: true, parent: "countries" })}
    <h3>Posts</h3>
    ${row("posts", "Post wall")}
    ${row("posts_country_filter", "Country filter", { sub: true, parent: "posts" })}
    ${camps.length ? "<h3>Campaigns</h3>" : ""}
    ${camps.map((x) => x.status === "draft"
      ? `<label class="row"><span>${esc(x.song ?? "Untitled")} <span class="muted small">upcoming, not shown yet</span></span><span class="switch"><input type="checkbox" disabled><span></span></span></label>`
      : `<label class="row"><span>${esc(x.song ?? "Untitled")}</span><span class="switch"><input type="checkbox" data-camp="${esc(x.id)}" ${S.hidden_campaigns.includes(x.id) ? "" : "checked"}><span></span></span></label>`).join("")}
    <h3>Creators</h3>
    ${row("show_country", "Creator country", { note: "also used for country analytics" })}
    ${row("show_followers", "Creator follower counts")}
    <p class="never">Budgets, spend, margins and creator costs can't be shown on client links.</p>`;
  const save = async () => {
    const { error } = await sb.from("share_links").update({ settings: S, updated_at: new Date().toISOString() }).eq("id", link.id);
    if (error) { toast(`Couldn't save: ${error.message}`); return; }
    link.settings = { ...S };
    toast("Link settings saved");
    drawLinkSettings(el, link, camps);
    const intro = el.closest(".share-panel")?.querySelector("p.small");
    if (intro) intro.dataset.stale = "1";
  };
  el.querySelectorAll("[data-key]").forEach((i) => i.onchange = () => { S[i.dataset.key] = i.checked; save(); });
  el.querySelectorAll("[data-camp]").forEach((i) => i.onchange = () => {
    const id = i.dataset.camp;
    S.hidden_campaigns = i.checked ? S.hidden_campaigns.filter((x) => x !== id) : [...new Set([...S.hidden_campaigns, id])];
    save();
  });
}

function timeAgo(iso) {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const h = Math.round(mins / 60);
  if (h < 24) return `${h} hour${h === 1 ? "" : "s"} ago`;
  return new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

function drawChart(el, rows) {
  if (rows.length < 2) {
    el.innerHTML = `<div class="panel"><p class="muted small">The daily chart fills in once stats have been collected on two or more days.</p></div>`;
    return;
  }
  // Draw at the container's real width so text stays readable on phones.
  const W = Math.max(280, Math.round(el.clientWidth - 32)), H = 200, P = 28;
  const max = Math.max(...rows.map((r) => Number(r.plays) || 0), 1);
  const x = (i) => P + (i / (rows.length - 1)) * (W - 2 * P);
  const y = (v) => H - P - ((Number(v) || 0) / max) * (H - 2 * P);
  const pts = rows.map((r, i) => `${x(i).toFixed(1)},${y(r.plays).toFixed(1)}`).join(" ");
  const last = rows.at(-1);
  el.innerHTML = `<div class="chart"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Total plays per day, from ${esc(date(rows[0].stat_date))} to ${esc(date(last.stat_date))}">
    <line x1="${P}" x2="${W - P}" y1="${H - P}" y2="${H - P}" stroke="#e3e5eb"/>
    <polygon points="${x(0).toFixed(1)},${H - P} ${pts} ${x(rows.length - 1).toFixed(1)},${H - P}" fill="#0626c7" fill-opacity="0.08"/>
    <polyline points="${pts}" fill="none" stroke="#0626c7" stroke-width="2.5" stroke-linejoin="round"/>
    ${rows.map((r, i) => `<circle cx="${x(i)}" cy="${y(r.plays)}" r="3.5" fill="#0626c7"><title>${esc(date(r.stat_date))}: ${n(r.plays)} plays</title></circle>`).join("")}
    <text x="${P}" y="${H - 8}" font-size="12" fill="#6b6f7a">${esc(date(rows[0].stat_date))}</text>
    <text x="${W - P}" y="${H - 8}" font-size="12" fill="#6b6f7a" text-anchor="end">${esc(date(last.stat_date))}</text>
    <text x="${W - P}" y="${y(last.plays) - 10}" font-size="13" font-weight="700" fill="#282828" text-anchor="end">${compact(last.plays)}</text>
  </svg></div>`;
}

async function loadSounds(token, id) {
  const el = document.getElementById("sounds");
  const { data, error } = await sb.from("campaign_sounds")
    .select("sound:sounds(id,title,author,matched_song_title,matched_song_author,cover_url,sound_url)").eq("campaign_id", id);
  if (token !== routeToken) return;
  if (error) { el.innerHTML = fail(error); return; }
  const sounds = data.map((d) => d.sound).filter(Boolean);
  if (!sounds.length) { el.innerHTML = `<p class="muted small">Sounds appear here automatically when you add links.</p>`; return; }
  const counts = {};
  const { data: sd } = await sb.from("sound_daily_stats").select("sound_id,stat_date,video_count")
    .in("sound_id", sounds.map((s) => s.id)).order("stat_date", { ascending: false });
  for (const r of sd ?? []) if (!(r.sound_id in counts)) counts[r.sound_id] = r;
  if (token !== routeToken) return;
  el.innerHTML = `<div class="sounds">${sounds.map((s) => `
    <div class="sound">
      ${s.cover_url ? `<img src="${esc(s.cover_url)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'ph'}))">` : `<div class="ph"></div>`}
      <div>
        <div class="t"><a href="${esc(s.sound_url)}" target="_blank" rel="noopener">${esc(s.title ?? "Untitled sound")}</a></div>
        <div class="s">${esc(s.author ?? "")}${s.matched_song_title && s.matched_song_title !== s.title ? ` · song: ${esc(s.matched_song_title)}` : ""}</div>
        <div class="s">${counts[s.id] ? `<span class="count">${n(counts[s.id].video_count)}</span> videos use it (${esc(date(counts[s.id].stat_date))})` : "Video count arrives with the daily refresh"}</div>
      </div>
    </div>`).join("")}</div>`;
}

async function loadPosts(token, id, camp) {
  const el = document.getElementById("posts");
  let posts, folders, folderLinks = {};
  try {
    [posts, { data: folders }] = await Promise.all([
      fetchAll(() => sb.from("posts")
        .select("id,folder_id,tiktok_video_id,url,caption,published_at,country_code,cover_path,status,created_at,sound:sounds(title),creator:creators(username,display_name,follower_count,is_verified,avatar_url,country_code)")
        .eq("campaign_id", id).order("created_at", { ascending: false })),
      sb.from("campaign_folders").select("id,name,market,position,hidden,created_at").eq("campaign_id", id).order("position").order("created_at"),
    ]);
    folderLinks = Object.fromEntries(((await sb.from("share_links").select("id,token,folder_id").eq("campaign_id", id).eq("revoked", false).not("folder_id", "is", null)).data ?? []).map((l) => [l.folder_id, l]));
  } catch (e) { el.innerHTML = fail(e); return; }
  if (token !== routeToken) return;
  folders = folders ?? [];
  const ids = [...new Set(posts.map((p) => p.tiktok_video_id))];
  const stats = Object.fromEntries((await inChunks(ids, 150, async (chunk) => {
    const { data } = await sb.from("post_latest_stats").select("*").in("tiktok_video_id", chunk);
    return data ?? [];
  })).map((s) => [s.tiktok_video_id, s]));
  const paths = posts.map((p) => p.cover_path).filter(Boolean);
  const byPath = Object.fromEntries((await inChunks(paths, 200, async (chunk) => {
    const { data } = await sb.storage.from("covers").createSignedUrls(chunk, 3600);
    return data ?? [];
  })).filter((c) => c.signedUrl).map((c) => [c.path, c.signedUrl]));
  if (token !== routeToken) return;

  const list = posts.map((p) => {
    const st = stats[p.tiktok_video_id] ?? {};
    return {
      id: p.id, campaign_id: id, folder_id: p.folder_id, video_id: p.tiktok_video_id, url: p.url, caption: p.caption, published_at: p.published_at, created_at: p.created_at,
      country: p.creator?.country_code ?? p.country_code ?? null, sound_title: p.sound?.title ?? null, gone: p.status !== "active", has_cover: !!p.cover_path,
      creator: p.creator ? { username: p.creator.username, name: p.creator.display_name, followers: p.creator.follower_count, verified: p.creator.is_verified, avatar: p.creator.avatar_url } : null,
      plays: st.plays ?? null, likes: st.likes ?? null, comments: st.comments ?? null, shares: st.shares ?? null, stats_date: st.stat_date ?? null,
    };
  });
  const folderName = (fid) => folders.find((f) => f.id === fid)?.name ?? "";
  let current = sessionStorageGet(`folder-${id}`) ?? "";   // "" all, "none" not in a folder, or a folder id
  if (current && current !== "none" && !folders.some((f) => f.id === current)) current = "";

  const ctx = {
    mode: "team",
    covers: Object.fromEntries(posts.filter((p) => byPath[p.cover_path]).map((p) => [p.tiktok_video_id, byPath[p.cover_path]])),
    postDaily: async (vid) => (await sb.from("post_daily_stats").select("stat_date,plays,likes,comments,shares").eq("tiktok_video_id", vid).order("stat_date")).data ?? [],
    remove: async (p) => { const { error } = await sb.from("posts").delete().eq("id", p.id); if (error) toast(error.message); return !error; },
    onRemoved: () => renderCampaign(++routeToken, id),
    showCountry: true,
    folders,
    folderOf: folders.length ? (p) => folderName(p.folder_id) : null,
    move: async (items, folderId) => {
      const { error } = await sb.from("posts").update({ folder_id: folderId }).in("id", items.map((p) => p.id));
      if (error) { toast(error.message); return false; }
      for (const p of items) { const x = list.find((y) => y.id === p.id); if (x) x.folder_id = folderId; }
      toast(`${items.length === 1 ? "Post" : `${items.length} posts`} moved to ${folderId ? folderName(folderId) : "no folder"}`);
      drawFolders(); draw();
      return true;
    },
    selected: null,
    onSelect: () => drawPickBar(),
  };

  const sortSel = document.getElementById("sort");
  const folderEl = document.getElementById("folders");
  const gridPanel = document.getElementById("folder-panel");
  const pickBar = document.getElementById("pick-bar");
  const pickBtn = document.getElementById("pick-toggle");
  let shown = 48;
  const inView = () => list.filter((p) => !current || (current === "none" ? !p.folder_id : p.folder_id === current));
  const sum = (ps) => ps.reduce((s, p) => s + (p.gone ? 0 : Number(p.plays ?? 0)), 0);

  function drawFolders() {
    if (!folders.length) {
      folderEl.innerHTML = camp.folders_by_market
        ? `<p class="muted small">Folders appear here for each market you add to the campaign.</p>`
        : `<p class="muted small">No folders yet. Use <b>New folder</b> to group posts, for example by creative.</p>`;
      return;
    }
    const loose = list.filter((p) => !p.folder_id);
    const card = (key, name, ps, f) => `
      <div class="folder${current === key ? " on" : ""}${f?.hidden ? " is-hidden" : ""}">
        <button type="button" class="folder-main" data-folder="${esc(key)}" aria-pressed="${current === key}">
          <span class="folder-name">${esc(name)}</span>
          <span class="folder-n">${compact(sum(ps))} plays</span>
          <span class="muted small">${n(ps.length)} post${ps.length === 1 ? "" : "s"}${f?.hidden ? " · hidden from clients" : ""}</span>
        </button>
        ${f ? `<button type="button" class="folder-more" data-fmenu="${esc(f.id)}" aria-label="Options for ${esc(f.name)}" title="Folder options">⋯</button>` : ""}
      </div>`;
    folderEl.innerHTML = `<div class="folder-row">
      ${card("", "All posts", list)}
      ${folders.map((f) => card(f.id, f.name, list.filter((p) => p.folder_id === f.id), f)).join("")}
      ${loose.length ? card("none", "Not in a folder", loose) : ""}
    </div>`;
    folderEl.querySelectorAll("[data-folder]").forEach((b) => (b.onclick = () => {
      current = b.dataset.folder; sessionStorageSet(`folder-${id}`, current); shown = 48;
      drawFolders(); draw();
    }));
    folderEl.querySelectorAll("[data-fmenu]").forEach((b) => (b.onclick = () => openFolderPanel(folders.find((f) => f.id === b.dataset.fmenu))));
  }

  async function openFolderPanel(f, panel = gridPanel) {
    if (!panel.hidden && panel.dataset.folder === f.id) { panel.hidden = true; return; }
    panel.hidden = false; panel.dataset.folder = f.id;
    panel.innerHTML = `<p class="muted small">Loading…</p>`;
    const { data: link } = await sb.from("share_links").select("id,token,created_at,created_by,settings,folder_id").eq("folder_id", f.id).eq("revoked", false).order("created_at", { ascending: false }).limit(1).maybeSingle();
    const count = list.filter((p) => p.folder_id === f.id).length;
    const url = link ? shareUrl(link.token) : null;
    panel.innerHTML = `
      <div class="folder-panel-head">
        <h2>${esc(f.name)}</h2>
        <button type="button" class="link-btn" id="fp-close">Close</button>
      </div>
      <div class="form-grid">
        <div><label for="fp-name">Folder name</label><div class="share-row"><input id="fp-name" value="${esc(f.name)}"><button type="button" id="fp-rename">Rename</button></div></div>
        <div><label class="row"><span>Show this folder on client links<br><span class="muted small">When off, its posts still count in the campaign's totals but aren't named as a separate ${f.market ? "market" : "folder"}.</span></span>
          <span class="switch"><input type="checkbox" id="fp-visible" ${f.hidden ? "" : "checked"}><span></span></span></label></div>
      </div>
      <h3>Client link for this folder</h3>
      <p class="small">The client sees only this folder's posts and numbers${camp.status === "draft" ? ", once the campaign is active" : ""}. <b>Budgets, spend and margins are never shown.</b></p>
      ${link ? `<div class="share-row"><input id="fp-url" readonly value="${esc(url)}" aria-label="Folder client link">
          <button type="button" class="primary" id="fp-copy">Copy link</button>
          <a class="btn" href="${esc(url)}" target="_blank" rel="noopener">Open</a></div>
        <p class="muted small">Created ${esc(date(link.created_at))}${link.created_by ? ` by ${esc(link.created_by)}` : ""}.
          <button type="button" class="link-btn danger small" id="fp-off">Turn off this link</button></p>
        <div class="settings" id="fp-settings"></div>`
      : `<div class="actions"><button type="button" class="primary" id="fp-create">Create client link</button></div>`}
      <div class="actions" style="border-top:1px solid var(--hairline);padding-top:16px;margin-top:16px">
        <button type="button" class="danger" id="fp-delete">Delete folder</button>
        <span class="muted small">${count ? (count === 1 ? "Its post stays in the campaign, just not in a folder." : `Its ${n(count)} posts stay in the campaign, just not in a folder.`) : "The folder is empty."}</span>
      </div>`;
    panel.scrollIntoView({ block: "nearest", behavior: "smooth" });
    // Re-open after a change; in the folder view the section was redrawn, so find its new panel.
    const again = () => { const host = el.querySelector(`.fsec[data-key="${f.id}"] .fs-panel`) ?? (document.body.contains(panel) ? panel : gridPanel); host.dataset.folder = ""; openFolderPanel(f, host); };
    panel.querySelector("#fp-close").onclick = () => { panel.hidden = true; };
    panel.querySelector("#fp-rename").onclick = async () => {
      const name = panel.querySelector("#fp-name").value.trim();
      if (!name || name === f.name) return;
      const { error } = await sb.from("campaign_folders").update({ name }).eq("id", f.id);
      if (error) { toast(error.code === "23505" ? "There's already a folder with that name." : error.message); return; }
      f.name = name; toast("Folder renamed"); drawFolders(); draw(); again();
    };
    panel.querySelector("#fp-visible").onchange = async (e) => {
      const hidden = !e.target.checked;
      const { error } = await sb.from("campaign_folders").update({ hidden }).eq("id", f.id);
      if (error) { toast(error.message); e.target.checked = !e.target.checked; return; }
      f.hidden = hidden; toast(hidden ? "Hidden from client links" : "Shown on client links"); drawFolders(); draw(); again();
    };
    panel.querySelector("#fp-create")?.addEventListener("click", async (e) => {
      e.currentTarget.disabled = true;
      const { error } = await sb.from("share_links").insert({ campaign_id: id, folder_id: f.id });
      if (error) { toast(error.message); e.currentTarget.disabled = false; return; }
      folderLinks[f.id] = (await sb.from("share_links").select("id,token,folder_id").eq("folder_id", f.id).eq("revoked", false).order("created_at", { ascending: false }).limit(1).maybeSingle()).data;
      toast("Folder link created"); again();
    });
    if (link) {
      drawLinkSettings(panel.querySelector("#fp-settings"), link, []);
      const input = panel.querySelector("#fp-url");
      input.onfocus = () => input.select();
      panel.querySelector("#fp-copy").onclick = async () => {
        try { await navigator.clipboard.writeText(url); toast("Link copied"); } catch { input.select(); toast("Press Cmd+C to copy"); }
      };
      panel.querySelector("#fp-off").onclick = async () => {
        if (!confirm(`Turn off the client link for ${f.name}? Anyone with it will see "This link isn't active".`)) return;
        const { error } = await sb.from("share_links").update({ revoked: true }).eq("id", link.id);
        if (error) { toast(error.message); return; }
        delete folderLinks[f.id];
        toast("Link turned off"); again();
      };
    }
    panel.querySelector("#fp-delete").onclick = async () => {
      if (!confirm(`Delete the folder "${f.name}"?${count ? ` Its ${count} post${count === 1 ? "" : "s"} stay in the campaign.` : ""}${link ? " Its client link stops working." : ""}`)) return;
      const { error } = await sb.from("campaign_folders").delete().eq("id", f.id);
      if (error) { toast(error.message); return; }
      toast("Folder deleted");
      renderCampaign(++routeToken, id);
    };
  }

  function drawPickBar() {
    if (!ctx.selected) { pickBar.hidden = true; return; }
    const k = ctx.selected.size;
    pickBar.hidden = false;
    pickBar.innerHTML = `<span><b>${n(k)}</b> selected</span>
      <button type="button" class="link-btn" id="pick-all">Select all ${n((view === "grid" ? inView() : list).length)}${view === "grid" ? " shown" : ""}</button>
      ${k ? `<button type="button" class="link-btn" id="pick-none">Clear</button>` : ""}
      <span class="spacer"></span>
      ${folders.length ? `<label class="small" for="pick-to">Move to</label>
      <select id="pick-to" ${k ? "" : "disabled"}><option value="" disabled selected>Choose a folder</option>${folders.map((f) => `<option value="${esc(f.id)}">${esc(f.name)}</option>`).join("")}<option value="none">Not in a folder</option></select>` : `<span class="muted small">Create a folder first, then move posts into it.</span>`}`;
    pickBar.querySelector("#pick-all").onclick = () => { (view === "grid" ? inView() : list).forEach((p) => ctx.selected.add(p.id)); draw(); drawPickBar(); };
    pickBar.querySelector("#pick-none")?.addEventListener("click", () => { ctx.selected.clear(); draw(); drawPickBar(); });
    const to = pickBar.querySelector("#pick-to");
    if (to) to.onchange = async () => {
      const items = list.filter((p) => ctx.selected.has(p.id));
      if (await ctx.move(items, to.value === "none" ? null : to.value)) { ctx.selected.clear(); drawPickBar(); }
    };
  }
  pickBtn.onclick = () => {
    ctx.selected = ctx.selected ? null : new Set();
    pickBtn.setAttribute("aria-pressed", !!ctx.selected);
    pickBtn.textContent = ctx.selected ? "Done selecting" : "Select posts";
    drawPickBar(); draw();
  };
  document.getElementById("new-folder").onclick = async () => {
    const name = prompt("Folder name, for example a creative or a market:")?.trim();
    if (!name) return;
    const { data: f, error } = await sb.from("campaign_folders").insert({ campaign_id: id, name, position: folders.length ? Math.max(...folders.map((x) => x.position)) + 1 : 0 }).select("id,name,market,position,hidden,created_at").single();
    if (error) { toast(error.code === "23505" ? "There's already a folder with that name." : error.message); return; }
    folders.push(f);
    ctx.folderOf = (p) => folderName(p.folder_id);
    toast(`Folder "${name}" created`);
    drawFolders(); drawPickBar(); draw();
  };

  let view = sessionStorageGet("posts-view") === "grid" ? "grid" : "folders";
  document.querySelectorAll("[data-pview]").forEach((b) => {
    b.setAttribute("aria-pressed", b.dataset.pview === view);
    b.onclick = () => {
      view = b.dataset.pview; sessionStorageSet("posts-view", view);
      document.querySelectorAll("[data-pview]").forEach((x) => x.setAttribute("aria-pressed", x.dataset.pview === view));
      gridPanel.hidden = true; drawPickBar(); draw();
    };
  });
  const sortList = (ps) => {
    const by = sortSel.value;
    return [...ps].sort((a, b) =>
      by === "plays" ? (b.plays ?? -1) - (a.plays ?? -1)
      : by === "newest" ? String(b.published_at ?? "").localeCompare(String(a.published_at ?? ""))
      : String(b.created_at).localeCompare(String(a.created_at)));
  };
  const draw = () => {
    folderEl.hidden = view !== "grid";
    if (view === "folders") return drawSections();
    if (!list.length) {
      el.innerHTML = `<div class="panel"><p>No posts yet.</p><a class="btn primary" href="#/c/${esc(id)}/add">Add links</a></div>`;
      return;
    }
    const by = sortSel.value;
    const sorted = inView().sort((a, b) =>
      by === "plays" ? (b.plays ?? -1) - (a.plays ?? -1)
      : by === "newest" ? String(b.published_at ?? "").localeCompare(String(a.published_at ?? ""))
      : String(b.created_at).localeCompare(String(a.created_at)));
    renderWall(el, sorted, ctx, { shown, onMore: () => { shown += 48; draw(); } });
  };
  sortSel.onchange = () => { shown = 48; Object.keys(pages).forEach((k) => (pages[k] = 0)); draw(); };

  // ---------- folder view: one section per folder, Cobrand-style, with its own add box ----------
  const PER_PAGE = 10;
  const pages = {};
  const collapsed = new Set(JSON.parse(sessionStorageGet(`collapsed-${id}`) ?? "[]"));
  const saveCollapsed = () => sessionStorageSet(`collapsed-${id}`, JSON.stringify([...collapsed]));
  const flash = JSON.parse(sessionStorageGet(`flash-${id}`) ?? "null");
  sessionStorageSet(`flash-${id}`, "null");
  const CHEVRON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 15l6-6 6 6"/></svg>';

  function sectionRows(ps, key) {
    const picking = ctx.selected instanceof Set;
    if (!ps.length) return `<div class="fsec-empty muted small">No posts in this folder yet. Use <b>Add links</b> to add some.</div>`;
    const page = Math.min(pages[key] ?? 0, Math.ceil(ps.length / PER_PAGE) - 1);
    pages[key] = page;
    const rows = ps.slice(page * PER_PAGE, page * PER_PAGE + PER_PAGE);
    const pagesN = Math.ceil(ps.length / PER_PAGE);
    return `<div class="table-wrap fsec-table"><table>
      <thead><tr>${picking ? '<th class="pick-col"><span class="sr">Select</span></th>' : ""}<th>Creator</th><th>Posted</th><th>Country</th><th class="num">Views</th><th class="num">Likes</th><th class="num">Comments</th><th class="num">Shares</th><th class="num">Eng. rate</th><th class="num">Followers</th><th><span class="sr">Actions</span></th></tr></thead>
      <tbody>${rows.map((p) => `<tr data-pid="${esc(p.id)}"${picking && ctx.selected.has(p.id) ? ' class="picked"' : ""}${p.gone ? ' data-gone="1"' : ""}>
        ${picking ? `<td class="pick-col"><input type="checkbox" data-rpick="${esc(p.id)}" ${ctx.selected.has(p.id) ? "checked" : ""} aria-label="Select @${esc(p.creator?.username ?? "")}"></td>` : ""}
        <td><button type="button" class="creator-cell" data-open="${esc(p.id)}">
          <span class="av">${p.creator?.avatar ? `<img src="${esc(p.creator.avatar)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">` : ""}<span>${esc((p.creator?.name || p.creator?.username || "?").trim().charAt(0).toUpperCase())}</span></span>
          <span class="cw"><span class="nm">${esc(p.creator?.name || p.creator?.username || "Unknown")}${p.creator?.verified ? ' <span class="tick" title="Verified">✓</span>' : ""}</span><span class="hd">@${esc(p.creator?.username ?? "unknown")}${p.gone ? ' · <span class="gone-tag">no longer on TikTok</span>' : ""}</span></span>
        </button></td>
        <td class="small">${p.published_at ? esc(ago(p.published_at)) : "–"}</td>
        <td>${p.country ? `<span title="${esc(regionName(p.country))}">${flag(p.country)}</span>` : "–"}</td>
        <td class="num plays-cell">${n(p.plays)}</td><td class="num">${n(p.likes)}</td><td class="num">${n(p.comments)}</td><td class="num">${n(p.shares)}</td>
        <td class="num">${pct(engagement(p))}</td><td class="num">${compact(p.creator?.followers)}</td>
        <td class="row-actions"><div class="card-actions">
          <button type="button" data-ract="copy" data-id="${esc(p.id)}" title="Copy link" aria-label="Copy link">${ICON.link}</button>
          <a href="${esc(p.url)}" target="_blank" rel="noopener" title="Open on TikTok" aria-label="Open on TikTok">${ICON.open}</a>
          <button type="button" data-ract="remove" data-id="${esc(p.id)}" title="Remove from campaign" aria-label="Remove from campaign">${ICON.trash}</button>
        </div></td></tr>`).join("")}</tbody></table></div>
      ${pagesN > 1 ? `<div class="pager"><button type="button" class="link-btn" data-page="${page - 1}" ${page === 0 ? "disabled" : ""} aria-label="Previous page">‹</button>
        <span class="small muted">Page ${page + 1} of ${pagesN} · ${n(ps.length)} posts</span>
        <button type="button" class="link-btn" data-page="${page + 1}" ${page >= pagesN - 1 ? "disabled" : ""} aria-label="Next page">›</button></div>` : ""}`;
  }

  function drawSections() {
    const loose = list.filter((p) => !p.folder_id);
    const groups = [
      ...folders.map((f) => ({ key: f.id, f, name: f.name, posts: sortList(list.filter((p) => p.folder_id === f.id)) })),
      ...(loose.length || !folders.length ? [{ key: "none", f: null, name: folders.length ? "Not in a folder" : "All posts", posts: sortList(loose) }] : []),
    ];
    el.innerHTML = groups.map((g) => {
      const live = g.posts.filter((p) => !p.gone);
      const plays = live.reduce((s, p) => s + Number(p.plays ?? 0), 0);
      const sounds = new Set(live.map((p) => p.sound_title).filter(Boolean)).size;
      const shut = collapsed.has(g.key);
      const fl = flash && flash.key === g.key ? flash.text : "";
      return `<section class="fsec${shut ? " shut" : ""}" data-key="${esc(g.key)}">
        <header class="fsec-head">
          <div class="fsec-title">
            <h3>${esc(g.name)}${g.f?.hidden ? ' <span class="badge">Hidden from clients</span>' : ""}${g.f && folderLinks[g.f.id] ? ' <span class="badge on">Client link on</span>' : ""}</h3>
            <div class="fsec-meta"><b>${compact(plays)}</b> plays · ${n(live.length)} post${live.length === 1 ? "" : "s"}${sounds ? ` · ${n(sounds)} sound${sounds === 1 ? "" : "s"}` : ""}${live.length ? ` · ${pct(plays ? live.reduce((s, p) => s + (p.likes ?? 0) + (p.comments ?? 0) + (p.shares ?? 0), 0) / plays : null)} engagement` : ""}</div>
          </div>
          <div class="fsec-actions">
            <button type="button" class="primary" data-sact="add">+ Add links</button>
            ${g.f ? `<button type="button" data-sact="link">${folderLinks[g.f.id] ? "Copy client link" : "Client link"}</button><button type="button" data-sact="edit">Edit</button>` : ""}
            <button type="button" class="icon-btn fsec-chev" data-sact="collapse" aria-expanded="${!shut}" aria-label="${shut ? "Expand" : "Collapse"} ${esc(g.name)}">${CHEVRON}</button>
          </div>
        </header>
        ${fl ? `<div class="fsec-flash small">${fl}</div>` : ""}
        <form class="fsec-add" hidden>
          <label class="sr" for="add-${esc(g.key)}">TikTok links for ${esc(g.name)}</label>
          <textarea id="add-${esc(g.key)}" placeholder="Paste TikTok video links for ${esc(g.name)}, one per line or separated by spaces."></textarea>
          <div class="fsec-add-row"><span class="small muted" data-count>No links yet.</span><span class="spacer"></span>
            <button type="button" class="link-btn" data-sact="cancel">Cancel</button><button type="submit" class="primary" disabled>Add links</button></div>
          <div class="progress" hidden><div></div></div>
        </form>
        <div class="fs-panel panel share-panel" hidden></div>
        <div class="fsec-body"${shut ? " hidden" : ""}>${sectionRows(g.posts, g.key)}</div>
      </section>`;
    }).join("");

    el.querySelectorAll(".fsec").forEach((sec) => {
      const key = sec.dataset.key;
      const g = groups.find((x) => x.key === key);
      const addForm = sec.querySelector(".fsec-add");
      const ta = addForm.querySelector("textarea"), go = addForm.querySelector("[type=submit]"), cnt = addForm.querySelector("[data-count]");
      sec.querySelectorAll("[data-sact]").forEach((b) => (b.onclick = async () => {
        const act = b.dataset.sact;
        if (act === "add") { addForm.hidden = !addForm.hidden; if (!addForm.hidden) { if (collapsed.has(key)) { collapsed.delete(key); saveCollapsed(); sec.classList.remove("shut"); sec.querySelector(".fsec-body").hidden = false; } ta.focus(); } }
        if (act === "cancel") { addForm.hidden = true; ta.value = ""; ta.oninput(); }
        if (act === "edit") openFolderPanel(g.f, sec.querySelector(".fs-panel"));
        if (act === "link") {
          const l = folderLinks[g.f.id];
          if (l) { await copyLink(shareUrl(l.token)); } else { const host = sec.querySelector(".fs-panel"); host.dataset.folder = ""; openFolderPanel(g.f, host); }
        }
        if (act === "collapse") {
          if (collapsed.has(key)) collapsed.delete(key); else collapsed.add(key);
          saveCollapsed(); drawSections();
        }
      }));
      const MAX = 500;
      ta.oninput = () => {
        const k = parseLinks(ta.value).length;
        cnt.textContent = k === 0 ? "No links yet." : k > MAX ? `${n(k)} links found. Add up to ${MAX} at a time.` : `${n(k)} link${k === 1 ? "" : "s"} found.`;
        go.disabled = k === 0 || k > MAX;
        go.textContent = k > 0 && k <= MAX ? `Add ${n(k)} link${k === 1 ? "" : "s"}` : "Add links";
      };
      addForm.onsubmit = async (e) => {
        e.preventDefault();
        const urls = parseLinks(ta.value);
        if (!urls.length) return;
        go.disabled = true; ta.disabled = true;
        const bar = addForm.querySelector(".progress"), fill = bar.firstElementChild;
        bar.hidden = false; cnt.textContent = "Starting…";
        const { data: job, error } = await sb.from("link_jobs").insert({ campaign_id: id, folder_id: g.f?.id ?? null }).select("id").single();
        if (error) { cnt.textContent = error.message; go.disabled = false; ta.disabled = false; return; }
        const r = await sb.from("link_job_items").insert(urls.map((url) => ({ job_id: job.id, url })));
        if (r.error) { cnt.textContent = r.error.message; go.disabled = false; ta.disabled = false; return; }
        const tick = async () => {
          if (!document.body.contains(addForm)) return;
          const [{ data: j }, { data: items }] = await Promise.all([
            sb.from("link_jobs").select("status").eq("id", job.id).single(),
            sb.from("link_job_items").select("url,status,error").eq("job_id", job.id),
          ]);
          const all = items ?? [], done = all.filter((i) => i.status !== "pending").length;
          fill.style.width = `${all.length ? Math.round((done / all.length) * 100) : 0}%`;
          cnt.textContent = `Checking links: ${done} of ${all.length}…`;
          if (j?.status !== "done") { setTimeout(tick, 2000); return; }
          const c = (st) => all.filter((i) => i.status === st);
          const failed = c("failed");
          const text = `Added ${n(c("success").length)} post${c("success").length === 1 ? "" : "s"} to ${esc(g.name)}`
            + (c("duplicate").length ? ` · ${n(c("duplicate").length)} already in this campaign` : "")
            + (failed.length ? ` · ${n(failed.length)} failed:<ul>${failed.map((i) => `<li><span class="u">${esc(i.url)}</span> – ${esc(i.error ?? "")}</li>`).join("")}</ul>` : "");
          sessionStorageSet(`flash-${id}`, JSON.stringify({ key, text }));
          renderCampaign(++routeToken, id);
        };
        tick();
      };
      sec.querySelectorAll("[data-page]").forEach((b) => (b.onclick = () => { pages[key] = Number(b.dataset.page); drawSections(); sec.scrollIntoView({ block: "nearest" }); }));
      sec.querySelectorAll("[data-open]").forEach((b) => (b.onclick = () => openPostModal(g.posts, g.posts.findIndex((p) => p.id === b.dataset.open), ctx)));
      sec.querySelectorAll("[data-ract=copy]").forEach((b) => (b.onclick = () => copyLink(list.find((p) => p.id === b.dataset.id).url)));
      sec.querySelectorAll("[data-ract=remove]").forEach((b) => (b.onclick = async () => {
        const p = list.find((x) => x.id === b.dataset.id);
        if (!confirm(`Remove @${p.creator?.username ?? "this creator"}'s video from the campaign? Its numbers will no longer count.`)) return;
        if (await ctx.remove(p)) { toast("Video removed"); renderCampaign(++routeToken, id); }
      }));
      sec.querySelectorAll("[data-rpick]").forEach((b) => (b.onchange = () => {
        if (b.checked) ctx.selected.add(b.dataset.rpick); else ctx.selected.delete(b.dataset.rpick);
        b.closest("tr").classList.toggle("picked", b.checked); drawPickBar();
      }));
    });
  }
  drawFolders();
  draw();
}

// ---------- client view (the report as the client sees it, every setting on) ----------
function renderReport(token, artist) {
  const c = { artist, status: null };
  mountReport(app, {
    mode: "team",
    load: async () => {
      const { data, error } = await sb.functions.invoke("share", { body: { artist } });
      if (error || data?.error) throw new Error(data?.error ?? error.message);
      return data;
    },
    loadCovers: async (ids) => (await sb.functions.invoke("share", { body: { artist, covers: ids } })).data?.covers ?? {},
    postDaily: async (vid) => (await sb.from("post_daily_stats").select("stat_date,plays,likes,comments,shares").eq("tiktok_video_id", vid).order("stat_date")).data ?? [],
    remove: async (p) => {
      const { error } = await sb.from("posts").delete().eq("campaign_id", p.campaign_id).eq("tiktok_video_id", p.video_id);
      if (error) toast(error.message);
      return !error;
    },
    header: `<div class="client-view-note">
        <a href="#/campaigns" class="back">All campaigns</a>
        <span>Client view: what a client link shows with every setting on. Upcoming campaigns appear here but not on client links.</span>
        <button type="button" id="rep-share" aria-expanded="false" aria-controls="share-panel">Share with client</button>
      </div>`,
    onHeader: (root) => {
      if (token !== routeToken) return;
      root.querySelector(".band")?.insertAdjacentHTML("afterend", `<section id="share-panel" class="panel share-panel" hidden></section>`);
      const b = root.querySelector("#rep-share");
      if (b) b.onclick = () => toggleSharePanel(b, c);
    },
    onError: (e) => { app.innerHTML = fail(e); },
  });
}

// ---------- add links ----------
function parseLinks(text) {
  const found = text.split(/[\s,;]+/).map((t) => t.trim().replace(/^[<(\["']+|[>)\]"'.]+$/g, "")).filter(Boolean)
    .map((t) => (/^(vm\.|vt\.|www\.|m\.)?tiktok\.com\//i.test(t) ? `https://${t}` : t))
    .filter((t) => /^https?:\/\//i.test(t));
  return [...new Set(found)];
}

async function renderAdd(token, id, jobId) {
  const [{ data: c }, { data: folders }] = await Promise.all([
    sb.from("campaigns").select("id,artist,song").eq("id", id).maybeSingle(),
    sb.from("campaign_folders").select("id,name").eq("campaign_id", id).order("position").order("created_at"),
  ]);
  if (token !== routeToken) return;
  if (!c) { app.innerHTML = fail("This campaign doesn't exist or was deleted."); return; }
  const title = `${esc(c.artist)}${c.song ? ` – ${esc(c.song)}` : ""}`;
  if (jobId) return renderJob(token, c, jobId, title);

  app.innerHTML = `
    <a href="#/c/${esc(id)}" class="small">Back to ${title}</a>
    <div class="page-head" style="margin-top:8px"><h1>Add links</h1></div>
    <form id="af" class="panel">
      <label for="links">TikTok links</label>
      <textarea id="links" placeholder="Paste one or more TikTok video links. Short vm.tiktok.com links work too."></textarea>
      <p class="muted small" id="count">No links yet.</p>
      ${folders?.length ? `<label for="folder">Folder</label>
      <select id="folder" style="max-width:360px"><option value="">No folder</option>${folders.map((f) => `<option value="${esc(f.id)}">${esc(f.name)}</option>`).join("")}</select>
      <p class="muted small">Every link in this batch goes into this folder. You can move posts later.</p>` : ""}
      <div id="add-msg"></div>
      <div class="actions"><button class="primary" type="submit" id="go" disabled>Add links</button></div>
    </form>`;
  const ta = document.getElementById("links"), btn = document.getElementById("go"), count = document.getElementById("count");
  const fsel = document.getElementById("folder");
  const lastFolder = sessionStorageGet(`folder-${id}`);
  if (fsel && lastFolder && folders.some((f) => f.id === lastFolder)) fsel.value = lastFolder;
  const MAX = 500;
  ta.oninput = () => {
    const k = parseLinks(ta.value).length;
    count.textContent = k === 0 ? "No links yet." : k > MAX ? `${n(k)} links found. Add up to ${MAX} at a time.` : `${n(k)} link${k === 1 ? "" : "s"} found.`;
    btn.disabled = k === 0 || k > MAX;
    btn.textContent = k > 0 && k <= MAX ? `Add ${n(k)} link${k === 1 ? "" : "s"}` : "Add links";
  };
  document.getElementById("af").addEventListener("submit", async (e) => {
    e.preventDefault();
    const urls = parseLinks(ta.value);
    btn.disabled = true;
    const folderId = document.getElementById("folder")?.value || null;
    const { data: job, error } = await sb.from("link_jobs").insert({ campaign_id: id, folder_id: folderId }).select("id").single();
    if (error) { btn.disabled = false; document.getElementById("add-msg").innerHTML = fail(error); return; }
    const res = await sb.from("link_job_items").insert(urls.map((url) => ({ job_id: job.id, url })));
    if (res.error) { btn.disabled = false; document.getElementById("add-msg").innerHTML = fail(res.error); return; }
    go(`#/c/${id}/add/${job.id}`);
  });
}

async function renderJob(token, c, jobId, title) {
  app.innerHTML = `
    <a href="#/c/${esc(c.id)}" class="small">Back to ${title}</a>
    <div class="page-head" style="margin-top:8px"><h1>Adding links</h1></div>
    <div class="panel">
      <p id="job-line">Starting…</p>
      <div class="progress"><div id="bar"></div></div>
      <ul class="items" id="items"></ul>
      <div class="actions" id="job-actions"></div>
    </div>`;
  const label = { success: "Added", failed: "Failed", duplicate: "Already in", pending: "Waiting" };
  const tick = async () => {
    if (token !== routeToken) return;
    const [{ data: job }, { data: items }] = await Promise.all([
      sb.from("link_jobs").select("*").eq("id", jobId).single(),
      sb.from("link_job_items").select("url,status,error").eq("job_id", jobId).order("processed_at", { ascending: true, nullsFirst: false }),
    ]);
    if (token !== routeToken || !job) return;
    const all = items ?? [];
    const done = all.filter((i) => i.status !== "pending").length;
    const cnt = (s) => all.filter((i) => i.status === s).length;
    document.getElementById("bar").style.width = `${all.length ? Math.round((done / all.length) * 100) : 0}%`;
    document.getElementById("job-line").textContent = job.status === "done"
      ? `Done. ${cnt("success")} added, ${cnt("duplicate")} already in this campaign, ${cnt("failed")} failed.`
      : job.status === "pending" ? "Waiting to start…" : `Checking links: ${done} of ${all.length} done.`;
    document.getElementById("items").innerHTML = all.map((i) => `
      <li><span class="pill ${esc(i.status)}">${label[i.status] ?? esc(i.status)}</span>
        <span><span class="u">${esc(i.url)}</span>${i.error && i.status !== "duplicate" ? `<br><span class="e">${esc(i.error)}</span>` : ""}</span></li>`).join("");
    if (job.status === "done") {
      document.getElementById("job-actions").innerHTML = `<a class="btn primary" href="#/c/${esc(c.id)}">See the campaign</a><a class="btn" href="#/c/${esc(c.id)}/add">Add more links</a>`;
      return;
    }
    setTimeout(tick, 2000);
  };
  tick();
}

// ---------- router ----------
async function route() {
  const token = ++routeToken;
  const user = await signedInUser();
  if (token !== routeToken) return;
  if (!user) return renderLogin();
  if (!(await isTeamMember())) {
    document.body.classList.add("signin");
    app.innerHTML = `<section class="login no-access on-blue">
      <img class="logo" src="assets/stellar-blue.png" alt="Stellar" width="160" height="44">
      <h1>No access <em>yet</em></h1>
      <p>${esc(user.email)} isn't on the Stellar team list. Ask Sam to add this email, then sign in again.</p>
      <div class="actions"><button type="button" id="signout2">Sign out</button></div></section>`;
    document.getElementById("signout2").onclick = () => sb.auth.signOut();
    return;
  }
  document.body.classList.remove("signin");
  renderWho(user);
  const parts = location.hash.replace(/^#\/?/, "").split("/").filter(Boolean);
  window.scrollTo(0, 0);
  const section = !parts[0] || parts[0] === "overview" ? "overview" : SOON[parts[0]] ? parts[0] : "campaigns";
  renderNav(section);
  if (section === "overview") return renderOverview(token);
  if (SOON[parts[0]]) return renderSoon(parts[0]);
  if (parts[0] === "campaigns") return renderList(token);
  if (parts[0] === "new") return renderForm(token);
  if (parts[0] === "report" && parts[1]) return renderReport(token, decodeURIComponent(parts.slice(1).join("/")));
  if (parts[0] === "c" && parts[1]) {
    if (parts[2] === "edit") return renderForm(token, parts[1]);
    if (parts[2] === "add") return renderAdd(token, parts[1], parts[3]);
    return renderCampaign(token, parts[1]);
  }
  return renderList(token);
}

window.addEventListener("hashchange", route);
// Supabase also reports SIGNED_IN when a tab regains focus, so only re-render when the user actually changes.
// Work is deferred with setTimeout: calling Supabase inside this callback can deadlock the client.
let lastUserId;
sb.auth.onAuthStateChange((_event, session) => {
  const uid = session?.user?.id ?? null;
  if (lastUserId !== undefined && uid !== lastUserId) setTimeout(route, 0);
  lastUserId = uid;
});
route();
