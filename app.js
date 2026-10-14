import { createClient } from "./vendor/supabase.esm.js";
import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from "./config.js";
import { mountReport, renderWall } from "./report.js";

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
      <img class="logo" src="assets/stellar-white.png" alt="Stellar" width="160" height="44">
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
      <input id="q" type="search" placeholder="Search artist, song, client or owner" aria-label="Search campaigns">
      <select id="st" aria-label="Status">
        <option value="active">Active</option><option value="draft">Draft</option>
        <option value="finished">Finished</option><option value="">All</option>
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
      (!term || [r.artist, r.song, r.client, r.campaign_runner, r.comms_owner].some((v) => (v ?? "").toLowerCase().includes(term))));
    document.getElementById("list").innerHTML = shown.length === 0
      ? `<div class="panel"><p>${rows.length === 0 ? "No campaigns yet. Create the first one to start adding links." : "No campaigns match these filters."}</p></div>`
      : `<div class="table-wrap"><table>
          <thead><tr><th>Artist and song</th><th>Client</th><th>Runner</th><th>Dates</th><th class="num">Budget</th><th class="num">Spend</th><th class="num">Live posts</th><th class="num">Plays</th><th class="num">Cost per view</th><th>Status</th></tr></thead>
          <tbody>${shown.map((r) => `
            <tr data-id="${esc(r.id)}" tabindex="0">
              <td><div class="artist">${esc(r.artist)}</div><div class="song small">${esc(r.song)}</div></td>
              <td>${esc(r.client)}</td>
              <td>${esc(r.campaign_runner)}</td>
              <td class="small">${esc(date(r.start_date))}${r.end_date ? ` to ${esc(date(r.end_date))}` : ""}</td>
              <td class="num">${money(r.budget, r.currency)}</td>
              <td class="num">${Number(r.spend) ? money(r.spend, r.currency) : "–"}</td>
              <td class="num">${n(r.live_posts)}</td>
              <td class="num plays-cell">${compact(r.total_plays)}</td>
              <td class="num">${cpv(r.cost_per_view, r.currency)}</td>
              <td><span class="status ${esc(r.status)}">${esc(r.status)}</span>${r.invoiced ? ` <span class="status finished">invoiced</span>` : ""}</td>
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
const CURRENCIES = ["EUR", "USD", "DKK", "GBP", "JPY", "SGD", "IDR", "THB", "PHP", "MYR", "VND", "BRL", "MXN", "COP", "ARS", "CLP"];

