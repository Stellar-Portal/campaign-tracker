import { createClient } from "./vendor/supabase.esm.js";
import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from "./config.js?v=20261015d";
import { mountReport, renderWall, openPostModal, flag, regionName, ago, engagement, ICON, copyLink, pct } from "./report.js?v=20261015d";
import { INVOICING_ENTITIES, CLIENT_COUNTRIES, CLIENT_MARKETS, CAMPAIGN_TYPES, RELEASE_TYPES, LABEL_TYPES, STATUSES, statusLabel, normalisePO } from "./sheet-lists.js?v=20261015d";

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
      <h1>Campaign <em>tracker</em></h1>
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
  who.innerHTML = `<span class="email">${esc(user.email)}</span><button id="signout" type="button">Sign out</button>`;
  document.getElementById("signout").onclick = async () => { await sb.auth.signOut(); };
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
        <a class="btn" href="${id ? `#/c/${esc(id)}` : "#/"}">Cancel</a>
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
    toast("Campaign deleted"); go("#/");
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
          <a href="#/" class="back">All campaigns</a>
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
        <a href="#/" class="back">All campaigns</a>
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
