// Client report: the page behind a "Share with client" link (share.html#t=<token>).
// It has no login. The token in the link is checked by the `share` function, which
// returns only campaigns, posts, creators, sounds and their numbers — never money.
import { SUPABASE_URL } from "./config.js";

const app = document.getElementById("app");
const tip = document.getElementById("tip");
const FN = `${SUPABASE_URL}/functions/v1/share`;
const token = (new URLSearchParams(location.hash.slice(1)).get("t") || new URLSearchParams(location.search).get("t") || "").trim();

// ---------- formatting ----------
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const nf = new Intl.NumberFormat("en");
const cf = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });
const n = (v) => (v == null ? "–" : nf.format(v));
const compact = (v) => (v == null ? "–" : cf.format(v));
const signed = (v) => (v == null ? "" : `${v >= 0 ? "+" : "−"}${compact(Math.abs(v))}`);
const pct = (v) => (v == null || !isFinite(v) ? "–" : `${(v * 100).toFixed(1)}%`);
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const dayLabel = (d) => `${Number(d.slice(8))} ${MONTHS[Number(d.slice(5, 7)) - 1]}`;
const dayLong = (d) => `${dayLabel(d)} ${d.slice(0, 4)}`;
const regionName = (() => { try { const dn = new Intl.DisplayNames(["en"], { type: "region" }); return (c) => (c ? dn.of(c.toUpperCase()) ?? c : "Unknown"); } catch { return (c) => c ?? "Unknown"; } })();
const flag = (c) => (c && /^[a-z]{2}$/i.test(c) ? String.fromCodePoint(...[...c.toUpperCase()].map((ch) => 0x1f1a5 + ch.charCodeAt(0))) : "🌐");
const ago = (iso) => {
  if (!iso) return "";
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 864e5);
  return days <= 0 ? "Today" : days === 1 ? "1 day ago" : days < 60 ? `${days} days ago` : dayLong(iso.slice(0, 10));
};
const addDays = (d, k) => new Date(Date.parse(d + "T00:00:00Z") + k * 864e5).toISOString().slice(0, 10);
const daysBetween = (a, b) => { const out = []; for (let d = a; d <= b; d = addDays(d, 1)) out.push(d); return out; };

// Validated categorical palette (dataviz reference order). Stellar cobalt stays for single-series charts.
const SERIES = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#6250d6", "#e34948"];
const BRAND = "#0626c7";
const METRICS = [
  { key: "plays", label: "Views" },
  { key: "likes", label: "Likes" },
  { key: "comments", label: "Comments" },
  { key: "shares", label: "Shares" },
];

// ---------- state ----------
let data = null;
const state = { tab: "overview", metric: "plays", from: null, to: null, q: "", camp: "", creator: "", country: "", sort: "plays", view: "grid", shown: 48 };
const coverCache = {};
const asked = new Set();

// ---------- load ----------
async function load() {
  if (!/^[0-9a-f]{40,128}$/i.test(token)) return renderGone();
  let res;
  try { res = await fetch(FN, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token }) }); }
  catch { return renderGone("We couldn't load this report. Check your connection and try again."); }
  if (res.status === 404) return renderGone();
  if (!res.ok) return renderGone("Something went wrong loading this report. Please try again in a minute.");
  data = await res.json();
  Object.assign(coverCache, data.covers ?? {});
  prepare();
  render();
}

function renderGone(msg) {
  document.body.classList.add("signin");
  app.innerHTML = `<section class="login on-blue">
    <img class="logo" src="assets/stellar-white.png" alt="Stellar" width="160" height="44">
    <h1>Campaign <em>report</em></h1>
    <p>${esc(msg ?? "This link isn't active. Ask your Stellar contact for a new one.")}</p></section>`;
}

