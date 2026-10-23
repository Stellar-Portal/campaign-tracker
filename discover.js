// Discover: find new creators through Influencers.club (AI search, lookalikes of a creator, or filters)
// on Instagram, YouTube, TikTok, Twitch and X, and add them to the roster.
// The discover Edge Function runs the searches; each costs 0.01 Influencers.club credits per creator shown,
// and the same search again within 24 hours is free.
//
// Route: #/discover
import { esc, big } from "./report.js?v=20261023n";
import { PLATFORMS, PLATFORM_ORDER, platformOf, detectPlatform } from "./platforms.js?v=20261023n";

const PAGE = 25;
const STORE = "discover:v1";
const load = () => { try { return JSON.parse(localStorage.getItem(STORE) ?? "null"); } catch { return null; } };
const save = () => { try { localStorage.setItem(STORE, JSON.stringify({ platform: st.platform, mode: st.mode, query: st.query, filters: st.filters, sort: st.sort })); } catch { /* private window */ } };
const st = { platform: "tiktok", mode: "ai", query: "", filters: {}, sort: "relevancy", ...(load() ?? {}), results: null, pages: [], busy: false };
const dicts = {};

// ---------- filters ----------
// Platforms: ig instagram · yt youtube · tt tiktok · tw twitch · x twitter
const ALL = ["instagram", "youtube", "tiktok", "twitch", "twitter"];
const IGTTYT = ["instagram", "tiktok", "youtube"];
const pct = (o) => ({ ...o, pct: true });
const FILTERS = [
  // General
  { id: "location", sec: "General", label: "Location", type: "pick", dict: (p) => `locations:${p}`, free: true, platforms: ALL, key: "location" },
  { id: "followers", sec: "General", label: "Followers", type: "range", platforms: ALL, key: "number_of_followers", labelFor: { youtube: "Subscribers" } },
  { id: "last_post", sec: "General", label: "Last post", type: "select", platforms: ALL, key: { twitch: "most_recent_stream_date", default: "last_post" },
    options: (p) => (p === "twitch" ? [["30", "Streamed in the last 30 days"], ["60", "In the last 60 days"], ["90", "In the last 90 days"]] : [["90", "Posted in the last 3 months"], ["365", "In the last year"]]) },
  pct({ id: "engagement", sec: "General", label: "Engagement rate", type: "range", platforms: ALL, key: "engagement_percent" }),
  { id: "gender", sec: "General", label: "Gender", type: "select", platforms: IGTTYT, key: "gender", options: () => [["Female", "Female"], ["Male", "Male"]] },
  { id: "language", sec: "General", label: "Language", type: "pick", dict: () => "languages", platforms: ALL, key: "profile_language", value: (x) => x.abbreviation, text: (x) => x.language },
  // Creator
  { id: "niche", sec: "Creator", label: "Niche", type: "pick", dict: () => "niche+sub", platforms: [...IGTTYT, "twitter"], key: "niche" },
  { id: "link_in_bio", sec: "Creator", label: "Link in bio contains", type: "tags", platforms: IGTTYT, key: "link_in_bio", hint: "e.g. linktr.ee, spotify" },
  { id: "bio", sec: "Creator", label: "Keywords in bio", type: "tags", platforms: ALL, key: "keywords_in_bio", hint: "e.g. singer, DJ" },
  { id: "age", sec: "Creator", label: "Age", type: "checks", platforms: IGTTYT, key: "age_bracket", options: () => [["18-24", "18–24"], ["25-34", "25–34"], ["35-44", "35–44"], ["45-60", "45–60"], ["60+", "60+"]] },
  { id: "private", sec: "Creator", label: "Exclude private profiles", type: "check", platforms: ["instagram", "tiktok"], key: "exclude_private_profile" },
  { id: "verified", sec: "Creator", label: "Verified profile", type: "check", platforms: [...IGTTYT, "twitter"], key: "is_verified" },
  { id: "partner", sec: "Creator", label: "Twitch partner", type: "check", platforms: ["twitch"], key: "is_twitch_partner" },
  { id: "shorts", sec: "Creator", label: "Makes Shorts", type: "check", platforms: ["youtube"], key: "has_shorts" },
  { id: "growth", sec: "Creator", label: "Follower growth", type: "growth", platforms: ALL, key: "follower_growth" },
  { id: "frequency", sec: "Creator", label: "Posting frequency", type: "number", platforms: [...IGTTYT, "twitter"], key: "posting_frequency", unit: "posts a month or more" },
  { id: "posts", sec: "Creator", label: "Number of posts", type: "range", platforms: [...IGTTYT, "twitter"], key: { twitter: "tweets_count", default: "number_of_posts" } },
  { id: "games", sec: "Creator", label: "Games streamed", type: "pick", dict: () => "games", platforms: ["twitch"], key: "games_played" },
  { id: "hours", sec: "Creator", label: "Hours streamed (30 days)", type: "range", platforms: ["twitch"], key: "streamed_hours_last_30_days" },
  // Audience
  { id: "a_age", sec: "Audience", label: "Age range", type: "aud", sub: "age", platforms: IGTTYT, options: () => [["13-17", "13–17"], ["18-24", "18–24"], ["25-34", "25–34"], ["35-44", "35–44"], ["45-64", "45–64"], ["65+", "65+"]] },
  { id: "a_int", sec: "Audience", label: "Interests", type: "aud", sub: "interests", dict: () => "audience_interests", platforms: IGTTYT },
  { id: "a_cred", sec: "Audience", label: "Audience credibility", type: "select", platforms: IGTTYT, key: "audience.credibility",
    options: () => [["best", "Best"], ["high", "High"], ["good", "Good"], ["normal", "Normal"], ["low", "Low"]] },
  { id: "a_loc", sec: "Audience", label: "Audience location", type: "aud", sub: "location", dict: () => "audience_locations", platforms: IGTTYT },
  { id: "a_lang", sec: "Audience", label: "Audience language", type: "aud", sub: "language", dict: () => "languages", platforms: IGTTYT },
  { id: "a_gender", sec: "Audience", label: "Audience gender", type: "aud", sub: "gender", platforms: IGTTYT, options: () => [["female", "Female"], ["male", "Male"]] },
  // Content
  { id: "hashtags", sec: "Content", label: "Hashtags", type: "tags", platforms: [...IGTTYT, "twitter"], key: "hashtags", hint: "without #" },
  { id: "captions", sec: "Content", label: "Video description", type: "tags", platforms: [...IGTTYT, "twitter"],
    key: { tiktok: "video_description", instagram: "keywords_in_captions", youtube: "keywords_in_video_description", twitter: "keywords_in_tweets" },
    labelFor: { instagram: "Captions", twitter: "Words in tweets" }, hint: "words that appear" },
  { id: "views", sec: "Content", label: "Average views", note: "(last 30 videos)", type: "range", platforms: ["tiktok", "youtube", "instagram", "twitch"],
    key: { tiktok: "average_views", youtube: "average_views", instagram: "average_views_for_reels", twitch: "average_stream_views" }, labelFor: { instagram: "Average reel views", twitch: "Average stream views" } },
  { id: "likes", sec: "Content", label: "Average likes", note: "(last 30 videos)", type: "range", platforms: [...IGTTYT, "twitter"], key: "average_likes" },
  { id: "comments", sec: "Content", label: "Average comments", note: "(last 30 videos)", type: "range", platforms: IGTTYT, key: "average_comments" },
  { id: "downloads", sec: "Content", label: "Average downloads", type: "range", platforms: ["tiktok"], key: "average_video_downloads" },
  // Creator has
  { id: "has", sec: "Creator has", label: "Creator has", type: "has", platforms: ALL, key: "creator_has" },
];
const SECTIONS = ["General", "Creator", "Audience", "Content", "Creator has"];
const HAS = [["instagram", "Instagram"], ["tiktok", "TikTok"], ["youtube", "YouTube"], ["twitch", "Twitch"], ["twitter", "X"], ["spotify", "Spotify"], ["applemusic", "Apple Music"], ["soundcloud", "SoundCloud"],
  ["bandcamp", "Bandcamp"], ["patreon", "Patreon"], ["discord", "Discord"], ["linktree", "Linktree"], ["snapchat", "Snapchat"], ["facebook", "Facebook"], ["whatsApp", "WhatsApp"], ["telegram", "Telegram"],
  ["linkedin", "LinkedIn"], ["tumblr", "Tumblr"], ["pinterest", "Pinterest"], ["podcast", "Podcast"], ["personal_website", "Own website"], ["shopify", "Shopify"], ["etsy", "Etsy"], ["kofi", "Ko-fi"],
  ["buymeacoffee", "Buy Me a Coffee"], ["substack", "Substack"], ["medium", "Medium"], ["vimeo", "Vimeo"], ["kakao", "Kakao"], ["vk", "VK"], ["phone", "Phone number"]];

