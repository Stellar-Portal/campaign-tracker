// Creator roster: the creators Stellar works with, each with topline numbers from their recent
// TikTok videos (ScrapeCreators, refreshed weekly by the roster Edge Function) and, on request,
// audience insights and contact details (Influencers.club, 1 credit per creator, kept 60 days).
//
// Routes: #/roster · #/creator/<creator id>
import { esc, flag, regionName, ago, compact, big } from "./report.js?v=20261021e";
import { PLATFORMS, PLATFORM_ORDER, platformOf, detectPlatform } from "./platforms.js?v=20261021e";

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

export async function renderRoster(app, sb, ctx) {
  if (ctx.parts[0] === "creator" && ctx.parts[1]) return renderCreator(app, sb, ctx, ctx.parts[1]);
  return renderList(app, sb, ctx);
}

// ---------- roster list ----------
async function renderList(app, sb, { isCurrent, go, toast }) {
  app.innerHTML = `<p class="muted pad">Loading the roster…</p>`;
  const { data: creators, error } = await sb.from("creators")
    .select("id,username,display_name,avatar_url,follower_count,is_verified,country_code,platform,profile_stats,stats_checked_at,stats_error,roster_added_at")
    .eq("on_roster", true).order("roster_added_at", { ascending: false });
  if (!isCurrent()) return;
  if (error) { app.innerHTML = `<div class="panel"><p class="warn-note">${esc(error.message)}</p></div>`; return; }
  const ids = creators.map((c) => c.id);
  const [posts, insights] = await Promise.all([
    ids.length ? sb.from("posts").select("creator_id,campaign_id").in("creator_id", ids) : { data: [] },
    sb.from("creator_insights").select("handle,platform,fetched_at,error"),
  ]);
  if (!isCurrent()) return;
  const camps = {};
  for (const p of posts.data ?? []) (camps[p.creator_id] ??= new Set()).add(p.campaign_id);
  const unlocked = new Set((insights.data ?? []).filter((x) => !x.error).map((x) => `${x.platform}:${x.handle}`));
  for (const c of creators) { c.platform ??= "tiktok"; c._campaigns = camps[c.id]?.size ?? 0; c._insights = unlocked.has(`${c.platform}:${String(c.username).toLowerCase()}`); }
  const platformsUsed = PLATFORM_ORDER.filter((p) => creators.some((c) => c.platform === p));
  const countries = [...new Set(creators.map((c) => c.country_code).filter(Boolean))].sort((a, b) => regionName(a).localeCompare(regionName(b)));

  app.innerHTML = `
    <div class="page-head">
      <div><h1>Roster</h1>
        <p class="muted small" style="margin:6px 0 0">Creators Stellar works with on TikTok, Instagram, YouTube, X and Twitch. Numbers come from each creator's recent posts and refresh every week.</p></div>
      <a class="btn" href="#/discover">Find new creators</a>
    </div>
    <form class="ro-add" id="ro-add">
      <label class="ov-pill ro-pf"><span class="ro-pf-ico" id="ro-pf-ico">${PLATFORMS[st.addPlatform].icon}</span><select id="ro-platform" aria-label="Platform">${PLATFORM_ORDER.map((p) => `<option value="${p}"${p === st.addPlatform ? " selected" : ""}>${PLATFORMS[p].name}</option>`).join("")}</select></label>
      <input id="ro-input" type="text" autocomplete="off" placeholder="Paste a profile link, a video link or @handle" aria-label="Profile link, video link or handle">
      <button type="submit" class="primary">Add to roster</button>
      <span class="small muted ro-add-msg" id="ro-msg" role="status"></span>
    </form>
    ${creators.length ? `
    <div class="ov-bar">
      <label class="ov-search"><svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="8.5" cy="8.5" r="5.5"/><path d="m13 13 4 4"/></svg><input id="ro-q" type="search" placeholder="Search name or handle" aria-label="Search the roster"></label>
      ${platformsUsed.length > 1 ? `<select id="ro-pfilter" class="ov-pill" aria-label="Platform"><option value="">All platforms</option>${platformsUsed.map((p) => `<option value="${p}">${PLATFORMS[p].name}</option>`).join("")}</select>` : ""}
      <select id="ro-country" class="ov-pill" aria-label="Country"><option value="">All countries</option>${countries.map((x) => `<option value="${esc(x)}">${esc(regionName(x))}</option>`).join("")}</select>
      <label class="ov-pill ov-sort"><span>Sort</span><select id="ro-sort" aria-label="Sort by">${Object.entries(SORTS).map(([k, [l]]) => `<option value="${k}">${esc(l)}</option>`).join("")}</select></label>
    </div>
    <div id="ro-list"></div>` : `
    <section class="panel ro-empty">
      <h3>No creators on the roster yet</h3>
      <p class="muted">Paste a creator's profile link, any of their video links, or their @handle above (pick the platform for a bare handle). You can also add creators from a campaign (the ☆ next to a creator) or from <a href="#/discover">Discover</a>.</p>
    </section>`}`;

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
      if (!isCurrent()) return;
      toast(`Added @${r.username} to the roster`);
      go(`#/creator/${r.id}`);
    } catch (err) {
      btn.disabled = false; btn.textContent = "Add to roster";
      msg.innerHTML = `<span class="warn-note">${esc(err.message)}</span>`;
    }
  };
  if (!creators.length) return;

  const listEl = document.getElementById("ro-list");
  const draw = () => {
    const q = st.q.trim().toLowerCase().replace(/^@/, "");
    const [, key, dir] = SORTS[st.sort];
    const list = creators
      .filter((c) => (!st.platform || c.platform === st.platform) && (!st.country || c.country_code === st.country) && (!q || `${c.username} ${c.display_name ?? ""}`.toLowerCase().includes(q)))
      .sort((a, b) => { const x = key(a), y = key(b); return (x < y ? -1 : x > y ? 1 : 0) * dir; });
    listEl.innerHTML = !list.length ? `<div class="panel"><p class="muted">No creators match.</p></div>` : `
      <div class="table-wrap ro-table"><table>
        <thead><tr><th>Creator</th><th>Country</th><th class="num">Followers</th><th class="num">Median views</th><th class="num">Engagement</th><th class="num">Posts / week</th><th class="num">Campaigns</th><th>Insights</th></tr></thead>
        <tbody>${list.map((c) => { const s = c.profile_stats ?? {}; return `
          <tr class="ro-row" data-id="${esc(c.id)}" tabindex="0">
            <td><div class="ro-who">${avatar(c)}<div class="ro-names"><b>${esc(c.display_name || c.username)}${c.is_verified ? ' <span class="tick" title="Verified">✓</span>' : ""}</b><span class="muted small ro-handle"><span class="ro-pfmini" title="${esc(platformOf(c.platform).name)}">${platformOf(c.platform).icon}</span>@${esc(c.username)}</span></div></div></td>
            <td class="small">${place(c.country_code)}</td>
            <td class="num" title="${c.follower_count ?? ""}">${big(c.follower_count)}</td>
            <td class="num">${big(s.median_views)}</td>
            <td class="num">${eng(s.engagement)}</td>
            <td class="num">${perWeek(s.posts_per_week)}</td>
            <td class="num">${c._campaigns || "–"}</td>
            <td>${c._insights ? `<span class="status active">Unlocked</span>` : `<span class="muted small">–</span>`}</td>
          </tr>`; }).join("")}</tbody></table></div>
      <p class="muted small" style="margin-top:10px">${list.length} of ${creators.length} creators. Click a creator for their page, recent videos and audience.</p>`;
    listEl.querySelectorAll(".ro-row").forEach((tr) => {
      tr.onclick = () => go(`#/creator/${tr.dataset.id}`);
      tr.onkeydown = (e) => { if (e.key === "Enter") go(`#/creator/${tr.dataset.id}`); };
    });
  };
  const bind = (id, k) => { const el = document.getElementById(id); el.value = st[k]; el.oninput = () => { st[k] = el.value; draw(); }; };
  bind("ro-q", "q"); bind("ro-country", "country"); bind("ro-sort", "sort");
  if (document.getElementById("ro-pfilter")) bind("ro-pfilter", "platform");
  draw();
}