// Turn the function's rows into lookups the views share.
function prepare() {
  const rows = data.series ?? [];
  const dates = [...new Set(rows.map((r) => r.stat_date))].sort();
  data.dates = dates.length ? daysBetween(dates[0], dates.at(-1)) : [];
  data.campById = Object.fromEntries((data.campaigns ?? []).map((c, i) => [c.id, { ...c, color: SERIES[i % SERIES.length] }]));
  data.byDate = {};
  for (const r of rows) (data.byDate[r.stat_date] ??= []).push(r);
  state.from = data.dates[0] ?? null;
  state.to = data.dates.at(-1) ?? null;
  // Countries ranked by views at the latest date, so colours follow the country, not today's rank.
  const latest = {};
  for (const r of data.byDate[state.to] ?? []) latest[r.country_code ?? "??"] = (latest[r.country_code ?? "??"] ?? 0) + Number(r.plays ?? 0);
  const ranked = Object.keys(latest).sort((a, b) => latest[b] - latest[a]);
  data.countryColor = Object.fromEntries(ranked.slice(0, 7).map((c, i) => [c, SERIES[i]]));
  data.countryOrder = ranked;
  (data.sounds ?? []).forEach((s, i) => { s.color = SERIES[i % SERIES.length]; });
}

// Sum one metric at one date, optionally filtered by a row predicate.
function sumAt(date, key, pred = () => true) {
  let t = 0, any = false;
  for (const r of data.byDate[date] ?? []) if (pred(r)) { t += Number(r[key] ?? 0); any = true; }
  return any ? t : null;
}
const rangeDates = () => data.dates.filter((d) => d >= state.from && d <= state.to);
// Value at the end of the range and how much it grew within the range.
function growth(key, pred) {
  const ds = rangeDates();
  if (!ds.length) return { end: null, delta: null, since: null };
  const end = sumAt(ds.at(-1), key, pred);
  const before = data.dates.filter((d) => d < ds[0]).at(-1);
  const base = before ? sumAt(before, key, pred) : sumAt(ds[0], key, pred);
  return { end, delta: end != null && base != null ? end - base : null, since: before ? ds[0] : ds[0], fromStart: !before };
}

