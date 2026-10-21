// Creator roster: the creators Stellar works with, each with topline numbers from their recent
// TikTok videos (ScrapeCreators, refreshed weekly by the roster Edge Function) and, on request,
// audience insights and contact details (Influencers.club, 1 credit per creator, kept 60 days).
//
// Routes: #/roster · #/creator/<creator id>
import { esc, flag, regionName, ago, compact, big, pct } from "./report.js?v=20261021a";

const SORTS = {
  added: ["Recently added", (c) => c.roster_added_at ?? "", -1],
  followers: ["Most followers", (c) => c.follower_count ?? -1, -1],
  views: ["Highest median views", (c) => c.profile_stats?.median_views ?? -1, -1],
  engagement: ["Highest engagement", (c) => c.profile_stats?.engagement ?? -1, -1],
  campaigns: ["Most campaigns with us", (c) => c._campaigns ?? 0, -1],
  name: ["Name A–Z", (c) => (c.display_name || c.username || "").toLowerCase(), 1],
};
const st = { q: "", country: "", sort: "added" };   // kept while moving between pages

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
    .select("id,username,display_name,avatar_url,follower_count,is_verified,country_code,profile_stats,stats_checked_at,stats_error,roster_added_at")
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
  const unlocked = new Set((insights.data ?? []).filter((x) => !x.error && x.platform === "tiktok").map((x) => x.handle));
  for (const c of creators) { c._campaigns = camps[c.id]?.size ?? 0; c._insights = unlocked.has(c.username); }
  const countries = [...new Set(creators.map((c) => c.country_code).filter(Boolean))].sort((a, b) => regionName(a).localeCompare(regionName(b)));

  app.innerHTML = `
    <div class="page-head">
      <div><h1>Roster</h1>
        <p class="muted small" style="margin:6px 0 0">Creators Stellar works with. Numbers come from each creator's last 20 TikTok videos and refresh every week.</p></div>
    </div>
    <form class="ro-add" id="ro-add">
      <input id="ro-input" type="text" autocomplete="off" placeholder="Paste a TikTok profile link, a video link or @handle" aria-label="TikTok profile link, video link or handle">
      <button type="submit" class="primary">Add to roster</button>
      <span class="small muted ro-add-msg" id="ro-msg" role="status"></span>
    </form>
    ${creators.length ? `
    <div class="ov-bar">
      <label class="ov-search"><svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="8.5" cy="8.5" r="5.5"/><path d="m13 13 4 4"/></svg><input id="ro-q" type="search" placeholder="Search name or handle" aria-label="Search the roster"></label>
      <select id="ro-country" class="ov-pill" aria-label="Country"><option value="">All countries</option>${countries.map((x) => `<option value="${esc(x)}">${esc(regionName(x))}</option>`).join("")}</select>
      <label class="ov-pill ov-sort"><span>Sort</span><select id="ro-sort" aria-label="Sort by">${Object.entries(SORTS).map(([k, [l]]) => `<option value="${k}">${esc(l)}</option>`).join("")}</select></label>
    </div>
    <div id="ro-list"></div>` : `
    <section class="panel ro-empty">
      <h3>No creators on the roster yet</h3>
      <p class="muted">Paste a creator's TikTok profile link, any of their video links, or their @handle above. You can also add creators straight from a campaign: open a campaign and use the ☆ next to a creator.</p>
    </section>`}`;

  const form = document.getElementById("ro-add"), msg = document.getElementById("ro-msg");
  form.onsubmit = async (e) => {
    e.preventDefault();
    const input = document.getElementById("ro-input").value.trim();
    if (!input) return;
    const btn = form.querySelector("button"); btn.disabled = true; btn.textContent = "Adding…";
    msg.textContent = "Reading their profile and recent videos. This takes about 20 seconds.";
    try {
      const r = await invoke(sb, "roster", { action: "add", input });
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
      .filter((c) => (!st.country || c.country_code === st.country) && (!q || `${c.username} ${c.display_name ?? ""}`.toLowerCase().includes(q)))
      .sort((a, b) => { const x = key(a), y = key(b); return (x < y ? -1 : x > y ? 1 : 0) * dir; });
    listEl.innerHTML = !list.length ? `<div class="panel"><p class="muted">No creators match.</p></div>` : `
      <div class="table-wrap ro-table"><table>
        <thead><tr><th>Creator</th><th>Country</th><th class="num">Followers</th><th class="num">Median views</th><th class="num">Engagement</th><th class="num">Posts / week</th><th class="num">Campaigns</th><th>Insights</th></tr></thead>
        <tbody>${list.map((c) => { const s = c.profile_stats ?? {}; return `
          <tr class="ro-row" data-id="${esc(c.id)}" tabindex="0">
            <td><div class="ro-who">${avatar(c)}<div class="ro-names"><b>${esc(c.display_name || c.username)}${c.is_verified ? ' <span class="tick" title="Verified">✓</span>' : ""}</b><span class="muted small">@${esc(c.username)}</span></div></div></td>
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
    sb.from("creator_insights").select("*").eq("platform", c.platform ?? "tiktok").eq("handle", c.username).maybeSingle(),
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
  const tiktokUrl = `https://www.tiktok.com/@${encodeURIComponent(c.username)}`;

  app.innerHTML = `
    <section class="band sh-band art-band${c.avatar_url ? " has-img" : ""}"${c.avatar_url ? ` style="--art:url('${esc(c.avatar_url)}')"` : ""}>
      <div class="art-bg" aria-hidden="true"></div>
      <div class="art-inner">
        <a href="#/roster" class="back">Roster</a>
        <div class="hero"><div class="art-id">
          <div class="art-avatar">${c.avatar_url ? `<img src="${esc(c.avatar_url)}" alt="" referrerpolicy="no-referrer">` : `<span>${esc((c.display_name || c.username || "?").charAt(0).toUpperCase())}</span>`}</div>
          <div class="art-text">
            <h1>${esc(c.display_name || c.username)}</h1>
            <div class="voice"><a href="${esc(tiktokUrl)}" target="_blank" rel="noopener">@${esc(c.username)}</a></div>
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
          <a class="btn" href="${esc(tiktokUrl)}" target="_blank" rel="noopener">Open on TikTok</a>
          ${c.on_roster ? `<button type="button" id="cr-remove" class="danger-lite">Remove from roster</button>` : ""}
        </div>
      </div>
    </section>
    ${c.stats_error ? `<p class="warn-note small" style="margin-top:12px">Last refresh: ${esc(c.stats_error)}</p>` : ""}
    <div class="stats ro-stats">
      ${tile("Followers", big(c.follower_count ?? s.followers), c.follower_count)}
      ${tile("Median views", big(s.median_views), s.median_views, s.avg_views != null ? `avg ${big(s.avg_views)}` : "")}
      ${tile("Engagement rate", eng(s.engagement), null, "interactions per view")}
      ${tile("Median likes", big(s.median_likes), s.median_likes)}
      ${tile("Median shares", big(s.median_shares), s.median_shares, s.median_comments != null ? `${big(s.median_comments)} comments` : "")}
      ${tile("Posts per week", perWeek(s.posts_per_week), null, s.last_post ? `last ${ago(s.last_post)}` : "")}
    </div>
    <p class="muted small ro-basis">${s.sample ? `Based on their ${s.sample} most recent videos (pinned videos left out).` : "No recent videos found yet."}</p>

    <section class="panel ro-insights" id="cr-insights">${insightsHtml(ins, c)}</section>

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

    <h3 class="ro-h3">Recent videos</h3>
    ${rv.length ? `<div class="wall sh-wall ro-wall">${rv.map((v) => `
      <article class="post"><div class="cover-wrap">
        <a class="cover" href="${esc(v.url)}" target="_blank" rel="noopener" title="${esc(`${big(v.views)} views · ${big(v.likes)} likes · ${big(v.comments)} comments · ${big(v.shares)} shares`)}">
          ${covers[v.cover_path] ? `<img src="${esc(covers[v.cover_path])}" alt="" loading="lazy">` : ""}
          ${v.posted ? `<span class="chip tr">${esc(ago(v.posted))}</span>` : ""}
          <span class="cap"><span class="plays">${compact(v.views)}</span></span>
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
    await invoke(sb, "roster", { action: "add", input: `@${c.username}` });
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
function insightsHtml(ins, c) {
  if (!ins) return `
    <div class="ro-ins-empty">
      <div><h3 style="margin:0 0 4px">Audience insights</h3>
        <p class="muted small" style="margin:0">Where their followers are, gender and age, languages, notable followers, and a contact email when one is public. From Influencers.club; uses 1 credit, then kept for 60 days.</p></div>
      <button type="button" class="primary" id="cr-unlock">Unlock insights</button>
    </div>`;
  const r = ins.data?.result ?? {};
  const p = r[c.platform ?? "tiktok"] ?? {};
  const a = p?.audience?.audience_followers?.data ?? {};
  const countries = a.audience_geo?.countries ?? [];
  const genders = a.audience_genders ?? [];
  const ages = (a.audience_ages ?? []).filter((x) => x.code !== "65-" || x.weight > 0);
  const langs = a.audience_languages ?? [];
  const notable = (a.notable_users ?? []).slice(0, 6);
  const male = genders.find((g) => g.code === "MALE")?.weight, female = genders.find((g) => g.code === "FEMALE")?.weight;
  const email = r.email && r.email_status !== "invalid" ? r.email : null;
  return `
    <div class="ro-ins-head"><h3 style="margin:0">Audience insights</h3>
      <span class="muted small">From Influencers.club, ${esc(ago(ins.fetched_at))}. Followers' audience, not viewers.</span></div>
    <div class="ro-ins-grid">
      <div><h4>Top countries</h4>${countries.length ? bars(countries, { label: (x) => `${flag(x.code)} ${esc(x.name)}` }) : `<p class="muted small">Too few followers to estimate.</p>`}</div>
      <div><h4>Gender</h4>${male != null ? `<div class="ro-split"><i style="flex:${female ?? 0}"></i><i style="flex:${male ?? 0}"></i></div>
        <div class="ro-split-l"><span><b>${pctW(female)}</b> female</span><span><b>${pctW(male)}</b> male</span></div>` : `<p class="muted small">Not available.</p>`}
        <h4 style="margin-top:18px">Age</h4>${ages.length ? bars(ages, { max: 6, label: (x) => esc(x.code === "65-" ? "65+" : x.code) }) : `<p class="muted small">Not available.</p>`}</div>
      <div><h4>Languages</h4>${langs.length ? bars(langs, { max: 4, label: (x) => esc(x.name ?? x.code) }) : `<p class="muted small">Not available.</p>`}
        <h4 style="margin-top:18px">Contact</h4>
        <p class="small" style="margin:0">${email ? `<a href="mailto:${esc(email)}">${esc(email)}</a> <span class="muted">${esc(r.email_status === "valid" ? "verified" : r.email_status ?? "")}</span>` : `<span class="muted">No public email found.</span>`}</p></div>
    </div>
    ${notable.length ? `<h4 style="margin:18px 0 8px">Notable followers</h4><div class="ro-notable">${notable.map((n) => `<a href="https://www.tiktok.com/@${encodeURIComponent(n.username)}" target="_blank" rel="noopener" class="ro-chip">@${esc(n.username)} <span class="muted">${big(n.followers)}</span></a>`).join("")}</div>` : ""}`;
}
function bindInsights(app, sb, ctx, c, id) {
  document.getElementById("cr-unlock")?.addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true; btn.textContent = "Unlocking…";
    try {
      await invoke(sb, "creator-insights", { handle: c.username, platform: c.platform ?? "tiktok" });
      if (!ctx.isCurrent()) return;
      ctx.toast("Insights unlocked");
      renderCreator(app, sb, ctx, id);
    } catch (err) { ctx.toast(err.message); btn.disabled = false; btn.textContent = "Unlock insights"; }
  });
}
