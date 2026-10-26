import { confirmDialog } from "./dialog.js?v=20261027d";
// Creator roster: the creators Stellar works with, each with topline numbers from their recent
// TikTok videos (ScrapeCreators, refreshed weekly by the roster Edge Function) and, on request,
// audience insights and contact details (Influencers.club, 1 credit per creator, kept 60 days).
//
// Routes: #/roster · #/creator/<creator id>
import { esc, flag, regionName, ago, compact, big } from "./report.js?v=20261027d";
import { PLATFORMS, PLATFORM_ORDER, platformOf, detectPlatform } from "./platforms.js?v=20261027d";

const SORTS = {
  added: ["Recently added", (c) => c.roster_added_at ?? "", -1],
  followers: ["Most followers", (c) => c.follower_count ?? -1, -1],
  views: ["Highest median views", (c) => c.profile_stats?.median_views ?? -1, -1],
  engagement: ["Highest engagement", (c) => c.profile_stats?.engagement ?? -1, -1],
  campaigns: ["Most campaigns with us", (c) => c._campaigns ?? 0, -1],
  name: ["Name A–Z", (c) => (c.display_name || c.username || "").toLowerCase(), 1],
};
const st = { q: "", country: "", platform: "", sort: "added", addPlatform: "tiktok" };   // kept while moving between pages

const avatar = (c, size = 40) => {
  const letter = esc((c.display_name || c.username || "?").trim().charAt(0).toUpperCase());
  return `<span class="ro-av" style="--s:${size}px">${c.avatar_url ? `<img src="${esc(c.avatar_url)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">` : ""}<span>${letter}</span></span>`;
};
const place = (code) => (code ? `${flag(code)} ${esc(regionName(code))}` : "–");
const perWeek = (x) => (x == null ? "–" : x >= 1 ? `${Math.round(x * 10) / 10}` : `${Math.round(x * 4 * 10) / 10}/mo`);

async function invoke(sb, name, body) {
  const { data, error } = await sb.functions.invoke(name, { body });
  if (error || data?.error) {
    let msg = data?.error;
    if (!msg && error?.context?.json) { try { msg = (await error.context.json())?.error; } catch { /* ignore */ } }
    throw new Error(msg ?? error?.message ?? "Something went wrong");
  }
  return data;
}

// Routes:
//   #/roster                         all roster creators
//   #/roster/list/<id>               one list ("Football clubs")
//   #/roster/list/<id>/compare       the list compared: growth, engagement, audience per country
//   …/c/<creator id>                 any of the above with that creator open in the side panel
//   #/creator/<id>                   a creator as a full page
export async function renderRoster(app, sb, ctx) {
  const parts = ctx.parts;
  if (parts[0] === "creator" && parts[1]) { closeDrawer(true); return renderCreator(app, sb, ctx, parts[1]); }
  const drawerId = parts[parts.length - 2] === "c" ? parts[parts.length - 1] : null;
  const baseParts = drawerId ? parts.slice(0, -2) : parts;
  const base = `#/${baseParts.join("/")}`;
  view.ctx = ctx;
  // Opening or closing the side panel leaves the page underneath as it is.
  if (view.base === base && view.app === app && app.querySelector("[data-roster-view]")) return syncDrawer(sb, drawerId);
  view.base = base; view.app = app; view.order = [];
  const listId = baseParts[1] === "list" ? baseParts[2] : null;
  const mode = listId && baseParts[3] === "compare" ? "compare" : "creators";
  await renderList(app, sb, ctx, { listId, mode, base });
  if (ctx.isCurrent()) syncDrawer(sb, drawerId);
}
const view = { base: null, app: null, ctx: null, order: [], listCache: null };
const cur = () => view.ctx;

// ---------- roster list ----------
async function renderList(app, sb, ctx, { listId, mode, base }) {
  const { isCurrent, go, toast } = ctx;
  app.innerHTML = `<p class="muted pad">Loading the roster…</p>`;
  const [cRes, lRes, mRes] = await Promise.all([
    sb.from("creators").select("id,username,display_name,avatar_url,follower_count,is_verified,country_code,platform,profile_stats,stats_checked_at,stats_error,roster_added_at")
      .eq("on_roster", true).order("roster_added_at", { ascending: false }),
    sb.from("roster_lists").select("id,name,created_at").order("created_at"),
    sb.from("roster_list_members").select("list_id,creator_id"),
  ]);
  if (!isCurrent()) return;
  if (cRes.error) { app.innerHTML = `<div class="panel"><p class="warn-note">${esc(cRes.error.message)}</p></div>`; return; }
  const all = cRes.data;
  const lists = lRes.data ?? [];
  const members = mRes.data ?? [];
  const list = listId ? lists.find((l) => l.id === listId) : null;
  if (listId && !list) { app.innerHTML = `<div class="panel" data-roster-view><p>This list doesn't exist any more.</p><p><a href="#/roster">All creators</a></p></div>`; return; }
  const inList = new Set(members.filter((m) => m.list_id === listId).map((m) => m.creator_id));
  const creators = list ? all.filter((c) => inList.has(c.id)) : all;
  const ids = creators.map((c) => c.id);
  const [posts, insights] = await Promise.all([
    ids.length ? sb.from("posts").select("creator_id,campaign_id").in("creator_id", ids) : { data: [] },
    sb.from("creator_insights").select("handle,platform,fetched_at,error"),
  ]);
  if (!isCurrent()) return;
  const camps = {};
  for (const p of posts.data ?? []) (camps[p.creator_id] ??= new Set()).add(p.campaign_id);
  const unlocked = new Set((insights.data ?? []).filter((x) => !x.error).map((x) => `${x.platform}:${x.handle}`));
  for (const c of all) { c.platform ??= "tiktok"; c._campaigns = camps[c.id]?.size ?? 0; c._insights = unlocked.has(`${c.platform}:${String(c.username).toLowerCase()}`); }
  const count = (lid) => members.filter((m) => m.list_id === lid).length;
  const platformsUsed = PLATFORM_ORDER.filter((p) => creators.some((c) => c.platform === p));
  const countries = [...new Set(creators.map((c) => c.country_code).filter(Boolean))].sort((a, b) => regionName(a).localeCompare(regionName(b)));
  view.listCache = list ? { list, creators } : null;

  app.innerHTML = `
    <div data-roster-view>
    <div class="page-head">
      <div><h1 class="ro-title">${list ? esc(list.name) : "Roster"}${list ? `
        <details class="ro-more"><summary aria-label="List options" title="List options">⋯</summary>
          <div class="ro-more-pop"><button type="button" id="ro-rename">Rename list</button><button type="button" id="ro-dellist" class="danger-lite">Delete list</button></div></details>` : ""}</h1>
        <p class="muted small" style="margin:6px 0 0">${list ? `${creators.length} creator${creators.length === 1 ? "" : "s"} from the roster` : "Creators Stellar works with on TikTok, Instagram, YouTube, X and Twitch. Numbers come from each creator's recent posts and refresh every week."}</p></div>
      ${list ? "" : `<a class="btn" href="#/discover">Find new creators</a>`}
    </div>
    <nav class="ro-tabs" aria-label="Roster lists">
      <a href="#/roster" class="ro-tab${list ? "" : " on"}">All creators <span>${all.length}</span></a>
      ${lists.map((l) => `<a href="#/roster/list/${esc(l.id)}" class="ro-tab${l.id === listId ? " on" : ""}">${esc(l.name)} <span>${count(l.id)}</span></a>`).join("")}
      <button type="button" class="ro-tab ro-tab-new" id="ro-newlist">+ New list</button>
    </nav>
    ${list ? `
    <div class="ro-listbar">
      <div class="ro-seg" role="tablist">
        <a role="tab" href="#/roster/list/${esc(list.id)}" class="${mode === "creators" ? "on" : ""}" aria-selected="${mode === "creators"}">Creators</a>
        <a role="tab" href="#/roster/list/${esc(list.id)}/compare" class="${mode === "compare" ? "on" : ""}" aria-selected="${mode === "compare"}">Compare</a>
      </div>
      <div class="ro-listtools" id="ro-listtools"></div>
      <button type="button" id="ro-addto" class="ro-addto">+ Add creators</button>
    </div>` : `
    <form class="ro-add" id="ro-add">
      <label class="ov-pill ro-pf"><span class="ro-pf-ico" id="ro-pf-ico">${PLATFORMS[st.addPlatform].icon}</span><select id="ro-platform" aria-label="Platform">${PLATFORM_ORDER.map((p) => `<option value="${p}"${p === st.addPlatform ? " selected" : ""}>${PLATFORMS[p].name}</option>`).join("")}</select></label>
      <input id="ro-input" type="text" autocomplete="off" placeholder="Paste a profile link, a video link or @handle" aria-label="Profile link, video link or handle">
      <button type="submit" class="primary">Add to roster</button>
      <span class="small muted ro-add-msg" id="ro-msg" role="status"></span>
    </form>`}
    ${mode === "compare" ? `<div id="ro-compare"></div>` : creators.length ? `
    <div class="ov-bar">
      <label class="ov-search"><svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="8.5" cy="8.5" r="5.5"/><path d="m13 13 4 4"/></svg><input id="ro-q" type="search" placeholder="Search name or handle" aria-label="Search the roster"></label>
      ${platformsUsed.length > 1 ? `<select id="ro-pfilter" class="ov-pill" aria-label="Platform"><option value="">All platforms</option>${platformsUsed.map((p) => `<option value="${p}">${PLATFORMS[p].name}</option>`).join("")}</select>` : ""}
      ${countries.length ? `<select id="ro-country" class="ov-pill" aria-label="Country"><option value="">All countries</option>${countries.map((x) => `<option value="${esc(x)}">${esc(regionName(x))}</option>`).join("")}</select>` : ""}
      <label class="ov-pill ov-sort"><span>Sort</span><select id="ro-sort" aria-label="Sort by">${Object.entries(SORTS).map(([k, [l]]) => `<option value="${k}">${esc(l)}</option>`).join("")}</select></label>
    </div>
    <div id="ro-list"></div>` : list ? `
    <section class="panel ro-empty"><h3>This list is empty</h3><p class="muted">Use <b>Add creators</b> to pick creators from the roster, or open a creator and add them from their <b>Lists</b> menu.</p></section>` : `
    <section class="panel ro-empty">
      <h3>No creators on the roster yet</h3>
      <p class="muted">Paste a creator's profile link, any of their video links, or their @handle above (pick the platform for a bare handle). You can also add creators from a campaign (the ☆ next to a creator) or from <a href="#/discover">Discover</a>.</p>
    </section>`}
    </div>`;

  const more = app.querySelector(".ro-more");
  if (more) document.addEventListener("click", (e) => { if (more.open && !more.contains(e.target)) more.open = false; });
  // New list / rename / delete / add creators
  document.getElementById("ro-newlist").onclick = async () => {
    const name = await askText("New list", "Name", "e.g. Football clubs");
    if (!name) return;
    const { data, error } = await sb.from("roster_lists").insert({ name, created_by: await me(sb) }).select("id").single();
    if (error) return toast(error.message);
    go(`#/roster/list/${data.id}`);
  };
  if (list) {
    document.getElementById("ro-rename").onclick = async () => {
      const name = await askText("Rename list", "Name", "", list.name);
      if (!name || name === list.name) return;
      const { error } = await sb.from("roster_lists").update({ name }).eq("id", list.id);
      if (error) return toast(error.message);
      view.base = null; renderRoster(app, sb, cur());
    };
    document.getElementById("ro-dellist").onclick = async () => {
      if (!(await confirmDialog({ title: `Delete the list "${list.name}"?`, body: "The creators stay on the roster." }))) return;
      const { error } = await sb.from("roster_lists").delete().eq("id", list.id);
      if (error) return toast(error.message);
      toast("List deleted"); go("#/roster");
    };
    document.getElementById("ro-addto").onclick = () => pickCreators(sb, list, all, inList, () => { view.base = null; renderRoster(app, sb, cur()); });
  } else {
    const form = document.getElementById("ro-add"), msg = document.getElementById("ro-msg");
    const pfSel = document.getElementById("ro-platform"), pfIco = document.getElementById("ro-pf-ico"), inputEl = document.getElementById("ro-input");
    const setPf = (p) => { st.addPlatform = p; pfSel.value = p; pfIco.innerHTML = PLATFORMS[p].icon; };
    pfSel.onchange = () => setPf(pfSel.value);
    inputEl.oninput = () => { const p = detectPlatform(inputEl.value); if (p && p !== st.addPlatform) setPf(p); };
    form.onsubmit = async (e) => {
      e.preventDefault();
      const input = inputEl.value.trim();
      if (!input) return;
      const btn = form.querySelector("button[type=submit]"); btn.disabled = true; btn.textContent = "Adding…";
      msg.textContent = "Reading their profile and recent posts. This takes about 20 seconds.";
      try {
        const r = await invoke(sb, "roster", { action: "add", input, platform: detectPlatform(input) ?? st.addPlatform });
        toast(`Added @${r.username} to the roster`);
        view.base = null; cur().go(`#/roster/c/${r.id}`);
      } catch (err) {
        btn.disabled = false; btn.textContent = "Add to roster";
        msg.innerHTML = `<span class="warn-note">${esc(err.message)}</span>`;
      }
    };
  }
  if (mode === "compare") return renderCompare(document.getElementById("ro-compare"), sb, list, creators, base);
  if (!creators.length) return;

  const listEl = document.getElementById("ro-list");
  const draw = () => {
    const q = st.q.trim().toLowerCase().replace(/^@/, "");
    const [, key, dir] = SORTS[st.sort];
    const rows = creators
      .filter((c) => (!st.platform || c.platform === st.platform) && (!st.country || c.country_code === st.country) && (!q || `${c.username} ${c.display_name ?? ""}`.toLowerCase().includes(q)))
      .sort((a, b) => { const x = key(a), y = key(b); return (x < y ? -1 : x > y ? 1 : 0) * dir; });
    view.order = rows.map((c) => c.id);
    listEl.innerHTML = !rows.length ? `<div class="panel"><p class="muted">No creators match.</p></div>` : `
      <div class="table-wrap ro-table"><table>
        <thead><tr><th>Creator</th><th>Country</th><th class="num">Followers</th><th class="num">Median views</th><th class="num">Engagement</th><th class="num">Posts / week</th><th class="num">Campaigns</th><th>Insights</th>${list ? `<th><span class="sr-only">Remove</span></th>` : ""}</tr></thead>
        <tbody>${rows.map((c) => { const s = c.profile_stats ?? {}; return `
          <tr class="ro-row" data-id="${esc(c.id)}" tabindex="0">
            <td><div class="ro-who">${avatar(c)}<div class="ro-names"><b>${esc(c.display_name || c.username)}${c.is_verified ? ' <span class="tick" title="Verified">✓</span>' : ""}</b><span class="muted small ro-handle"><span class="ro-pfmini" title="${esc(platformOf(c.platform).name)}">${platformOf(c.platform).icon}</span>@${esc(c.username)}</span></div></div></td>
            <td class="small">${place(c.country_code)}</td>
            <td class="num" title="${c.follower_count ?? ""}">${big(c.follower_count)}</td>
            <td class="num">${big(s.median_views)}</td>
            <td class="num">${eng(s.engagement)}</td>
            <td class="num">${perWeek(s.posts_per_week)}</td>
            <td class="num">${c._campaigns || "–"}</td>
            <td>${c._insights ? `<span class="status active">Unlocked</span>` : `<span class="muted small">–</span>`}</td>
            ${list ? `<td class="ro-x-cell"><button type="button" class="ro-x" data-out="${esc(c.id)}" title="Remove from ${esc(list.name)}" aria-label="Remove from ${esc(list.name)}">×</button></td>` : ""}
          </tr>`; }).join("")}</tbody></table></div>
      <p class="muted small" style="margin-top:10px">${rows.length} of ${creators.length} creators. Click a creator to see their numbers, audience and campaigns.</p>`;
    listEl.querySelectorAll(".ro-row").forEach((tr) => {
      tr.onclick = (e) => { if (e.target.closest("[data-out]")) return; cur().go(`${base}/c/${tr.dataset.id}`); };
      tr.onkeydown = (e) => { if (e.key === "Enter") cur().go(`${base}/c/${tr.dataset.id}`); };
    });
    listEl.querySelectorAll("[data-out]").forEach((b) => (b.onclick = async () => {
      const { error } = await sb.from("roster_list_members").delete().eq("list_id", list.id).eq("creator_id", b.dataset.out);
      if (error) return toast(error.message);
      const i = creators.findIndex((c) => c.id === b.dataset.out); if (i >= 0) creators.splice(i, 1);
      toast(`Removed from ${list.name}`); draw();
    }));
    markDrawerRow();
  };
  const bind = (id, k) => { const el = document.getElementById(id); if (!el) return; el.value = st[k]; el.oninput = () => { st[k] = el.value; draw(); }; };
  bind("ro-q", "q"); bind("ro-country", "country"); bind("ro-sort", "sort"); bind("ro-pfilter", "platform");
  draw();
}