// ---------- page ----------
function render() {
  document.body.classList.remove("signin");
  const camps = data.campaigns ?? [];
  const posts = data.posts ?? [];
  const lastStats = posts.map((p) => p.stats_date).filter(Boolean).sort().at(-1);
  app.innerHTML = `
    <section class="band on-blue sh-band">
      <div class="sh-top"><img src="assets/stellar-white.png" alt="Stellar" width="80" height="22"><span>Campaign report</span></div>
      <div class="hero">
        <div>
          <h1>${esc(data.artist)}</h1>
          <div class="voice">${camps.length === 1 ? esc(camps[0].song ?? "1 campaign") : `${camps.length} campaigns`}</div>
          <div class="meta">
            ${camps.length > 1 ? camps.map((c) => `<span class="status">${esc(c.song ?? "Untitled")}</span>`).join("") : ""}
            ${data.dates.length ? `<span>Tracking since ${esc(dayLong(data.dates[0]))}</span>` : ""}
            ${lastStats ? `<span>Numbers from ${esc(dayLong(lastStats))}</span>` : ""}
          </div>
        </div>
      </div>
    </section>
    ${camps.length === 0 ? `<div class="panel" style="margin-top:24px"><p>There's nothing to show here yet. Check back once the campaign is live.</p></div>` : `
    <div class="sh-controls">
      <div class="tabs" role="tablist" aria-label="Report views">
        ${[["overview", "Overview"], ["sounds", "Sounds"], ["songs", "Songs"], ["countries", "Countries"]].map(([k, l]) =>
          `<button type="button" role="tab" data-tab="${k}" aria-selected="${state.tab === k}">${l}</button>`).join("")}
      </div>
      <div class="range" ${data.dates.length < 2 ? "hidden" : ""}>
        <div class="seg" role="group" aria-label="Date range">
          <button type="button" data-preset="7">7 days</button><button type="button" data-preset="30">30 days</button><button type="button" data-preset="all">All</button>
        </div>
        <label class="sr" for="from">From</label><input type="date" id="from" min="${data.dates[0] ?? ""}" max="${data.dates.at(-1) ?? ""}" value="${state.from ?? ""}">
        <span class="muted small">to</span>
        <label class="sr" for="to">To</label><input type="date" id="to" min="${data.dates[0] ?? ""}" max="${data.dates.at(-1) ?? ""}" value="${state.to ?? ""}">
      </div>
    </div>
    <section id="panel" role="tabpanel"></section>
    <div class="section-head" id="posts-head"><h2>Posts <span class="muted" style="font-weight:400">${n(posts.length)}</span></h2></div>
    <div class="filters sh-filters">
      <input id="q" type="search" placeholder="Search captions or creators" aria-label="Search posts" value="${esc(state.q)}">
      ${camps.length > 1 ? `<select id="f-camp" aria-label="Campaign"><option value="">All songs</option>${camps.map((c) => `<option value="${esc(c.id)}">${esc(c.song ?? "Untitled")}</option>`).join("")}</select>` : ""}
      <select id="f-creator" aria-label="Creator"><option value="">All creators</option>${[...new Set(posts.map((p) => p.creator?.username).filter(Boolean))].sort().map((u) => `<option>${esc(u)}</option>`).join("")}</select>
      <select id="f-country" aria-label="Country"><option value="">All countries</option>${[...new Set(posts.map((p) => p.country).filter(Boolean))].sort((a, b) => regionName(a).localeCompare(regionName(b))).map((c) => `<option value="${esc(c)}">${flag(c)} ${esc(regionName(c))}</option>`).join("")}</select>
      <select id="sort" aria-label="Sort"><option value="plays">Most views</option><option value="likes">Most likes</option><option value="shares">Most shares</option><option value="newest">Newest first</option></select>
      <div class="seg view-toggle" role="group" aria-label="Layout"><button type="button" data-view="grid" aria-pressed="${state.view === "grid"}">Grid</button><button type="button" data-view="list" aria-pressed="${state.view === "list"}">List</button></div>
    </div>
    <div id="posts"></div>`}`;
  if (!camps.length) return;

  document.querySelectorAll("[data-tab]").forEach((b) => b.onclick = () => { state.tab = b.dataset.tab; document.querySelectorAll("[data-tab]").forEach((x) => x.setAttribute("aria-selected", x === b)); renderPanel(); });
  document.querySelectorAll("[data-preset]").forEach((b) => b.onclick = () => {
    const last = data.dates.at(-1);
    state.to = last;
    state.from = b.dataset.preset === "all" ? data.dates[0] : [data.dates[0], addDays(last, 1 - Number(b.dataset.preset))].sort().at(-1);
    syncRange(); renderPanel();
  });
  const from = document.getElementById("from"), to = document.getElementById("to");
  from.onchange = () => { if (from.value) { state.from = from.value; if (state.from > state.to) state.to = state.from; } syncRange(); renderPanel(); };
  to.onchange = () => { if (to.value) { state.to = to.value; if (state.to < state.from) state.from = state.to; } syncRange(); renderPanel(); };
  syncRange();

  const bind = (id, key) => { const el = document.getElementById(id); if (el) { el.value = state[key]; el.oninput = () => { state[key] = el.value; state.shown = 48; renderPosts(); }; } };
  bind("q", "q"); bind("f-camp", "camp"); bind("f-creator", "creator"); bind("f-country", "country"); bind("sort", "sort");
  document.querySelectorAll("[data-view]").forEach((b) => b.onclick = () => {
    state.view = b.dataset.view;
    document.querySelectorAll("[data-view]").forEach((x) => x.setAttribute("aria-pressed", x === b));
    renderPosts();
  });
  renderPanel();
  renderPosts();
}

function syncRange() {
  const from = document.getElementById("from"), to = document.getElementById("to");
  if (from) from.value = state.from ?? "";
  if (to) to.value = state.to ?? "";
  const first = data.dates[0], last = data.dates.at(-1);
  document.querySelectorAll("[data-preset]").forEach((b) => {
    const p = b.dataset.preset;
    const start = p === "all" ? first : [first, addDays(last, 1 - Number(p))].sort().at(-1);
    // When there's less history than the preset, "All" is the one that lights up.
    const on = state.to === last && state.from === start && (p === "all" || start !== first);
    b.setAttribute("aria-pressed", on);
  });
}

// ---------- analytics panels ----------
function renderPanel() {
  const el = document.getElementById("panel");
  hideTip();
  if (state.tab === "overview") return renderOverview(el);
  if (state.tab === "sounds") return renderSounds(el);
  if (state.tab === "songs") return renderBreakdown(el, "songs");
  return renderBreakdown(el, "countries");
}

