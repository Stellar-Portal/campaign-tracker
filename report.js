// The report: one module used in two places.
// - share.html (a client with a link): what the link's settings allow.
// - the team dashboard (#/report/<artist>): the same view with everything on, plus "remove".
// It also exports the post wall and the post preview window, which the campaign page reuses.

// ---------- formatting ----------
export const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const nf = new Intl.NumberFormat("en");
const cf = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });
const n = (v) => (v == null ? "–" : nf.format(v));
const compact = (v) => (v == null ? "–" : cf.format(v));
const signed = (v) => (v == null ? "" : `${v >= 0 ? "+" : "−"}${compact(Math.abs(v))}`);
const pct = (v) => (v == null || !isFinite(v) ? "–" : `${(v * 100).toFixed(2)}%`);
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const dayLabel = (d) => `${Number(d.slice(8, 10))} ${MONTHS[Number(d.slice(5, 7)) - 1]}`;
const dayLong = (d) => `${dayLabel(d)} ${d.slice(0, 4)}`;
const regionName = (() => { try { const dn = new Intl.DisplayNames(["en"], { type: "region" }); return (c) => (c ? dn.of(c.toUpperCase()) ?? c : "Unknown"); } catch { return (c) => c ?? "Unknown"; } })();
const flag = (c) => (c && /^[a-z]{2}$/i.test(c) ? String.fromCodePoint(...[...c.toUpperCase()].map((ch) => 0x1f1a5 + ch.charCodeAt(0))) : "");
const ago = (iso) => {
  if (!iso) return "";
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 864e5);
  return days <= 0 ? "Today" : days === 1 ? "1 day ago" : days < 60 ? `${days} days ago` : dayLong(iso.slice(0, 10));
};
const addDays = (d, k) => new Date(Date.parse(d + "T00:00:00Z") + k * 864e5).toISOString().slice(0, 10);
const daysBetween = (a, b) => { const out = []; for (let d = a; d <= b; d = addDays(d, 1)) out.push(d); return out; };
const truncate = (s, k) => (s.length > k ? s.slice(0, k - 1) + "…" : s);
// "original sound - soraempire" → "soraempire (original)" so labels stay tellable apart.
const shortName = (s) => { const m = /^original sound\s*[-–]\s*(.+)$/i.exec(s); return m ? `${m[1]} (original)` : s; };
const engagement = (p) => (p.plays ? ((p.likes ?? 0) + (p.comments ?? 0) + (p.shares ?? 0)) / p.plays : null);

// Validated categorical palette (dataviz reference order). Stellar cobalt stays for single-series charts.
const SERIES = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#6250d6", "#e34948"];
const BRAND = "#0626c7";
const METRICS = [
  { key: "plays", label: "Views" },
  { key: "likes", label: "Likes" },
  { key: "comments", label: "Comments" },
  { key: "shares", label: "Shares" },
];
const metricLabel = (k) => METRICS.find((m) => m.key === k).label;

const ICON = {
  link: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/></svg>',
  open: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>',
  trash: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6"/></svg>',
  close: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  prev: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg>',
  next: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 5l7 7-7 7"/></svg>',
};

// ---------- small shared bits ----------
function ensureEl(id, cls, attrs = "") {
  let el = document.getElementById(id);
  if (!el) { document.body.insertAdjacentHTML("beforeend", `<div id="${id}" class="${cls}" ${attrs}></div>`); el = document.getElementById(id); }
  return el;
}
function toast(msg) {
  const t = ensureEl("toast", "", 'role="status" aria-live="polite"');
  t.textContent = msg; t.classList.add("show");
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove("show"), 2400);
}
async function copyLink(url) {
  try { await navigator.clipboard.writeText(url); toast("Link copied"); }
  catch { window.prompt("Copy this link:", url); }
}
const tip = () => ensureEl("tip", "tip", 'role="tooltip" hidden');
const hideTip = () => { const t = document.getElementById("tip"); if (t) t.hidden = true; };
window.addEventListener("scroll", hideTip, { passive: true });