async function renderForm(token, id) {
  let c = { status: "active", currency: "EUR", invoiced: false };
  let markets = [];
  if (id) {
    const [{ data, error }, m] = await Promise.all([
      sb.from("campaigns").select("*").eq("id", id).single(),
      sb.from("campaign_markets").select("market,share_percent").eq("campaign_id", id),
    ]);
    if (token !== routeToken) return;
    if (error) { app.innerHTML = fail(error); return; }
    c = data; markets = m.data ?? [];
  }
  const v = (k) => esc(c[k] ?? "");
  app.innerHTML = `
    <div class="page-head"><h1>${id ? "Edit campaign" : "New campaign"}</h1></div>
    <form id="cf" class="panel">
      <div class="form-grid">
        <div><label for="artist">Artist</label><input id="artist" required value="${v("artist")}"></div>
        <div><label for="song">Song</label><input id="song" value="${v("song")}"></div>
        <div><label for="client">Client</label><input id="client" placeholder="Label or brand" value="${v("client")}"></div>
        <div><label for="comms_owner">Comms owner</label><input id="comms_owner" value="${v("comms_owner")}"></div>
        <div><label for="campaign_runner">Campaign runner</label><input id="campaign_runner" value="${v("campaign_runner")}"></div>
        <div><label for="status">Status</label><select id="status">
          ${["draft", "active", "finished"].map((s) => `<option ${c.status === s ? "selected" : ""}>${s}</option>`).join("")}</select></div>
        <div><label for="start_date">Start date</label><input id="start_date" type="date" value="${v("start_date")}"></div>
        <div><label for="end_date">End date</label><input id="end_date" type="date" value="${v("end_date")}"></div>
        <div><label for="budget">Budget</label><input id="budget" type="number" min="0" step="0.01" value="${v("budget")}"></div>
        <div><label for="currency">Currency</label><input id="currency" list="currencies" maxlength="3" value="${v("currency")}">
          <datalist id="currencies">${CURRENCIES.map((x) => `<option value="${x}">`).join("")}</datalist></div>
        <div class="field-wide"><label class="check"><input id="invoiced" type="checkbox" ${c.invoiced ? "checked" : ""}> Invoiced</label></div>
        <div class="field-wide"><label for="notes">Notes</label><textarea id="notes" style="min-height:80px">${v("notes")}</textarea></div>
      </div>
      <h2 style="margin-top:24px">Markets</h2>
      <p class="muted small">Add each market and its share of the budget.</p>
      <div id="markets"></div>
      <button type="button" id="add-market">Add market</button>
      <div id="form-msg"></div>
      <div class="actions">
        <button class="primary" type="submit">${id ? "Save changes" : "Create campaign"}</button>
        <a class="btn" href="${id ? `#/c/${esc(id)}` : "#/"}">Cancel</a>
        ${id ? `<button type="button" id="delete" class="danger" style="margin-left:auto">Delete campaign</button>` : ""}
      </div>
    </form>`;

  const box = document.getElementById("markets");
  const addRow = (m = {}) => {
    const row = document.createElement("div");
    row.className = "markets-row";
    row.innerHTML = `<input aria-label="Market" placeholder="Market, e.g. Indonesia" value="${esc(m.market ?? "")}">
      <input aria-label="Share in percent" type="number" min="0" max="100" step="0.01" placeholder="%" value="${esc(m.share_percent ?? "")}">
      <button type="button" class="link-btn danger">Remove</button>`;
    row.querySelector("button").onclick = () => row.remove();
    box.appendChild(row);
  };
  markets.forEach(addRow);
  document.getElementById("add-market").onclick = () => addRow();

  document.getElementById("cf").addEventListener("submit", async (e) => {
    e.preventDefault();
    const msg = document.getElementById("form-msg");
    const val = (k) => document.getElementById(k).value.trim();
    const cur = val("currency").toUpperCase();
    if (cur && !/^[A-Z]{3}$/.test(cur)) { msg.innerHTML = fail("Currency must be a three-letter code, such as EUR or USD."); return; }
    const rows = [...box.querySelectorAll(".markets-row")].map((r) => {
      const [m, p] = r.querySelectorAll("input");
      return { market: m.value.trim(), share_percent: p.value === "" ? null : Number(p.value) };
    }).filter((r) => r.market);
    const names = rows.map((r) => r.market.toLowerCase());
    if (new Set(names).size !== names.length) { msg.innerHTML = fail("Each market can only be listed once."); return; }
    const total = rows.reduce((s, r) => s + (r.share_percent ?? 0), 0);
    if (total > 100.001) { msg.innerHTML = fail(`Market shares add up to ${total}%. They can't be more than 100%.`); return; }

    const record = {
      artist: val("artist"), song: val("song") || null, client: val("client") || null,
      comms_owner: val("comms_owner") || null, campaign_runner: val("campaign_runner") || null,
      status: val("status"), start_date: val("start_date") || null, end_date: val("end_date") || null,
      budget: val("budget") === "" ? null : Number(val("budget")), currency: cur || null,
      invoiced: document.getElementById("invoiced").checked, notes: val("notes") || null,
    };
    const btn = e.submitter; btn.disabled = true;
    const res = id
      ? await sb.from("campaigns").update(record).eq("id", id).select("id").single()
      : await sb.from("campaigns").insert(record).select("id").single();
    if (res.error) { btn.disabled = false; msg.innerHTML = fail(res.error); return; }
    const cid = res.data.id;
    await sb.from("campaign_markets").delete().eq("campaign_id", cid);
    if (rows.length) {
      const { error } = await sb.from("campaign_markets").insert(rows.map((r) => ({ ...r, campaign_id: cid })));
      if (error) { btn.disabled = false; msg.innerHTML = fail(error); return; }
    }
    toast(id ? "Changes saved" : "Campaign created");
    go(`#/c/${cid}`);
  });

  const del = document.getElementById("delete");
  if (del) del.onclick = async () => {
    if (!confirm(`Delete "${c.artist}${c.song ? ` – ${c.song}` : ""}" and all its posts? This can't be undone.`)) return;
    const { error } = await sb.from("campaigns").delete().eq("id", id);
    if (error) { document.getElementById("form-msg").innerHTML = fail(error); return; }
    toast("Campaign deleted"); go("#/");
  };
}