const keyFor = (f, p) => (typeof f.key === "object" ? f.key[p] ?? f.key.default : f.key);
const labelOf = (f, p) => f.labelFor?.[p] ?? f.label;
const avail = (f, p) => f.platforms.includes(p);
const isSet = (v) => v != null && v !== "" && !(Array.isArray(v) && !v.length) && !(typeof v === "object" && !Array.isArray(v) && !Object.values(v).some((x) => x != null && x !== "" && !(Array.isArray(x) && !x.length)));
const activeIds = () => FILTERS.filter((f) => avail(f, st.platform) && isSet(st.filters[f.id])).map((f) => f.id);

// "50k", "1.2m", "1,000" → number
function parseNum(v) {
  const s = String(v ?? "").trim().toLowerCase().replace(/[, ]/g, "");
  if (!s) return null;
  const m = s.match(/^(\d+(?:\.\d+)?)([km])?$/);
  if (!m) return null;
  return Number(m[1]) * (m[2] === "k" ? 1e3 : m[2] === "m" ? 1e6 : 1);
}
const fmtNum = (n) => (n == null ? "" : n >= 1e6 ? `${+(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${+(n / 1e3).toFixed(1)}K` : String(n));

// The filters object Influencers.club expects, for the chosen platform.
function apiFilters() {
  const p = st.platform, out = {}, aud = {};
  for (const f of FILTERS) {
    if (!avail(f, p)) continue;
    const v = st.filters[f.id];
    if (!isSet(v)) continue;
    const k = keyFor(f, p);
    if (f.type === "range") {
      const r = {}; if (v.min != null) r.min = f.pct ? Number(v.min) : v.min; if (v.max != null) r.max = f.pct ? Number(v.max) : v.max;
      if (Object.keys(r).length) out[k] = r;
    } else if (f.type === "pick" && f.id === "niche") {
      const niches = dicts.niche ?? [];
      const top = v.filter((x) => niches.includes(x)), sub = v.filter((x) => !niches.includes(x));
      if (top.length) out.niche = top;
      if (sub.length) out.sub_niche = sub;
    } else if (f.type === "growth") {
      if (v.pct != null) out[k] = { growth_percentage: Number(v.pct), time_range_months: Number(v.months ?? 6) };
    } else if (f.type === "number") out[k] = Number(v);
    else if (f.type === "has") { const o = {}; v.forEach((h) => (o[`has_${h}`] = true)); out[k] = o; }
    else if (f.type === "aud") {
      const min = Number(v.min ?? 20);
      if (f.sub === "gender") { if (v.value) aud.gender = { type: v.value, min_pct: min }; }
      else if (f.sub === "age") aud.age = (v.values ?? []).map((r) => ({ range: r, min_pct: min }));
      else if (f.sub === "interests") aud.interests = (v.values ?? []).map((n) => ({ name: n, min_pct: min }));
      else if (f.sub === "language") aud.language = (v.values ?? []).map((a) => ({ language_abbr: a, min_pct: min }));
      else if (f.sub === "location") aud.location = (v.values ?? []).map((n) => ({ name: n, type: (dicts.audience_locations ?? []).find((x) => x.name === n)?.type ?? "country", min_pct: min }));
    } else if (k === "audience.credibility") aud.credibility = v;
    else out[k] = v;
  }
  if (Object.keys(aud).length) out.audience = aud;
  return out;
}

