// Analytics: charts across every campaign in the Campaign Overview sheet, plus tracker performance.
// Money is shown in USD (ECB rates, refreshed daily in fx_rates). Every chart says how many
// campaigns it is based on, has a hover read-out and a "Show as table" view.
import { chart, esc } from "./report.js?v=20261026e";

// Validated categorical slots (dataviz palette); cobalt only for single-series charts.
const SLOT = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#6250d6", "#e34948"];
const ONE = "#0f25bf";
const GREY = "#a1a1a6";
const BRAND = "#0f25bf", BRAND_LIGHT = "#8b9cec", GREEN = "#4a9d6e", NOTSET = "#c7c7cc";
const REGIONS = [["Stellar West", "West", BRAND], ["Stellar Central", "Central", BRAND_LIGHT], ["Stellar East", "East", GREEN]];
const ALLOC = ["US", "Brazil", "Mexico", "All LATAM", "Canada", "UK", "Germany", "France", "Africa", "Other", "Japan", "Korea", "China", "India", "SEA", "Global"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const nf = new Intl.NumberFormat("en-US");
const usd = (v) => (v == null || !isFinite(v) ? "–" : `$${nf.format(Math.round(v))}`);
const usdAxis = (v) => (v >= 1e6 ? `$${+(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `$${+(v / 1e3).toFixed(0)}k` : `$${v}`);
const usdShort = (v) => (v == null || !isFinite(v) ? "–" : v >= 1e6 ? `$${(v / 1e6).toFixed(v >= 1e7 ? 0 : 1)}M` : v >= 1e3 ? `$${(v / 1e3).toFixed(v >= 1e5 ? 0 : 1)}K` : `$${Math.round(v)}`);
const num = (v) => (v == null ? "–" : nf.format(Math.round(v)));
const compactN = (v) => (v == null ? "–" : new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(v));
const pct = (v) => (v == null || !isFinite(v) ? "–" : `${Math.round(v * 100)}%`);
const blank = (v) => { const t = String(v ?? "").trim(); return t === "" || t === "Select"; };
const toNum = (v) => { const t = String(v ?? "").replace(/[^\d.\-]/g, ""); return t && !isNaN(Number(t)) ? Number(t) : null; };
const normKey = (...v) => v.map((x) => String(x ?? "").trim().toLowerCase().replace(/\s+/g, " ")).join("|");

// "20/04" → ISO date. The tab is a financial year ("FY26/27", April–March): April–December belong to
// the first year, January–March to the second. Without a FY in the name, the year closest to today.
function sheetDate(v, sheetName) {
  const m = String(v ?? "").trim().match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/);
  if (!m) return null;
  const d = Number(m[1]), mo = Number(m[2]);
  if (d < 1 || d > 31 || mo < 1 || mo > 12) return null;
  const pad = (x) => String(x).padStart(2, "0");
  if (m[3]) return `${m[3].length === 2 ? "20" + m[3] : m[3]}-${pad(mo)}-${pad(d)}`;
  const fy = String(sheetName ?? "").match(/FY\s*(\d{2})\s*\/\s*(\d{2})/i);
  if (fy) return `20${mo >= 4 ? fy[1] : fy[2]}-${pad(mo)}-${pad(d)}`;
  const now = new Date(), y = now.getFullYear();
  return [y - 1, y, y + 1].map((yy) => `${yy}-${pad(mo)}-${pad(d)}`).sort((a, b) => Math.abs(Date.parse(a) - now) - Math.abs(Date.parse(b) - now))[0];
}
// "Fer & Cris", "Maria and Carol", "Fer, Cris" → ["Fer", "Cris"]
const people = (v) => String(v ?? "").split(/\s*(?:&|\+|,|\band\b|\/)\s*/i).map((x) => x.trim()).filter(Boolean).map((x) => x.charAt(0).toUpperCase() + x.slice(1));

// ---------- tooltip ----------
function tipEl() {
  let t = document.getElementById("an-tip");
  if (!t) { t = document.createElement("div"); t.id = "an-tip"; t.className = "tip tip-light"; t.setAttribute("role", "tooltip"); t.hidden = true; document.body.appendChild(t); }
  return t;
}
// Read-out box: content is rebuilt only when the hovered item changes; moving the pointer just moves the
// box (GPU transform, once per frame), so it tracks the cursor without lag.
let tipKey = null, tipPos = null, tipRaf = 0;
function placeTip() {
  tipRaf = 0;
  const t = document.getElementById("an-tip");
  if (!t || t.hidden || !tipPos) return;
  const { x, y } = tipPos, tw = t.offsetWidth, th = t.offsetHeight;
  const left = x + 18 + tw > innerWidth - 8 ? x - tw - 18 : x + 18;
  const top = Math.min(innerHeight - th - 8, Math.max(8, y - th / 2));
  t.style.transform = `translate3d(${Math.round(Math.max(8, left))}px, ${Math.round(top)}px, 0)`;
}
function showTip(e, rows, title, key) {
  const t = tipEl();
  if (key !== tipKey || t.hidden) {
    t.innerHTML = `${title ? `<div class="tip-date">${esc(title)}</div>` : ""}${rows.map(([color, label, value]) => `<div class="tip-row">${color ? `<i style="background:${color}"></i>` : "<span></span>"}<span>${esc(label)}</span><b>${esc(value)}</b></div>`).join("")}`;
    tipKey = key; t.hidden = false;
  }
  tipPos = { x: e.clientX, y: e.clientY };
  if (!tipRaf) tipRaf = requestAnimationFrame(placeTip);
}
const hideTip = () => { const t = document.getElementById("an-tip"); if (t) t.hidden = true; tipKey = null; };
function bindTips(root, lookup) {
  root.querySelectorAll("[data-tip]").forEach((el) => {
    const on = (e) => {
      const k = el.dataset.tip;
      if (k === tipKey && !document.getElementById("an-tip")?.hidden) { tipPos = { x: e.clientX, y: e.clientY }; if (!tipRaf) tipRaf = requestAnimationFrame(placeTip); return; }
      const x = lookup(k); if (x) showTip(e, x.rows, x.title, k);
    };
    el.addEventListener("pointermove", on, { passive: true });
    el.addEventListener("focus", () => { const b = el.getBoundingClientRect(); on({ clientX: b.right, clientY: b.top + b.height / 2 }); });
    el.addEventListener("pointerleave", hideTip);
    el.addEventListener("blur", hideTip);
  });
}

// ---------- card shell with a table twin ----------
function card({ id, title, note, wide = false, body, table, views = null, view = "" }) {
  return `<section class="an-card${wide ? " wide" : ""}" id="${id}">
    <div class="an-head"><h3>${esc(title)}</h3><span class="an-head-r">${note ? `<span class="muted small">${note}</span>` : ""}${views ? `<span class="seg an-view" role="group" aria-label="Chart type">${views.map(([k, l]) => `<button type="button" data-view="${id}:${k}" aria-pressed="${view === k}">${l}</button>`).join("")}</span>` : ""}</span></div>
    <div class="an-body">${body}</div>
    ${table ? `<div class="chart-foot"><button type="button" class="link-btn small" data-tbl="${id}">Show as table</button></div>
      <div class="chart-table" hidden data-tblbody="${id}">${table}</div>` : ""}
  </section>`;
}
const tableHtml = (head, rows) => `<div class="table-wrap"><table><thead><tr>${head.map((h, i) => `<th${i ? ' class="num"' : ""}>${esc(h)}</th>`).join("")}</tr></thead>
  <tbody>${rows.map((r) => `<tr>${r.map((c, i) => `<td${i ? ' class="num"' : ""}>${esc(c)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;

// Horizontal ranked bars (HTML): one colour unless a row brings its own.
function hbars(items, { fmt = usd, key = "hb", color = ONE } = {}) {
  if (!items.length) return `<p class="muted small an-empty">No data in this selection.</p>`;
  const max = Math.max(...items.map((i) => i.value), 1);
  return `<div class="hbars">${items.map((it, k) => `
    <div class="hb-row" tabindex="0" data-tip="${key}:${k}">
      <span class="hb-label" title="${esc(it.label)}">${esc(it.label)}${it.tag ? ` <span class="hb-tag">${esc(it.tag)}</span>` : ""}</span>
      <span class="hb-track"><i style="width:${Math.max(0.6, (it.value / max) * 100)}%;background:${it.color ?? color}"></i></span>
      <span class="hb-val">${esc(fmt(it.value))}${it.sub ? ` <span class="muted">${esc(it.sub)}</span>` : ""}</span>
    </div>`).join("")}</div>`;
}

const clip = (t, n) => (String(t).length > n ? `${String(t).slice(0, Math.max(1, n - 1)).trim()}…` : String(t));
// Brand ramp for pies: cobalt shades, then greens, then greys.
const RAMP = ["#0f25bf", "#3a4fd0", "#6577dd", "#8b9cec", "#b4c0f4", "#2f7d52", "#4a9d6e", "#7cbd96", "#a9d5bb", "#c7c7cc", "#dedee3"];

// Donut with a legend beside it; hovering a slice or its legend row highlights it.
function donut(items, { key = "pie", fmt = usd, center = "" } = {}) {
  const total = items.reduce((t, it) => t + Math.max(0, it.value), 0);
  if (!total) return `<p class="muted small an-empty">No data in this selection.</p>`;
  const R = 92, r = 58, C = 110;
  let a0 = -Math.PI / 2;
  const arcs = items.map((it, i) => {
    const frac = Math.max(0, it.value) / total, a1 = a0 + frac * Math.PI * 2;
    const big = a1 - a0 > Math.PI ? 1 : 0, gapA = items.length > 1 ? 0.012 : 0;
    const s0 = a0 + gapA, s1 = Math.max(s0, a1 - gapA);
    const p = (rad, a) => `${(C + rad * Math.cos(a)).toFixed(2)},${(C + rad * Math.sin(a)).toFixed(2)}`;
    const d = frac >= 0.999 ? `M${C},${C - R} A${R},${R} 0 1 1 ${C - 0.01},${C - R} L${C - 0.01},${C - r} A${r},${r} 0 1 0 ${C},${C - r} Z`
      : `M${p(R, s0)} A${R},${R} 0 ${big} 1 ${p(R, s1)} L${p(r, s1)} A${r},${r} 0 ${big} 0 ${p(r, s0)} Z`;
    a0 = a1;
    return `<path d="${d}" fill="${it.color ?? RAMP[i % RAMP.length]}" data-tip="${key}:${i}" data-slice="${i}" tabindex="0"/>`;
  });
  return `<div class="an-donut" data-donut>
    <svg viewBox="0 0 220 220" width="220" height="220" role="img">${arcs.join("")}
      <text x="110" y="106" text-anchor="middle" class="dn-total">${esc(fmt(total))}</text><text x="110" y="126" text-anchor="middle" class="dn-sub">${esc(center)}</text></svg>
    <ul class="dn-legend">${items.map((it, i) => `<li data-tip="${key}:${i}" data-slice="${i}" tabindex="0"><i style="background:${it.color ?? RAMP[i % RAMP.length]}"></i><span>${esc(it.label)}</span><b>${esc(fmt(it.value))}</b><em>${pct(Math.max(0, it.value) / total)}</em></li>`).join("")}</ul>
  </div>`;
}

// Grouped columns (SVG), the demo's style: bars of one group sit side by side with rounded tops,
// the whole group lights up on hover and one read-out follows the pointer.
function groupBars(groups, series, width, { key = "gb", H = 280, fmt = usdShort, compact = false } = {}) {
  const W = Math.max(320, width), L = 56, R = 8, T = 12, B = 30;
  const maxV = Math.max(1, ...groups.flatMap((_, gi) => series.map((se) => se.values[gi] ?? 0)));
  const stepRaw = maxV / 4, mag = 10 ** Math.floor(Math.log10(stepRaw)), step = [1, 2, 2.5, 3, 5, 6, 10].map((f) => f * mag).find((x) => x >= stepRaw);
  const hi = Math.ceil(maxV / step) * step;
  const y = (v) => T + (1 - Math.max(0, v) / hi) * (H - T - B);
  const band = (W - L - R) / groups.length, gap = 6;
  const n = compact ? Math.max(1, ...groups.map((_, gi) => series.filter((se) => se.values[gi] > 0).length)) : series.length;
  const bw = Math.min(64, Math.max(6, (band * 0.8 - gap * (n - 1)) / n));
  const ticks = []; for (let v = 0; v <= hi + step / 2; v += step) ticks.push(v);
  const bar = (x, v, color) => {
    if (!(v > 0)) return "";
    const y0 = y(0), y1 = y(v), r = Math.min(6, bw / 2, (y0 - y1) / 2);
    return `<path d="M${x},${y0} V${y1 + r} Q${x},${y1} ${x + r},${y1} H${x + bw - r} Q${x + bw},${y1} ${x + bw},${y1 + r} V${y0} Z" fill="${color}"/>`;
  };
  return `<svg class="gb" viewBox="0 0 ${W} ${H}" width="100%" height="${H}" role="img">
    <g class="grid">${ticks.map((v) => `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" ${v === 0 ? 'class="zero"' : ""}/><text x="${L - 10}" y="${y(v) + 4}" text-anchor="end">${fmt(v)}</text>`).join("")}</g>
    ${groups.map((g, gi) => {
      const x0 = L + band * gi;
      // compact: only this group's non-zero bars, centred, so they sit together.
      const here = compact ? series.filter((se) => se.values[gi] > 0) : series;
      const w = here.length * bw + gap * Math.max(0, here.length - 1), start = x0 + (band - w) / 2;
      return `<g class="gb-g"><rect class="gb-hit" x="${x0 + 2}" y="${T}" width="${band - 4}" height="${H - T - B}" rx="8" data-tip="${key}:${gi}" tabindex="0" aria-label="${esc(g)}"/>
        ${here.map((se, si) => bar(start + si * (bw + gap), se.values[gi], se.colors?.[gi] ?? se.color)).join("")}
        <text class="gb-x" x="${x0 + band / 2}" y="${H - 8}" text-anchor="middle">${esc(clip(g, Math.max(3, Math.floor(band / 7.5))))}</text></g>`;
    }).join("")}
  </svg>`;
}

// Data is kept for two minutes, so zooming in and out of charts doesn't reload anything.
let DATA = null, DATA_AT = 0;
const DRILL = { region: "Client market", month: "Start month", client: "Client", market: "Market", dri: "DRI", label: "Label type" };
const drillPath = (pairs) => `#/analytics${pairs.map(([k, v]) => `/${k}/${encodeURIComponent(v)}`).join("")}`;
const regionName = (v) => (v === "none" ? "Not set" : (REGIONS.find(([k]) => k === v) ?? [, v])[1]);
const monthName = (m) => `${MONTHS[Number(m.slice(5)) - 1]} ${m.slice(0, 4)}`;
export const drillTitle = (k, v) => (k === "region" ? regionName(v) : k === "month" ? monthName(v) : v);

export async function renderAnalytics(app, sb, { isCurrent, go, parts = [] }) {
  // #/analytics/<kind>/<value>[/<kind>/<value>…]: a zoomed-in view, filtered by each pair in turn.
  const pairs = [];
  for (let i = 1; i + 1 < parts.length; i += 2) if (DRILL[parts[i]]) pairs.push([parts[i], decodeURIComponent(parts[i + 1])]);
  const fresh = DATA && Date.now() - DATA_AT < 120000;
  if (!fresh) app.innerHTML = `<p class="muted pad">Loading analytics…</p>`;
  const [snap, fx, camps, daily, folders, markets] = fresh ? DATA : await Promise.all([
    sb.from("overview_snapshot").select("sheet,headers,rows,synced_at").eq("id", 1).maybeSingle(),
    sb.from("fx_rates").select("currency,per_usd,rate_date"),
    sb.from("campaign_summary").select("id,artist,song,po_number,status,currency,budget,spend,total_plays,live_posts,cost_per_view"),
    sb.from("campaign_daily_stats").select("campaign_id,stat_date,plays").order("stat_date"),
    sb.from("campaign_folders").select("id,campaign_id,name,market"),
    sb.from("campaign_markets").select("campaign_id,market,share_percent,amount"),
  ]);
  if (!fresh) { DATA = [snap, fx, camps, daily, folders, markets]; DATA_AT = Date.now(); }
  if (!isCurrent()) return;
  const s = snap.data ?? {};
  const rate = Object.fromEntries((fx.data ?? []).map((r) => [r.currency, Number(r.per_usd)]));
  const rateDate = fx.data?.[0]?.rate_date;
  const toUsd = (v, cur) => { if (v == null) return null; const c = String(cur ?? "").toUpperCase().replace("JYP", "JPY"); return rate[c] ? v / rate[c] : null; };
  const H = s.headers ?? [];
  const idx = {}; H.forEach((h, i) => { if (!(h in idx)) idx[h] = i; });
  const trackerByKey = new Map((camps.data ?? []).filter((c) => c.po_number).map((c) => [normKey(c.artist, c.song, c.po_number), c]));

  // One clean record per sheet row.
  const all = (s.rows ?? []).map((r) => {
    const g = (h) => (idx[h] == null || blank(r.values[idx[h]]) ? "" : String(r.values[idx[h]]).trim());
    const cur = g("Currency");
    const price = toNum(g("Price"));
    const start = sheetDate(g("Start Date"), s.sheet);
    const cost = toNum(g("Campaign Cost"));
    const allocs = Object.fromEntries(ALLOC.map((m) => [m, toUsd(toNum(g(m)), cur)]).filter(([, v]) => v));
    return {
      row: r.row, artist: g("Artist Name"), song: g("Song Name (s) or Project Name"), po: g("Stellar PO no."),
      status: g("Status"), client: g("Client") || "Unknown", label: g("Major / Indie / Other") || "Unknown",
      region: g("Client Market"), dris: people(g("Stellar DRI")), start, month: start ? start.slice(0, 7) : null,
      cur, priceUsd: toUsd(price, cur), costUsd: toUsd(cost, cur),
      invoiced: g("Invoice Status") === "Invoiced", paid: g("Paid") === "Paid", allocs,
      camp: trackerByKey.get(normKey(g("Artist Name"), g("Song Name (s) or Project Name"), g("Stellar PO no."))) ?? null,
    };
  }).filter((x) => x.artist || x.po);

  const monthsAll = [...new Set(all.map((x) => x.month).filter(Boolean))].sort();
  const quarters = (() => {
    // Financial-year quarters (April start) that contain campaigns.
    const q = new Map();
    for (const m of monthsAll) {
      const [y, mo] = m.split("-").map(Number);
      const fyStart = mo >= 4 ? y : y - 1, qn = Math.floor(((mo - 4 + 12) % 12) / 3) + 1;
      q.set(`${fyStart}-Q${qn}`, `Q${qn} ${["Apr–Jun", "Jul–Sep", "Oct–Dec", "Jan–Mar"][qn - 1]}`);
    }
    return [...q.entries()];
  })();
  const inQuarter = (m, key) => { if (!m) return false; const [y, mo] = m.split("-").map(Number); const fyStart = mo >= 4 ? y : y - 1; const qn = Math.floor(((mo - 4 + 12) % 12) / 3) + 1; return key === `${fyStart}-Q${qn}`; };
  const allDris = [...new Set(all.flatMap((x) => x.dris))].sort();
  const VIEWS = [["cols", "Columns"], ["pie", "Pie"], ["list", "List"]];
  const st = { period: "", region: "", dri: "", views: (() => { try { return JSON.parse(localStorage.getItem("an-views") ?? "{}"); } catch { return {}; } })(), ...(() => { try { return JSON.parse(sessionStorage.getItem("an-filters") ?? "{}"); } catch { return {}; } })(), campSort: "margin", campAll: false, tab: (() => { try { return localStorage.getItem("an-tab") || "money"; } catch { return "money"; } })() };

  const drilled = pairs.length > 0;
  const crumbs = pairs.map(([k, v], i) => ({ k, v, title: drillTitle(k, v), href: drillPath(pairs.slice(0, i + 1)) }));
  app.innerHTML = `
    <div class="page-head${drilled ? " an-drill-head" : ""}">
      <div>${drilled ? `<nav class="an-crumbs" aria-label="Zoom path"><a href="#/analytics">Analytics</a>${crumbs.slice(0, -1).map((c) => ` <span>›</span> <a href="${esc(c.href)}">${esc(c.title)}</a>`).join("")} <span>›</span></nav>` : ""}
        <h1>${drilled ? esc(crumbs.at(-1).title) : "Analytics"}</h1>
        <p class="muted small" style="margin:6px 0 0">${drilled ? `${esc(crumbs.map((c) => DRILL[c.k]).join(" · "))} · everything below is only these campaigns · click any chart to zoom further` : `${esc(s.sheet ?? "Campaign Overview")} · ${all.length} campaigns · amounts in USD${rateDate ? ` at ECB rates from ${esc(rateDate)}` : ""} · click any chart to zoom in`}</p></div>
    </div>
    ${!all.length ? `<div class="panel"><p>No campaigns yet. Analytics fills in from the Campaign overview once the sheet has been read.</p></div>` : `
    <div class="filters an-filters">
      <select id="an-period" aria-label="Period"><option value="">Whole year</option>${quarters.map(([k, l]) => `<option value="${k}">${esc(l)}</option>`).join("")}${monthsAll.map((m) => `<option value="m:${m}">${MONTHS[Number(m.slice(5)) - 1]} ${m.slice(0, 4)}</option>`).join("")}</select>
      <select id="an-region" aria-label="Client market"><option value="">All client markets</option>${REGIONS.map(([k, l]) => `<option value="${esc(k)}">${esc(l)}</option>`).join("")}</select>
      <select id="an-dri" aria-label="Stellar DRI"><option value="">Everyone</option>${allDris.map((d) => `<option>${esc(d)}</option>`).join("")}</select>
    </div>
    <div id="an-out"></div>`}`;
  if (!all.length) return;
  const out = document.getElementById("an-out");

  function drillMatch(x, k, v) {
    if (k === "region") return v === "none" ? !REGIONS.some(([r]) => r === x.region) : x.region === v;
    if (k === "month") return x.month === v;
    if (k === "client") return x.client === v;
    if (k === "market") return (x.allocs[v] ?? 0) > 0;
    if (k === "dri") return x.dris.includes(v);
    if (k === "label") return x.label === v;
    return true;
  }
  function draw() {
    const list = all.filter((x) =>
      (!st.period || (st.period.startsWith("m:") ? x.month === st.period.slice(2) : inQuarter(x.month, st.period))) &&
      (!st.region || x.region === st.region) && (!st.dri || x.dris.includes(st.dri)) && pairs.every(([k, v]) => drillMatch(x, k, v)));
    const priced = list.filter((x) => x.priceUsd != null);
    const booked = priced.reduce((t, x) => t + x.priceUsd, 0);
    const invoiced = priced.filter((x) => x.invoiced).reduce((t, x) => t + x.priceUsd, 0);
    const paid = priced.filter((x) => x.paid).reduce((t, x) => t + x.priceUsd, 0);
    const withCost = priced.filter((x) => x.costUsd != null && x.priceUsd > 0);
    const avgMargin = withCost.length ? withCost.reduce((t, x) => t + (x.priceUsd - x.costUsd), 0) / withCost.reduce((t, x) => t + x.priceUsd, 0) : null;
    const W = Math.max(320, (out.clientWidth || 1000));
    const half = W >= 900 ? Math.floor((W - 20) / 2) - 40 : W - 40;

    // 2. revenue by month, by region
    const months = (st.period.startsWith("m:") ? [st.period.slice(2)] : [...new Set(list.map((x) => x.month).filter(Boolean))].sort()).map((m) => ({ key: m, label: `${MONTHS[Number(m.slice(5)) - 1]}${monthsAll[0]?.slice(0, 4) !== monthsAll.at(-1)?.slice(0, 4) ? ` ${m.slice(2, 4)}` : ""}` }));
    const regionSeries = [...REGIONS.map(([k, l, c]) => ({ name: l, color: c, match: (x) => x.region === k })), { name: "Not set", color: NOTSET, match: (x) => !REGIONS.some(([k]) => k === x.region) }]
      .map((se) => ({ ...se, values: months.map((m) => priced.filter((x) => x.month === m.key && se.match(x)).reduce((t, x) => t + x.priceUsd, 0)) }))
      .filter((se) => se.values.some((v) => v > 0));
    // 3. finished but not invoiced
    const toInvoice = priced.filter((x) => x.status === "Completed" && !x.invoiced).sort((a, b) => b.priceUsd - a.priceUsd);
    // 4. clients
    const byClient = new Map();
    for (const x of priced) { const c = byClient.get(x.client) ?? { label: x.client, value: 0, n: 0, labels: new Set() }; c.value += x.priceUsd; c.n++; c.labels.add(x.label); byClient.set(x.client, c); }
    const clients = [...byClient.values()].sort((a, b) => b.value - a.value);
    const topClients = clients.slice(0, 10).map((c) => ({ key: c.label, label: c.label, value: c.value, sub: `${c.n} campaign${c.n === 1 ? "" : "s"}`, tag: [...c.labels].filter((l) => l !== "Unknown").join("/") }));
    const restClients = clients.slice(10);
    if (restClients.length) topClients.push({ label: `Other (${restClients.length} clients)`, value: restClients.reduce((t, c) => t + c.value, 0), sub: `${restClients.reduce((t, c) => t + c.n, 0)} campaigns`, color: NOTSET });
    const labelSplit = ["Major", "Indie", "Other"].map((l, i) => ({ l, color: [BRAND, BRAND_LIGHT, GREEN][i], v: priced.filter((x) => x.label === l).reduce((t, x) => t + x.priceUsd, 0), n: priced.filter((x) => x.label === l).length }));
    const labelTotal = labelSplit.reduce((t, x) => t + x.v, 0);
    // 5. budget by market
    const byMarket = ALLOC.map((m) => ({ label: m, value: list.reduce((t, x) => t + (x.allocs[m] ?? 0), 0), n: list.filter((x) => x.allocs[m]).length })).filter((m) => m.value > 0).sort((a, b) => b.value - a.value);
    const allocN = list.filter((x) => Object.keys(x.allocs).length).length;
    // 6. team (shared campaigns split equally)
    const byPerson = new Map();
    for (const x of priced) for (const p of x.dris) { const e = byPerson.get(p) ?? { label: p, value: 0, n: 0 }; e.value += x.priceUsd / x.dris.length; e.n++; byPerson.set(p, e); }
    const team = [...byPerson.values()].sort((a, b) => b.value - a.value).map((e) => ({ ...e, sub: `${e.n} campaign${e.n === 1 ? "" : "s"}` }));
    // 8. performance (tracker)
    const tracked = list.filter((x) => x.camp);
    const trackedIds = new Set(tracked.map((x) => x.camp.id));
    const dailyRows = (daily.data ?? []).filter((r) => trackedIds.has(r.campaign_id));
    const dates = [...new Set(dailyRows.map((r) => r.stat_date))].sort();
    const viewsByDate = dates.map((d) => dailyRows.filter((r) => r.stat_date === d).reduce((t, r) => t + Number(r.plays ?? 0), 0));
    const topViews = tracked.filter((x) => Number(x.camp.total_plays) > 0).sort((a, b) => b.camp.total_plays - a.camp.total_plays).slice(0, 10)
      .map((x) => ({ camp: x.camp, label: `${x.artist}${x.song ? ` – ${x.song}` : ""}`, value: Number(x.camp.total_plays), sub: x.priceUsd ? `${usdShort((x.priceUsd / x.camp.total_plays) * 1000)} per 1K` : "" }));
    const cpmRows = tracked.filter((x) => x.priceUsd && Number(x.camp.total_plays) > 0);
    const totalViews = tracked.reduce((t, x) => t + Number(x.camp.total_plays ?? 0), 0);
    const cpm = cpmRows.length ? (cpmRows.reduce((t, x) => t + x.priceUsd, 0) / cpmRows.reduce((t, x) => t + Number(x.camp.total_plays), 0)) * 1000 : null;

    // Margin per campaign: the sheet's campaign cost, else creator spend recorded in the tracker.
    const costOf = (x) => x.costUsd ?? (x.camp && Number(x.camp.spend) > 0 ? toUsd(Number(x.camp.spend), x.camp.currency) : null);
    const costed = priced.filter((x) => costOf(x) != null && x.priceUsd > 0);
    const costTotal = costed.reduce((t, x) => t + costOf(x), 0);
    const costedRev = costed.reduce((t, x) => t + x.priceUsd, 0);
    const marginAll = costedRev ? (costedRev - costTotal) / costedRev : null;
    // By client region (the demo's "by territory").
    const regions = [...REGIONS, ["", "Not set", NOTSET]].map(([k, l, c]) => {
      const xs = priced.filter((x) => (k ? x.region === k : !REGIONS.some(([r]) => r === x.region)));
      const cs = xs.filter((x) => costOf(x) != null);
      const rev = xs.reduce((t, x) => t + x.priceUsd, 0), crev = cs.reduce((t, x) => t + x.priceUsd, 0), cost = cs.reduce((t, x) => t + costOf(x), 0);
      return { key: k || "none", label: l, color: c, rev, n: xs.length, cost, crev, margin: crev ? (crev - cost) / crev : null, nc: cs.length };
    }).filter((r) => r.n);
    const maxRegion = Math.max(...regions.map((r) => r.rev), 1);
    // By campaign, ranked.
    const campRows = priced.map((x) => {
      const c = costOf(x);
      return { name: `${x.artist}${x.song ? ` – ${x.song}` : ""}`, client: x.client, region: (REGIONS.find(([k]) => k === x.region) ?? [, ""])[1], rev: x.priceUsd, cost: c, margin: c != null ? (x.priceUsd - c) / x.priceUsd : null, camp: x.camp };
    });
    const sortCamps = (rs) => [...rs].sort(st.campSort === "rev" ? (a, b) => b.rev - a.rev : (a, b) => (b.margin ?? -9) - (a.margin ?? -9) || b.rev - a.rev);
    const campsSorted = sortCamps(campRows);
    const campShown = st.campAll ? campsSorted : campsSorted.slice(0, 12);

    // A chart that can be shown as columns, a pie or a ranked list.
    const colsTodo = [];
    const vis = (id, items, { fmt = usd, key, center = "" } = {}) => {
      const view = st.views[id] ?? "cols";
      if (!items.length) return { view, body: `<p class="muted small an-empty">No data in this selection.</p>` };
      if (view === "list") return { view, body: hbars(items, { fmt, key }) };
      if (view === "pie") return { view, body: donut(items.map((it, i) => ({ ...it, color: it.color ?? RAMP[i % RAMP.length] })), { key, fmt, center }) };
      colsTodo.push({ id, items, fmt, key });
      return { view, body: `<div class="an-svg" data-cols="${id}"></div>` };
    };
    const regionPie = regions.map((r) => ({ key: r.key, label: r.label, value: r.rev, color: r.color, sub: `${r.n} campaign${r.n === 1 ? "" : "s"}` }));
    const monthPie = months.map((m, i) => ({ key: m.key, label: m.label, value: regionSeries.reduce((t, se) => t + se.values[i], 0) })).filter((m) => m.value > 0);
    const campByRev = [...campRows].sort((a, b) => b.rev - a.rev);
    const campPie = campByRev.slice(0, 10).map((r) => ({ label: r.name, value: r.rev, sub: r.client, camp: r.camp }));
    if (campByRev.length > 10) campPie.push({ label: `Other (${campByRev.length - 10} campaigns)`, value: campByRev.slice(10).reduce((t, r) => t + r.rev, 0), color: NOTSET });
    const cashPie = [{ label: "Paid", value: paid, color: GREEN }, { label: "Invoiced, not paid", value: Math.max(0, invoiced - paid), color: BRAND }, { label: "Not invoiced yet", value: Math.max(0, booked - invoiced), color: BRAND_LIGHT }];
    const cashCols = [{ label: "Booked", value: booked, color: BRAND_LIGHT }, { label: "Invoiced", value: invoiced, color: BRAND }, { label: "Paid", value: paid, color: GREEN }];
    const vw = (id, d = "cols") => st.views[id] ?? d;
    const tab = st.tab;
    const show = (t) => drilled || tab === t;
    const tabs = [["money", "Money"], ["clients", "Clients & markets"], ["team", "Team"], ["performance", "Performance"]];
    const hero = (label, value, sub, main = false) => `<div class="an-hero-card${main ? " main" : ""}"><div class="l">${esc(label)}</div><div class="n">${value}</div>${sub ? `<div class="d">${sub}</div>` : ""}</div>`;
    const marginBar = (m) => m == null ? `<span class="muted small">no cost yet</span>`
      : `<span class="an-mbar"><i class="${m < 0 ? "neg" : m < 0.3 ? "low" : ""}" style="width:${Math.max(2, Math.min(100, Math.abs(m) * 100))}%"></i></span><b class="${m < 0 ? "neg" : ""}">${pct(m)}</b>`;

    out.innerHTML = `
      <div class="an-hero">
        ${hero("Revenue booked", usdShort(booked), `${priced.length} priced campaign${priced.length === 1 ? "" : "s"} · ${pct(booked ? invoiced / booked : null)} invoiced`, true)}
        ${hero("Campaign costs", usdShort(costed.length ? costTotal : null), `${costed.length} of ${priced.length} campaigns have a cost`)}
        ${hero("Margin", pct(marginAll), costedRev ? `${usdShort(costedRev - costTotal)} on campaigns with a cost` : "Fills in as costs are recorded")}
      </div>
      <div class="an-mini">
        <span><b>${num(list.length)}</b> campaigns · ${list.filter((x) => x.status === "Active").length} active</span>
        <span><b>${usdShort(priced.length ? booked / priced.length : null)}</b> average deal</span>
        <span><b>${usdShort(booked - invoiced)}</b> still to invoice</span>
        <span><b>${usdShort(paid)}</b> paid</span>
      </div>
      <div class="tabs an-tabs" role="tablist" aria-label="Analytics views"${drilled ? " hidden" : ""}>
        ${tabs.map(([k, l]) => `<button type="button" role="tab" data-antab="${k}" aria-selected="${tab === k}">${l}</button>`).join("")}
      </div>
      ${show("money") ? `
      <div class="an-grid">
        ${card({ id: "an-regions", wide: true, title: "By client market", note: vw("an-regions") === "pie" ? "Share of revenue" : "Costs and margin count only campaigns with a recorded cost", views: [["cols", "Columns"], ["pie", "Pie"]], view: vw("an-regions"),
          body: `${vw("an-regions") === "pie" ? donut(regionPie, { key: "rgp", center: "revenue" }) : `<div class="legend"><span><i style="background:${BRAND}"></i>Revenue</span><span><i style="background:${BRAND_LIGHT}"></i>Costs</span><span><i style="background:${GREEN}"></i>Margin</span></div>
            <div class="an-svg" id="an-regions-svg"></div>`}
            <div class="an-mtiles">${regions.map((r) => `<div class="an-mtile"><span>${esc(r.label)}</span><b class="${r.margin != null && r.margin < 0 ? "neg" : ""}">${pct(r.margin)}</b><i>${r.nc ? `margin · ${r.nc} of ${r.n} with a cost` : "no costs yet"}</i></div>`).join("")}</div>`,
          table: tableHtml(["Client market", "Campaigns", "Revenue (USD)", "Costs (USD)", "Margin"], regions.map((r) => [r.label, String(r.n), usd(r.rev), r.nc ? usd(r.cost) : "–", pct(r.margin)])) })}
        ${card({ id: "an-months", wide: true, title: "Revenue by start month", note: `${vw("an-months") === "pie" ? "Share of revenue per month" : "By client market"} · ${priced.filter((x) => x.month).length} campaigns with a start date`, views: [["cols", "Columns"], ["pie", "Pie"]], view: vw("an-months"),
          body: vw("an-months") === "pie" ? donut(monthPie, { key: "mop", center: "revenue" }) : `<div class="legend">${regionSeries.map((se) => `<span><i style="background:${se.color}"></i>${esc(se.name)}</span>`).join("")}</div><div class="an-svg" id="an-months-svg"></div>`,
          table: tableHtml(["Month", ...regionSeries.map((se) => se.name), "Total"], months.map((m, i) => [m.label, ...regionSeries.map((se) => usd(se.values[i])), usd(regionSeries.reduce((t, se) => t + se.values[i], 0))])) })}
        ${card({ id: "an-camps", wide: true, title: "By campaign", views: [["table", "Table"], ["pie", "Pie"]], view: vw("an-camps", "table"),
          note: vw("an-camps", "table") === "pie" ? "Share of revenue, top 10" : `<span class="seg an-sort" role="group" aria-label="Sort"><button type="button" data-csort="margin" aria-pressed="${st.campSort !== "rev"}">Margin</button><button type="button" data-csort="rev" aria-pressed="${st.campSort === "rev"}">Revenue</button></span>`,
          body: vw("an-camps", "table") === "pie" ? donut(campPie, { key: "cp", center: "revenue" }) : `<div class="table-wrap an-camps-wrap"><table class="an-camps"><colgroup><col><col class="c-rev"><col class="c-cost"><col class="c-m"></colgroup>
            <thead><tr><th>Campaign</th><th class="num">Revenue</th><th class="num">Costs</th><th>Margin</th></tr></thead>
            <tbody>${campShown.map((r) => `<tr${r.camp ? ` class="row-link" data-go="#/c/${esc(r.camp.id)}"` : ""}><td><div class="an-cname">${esc(r.name)}</div><div class="muted small">${esc(r.client)}${r.region ? ` · ${esc(r.region)}` : ""}</div></td>
              <td class="num">${usd(r.rev)}</td><td class="num">${r.cost != null ? usd(r.cost) : "–"}</td><td class="an-mcell">${marginBar(r.margin)}</td></tr>`).join("")}</tbody></table></div>
            ${campsSorted.length > 12 ? `<button type="button" class="link-btn small an-more" data-campall>${st.campAll ? "Show top 12" : `Show all ${campsSorted.length}`}</button>` : ""}
            <p class="muted small" style="margin:8px 0 0">Costs come from the sheet's campaign cost, or the creator payouts recorded in the tracker. Campaigns still running look more profitable until their payouts are in.</p>` })}
        ${card({ id: "an-cash", wide: true, title: "Booked, invoiced and paid", note: `${priced.length} campaigns`, views: VIEWS, view: vw("an-cash"),
          body: (vw("an-cash") === "pie" ? donut(cashPie, { key: "cashp", center: "booked" }) : vw("an-cash") === "list"
            ? hbars([{ label: "Booked", value: booked }, { label: "Invoiced", value: invoiced, sub: pct(booked ? invoiced / booked : null) }, { label: "Paid", value: paid, sub: pct(booked ? paid / booked : null) }], { key: "cash" })
            : `<div class="an-svg" id="an-cash-svg"></div>`)
            + (toInvoice.length ? `<div class="an-list"><h4>Finished, not invoiced yet <span class="muted">${toInvoice.length} · ${usdShort(toInvoice.reduce((t, x) => t + x.priceUsd, 0))}</span></h4>
              <ul>${toInvoice.slice(0, 6).map((x) => `<li><span>${esc(x.artist)}${x.song ? ` – ${esc(x.song)}` : ""} <span class="muted">${esc(x.client)}</span></span><b>${usd(x.priceUsd)}</b></li>`).join("")}</ul>
              ${toInvoice.length > 6 ? `<a href="#/" class="small" data-go-inv>See all ${toInvoice.length} in the Campaign overview</a>` : ""}</div>` : `<p class="muted small">Every finished campaign is invoiced.</p>`),
          table: tableHtml(["Campaign", "Client", "Price (USD)"], toInvoice.map((x) => [`${x.artist}${x.song ? ` – ${x.song}` : ""}`, x.client, usd(x.priceUsd)])) })}
      </div>` : ""}
      ${show("clients") ? (() => {
        const cl = vis("an-clients", topClients, { key: "cl", center: "revenue" });
        const mk = vis("an-markets", byMarket.map((m) => ({ ...m, sub: `${m.n} campaign${m.n === 1 ? "" : "s"}` })), { key: "mk", center: "budget" });
        return `
      <div class="an-grid">
        ${card({ id: "an-clients", wide: true, title: "Top clients", note: `${clients.length} clients`, views: VIEWS, view: cl.view,
          body: (labelTotal ? `<div class="an-labelsplit"><div class="an-split" aria-label="Major, indie and other share of revenue">${labelSplit.filter((x) => x.v).map((x, i) => `<i style="flex:${x.v};background:${x.color}" data-tip="lbl:${i}" tabindex="0"></i>`).join("")}</div>
            <div class="legend">${labelSplit.filter((x) => x.v).map((x) => `<span><i style="background:${x.color}"></i>${x.l} ${pct(x.v / labelTotal)}</span>`).join("")}</div></div>` : "") + cl.body,
          table: tableHtml(["Client", "Campaigns", "Revenue (USD)"], clients.map((c) => [c.label, String(c.n), usd(c.value)])) })}
        ${card({ id: "an-markets", wide: true, title: "Where budgets go", note: `Budget allocations · ${allocN} of ${list.length} campaigns have a split`, views: VIEWS, view: mk.view, body: mk.body,
          table: tableHtml(["Market", "Campaigns", "Budget (USD)"], byMarket.map((m) => [m.label, String(m.n), usd(m.value)])) })}
      </div>`;
      })() : ""}
      ${show("team") ? (() => {
        const tm = vis("an-team", team, { key: "tm", center: "revenue" });
        return `
      <div class="an-hero an-hero-sm">
        <div class="an-hero-card main"><div class="l">People</div><div class="n">${team.length}</div><div class="d">DRIs with priced campaigns</div></div>
        <div class="an-hero-card"><div class="l">Top DRI</div><div class="n an-n-text">${esc(team[0]?.label ?? "–")}</div><div class="d">${team[0] ? `${usdShort(team[0].value)} · ${team[0].sub}` : ""}</div></div>
        <div class="an-hero-card"><div class="l">Average per DRI</div><div class="n">${usdShort(team.length ? team.reduce((t, x) => t + x.value, 0) / team.length : null)}</div><div class="d">shared campaigns split equally</div></div>
      </div>
      <div class="an-grid">
        ${card({ id: "an-team", wide: true, title: "Revenue per DRI", note: "Shared campaigns split equally", views: VIEWS, view: tm.view, body: tm.body,
          table: tableHtml(["DRI", "Campaigns", "Revenue (USD)"], team.map((t) => [t.label, String(t.n), usd(t.value)])) })}
      </div>`;
      })() : ""}
      ${show("performance") ? (!tracked.length ? `<div class="panel" style="margin-top:18px"><p class="muted" style="margin:0">None of these campaigns are in the tracker yet. Use <b>Create</b> on the Campaign overview to start tracking them; views and cost per view appear here.</p></div>` : (() => {
        const tv = vis("an-top", topViews, { key: "tv", fmt: compactN, center: "views" });
        return `
      <div class="an-hero an-hero-sm">
        <div class="an-hero-card main"><div class="l">Views</div><div class="n">${compactN(totalViews)}</div><div class="d">across ${tracked.length} tracked campaign${tracked.length === 1 ? "" : "s"}</div></div>
        <div class="an-hero-card"><div class="l">Price per 1,000 views</div><div class="n">${cpm != null ? `$${cpm.toFixed(2)}` : "–"}</div><div class="d">${cpmRows.length} campaigns with a price and views</div></div>
        <div class="an-hero-card"><div class="l">Live posts</div><div class="n">${num(tracked.reduce((t, x) => t + Number(x.camp.live_posts ?? 0), 0))}</div><div class="d">in tracked campaigns</div></div>
      </div>
      <div class="an-grid">
        ${card({ id: "an-views", wide: true, title: "Views over time", note: "All tracked campaigns together", body: `<div id="an-views-chart"></div>` })}
        ${card({ id: "an-top", wide: true, title: "Top campaigns by views", note: "With price per 1,000 views", views: VIEWS, view: tv.view, body: tv.body,
          table: tableHtml(["Campaign", "Views", "Price per 1K views"], topViews.map((t) => [t.label, num(t.value), t.sub])) })}
      </div>`;
      })()) : ""}`;
    // In a zoomed view, the chart for the dimension we zoomed into would be a single bar: leave it out.
    for (const [k] of pairs) out.querySelector(`#${{ region: "an-regions", month: "an-months", client: "an-clients", market: "an-markets", dri: "an-team" }[k] ?? "none"}`)?.remove();
    for (const c of colsTodo) {
      const el = out.querySelector(`[data-cols="${c.id}"]`);
      if (el) el.innerHTML = groupBars(c.items.map((it) => it.label), [{ name: "Value", color: BRAND, colors: c.items.map((it) => it.color ?? BRAND), values: c.items.map((it) => it.value) }], el.clientWidth || W,
        { key: c.key, fmt: c.fmt === compactN ? compactN : usdAxis });
    }
    out.querySelectorAll("[data-view]").forEach((b) => (b.onclick = () => {
      const [id, v] = b.dataset.view.split(":"); st.views[id] = v;
      try { localStorage.setItem("an-views", JSON.stringify(st.views)); } catch { /* ignore */ }
      const y = scrollY; draw(); scrollTo(0, y);
    }));
    out.querySelectorAll("[data-donut]").forEach((d) => d.querySelectorAll("[data-slice]").forEach((el) => {
      const on = () => { d.classList.add("dim"); d.querySelectorAll(`[data-slice="${el.dataset.slice}"]`).forEach((x) => x.classList.add("on")); };
      const off = () => { d.classList.remove("dim"); d.querySelectorAll(".on").forEach((x) => x.classList.remove("on")); };
      el.addEventListener("pointerenter", on); el.addEventListener("pointerleave", off);
      el.addEventListener("focus", on); el.addEventListener("blur", off);
    }));
    out.querySelectorAll("[data-antab]").forEach((b) => (b.onclick = () => { st.tab = b.dataset.antab; try { localStorage.setItem("an-tab", st.tab); } catch { /* ignore */ } draw(); }));
    out.querySelectorAll("[data-csort]").forEach((b) => (b.onclick = () => { st.campSort = b.dataset.csort; draw(); }));
    out.querySelector("[data-campall]")?.addEventListener("click", () => { st.campAll = !st.campAll; draw(); });
    out.querySelectorAll("tr[data-go]").forEach((tr) => (tr.onclick = () => go(tr.dataset.go)));

    // Charts drawn at their real width.
    const mEl = document.getElementById("an-months-svg");
    if (mEl) mEl.innerHTML = months.length ? groupBars(months.map((m) => m.label), regionSeries, mEl.clientWidth || W, { key: "mc", fmt: usdAxis, compact: true }) : `<p class="muted small an-empty">No start dates in this selection.</p>`;
    const cEl = document.getElementById("an-cash-svg");
    if (cEl) cEl.innerHTML = groupBars(cashCols.map((c) => c.label), [{ name: "Amount", color: BRAND, colors: cashCols.map((c) => c.color), values: cashCols.map((c) => c.value) }], cEl.clientWidth || W, { key: "cashc", fmt: usdAxis, H: 240 });
    const rEl = document.getElementById("an-regions-svg");
    if (rEl) rEl.innerHTML = groupBars(regions.map((r) => r.label), [
      { name: "Revenue", color: BRAND, values: regions.map((r) => r.rev) },
      { name: "Costs", color: BRAND_LIGHT, values: regions.map((r) => (r.nc ? r.cost : 0)) },
      { name: "Margin", color: GREEN, values: regions.map((r) => (r.nc ? r.crev - r.cost : 0)) },
    ], rEl.clientWidth || W, { key: "rg", fmt: usdAxis });
    const vEl = document.getElementById("an-views-chart");
    if (vEl) chart(vEl, { dates, panels: [{ label: "Views", series: [{ name: "Views", color: ONE, values: viewsByDate }] }], empty: "Views over time appear once the tracker has collected numbers on two or more days." });

    // Hover read-outs
    const lists = { cash: [["Booked", booked], ["Invoiced", invoiced], ["Paid", paid]], rgp: regionPie, mop: monthPie, cp: campPie, cashp: cashPie, cashc: cashCols, cl: topClients, mk: byMarket, tm: team, tv: topViews };
    bindTips(out, (k) => {
      const [kind, iStr] = k.split(":"); const i = Number(iStr);
      if (kind === "mc") return { title: months[i]?.label, rows: [...regionSeries.filter((se) => se.values[i] > 0).map((se) => [se.color, se.name, usd(se.values[i])]), ["", "Total", usd(regionSeries.reduce((t, se) => t + se.values[i], 0))]] };
      if (kind === "rg") { const r = regions[i]; return { title: r.label, rows: [[BRAND, "Revenue", usd(r.rev)], [BRAND_LIGHT, "Costs", r.nc ? usd(r.cost) : "–"], [GREEN, "Margin", r.nc ? `${usd(r.crev - r.cost)} · ${pct(r.margin)}` : "–"], ["", "Campaigns", r.nc ? `${r.n} · ${r.nc} with a cost` : String(r.n)]] }; }
      if (kind === "lbl") { const x = labelSplit.filter((y) => y.v)[i]; return { title: x.l, rows: [[x.color, "Revenue", usd(x.v)], ["", "Share", pct(x.v / labelTotal)], ["", "Campaigns", String(x.n)]] }; }
      if (kind === "cashc") { const c = cashCols[i]; return { title: c.label, rows: [[c.color, "Amount", usd(c.value)], ["", "Share of booked", pct(booked ? c.value / booked : null)]] }; }
      if (kind === "cash") { const [l, v] = lists.cash[i]; return { title: l, rows: [["", "Amount", usd(v)], ["", "Share of booked", pct(booked ? v / booked : null)]] }; }
      const it = lists[kind]?.[i]; if (!it) return null;
      const sum = lists[kind].reduce((t, x) => t + (x.value ?? 0), 0);
      const pie = ["rgp", "mop", "cp", "cashp"].includes(kind) || st.views[{ cl: "an-clients", mk: "an-markets", tm: "an-team", tv: "an-top" }[kind]] === "pie";
      const dot = it.color ?? (pie ? RAMP[i % RAMP.length] : BRAND);
      const what = kind === "tv" ? "Views" : kind === "mk" ? "Budget" : kind === "cashp" ? "Amount" : "Revenue";
      const subLabel = kind === "tv" ? "Per 1K views" : kind === "cp" ? "Client" : "Campaigns";
      return { title: it.label, rows: [[dot, what, kind === "tv" ? num(it.value) : usd(it.value)], ...(it.sub ? [["", subLabel, it.sub.replace(/ campaigns?$/, "").replace(/ per 1K$/, "")]] : []), ["", kind === "cashp" ? "Share of booked" : "Share", pct(sum ? it.value / sum : null)]] };
    });
    // Click a column, slice or row to zoom into it.
    const target = (k) => {
      const [kind, iStr] = k.split(":"); const i = Number(iStr);
      const pick = (arr) => arr[i];
      if (kind === "rg" || kind === "rgp") return ["region", (kind === "rg" ? regions : regionPie)[i]?.key];
      if (kind === "mc") return ["month", months[i]?.key];
      if (kind === "mop") return ["month", monthPie[i]?.key];
      if (kind === "cl") return ["client", pick(topClients)?.key];
      if (kind === "mk") return ["market", pick(byMarket)?.label];
      if (kind === "tm") return ["dri", pick(team)?.label];
      if (kind === "lbl") return ["label", labelSplit.filter((y) => y.v)[i]?.l];
      if (kind === "tv" || kind === "cp") { const c = pick(kind === "tv" ? topViews : campPie)?.camp; return c ? ["camp", c.id] : null; }
      return null;
    };
    out.querySelectorAll("[data-tip]").forEach((el) => {
      const t = target(el.dataset.tip);
      if (!t || !t[1] || pairs.some(([k]) => k === t[0])) return;
      el.classList.add("an-zoomable");
      const zoom = (e) => {
        hideTip();
        const r = el.getBoundingClientRect();
        const x = e?.clientX ?? r.left + r.width / 2, y = e?.clientY ?? r.top + r.height / 2;
        try { sessionStorage.setItem("an-zoom", JSON.stringify({ x, y, at: Date.now() })); } catch { /* ignore */ }
        const dest = t[0] === "camp" ? `#/c/${t[1]}` : drillPath([...pairs, t]);
        const ob = out.getBoundingClientRect();
        out.style.transformOrigin = `${x - ob.left}px ${y - ob.top}px`;
        out.classList.add("an-zooming");
        setTimeout(() => go(dest), matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 170);
      };
      el.addEventListener("click", zoom);
      el.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); zoom(); } });
    });
    out.querySelectorAll("[data-tbl]").forEach((b) => (b.onclick = () => {
      const t = out.querySelector(`[data-tblbody="${b.dataset.tbl}"]`); t.hidden = !t.hidden; b.textContent = t.hidden ? "Show as table" : "Hide table";
    }));
    out.querySelector("[data-go-inv]")?.addEventListener("click", (e) => { e.preventDefault(); try { sessionStorage.setItem("ov-status", "Completed"); } catch { /* ignore */ } go("#/"); });
  }
  const bind = (id, key) => { const el = document.getElementById(id); el.value = st[key]; el.onchange = () => { st[key] = el.value; try { sessionStorage.setItem("an-filters", JSON.stringify({ period: st.period, region: st.region, dri: st.dri })); } catch { /* ignore */ } out.style.opacity = "0.55"; requestAnimationFrame(() => { draw(); out.style.opacity = ""; }); }; };
  bind("an-period", "period"); bind("an-region", "region"); bind("an-dri", "dri");
  draw();
  if (drilled) {
    // Grow out of the point that was clicked; arriving any other way (Back from a deeper zoom) zooms out instead.
    let z = null; try { z = JSON.parse(sessionStorage.getItem("an-zoom") ?? "null"); sessionStorage.removeItem("an-zoom"); } catch { /* ignore */ }
    const zin = z && Date.now() - z.at < 4000, ar = app.getBoundingClientRect(), cls = zin ? "an-zoom-in" : "an-zoom-out";
    app.style.transformOrigin = zin ? `${z.x - ar.left}px ${z.y - ar.top}px` : "50% 30%";
    app.classList.remove("an-zoom-in", "an-zoom-out"); void app.offsetWidth; app.classList.add(cls);
    setTimeout(() => app.classList.remove(cls), 600);
  }
  let t;
  const onResize = () => { clearTimeout(t); t = setTimeout(() => { if (isCurrent() && document.getElementById("an-out")) draw(); else removeEventListener("resize", onResize); }, 200); };
  addEventListener("resize", onResize);
}