// ---------- campaign dashboard ----------
async function renderCampaign(token, id) {
  app.innerHTML = `<p class="muted pad">Loading campaign…</p>`;
  const { data: c, error } = await sb.from("campaign_summary").select("*").eq("id", id).maybeSingle();
  if (token !== routeToken) return;
  if (error || !c) { app.innerHTML = fail(error ?? "This campaign doesn't exist or was deleted."); return; }

  const [markets, daily, latest] = await Promise.all([
    sb.from("campaign_markets").select("market,share_percent").eq("campaign_id", id),
    sb.from("campaign_daily_stats").select("*").eq("campaign_id", id).order("stat_date"),
    sb.from("posts").select("last_checked_at").eq("campaign_id", id).not("last_checked_at", "is", null).order("last_checked_at", { ascending: false }).limit(1),
  ]);
  if (token !== routeToken) return;
  const mk = (markets.data ?? []).map((m) => `${m.market}${m.share_percent != null ? ` ${m.share_percent}%` : ""}`).join(", ");
  const lastChecked = latest.data?.[0]?.last_checked_at;

  app.innerHTML = `
    <section class="band on-blue">
      <div class="hero">
        <div>
          <a href="#/" class="back">All campaigns</a>
          <h1>${esc(c.artist)}</h1>
          ${c.song ? `<div class="voice">${esc(c.song)}</div>` : ""}
          <div class="meta">
            <span class="status">${esc(c.status)}</span>
            ${c.client ? `<span>Client: ${esc(c.client)}</span>` : ""}
            ${c.campaign_runner ? `<span>Runner: ${esc(c.campaign_runner)}</span>` : ""}
            ${c.comms_owner ? `<span>Comms: ${esc(c.comms_owner)}</span>` : ""}
            ${c.start_date ? `<span>${esc(date(c.start_date))}${c.end_date ? ` to ${esc(date(c.end_date))}` : ""}</span>` : ""}
            ${mk ? `<span>Markets: ${esc(mk)}</span>` : ""}
          </div>
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
      <label class="small" style="display:flex;gap:8px;align-items:center;margin:0">Sort by
        <select id="sort" style="width:auto"><option value="plays">Most plays</option><option value="newest">Newest first</option><option value="added">Recently added</option></select>
      </label>
    </div>
    <div id="posts"><p class="muted">Loading posts…</p></div>`;

  drawChart(document.getElementById("chart"), daily.data ?? []);
  loadSounds(token, id);
  loadPosts(token, id);
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
  const what = `The client sees ${visible.length === 1 ? (visible[0].song ? `the ${esc(visible[0].song)} campaign` : "1 campaign") : `${visible.length} of ${esc(c.artist)}'s campaigns`}, with whatever you switch on below. Drafts are never shown. <b>Budgets, spend, margins and creator costs are never shown.</b>`;
  const draftNote = c.status === "draft" ? `<p class="small warn-note">This campaign is a draft, so it won't appear on the client link until you set it to active.</p>` : "";
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
const LINK_DEFAULTS = { overview: true, overview_chart: true, sounds: true, songs: true, songs_chart: true, countries: true, countries_chart: true, posts: true, posts_country_filter: true, show_country: true, show_followers: true };
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
    ${row("countries", "Country analytics")}
    ${row("countries_chart", "Countries chart", { sub: true, parent: "countries" })}
    <h3>Posts</h3>
    ${row("posts", "Post wall")}
    ${row("posts_country_filter", "Country filter", { sub: true, parent: "posts" })}
    <h3>Campaigns</h3>
    ${camps.map((x) => x.status === "draft"
      ? `<label class="row"><span>${esc(x.song ?? "Untitled")} <span class="muted small">draft, never shown</span></span><span class="switch"><input type="checkbox" disabled><span></span></span></label>`
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

async function loadPosts(token, id) {
  const el = document.getElementById("posts");
  let posts;
  try {
    posts = await fetchAll(() => sb.from("posts")
      .select("id,tiktok_video_id,url,caption,published_at,country_code,cover_path,status,created_at,sound:sounds(title),creator:creators(username,display_name,follower_count,is_verified,avatar_url,country_code)")
      .eq("campaign_id", id).order("created_at", { ascending: false }));
  } catch (e) { el.innerHTML = fail(e); return; }
  if (token !== routeToken) return;
  if (!posts.length) {
    el.innerHTML = `<div class="panel"><p>No posts yet.</p><a class="btn primary" href="#/c/${esc(id)}/add">Add links</a></div>`;
    return;
  }
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
      id: p.id, campaign_id: id, video_id: p.tiktok_video_id, url: p.url, caption: p.caption, published_at: p.published_at, created_at: p.created_at,
      country: p.creator?.country_code ?? p.country_code ?? null, sound_title: p.sound?.title ?? null, gone: p.status !== "active", has_cover: !!p.cover_path,
      creator: p.creator ? { username: p.creator.username, name: p.creator.display_name, followers: p.creator.follower_count, verified: p.creator.is_verified, avatar: p.creator.avatar_url } : null,
      plays: st.plays ?? null, likes: st.likes ?? null, comments: st.comments ?? null, shares: st.shares ?? null, stats_date: st.stat_date ?? null,
    };
  });
  const ctx = {
    mode: "team",
    covers: Object.fromEntries(posts.filter((p) => byPath[p.cover_path]).map((p) => [p.tiktok_video_id, byPath[p.cover_path]])),
    postDaily: async (vid) => (await sb.from("post_daily_stats").select("stat_date,plays,likes,comments,shares").eq("tiktok_video_id", vid).order("stat_date")).data ?? [],
    remove: async (p) => { const { error } = await sb.from("posts").delete().eq("id", p.id); if (error) toast(error.message); return !error; },
    onRemoved: () => renderCampaign(++routeToken, id),
    showCountry: true,
  };
  const sortSel = document.getElementById("sort");
  let shown = 48;
  const draw = () => {
    const by = sortSel.value;
    const sorted = [...list].sort((a, b) =>
      by === "plays" ? (b.plays ?? -1) - (a.plays ?? -1)
      : by === "newest" ? String(b.published_at ?? "").localeCompare(String(a.published_at ?? ""))
      : String(b.created_at).localeCompare(String(a.created_at)));
    renderWall(el, sorted, ctx, { shown, onMore: () => { shown += 48; draw(); } });
  };
  sortSel.onchange = () => { shown = 48; draw(); };
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
        <span>Client view: what a client link shows with every setting on. Drafts appear here but never on client links.</span>
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
  const { data: c } = await sb.from("campaigns").select("id,artist,song").eq("id", id).maybeSingle();
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
      <div id="add-msg"></div>
      <div class="actions"><button class="primary" type="submit" id="go" disabled>Add links</button></div>
    </form>`;
  const ta = document.getElementById("links"), btn = document.getElementById("go"), count = document.getElementById("count");
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
    const { data: job, error } = await sb.from("link_jobs").insert({ campaign_id: id }).select("id").single();
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
      <img class="logo" src="assets/stellar-white.png" alt="Stellar" width="160" height="44">
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