// Short text for a filter chip.
function summary(f) {
  const v = st.filters[f.id], p = st.platform;
  if (!isSet(v)) return "";
  const nameOf = (x) => (f.id === "language" ? (dicts.languages ?? []).find((l) => l.abbreviation === x)?.language ?? x : x);
  switch (f.type) {
    case "range": {
      const u = f.pct ? "%" : "";
      const a = v.min != null ? `${f.pct ? v.min : fmtNum(v.min)}${u}` : null, b = v.max != null ? `${f.pct ? v.max : fmtNum(v.max)}${u}` : null;
      return a && b ? `${a}–${b}` : a ? `${a}+` : `up to ${b}`;
    }
    case "select": return (f.options(p).find(([k]) => k === v) ?? [v, v])[1];
    case "check": return "Yes";
    case "number": return `${v}+ a month`;
    case "growth": return `${v.pct}%+ in ${v.months ?? 6} months`;
    case "checks": case "pick": case "tags": return v.length > 2 ? `${v.slice(0, 2).map(nameOf).join(", ")} +${v.length - 2}` : v.map(nameOf).join(", ");
    case "has": return v.length > 2 ? `${v.slice(0, 2).map((h) => HAS.find(([k]) => k === h)?.[1] ?? h).join(", ")} +${v.length - 2}` : v.map((h) => HAS.find(([k]) => k === h)?.[1] ?? h).join(", ");
    case "aud": {
      const names = f.sub === "gender" ? [String(v.value).charAt(0).toUpperCase() + String(v.value).slice(1)] : (v.values ?? []).map((x) => (f.sub === "language" ? (dicts.languages ?? []).find((l) => l.abbreviation === x)?.language ?? x : x));
      return `${names.slice(0, 2).join(", ")}${names.length > 2 ? ` +${names.length - 2}` : ""} ≥${v.min ?? 20}%`;
    }
  }
  return "";
}

async function invoke(sb, body) {
  const { data, error } = await sb.functions.invoke("discover", { body });
  if (error || data?.error) {
    let msg = data?.error;
    if (!msg && error?.context?.json) { try { msg = (await error.context.json())?.error; } catch { /* ignore */ } }
    throw new Error(msg ?? error?.message ?? "Something went wrong");
  }
  return data;
}

async function loadDicts(sb) {
  const want = ["languages", "niche", "sub_niche", "audience_interests", "audience_locations", "games", ...ALL.map((p) => `locations:${p}`)];
  const missing = want.filter((k) => !dicts[k]);
  if (!missing.length) return;
  const { data } = await sb.from("ic_dictionary").select("kind,values").in("kind", missing);
  for (const r of data ?? []) dicts[r.kind] = r.values;
  dicts["niche+sub"] = [...(dicts.niche ?? []), ...(dicts.sub_niche ?? [])];
}
const dictValues = (f) => {
  const list = dicts[f.dict(st.platform)] ?? [];
  return list.map((x) => (typeof x === "string" ? { value: x, text: x } : { value: f.value ? f.value(x) : x.name, text: f.text ? f.text(x) : x.name }));
};