// ---------- one creator ----------
async function renderCreator(app, sb, { isCurrent, go, toast }, id) {
  app.innerHTML = `<p class="muted pad">Loading the creator…</p>`;
  const { data: c, error } = await sb.from("creators").select("*").eq("id", id).maybeSingle();
  if (!isCurrent()) return;
  if (error || !c) { app.innerHTML = `<div class="panel"><p>This creator doesn't exist.</p><p><a href="#/roster">Back to the roster</a></p></div>`; return; }
  const [postsRes, insRes] = await Promise.all([
    sb.from("posts").select("campaign_id,tiktok_video_id,published_at,campaign:campaigns(id,artist,song,status)").eq("creator_id", id),
    sb.from("creator_insights").select("*").eq("platform", c.platform ?? "tiktok").eq("handle", String(c.username).toLowerCase()).maybeSingle(),
  ]);
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
        <a href="#/roster" class="back">Roster</a>
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
  document.getElementById("cr-refresh").onclick = (e) => run(e.currentTarget, "Refreshing…", async () => {
    await invoke(sb, "roster", { action: "refresh", creator_id: id });
    toast("Numbers updated"); renderCreator(app, sb, { isCurrent, go, toast }, id);
  });
  document.getElementById("cr-add")?.addEventListener("click", (e) => run(e.currentTarget, "Adding…", async () => {
    await invoke(sb, "roster", { action: "add", input: `@${c.username}`, platform: c.platform ?? "tiktok" });
    toast("Added to the roster"); renderCreator(app, sb, { isCurrent, go, toast }, id);
  }));
  document.getElementById("cr-remove")?.addEventListener("click", (e) => run(e.currentTarget, "Removing…", async () => {
    const { error: err } = await sb.from("creators").update({ on_roster: false }).eq("id", id);
    if (err) throw err;
    toast("Removed from the roster. Their campaign posts stay."); go("#/roster");
  }));
  const notes = document.getElementById("cr-notes"), notesMsg = document.getElementById("cr-notes-msg");
  let t;
  notes.oninput = () => {
    clearTimeout(t); notesMsg.textContent = "Saving…";
    t = setTimeout(async () => {
      const { error: err } = await sb.from("creators").update({ roster_notes: notes.value || null }).eq("id", id);
      notesMsg.textContent = err ? `Couldn't save: ${err.message}` : "Saved. Visible to the team only.";
    }, 700);
  };
  bindInsights(app, sb, { isCurrent, go, toast }, c, id);
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
  document.getElementById("cr-unlock")?.addEventListener("click", unlock(false));
  document.getElementById("cr-reunlock")?.addEventListener("click", (e) => {
    if (confirm("Get fresh insights from Influencers.club? This uses 1 credit.")) unlock(true)(e);
  });
  const box = app.querySelector(".ic-growth");
  if (box) {
    const followers = Number(box.dataset.followers), growth = JSON.parse(box.dataset.growth);
    const plot = box.querySelector(".ic-growth-plot");
    const draw = (m) => { plot.innerHTML = growthSvg(followers, growth, m, plot.clientWidth || 1000); box.querySelectorAll("[data-m]").forEach((b) => b.classList.toggle("on", Number(b.dataset.m) === m)); };
    box.querySelectorAll("[data-m]").forEach((b) => (b.onclick = () => draw(Number(b.dataset.m))));
    draw(12);
  }
  app.querySelectorAll("[data-jump]").forEach((a) => (a.onclick = (e) => { e.preventDefault(); document.getElementById(a.dataset.jump)?.scrollIntoView({ behavior: "smooth", block: "start" }); }));
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