// ---------- charts ----------
// One or more stacked panels (one per metric) sharing the date axis and one crosshair.
// Different metrics never share a y-axis: views would flatten comments to a line on the floor.
export function chart(host, { dates, panels, empty, allowNegative = false }) {
  panels = panels.map((p) => ({ ...p, series: p.series.filter((s) => s.values.some((v) => v != null)) })).filter((p) => p.series.length);
  if (dates.length < 2 || !panels.length) { host.innerHTML = `<p class="muted small chart-empty">${esc(empty)}</p>`; return; }
  const all = panels[0].series;
  const multi = all.length > 1;
  const stacked = panels.length > 1;
  const labelled = multi && all.length <= 4 && !stacked;
  host.innerHTML = `
    ${multi ? `<div class="legend">${all.map((s) => `<span><i style="background:${s.color}"></i>${esc(s.name)}</span>`).join("")}</div>` : ""}
    ${panels.map((_, k) => `<div class="plot" data-panel="${k}"></div>`).join("")}
    <div class="chart-foot"><button type="button" class="link-btn small" data-table>Show as table</button></div>
    <div class="chart-table" hidden></div>`;
  const W = Math.max(300, Math.round(host.clientWidth || 600));
  const H = stacked ? 150 : 260, L = 52, R = labelled ? Math.min(150, Math.round(W * 0.24)) : 16, T = stacked ? 26 : 14;
  const x = (i) => L + (i / (dates.length - 1)) * (W - L - R);
  const views = panels.map((p, k) => {
    const last = k === panels.length - 1;
    const B = last ? 30 : 10;
    const vals = p.series.flatMap((s) => s.values).filter((v) => v != null);
    let lo = allowNegative ? Math.min(0, ...vals) : 0, hi = Math.max(...vals, 1);
    const step = niceStep((hi - lo) / (stacked ? 3 : 4));
    hi = Math.ceil(hi / step) * step; lo = Math.floor(lo / step) * step;
    const y = (v) => T + (1 - (v - lo) / (hi - lo || 1)) * (H - T - B);
    const ticks = []; for (let v = lo; v <= hi + step / 2; v += step) ticks.push(v);
    const path = (s) => { let d = "", pen = false; s.values.forEach((v, i) => { if (v == null) { pen = false; return; } d += `${pen ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`; pen = true; }); return d; };
    const xIdx = dates.length <= 8 ? dates.map((_, i) => i) : [0, Math.round((dates.length - 1) / 2), dates.length - 1];
    let ends = [];
    if (labelled) {
      ends = p.series.map((s) => ({ s, ty: y(s.values[s.values.findLastIndex((v) => v != null)]) })).sort((a, b) => a.ty - b.ty);
      for (let j = 1; j < ends.length; j++) if (ends[j].ty - ends[j - 1].ty < 16) ends[j].ty = ends[j - 1].ty + 16;
    }
    const single = p.series.length === 1 ? p.series[0] : null;
    const el = host.querySelector(`[data-panel="${k}"]`);
    el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" role="img" aria-label="${esc(p.label ?? "")} ${esc(p.series.map((s) => s.name).join(", "))}, ${esc(dayLong(dates[0]))} to ${esc(dayLong(dates.at(-1)))}">
      ${stacked ? `<text class="panel-label" x="${L}" y="14">${esc(p.label)}</text>` : ""}
      <g class="grid">${ticks.map((v) => `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" ${v === 0 ? 'class="zero"' : ""}/><text x="${L - 8}" y="${y(v) + 4}" text-anchor="end">${compact(v)}</text>`).join("")}</g>
      ${last ? `<g class="xaxis">${xIdx.map((i) => `<text x="${x(i)}" y="${H - 8}" text-anchor="${i === 0 ? "start" : i === dates.length - 1 ? "end" : "middle"}">${esc(dayLabel(dates[i]))}</text>`).join("")}</g>` : ""}
      ${single ? `<path d="${path(single)}L${x(single.values.findLastIndex((v) => v != null)).toFixed(1)},${y(Math.max(lo, 0))}L${x(single.values.findIndex((v) => v != null)).toFixed(1)},${y(Math.max(lo, 0))}Z" fill="${single.color}" fill-opacity="0.06" stroke="none"/>` : ""}
      ${p.series.map((s) => `<path d="${path(s)}" fill="none" stroke="${s.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`).join("")}
      ${dates.length <= 14 ? p.series.map((s) => s.values.map((v, i) => (v == null ? "" : `<circle cx="${x(i)}" cy="${y(v)}" r="3" fill="${s.color}"/>`)).join("")).join("") : ""}
      ${ends.map((e) => `<text class="end" x="${W - R + 10}" y="${e.ty + 4}"><tspan fill="${e.s.color}">■</tspan> ${esc(truncate(shortName(e.s.name), 20))}</text>`).join("")}
      <line class="cross" x1="0" x2="0" y1="${T}" y2="${H - B}" visibility="hidden"/>
      <g class="hover-dots"></g>
      <rect class="hit" x="0" y="0" width="${W}" height="${H}" fill="transparent"/>
    </svg>`;
    return { p, el, y };
  });

  // Hover: snap to the nearest day, move every panel's crosshair together, tooltip follows the pointer.
  let raf = 0, last = { i: -1 };
  const show = (clientX, clientY, svg) => {
    const box = svg.getBoundingClientRect();
    const sx = ((clientX - box.left) / box.width) * W;
    const i = Math.max(0, Math.min(dates.length - 1, Math.round(((sx - L) / (W - L - R)) * (dates.length - 1))));
    if (i !== last.i) {
      last.i = i;
      for (const v of views) {
        const s = v.el.querySelector("svg"), cross = s.querySelector(".cross");
        cross.setAttribute("x1", x(i)); cross.setAttribute("x2", x(i)); cross.setAttribute("visibility", "visible");
        s.querySelector(".hover-dots").innerHTML = v.p.series.map((se) => (se.values[i] == null ? "" : `<circle cx="${x(i)}" cy="${v.y(se.values[i])}" r="5" fill="${se.color}" stroke="#fff" stroke-width="2"/>`)).join("");
      }
      const t = tip();
      t.innerHTML = `<div class="tip-date">${esc(dayLong(dates[i]))}</div>` + views.map((v) => {
        const rows = v.p.series.map((se) => ({ se, val: se.values[i] })).filter((r) => r.val != null).sort((a, b) => b.val - a.val);
        return `${stacked && multi ? `<div class="tip-group">${esc(v.p.label)}</div>` : ""}${rows.map((r) => `<div class="tip-row"><i style="background:${r.se.color}"></i><span>${esc(multi ? r.se.name : v.p.label ?? r.se.name)}</span><b>${n(r.val)}</b></div>`).join("")}`;
      }).join("");
      t.hidden = false;
    }
    const t = tip(), tw = t.offsetWidth, th = t.offsetHeight;
    const left = clientX + 18 + tw > window.innerWidth - 8 ? clientX - tw - 18 : clientX + 18;
    const top = Math.min(window.innerHeight - th - 8, Math.max(8, clientY - th / 2));
    t.style.left = `${Math.max(8, left)}px`; t.style.top = `${top}px`;
  };
  const clear = () => {
    last.i = -1;
    for (const v of views) { const s = v.el.querySelector("svg"); s.querySelector(".cross").setAttribute("visibility", "hidden"); s.querySelector(".hover-dots").innerHTML = ""; }
    hideTip();
  };
  for (const v of views) {
    const svg = v.el.querySelector("svg"), hit = svg.querySelector(".hit");
    const move = (e) => { cancelAnimationFrame(raf); const { clientX, clientY } = e; raf = requestAnimationFrame(() => show(clientX, clientY, svg)); };
    hit.addEventListener("pointermove", move);
    hit.addEventListener("pointerdown", move);
    hit.addEventListener("pointerleave", (e) => { if (!e.relatedTarget?.closest?.(".plot")) clear(); });
  }
  host.addEventListener("pointerleave", clear);

  host.querySelector("[data-table]").onclick = (e) => {
    const tbl = host.querySelector(".chart-table");
    tbl.hidden = !tbl.hidden;
    e.currentTarget.textContent = tbl.hidden ? "Show as table" : "Hide table";
    if (tbl.hidden) return;
    const cols = views.flatMap((v) => v.p.series.map((se) => ({ name: stacked && multi ? `${v.p.label}: ${se.name}` : stacked ? v.p.label : se.name, values: se.values })));
    tbl.innerHTML = `<div class="table-wrap"><table><thead><tr><th>Date</th>${cols.map((c) => `<th class="num">${esc(c.name)}</th>`).join("")}</tr></thead>
      <tbody>${dates.map((d, i) => `<tr><td>${esc(dayLong(d))}</td>${cols.map((c) => `<td class="num">${n(c.values[i])}</td>`).join("")}</tr>`).reverse().join("")}</tbody></table></div>`;
  };
}
function niceStep(raw) {
  if (!(raw > 0)) return 1;
  const p = 10 ** Math.floor(Math.log10(raw)), f = raw / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p;
}

// ---------- post wall (used by the report and the campaign page) ----------
// ctx: { mode: "client"|"team", covers: {video_id: url}, loadCovers?(ids), postDaily(video_id), remove?(post), songOf?(post), showCountry }
export function renderWall(el, list, ctx, { shown = 48, view = "grid", onMore } = {}) {
  const page = list.slice(0, shown);
  if (!list.length) { el.innerHTML = `<div class="panel"><p class="muted">No posts match these filters.</p></div>`; return; }
  const team = ctx.mode === "team" && ctx.remove;
  const picking = ctx.selected instanceof Set;
  const pick = (p, i) => picking ? `<label class="pick" title="Select"><input type="checkbox" data-pick="${i}" ${ctx.selected.has(p.id) ? "checked" : ""} aria-label="Select @${esc(p.creator?.username ?? "")}'s video"></label>` : "";
  const actions = (p, i) => `<div class="card-actions">
      <button type="button" data-act="copy" data-i="${i}" title="Copy link" aria-label="Copy link to this video">${ICON.link}</button>
      <a data-act="open" href="${esc(p.url)}" target="_blank" rel="noopener" title="Open on TikTok" aria-label="Open this video on TikTok">${ICON.open}</a>
      ${team ? `<button type="button" data-act="remove" data-i="${i}" title="Remove from campaign" aria-label="Remove this video from the campaign">${ICON.trash}</button>` : ""}
    </div>`;
  el.innerHTML = view === "grid"
    ? `<div class="wall sh-wall">${page.map((p, i) => `
      <article class="post${p.gone ? " gone" : ""}${picking && ctx.selected.has(p.id) ? " picked" : ""}">
        <div class="cover-wrap">
          ${pick(p, i)}
          <button type="button" class="cover" data-i="${i}" aria-label="Preview @${esc(p.creator?.username ?? "")}'s video">
            <img data-vid="${esc(p.video_id)}" alt="" loading="lazy" ${ctx.covers[p.video_id] ? `src="${esc(ctx.covers[p.video_id])}"` : "hidden"} onerror="this.hidden=true">
            ${p.gone ? `<span class="chip tl">No longer on TikTok</span>` : ctx.showCountry !== false && flag(p.country) ? `<span class="chip tl" title="${esc(regionName(p.country))}">${flag(p.country)}</span>` : ""}
            ${p.gone ? "" : `<span class="chip tr">${esc(ago(p.published_at))}</span>`}
            <span class="plays">${compact(p.plays)}</span>
          </button>
          ${actions(p, i)}
        </div>
        <div class="body">
          <div class="handle">@${esc(p.creator?.username ?? "unknown")}${p.creator?.verified ? ' <span class="tick" title="Verified">✓</span>' : ""}</div>
          <div class="caption">${esc(p.caption ?? "")}</div>
          ${p.sound_title ? `<div class="line sound-line">♪ ${esc(p.sound_title)}</div>` : ""}
          ${ctx.folderOf && ctx.folderOf(p) ? `<div class="line folder-line">${esc(ctx.folderOf(p))}</div>` : ""}
          <div class="line">${compact(p.likes)} likes · ${compact(p.comments)} comments · ${compact(p.shares)} shares</div>
        </div>
      </article>`).join("")}</div>`
    : `<div class="table-wrap"><table class="post-table"><thead><tr>${picking ? '<th class="pick-col"><span class="sr">Select</span></th>' : ""}<th>Post</th>${ctx.songOf ? "<th>Song</th>" : ""}${ctx.folderOf ? "<th>Folder</th>" : ""}${ctx.showCountry !== false ? "<th>Country</th>" : ""}<th>Posted</th><th class="num">Views</th><th class="num">Likes</th><th class="num">Comments</th><th class="num">Shares</th><th></th></tr></thead>
      <tbody>${page.map((p, i) => `<tr${picking && ctx.selected.has(p.id) ? ' class="picked"' : ""}>
        ${picking ? `<td class="pick-col">${pick(p, i)}</td>` : ""}
        <td><button type="button" class="link-btn artist" data-i="${i}" data-act="preview">@${esc(p.creator?.username ?? "unknown")}</button><div class="muted small clamp">${esc(p.caption ?? "")}</div></td>
        ${ctx.songOf ? `<td>${esc(ctx.songOf(p))}</td>` : ""}
        ${ctx.folderOf ? `<td>${esc(ctx.folderOf(p) || "–")}</td>` : ""}
        ${ctx.showCountry !== false ? `<td>${p.country ? `${flag(p.country)} ${esc(regionName(p.country))}` : "–"}</td>` : ""}
        <td class="small">${esc(ago(p.published_at))}</td>
        <td class="num plays-cell">${n(p.plays)}</td><td class="num">${n(p.likes)}</td><td class="num">${n(p.comments)}</td><td class="num">${n(p.shares)}</td>
        <td class="row-actions">${actions(p, i)}</td></tr>`).join("")}</tbody></table></div>`;
  if (list.length > page.length) {
    el.insertAdjacentHTML("beforeend", `<div class="actions" style="justify-content:center"><button type="button" data-more>${list.length - page.length <= 48 ? `Show the last ${n(list.length - page.length)}` : `Show 48 more (${n(list.length - page.length)} left)`}</button></div>`);
    el.querySelector("[data-more]").onclick = () => onMore?.();
  }
  el.querySelectorAll(".cover, [data-act=preview]").forEach((b) => b.onclick = () => {
    if (picking && b.classList.contains("cover")) { const box = b.parentElement.querySelector("[data-pick]"); box.checked = !box.checked; box.dispatchEvent(new Event("change")); return; }
    openPostModal(page, Number(b.dataset.i), ctx);
  });
  el.querySelectorAll("[data-pick]").forEach((b) => b.onchange = () => {
    const p = page[Number(b.dataset.pick)];
    if (b.checked) ctx.selected.add(p.id); else ctx.selected.delete(p.id);
    b.closest("article, tr")?.classList.toggle("picked", b.checked);
    ctx.onSelect?.();
  });
  el.querySelectorAll("[data-act=copy]").forEach((b) => b.onclick = (e) => { e.stopPropagation(); copyLink(page[Number(b.dataset.i)].url); });
  el.querySelectorAll("[data-act=remove]").forEach((b) => b.onclick = async (e) => {
    e.stopPropagation();
    await removePost(page[Number(b.dataset.i)], ctx);
  });
  fetchCovers(page, ctx);
}

async function removePost(p, ctx) {
  if (!confirm(`Remove @${p.creator?.username ?? "this creator"}'s video from the campaign? Its numbers will no longer count. You can add the link again later.`)) return false;
  const ok = await ctx.remove(p);
  if (ok) { toast("Video removed"); ctx.onRemoved?.(p); }
  return ok;
}

const asked = new WeakMap();
async function fetchCovers(page, ctx) {
  if (!ctx.loadCovers) return;
  const seen = asked.get(ctx) ?? new Set(); asked.set(ctx, seen);
  const want = page.filter((p) => p.has_cover && !ctx.covers[p.video_id] && !seen.has(p.video_id)).map((p) => p.video_id);
  for (const v of want) seen.add(v);
  for (let i = 0; i < want.length; i += 200) {
    try {
      const got = await ctx.loadCovers(want.slice(i, i + 200));
      Object.assign(ctx.covers, got ?? {});
      for (const [vid, url] of Object.entries(got ?? {})) {
        document.querySelectorAll(`img[data-vid="${CSS.escape(vid)}"]`).forEach((img) => { img.src = url; img.hidden = false; });
      }
    } catch { /* a missing cover isn't worth an error */ }
  }
}

// ---------- post preview window ----------
export function openPostModal(list, index, ctx) {
  closeModal();
  let i = index;
  const opener = document.activeElement;
  const wrap = document.createElement("div");
  wrap.className = "pm-backdrop";
  document.body.appendChild(wrap);
  document.body.classList.add("modal-open");
  let tab = "performance";

  const draw = () => {
    const p = list[i];
    const er = engagement(p);
    const name = p.creator?.name || p.creator?.username || "Unknown creator";
    const initial = esc((name.match(/[\p{L}\p{N}]/u)?.[0] ?? "?").toUpperCase());
    wrap.innerHTML = `
      <div class="pm" role="dialog" aria-modal="true" aria-label="Video by @${esc(p.creator?.username ?? "")}">
        <div class="pm-media">
          ${ctx.covers[p.video_id] ? `<img class="pm-poster" src="${esc(ctx.covers[p.video_id])}" alt="">` : ""}
          <iframe src="https://www.tiktok.com/player/v1/${encodeURIComponent(p.video_id)}?description=1&music_info=1&rel=0&native_context_menu=0" title="TikTok video by @${esc(p.creator?.username ?? "")}"
            allow="encrypted-media; fullscreen; picture-in-picture" allowfullscreen referrerpolicy="strict-origin-when-cross-origin"></iframe>
          ${list.length > 1 ? `<button type="button" class="pm-nav prev" aria-label="Previous video" ${i === 0 ? "disabled" : ""}>${ICON.prev}</button>
          <button type="button" class="pm-nav next" aria-label="Next video" ${i === list.length - 1 ? "disabled" : ""}>${ICON.next}</button>` : ""}
        </div>
        <div class="pm-side">
          <div class="pm-head">
            <div class="pm-avatar">${p.creator?.avatar ? `<img src="${esc(p.creator.avatar)}" alt="" referrerpolicy="no-referrer" onerror="this.replaceWith(document.createTextNode('${initial}'))">` : initial}</div>
            <div class="pm-who">
              <div class="pm-name">${esc(name)}${p.creator?.verified ? ' <span class="tick" title="Verified">✓</span>' : ""}</div>
              <a href="https://www.tiktok.com/@${encodeURIComponent(p.creator?.username ?? "")}" target="_blank" rel="noopener">@${esc(p.creator?.username ?? "unknown")}</a>
              <div class="muted small">${p.published_at ? `Posted ${esc(dayLong(p.published_at.slice(0, 10)))}` : ""}${ctx.showCountry !== false && p.country ? ` · ${flag(p.country)} ${esc(regionName(p.country))}` : ""}</div>
            </div>
            <button type="button" class="pm-close" aria-label="Close">${ICON.close}</button>
          </div>
          <div class="pm-actions">
            <a class="btn primary" href="${esc(p.url)}" target="_blank" rel="noopener">Watch on TikTok</a>
            <button type="button" class="icon-btn" data-pm="copy" title="Copy link" aria-label="Copy link">${ICON.link}</button>
            <a class="icon-btn" href="${esc(p.url)}" target="_blank" rel="noopener" title="Open in a new tab" aria-label="Open in a new tab">${ICON.open}</a>
            ${ctx.mode === "team" && ctx.move && ctx.folders?.length ? `<label class="pm-folder"><span class="sr">Folder</span><select data-pm="folder" aria-label="Folder"><option value="">Not in a folder</option>${ctx.folders.map((f) => `<option value="${esc(f.id)}" ${p.folder_id === f.id ? "selected" : ""}>${esc(f.name)}</option>`).join("")}</select></label>` : ""}
            ${ctx.mode === "team" && ctx.remove ? `<button type="button" class="icon-btn danger" data-pm="remove" title="Remove from campaign" aria-label="Remove from campaign">${ICON.trash}</button>` : ""}
          </div>
          <div class="pm-tabs" role="tablist">
            <button type="button" role="tab" data-pmtab="performance" aria-selected="${tab === "performance"}">Performance</button>
            <button type="button" role="tab" data-pmtab="details" aria-selected="${tab === "details"}">Details</button>
          </div>
          <div class="pm-body">
            ${tab === "performance" ? `
              <div class="pm-grid">
                ${METRICS.map((m) => `<div class="pm-tile"><div class="l">${m.label}</div><div class="n">${n(p[m.key])}</div></div>`).join("")}
                <div class="pm-tile"><div class="l">Engagement rate</div><div class="n">${pct(er)}</div></div>
                ${p.creator?.followers != null ? `<div class="pm-tile"><div class="l">Creator's followers</div><div class="n">${compact(p.creator.followers)}</div></div>` : ""}
              </div>
              <div class="pm-chart"><div class="chart-head"><h3>Views over time</h3></div><div id="pm-chart"><p class="muted small">Loading…</p></div></div>
              <p class="muted small">Numbers from ${p.stats_date ? esc(dayLong(p.stats_date)) : "the latest check"}. Engagement rate is likes, comments and shares per view.</p>`
            : `<dl class="pm-details">
                <dt>Caption</dt><dd>${esc(p.caption || "–")}</dd>
                ${p.sound_title ? `<dt>Sound</dt><dd>♪ ${esc(p.sound_title)}</dd>` : ""}
                ${ctx.songOf ? `<dt>Campaign</dt><dd>${esc(ctx.songOf(p) || "–")}</dd>` : ""}
                ${ctx.folderOf && ctx.folderOf(p) ? `<dt>Folder</dt><dd>${esc(ctx.folderOf(p))}</dd>` : ""}
                ${p.creator?.followers != null ? `<dt>Creator's followers</dt><dd>${n(p.creator.followers)}</dd>` : ""}
                ${ctx.showCountry !== false && p.country ? `<dt>Country</dt><dd>${flag(p.country)} ${esc(regionName(p.country))}</dd>` : ""}
                <dt>Posted</dt><dd>${p.published_at ? esc(dayLong(p.published_at.slice(0, 10))) : "–"}</dd>
                <dt>TikTok video ID</dt><dd>${esc(p.video_id)}</dd>
              </dl>`}
          </div>
        </div>
      </div>`;
    wrap.querySelector(".pm-close").onclick = closeModal;
    wrap.querySelector(".prev")?.addEventListener("click", () => { if (i > 0) { i--; draw(); } });
    wrap.querySelector(".next")?.addEventListener("click", () => { if (i < list.length - 1) { i++; draw(); } });
    wrap.querySelectorAll("[data-pmtab]").forEach((b) => b.onclick = () => { tab = b.dataset.pmtab; draw(); });
    wrap.querySelector("[data-pm=copy]").onclick = () => copyLink(p.url);
    const rm = wrap.querySelector("[data-pm=remove]");
    if (rm) rm.onclick = async () => { if (await removePost(p, ctx)) closeModal(); };
    const fs = wrap.querySelector("[data-pm=folder]");
    if (fs) fs.onchange = async () => { if (await ctx.move([p], fs.value || null)) { p.folder_id = fs.value || null; } else fs.value = p.folder_id ?? ""; };
    wrap.querySelector(".pm-close").focus();
    if (tab === "performance") loadPostChart(p, ctx);
  };
  wrap.addEventListener("click", (e) => { if (e.target === wrap) closeModal(); });
  modalKeys = (e) => {
    if (e.key === "Escape") closeModal();
    else if (e.key === "ArrowLeft" && i > 0 && !e.target.closest?.("input,select,textarea")) { i--; draw(); }
    else if (e.key === "ArrowRight" && i < list.length - 1 && !e.target.closest?.("input,select,textarea")) { i++; draw(); }
  };
  document.addEventListener("keydown", modalKeys);
  closeModal.opener = opener;
  draw();
}
let modalKeys = null;
function closeModal() {
  const w = document.querySelector(".pm-backdrop");
  if (!w) return;
  w.remove();
  document.body.classList.remove("modal-open");
  if (modalKeys) document.removeEventListener("keydown", modalKeys);
  hideTip();
  closeModal.opener?.focus?.();
}
const dailyCache = new Map();
async function loadPostChart(p, ctx) {
  const host = document.getElementById("pm-chart");
  let rows = dailyCache.get(p.video_id);
  if (!rows) {
    try { rows = (await ctx.postDaily(p.video_id)) ?? []; } catch { rows = []; }
    dailyCache.set(p.video_id, rows);
  }
  if (!document.getElementById("pm-chart") || host !== document.getElementById("pm-chart")) return;
  const map = Object.fromEntries(rows.map((r) => [r.stat_date, r]));
  const dates = rows.length ? daysBetween(rows[0].stat_date, rows.at(-1).stat_date) : [];
  let lastRow = null;
  const filled = dates.map((d) => (lastRow = map[d] ?? lastRow));
  chart(host, {
    dates,
    panels: [{ label: "Views", series: [{ name: "Views", color: BRAND, values: filled.map((r) => r?.plays ?? null) }] }],
    empty: rows.length === 1 ? `Tracking started ${dayLong(rows[0].stat_date)}. The line appears after the next daily check.` : "No daily numbers yet.",
  });
}

// ---------- the full report ----------
// api: { mode, load() → payload, loadCovers(ids), postDaily(vid), remove?(post), header?: html, onHeader?(root) }
export function mountReport(root, api) {
  let data = null;
  const state = { tab: null, metrics: ["plays"], from: null, to: null, q: "", camp: "", folder: "", creator: "", country: "", sort: "plays", view: "grid", shown: 48 };
  const ctx = { mode: api.mode, covers: {}, loadCovers: api.loadCovers, postDaily: api.postDaily, remove: api.remove, onRemoved: null, songOf: null, showCountry: true };
  let S = {};

  (async () => {
    root.innerHTML = `<p class="muted pad">Loading the report…</p>`;
    try { data = await api.load(); }
    catch (e) { api.onError?.(e); return; }
    S = { overview: true, overview_chart: true, sounds: true, songs: true, songs_chart: true, countries: true, countries_chart: true, posts: true, posts_country_filter: true, show_country: true, show_followers: true, folders: true, ...(data.settings ?? {}) };
    // Same rules the server applies, so the page never offers a view whose data was withheld.
    if (!S.show_country) { S.countries = false; S.posts_country_filter = false; }
    if (!S.countries) S.countries_chart = false;
    if (!S.songs) S.songs_chart = false;
    if (!S.overview) S.overview_chart = false;
    ctx.showCountry = S.show_country;
    Object.assign(ctx.covers, data.covers ?? {});
    prepare();
    render();
  })();

  function prepare() {
    const rows = data.series ?? [];
    const dates = [...new Set(rows.map((r) => r.stat_date))].sort();
    data.dates = dates.length ? daysBetween(dates[0], dates.at(-1)) : [];
    data.campById = Object.fromEntries((data.campaigns ?? []).map((c, i) => [c.id, { ...c, color: SERIES[i % SERIES.length] }]));
    data.byDate = {};
    for (const r of rows) (data.byDate[r.stat_date] ??= []).push(r);
    state.from = data.dates[0] ?? null;
    state.to = data.dates.at(-1) ?? null;
    const latest = {};
    for (const r of data.byDate[state.to] ?? []) latest[r.country_code ?? "??"] = (latest[r.country_code ?? "??"] ?? 0) + Number(r.plays ?? 0);
    data.countryOrder = Object.keys(latest).sort((a, b) => latest[b] - latest[a]);
    data.countryColor = Object.fromEntries(data.countryOrder.slice(0, 7).map((c, i) => [c, SERIES[i]]));
    (data.sounds ?? []).forEach((s, i) => { s.color = SERIES[i % SERIES.length]; });
    ctx.songOf = (data.campaigns ?? []).length > 1 ? (p) => data.campById[p.campaign_id]?.song ?? "" : null;
    // Folders (markets or creatives). Names get the song in front when the report covers several campaigns.
    const many = (data.campaigns ?? []).length > 1;
    data.folders = (data.folders ?? []).map((f, i) => ({ ...f, label: many ? `${data.campById[f.campaign_id]?.song ?? "Untitled"} · ${f.name}` : f.name, color: SERIES[i % SERIES.length] }));
    data.folderById = Object.fromEntries(data.folders.map((f) => [f.id, f]));
    ctx.folderOf = data.folders.length && S.folders ? (p) => data.folderById[p.folder_id]?.label ?? "" : null;
    ctx.onRemoved = (p) => { data.posts = data.posts.filter((x) => !(x.video_id === p.video_id && x.campaign_id === p.campaign_id)); data.post_count = Math.max(0, (data.post_count ?? 1) - 1); renderPosts(); };
  }

  const folderWord = () => ((data.folders ?? []).every((f) => f.market) ? "Markets" : "Folders");
  const tabsAvailable = () => [["overview", "Overview", S.overview], ["sounds", "Sounds", S.sounds && (data.sounds ?? []).length], ["songs", "Songs", S.songs], ["folders", folderWord(), S.folders && (data.folders ?? []).length], ["countries", "Countries", S.countries]].filter((t) => t[2]);

  function sumAt(date, key, pred = () => true) {
    let t = 0, any = false;
    for (const r of data.byDate[date] ?? []) if (pred(r)) { t += Number(r[key] ?? 0); any = true; }
    return any ? t : null;
  }
  const rangeDates = () => data.dates.filter((d) => d >= state.from && d <= state.to);
  function growth(key, pred) {
    const ds = rangeDates();
    if (!ds.length) return { end: null, delta: null };
    const end = sumAt(ds.at(-1), key, pred);
    const before = data.dates.filter((d) => d < ds[0]).at(-1);
    const base = before ? sumAt(before, key, pred) : sumAt(ds[0], key, pred);
    return { end, delta: end != null && base != null && ds.length + (before ? 1 : 0) > 1 ? end - base : null, since: ds[0], fromStart: !before };
  }

  function render() {
    const camps = data.campaigns ?? [];
    const posts = data.posts ?? [];
    const lastStats = posts.map((p) => p.stats_date).filter(Boolean).sort().at(-1) ?? data.dates.at(-1);
    const tabs = tabsAvailable();
    if (!tabs.some((t) => t[0] === state.tab)) state.tab = tabs[0]?.[0] ?? null;
    const showPosts = S.posts && (api.mode === "team" || posts.length);
    root.innerHTML = `
      <section class="band on-blue sh-band">
        ${api.mode === "client" ? `<div class="sh-top"><img src="assets/stellar-blue.png" alt="Stellar" width="80" height="22"><span>Campaign report</span></div>` : ""}
        ${api.header ?? ""}
        <div class="hero">
          <div>
            <h1>${esc(data.artist)}</h1>
            <div class="voice">${camps.length === 1 ? esc(camps[0].song ?? "1 campaign") : `${camps.length} campaigns`}${data.folder ? `<span class="folder-name">${esc(data.folder.name)}</span>` : ""}</div>
            <div class="meta">
              ${camps.length > 1 ? camps.map((c) => `<span class="status">${esc(c.song ?? "Untitled")}${c.status === "draft" ? " · upcoming" : ""}</span>`).join("") : camps[0]?.status === "draft" ? `<span class="status">upcoming</span>` : ""}
              ${data.dates.length ? `<span>Tracking since ${esc(dayLong(data.dates[0]))}</span>` : ""}
              ${lastStats ? `<span>Numbers from ${esc(dayLong(lastStats))}</span>` : ""}
            </div>
          </div>
        </div>
      </section>
      ${camps.length === 0 ? `<div class="panel" style="margin-top:24px"><p>There's nothing to show here yet. Check back once the campaign is live.</p></div>` : `
      ${tabs.length ? `<div class="sh-controls">
        <div class="tabs" role="tablist" aria-label="Report views">
          ${tabs.map(([k, l]) => `<button type="button" role="tab" data-tab="${k}" aria-selected="${state.tab === k}">${l}</button>`).join("")}
        </div>
        <div class="range" ${data.dates.length < 2 ? "hidden" : ""}>
          <div class="seg" role="group" aria-label="Date range">
            <button type="button" data-preset="7">7 days</button><button type="button" data-preset="30">30 days</button><button type="button" data-preset="all">All</button>
          </div>
          <label class="sr" for="from">From</label><input type="date" id="from" min="${data.dates[0] ?? ""}" max="${data.dates.at(-1) ?? ""}">
          <span class="muted small">to</span>
          <label class="sr" for="to">To</label><input type="date" id="to" min="${data.dates[0] ?? ""}" max="${data.dates.at(-1) ?? ""}">
        </div>
      </div>
      <section id="panel" role="tabpanel"></section>` : ""}
      ${showPosts ? `
      <div class="section-head" id="posts-head"><h2>Posts <span class="muted" style="font-weight:400" id="post-count"></span></h2></div>
      <div class="filters sh-filters">
        <input id="q" type="search" placeholder="Search captions or creators" aria-label="Search posts">
        ${camps.length > 1 ? `<select id="f-camp" aria-label="Campaign"><option value="">All songs</option>${camps.map((c) => `<option value="${esc(c.id)}">${esc(c.song ?? "Untitled")}</option>`).join("")}</select>` : ""}
        ${ctx.folderOf ? `<select id="f-folder" aria-label="${folderWord() === "Markets" ? "Market" : "Folder"}"><option value="">All ${folderWord().toLowerCase()}</option>${data.folders.map((f) => `<option value="${esc(f.id)}">${esc(f.label)}</option>`).join("")}${posts.some((p) => !p.folder_id) ? `<option value="none">${api.mode === "client" ? "Other posts" : "Not in a folder"}</option>` : ""}</select>` : ""}
        <select id="f-creator" aria-label="Creator"><option value="">All creators</option>${[...new Set(posts.map((p) => p.creator?.username).filter(Boolean))].sort().map((u) => `<option>${esc(u)}</option>`).join("")}</select>
        ${S.posts_country_filter && S.show_country ? `<select id="f-country" aria-label="Country"><option value="">All countries</option>${[...new Set(posts.map((p) => p.country).filter(Boolean))].sort((a, b) => regionName(a).localeCompare(regionName(b))).map((c) => `<option value="${esc(c)}">${flag(c)} ${esc(regionName(c))}</option>`).join("")}</select>` : ""}
        <select id="sort" aria-label="Sort"><option value="plays">Most views</option><option value="likes">Most likes</option><option value="shares">Most shares</option><option value="er">Highest engagement</option><option value="newest">Newest first</option></select>
        <div class="seg view-toggle" role="group" aria-label="Layout"><button type="button" data-view="grid">Grid</button><button type="button" data-view="list">List</button></div>
      </div>
      <div id="posts"></div>` : ""}`}`;
    api.onHeader?.(root);
    if (!camps.length) return;

    root.querySelectorAll("[data-tab]").forEach((b) => b.onclick = () => { state.tab = b.dataset.tab; root.querySelectorAll("[data-tab]").forEach((x) => x.setAttribute("aria-selected", x === b)); renderPanel(); });
    root.querySelectorAll("[data-preset]").forEach((b) => b.onclick = () => {
      const last = data.dates.at(-1);
      state.to = last;
      state.from = b.dataset.preset === "all" ? data.dates[0] : [data.dates[0], addDays(last, 1 - Number(b.dataset.preset))].sort().at(-1);
      syncRange(); renderPanel();
    });
    const from = root.querySelector("#from"), to = root.querySelector("#to");
    if (from) {
      from.onchange = () => { if (from.value) { state.from = from.value; if (state.from > state.to) state.to = state.from; } syncRange(); renderPanel(); };
      to.onchange = () => { if (to.value) { state.to = to.value; if (state.to < state.from) state.from = state.to; } syncRange(); renderPanel(); };
    }
    syncRange();
    const bind = (id, key) => { const el = root.querySelector("#" + id); if (el) { el.value = state[key]; el.oninput = () => { state[key] = el.value; state.shown = 48; renderPosts(); }; } };
    bind("q", "q"); bind("f-camp", "camp"); bind("f-folder", "folder"); bind("f-creator", "creator"); bind("f-country", "country"); bind("sort", "sort");
    root.querySelectorAll("[data-view]").forEach((b) => {
      b.setAttribute("aria-pressed", state.view === b.dataset.view);
      b.onclick = () => { state.view = b.dataset.view; root.querySelectorAll("[data-view]").forEach((x) => x.setAttribute("aria-pressed", x === b)); renderPosts(); };
    });
    if (state.tab) renderPanel();
    if (root.querySelector("#posts")) renderPosts();
  }

  function syncRange() {
    const from = root.querySelector("#from"), to = root.querySelector("#to");
    if (from) { from.value = state.from ?? ""; to.value = state.to ?? ""; }
    const first = data.dates[0], last = data.dates.at(-1);
    root.querySelectorAll("[data-preset]").forEach((b) => {
      const p = b.dataset.preset;
      const start = p === "all" ? first : [first, addDays(last, 1 - Number(p))].sort().at(-1);
      b.setAttribute("aria-pressed", state.to === last && state.from === start && (p === "all" || start !== first));
    });
  }

  function renderPanel() {
    const el = root.querySelector("#panel");
    if (!el) return;
    hideTip();
    if (state.tab === "overview") return renderOverview(el);
    if (state.tab === "sounds") return renderSounds(el);
    if (state.tab === "songs") return renderBreakdown(el, "songs");
    if (state.tab === "folders") return renderBreakdown(el, "folders");
    if (state.tab === "countries") return renderBreakdown(el, "countries");
  }

  const sinceText = (g) => (g.delta == null ? "" : `<div class="d ${g.delta < 0 ? "neg" : ""}">${signed(g.delta)} ${g.fromStart ? `since ${esc(dayLabel(g.since))}` : "in this period"}</div>`);
  const toggleMetric = (k) => {
    const on = state.metrics.includes(k);
    if (on && state.metrics.length === 1) return;
    state.metrics = on ? state.metrics.filter((m) => m !== k) : [...state.metrics, k].sort((a, b) => METRICS.findIndex((m) => m.key === a) - METRICS.findIndex((m) => m.key === b));
  };
  const metricChips = () => `<div class="metric-pick" role="group" aria-label="Numbers to chart">
      ${METRICS.map((m) => `<button type="button" class="chip-toggle" data-metric="${m.key}" aria-pressed="${state.metrics.includes(m.key)}">${m.label}</button>`).join("")}
      <span class="muted small">Pick one or more</span></div>`;

  function renderOverview(el) {
    const g = Object.fromEntries(METRICS.map((m) => [m.key, growth(m.key)]));
    const er = g.plays.end ? ((g.likes.end ?? 0) + (g.comments.end ?? 0) + (g.shares.end ?? 0)) / g.plays.end : null;
    const creators = data.creator_count ?? new Set((data.posts ?? []).map((p) => p.creator?.username).filter(Boolean)).size;
    const posts = data.post_count ?? (data.posts ?? []).length;
    el.innerHTML = `
      <div class="stats sh-stats">
        ${METRICS.map((m) => `<div class="stat ${state.metrics.includes(m.key) && S.overview_chart ? "on" : ""}">${S.overview_chart ? `<button type="button" class="stat-btn" data-metric="${m.key}" aria-pressed="${state.metrics.includes(m.key)}">` : "<div>"}
          <div class="n">${n(g[m.key].end)}</div><div class="l">${m.label}</div>${sinceText(g[m.key])}${S.overview_chart ? "</button>" : "</div>"}</div>`).join("")}
        <div class="stat"><div class="n">${pct(er)}</div><div class="l">Engagement rate</div><div class="d muted">likes, comments and shares per view</div></div>
        <div class="stat"><div class="n">${n(posts)}</div><div class="l">Live posts</div><div class="d muted">by ${n(creators)} creator${creators === 1 ? "" : "s"}</div></div>
        ${data.follower_total != null ? `<div class="stat"><div class="n">${compact(data.follower_total)}</div><div class="l">Creators' followers</div><div class="d muted">combined reach</div></div>` : ""}
      </div>
      ${S.overview_chart ? `<div class="chart-card">
        <div class="chart-head"><h3>${state.metrics.map(metricLabel).join(", ")} over time</h3><span class="muted small">Click the numbers above to add or remove them</span></div>
        <div id="chart"></div>
      </div>` : ""}`;
    el.querySelectorAll("[data-metric]").forEach((b) => b.onclick = () => { toggleMetric(b.dataset.metric); renderOverview(el); });
    if (!S.overview_chart) return;
    const ds = rangeDates();
    chart(el.querySelector("#chart"), {
      dates: ds,
      panels: state.metrics.map((k) => ({ label: metricLabel(k), series: [{ name: metricLabel(k), color: BRAND, values: ds.map((d) => sumAt(d, k)) }] })),
      empty: "The chart fills in once numbers have been collected on two or more days.",
    });
  }

  function renderBreakdown(el, kind) {
    const ds = rangeDates();
    let groups;
    if (kind === "songs") {
      groups = (data.campaigns ?? []).map((c) => ({ id: c.id, name: c.song ?? "Untitled", color: data.campById[c.id].color, pred: (r) => r.campaign_id === c.id }));
    } else if (kind === "folders") {
      groups = data.folders.map((f) => ({ id: f.id, name: f.label, color: f.color, pred: (r) => r.folder_id === f.id }));
      if ((data.series ?? []).some((r) => !r.folder_id)) groups.push({ id: "none", name: api.mode === "client" ? "Other posts" : "Not in a folder", color: "#8a8f99", pred: (r) => !r.folder_id });
    } else {
      const top = data.countryOrder.slice(0, 7);
      groups = top.map((c) => ({ id: c, name: c === "??" ? "Unknown" : `${flag(c)} ${regionName(c)}`, color: data.countryColor[c], pred: (r) => (r.country_code ?? "??") === c }));
      const rest = data.countryOrder.slice(7);
      if (rest.length) groups.push({ id: "other", name: `Other (${rest.length})`, color: "#8a8f99", pred: (r) => rest.includes(r.country_code ?? "??") });
    }
    const showChart = kind === "songs" ? S.songs_chart : kind === "folders" ? true : S.countries_chart;
    const k0 = state.metrics[0];
    const totalEnd = growth(k0).end || 0;
    const tiles = groups.map((gr) => ({ ...gr, g: growth(k0, gr.pred) })).sort((a, b) => (b.g.end ?? 0) - (a.g.end ?? 0));
    el.innerHTML = `
      ${showChart ? metricChips() : `<div class="metric-pick seg" role="group" aria-label="Number to show">${METRICS.map((m) => `<button type="button" data-metric1="${m.key}" aria-pressed="${k0 === m.key}">${m.label}</button>`).join("")}</div>`}
      <div class="tiles">
        ${tiles.map((t) => `<div class="tile"><div class="tile-name"><i style="background:${t.color}"></i><span>${esc(t.name)}</span></div>
          <div class="n">${n(t.g.end)}</div>
          <div class="bar"><span style="width:${totalEnd ? Math.max(1, Math.round(((t.g.end ?? 0) / totalEnd) * 100)) : 0}%;background:${t.color}"></span></div>
          <div class="d muted">${totalEnd ? `${Math.round(((t.g.end ?? 0) / totalEnd) * 100)}% of ${metricLabel(k0).toLowerCase()}` : ""}${t.g.delta != null ? ` · ${signed(t.g.delta)}` : ""}</div></div>`).join("")}
      </div>
      ${showChart ? `<div class="chart-card">
        <div class="chart-head"><h3>${state.metrics.map(metricLabel).join(", ")} by ${kind === "songs" ? "song" : kind === "folders" ? (folderWord() === "Markets" ? "market" : "folder") : "creator country"}</h3></div>
        <div id="chart"></div>
      </div>` : ""}`;
    el.querySelectorAll("[data-metric]").forEach((b) => b.onclick = () => { toggleMetric(b.dataset.metric); renderBreakdown(el, kind); });
    el.querySelectorAll("[data-metric1]").forEach((b) => b.onclick = () => { state.metrics = [b.dataset.metric1]; renderBreakdown(el, kind); });
    if (!showChart) return;
    chart(el.querySelector("#chart"), {
      dates: ds,
      panels: state.metrics.map((k) => ({ label: metricLabel(k), series: groups.map((gr) => ({ name: gr.name, color: gr.color, values: ds.map((d) => sumAt(d, k, gr.pred)) })) })),
      empty: "The chart fills in once numbers have been collected on two or more days.",
    });
  }

  function renderSounds(el) {
    const sounds = data.sounds ?? [];
    if (!sounds.length) { el.innerHTML = `<div class="panel"><p class="muted">Sounds appear here once posts are tracked.</p></div>`; return; }
    const allDays = [...new Set(sounds.flatMap((s) => s.daily.map((d) => d.d)))].sort();
    const full = allDays.length ? daysBetween(allDays[0], allDays.at(-1)) : [];
    const ds = full.filter((d) => d >= state.from && d <= state.to);
    const totals = sounds.map((s) => { const map = Object.fromEntries(s.daily.map((d) => [d.d, d.n])); let last = null; return Object.fromEntries(full.map((d) => { if (map[d] != null) last = map[d]; return [d, last]; })); });
    const newPerDay = (i, d) => { const prev = totals[i][addDays(d, -1)]; const cur = totals[i][d]; return prev == null || cur == null ? null : cur - prev; };
    const tiles = sounds.map((s, i) => {
      const now = totals[i][ds.at(-1)] ?? s.daily.at(-1)?.n ?? null;
      const before = ds.length ? totals[i][addDays(ds[0], -1)] : null;
      const start = ds.length ? totals[i][ds[0]] : null;
      return { s, now, delta: now != null && before != null ? now - before : now != null && start != null && ds.length > 1 ? now - start : null };
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
    chart(el.querySelector("#chart"), {
      dates: chartDays,
      panels: [{ label: "New videos", series: sounds.map((s, i) => ({ name: s.title ?? "Untitled sound", color: s.color, values: chartDays.map((d) => newPerDay(i, d)) })) }],
      empty: "New videos per day appear after the sounds have been checked on two or more days.",
      allowNegative: true,
    });
  }

  function filteredPosts() {
    const q = state.q.trim().toLowerCase();
    const list = (data.posts ?? []).filter((p) =>
      (!state.camp || p.campaign_id === state.camp) &&
      (!state.folder || (state.folder === "none" ? !p.folder_id : p.folder_id === state.folder)) &&
      (!state.creator || p.creator?.username === state.creator) &&
      (!state.country || p.country === state.country) &&
      (!q || (p.caption ?? "").toLowerCase().includes(q) || (p.creator?.username ?? "").toLowerCase().includes(q) || (p.creator?.name ?? "").toLowerCase().includes(q)));
    const by = state.sort;
    const val = (p) => (by === "er" ? engagement(p) : p[by]) ?? -1;
    return list.sort((a, b) => by === "newest" ? String(b.published_at ?? "").localeCompare(String(a.published_at ?? "")) : val(b) - val(a));
  }

  function renderPosts() {
    const el = root.querySelector("#posts");
    if (!el) return;
    const list = filteredPosts();
    const count = root.querySelector("#post-count");
    if (count) count.textContent = n((data.posts ?? []).length);
    renderWall(el, list, ctx, { shown: state.shown, view: state.view, onMore: () => { state.shown += 48; renderPosts(); } });
  }

  let resizeTimer;
  const onResize = () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { if (data && root.isConnected && root.querySelector("#panel")) renderPanel(); }, 200); };
  window.addEventListener("resize", onResize);
}
export { flag, regionName, ago, engagement, ICON, copyLink, pct, compact };