// ---------- page ----------
export async function renderDiscover(app, sb, ctx) {
  const { isCurrent, toast } = ctx;
  app.innerHTML = `<p class="muted pad">Loading Discover…</p>`;
  await loadDicts(sb);
  const [rosterRes, recentRes] = await Promise.all([
    sb.from("creators").select("id,username,platform").eq("on_roster", true),
    sb.from("discovery_searches").select("id,platform,mode,query,total,created_by,created_at,request").order("created_at", { ascending: false }).limit(8),
  ]);
  if (!isCurrent()) return;
  const onRoster = new Map((rosterRes.data ?? []).map((c) => [`${c.platform}:${String(c.username).toLowerCase()}`, c.id]));

  app.innerHTML = `
    <div class="page-head">
      <div><h1>Discover</h1>
        <p class="muted small" style="margin:6px 0 0">Find new creators with Influencers.club: describe who you're looking for, find lookalikes of a creator, or use filters. Add the ones you like to the <a href="#/roster">roster</a>.</p></div>
      <span class="dc-credits small muted" id="dc-credits"></span>
    </div>
    <form class="dc-bar" id="dc-form">
      <label class="dc-sel dc-pf"><span class="dc-pf-ico" id="dc-pf-ico">${PLATFORMS[st.platform].icon}</span>
        <select id="dc-platform" aria-label="Platform">${PLATFORM_ORDER.map((p) => `<option value="${p}"${p === st.platform ? " selected" : ""}>${PLATFORMS[p].name}</option>`).join("")}</select></label>
      <label class="dc-sel"><select id="dc-mode" aria-label="Search type">
        <option value="ai"${st.mode === "ai" ? " selected" : ""}>AI search</option>
        <option value="lookalike"${st.mode === "lookalike" ? " selected" : ""}>Lookalike / username search</option>
      </select></label>
      <input id="dc-q" type="text" autocomplete="off" aria-label="Search" value="${esc(st.query)}">
      <button type="submit" class="primary" id="dc-go">Search</button>
    </form>
    <div class="dc-row">
      <button type="button" id="dc-open-filters" class="dc-filters-btn"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3 5h14M6 10h8M8.5 15h3"/></svg>All filters <span class="dc-count" id="dc-count"></span></button>
      <div class="dc-chips" id="dc-chips"></div>
      <label class="ov-pill ov-sort dc-sort" id="dc-sort-wrap"><span>Show me</span><select id="dc-sort" aria-label="Sort">
        ${[["relevancy", "Most relevant"], ["number_of_followers", "Most followers"], ["engagement_rate", "Highest engagement"], ["growth_rate", "Fastest growing"]].map(([k, l]) => `<option value="${k}"${st.sort === k ? " selected" : ""}>${l}</option>`).join("")}
      </select></label>
    </div>
    <p class="small muted dc-cost" id="dc-cost"></p>
    <div id="dc-results"></div>
    ${(recentRes.data ?? []).length ? `<section class="dc-recent"><h3 class="ro-h3">Recent searches by the team</h3><div class="dc-recent-list">${(recentRes.data ?? []).map((r) => `
      <button type="button" class="dc-recent-item" data-recent="${esc(r.id)}"><span class="ro-pfmini">${platformOf(r.platform).icon}</span>
        <span class="dc-recent-q">${esc(r.mode === "lookalike" ? `Lookalikes of @${String(r.query ?? "").replace(/^@/, "")}` : r.query || "Filters only")}</span>
        <span class="muted small">${big(r.total)} found · ${esc((r.created_by ?? "").split("@")[0])} · ${esc(new Date(r.created_at).toLocaleDateString("en-GB", { day: "numeric", month: "short" }))}</span></button>`).join("")}</div></section>` : ""}
    <dialog class="dc-dialog" id="dc-dialog" aria-label="All filters"></dialog>`;

  const $ = (id) => document.getElementById(id);
  const qEl = $("dc-q"), modeEl = $("dc-mode"), pfEl = $("dc-platform");
  const placeholder = () => (qEl.placeholder = st.mode === "ai"
    ? `Describe who you're looking for, e.g. "Filipino indie pop singers with 50k–500k followers"`
    : `@handle or ${PLATFORMS[st.platform].name} profile link of a creator you like`);
  placeholder();
  const costLine = () => {
    $("dc-cost").textContent = `Shows ${PAGE} creators per search · 0.01 credits per creator (${(PAGE * 0.01).toFixed(2)} per search) · the same search again within 24 hours is free.`;
  };
  costLine();
  $("dc-sort-wrap").hidden = st.mode === "lookalike";

  invoke(sb, { action: "credits" }).then((c) => { if (isCurrent() && c) $("dc-credits").textContent = `Influencers.club: ${(+c.credits_available).toFixed(2)} credits left`; }).catch(() => {});

  const drawChips = () => {
    const ids = activeIds();
    $("dc-count").textContent = ids.length ? String(ids.length) : "";
    $("dc-chips").innerHTML = ids.map((id) => { const f = FILTERS.find((x) => x.id === id); return `<span class="dc-chip">${esc(labelOf(f, st.platform))}: <b>${esc(summary(f))}</b><button type="button" data-unset="${id}" aria-label="Remove ${esc(labelOf(f, st.platform))}">×</button></span>`; }).join("")
      + (ids.length ? `<button type="button" class="link-btn small" id="dc-clear">Clear all</button>` : "");
    $("dc-chips").querySelectorAll("[data-unset]").forEach((b) => (b.onclick = () => { delete st.filters[b.dataset.unset]; save(); drawChips(); }));
    $("dc-clear")?.addEventListener("click", () => { st.filters = {}; save(); drawChips(); });
  };
  drawChips();

  pfEl.onchange = () => { st.platform = pfEl.value; $("dc-pf-ico").innerHTML = PLATFORMS[st.platform].icon; placeholder(); save(); drawChips(); };
  modeEl.onchange = () => { st.mode = modeEl.value; placeholder(); $("dc-sort-wrap").hidden = st.mode === "lookalike"; save(); };
  qEl.oninput = () => {
    st.query = qEl.value; save();
    const p = st.mode === "lookalike" ? detectPlatform(qEl.value) : null;
    if (p && p !== st.platform) { st.platform = p; pfEl.value = p; $("dc-pf-ico").innerHTML = PLATFORMS[p].icon; placeholder(); drawChips(); }
  };
  $("dc-sort").onchange = (e) => { st.sort = e.target.value; save(); };
  $("dc-open-filters").onclick = () => openFilters(app, sb, drawChips);

  const resultsEl = $("dc-results");
  const run = async (page = 0, opts = {}) => {
    if (st.busy) return;
    const query = qEl.value.trim();
    const mode = opts.mode ?? (query || st.mode === "lookalike" ? st.mode : "filters");
    if (mode === "lookalike" && !query) { toast("Type the @handle or paste the profile link of a creator you like"); qEl.focus(); return; }
    if (mode === "filters" && !activeIds().length) { toast("Describe who you're looking for, or add some filters"); qEl.focus(); return; }
    st.busy = true;
    const btn = $("dc-go"); btn.disabled = true; btn.textContent = "Searching…";
    if (!page) resultsEl.innerHTML = `<div class="panel"><p class="muted" style="margin:0">Searching Influencers.club…</p></div>`;
    else resultsEl.querySelector("#dc-more")?.setAttribute("disabled", "");
    try {
      const r = await invoke(sb, { action: "search", platform: st.platform, mode, query, filters: apiFilters(), sort: st.sort, page, limit: PAGE });
      if (!isCurrent()) return;
      st.results = { ...r, mode, query, platform: st.platform };
      st.pages = page ? [...st.pages, ...r.accounts] : r.accounts;
      drawResults();
    } catch (err) {
      if (!isCurrent()) return;
      if (!page) resultsEl.innerHTML = `<div class="panel"><p class="warn-note" style="margin:0">${esc(err.message)}</p></div>`;
      else toast(err.message);
    } finally {
      st.busy = false;
      if (isCurrent()) { btn.disabled = false; btn.textContent = "Search"; }
    }
  };
  $("dc-form").onsubmit = (e) => { e.preventDefault(); run(0); };

  const drawResults = () => {
    const r = st.results;
    if (!r) { resultsEl.innerHTML = ""; return; }
    const pf = platformOf(r.platform);
    const applied = r.applied_filters ? Object.entries(r.applied_filters) : [];
    const head = `<div class="dc-res-head">
        <div><b>${big(r.total)}</b> creators found${r.mode === "lookalike" ? ` similar to <b>@${esc(String(r.query).replace(/^@/, "").split("/").filter(Boolean).pop())}</b>` : ""}
          <span class="muted small"> · ${r.cached ? "from a search in the last 24 hours, no credits used" : `used ${Number(r.credits_cost ?? 0).toFixed(2)} credits`}${r.credits_left != null ? ` · ${Number(r.credits_left).toFixed(2)} left` : ""}${r.trial_searches_left != null ? ` · ${r.trial_searches_left} trial searches left` : ""}</span></div>
      </div>
      ${r.mode === "ai" && applied.length ? `<div class="dc-applied"><span class="muted small">AI searched for:</span> ${applied.map(([k, v]) => `<span class="ro-chip small">${esc(k.replace(/_/g, " "))}: ${esc(typeof v === "object" ? JSON.stringify(v).replace(/[{}"[\]]/g, "").replace(/,/g, ", ").replace(/:/g, " ") : String(v))}</span>`).join("")}${(r.nlp?.notes ?? []).length ? `<span class="muted small"> ${esc(r.nlp.notes.join(" "))}</span>` : ""}</div>` : ""}`;
    if (!st.pages.length) { resultsEl.innerHTML = `${head}<div class="panel"><p class="muted" style="margin:0">No creators match. Try fewer filters or a broader description.</p></div>`; return; }
    resultsEl.innerHTML = `${head}
      <div class="table-wrap dc-table"><table>
        <thead><tr><th>Creator</th><th class="num">${r.platform === "youtube" ? "Subscribers" : "Followers"}</th><th class="num">Engagement</th>${r.mode === "lookalike" ? `<th class="num">Match</th>` : ""}<th class="dc-act-h"><span class="sr-only">Actions</span></th></tr></thead>
        <tbody>${st.pages.map((a) => {
          const key = `${r.platform}:${String(a.username).toLowerCase()}`, rid = onRoster.get(key);
          return `<tr>
            <td><a class="ro-who dc-who" href="${esc(pf.url(a.username))}" target="_blank" rel="noopener">
              <span class="ro-av" style="--s:40px">${a.picture ? `<img src="${esc(a.picture)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">` : ""}<span>${esc((a.name || a.username || "?").charAt(0).toUpperCase())}</span></span>
              <span class="ro-names"><b>${esc(a.name || a.username)}</b><span class="muted small ro-handle"><span class="ro-pfmini">${pf.icon}</span>@${esc(a.username)}</span></span></a></td>
            <td class="num" title="${a.followers ?? ""}">${big(a.followers)}</td>
            <td class="num">${a.engagement != null ? `${Number(a.engagement).toFixed(1)}%` : "–"}</td>
            ${r.mode === "lookalike" ? `<td class="num">${a.similarity != null ? `${Math.round(a.similarity * 100)}%` : "–"}</td>` : ""}
            <td class="dc-acts">
              <button type="button" class="dc-btn" data-like="${esc(a.username)}" title="Find creators like @${esc(a.username)}">Lookalikes</button>
              ${rid ? `<a class="dc-btn on" href="#/creator/${esc(rid)}">★ On the roster</a>` : `<button type="button" class="dc-btn" data-add="${esc(a.username)}">☆ Add to roster</button>`}
            </td></tr>`;
        }).join("")}</tbody></table></div>
      ${st.pages.length < r.total ? `<div class="dc-more-row"><button type="button" id="dc-more">Show ${Math.min(PAGE, r.total - st.pages.length)} more</button><span class="muted small">${(Math.min(PAGE, r.total - st.pages.length) * 0.01).toFixed(2)} credits</span></div>` : ""}`;
    resultsEl.querySelector("#dc-more")?.addEventListener("click", () => run(Math.floor(st.pages.length / PAGE), { mode: r.mode }));
    resultsEl.querySelectorAll("[data-like]").forEach((b) => (b.onclick = () => {
      st.mode = "lookalike"; modeEl.value = "lookalike"; qEl.value = st.query = `@${b.dataset.like}`; placeholder(); $("dc-sort-wrap").hidden = true; save();
      window.scrollTo({ top: 0, behavior: "smooth" }); run(0);
    }));
    resultsEl.querySelectorAll("[data-add]").forEach((b) => (b.onclick = async () => {
      b.disabled = true; b.textContent = "Adding…";
      try {
        const { data: res, error } = await sb.functions.invoke("roster", { body: { action: "add", input: `@${b.dataset.add}`, platform: r.platform } });
        if (error || res?.error) throw new Error(res?.error ?? error.message);
        onRoster.set(`${r.platform}:${b.dataset.add.toLowerCase()}`, res.id);
        b.outerHTML = `<a class="dc-btn on" href="#/creator/${esc(res.id)}">★ On the roster</a>`;
        toast(`Added @${b.dataset.add} to the roster`);
      } catch (err) { toast(`Couldn't add: ${err.message}`); b.disabled = false; b.textContent = "☆ Add to roster"; }
    }));
  };
  if (st.results && st.results.platform) drawResults();

  // Reopen a recent search: same request, so it's free within 24 hours.
  app.querySelectorAll("[data-recent]").forEach((b) => (b.onclick = async () => {
    const row = (recentRes.data ?? []).find((x) => x.id === b.dataset.recent);
    if (!row) return;
    const rq = row.request ?? {};
    st.platform = row.platform; pfEl.value = row.platform; $("dc-pf-ico").innerHTML = PLATFORMS[row.platform].icon;
    st.mode = row.mode === "lookalike" ? "lookalike" : "ai"; modeEl.value = st.mode;
    qEl.value = st.query = row.mode === "lookalike" ? `@${rq.filter_value ?? row.query ?? ""}` : row.query ?? "";
    placeholder(); save(); drawChips();
    window.scrollTo({ top: 0, behavior: "smooth" });
    if (st.busy) return;
    st.busy = true;
    resultsEl.innerHTML = `<div class="panel"><p class="muted" style="margin:0">Opening the search…</p></div>`;
    try {
      const body = { action: "search", platform: row.platform, mode: row.mode, query: row.mode === "lookalike" ? rq.filter_value : row.query, filters: rq.filters ?? {}, sort: rq.sort?.sort_by, page: rq.paging?.page ?? 0, limit: rq.paging?.limit ?? PAGE };
      const r = await invoke(sb, body);
      if (!isCurrent()) return;
      st.results = { ...r, mode: row.mode, query: body.query, platform: row.platform }; st.pages = r.accounts; drawResults();
    } catch (err) { resultsEl.innerHTML = `<div class="panel"><p class="warn-note" style="margin:0">${esc(err.message)}</p></div>`; }
    finally { st.busy = false; }
  }));
}

