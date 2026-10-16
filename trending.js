// Trending: songs and artists breaking out per country, from Chartmetric charts
// (Spotify daily, Shazam, TikTok weekly breakout and popular), collected each morning by the
// chartmetric-sync Edge Function and scored in the database (trend_compute_scores).
//
// Routes: #/trending (tracks) · #/trending/artists · #/trending/artist/<chartmetric artist id>
import { esc, flag, ago, compact } from "./report.js?v=20261016k";

const REGIONS = ["Asia", "LATAM", "US"];
const PLATFORM = { spotify: "Spotify", shazam: "Shazam", tiktok: "TikTok", applemusic: "Apple Music", youtube: "YouTube" };
const SOURCE_PLATFORM = { spotify: "spotify", shazam: "shazam", tiktok_breakout: "tiktok", tiktok_popular: "tiktok", applemusic: "applemusic", youtube: "youtube" };
const ONE = "#0626c7";
const st = { region: "", country: "", breakoutOnly: false, q: "" }; // kept while moving between tabs

async function fetchAll(build, pageSize = 1000) {
  const out = [];
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await build().range(from, from + pageSize - 1);
    if (error) throw error;
    out.push(...data);
    if (data.length < pageSize) return out;
  }
}
const day = (iso) => (iso ? new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short" }) : "");
const thumb = (url, alt = "") => url
  ? `<img class="tr-thumb" src="${esc(url)}" alt="${esc(alt)}" loading="lazy" referrerpolicy="no-referrer" onerror="this.replaceWith(Object.assign(document.createElement('span'),{className:'tr-thumb'}))">`
  : `<span class="tr-thumb" aria-hidden="true"></span>`;

// What one platform says about a track, e.g. "Shazam #4 · new" or "Spotify #37 ↑52".
function platformLine(detail) {
  const by = {};
  for (const [src, d] of Object.entries(detail ?? {})) {
    const p = SOURCE_PLATFORM[src] ?? src;
    const label = src === "tiktok_breakout" ? "TikTok breakout" : PLATFORM[p] ?? p;
    const move = d.pre_rank == null ? "new" : d.change > 0 ? `↑${d.change}` : d.change < 0 ? `↓${-d.change}` : "=";
    const rising = src === "tiktok_breakout" || d.pre_rank == null || d.change > 0;
    (by[p] ??= []).push({ label, rank: d.rank, move, rising, breakout: src === "tiktok_breakout" });
  }
  return Object.values(by).flat()
    .sort((a, b) => Number(b.breakout) - Number(a.breakout))
    .map((x) => `<span class="tr-plat${x.rising ? " up" : ""}" title="${esc(x.label)}: number ${x.rank}${x.move === "new" ? ", new on the chart" : x.move === "=" ? ", no change" : `, ${x.move.startsWith("↑") ? "up" : "down"} ${x.move.slice(1)} places`}">${esc(x.label)} <b>#${x.rank}</b> <i>${esc(x.move)}</i></span>`).join("");
}

export async function renderTrending(app, sb, { isCurrent, go, parts, toast }) {
  const tab = parts[1] === "artists" ? "artists" : parts[1] === "artist" && parts[2] ? "artist" : "tracks";
  app.innerHTML = `<p class="muted pad">Loading trending…</p>`;

  const [countriesRes, runRes] = await Promise.all([
    sb.from("trend_countries").select("code,name,region,enabled,position").order("position"),
    sb.from("trend_runs").select("finished_at,note,errors").not("finished_at", "is", null).order("finished_at", { ascending: false }).limit(1),
  ]);
  if (!isCurrent()) return;
  if (countriesRes.error) { app.innerHTML = `<p class="error">${esc(countriesRes.error.message)}</p>`; return; }
  const countries = countriesRes.data.filter((c) => c.enabled);
  const cName = Object.fromEntries(countriesRes.data.map((c) => [c.code, c.name]));
  const cRegion = Object.fromEntries(countriesRes.data.map((c) => [c.code, c.region]));
  const lastRun = runRes.data?.[0];

  // Latest scores per country (countries' charts can be a day apart), from the last 4 days.
  const { data: maxRow } = await sb.from("trend_scores").select("score_date").gte("score_date", "2000-01-01").order("score_date", { ascending: false }).limit(1);
  if (!isCurrent()) return;
  const latestDate = maxRow?.[0]?.score_date ?? null;
  let scores = [];
  if (latestDate) {
    const from = new Date(Date.parse(`${latestDate}T00:00:00Z`) - 3 * 864e5).toISOString().slice(0, 10);
    const all = await fetchAll(() => sb.from("trend_scores")
      .select("score_date,country,track_key,title,artist_names,cm_artist_ids,image_url,score,platforms,rising,breakout,detail")
      .gte("score_date", from).order("score_date", { ascending: false }).order("country").order("score", { ascending: false }));
    if (!isCurrent()) return;
    const newest = {};
    for (const r of all) newest[r.country] ??= r.score_date;
    scores = all.filter((r) => r.score_date === newest[r.country]);
  }

  const head = `
    <div class="page-head">
      <div><h1>Trending</h1>
        <p class="muted small" style="margin:6px 0 0">Songs breaking out by country, scored across Spotify, Shazam and TikTok · data from Chartmetric${latestDate ? ` · charts up to ${esc(day(latestDate))}` : ""}${lastRun ? ` · collected ${esc(ago(lastRun.finished_at).toLowerCase())}` : ""}</p></div>
      <div class="actions" style="margin:0"><button type="button" id="tr-collect">Collect now</button></div>
    </div>`;

  if (!latestDate) {
    app.innerHTML = `${head}
      <div class="panel soon-panel">
        <h2>No chart data yet</h2>
        <p>Charts are collected every morning for ${countries.length} countries across Asia, LATAM and the US. The first collection starts once the Chartmetric key is saved in Supabase (Edge Functions → Secrets → <code>CHARTMETRIC_REFRESH_TOKEN</code>).</p>
        ${lastRun?.errors?.length ? `<p class="error small">Last attempt: ${esc(lastRun.errors[0])}</p>` : ""}
      </div>`;
    bindCollect();
    return;
  }

  const regionOf = (code) => cRegion[code] ?? "Other";
  const inFilter = (code) => code !== "GLOBAL" && (!st.region || regionOf(code) === st.region) && (!st.country || code === st.country);
  const countryOptions = () => countries.filter((c) => c.code !== "GLOBAL" && (!st.region || c.region === st.region));

  const controls = (showBreakout = true) => `
    <div class="filters tr-filters">
      <div class="tabs" role="tablist" aria-label="View">
        <button role="tab" type="button" data-tab="tracks" aria-selected="${tab === "tracks"}">Tracks</button>
        <button role="tab" type="button" data-tab="artists" aria-selected="${tab === "artists"}">Artists</button>
      </div>
      <div class="seg" role="group" aria-label="Region">
        ${["", ...REGIONS].map((r) => `<button type="button" data-region="${r}" aria-pressed="${st.region === r}">${r || "All regions"}</button>`).join("")}
      </div>
      <select id="tr-country" aria-label="Country">
        <option value="">All countries</option>
        ${countryOptions().map((c) => `<option value="${c.code}"${st.country === c.code ? " selected" : ""}>${flag(c.code)} ${esc(c.name)}</option>`).join("")}
      </select>
      ${showBreakout ? `<button type="button" class="chip-toggle" id="tr-breakout" aria-pressed="${st.breakoutOnly}">Breakouts only</button>` : ""}
      <input type="search" id="tr-q" placeholder="Search song or artist" value="${esc(st.q)}" aria-label="Search">
    </div>`;

  function bindCollect() {
    const b = document.getElementById("tr-collect");
    if (!b) return;
    b.onclick = async () => {
      b.disabled = true; b.textContent = "Collecting…";
      const { data, error } = await sb.functions.invoke("chartmetric-sync", { body: { force: true } });
      b.disabled = false; b.textContent = "Collect now";
      const msg = error ? (await error.context?.json?.().catch(() => null))?.error ?? error.message : data?.error;
      if (msg) { toast(msg); return; }
      toast(data.charts_left ? `Collected ${data.charts_fetched} charts, ${data.charts_left} still to go — the morning run finishes the rest` : `Collected ${data.charts_fetched} charts`);
      if (isCurrent()) renderTrending(app, sb, { isCurrent, go, parts, toast });
    };
  }
  function bindControls(redraw) {
    app.querySelectorAll("[data-tab]").forEach((b) => (b.onclick = () => go(b.dataset.tab === "tracks" ? "#/trending" : "#/trending/artists")));
    app.querySelectorAll("[data-region]").forEach((b) => (b.onclick = () => { st.region = b.dataset.region; st.country = ""; redraw(true); }));
    const sel = document.getElementById("tr-country");
    if (sel) sel.onchange = () => { st.country = sel.value; redraw(); };
    const bo = document.getElementById("tr-breakout");
    if (bo) bo.onclick = () => { st.breakoutOnly = !st.breakoutOnly; redraw(true); };
    const q = document.getElementById("tr-q");
    if (q) q.oninput = () => { st.q = q.value; redraw(false, true); };
    bindCollect();
  }
  const match = (title, names) => !st.q || `${title} ${(names ?? []).join(" ")}`.toLowerCase().includes(st.q.trim().toLowerCase());
  const artistLinks = (names, ids) => (names ?? []).map((n, i) => ids?.[i] ? `<a href="#/trending/artist/${ids[i]}" data-stop>${esc(n)}</a>` : esc(n)).join(", ");

  // ---------- tracks ----------
  if (tab === "tracks") {
    const draw = (rebuild = true, keepFocus = false) => {
      const rows = scores.filter((r) => inFilter(r.country) && (!st.breakoutOnly || r.breakout) && match(r.title, r.artist_names));
      let list;
      if (st.country) {
        list = rows.map((r) => ({ ...r, where: [r.country] })).sort((a, b) => b.score - a.score);
      } else {
        // One row per song: its best country, plus everywhere else it's trending.
        const by = new Map();
        for (const r of rows) {
          const t = by.get(r.track_key);
          if (!t) by.set(r.track_key, { ...r, where: [r.country], scores: { [r.country]: r.score } });
          else {
            t.where.push(r.country); t.scores[r.country] = r.score; t.breakout ||= r.breakout;
            if (r.score > t.score) Object.assign(t, { score: r.score, country: r.country, detail: r.detail, rising: r.rising, platforms: r.platforms });
            if (!t.image_url && r.image_url) t.image_url = r.image_url;
            if ((!t.cm_artist_ids?.length) && r.cm_artist_ids?.length) Object.assign(t, { cm_artist_ids: r.cm_artist_ids, artist_names: r.artist_names });
          }
        }
        // Spreading across countries counts: best score + 15% of the rest.
        list = [...by.values()].map((t) => {
          const others = t.where.filter((c) => c !== t.country).reduce((s, c) => s + Number(t.scores[c]), 0);
          return { ...t, rankScore: Number(t.score) + 0.15 * others, where: t.where.sort((a, b) => t.scores[b] - t.scores[a]) };
        }).sort((a, b) => b.rankScore - a.rankScore);
      }
      const shown = list.slice(0, 150);
      const breakouts = list.filter((t) => t.breakout).length;
      const html = `
        <div class="stats tr-stats">
          <div class="stat"><div class="n">${compact(list.length)}</div><div class="l">Songs on the charts</div></div>
          <div class="stat"><div class="n">${compact(breakouts)}</div><div class="l">Breakouts</div></div>
          <div class="stat"><div class="n">${compact(new Set(rows.map((r) => r.country)).size)}</div><div class="l">Countries</div></div>
        </div>
        ${!shown.length ? `<div class="panel"><p class="muted" style="margin:0">Nothing matches this selection.</p></div>` : `
        <div class="table-wrap"><table class="tr-table">
          <thead><tr><th class="num">#</th><th>Song</th><th class="num" title="${st.country ? "Higher = breaking out faster. New entries, places climbed and rising on several platforms at once all add up." : "Best country's score, plus 15% of its score in every other country it's trending in."}">Score</th><th>Where it's moving</th><th>${st.country ? "Country" : "Trending in"}</th></tr></thead>
          <tbody>${shown.map((t, i) => `
            <tr${t.cm_artist_ids?.[0] ? ` data-artist="${t.cm_artist_ids[0]}"` : ""}>
              <td class="num muted">${i + 1}</td>
              <td><div class="tr-song">${thumb(t.image_url)}<div><div class="artist">${esc(t.title)}${t.breakout ? ' <span class="badge on">Breakout</span>' : ""}</div><div class="muted small">${artistLinks(t.artist_names, t.cm_artist_ids)}</div></div></div></td>
              <td class="num"><b>${Math.round(t.rankScore ?? t.score)}</b></td>
              <td><div class="tr-plats">${platformLine(t.detail)}</div></td>
              <td class="tr-where">${t.where.slice(0, 6).map((c) => `<span title="${esc(cName[c] ?? c)}${t.scores ? `: ${Math.round(t.scores[c])}` : ""}">${flag(c)} ${esc(c)}</span>`).join(" ")}${t.where.length > 6 ? ` <span class="muted">+${t.where.length - 6}</span>` : ""}</td>
            </tr>`).join("")}</tbody></table></div>
        ${list.length > shown.length ? `<p class="muted small">Showing the top ${shown.length} of ${list.length}. Pick a country or search to narrow it down.</p>` : ""}`}
        <p class="muted small tr-note">How the score works: a new entry or a climb on Spotify (streams) or Shazam (people looking a song up) earns up to 40 points each; the weekly TikTok breakout chart earns 30–40; rising on two platforms at once adds 20, on three adds 35. "Breakout" means it's rising on at least two platforms. TikTok charts are weekly; Spotify and Shazam daily.</p>`;
      if (rebuild) {
        app.innerHTML = head + controls() + `<div id="tr-out"></div>`;
        bindControls(draw);
        if (keepFocus) document.getElementById("tr-q")?.focus();
      }
      document.getElementById("tr-out").innerHTML = html;
      document.querySelectorAll("#tr-out tr[data-artist]").forEach((tr) => (tr.onclick = (e) => { if (!e.target.closest("[data-stop]")) go(`#/trending/artist/${tr.dataset.artist}`); }));
    };
    draw();
    return;
  }

  // ---------- artists ----------
  if (tab === "artists") {
    const draw = (rebuild = true, keepFocus = false) => {
      const by = new Map();
      for (const r of scores) {
        if (!inFilter(r.country) || (st.breakoutOnly && !r.breakout)) continue;
        (r.cm_artist_ids ?? []).forEach((id, i) => {
          const name = r.artist_names?.[i] ?? "";
          if (!id || !match("", [name])) return;
          let a = by.get(id);
          if (!a) by.set(id, (a = { id, name, momentum: 0, tracks: new Map(), countries: new Map(), breakout: false, image: null }));
          a.momentum += Number(r.score);
          const t = a.tracks.get(r.track_key);
          if (!t || r.score > t.score) a.tracks.set(r.track_key, { title: r.title, score: Number(r.score) });
          a.countries.set(r.country, (a.countries.get(r.country) ?? 0) + Number(r.score));
          a.breakout ||= r.breakout;
        });
      }
      const list = [...by.values()].sort((a, b) => b.momentum - a.momentum);
      const shown = list.slice(0, 150);
      const html = !shown.length ? `<div class="panel"><p class="muted" style="margin:0">Nothing matches this selection.</p></div>` : `
        <div class="table-wrap"><table class="tr-table">
          <thead><tr><th class="num">#</th><th>Artist</th><th class="num" title="The scores of all their charting songs added up, across the selected countries.">Momentum</th><th>Top songs</th><th>Trending in</th></tr></thead>
          <tbody>${shown.map((a, i) => {
            const tracks = [...a.tracks.values()].sort((x, y) => y.score - x.score);
            const where = [...a.countries.entries()].sort((x, y) => y[1] - x[1]).map(([c]) => c);
            return `<tr data-artist="${a.id}">
              <td class="num muted">${i + 1}</td>
              <td><span class="artist">${esc(a.name)}</span>${a.breakout ? ' <span class="badge on">Breakout</span>' : ""}</td>
              <td class="num"><b>${compact(Math.round(a.momentum))}</b></td>
              <td class="small">${tracks.slice(0, 2).map((t) => esc(t.title)).join(", ")}${tracks.length > 2 ? ` <span class="muted">+${tracks.length - 2}</span>` : ""}</td>
              <td class="tr-where">${where.slice(0, 6).map((c) => `<span title="${esc(cName[c] ?? c)}">${flag(c)} ${esc(c)}</span>`).join(" ")}${where.length > 6 ? ` <span class="muted">+${where.length - 6}</span>` : ""}</td>
            </tr>`;
          }).join("")}</tbody></table></div>
        ${list.length > shown.length ? `<p class="muted small">Showing the top ${shown.length} of ${list.length}.</p>` : ""}`;
      if (rebuild) {
        app.innerHTML = head + controls() + `<div id="tr-out"></div>`;
        bindControls(draw);
        if (keepFocus) document.getElementById("tr-q")?.focus();
      }
      document.getElementById("tr-out").innerHTML = html;
      document.querySelectorAll("#tr-out tr[data-artist]").forEach((tr) => (tr.onclick = () => go(`#/trending/artist/${tr.dataset.artist}`)));
    };
    draw();
    return;
  }

  // ---------- one artist ----------
  const id = Number(parts[2]);
  const mine = scores.filter((r) => (r.cm_artist_ids ?? []).map(Number).includes(id));
  const name = mine.map((r) => r.artist_names?.[(r.cm_artist_ids ?? []).map(Number).indexOf(id)]).find(Boolean) ?? "Artist";
  const byCountry = new Map();
  for (const r of mine) byCountry.set(r.country, (byCountry.get(r.country) ?? 0) + Number(r.score));
  const countriesSorted = [...byCountry.entries()].filter(([c]) => c !== "GLOBAL").sort((a, b) => b[1] - a[1]);
  const tracks = new Map();
  for (const r of mine) {
    const t = tracks.get(r.track_key);
    if (!t) tracks.set(r.track_key, { ...r, where: [r.country] });
    else { t.where.push(r.country); if (r.score > t.score) Object.assign(t, { score: r.score, detail: r.detail, country: r.country }); t.breakout ||= r.breakout; }
  }
  const trackList = [...tracks.values()].sort((a, b) => b.score - a.score);

  app.innerHTML = `
    <p class="back"><a href="#/trending/artists">← Trending artists</a></p>
    <div class="page-head">
      <div><h1>${esc(name)}</h1>
        <p class="muted small" style="margin:6px 0 0">${trackList.length ? `${trackList.length} song${trackList.length === 1 ? "" : "s"} on the charts in ${countriesSorted.length} countr${countriesSorted.length === 1 ? "y" : "ies"}` : "Not on the followed charts right now"}</p></div>
    </div>
    <div class="tr-artist-grid">
      <section class="panel">
        <h2>Where they're trending</h2>
        ${countriesSorted.length ? `<div class="hbars">${countriesSorted.slice(0, 12).map(([c, v]) => {
          const max = countriesSorted[0][1] || 1;
          return `<div class="hb-row"><span class="hb-label">${flag(c)} ${esc(cName[c] ?? c)}</span><span class="hb-track"><i style="width:${Math.max(0.6, (v / max) * 100)}%;background:${ONE}"></i></span><span class="hb-val">${Math.round(v)}</span></div>`;
        }).join("")}</div>` : `<p class="muted small">No chart positions in the followed countries.</p>`}
      </section>
      <section class="panel">
        <h2>Songs</h2>
        ${trackList.length ? `<ul class="tr-songlist">${trackList.map((t) => `
          <li><div class="tr-song">${thumb(t.image_url)}<div><div class="artist">${esc(t.title)}${t.breakout ? ' <span class="badge on">Breakout</span>' : ""}</div>
            <div class="tr-plats">${platformLine(t.detail)}</div>
            <div class="muted small">${t.where.map((c) => `${flag(c)} ${esc(c)}`).join("  ")}</div></div></div></li>`).join("")}</ul>` : `<p class="muted small">None right now.</p>`}
      </section>
    </div>
    <section class="panel" style="margin-top:20px">
      <div class="page-head" style="margin-bottom:12px">
        <h2 style="margin:0">Audience</h2>
        <div class="seg" role="group" aria-label="Platform">
          ${["tiktok", "instagram", "youtube"].map((p, i) => `<button type="button" data-plat="${p}" aria-pressed="${i === 0}">${PLATFORM[p] ?? "Instagram"}</button>`).join("")}
        </div>
      </div>
      <div id="tr-aud"><p class="muted small">Loading…</p></div>
    </section>`;

  let plat = "tiktok";
  async function showAudience(load = false, refresh = false) {
    const box = document.getElementById("tr-aud");
    if (!box) return;
    let row = null;
    if (load) {
      box.innerHTML = `<p class="muted small">Getting ${esc(PLATFORM[plat] ?? "Instagram")} audience from Chartmetric…</p>`;
      const { data, error } = await sb.functions.invoke("chartmetric-sync", { body: { action: "audience", cm_artist: id, platform: plat, refresh } });
      if (!isCurrent()) return;
      if (error || data?.error) { box.innerHTML = `<p class="error small">${esc(data?.error ?? (await error.context?.json?.().catch(() => null))?.error ?? error.message)}</p>`; return; }
      row = data;
    } else {
      const { data } = await sb.from("trend_artist_audience").select("*").eq("cm_artist", id).eq("platform", plat).maybeSingle();
      if (!isCurrent()) return;
      row = data;
    }
    if (!row) {
      box.innerHTML = `<p class="muted small" style="margin-top:0">Audience isn't loaded for this artist yet. Loading it uses Chartmetric credits once, then it's kept for 30 days.</p>
        <button type="button" class="primary" id="tr-aud-load">Load ${esc(PLATFORM[plat] ?? "Instagram")} audience</button>`;
      document.getElementById("tr-aud-load").onclick = () => showAudience(true);
      return;
    }
    box.innerHTML = audienceHtml(row) + `<p class="muted small" style="margin-top:16px">From Chartmetric · loaded ${esc(ago(row.fetched_at).toLowerCase())} · <button type="button" class="link-btn" id="tr-aud-refresh">Refresh</button></p>`;
    document.getElementById("tr-aud-refresh").onclick = () => showAudience(true, true);
  }
  app.querySelectorAll("[data-plat]").forEach((b) => (b.onclick = () => {
    plat = b.dataset.plat;
    app.querySelectorAll("[data-plat]").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    showAudience();
  }));
  showAudience();
}

// Audience blocks, tolerant of what each platform returns (fields differ between TikTok, Instagram and YouTube).
function audienceHtml(row) {
  if (row.error && !row.data) return `<p class="muted small" style="margin-top:0">${esc(row.error)}</p>`;
  const d = row.data ?? {};
  const pctOf = (x) => { const v = Number(x?.percent ?? x?.weight ?? x?.share ?? x?.value); return Number.isFinite(v) ? (v <= 1 ? v * 100 : v) : null; };
  const bars = (items, label) => {
    const list = (items ?? []).map((x) => ({ label: label(x), v: pctOf(x) })).filter((x) => x.label && x.v != null).slice(0, 8);
    if (!list.length) return "";
    const max = Math.max(...list.map((x) => x.v), 1);
    return `<div class="hbars">${list.map((x) => `<div class="hb-row"><span class="hb-label">${esc(x.label)}</span><span class="hb-track"><i style="width:${Math.max(0.6, (x.v / max) * 100)}%;background:${ONE}"></i></span><span class="hb-val">${x.v.toFixed(x.v < 10 ? 1 : 0)}%</span></div>`).join("")}</div>`;
  };
  const countryBars = bars(d.top_countries ?? d.audience_countries, (x) => `${flag(x.code ?? x.code2 ?? "")} ${x.name ?? x.code ?? ""}`.trim());
  const cityBars = bars(d.top_cities ?? d.audience_cities, (x) => [x.name ?? x.city, x.country ?? x.code2].filter(Boolean).join(", "));
  const genders = (d.audience_genders ?? d.genders ?? []).map((x) => ({ k: String(x.code ?? x.gender ?? "").toLowerCase(), v: pctOf(x) })).filter((x) => x.v != null);
  const genderLabel = (k) => (k.startsWith("f") ? "Women" : k.startsWith("m") ? "Men" : k || "Other");
  const ageSrc = d.audience_ages ?? d.ages ?? d.audience_genders_per_age ?? [];
  const ages = (Array.isArray(ageSrc) ? ageSrc : []).map((x) => {
    const v = pctOf(x) ?? (Number(x?.male ?? 0) + Number(x?.female ?? 0) || null);
    return { label: x.code ?? x.age ?? x.range, v: v == null ? null : v <= 1 ? v * 100 : v };
  }).filter((x) => x.label && x.v != null);
  const ageBars = ages.length ? (() => { const max = Math.max(...ages.map((x) => x.v), 1); return `<div class="hbars">${ages.map((x) => `<div class="hb-row"><span class="hb-label">${esc(x.label)}</span><span class="hb-track"><i style="width:${Math.max(0.6, (x.v / max) * 100)}%;background:${ONE}"></i></span><span class="hb-val">${x.v.toFixed(x.v < 10 ? 1 : 0)}%</span></div>`).join("")}</div>`; })() : "";
  const kpi = [
    ["Followers", d.followers ?? d.followers_count ?? d.subscribers],
    ["Engagement rate", d.engagement_rate != null ? `${(Number(d.engagement_rate) * (Number(d.engagement_rate) <= 1 ? 100 : 1)).toFixed(2)}%` : null],
    ["Avg likes per post", d.avg_likes_per_post ?? d.avg_likes],
    ["Avg comments per post", d.avg_comments_per_post ?? d.avg_comments],
  ].filter(([, v]) => v != null && v !== "");
  const any = countryBars || cityBars || genders.length || ageBars || kpi.length;
  if (!any) return `<p class="muted small" style="margin-top:0">Chartmetric returned no audience breakdown for this artist on this platform.</p>`;
  return `
    ${kpi.length ? `<div class="stats" style="margin-top:0">${kpi.map(([l, v]) => `<div class="stat"><div class="n">${typeof v === "number" ? compact(v) : esc(v)}</div><div class="l">${esc(l)}</div></div>`).join("")}</div>` : ""}
    <div class="tr-aud-grid">
      ${countryBars ? `<div><h3>Top countries</h3>${countryBars}</div>` : ""}
      ${cityBars ? `<div><h3>Top cities</h3>${cityBars}</div>` : ""}
      ${genders.length ? `<div><h3>Gender</h3><div class="an-split">${genders.map((g, i) => `<i style="flex:${g.v};background:${["#2a78d6", "#eb6834", "#a1a1a6"][i] ?? "#a1a1a6"}" title="${esc(genderLabel(g.k))} ${g.v.toFixed(0)}%"></i>`).join("")}</div>
        <div class="legend">${genders.map((g, i) => `<span><i style="background:${["#2a78d6", "#eb6834", "#a1a1a6"][i] ?? "#a1a1a6"}"></i>${esc(genderLabel(g.k))} ${g.v.toFixed(0)}%</span>`).join("")}</div></div>` : ""}
      ${ageBars ? `<div><h3>Age</h3>${ageBars}</div>` : ""}
    </div>`;
}