function sinceText(g) {
  if (g.delta == null || !g.since) return "";
  return `<div class="d ${g.delta < 0 ? "neg" : ""}">${signed(g.delta)} ${g.fromStart ? `since ${esc(dayLabel(g.since))}` : "in this period"}</div>`;
}

function renderOverview(el) {
  const posts = data.posts ?? [];
  const g = Object.fromEntries(METRICS.map((m) => [m.key, growth(m.key)]));
  const er = g.plays.end ? ((g.likes.end ?? 0) + (g.comments.end ?? 0) + (g.shares.end ?? 0)) / g.plays.end : null;
  const followers = Object.values(Object.fromEntries(posts.filter((p) => p.creator).map((p) => [p.creator.username, p.creator.followers ?? 0]))).reduce((s, v) => s + v, 0);
  const creators = new Set(posts.map((p) => p.creator?.username).filter(Boolean)).size;
  el.innerHTML = `
    <div class="stats sh-stats">
      ${METRICS.map((m) => `<div class="stat ${state.metric === m.key ? "on" : ""}"><button type="button" class="stat-btn" data-metric="${m.key}" aria-pressed="${state.metric === m.key}">
        <div class="n">${n(g[m.key].end)}</div><div class="l">${m.label}</div>${sinceText(g[m.key])}</button></div>`).join("")}
      <div class="stat"><div class="n">${pct(er)}</div><div class="l">Engagement rate</div><div class="d muted">likes, comments and shares per view</div></div>
      <div class="stat"><div class="n">${n(posts.length)}</div><div class="l">Live posts</div><div class="d muted">by ${n(creators)} creator${creators === 1 ? "" : "s"}</div></div>
      <div class="stat"><div class="n">${compact(followers)}</div><div class="l">Creators' followers</div><div class="d muted">combined reach</div></div>
    </div>
    <div class="chart-card">
      <div class="chart-head"><h3>${METRICS.find((m) => m.key === state.metric).label} over time</h3><span class="muted small">Pick a number above to chart it</span></div>
      <div id="chart"></div>
    </div>`;
  el.querySelectorAll("[data-metric]").forEach((b) => b.onclick = () => { state.metric = b.dataset.metric; renderOverview(el); });
  const ds = rangeDates();
  lineChart(document.getElementById("chart"), {
    dates: ds,
    series: [{ name: METRICS.find((m) => m.key === state.metric).label, color: BRAND, values: ds.map((d) => sumAt(d, state.metric)) }],
    empty: "The chart fills in once numbers have been collected on two or more days.",
  });
}

function renderBreakdown(el, kind) {
  const metric = METRICS.find((m) => m.key === state.metric);
  const ds = rangeDates();
  let groups;
  if (kind === "songs") {
    groups = (data.campaigns ?? []).map((c) => ({ id: c.id, name: c.song ?? "Untitled", color: data.campById[c.id].color, pred: (r) => r.campaign_id === c.id }));
  } else {
    const top = data.countryOrder.slice(0, 7);
    groups = top.map((c) => ({ id: c, name: `${flag(c === "??" ? null : c)} ${regionName(c === "??" ? null : c)}`, color: data.countryColor[c], pred: (r) => (r.country_code ?? "??") === c }));
    const rest = data.countryOrder.slice(7);
    if (rest.length) groups.push({ id: "other", name: `Other (${rest.length})`, color: "#8a8f99", pred: (r) => rest.includes(r.country_code ?? "??") });
  }
  const totalEnd = growth(metric.key).end || 0;
  const tiles = groups.map((gr) => ({ ...gr, g: growth(metric.key, gr.pred) })).sort((a, b) => (b.g.end ?? 0) - (a.g.end ?? 0));
  el.innerHTML = `
    <div class="metric-pick seg" role="group" aria-label="Number to show">
      ${METRICS.map((m) => `<button type="button" data-metric="${m.key}" aria-pressed="${state.metric === m.key}">${m.label}</button>`).join("")}
    </div>
    <div class="tiles">
      ${tiles.map((t) => `<div class="tile"><div class="tile-name"><i style="background:${t.color}"></i>${esc(t.name)}</div>
        <div class="n">${n(t.g.end)}</div>
        <div class="bar"><span style="width:${totalEnd ? Math.max(1, Math.round(((t.g.end ?? 0) / totalEnd) * 100)) : 0}%;background:${t.color}"></span></div>
        <div class="d muted">${totalEnd ? `${Math.round(((t.g.end ?? 0) / totalEnd) * 100)}% of ${metric.label.toLowerCase()}` : ""}${t.g.delta != null ? ` · ${signed(t.g.delta)}` : ""}</div></div>`).join("")}
    </div>
    <div class="chart-card">
      <div class="chart-head"><h3>${metric.label} by ${kind === "songs" ? "song" : "creator country"}</h3></div>
      <div id="chart"></div>
    </div>`;
  el.querySelectorAll("[data-metric]").forEach((b) => b.onclick = () => { state.metric = b.dataset.metric; renderBreakdown(el, kind); });
  lineChart(document.getElementById("chart"), {
    dates: ds,
    series: groups.map((gr) => ({ name: gr.name, color: gr.color, values: ds.map((d) => sumAt(d, metric.key, gr.pred)) })),
    empty: "The chart fills in once numbers have been collected on two or more days.",
  });
}