const me = async (sb) => (await sb.auth.getUser()).data.user?.email ?? null;

// A small dialog asking for one line of text. Resolves to the text, or null when cancelled.
function askText(title, label, placeholder = "", value = "") {
  return new Promise((resolve) => {
    const d = document.createElement("dialog");
    d.className = "ro-ask";
    d.innerHTML = `<form method="dialog"><h3>${esc(title)}</h3><label>${esc(label)}<input name="v" required maxlength="80" placeholder="${esc(placeholder)}" value="${esc(value)}"></label>
      <div class="actions"><button type="button" data-cancel>Cancel</button><button class="primary" value="ok">Save</button></div></form>`;
    document.body.appendChild(d);
    const done = (v) => { d.close(); d.remove(); resolve(v); };
    d.querySelector("[data-cancel]").onclick = () => done(null);
    d.querySelector("form").onsubmit = (e) => { e.preventDefault(); done(d.querySelector("input").value.trim() || null); };
    d.addEventListener("cancel", () => done(null));
    d.showModal(); d.querySelector("input").select();
  });
}

// Pick roster creators to add to a list.
function pickCreators(sb, list, all, inList, onDone) {
  const d = document.createElement("dialog");
  d.className = "ro-ask ro-pick";
  const rows = all.filter((c) => !inList.has(c.id));
  d.innerHTML = `<form method="dialog"><h3>Add creators to ${esc(list.name)}</h3>
    ${rows.length ? `<input type="search" placeholder="Search name or handle" data-q aria-label="Search">
    <div class="ro-pick-list">${rows.map((c) => `<label class="ro-pick-row" data-name="${esc(`${c.username} ${c.display_name ?? ""}`.toLowerCase())}"><input type="checkbox" value="${esc(c.id)}">${avatar(c, 32)}<span class="ro-names"><b>${esc(c.display_name || c.username)}</b><span class="muted small ro-handle"><span class="ro-pfmini">${platformOf(c.platform).icon}</span>@${esc(c.username)} · ${big(c.follower_count)}</span></span></label>`).join("")}</div>`
      : `<p class="muted">Every roster creator is already on this list. Add more creators to the roster first.</p>`}
    <div class="actions"><span class="muted small" data-n></span><button type="button" data-cancel>Cancel</button>${rows.length ? `<button class="primary" value="ok">Add to list</button>` : ""}</div></form>`;
  document.body.appendChild(d);
  const close = () => { d.close(); d.remove(); };
  d.querySelector("[data-cancel]").onclick = close;
  d.addEventListener("cancel", close);
  const n = d.querySelector("[data-n]");
  d.querySelectorAll("input[type=checkbox]").forEach((x) => (x.onchange = () => { const k = d.querySelectorAll("input[type=checkbox]:checked").length; n.textContent = k ? `${k} selected` : ""; }));
  d.querySelector("[data-q]")?.addEventListener("input", (e) => { const q = e.target.value.trim().toLowerCase().replace(/^@/, ""); d.querySelectorAll(".ro-pick-row").forEach((r) => (r.hidden = !!q && !r.dataset.name.includes(q))); });
  d.querySelector("form").onsubmit = async (e) => {
    e.preventDefault();
    const ids = [...d.querySelectorAll("input[type=checkbox]:checked")].map((x) => x.value);
    if (!ids.length) return close();
    const who = await me(sb);
    const { error } = await sb.from("roster_list_members").insert(ids.map((creator_id) => ({ list_id: list.id, creator_id, added_by: who })));
    if (error) { cur().toast(error.message); return; }
    close(); cur().toast(`Added ${ids.length} creator${ids.length === 1 ? "" : "s"} to ${list.name}`); onDone();
  };
  d.showModal();
}