// ---------- the filters window ----------
function openFilters(app, sb, onChange) {
  const dlg = document.getElementById("dc-dialog");
  const p = st.platform;
  const draft = JSON.parse(JSON.stringify(st.filters));
  const field = (f) => {
    const v = draft[f.id];
    const on = isSet(v);
    const sum = on ? (() => { const keep = st.filters; st.filters = draft; const t = summary(f); st.filters = keep; return t; })() : "";
    if (f.type === "check") return `<label class="df df-check"><input type="checkbox" data-check="${f.id}"${v ? " checked" : ""}><span>${esc(labelOf(f, p))}</span></label>`;
    return `<details class="df${on ? " on" : ""}" data-f="${f.id}"><summary><span class="df-l">${esc(labelOf(f, p))}${f.note ? ` <i>${esc(f.note)}</i>` : ""}</span>${on ? `<span class="df-v">${esc(sum)}</span>` : ""}<svg viewBox="0 0 20 20" aria-hidden="true"><path d="m6 8 4 4 4-4"/></svg></summary><div class="df-pop">${editor(f, v)}</div></details>`;
  };
  const editor = (f, v) => {
    switch (f.type) {
      case "range": return `<div class="df-range"><label>Min<input data-min="${f.id}" inputmode="decimal" value="${esc(v?.min != null ? (f.pct ? v.min : fmtNum(v.min)) : "")}" placeholder="${f.pct ? "e.g. 3" : "e.g. 50k"}"></label><span>–</span><label>Max<input data-max="${f.id}" inputmode="decimal" value="${esc(v?.max != null ? (f.pct ? v.max : fmtNum(v.max)) : "")}" placeholder="${f.pct ? "e.g. 15" : "e.g. 1m"}"></label>${f.pct ? `<span class="muted small">%</span>` : ""}</div>`;
      case "select": return `<div class="df-opts">${f.options(p).map(([k, l]) => `<label><input type="radio" name="r-${f.id}" data-radio="${f.id}" value="${esc(k)}"${v === k ? " checked" : ""}> ${esc(l)}</label>`).join("")}<button type="button" class="link-btn small" data-clear="${f.id}">Clear</button></div>`;
      case "checks": return `<div class="df-opts">${f.options(p).map(([k, l]) => `<label><input type="checkbox" data-multi="${f.id}" value="${esc(k)}"${(v ?? []).includes(k) ? " checked" : ""}> ${esc(l)}</label>`).join("")}</div>`;
      case "number": return `<div class="df-range"><label>At least<input data-num="${f.id}" inputmode="numeric" value="${esc(v ?? "")}" placeholder="e.g. 8"></label><span class="muted small">${esc(f.unit ?? "")}</span></div>`;
      case "growth": return `<div class="df-range"><label>Grew at least<input data-gpct="${f.id}" inputmode="decimal" value="${esc(v?.pct ?? "")}" placeholder="e.g. 10"></label><span class="muted small">% in</span><label><select data-gmon="${f.id}">${[3, 6, 9, 12].map((m) => `<option value="${m}"${Number(v?.months ?? 6) === m ? " selected" : ""}>${m} months</option>`).join("")}</select></label></div>`;
      case "tags": return `<div class="df-tags"><div class="df-tag-list">${(v ?? []).map((t) => `<span class="dc-chip">${esc(t)}<button type="button" data-untag="${f.id}" data-t="${esc(t)}" aria-label="Remove">×</button></span>`).join("")}</div><input data-tag="${f.id}" placeholder="${esc(f.hint ?? "Type and press Enter")}"><span class="muted small">Press Enter after each one.</span></div>`;
      case "pick": return picker(f, v ?? [], "pick");
      case "has": return `<div class="df-has">${HAS.map(([k, l]) => `<label class="df-has-i${(v ?? []).includes(k) ? " on" : ""}"><input type="checkbox" data-has="${k}"${(v ?? []).includes(k) ? " checked" : ""}>${PLATFORMS[k]?.icon ?? ""}<span>${esc(l)}</span></label>`).join("")}</div>`;
      case "aud": {
        const min = v?.min ?? 20;
        const body = f.sub === "gender" ? `<div class="df-opts">${f.options().map(([k, l]) => `<label><input type="radio" name="ag" data-agender="${f.id}" value="${k}"${v?.value === k ? " checked" : ""}> ${l}</label>`).join("")}</div>`
          : f.sub === "age" ? `<div class="df-opts">${f.options().map(([k, l]) => `<label><input type="checkbox" data-amulti="${f.id}" value="${k}"${(v?.values ?? []).includes(k) ? " checked" : ""}> ${l}</label>`).join("")}</div>`
          : picker(f, v?.values ?? [], "apick");
        return `${body}<div class="df-range df-min"><label>At least<input data-amin="${f.id}" inputmode="numeric" value="${esc(min)}"></label><span class="muted small">% of their audience</span></div>`;
      }
    }
    return "";
  };
  const picker = (f, sel, kind) => {
    const nameOf = (x) => dictValues(f).find((d) => d.value === x)?.text ?? x;
    return `<div class="df-pick" data-pick="${f.id}" data-kind="${kind}">
      <div class="df-tag-list">${sel.map((x) => `<span class="dc-chip">${esc(nameOf(x))}<button type="button" data-unpick="${f.id}" data-v="${esc(x)}" aria-label="Remove">×</button></span>`).join("")}</div>
      <input type="search" data-search="${f.id}" placeholder="Search${f.free ? " or type a place and press Enter" : ""}" autocomplete="off">
      <div class="df-pick-list" data-list="${f.id}"></div></div>`;
  };
  const fillList = (f, q = "") => {
    const box = dlg.querySelector(`[data-list="${f.id}"]`);
    if (!box) return;
    const sel = f.type === "aud" ? draft[f.id]?.values ?? [] : draft[f.id] ?? [];
    const ql = q.trim().toLowerCase();
    const items = dictValues(f).filter((d) => !sel.includes(d.value) && (!ql || d.text.toLowerCase().includes(ql))).slice(0, 60);
    box.innerHTML = items.length ? items.map((d) => `<button type="button" data-addpick="${f.id}" data-v="${esc(d.value)}">${esc(d.text)}</button>`).join("") : `<span class="muted small">${dictValues(f).length ? "No matches" : "List not loaded yet"}</span>`;
  };

  const draw = (openId) => {
    const secs = SECTIONS.map((s) => {
      const fs = FILTERS.filter((f) => f.sec === s && avail(f, p));
      if (!fs.length) return "";
      return `<section class="dc-sec"><h4>${esc(s)}</h4><div class="dc-grid${s === "Creator has" ? " one" : ""}">${fs.map(field).join("")}</div></section>`;
    }).join("");
    dlg.innerHTML = `<form method="dialog" class="dc-dlg-in">
      <header class="dc-dlg-head"><div><h3 style="margin:0">All filters</h3><span class="muted small">${esc(PLATFORMS[p].name)} · filters that don't apply to ${esc(PLATFORMS[p].name)} are hidden${["instagram", "tiktok", "youtube"].includes(p) ? ". Audience filters work best for Instagram creators with 10K+ followers" : ""}.</span></div>
        <button type="button" class="dc-x" data-close aria-label="Close">×</button></header>
      <div class="dc-dlg-body">${secs}</div>
      <footer class="dc-dlg-foot"><button type="button" class="link-btn" data-reset>Clear all</button><span class="muted small" id="dc-dlg-n"></span><button type="button" data-close>Cancel</button><button type="button" class="primary" data-apply>Apply filters</button></footer>
    </form>`;
    const n = FILTERS.filter((f) => avail(f, p) && isSet(draft[f.id])).length;
    dlg.querySelector("#dc-dlg-n").textContent = n ? `${n} filter${n === 1 ? "" : "s"} set` : "";
    if (openId) { const d = dlg.querySelector(`details[data-f="${openId}"]`); if (d) { d.open = true; const f = FILTERS.find((x) => x.id === openId); if (f.dict) fillList(f); d.querySelector("[data-search]")?.focus(); } }
    bind();
  };
  const refresh = (id) => {
    const d = dlg.querySelector(`details[data-f="${id}"]`), f = FILTERS.find((x) => x.id === id);
    if (d && f) {
      const on = isSet(draft[id]);
      d.classList.toggle("on", on);
      const keep = st.filters; st.filters = draft; const t = on ? summary(f) : ""; st.filters = keep;
      let v = d.querySelector(".df-v");
      if (on && !v) { v = document.createElement("span"); v.className = "df-v"; d.querySelector(".df-l").after(v); }
      if (v) { if (on) v.textContent = t; else v.remove(); }
    }
    const n = FILTERS.filter((x) => avail(x, p) && isSet(draft[x.id])).length;
    dlg.querySelector("#dc-dlg-n").textContent = n ? `${n} filter${n === 1 ? "" : "s"} set` : "";
  };
  const redraw = (id) => { const scroll = dlg.querySelector(".dc-dlg-body")?.scrollTop ?? 0; draw(id); dlg.querySelector(".dc-dlg-body").scrollTop = scroll; };

  const bind = () => {
    dlg.querySelectorAll("[data-close]").forEach((b) => (b.onclick = () => dlg.close()));
    dlg.querySelector("[data-reset]").onclick = () => { for (const k of Object.keys(draft)) delete draft[k]; redraw(); };
    dlg.querySelector("[data-apply]").onclick = () => { st.filters = draft; save(); onChange(); dlg.close(); };
    // One open field at a time.
    dlg.querySelectorAll("details.df").forEach((d) => d.addEventListener("toggle", () => {
      if (!d.open) return;
      dlg.querySelectorAll("details.df[open]").forEach((o) => { if (o !== d) o.open = false; });
      const f = FILTERS.find((x) => x.id === d.dataset.f);
      if (f.dict) fillList(f);
    }));
    // Typing updates the draft and the field's summary in place (a redraw would swallow a click on Apply).
    const numIn = (sel, fn) => dlg.querySelectorAll(sel).forEach((el) => (el.oninput = el.onchange = () => { fn(el); refresh(el.dataset[Object.keys(el.dataset)[0]]); }));
    numIn("[data-min],[data-max]", (el) => {
      const id = el.dataset.min ?? el.dataset.max, f = FILTERS.find((x) => x.id === id);
      const val = f.pct ? (el.value.trim() === "" ? null : Number(el.value)) : parseNum(el.value);
      draft[id] = { ...(draft[id] ?? {}), [el.dataset.min ? "min" : "max"]: Number.isFinite(val) ? val : null };
    });
    numIn("[data-num]", (el) => { const n = parseNum(el.value); draft[el.dataset.num] = n ?? undefined; if (n == null) delete draft[el.dataset.num]; });
    numIn("[data-gpct],[data-gmon]", (el) => {
      const id = el.dataset.gpct ?? el.dataset.gmon;
      draft[id] = { ...(draft[id] ?? { months: 6 }), ...(el.dataset.gpct ? { pct: el.value.trim() === "" ? null : Number(el.value) } : { months: Number(el.value) }) };
    });
    dlg.querySelectorAll("[data-radio]").forEach((el) => (el.onchange = () => { draft[el.dataset.radio] = el.value; redraw(el.dataset.radio); }));
    dlg.querySelectorAll("[data-clear]").forEach((el) => (el.onclick = () => { delete draft[el.dataset.clear]; redraw(el.dataset.clear); }));
    dlg.querySelectorAll("[data-check]").forEach((el) => (el.onchange = () => { if (el.checked) draft[el.dataset.check] = true; else delete draft[el.dataset.check]; redraw(); }));
    dlg.querySelectorAll("[data-multi]").forEach((el) => (el.onchange = () => {
      const id = el.dataset.multi, cur = new Set(draft[id] ?? []); el.checked ? cur.add(el.value) : cur.delete(el.value); draft[id] = [...cur]; redraw(id);
    }));
    dlg.querySelectorAll("[data-has]").forEach((el) => (el.onchange = () => {
      const cur = new Set(draft.has ?? []); el.checked ? cur.add(el.dataset.has) : cur.delete(el.dataset.has); draft.has = [...cur]; redraw("has");
    }));
    dlg.querySelectorAll("[data-tag]").forEach((el) => (el.onkeydown = (e) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      const id = el.dataset.tag, t = el.value.trim().replace(/^#/, "");
      if (t) { draft[id] = [...new Set([...(draft[id] ?? []), t])]; redraw(id); }
    }));
    dlg.querySelectorAll("[data-untag]").forEach((el) => (el.onclick = () => { const id = el.dataset.untag; draft[id] = (draft[id] ?? []).filter((x) => x !== el.dataset.t); redraw(id); }));
    // Pickers (lists from Influencers.club)
    const setPick = (id, fn) => {
      const f = FILTERS.find((x) => x.id === id);
      if (f.type === "aud") { const cur = draft[id]?.values ?? []; draft[id] = { min: draft[id]?.min ?? 20, values: fn(cur) }; }
      else draft[id] = fn(draft[id] ?? []);
      redraw(id);
    };
    dlg.querySelectorAll("[data-search]").forEach((el) => {
      const f = FILTERS.find((x) => x.id === el.dataset.search);
      el.oninput = () => fillList(f, el.value);
      el.onkeydown = (e) => {
        if (e.key !== "Enter") return;
        e.preventDefault();
        const first = dlg.querySelector(`[data-list="${f.id}"] [data-addpick]`);
        const v = first ? first.dataset.v : f.free ? el.value.trim() : "";
        if (v) setPick(f.id, (cur) => [...new Set([...cur, v])]);
      };
    });
    dlg.querySelectorAll("[data-list]").forEach((box) => (box.onclick = (e) => {
      const b = e.target.closest("[data-addpick]");
      if (b) setPick(b.dataset.addpick, (cur) => [...new Set([...cur, b.dataset.v])]);
    }));
    dlg.querySelectorAll("[data-unpick]").forEach((el) => (el.onclick = () => setPick(el.dataset.unpick, (cur) => cur.filter((x) => x !== el.dataset.v))));
    dlg.querySelectorAll("[data-agender]").forEach((el) => (el.onchange = () => { draft[el.dataset.agender] = { min: draft[el.dataset.agender]?.min ?? 50, value: el.value }; redraw(el.dataset.agender); }));
    dlg.querySelectorAll("[data-amulti]").forEach((el) => (el.onchange = () => {
      const id = el.dataset.amulti, cur = new Set(draft[id]?.values ?? []); el.checked ? cur.add(el.value) : cur.delete(el.value);
      draft[id] = { min: draft[id]?.min ?? 20, values: [...cur] }; redraw(id);
    }));
    numIn("[data-amin]", (el) => { const id = el.dataset.amin; draft[id] = { ...(draft[id] ?? {}), min: Math.max(1, Math.min(100, Number(el.value) || 20)) }; });
  };
  draw();
  dlg.showModal();
}