function renderSounds(el) {
  const sounds = data.sounds ?? [];
  if (!sounds.length) { el.innerHTML = `<div class="panel"><p class="muted">Sounds appear here once posts are tracked.</p></div>`; return; }
  const [from, to] = [state.from, state.to];
  const allDays = [...new Set(sounds.flatMap((s) => s.daily.map((d) => d.d)))].sort();
  const ds = allDays.length ? daysBetween(allDays[0], allDays.at(-1)).filter((d) => d >= from && d <= to) : [];
  // Videos using each sound on each day (carried forward over a missing day), then new videos per day.
  const totals = sounds.map((s) => {
    const map = Object.fromEntries(s.daily.map((d) => [d.d, d.n]));
    let last = null;
    const full = (allDays.length ? daysBetween(allDays[0], allDays.at(-1)) : []).map((d) => { if (map[d] != null) last = map[d]; return [d, last]; });
    return Object.fromEntries(full);
  });
  const newPerDay = (i, d) => { const prev = totals[i][addDays(d, -1)]; const cur = totals[i][d]; return prev == null || cur == null ? null : cur - prev; };
  const tiles = sounds.map((s, i) => {
    const now = totals[i][ds.at(-1)] ?? s.daily.at(-1)?.n ?? null;
    const before = totals[i][addDays(ds[0] ?? to, -1)];
    const start = totals[i][ds[0]];
    return { s, now, delta: now != null && before != null ? now - before : (now != null && start != null && ds.length > 1 ? now - start : null) };
  });
  el.innerHTML = `
    <div class="tiles">
      ${tiles.map(({ s, now, delta }) => `<div class="tile"><div class="tile-name"><i style="background:${s.color}"></i><a href="${esc(s.sound_url)}" target="_blank" rel="noopener">${esc(s.title ?? "Untitled sound")}</a></div>
        <div class="n">${n(now)}</div>
        <div class="d muted">videos use this sound${delta != null ? ` · <b class="${delta < 0 ? "neg" : "pos"}">${signed(delta)}</b> in this period` : ""}</div>
        ${s.matched_song_title && s.matched_song_title !== s.title ? `<div class="d muted">TikTok matches it to “${esc(s.matched_song_title)}”</div>` : ""}</div>`).join("")}
    </div>
    <div class="chart-card">
      <div class="chart-head"><h3>New videos made with each sound, per day</h3><span class="muted small">Can dip below zero when videos are deleted</span></div>
      <div id="chart"></div>
    </div>`;
  const chartDays = ds.filter((d) => d > (allDays[0] ?? d));
  lineChart(document.getElementById("chart"), {
    dates: chartDays,
    series: sounds.map((s, i) => ({ name: s.title ?? "Untitled sound", color: s.color, values: chartDays.map((d) => newPerDay(i, d)) })),
    empty: "New videos per day appear after the sounds have been checked on two or more days.",
    allowNegative: true,
  });
}