// ---------- the side panel ----------
let drawerFor = null;
function ensureDrawer() {
  let el = document.getElementById("ro-drawer");
  if (el) return el;
  el = document.createElement("div");
  el.id = "ro-drawer";
  el.className = "ro-drawer";
  el.hidden = true;
  el.innerHTML = `<div class="ro-drawer-back" data-dclose></div>
    <aside class="ro-drawer-panel" role="dialog" aria-modal="false" aria-label="Creator">
      <header class="ro-drawer-head">
        <div class="ro-drawer-nav"><button type="button" data-dstep="-1" aria-label="Previous creator">‹</button><span data-dpos></span><button type="button" data-dstep="1" aria-label="Next creator">›</button></div>
        <a class="btn ro-drawer-full" data-dfull>Open full page</a>
        <button type="button" class="ro-drawer-x" data-dclose aria-label="Close">×</button>
      </header>
      <div class="ro-drawer-body"><main class="ro-drawer-main"></main></div>
      <button type="button" class="to-top in-panel" data-dtop aria-label="Back to the top" title="Back to the top"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 15.5V5M5 9.5 10 4.5l5 5"/></svg></button>
    </aside>`;
  document.body.appendChild(el);
  const body = el.querySelector(".ro-drawer-body"), top = el.querySelector("[data-dtop]");
  body.addEventListener("scroll", () => top.classList.toggle("on", body.scrollTop > 500), { passive: true });
  top.onclick = () => body.scrollTo({ top: 0, behavior: "smooth" });
  window.addEventListener("hashchange", () => { if (!/^#\/roster(\/|$)/.test(location.hash)) { closeDrawer(true); view.base = null; } });
  el.querySelectorAll("[data-dclose]").forEach((b) => (b.onclick = () => cur().go(view.base)));
  el.querySelectorAll("[data-dstep]").forEach((b) => (b.onclick = () => {
    const i = view.order.indexOf(drawerFor), j = i + Number(b.dataset.dstep);
    if (i >= 0 && j >= 0 && j < view.order.length) cur().go(`${view.base}/c/${view.order[j]}`);
  }));
  document.addEventListener("keydown", (e) => {
    if (el.hidden || document.querySelector("dialog[open]")) return;
    if (e.key === "Escape") cur().go(view.base);
    if ((e.key === "ArrowDown" || e.key === "ArrowUp") && e.altKey) el.querySelector(`[data-dstep="${e.key === "ArrowDown" ? 1 : -1}"]`).click();
  });
  return el;
}
function markDrawerRow() {
  document.querySelectorAll(".ro-row.open, .cmp-row.open").forEach((r) => r.classList.remove("open"));
  if (drawerFor) document.querySelectorAll(`.ro-row[data-id="${drawerFor}"], .cmp-row[data-id="${drawerFor}"]`).forEach((r) => r.classList.add("open"));
}
function closeDrawer(instant) {
  const el = document.getElementById("ro-drawer");
  drawerFor = null;
  document.body.classList.remove("drawer-open");
  if (!el) return;
  el.classList.remove("in");
  const clear = () => { el.hidden = true; el.querySelector(".ro-drawer-main").innerHTML = ""; };
  if (instant) clear(); else setTimeout(() => { if (!drawerFor) clear(); }, 220);
  markDrawerRow();
}
function syncDrawer(sb, id) {
  if (!id) return closeDrawer();
  const el = ensureDrawer();
  const first = el.hidden;
  drawerFor = id;
  el.hidden = false;
  requestAnimationFrame(() => el.classList.add("in"));
  document.body.classList.add("drawer-open");
  const i = view.order.indexOf(id);
  el.querySelector("[data-dpos]").textContent = i >= 0 ? `${i + 1} of ${view.order.length}` : "";
  el.querySelector("[data-dstep='-1']").disabled = i <= 0;
  el.querySelector("[data-dstep='1']").disabled = i < 0 || i >= view.order.length - 1;
  el.querySelector("[data-dfull]").href = `#/creator/${id}`;
  markDrawerRow();
  const main = el.querySelector(".ro-drawer-main");
  el.querySelector(".ro-drawer-body").scrollTop = 0;
  const ctx = { ...cur(), isCurrent: () => drawerFor === id && !el.hidden, inDrawer: true, list: view.listCache?.list ?? null };
  renderCreator(main, sb, ctx, id);
  if (first) el.querySelector(".ro-drawer-x").focus({ preventScroll: true });
}

// ---------- list comparison ----------
// Influencers.club numbers for each list member (followers, growth, engagement, audience per country, credibility).
async function listStats(sb, creators) {
  const handles = [...new Set(creators.map((c) => String(c.username).toLowerCase()))];
  const { data } = handles.length ? await sb.from("creator_insight_summary").select("*").in("handle", handles) : { data: [] };
  const by = new Map((data ?? []).map((r) => [`${r.platform}:${r.handle}`, r]));
  return creators.map((c) => {
    const s = by.get(`${c.platform}:${String(c.username).toLowerCase()}`) ?? null;
    const followers = Number(c.follower_count ?? s?.followers ?? 0) || null;
    const geo = Object.fromEntries((s?.countries ?? []).map((x) => [x.code, { name: x.name, weight: x.weight }]));
    const real = (s?.audience_types ?? []).find((t) => t.code === "real")?.weight ?? null;
    const female = (s?.genders ?? []).find((g) => g.code === "FEMALE")?.weight ?? null;
    const ages = Object.fromEntries((s?.ages ?? []).map((a) => [a.code, a.weight]));
    return {
      c, s, followers, geo, real, female, ages,
      young: s?.ages?.length ? (ages["13-17"] ?? 0) + (ages["18-24"] ?? 0) : null,
      growth: (m) => (s?.growth?.[`${m}_months_ago`] ?? null),
      engagement: s?.engagement_percent != null ? Number(s.engagement_percent) : c.profile_stats?.engagement != null ? c.profile_stats.engagement * 100 : null,
      views: c.profile_stats?.median_views ?? (s?.avg_views != null ? Number(s.avg_views) : null),
      audienceIn: (code) => (followers && geo[code] ? followers * geo[code].weight : null),
      shareIn: (code) => geo[code]?.weight ?? null,
    };
  });
}
const cmpState = { platform: "", country: "", months: 3, metric: "aud", focus: "", off: new Set() };

// How alike two creators are (0–1), from what both have: size, where their audience is, audience age and
// gender, and engagement. Returns the score and the reasons behind it.
function similarity(a, b) {
  const parts = [];
  const reasons = [];
  if (a.followers && b.followers) {
    const d = Math.abs(Math.log10(a.followers) - Math.log10(b.followers));
    const v = Math.max(0, 1 - d / 1.5);
    parts.push([v, 0.25]);
    if (v > 0.75) reasons.push("similar size");
  }
  const ga = Object.entries(a.geo), gb = b.geo;
  if (ga.length && Object.keys(gb).length) {
    let dot = 0, na = 0, nb = 0;
    for (const [k, x] of ga) { dot += x.weight * (gb[k]?.weight ?? 0); na += x.weight ** 2; }
    for (const x of Object.values(gb)) nb += x.weight ** 2;
    const v = na && nb ? dot / Math.sqrt(na * nb) : 0;
    parts.push([v, 0.4]);
    const shared = ga.filter(([k]) => gb[k]).map(([k, x]) => [x.name, Math.min(x.weight, gb[k].weight)]).sort((p, q) => q[1] - p[1]).slice(0, 2).map(([n]) => n);
    if (v > 0.5 && shared.length) reasons.push(`both strong in ${shared.join(" and ")}`);
  }
  const ka = Object.keys(a.ages);
  if (ka.length && Object.keys(b.ages).length) {
    const keys = new Set([...ka, ...Object.keys(b.ages)]);
    let l1 = 0; for (const k of keys) l1 += Math.abs((a.ages[k] ?? 0) - (b.ages[k] ?? 0));
    const v = Math.max(0, 1 - l1 / 2);
    parts.push([v, 0.15]);
    if (v > 0.85) reasons.push("same age mix");
  }
  if (a.female != null && b.female != null) {
    const v = 1 - Math.abs(a.female - b.female);
    parts.push([v, 0.1]);
    if (v > 0.92) reasons.push("same gender split");
  }
  if (a.engagement && b.engagement) {
    const v = Math.max(0, 1 - Math.abs(Math.log(a.engagement / b.engagement)) / Math.log(4));
    parts.push([v, 0.1]);
  }
  if (a.c.country_code && a.c.country_code === b.c.country_code) reasons.push(`both from ${regionName(a.c.country_code)}`);
  const w = parts.reduce((t, [, x]) => t + x, 0);
  // Less shared data means less confidence: a match on size alone counts for less than one on audience too.
  const raw = w ? parts.reduce((t, [v, x]) => t + v * x, 0) / w : 0;
  return { score: raw * Math.min(1, 0.4 + w), reasons, basis: w };
}
const avgOf = (xs) => { const v = xs.filter((x) => x != null && Number.isFinite(x)); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };

async function renderCompare(box, sb, list, creators, base) {
  if (!creators.length) { box.innerHTML = `<section class="panel ro-empty"><h3>Nothing to compare yet</h3><p class="muted">Add creators to this list first.</p></section>`; return; }
  box.innerHTML = `<p class="muted pad">Comparing…</p>`;
  const rowsAll = await listStats(sb, creators);
  if (!box.isConnected) return;
  const plats = PLATFORM_ORDER.filter((p) => creators.some((c) => c.platform === p));
  if (!plats.includes(cmpState.platform)) cmpState.platform = plats.sort((a, b) => creators.filter((c) => c.platform === b).length - creators.filter((c) => c.platform === a).length)[0];
  const draw = () => {
    const rows = rowsAll.filter((r) => r.c.platform === cmpState.platform);
    const withIns = rows.filter((r) => r.s);
    // Countries ranked by the list's combined audience there.
    const totals = {};
    for (const r of withIns) for (const [code, g] of Object.entries(r.geo)) { totals[code] ??= { name: g.name, total: 0 }; totals[code].total += r.audienceIn(code) ?? 0; }
    const countryList = Object.entries(totals).sort((a, b) => b[1].total - a[1].total);
    if (!totals[cmpState.country]) cmpState.country = countryList[0]?.[0] ?? "";
    const cc = cmpState.country, m = cmpState.months;
    const cname = totals[cc]?.name ?? regionName(cc);
    const metric = {
      followers: (r) => r.followers, growth: (r) => r.growth(m), engagement: (r) => r.engagement, views: (r) => r.views,
      aud: (r) => r.audienceIn(cc), share: (r) => (r.shareIn(cc) != null ? r.shareIn(cc) * 100 : null), real: (r) => (r.real != null ? r.real * 100 : null),
      female: (r) => (r.female != null ? r.female * 100 : null), young: (r) => (r.young != null ? r.young * 100 : null),
    };
    const avg = Object.fromEntries(Object.entries(metric).map(([k, f]) => [k, avgOf(rows.map(f))]));
    const best = Object.fromEntries(Object.entries(metric).map(([k, f]) => [k, rows.filter((r) => f(r) != null).sort((a, b) => f(b) - f(a))[0] ?? null]));
    const rank = (k, r) => { const v = metric[k](r); if (v == null) return null; return rows.filter((x) => metric[k](x) != null && metric[k](x) > v).length + 1; };
    const ranked = (k) => rows.filter((r) => metric[k](r) != null).length;
    const name = (r) => esc(r.c.display_name || r.c.username);
    const fmt = { followers: (v) => big(Math.round(v)), growth: (v) => `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(1)}%`, engagement: (v) => `${v.toFixed(1)}%`, views: (v) => big(Math.round(v)),
      aud: (v) => compact(Math.round(v)), share: (v) => `${v.toFixed(1)}%`, real: (v) => `${Math.round(v)}%`, female: (v) => `${Math.round(v)}%`, young: (v) => `${Math.round(v)}%` };
    const LABEL = { aud: `Audience in ${cname || "–"}`, share: `Share of audience in ${cname || "–"}`, followers: "Followers", growth: `Growth · ${m} months`, engagement: "Engagement", views: "Median views",
      female: "Female audience", young: "Audience under 25", real: "Real audience" };
    const SUB = { aud: "estimated followers there (followers × share of audience)", share: "share of their audience in that country", followers: "", growth: `change over the last ${m} months`,
      engagement: "interactions per view (Influencers.club)", views: "median views of recent posts", female: "share of followers who are women", young: "share of followers aged 13–24", real: "share of real people in the engaged audience (Instagram)" };
    const tfmt = { ...fmt, followers: (v) => compact(Math.round(v)), views: (v) => compact(Math.round(v)) };
    // Benchmark cells: the value and the rank sit in fixed slots, so every column lines up row after row.
    const bm = (val, rk = "", cls = "", top = false) => `<div class="bm"><span class="bm-v ${cls}">${val}</span><span class="bm-r${top ? " top" : ""}">${rk}</span></div>`;
    const cell = (k, r) => {
      const v = metric[k](r);
      if (v == null) return `<td class="num">${bm('<span class="muted">–</span>')}</td>`;
      const a = avg[k], rk = rank(k, r), n = ranked(k);
      const cls = a == null || n < 2 ? "" : v > a * 1.001 ? "up" : v < a * 0.999 ? "down" : "";
      return `<td class="num">${bm(tfmt[k](v), n > 1 ? `#${rk}` : "", cls, n > 1 && rk === 1)}</td>`;
    };
    const barList = (k, label, sub) => {
      const xs = rows.filter((r) => metric[k](r) != null).sort((a, b) => metric[k](b) - metric[k](a));
      if (!xs.length) return `<p class="muted small">No data yet. ${rows.some((r) => !r.s) ? "Unlock insights for the creators below to include them." : ""}</p>`;
      const vals = xs.map((r) => metric[k](r));
      const lo = Math.min(0, ...vals), hi = Math.max(...vals, 0.0001), span = hi - lo || 1;
      const a = avg[k];
      return `<div class="cmp-bars">${xs.map((r) => { const v = metric[k](r); return `
        <button type="button" class="cmp-row" data-id="${esc(r.c.id)}"><span class="cmp-n">${avatar(r.c, 24)}<span>${name(r)}</span></span>
          <span class="cmp-t">${a != null && xs.length > 1 ? `<i class="cmp-avg" style="left:${((a - lo) / span) * 100}%" title="List average ${esc(fmt[k](a))}"></i>` : ""}<i class="cmp-fill${v < 0 ? " neg" : ""}" style="left:${((Math.min(v, 0) - lo) / span) * 100}%;width:${(Math.abs(v) / span) * 100}%"></i></span>
          <span class="cmp-val">${fmt[k](v)}${sub ? ` <small>${sub(r)}</small>` : ""}</span></button>`; }).join("")}</div>
        ${a != null && xs.length > 1 ? `<p class="muted small cmp-legend"><i class="cmp-avg-key"></i> List average: ${esc(fmt[k](a))}</p>` : ""}`;
    };
    const missing = rows.filter((r) => !r.s);
    const bestAud = best.aud, bestGrowth = best.growth;
    if (!metric[cmpState.metric] || !rows.some((r) => metric[cmpState.metric](r) != null)) cmpState.metric = ["aud", "followers", "engagement", "views"].find((k) => rows.some((r) => metric[k](r) != null)) ?? "followers";

    // Focus: one creator against the most similar creators on the list.
    function focusPanel() {
      if (rows.length < 3) return "";
      if (!rows.some((r) => r.c.id === cmpState.focus)) cmpState.focus = (withIns[0] ?? rows[0]).c.id;
      const f = rows.find((r) => r.c.id === cmpState.focus);
      const others = rows.filter((r) => r !== f).map((r) => ({ r, ...similarity(f, r) })).sort((x, y) => y.score - x.score);
      const auto = new Set(others.slice(0, Math.min(3, others.length)).map((o) => o.r.c.id));
      const peers = others.filter((o) => (cmpState.off.has(o.r.c.id) ? false : auto.has(o.r.c.id) || cmpState.off.has(`+${o.r.c.id}`)));
      const pr = peers.map((o) => o.r);
      const KEYS = ["followers", "growth", "engagement", "views", "female", "young", "real"];
      // Percentages (growth, engagement, audience shares) differ in points; counts differ in percent.
      const lineRow = (label, fv, vals, fmtv, bestName, points = false) => {
        if (fv == null && !vals.some((x) => x != null)) return "";
        const pv = vals.filter((x) => x != null), pa = avgOf(pv);
        const diff = fv == null || pa == null ? null : points ? fv - pa : pa ? (fv / pa - 1) * 100 : null;
        const rk = fv != null ? [fv, ...pv].filter((x) => x > fv).length + 1 : null;
        return `<tr><td>${esc(label)}</td><td class="num"><b class="${diff == null ? "" : diff >= 0 ? "up" : "down"}">${fv != null ? fmtv(fv) : "–"}</b></td>
          <td class="num">${pa != null ? fmtv(pa) : "–"}</td>
          <td class="num">${diff != null ? `<span class="cmp-diff ${diff >= 0 ? "up" : "down"}">${diff >= 0 ? "+" : "−"}${points ? `${Math.abs(diff).toFixed(1)} pts` : `${Math.abs(diff).toFixed(0)}%`}</span>` : "–"}</td>
          <td class="num">${rk ? `#${rk} of ${pv.length + 1}` : "–"}</td>
          <td class="num small muted">${bestName ?? ""}</td></tr>`;
      };
      const bestPeer = (fn) => { const b = pr.filter((r) => fn(r) != null).sort((x, y) => fn(y) - fn(x))[0]; return b ? `${esc(b.c.display_name || b.c.username)} ${fmt[Object.keys(metric).find((k) => metric[k] === fn) ?? "followers"]?.(fn(b)) ?? ""}` : ""; };
      const metricRows = KEYS.map((k) => lineRow(LABEL[k].replace(` · ${m} months`, ` · ${m} mo`), metric[k](f), pr.map(metric[k]), fmt[k], (() => { const b = pr.filter((r) => metric[k](r) != null).sort((x, y) => metric[k](y) - metric[k](x))[0]; return b ? `${esc(b.c.display_name || b.c.username)} ${fmt[k](metric[k](b))}` : ""; })(), ["growth", "engagement", "female", "young", "real"].includes(k))).join("");
      const topC = Object.entries(f.geo).sort((x, y) => y[1].weight - x[1].weight).slice(0, 6);
      const countryRows = topC.map(([code, g]) => {
        const fv = f.audienceIn(code);
        const pv = pr.map((r) => r.audienceIn(code));
        const b = pr.filter((r) => r.audienceIn(code) != null).sort((x, y) => y.audienceIn(code) - x.audienceIn(code))[0];
        return lineRow(`${flag(code)} ${g.name}`, fv, pv, (v) => compact(Math.round(v)), b ? `${esc(b.c.display_name || b.c.username)} ${compact(Math.round(b.audienceIn(code)))}` : "");
      }).join("");
      return `<section class="panel cmp-focus">
        <div class="cmp-h"><h3>Benchmark one ${list.name.toLowerCase().includes("club") ? "club" : "creator"} against similar ones</h3><span class="muted small">peers picked by audience countries, size, age and gender mix, and engagement</span></div>
        <div class="cmp-focus-top">
          <label class="ov-pill ov-sort"><span>Benchmark</span><select id="cmp-focus">${rows.map((r) => `<option value="${esc(r.c.id)}"${r === f ? " selected" : ""}>${esc(r.c.display_name || r.c.username)}${r.s ? "" : " (no insights)"}</option>`).join("")}</select></label>
          ${!f.s ? `<span class="muted small">Unlock insights for ${esc(f.c.display_name || f.c.username)} to match on audience, not just size.</span>` : ""}
        </div>
        <div class="cmp-peers">${others.map((o) => { const on = peers.includes(o);
          return `<button type="button" class="cmp-peer${on ? " on" : ""}" data-peer="${esc(o.r.c.id)}" aria-pressed="${on}">${avatar(o.r.c, 28)}<span class="cmp-peer-t"><b>${esc(o.r.c.display_name || o.r.c.username)} <span class="cmp-sim">${Math.round(o.score * 100)}% alike</span></b>
            <span class="muted small">${esc(o.reasons.slice(0, 2).join(" · ") || (o.basis < 0.5 ? "matched on size and engagement only" : "different audience"))}</span></span></button>`; }).join("")}</div>
        ${pr.length ? `<div class="cmp-focus-grid">
          <div class="table-wrap"><table class="cmp-ft"><thead><tr><th>Metric</th><th class="num">${esc(f.c.display_name || f.c.username)}</th><th class="num">Peers average</th><th class="num">Difference</th><th class="num">Rank</th><th class="num">Best peer</th></tr></thead><tbody>${metricRows}</tbody></table></div>
          ${countryRows ? `<div class="table-wrap"><table class="cmp-ft"><thead><tr><th>Audience in its top countries</th><th class="num">${esc(f.c.display_name || f.c.username)}</th><th class="num">Peers average</th><th class="num">Difference</th><th class="num">Rank</th><th class="num">Best peer there</th></tr></thead><tbody>${countryRows}</tbody></table></div>` : ""}
        </div>` : `<p class="muted small">Pick at least one peer above.</p>`}
      </section>`;
    }
    const tools = document.getElementById("ro-listtools");
    if (tools) tools.innerHTML = `
        ${plats.length > 1 ? `<label class="ov-pill ov-sort"><span>Platform</span><select id="cmp-pf">${plats.map((p) => `<option value="${p}"${p === cmpState.platform ? " selected" : ""}>${PLATFORMS[p].name}</option>`).join("")}</select></label>` : ""}
        <label class="ov-pill ov-sort"><span>Audience in</span><select id="cmp-cc">${countryList.length ? countryList.map(([code, t]) => `<option value="${esc(code)}"${code === cc ? " selected" : ""}>${esc(t.name)}</option>`).join("") : `<option>No data yet</option>`}</select></label>
        <label class="ov-pill ov-sort"><span>Growth over</span><select id="cmp-m">${[3, 6, 9, 12].map((x) => `<option value="${x}"${x === m ? " selected" : ""}>${x} months</option>`).join("")}</select></label>`;
    box.innerHTML = `
      <div class="cmp-cards">
        <div class="cmp-card"><div class="l">List average growth · ${m} months</div><div class="n">${avg.growth != null ? fmt.growth(avg.growth) : "–"}</div><div class="s">${bestGrowth ? `Fastest: ${name(bestGrowth)} ${fmt.growth(metric.growth(bestGrowth))}` : "Needs insights"}</div></div>
        <div class="cmp-card"><div class="l">Combined audience in ${esc(cname || "–")}</div><div class="n">${totals[cc] ? compact(Math.round(totals[cc].total)) : "–"}</div><div class="s">${bestAud ? `Largest: ${name(bestAud)} ${fmt.aud(metric.aud(bestAud))}` : "Needs insights"}</div></div>
        <div class="cmp-card"><div class="l">Average engagement</div><div class="n">${avg.engagement != null ? fmt.engagement(avg.engagement) : "–"}</div><div class="s">${best.engagement ? `Highest: ${name(best.engagement)} ${fmt.engagement(metric.engagement(best.engagement))}` : ""}</div></div>
        <div class="cmp-card"><div class="l">Total followers</div><div class="n">${compact(Math.round(rows.reduce((t, r) => t + (r.followers ?? 0), 0)))}</div><div class="s">${rows.length} creator${rows.length === 1 ? "" : "s"} on ${esc(PLATFORMS[cmpState.platform].name)}</div></div>
      </div>
      <section class="panel cmp-rank">
        <div class="cmp-h"><h3>Rank the list</h3><span class="muted small">${esc(SUB[cmpState.metric] ?? "")}</span></div>
        <div class="cmp-chips" role="tablist">${Object.keys(LABEL).map((k) => { const nData = rows.filter((r) => metric[k](r) != null).length;
          return `<button type="button" class="cmp-chip${k === cmpState.metric ? " on" : ""}" data-metric="${k}"${nData ? "" : " disabled title=\"No data yet\""}>${esc(LABEL[k])}${nData ? "" : " · no data"}</button>`; }).join("")}</div>
        ${barList(cmpState.metric, "", cmpState.metric === "aud" ? (r) => (r.shareIn(cc) != null ? `${(r.shareIn(cc) * 100).toFixed(0)}%` : "") : null)}
      </section>
      ${focusPanel()}
      <section class="panel cmp-tablep"><div class="cmp-h"><h3>Benchmarks <span class="muted small" style="font-weight:400">${PLATFORMS[cmpState.platform].name} · ${withIns.length} of ${rows.length} with insights</span></h3><span class="muted small"><span class="up">green</span> above the list average · <span class="down">red</span> below · #rank in the list</span></div>
        ${(() => {
          const HEAD = { followers: "Followers", growth: `Growth · ${m} mo`, engagement: "Engagement", views: "Median views", aud: `Audience in ${esc(cname || "–")}`, share: `Share of audience`, real: "Real audience" };
          // Leave out columns nobody in the list has data for (e.g. real audience outside Instagram).
          const cols = Object.keys(HEAD).filter((k) => rows.some((r) => metric[k](r) != null));
          const sorted = rows.slice().sort((a, b) => (metric.aud(b) ?? -1) - (metric.aud(a) ?? -1) || (b.followers ?? 0) - (a.followers ?? 0));
          return `<div class="table-wrap cmp-table"><table>
          <colgroup><col class="bm-c-name">${cols.map(() => "<col>").join("")}</colgroup>
          <thead><tr><th>Creator</th>${cols.map((k) => `<th class="num"><span class="bm-h">${HEAD[k]}</span></th>`).join("")}</tr></thead>
          <tbody>${sorted.map((r) => `
            <tr class="cmp-row" data-id="${esc(r.c.id)}" tabindex="0"><td><div class="ro-who">${avatar(r.c, 32)}<div class="ro-names"><b>${name(r)}</b><span class="muted small">@${esc(r.c.username)}</span>${r.s ? "" : `<span class="bm-tag">No insights</span>`}</div></div></td>
              ${cols.map((k) => cell(k, r)).join("")}</tr>`).join("")}</tbody>
          <tfoot><tr><td>List average</td>${cols.map((k) => `<td class="num">${bm(avg[k] != null ? tfmt[k](avg[k]) : "–")}</td>`).join("")}</tr>
            <tr><td>Best in the list</td>${cols.map((k) => `<td class="num">${best[k] ? `${bm(tfmt[k](metric[k](best[k])))}<div class="bm-who">${name(best[k])}</div>` : bm("–")}</td>`).join("")}</tr></tfoot>
          </table></div>${cols.length < Object.keys(HEAD).length ? `<p class="muted small" style="margin:8px 0 0">Not shown, no data yet: ${Object.keys(HEAD).filter((k) => !cols.includes(k)).map((k) => HEAD[k].toLowerCase()).join(", ")}.</p>` : ""}`;
        })()}
        <p class="muted small" style="margin:10px 0 0">Growth, audience per country and real audience come from Influencers.club insights (real audience: Instagram only). Followers and median views come from the weekly roster refresh.</p>
      </section>
      ${missing.length ? `<section class="panel cmp-missing"><h3>Not compared yet</h3><p class="muted small">These creators have no insights, so growth and audience per country are missing. Unlocking uses 1 Influencers.club credit each.</p>
        <div class="cmp-miss-list">${missing.map((r) => `<div class="cmp-miss">${avatar(r.c, 28)}<span>${name(r)}</span><button type="button" data-unlock="${esc(r.c.id)}">Unlock insights</button></div>`).join("")}</div></section>` : ""}`;
    view.order = rows.map((r) => r.c.id);
    document.querySelector("#cmp-pf")?.addEventListener("change", (e) => { cmpState.platform = e.target.value; draw(); });
    document.querySelector("#cmp-cc").onchange = (e) => { cmpState.country = e.target.value; draw(); };
    document.querySelector("#cmp-m").onchange = (e) => { cmpState.months = Number(e.target.value); draw(); };
    box.querySelectorAll("[data-metric]").forEach((b) => (b.onclick = () => { cmpState.metric = b.dataset.metric; draw(); }));
    box.querySelector("#cmp-focus")?.addEventListener("change", (e) => { cmpState.focus = e.target.value; cmpState.off = new Set(); draw(); });
    box.querySelectorAll("[data-peer]").forEach((b) => (b.onclick = () => {
      const id = b.dataset.peer, on = b.getAttribute("aria-pressed") === "true";
      if (on) { cmpState.off.add(id); cmpState.off.delete(`+${id}`); } else { cmpState.off.delete(id); cmpState.off.add(`+${id}`); }
      draw();
    }));
    box.querySelectorAll(".cmp-row").forEach((r) => {
      r.onclick = () => cur().go(`${base}/c/${r.dataset.id}`);
      r.onkeydown = (e) => { if (e.key === "Enter") cur().go(`${base}/c/${r.dataset.id}`); };
    });
    box.querySelectorAll("[data-unlock]").forEach((b) => (b.onclick = async () => {
      const r = rows.find((x) => x.c.id === b.dataset.unlock);
      b.disabled = true; b.textContent = "Unlocking…";
      try {
        await invoke(sb, "creator-insights", { handle: String(r.c.username).toLowerCase(), platform: r.c.platform });
        cur().toast(`Insights unlocked for ${r.c.display_name || r.c.username}`);
        const fresh = await listStats(sb, creators);
        rowsAll.splice(0, rowsAll.length, ...fresh); draw();
      } catch (err) { cur().toast(err.message); b.disabled = false; b.textContent = "Unlock insights"; }
    }));
    markDrawerRow();
  };
  draw();
}

// How one creator compares with the rest of a list (shown on the creator's page when opened from that list).
async function compareSnippet(sb, list, c) {
  const { data: mem } = await sb.from("roster_list_members").select("creator:creators(id,username,display_name,avatar_url,follower_count,platform,profile_stats)").eq("list_id", list.id);
  const creators = (mem ?? []).map((m) => m.creator).filter((x) => x && (x.platform ?? "tiktok") === (c.platform ?? "tiktok"));
  if (creators.length < 2) return "";
  creators.forEach((x) => (x.platform ??= "tiktok"));
  const rows = await listStats(sb, creators);
  const me_ = rows.find((r) => r.c.id === c.id);
  if (!me_) return "";
  const top = Object.entries(me_.geo).sort((a, b) => b[1].weight - a[1].weight)[0];
  const items = [];
  const line = (label, f, fmtv) => {
    const v = f(me_); if (v == null) return;
    const vals = rows.map(f).filter((x) => x != null);
    if (vals.length < 2) return;
    const rk = vals.filter((x) => x > v).length + 1, a = avgOf(vals), bestR = rows.filter((r) => f(r) != null).sort((x, y) => f(y) - f(x))[0];
    items.push(`<div class="cmp-mini"><div class="l">${esc(label)}</div><div class="n"><span class="${v > a ? "up" : v < a ? "down" : ""}">${fmtv(v)}</span> <span class="cmp-rk${rk === 1 ? " top" : ""}">#${rk} of ${vals.length}</span></div>
      <div class="s">list average ${fmtv(a)}${bestR.c.id !== c.id ? ` · best ${esc(bestR.c.display_name || bestR.c.username)} ${fmtv(f(bestR))}` : " · best in the list"}</div></div>`);
  };
  line("Followers", (r) => r.followers, (v) => compact(Math.round(v)));
  line("Growth · 3 months", (r) => r.growth(3), (v) => `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(1)}%`);
  line("Engagement", (r) => r.engagement, (v) => `${v.toFixed(1)}%`);
  if (top) line(`Audience in ${top[1].name}`, (r) => r.audienceIn(top[0]), (v) => compact(Math.round(v)));
  if (!items.length) return "";
  return `<section class="panel ro-cmp-snip"><div class="cmp-h"><h3>Compared with ${esc(list.name)}</h3><a href="#/roster/list/${esc(list.id)}/compare" class="small">Full comparison</a></div><div class="cmp-minis">${items.join("")}</div></section>`;
}

// ---------- one creator ----------
async function renderCreator(app, sb, ctx, id) {
  const { isCurrent, go, toast } = ctx;
  app.innerHTML = `<p class="muted pad">Loading the creator…</p>`;
  const { data: c, error } = await sb.from("creators").select("*").eq("id", id).maybeSingle();
  if (!isCurrent()) return;
  if (error || !c) { app.innerHTML = `<div class="panel"><p>This creator doesn't exist.</p><p><a href="#/roster">Back to the roster</a></p></div>`; return; }
  const [postsRes, insRes, listsRes, myListsRes] = await Promise.all([
    sb.from("posts").select("campaign_id,tiktok_video_id,published_at,campaign:campaigns(id,artist,song,status)").eq("creator_id", id),
    sb.from("creator_insights").select("*").eq("platform", c.platform ?? "tiktok").eq("handle", String(c.username).toLowerCase()).maybeSingle(),
    sb.from("roster_lists").select("id,name").order("created_at"),
    sb.from("roster_list_members").select("list_id").eq("creator_id", id),
  ]);
  const allLists = listsRes.data ?? [];
  const mine = new Set((myListsRes.data ?? []).map((m) => m.list_id));
  if (!isCurrent()) return;
  const posts = postsRes.data ?? [];
  const vids = [...new Set(posts.map((p) => p.tiktok_video_id))];
  const latest = vids.length ? (await sb.from("post_latest_stats").select("tiktok_video_id,plays").in("tiktok_video_id", vids)).data ?? [] : [];
  const playsBy = Object.fromEntries(latest.map((r) => [r.tiktok_video_id, r.plays ?? 0]));
  const byCamp = {};
  for (const p of posts) {
    const k = p.campaign_id;
    byCamp[k] ??= { camp: p.campaign, posts: 0, views: 0, last: null };
    byCamp[k].posts++; byCamp[k].views += playsBy[p.tiktok_video_id] ?? 0;
    if (p.published_at && (!byCamp[k].last || p.published_at > byCamp[k].last)) byCamp[k].last = p.published_at;
  }
  const campRows = Object.values(byCamp).sort((a, b) => String(b.last ?? "").localeCompare(String(a.last ?? "")));
  const s = c.profile_stats ?? {};
  const rv = Array.isArray(c.recent_videos) ? c.recent_videos : [];
  const paths = rv.map((v) => v.cover_path).filter(Boolean);
  let covers = {};
  if (paths.length) {
    const { data } = await sb.storage.from("covers").createSignedUrls(paths, 3600);
    covers = Object.fromEntries((data ?? []).filter((x) => x.signedUrl).map((x) => [x.path, x.signedUrl]));
  }
  if (!isCurrent()) return;
  const ins = insRes.data && !insRes.data.error ? insRes.data : null;
  const pf = platformOf(c.platform);
  const tiktokUrl = pf.url(c.username);
  const perFollower = s.engagement_basis === "followers";

  app.innerHTML = `
    <section class="band sh-band art-band${c.avatar_url ? " has-img" : ""}"${c.avatar_url ? ` style="--art:url('${esc(c.avatar_url)}')"` : ""}>
      <div class="art-bg" aria-hidden="true"></div>
      <div class="art-inner">
        <div class="hero"><div class="art-id">
          <div class="art-avatar">${c.avatar_url ? `<img src="${esc(c.avatar_url)}" alt="" referrerpolicy="no-referrer">` : `<span>${esc((c.display_name || c.username || "?").charAt(0).toUpperCase())}</span>`}</div>
          <div class="art-text">
            <h1>${esc(c.display_name || c.username)}</h1>
            <div class="voice"><a href="${esc(tiktokUrl)}" target="_blank" rel="noopener"><span class="ro-pfmini lg">${pf.icon}</span>@${esc(c.username)}</a></div>
            <div class="hero-keys">
              ${c.on_roster ? `<span class="key-chip">On the roster</span>` : `<span class="key-chip">Not on the roster</span>`}
              ${c.country_code ? `<span class="key-chip">${place(c.country_code)}</span>` : ""}
              ${c.is_verified ? `<span class="key-chip">✓ Verified</span>` : ""}
              ${c.stats_checked_at ? `<span class="hero-upd">Updated ${esc(ago(c.stats_checked_at)).toLowerCase()}</span>` : ""}
            </div>
          </div>
        </div></div>
        <div class="actions hero-actions">
          ${c.on_roster ? "" : `<button type="button" class="primary" id="cr-add">Add to roster</button>`}
          <button type="button" id="cr-refresh">Refresh numbers</button>
          <a class="btn" href="${esc(tiktokUrl)}" target="_blank" rel="noopener">Open on ${esc(pf.name)}</a>
          ${c.on_roster ? `<details class="ro-lists" id="cr-lists"><summary class="btn">Lists${mine.size ? ` · ${mine.size}` : ""}</summary>
            <div class="ro-lists-pop">
              ${allLists.length ? allLists.map((l) => `<label><input type="checkbox" data-list="${esc(l.id)}"${mine.has(l.id) ? " checked" : ""}> ${esc(l.name)}</label>`).join("") : `<p class="muted small" style="margin:0">No lists yet.</p>`}
              <form class="ro-lists-new" id="cr-newlist"><input placeholder="New list, e.g. Football clubs" maxlength="80" aria-label="New list name"><button type="submit">Add</button></form>
            </div></details>` : ""}
          ${c.on_roster ? `<button type="button" id="cr-remove" class="danger-lite">Remove from roster</button>` : ""}
        </div>
      </div>
    </section>
    ${c.stats_error ? `<p class="warn-note small" style="margin-top:12px">Last refresh: ${esc(c.stats_error)}</p>` : ""}
    <div class="stats ro-stats">
      ${tile(c.platform === "youtube" ? "Subscribers" : "Followers", big(c.follower_count ?? s.followers), c.follower_count)}
      ${tile(c.platform === "instagram" ? "Median reel plays" : c.platform === "twitch" ? "Median broadcast views" : "Median views", big(s.median_views), s.median_views, s.avg_views != null ? `avg ${big(s.avg_views)}` : "")}
      ${tile("Engagement rate", eng(s.engagement), null, perFollower ? "interactions per post, of followers" : "interactions per view")}
      ${tile("Median likes", big(s.median_likes), s.median_likes)}
      ${s.median_shares != null ? tile("Median shares", big(s.median_shares), s.median_shares, s.median_comments != null ? `${big(s.median_comments)} comments` : "") : tile("Median comments", big(s.median_comments), s.median_comments)}
      ${tile(c.platform === "twitch" ? "Broadcasts per week" : "Posts per week", perWeek(s.posts_per_week), null, s.last_post ? `last ${ago(s.last_post)}` : "")}
    </div>
    <div id="cr-cmp"></div>
    <p class="muted small ro-basis">${s.sample ? `Based on their ${s.sample} most recent ${c.platform === "instagram" ? "posts" : c.platform === "twitch" ? "broadcasts" : "videos"}${c.platform === "tiktok" ? " (pinned videos left out)" : ""}.` : c.platform === "twitter" ? "X numbers come from the profile only." : "No recent posts found yet."}</p>

    <div class="ro-cols">
      <section class="panel">
        <div class="section-head" style="margin:0 0 10px"><h3 style="margin:0">Campaigns with Stellar</h3></div>
        ${campRows.length ? `<table class="ro-camps"><thead><tr><th>Campaign</th><th class="num">Posts</th><th class="num">Views</th><th>Latest</th></tr></thead><tbody>
          ${campRows.map((r) => `<tr><td>${r.camp ? `<a href="#/c/${esc(r.camp.id)}">${esc(r.camp.artist)}${r.camp.song ? ` – ${esc(r.camp.song)}` : ""}</a>` : "–"}</td><td class="num">${r.posts}</td><td class="num">${big(r.views)}</td><td class="small muted">${r.last ? esc(ago(r.last)) : "–"}</td></tr>`).join("")}
        </tbody></table>` : `<p class="muted small">Not in any campaign yet. Their posts show up here once their video links are added to a campaign.</p>`}
      </section>
      <section class="panel">
        <h3 style="margin:0 0 6px">Notes</h3>
        <textarea id="cr-notes" rows="5" placeholder="Rates, contact person, past deals, what works for them…">${esc(c.roster_notes ?? "")}</textarea>
        <p class="muted small" id="cr-notes-msg" style="margin:6px 0 0">Visible to the team only.</p>
      </section>
    </div>

    <div class="ro-insights" id="cr-insights">${insRes.error ? `<section class="panel"><p class="muted small" style="margin:0">Couldn't load audience insights: ${esc(insRes.error.message)}</p></section>` : insightsHtml(ins, c)}</div>

    <h3 class="ro-h3">${c.platform === "instagram" ? "Recent posts" : c.platform === "twitch" ? "Recent broadcasts" : "Recent videos"}</h3>
    ${rv.length ? `<div class="wall sh-wall ro-wall">${rv.map((v) => `
      <article class="post"><div class="cover-wrap">
        <a class="cover" href="${esc(v.url)}" target="_blank" rel="noopener" title="${esc([v.views != null && `${big(v.views)} views`, v.likes != null && `${big(v.likes)} likes`, v.comments != null && `${big(v.comments)} comments`, v.shares != null && `${big(v.shares)} shares`].filter(Boolean).join(" · "))}">
          ${covers[v.cover_path] || v.cover_url ? `<img src="${esc(covers[v.cover_path] || v.cover_url)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : ""}
          ${v.posted ? `<span class="chip tr">${esc(ago(v.posted))}</span>` : ""}
          <span class="cap"><span class="plays">${v.views != null ? compact(v.views) : v.likes != null ? `♥ ${compact(v.likes)}` : ""}</span></span>
        </a></div></article>`).join("")}</div>` : `<p class="muted small">No recent videos yet.</p>`}`;

  // Actions
  const run = async (btn, label, fn) => {
    btn.disabled = true; const old = btn.textContent; btn.textContent = label;
    try { await fn(); } catch (e) { toast(e.message); btn.disabled = false; btn.textContent = old; }
  };
  app.querySelector("#cr-refresh").onclick = (e) => run(e.currentTarget, "Refreshing…", async () => {
    await invoke(sb, "roster", { action: "refresh", creator_id: id });
    toast("Numbers updated"); renderCreator(app, sb, ctx, id);
  });
  app.querySelector("#cr-add")?.addEventListener("click", (e) => run(e.currentTarget, "Adding…", async () => {
    await invoke(sb, "roster", { action: "add", input: `@${c.username}`, platform: c.platform ?? "tiktok" });
    toast("Added to the roster"); renderCreator(app, sb, ctx, id);
  }));
  app.querySelector("#cr-remove")?.addEventListener("click", (e) => run(e.currentTarget, "Removing…", async () => {
    const { error: err } = await sb.from("creators").update({ on_roster: false }).eq("id", id);
    if (err) throw err;
    toast("Removed from the roster. Their campaign posts stay.");
    if (ctx.inDrawer) { const back = view.base; view.base = null; go(back); } else go("#/roster");
  }));
  const notes = app.querySelector("#cr-notes"), notesMsg = app.querySelector("#cr-notes-msg");
  let t;
  notes.oninput = () => {
    clearTimeout(t); notesMsg.textContent = "Saving…";
    t = setTimeout(async () => {
      const { error: err } = await sb.from("creators").update({ roster_notes: notes.value || null }).eq("id", id);
      notesMsg.textContent = err ? `Couldn't save: ${err.message}` : "Saved. Visible to the team only.";
    }, 700);
  };
  // Lists: tick to add or remove; type a name to make a new list with this creator on it.
  app.querySelectorAll("#cr-lists [data-list]").forEach((cb) => (cb.onchange = async () => {
    const lid = cb.dataset.list, name = allLists.find((l) => l.id === lid)?.name ?? "the list";
    const { error: err } = cb.checked
      ? await sb.from("roster_list_members").insert({ list_id: lid, creator_id: id, added_by: await me(sb) })
      : await sb.from("roster_list_members").delete().eq("list_id", lid).eq("creator_id", id);
    if (err) { cb.checked = !cb.checked; return toast(err.message); }
    cb.checked ? mine.add(lid) : mine.delete(lid);
    app.querySelector("#cr-lists summary").textContent = `Lists${mine.size ? ` · ${mine.size}` : ""}`;
    toast(cb.checked ? `Added to ${name}` : `Removed from ${name}`);
    if (ctx.inDrawer) view.base = null;   // the list underneath redraws when the panel closes
  }));
  app.querySelector("#cr-newlist")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = e.target.querySelector("input").value.trim();
    if (!name) return;
    const who = await me(sb);
    const { data: l, error: err } = await sb.from("roster_lists").insert({ name, created_by: who }).select("id").single();
    if (err) return toast(err.message);
    const { error: err2 } = await sb.from("roster_list_members").insert({ list_id: l.id, creator_id: id, added_by: who });
    if (err2) return toast(err2.message);
    toast(`Added to ${name}`);
    if (ctx.inDrawer) view.base = null;
    renderCreator(app, sb, ctx, id);
  });
  if (ctx.list) compareSnippet(sb, ctx.list, c).then((h) => { const el = app.querySelector("#cr-cmp"); if (el && isCurrent()) el.innerHTML = h; });
  bindInsights(app, sb, ctx, c, id);
}

function tile(label, value, exact, sub = "") {
  return `<div class="stat"><div class="n"${exact != null ? ` title="${Number(exact).toLocaleString("en-GB")}"` : ""}>${value}</div><div class="l">${esc(label)}</div>${sub ? `<div class="sub">${esc(sub)}</div>` : ""}</div>`;
}

// ---------- audience insights (Influencers.club) ----------
const eng = (v) => (v == null ? "–" : `${(v * 100).toFixed(1)}%`);
const pctW = (w) => (w == null ? "–" : `${(w * 100).toFixed(w >= 0.1 ? 0 : 1)}%`);
function bars(rows, { max = 6, label = (r) => r.name ?? r.code } = {}) {
  const top = rows.filter((r) => r.weight > 0).slice(0, max);
  const hi = Math.max(...top.map((r) => r.weight), 0.0001);
  return `<div class="ro-bars">${top.map((r) => `<div class="ro-bar"><span class="ro-bar-l">${label(r)}</span><span class="ro-bar-t"><i style="width:${Math.max(2, (r.weight / hi) * 100)}%"></i></span><span class="ro-bar-v">${pctW(r.weight)}</span></div>`).join("")}</div>`;
}
const TYPES = [["real", "Real people", "#2f7a4f"], ["mass_followers", "Mass followers", "#d9a23b"], ["influencers", "Influencers", "#4a7fdc"], ["suspicious", "Suspicious", "#b4592a"]];
const CRED = { best: "Excellent", high: "High", good: "Good", normal: "Medium", low: "Low", bad: "Poor" };
const icSection = (n, key, title, sub, body) => `<section class="panel ic-sec" id="ic-${key}"><div class="ic-head"><span class="ic-n">${String(n).padStart(2, "0")}</span><h3>${esc(title)}</h3>${sub ? `<span class="ic-sub">${esc(sub)}</span>` : ""}</div>${body}</section>`;
const icAvatar = (pic, name, size) => avatar({ avatar_url: pic, display_name: name }, size);
const fmtPct = (v, d = 1) => (v == null ? "–" : `${Number(v).toFixed(d)}%`);
const REACH = [["-500", "Follow under 500 accounts", "#2f7a4f"], ["500-1000", "500–1,000", "#d9a23b"], ["1000-1500", "1,000–1,500", "#4a7fdc"], ["1500-", "Over 1,500", "#b4592a"]];

function insightsHtml(ins, c) {
  if (!ins) return `<section class="panel ro-insights">
    <div class="ro-ins-empty">
      <div><h3 style="margin:0 0 4px">Audience insights</h3>
        <p class="muted small" style="margin:0">Where their followers are, gender and age, growth, brand deals, notable followers, similar creators and a contact email when one is public. From Influencers.club; uses 1 credit, then kept for 60 days.</p></div>
      <button type="button" class="primary" id="cr-unlock">Unlock insights</button>
    </div></section>`;
  const r = ins.data?.result ?? {};
  const p = r[c.platform ?? "tiktok"] ?? {};
  const a = p?.audience?.audience_followers?.data ?? {};
  const countries = a.audience_geo?.countries ?? [];
  const genders = a.audience_genders ?? [];
  const ages = (a.audience_ages ?? []).filter((x) => x.weight > 0);
  const byAge = a.audience_genders_per_age ?? [];
  const langs = a.audience_languages ?? [];
  const notable = a.notable_users ?? [];
  const looks = a.audience_lookalikes ?? [];
  const reach = a.audience_reachability ?? [];
  const male = genders.find((g) => g.code === "MALE")?.weight, female = genders.find((g) => g.code === "FEMALE")?.weight;
  const email = r.email && r.email_status !== "invalid" ? r.email : null;
  const growth = p.creator_follower_growth ?? {};
  const followers = p.follower_count ?? c.follower_count;
  const niche = [...new Set([...(p.niche_class ?? []), ...(p.niche_sub_class ?? [])].map((x) => x.charAt(0).toUpperCase() + x.slice(1)))];
  const lastPost = p.most_recent_post_date;
  const daysSince = lastPost ? Math.floor((Date.now() - Date.parse(lastPost)) / 86_400_000) : null;
  const sponsored = p.sponsored_posts ?? [];
  const brands = (p.brands_found ?? []).filter((b) => b && b.length > 2);
  const tagged = p.tagged ?? [];
  const top = countries[0];
  const sig = (label, value, sub = "", cls = "") => `<div class="ic-sig ${cls}"><div class="l">${esc(label)}</div><div class="n">${value}</div>${sub ? `<div class="s">${sub}</div>` : ""}</div>`;
  const g3 = growth["3_months_ago"];

  // Credibility: Influencers.club measures it for Instagram audiences (the engaged audience, i.e. likers, when available).
  const al = p?.audience?.audience_likers?.data ?? {};
  const engaged = (al.audience_types ?? []).length > 0;
  const types = engaged ? al.audience_types : a.audience_types ?? [];
  const credScore = engaged ? al.audience_credibility ?? a.audience_credibility : a.audience_credibility;
  const credClass = engaged ? al.credibility_class ?? a.credibility_class : a.credibility_class;
  const credBody = types.length ? (() => {
    const w = Object.fromEntries(types.map((x) => [x.code, x.weight]));
    return `<div class="ic-cred-head"><div><div class="ic-subh">Audience credibility</div><span class="muted small">based on the ${engaged ? "engaged audience (people who like their posts)" : "followers"}</span></div>
        ${credScore != null ? `<span class="ic-score ic-${esc(credClass ?? "normal")}"><b>${Math.round(credScore * 100)}</b><small>/100</small><i>${esc(CRED[credClass] ?? credClass ?? "")}</i></span>` : ""}</div>
      <div class="ic-stack">${TYPES.map(([k, l, col]) => `<i style="flex:${w[k] ?? 0};background:${col}" title="${esc(`${l}: ${fmtPct((w[k] ?? 0) * 100)}`)}"></i>`).join("")}</div>
      <div class="ic-legend">${TYPES.map(([k, l, col]) => `<span><b style="background:${col}"></b><strong>${fmtPct((w[k] ?? 0) * 100, 0)}</strong> ${esc(l)}</span>`).join("")}</div>`;
  })() : `<p class="muted small ic-lead" style="margin:0">Influencers.club only measures audience credibility (real people vs suspicious accounts) for Instagram audiences.${c.platform !== "instagram" ? " Add this creator's Instagram to the roster and unlock it to see it." : ""}</p>`;
  const reachBody = reach.length ? (() => {
    const w = Object.fromEntries(reach.map((x) => [x.code, x.weight]));
    const low = w["-500"] ?? 0;
    return `<div class="ic-subh ic-gap">Reachability</div>
      <p class="muted small ic-lead" style="margin-top:2px">How many accounts their followers follow. Followers who follow few accounts see more of what this creator posts; followers who follow thousands are often low-quality or bot-like.</p>
      <div class="ic-stack">${REACH.map(([k, , col]) => `<i style="flex:${w[k] ?? 0};background:${col}" title="${esc(fmtPct((w[k] ?? 0) * 100))}"></i>`).join("")}</div>
      <div class="ic-legend">${REACH.map(([k, l, col]) => `<span><b style="background:${col}"></b><strong>${fmtPct((w[k] ?? 0) * 100, 0)}</strong> ${esc(l)}</span>`).join("")}</div>
      <p class="small ic-verdict">${low >= 0.5 ? "Strong: most followers follow few accounts." : low >= 0.3 ? "Average: a fair share of followers follow few accounts." : "Weak: most followers follow many accounts, so fewer of them will see the posts."}</p>`;
  })() : "";
  const qualityBody = credBody + reachBody;

  // Interests and brand affinity: Instagram audiences only.
  const interests = [...(a.audience_interests ?? al.audience_interests ?? [])].sort((x, y) => y.weight - x.weight);
  const brandAff = [...(a.audience_brand_affinity ?? [])].sort((x, y) => y.weight - x.weight);
  const intHi = Math.max(...interests.map((r) => r.weight), 0.0001);
  const intRows = (rows) => { const hi = intHi; return rows.map((r) => `<div class="ic-int"><span class="ic-int-l">${esc(r.name)}</span><span class="ic-int-t"><i style="width:${(r.weight / hi) * 100}%"></i></span><span class="ic-int-v">${fmtPct(r.weight * 100)}</span></div>`).join(""); };
  const interestsBody = interests.length ? `<p class="muted small ic-lead">Share of their followers interested in each topic.</p>
      <div class="ic-ints"><div>${intRows(interests.slice(0, 7))}</div><div>${intRows(interests.slice(7, 14))}</div></div>
      ${brandAff.length ? `<div class="ic-cap ic-gap">Brands their audience follows</div><div class="ro-notable">${brandAff.slice(0, 14).map((b) => `<span class="ro-chip" title="${esc(fmtPct(b.weight * 100))} of followers">${esc(b.name)} <span class="muted">${fmtPct(b.weight * 100, 0)}</span></span>`).join("")}</div>` : ""}`
    : null;

  const growthBody = Object.keys(growth).length && followers ? `
    <div class="ic-growth" data-followers="${followers}" data-growth="${esc(JSON.stringify(growth))}">
      <div class="ic-growth-top"><span class="ic-cap">Follower change</span>
        <div class="ic-seg" role="group" aria-label="Period">${[3, 6, 9, 12].map((m) => `<button type="button" data-m="${m}"${m === 12 ? ' class="on"' : ""}>${m} mo</button>`).join("")}</div></div>
      <div class="ic-growth-plot"></div>
    </div>` : `<p class="muted small">No growth history for this creator.</p>`;

  const ageRows = byAge.length ? byAge.filter((x) => (x.male ?? 0) + (x.female ?? 0) > 0.001) : ages.map((x) => ({ code: x.code, total: x.weight }));
  const ageHi = Math.max(...ageRows.map((x) => x.total ?? (x.male + x.female)), 0.0001);
  const ageLabel = (code) => (code === "65-" ? "65+" : code.replace("-", "–"));
  const demoBody = `<div class="ic-two">
      <div class="ic-card"><div class="ic-cap">Gender</div>${male != null ? `
        <div class="ic-donut-row"><div class="ic-donut" style="--f:${(female ?? 0) * 100}"><div><b>${fmtPct((Math.max(female ?? 0, male ?? 0)) * 100, 0)}</b><span>${(female ?? 0) >= (male ?? 0) ? "Female" : "Male"}</span></div></div>
          <div class="ic-legend col"><span><b style="background:var(--ic-f)"></b><strong>${fmtPct((female ?? 0) * 100, 0)}</strong> Female</span><span><b style="background:var(--ic-m)"></b><strong>${fmtPct((male ?? 0) * 100, 0)}</strong> Male</span></div></div>` : `<p class="muted small">Not available.</p>`}</div>
      <div class="ic-card"><div class="ic-cap">Age${byAge.length ? ` <span class="ic-mini"><b style="background:var(--ic-f)"></b>female <b style="background:var(--ic-m)"></b>male</span>` : ""}</div>
        ${ageRows.length ? `<div class="ic-ages">${ageRows.map((x) => {
          const tot = x.total ?? ((x.male ?? 0) + (x.female ?? 0));
          return `<div class="ic-age"><span>${esc(ageLabel(x.code))}</span><span class="ic-age-t">${x.total != null ? `<i style="width:${(tot / ageHi) * 100}%;background:var(--accent)"></i>` : `<i style="width:${((x.female ?? 0) / ageHi) * 100}%;background:var(--ic-f)"></i><i style="width:${((x.male ?? 0) / ageHi) * 100}%;background:var(--ic-m)"></i>`}</span><span class="ic-age-v">${fmtPct(tot * 100)}</span></div>`;
        }).join("")}</div>` : `<p class="muted small">Not available.</p>`}</div>
    </div>`;

  const geoBody = `<div class="ic-two flat">
      <div><div class="ic-cap">Top countries</div>${countries.length ? bars(countries, { max: 8, label: (x) => `${flag(x.code)} ${esc(x.name)}` }) : `<p class="muted small">Too few followers to estimate.</p>`}</div>
      <div><div class="ic-cap">Languages</div>${langs.length ? bars(langs, { max: 8, label: (x) => esc(x.name ?? x.code) }) : `<p class="muted small">Not available.</p>`}</div>
    </div>`;

  const flagCard = (label, yes, detail) => `<div class="ic-flag${yes ? " yes" : ""}"><span class="ic-flag-i">${yes ? "✓" : "–"}</span><div><div class="ic-cap">${esc(label)}</div><b>${yes ? esc(detail || "Yes") : "None found"}</b></div></div>`;
  const brandsBody = `
    <div class="ic-flags">
      ${flagCard("Paid partnerships", p.has_paid_partnership || p.paid_partnership || sponsored.length > 0, sponsored.length ? `${sponsored.length} sponsored post${sponsored.length === 1 ? "" : "s"}` : "Yes")}
      ${flagCard("Affiliate links", !!p.promotes_affiliate_links)}
      ${flagCard("Merch", !!(p.has_merch || r.has_merch))}
    </div>
    ${brands.length ? `<div class="ic-cap ic-gap">Brands mentioned</div><div class="ro-notable">${brands.map((b) => `<span class="ro-chip">${esc(b)}</span>`).join("")}</div>` : ""}
    ${sponsored.length ? `<div class="ic-cap ic-gap">Sponsored posts</div><div class="ic-spons">${sponsored.slice(0, 8).map((x) => `
      <a class="ic-spon" href="${esc(x.post_url)}" target="_blank" rel="noopener">
        <span class="ic-spon-img">${x.thumbnail ? `<img src="${esc(x.thumbnail)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">` : ""}</span>
        <span class="ic-spon-t">${esc((x.caption || "").slice(0, 90) || "Sponsored post")}</span>
        <span class="ic-spon-m">${x.created_at ? esc(ago(x.created_at)) : ""}${x.engagement?.likes != null ? ` · ${big(x.engagement.likes)} likes` : ""}</span></a>`).join("")}</div>` : ""}
    ${tagged.length ? `<div class="ic-cap ic-gap">Recently tagged accounts</div><div class="ro-notable">${tagged.slice(0, 16).map((t) => { const u = typeof t === "string" ? t : t.username ?? t.name ?? ""; return u ? `<a class="ro-chip" href="${esc(platformOf(c.platform).url(u))}" target="_blank" rel="noopener">@${esc(u)}</a>` : ""; }).join("")}</div>` : ""}
    ${(p.hashtags ?? []).length ? `<div class="ic-cap ic-gap">Hashtags they use</div><div class="ro-notable">${p.hashtags.slice(0, 16).map((h) => `<span class="ro-chip">#${esc(h)}</span>`).join("")}</div>` : ""}`;

  const person = (u) => `<a class="ic-person" href="${esc(platformOf(c.platform).url(u.username))}" target="_blank" rel="noopener">${icAvatar(u.picture, u.fullname || u.username, 32)}<span class="ic-person-n"><b>${esc(u.fullname || u.username)}${u.is_verified ? ' <span class="tick">✓</span>' : ""}</b><span>${big(u.followers)} followers</span></span></a>`;
  const notableBody = notable.length ? `<p class="muted small ic-lead">${a.notable_users_ratio != null ? `${fmtPct(a.notable_users_ratio * 100)} of their followers are creators with a sizeable audience of their own. ` : ""}Largest ${Math.min(notable.length, 12)} shown.</p>
      <div class="ic-people">${[...notable].sort((x, y) => (y.followers ?? 0) - (x.followers ?? 0)).slice(0, 12).map(person).join("")}</div>` : `<p class="muted small">None found.</p>`;

  const lookCard = (u) => `<div class="ic-look">
      <a href="${esc(platformOf(c.platform).url(u.username))}" target="_blank" rel="noopener" class="ic-look-a">${icAvatar(u.picture, u.fullname || u.username, 64)}
        <b>${esc(u.fullname || u.username)}${u.is_verified ? ' <span class="tick">✓</span>' : ""}</b><span class="muted">@${esc(u.username)}</span></a>
      <span class="ic-look-f">${big(u.followers)} followers${u.geo?.country?.code ? ` · ${flag(u.geo.country.code)}` : ""}</span>
      <button type="button" class="ic-look-add" data-add="${esc(u.username)}">☆ Add to roster</button></div>`;
  const lookBody = looks.length ? `<p class="muted small ic-lead">Creators whose audience overlaps most with this one's.</p>
      <div class="ic-looks">${looks.slice(0, 10).map(lookCard).join("")}</div>
      ${looks.length > 10 ? `<div class="ic-looks ic-more" hidden>${looks.slice(10).map(lookCard).join("")}</div><button type="button" class="link-btn ic-gap" id="ic-more">Show all ${looks.length}</button>` : ""}` : `<p class="muted small">None found.</p>`;

  const secs = [
    ["sig", "Signals", "", "", "Signals"],
    ["quality", "Audience quality", "credibility · reachability", qualityBody, "Audience quality"],
    ...(interestsBody ? [["interests", "Audience interests", "interests · brand affinity", interestsBody, "Interests"]] : []),
    ["growth", "Growth & trajectory", "3 / 6 / 9 / 12 month history", growthBody, "Growth"],
    ["demo", "Audience demographics", "gender · age", demoBody, "Demographics"],
    ["geo", "Audience geography & language", "countries · languages", geoBody, "Geography & language"],
    ["brands", "Brand collaborations", "paid partnerships · sponsored posts · monetisation", brandsBody, "Brand collaborations"],
    ["notable", "Notable followers", "creators who follow them", notableBody, "Notable followers"],
    ["look", "Lookalikes", "similar creators worth a look", lookBody, "Lookalikes"],
  ];
  return `
    <div class="ic-top panel">
      <div class="ic-top-row">
        <div><h3 style="margin:0">Audience insights</h3>
          <span class="muted small">From Influencers.club, ${esc(ago(ins.fetched_at)).toLowerCase()}. Audience means their followers.</span></div>
        <button type="button" id="cr-reunlock">Update (1 credit)</button>
      </div>
      <div class="ic-tags">
        ${r.location ? `<span class="ro-chip">📍 ${esc(r.location)}</span>` : ""}
        ${r.speaking_language ? `<span class="ro-chip">Speaks ${esc(new Intl.DisplayNames(["en"], { type: "language" }).of(r.speaking_language) ?? r.speaking_language)}</span>` : ""}
        ${niche.map((n) => `<span class="ro-chip ic-niche">${esc(n)}</span>`).join("")}
        ${email ? `<a class="ro-chip ic-mail" href="mailto:${esc(email)}">✓ ${esc(email)}${r.email_status === "valid" ? " · verified" : ""}</a>` : `<span class="ro-chip">No public email found</span>`}
      </div>
      <nav class="ic-nav" aria-label="Insight sections">${secs.map(([k, , , , l], i) => `<a href="#ic-${k}" data-jump="ic-${k}"><span>${String(i + 1).padStart(2, "0")}</span>${esc(l)}</a>`).join("")}</nav>
    </div>
    ${icSection(1, "sig", "Signals", "the numbers brand managers filter on", `<div class="ic-sigs">
      ${sig("Engagement rate", fmtPct(p.engagement_percent), "likes, comments, shares per view")}
      ${sig("Avg plays / video", big(p.play_count_avg), p.play_count_median != null ? `median ${big(p.play_count_median)}` : "")}
      ${sig("Follower growth · 90 days", g3 != null ? `<span class="${g3 >= 0 ? "up" : "down"}">${g3 >= 0 ? "↑" : "↓"} ${fmtPct(Math.abs(g3))}</span>` : "–", "vs 3 months ago")}
      ${sig("Posting frequency", p.posting_frequency_recent_months != null ? `${Math.round(p.posting_frequency_recent_months)} <small>/ month</small>` : "–", "recent months")}
      ${sig("Top audience country", top ? fmtPct(top.weight * 100) : "–", top ? `${flag(top.code)} ${esc(top.name)}` : "")}
      ${sig("Most recent post", daysSince == null ? "–" : daysSince <= 1 ? "Today" : `${daysSince} days ago`, daysSince != null && daysSince > 60 ? '<span class="down">inactive</span>' : "active", daysSince != null && daysSince > 60 ? "warn" : "")}
      ${sig("Median likes", big(p.likes_median == null ? null : Math.round(p.likes_median)), p.comments_median != null ? `${big(Math.round(p.comments_median))} comments` : "")}
      ${sig("Avg video length", p.duration_avg != null ? `${Math.round(p.duration_avg)} <small>sec</small>` : "–", "")}
    </div>`)}
    ${secs.slice(1).map(([key, title, sub, body], i) => icSection(i + 2, key, title, sub, body)).join("")}`;
}

// Follower count over the chosen period, estimated back from today's count and the growth percentages.
function growthSvg(followers, growth, months, width = 1000) {
  const pts = [12, 9, 6, 3].filter((m) => m <= months && growth[`${m}_months_ago`] != null)
    .map((m) => ({ m, v: followers / (1 + growth[`${m}_months_ago`] / 100) })).concat([{ m: 0, v: followers }]);
  if (pts.length < 2) return `<p class="muted small">Not enough history for this period.</p>`;
  const W = Math.max(320, Math.round(width)), H = W < 600 ? 190 : 210, L = 8, R = 8, T = 24, B = 26;
  const lo = Math.min(...pts.map((x) => x.v)), hi = Math.max(...pts.map((x) => x.v));
  const pad = (hi - lo) * 0.25 || hi * 0.01;
  const x = (m) => L + ((months - m) / months) * (W - L - R), y = (v) => T + (1 - (v - (lo - pad)) / (hi + pad - (lo - pad))) * (H - T - B);
  const line = pts.map((p) => `${x(p.m).toFixed(1)},${y(p.v).toFixed(1)}`).join(" ");
  const change = (followers / pts[0].v - 1) * 100;
  return `<div class="ic-growth-sum"><b class="${change >= 0 ? "up" : "down"}">${change >= 0 ? "+" : "−"}${big(Math.abs(Math.round(followers - pts[0].v)))}</b> followers (${change >= 0 ? "+" : "−"}${Math.abs(change).toFixed(1)}%) in ${months} months</div>
    <svg viewBox="0 0 ${W} ${H}" class="ic-gsvg" role="img" aria-label="Follower count over the last ${months} months">
      <polygon points="${x(pts[0].m)},${H - B} ${line} ${x(0)},${H - B}" class="area"/>
      <polyline points="${line}" class="ln"/>
      ${pts.map((p) => `<circle cx="${x(p.m)}" cy="${y(p.v)}" r="4.5" class="dot"><title>${p.m ? `${p.m} months ago` : "Now"}: about ${big(Math.round(p.v))}</title></circle>
        <text x="${x(p.m)}" y="${y(p.v) - 10}" text-anchor="${p.m === months ? "start" : p.m === 0 ? "end" : "middle"}" class="val">${compact(Math.round(p.v))}</text>
        <text x="${x(p.m)}" y="${H - 6}" text-anchor="${p.m === months ? "start" : p.m === 0 ? "end" : "middle"}" class="ax">${p.m ? (W < 600 ? `${p.m} mo` : `${p.m} mo ago`) : "Now"}</text>`).join("")}
    </svg>`;
}

function bindInsights(app, sb, ctx, c, id) {
  const unlock = (refresh) => async (e) => {
    const btn = e.currentTarget, old = btn.textContent;
    btn.disabled = true; btn.textContent = refresh ? "Updating…" : "Unlocking…";
    try {
      await invoke(sb, "creator-insights", { handle: String(c.username).toLowerCase(), platform: c.platform ?? "tiktok", ...(refresh ? { refresh: true } : {}) });
      if (!ctx.isCurrent()) return;
      ctx.toast(refresh ? "Insights updated" : "Insights unlocked");
      renderCreator(app, sb, ctx, id);
    } catch (err) { ctx.toast(err.message); btn.disabled = false; btn.textContent = old; }
  };
  app.querySelector("#cr-unlock")?.addEventListener("click", unlock(false));
  app.querySelector("#cr-reunlock")?.addEventListener("click", (e) => {
    confirmDialog({ title: "Get fresh insights from Influencers.club?", body: "This uses 1 credit.", confirm: "Refresh", danger: false }).then((ok) => { if (ok) unlock(true)(e); });
  });
  const box = app.querySelector(".ic-growth");
  if (box) {
    const followers = Number(box.dataset.followers), growth = JSON.parse(box.dataset.growth);
    const plot = box.querySelector(".ic-growth-plot");
    const draw = (m) => { plot.innerHTML = growthSvg(followers, growth, m, plot.clientWidth || 1000); box.querySelectorAll("[data-m]").forEach((b) => b.classList.toggle("on", Number(b.dataset.m) === m)); };
    box.querySelectorAll("[data-m]").forEach((b) => (b.onclick = () => draw(Number(b.dataset.m))));
    draw(12);
  }
  app.querySelectorAll("[data-jump]").forEach((a) => (a.onclick = (e) => { e.preventDefault(); app.querySelector(`#${a.dataset.jump}`)?.scrollIntoView({ behavior: "smooth", block: "start" }); }));
  app.querySelector("#ic-more")?.addEventListener("click", (e) => { app.querySelector(".ic-more").hidden = false; e.currentTarget.remove(); });
  app.querySelectorAll("[data-add]").forEach((b) => (b.onclick = async () => {
    b.disabled = true; b.textContent = "Adding…";
    try {
      const r = await invoke(sb, "roster", { action: "add", input: `@${b.dataset.add}`, platform: c.platform ?? "tiktok" });
      b.outerHTML = `<a class="ic-look-add on" href="#/creator/${esc(r.id)}">★ On the roster</a>`;
      ctx.toast(`Added @${b.dataset.add} to the roster`);
    } catch (err) { ctx.toast(err.message); b.disabled = false; b.textContent = "☆ Add to roster"; }
  }));
}