// ---------- line chart (hand-drawn SVG, crosshair tooltip, table view) ----------
function lineChart(host, { dates, series, empty, allowNegative = false }) {
  const usable = series.filter((s) => s.values.some((v) => v != null));
  if (dates.length < 2 || !usable.length) { host.innerHTML = `<p class="muted small chart-empty">${esc(empty)}</p>`; return; }
  const multi = usable.length > 1;
  const labelled = multi && usable.length <= 4;
  host.innerHTML = `
    ${multi ? `<div class="legend">${usable.map((s) => `<span><i style="background:${s.color}"></i>${esc(s.name)}</span>`).join("")}</div>` : ""}
    <div class="plot"></div>
    <div class="chart-foot"><button type="button" class="link-btn small" data-table>Show as table</button></div>
    <div class="chart-table" hidden></div>`;
  const plot = host.querySelector(".plot");
  const W = Math.max(300, Math.round(plot.clientWidth || host.clientWidth || 600));
  const H = 260, L = 52, R = labelled ? Math.min(150, Math.round(W * 0.24)) : 16, T = 14, B = 30;
  const vals = usable.flatMap((s) => s.values).filter((v) => v != null);
  let lo = allowNegative ? Math.min(0, ...vals) : 0, hi = Math.max(...vals, 1);
  const step = niceStep((hi - lo) / 4);
  hi = Math.ceil(hi / step) * step; lo = Math.floor(lo / step) * step;
  const x = (i) => L + (i / (dates.length - 1)) * (W - L - R);
  const y = (v) => T + (1 - (v - lo) / (hi - lo || 1)) * (H - T - B);
  const ticks = []; for (let v = lo; v <= hi + step / 2; v += step) ticks.push(v);
  const path = (s) => { let d = "", pen = false; s.values.forEach((v, i) => { if (v == null) { pen = false; return; } d += `${pen ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`; pen = true; }); return d; };
  const xIdx = dates.length <= 8 ? dates.map((_, i) => i) : [0, Math.round((dates.length - 1) / 2), dates.length - 1];
  // Direct labels at the line ends, nudged apart so they never overlap.
  let ends = [];
  if (labelled) {
    ends = usable.map((s) => { const i = s.values.findLastIndex((v) => v != null); return { s, ty: y(s.values[i]), i }; }).sort((a, b) => a.ty - b.ty);
    for (let k = 1; k < ends.length; k++) if (ends[k].ty - ends[k - 1].ty < 16) ends[k].ty = ends[k - 1].ty + 16;
  }
  const single = !multi ? usable[0] : null;
  plot.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" role="img" aria-label="${esc(usable.map((s) => s.name).join(", "))}, ${esc(dayLong(dates[0]))} to ${esc(dayLong(dates.at(-1)))}">
    <g class="grid">${ticks.map((v) => `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" ${v === 0 ? 'class="zero"' : ""}/><text x="${L - 8}" y="${y(v) + 4}" text-anchor="end">${compact(v)}</text>`).join("")}</g>
    <g class="xaxis">${xIdx.map((i) => `<text x="${x(i)}" y="${H - 8}" text-anchor="${i === 0 ? "start" : i === dates.length - 1 ? "end" : "middle"}">${esc(dayLabel(dates[i]))}</text>`).join("")}</g>
    ${single ? `<path d="${path(single)}L${x(single.values.findLastIndex((v) => v != null)).toFixed(1)},${y(Math.max(lo, 0))}L${x(single.values.findIndex((v) => v != null)).toFixed(1)},${y(Math.max(lo, 0))}Z" fill="${single.color}" fill-opacity="0.08" stroke="none"/>` : ""}
    ${usable.map((s) => `<path d="${path(s)}" fill="none" stroke="${s.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`).join("")}
    ${dates.length <= 14 ? usable.map((s) => s.values.map((v, i) => (v == null ? "" : `<circle cx="${x(i)}" cy="${y(v)}" r="4" fill="${s.color}" stroke="#fff" stroke-width="2"/>`)).join("")).join("") : ""}
    ${ends.map((e) => `<text class="end" x="${W - R + 10}" y="${e.ty + 4}"><tspan fill="${e.s.color}">■</tspan> ${esc(truncate(shortName(e.s.name), 20))}</text>`).join("")}
    <line class="cross" x1="0" x2="0" y1="${T}" y2="${H - B}" visibility="hidden"/>
    <g class="hover-dots"></g>
    <rect class="hit" x="${L}" y="${T}" width="${W - L - R}" height="${H - T - B}" fill="transparent"/>
  </svg>`;
  const svg = plot.querySelector("svg"), cross = svg.querySelector(".cross"), dots = svg.querySelector(".hover-dots");
  const show = (clientX) => {
    const box = svg.getBoundingClientRect();
    const sx = ((clientX - box.left) / box.width) * W;
    const i = Math.max(0, Math.min(dates.length - 1, Math.round(((sx - L) / (W - L - R)) * (dates.length - 1))));
    cross.setAttribute("x1", x(i)); cross.setAttribute("x2", x(i)); cross.setAttribute("visibility", "visible");
    dots.innerHTML = usable.map((s) => (s.values[i] == null ? "" : `<circle cx="${x(i)}" cy="${y(s.values[i])}" r="5" fill="${s.color}" stroke="#fff" stroke-width="2"/>`)).join("");
    const rows = usable.map((s) => ({ s, v: s.values[i] })).filter((r) => r.v != null).sort((a, b) => b.v - a.v);
    tip.innerHTML = `<div class="tip-date">${esc(dayLong(dates[i]))}</div>${rows.map((r) => `<div class="tip-row"><i style="background:${r.s.color}"></i><span>${esc(r.s.name)}</span><b>${n(r.v)}</b></div>`).join("")}`;
    tip.hidden = false;
    const px = box.left + (x(i) / W) * box.width, tw = tip.offsetWidth;
    tip.style.left = `${Math.min(window.innerWidth - tw - 8, Math.max(8, px + 14 + tw > window.innerWidth ? px - tw - 14 : px + 14))}px`;
    tip.style.top = `${box.top + window.scrollY + 12}px`;
  };
  const hit = svg.querySelector(".hit");
  hit.addEventListener("pointermove", (e) => show(e.clientX));
  hit.addEventListener("pointerdown", (e) => show(e.clientX));
  hit.addEventListener("pointerleave", () => { cross.setAttribute("visibility", "hidden"); dots.innerHTML = ""; hideTip(); });
  host.querySelector("[data-table]").onclick = (e) => {
    const t = host.querySelector(".chart-table");
    t.hidden = !t.hidden;
    e.currentTarget.textContent = t.hidden ? "Show as table" : "Hide table";
    if (!t.hidden) t.innerHTML = `<div class="table-wrap"><table><thead><tr><th>Date</th>${usable.map((s) => `<th class="num">${esc(s.name)}</th>`).join("")}</tr></thead>
      <tbody>${dates.map((d, i) => `<tr><td>${esc(dayLong(d))}</td>${usable.map((s) => `<td class="num">${n(s.values[i])}</td>`).join("")}</tr>`).reverse().join("")}</tbody></table></div>`;
  };
}
function niceStep(raw) {
  if (!(raw > 0)) return 1;
  const p = 10 ** Math.floor(Math.log10(raw)), f = raw / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p;
}
const truncate = (s, k) => (s.length > k ? s.slice(0, k - 1) + "…" : s);
// "original sound - soraempire" → "soraempire (original)" so line-end labels stay tellable apart.
const shortName = (s) => { const m = /^original sound\s*[-–]\s*(.+)$/i.exec(s); return m ? `${m[1]} (original)` : s; };
function hideTip() { tip.hidden = true; }
window.addEventListener("scroll", hideTip, { passive: true });

// ---------- posts ----------
function filteredPosts() {
  const q = state.q.trim().toLowerCase();
  const list = (data.posts ?? []).filter((p) =>
    (!state.camp || p.campaign_id === state.camp) &&
    (!state.creator || p.creator?.username === state.creator) &&
    (!state.country || p.country === state.country) &&
    (!q || (p.caption ?? "").toLowerCase().includes(q) || (p.creator?.username ?? "").toLowerCase().includes(q) || (p.creator?.name ?? "").toLowerCase().includes(q)));
  const by = state.sort;
  return list.sort((a, b) => by === "newest" ? String(b.published_at ?? "").localeCompare(String(a.published_at ?? "")) : (b[by] ?? -1) - (a[by] ?? -1));
}

function renderPosts() {
  const el = document.getElementById("posts");
  const list = filteredPosts();
  const page = list.slice(0, state.shown);
  const soundName = Object.fromEntries((data.sounds ?? []).map((s) => [s.id, s.title]));
  const song = (p) => data.campById[p.campaign_id]?.song ?? "";
  if (!list.length) { el.innerHTML = `<div class="panel"><p class="muted">No posts match these filters.</p></div>`; return; }
  el.innerHTML = state.view === "grid"
    ? `<div class="wall sh-wall">${page.map((p) => `
      <article class="post">
        <a class="cover" href="${esc(p.url)}" target="_blank" rel="noopener" aria-label="Watch @${esc(p.creator?.username ?? "")} on TikTok">
          <img data-vid="${esc(p.video_id)}" alt="" loading="lazy" ${coverCache[p.video_id] ? `src="${esc(coverCache[p.video_id])}"` : "hidden"} onerror="this.hidden=true">
          <span class="chip tl">${flag(p.country)}</span>
          <span class="chip tr">${esc(ago(p.published_at))}</span>
          <span class="plays">${compact(p.plays)}</span>
        </a>
        <div class="body">
          <div class="handle">@${esc(p.creator?.username ?? "unknown")}${p.creator?.verified ? ' <span class="tick" title="Verified">✓</span>' : ""}</div>
          <div class="caption">${esc(p.caption ?? "")}</div>
          ${p.sound_id && soundName[p.sound_id] ? `<div class="line sound-line">♪ ${esc(soundName[p.sound_id])}</div>` : ""}
          <div class="line">${compact(p.likes)} likes · ${compact(p.comments)} comments · ${compact(p.shares)} shares</div>
        </div>
      </article>`).join("")}</div>`
    : `<div class="table-wrap"><table class="post-table"><thead><tr><th>Post</th>${(data.campaigns ?? []).length > 1 ? "<th>Song</th>" : ""}<th>Country</th><th>Posted</th><th class="num">Views</th><th class="num">Likes</th><th class="num">Comments</th><th class="num">Shares</th></tr></thead>
      <tbody>${page.map((p) => `<tr>
        <td><a href="${esc(p.url)}" target="_blank" rel="noopener" class="artist">@${esc(p.creator?.username ?? "unknown")}</a><div class="muted small clamp">${esc(p.caption ?? "")}</div></td>
        ${(data.campaigns ?? []).length > 1 ? `<td>${esc(song(p))}</td>` : ""}
        <td>${flag(p.country)} ${esc(regionName(p.country))}</td>
        <td class="small">${esc(ago(p.published_at))}</td>
        <td class="num plays-cell">${n(p.plays)}</td><td class="num">${n(p.likes)}</td><td class="num">${n(p.comments)}</td><td class="num">${n(p.shares)}</td></tr>`).join("")}</tbody></table></div>`;
  if (list.length > page.length) {
    el.insertAdjacentHTML("beforeend", `<div class="actions" style="justify-content:center"><button type="button" id="more">${list.length - page.length <= 48 ? `Show the last ${n(list.length - page.length)}` : `Show 48 more (${n(list.length - page.length)} left)`}</button></div>`);
    document.getElementById("more").onclick = () => { state.shown += 48; renderPosts(); };
  }
  fetchCovers(page);
}

// Covers are private images. The function signs the first few; ask for the rest as they come into view.
async function fetchCovers(page) {
  const want = page.filter((p) => p.has_cover && !coverCache[p.video_id] && !asked.has(p.video_id)).map((p) => p.video_id);
  if (!want.length) return;
  want.forEach((v) => asked.add(v));
  for (let i = 0; i < want.length; i += 200) {
    try {
      const res = await fetch(FN, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token, covers: want.slice(i, i + 200) }) });
      if (!res.ok) continue;
      const { covers } = await res.json();
      Object.assign(coverCache, covers ?? {});
      for (const [vid, url] of Object.entries(covers ?? {})) {
        document.querySelectorAll(`img[data-vid="${CSS.escape(vid)}"]`).forEach((img) => { img.src = url; img.hidden = false; });
      }
    } catch { /* a missing cover isn't worth an error */ }
  }
}

let resizeTimer;
window.addEventListener("resize", () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => data && document.getElementById("panel") && renderPanel(), 200); });
window.addEventListener("hashchange", () => location.reload());
load();
