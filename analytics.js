// Analytics: charts across every campaign in the Campaign Overview sheet, plus tracker performance.
// Money is shown in USD (ECB rates, refreshed daily in fx_rates). Every chart says how many
// campaigns it is based on, has a hover read-out and a "Show as table" view.
import { chart, esc } from "./report.js?v=20261021p";

// Validated categorical slots (dataviz palette); cobalt only for single-series charts.
const SLOT = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#6250d6", "#e34948"];
const ONE = "#0626c7";
const GREY = "#a1a1a6";
const REGIONS = [["Stellar West", "West", SLOT[0]], ["Stellar Central", "Central", SLOT[1]], ["Stellar East", "East", SLOT[2]]];
const ALLOC = ["US", "Brazil", "Mexico", "All LATAM", "Canada", "UK", "Germany", "France", "Africa", "Other", "Japan", "Korea", "China", "India", "SEA", "Global"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const nf = new Intl.NumberFormat("en-US");
const usd = (v) => (v == null || !isFinite(v) ? "–" : `$${nf.format(Math.round(v))}`);
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
  let t = document.getElementById("tip");
  if (!t) { t = document.createElement("div"); t.id = "tip"; t.className = "tip"; t.setAttribute("role", "tooltip"); t.hidden = true; document.body.appendChild(t); }
  return t;
}
function showTip(e, rows, title) {
  const t = tipEl();
  t.innerHTML = `${title ? `<div class="tip-date">${esc(title)}</div>` : ""}${rows.map(([color, label, value]) => `<div class="tip-row">${color ? `<i style="background:${color}"></i>` : "<span></span>"}<span>${esc(label)}</span><b>${esc(value)}</b></div>`).join("")}`;
  t.hidden = false;
  const r = e.target.getBoundingClientRect ? null : null;
  const x = e.clientX ?? (e.target.getBoundingClientRect().left + 20), y = e.clientY ?? e.target.getBoundingClientRect().top;
  const tw = t.offsetWidth, th = t.offsetHeight;
  t.style.left = `${Math.max(8, x + 16 + tw > innerWidth - 8 ? x - tw - 16 : x + 16)}px`;
  t.style.top = `${Math.min(innerHeight - th - 8, Math.max(8, y - th / 2))}px`;
}
const hideTip = () => { const t = document.getElementById("tip"); if (t) t.hidden = true; };
function bindTips(root, lookup) {
  root.querySelectorAll("[data-tip]").forEach((el) => {
    const on = (e) => { const x = lookup(el.dataset.tip); if (x) showTip(e, x.rows, x.title); };
    el.addEventListener("pointermove", on);
    el.addEventListener("focus", (e) => { const b = el.getBoundingClientRect(); on({ clientX: b.right, clientY: b.top + b.height / 2, target: el }); });
    el.addEventListener("pointerleave", hideTip);
    el.addEventListener("blur", hideTip);
  });
}

// ---------- card shell with a table twin ----------
function card({ id, title, note, wide = false, body, table }) {
  return `<section class="an-card${wide ? " wide" : ""}" id="${id}">
    <div class="an-head"><h3>${esc(title)}</h3>${note ? `<span class="muted small">${note}</span>` : ""}</div>
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

// Stacked columns by month (SVG), one colour per region; 2px surface gap between segments.
function monthColumns(months, series, width) {
  const W = Math.max(320, width), H = 260, L = 52, R = 12, T = 14, B = 30;
  const totals = months.map((_, i) => series.reduce((s, se) => s + (se.values[i] ?? 0), 0));
  const maxT = Math.max(...totals, 1);
  const stepRaw = maxT / 4, mag = 10 ** Math.floor(Math.log10(stepRaw)), step = [1, 2, 2.5, 5, 10].map((f) => f * mag).find((x) => x >= stepRaw);
  const hi = Math.ceil(maxT / step) * step;
  const y = (v) => T + (1 - v / hi) * (H - T - B);
  const band = (W - L - R) / months.length, bw = Math.min(24, band * 0.6);
  const ticks = []; for (let v = 0; v <= hi + step / 2; v += step) ticks.push(v);
  let segs = "";
  months.forEach((m, i) => {
    let acc = 0;
    const cx = L + band * i + band / 2;
    const parts = series.map((se) => ({ se, v: se.values[i] ?? 0 })).filter((p) => p.v > 0);
    parts.forEach((p, j) => {
      const y0 = y(acc), y1 = y(acc + p.v); acc += p.v;
      const top = j === parts.length - 1;
      const h = Math.max(1, y0 - y1 - (top ? 0 : 2));
      const yTop = y1 + (top ? 0 : 2);
      segs += top
        ? `<path d="M${cx - bw / 2},${y0} V${yTop + 4} Q${cx - bw / 2},${yTop} ${cx - bw / 2 + 4},${yTop} H${cx + bw / 2 - 4} Q${cx + bw / 2},${yTop} ${cx + bw / 2},${yTop + 4} V${y0} Z" fill="${p.se.color}"/>`
        : `<rect x="${cx - bw / 2}" y="${yTop}" width="${bw}" height="${h}" fill="${p.se.color}"/>`;
    });
    segs += `<rect class="hit" x="${L + band * i}" y="${T}" width="${band}" height="${H - T - B}" fill="transparent" data-tip="mc:${i}" tabindex="0"/>`;
    if (totals[i] > 0) segs += `<text class="col-total" x="${cx}" y="${y(totals[i]) - 6}" text-anchor="middle">${usdShort(totals[i])}</text>`;
  });
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" role="img" aria-label="Revenue by start month, by region">
    <g class="grid">${ticks.map((v) => `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" ${v === 0 ? 'class="zero"' : ""}/><text x="${L - 8}" y="${y(v) + 4}" text-anchor="end">${usdShort(v)}</text>`).join("")}</g>
    <g class="xaxis">${months.map((m, i) => `<text x="${L + band * i + band / 2}" y="${H - 8}" text-anchor="middle">${esc(m.label)}</text>`).join("")}</g>
    ${segs}</svg>`;
}

// Scatter: price (x) vs margin (y), one colour, 24px hit circles.
function scatter(points, width) {
  const W = Math.max(320, width), H = 260, L = 52, R = 16, T = 14, B = 30;
  const maxX = Math.max(...points.map((p) => p.x), 1);
  const xStep = (() => { const raw = maxX / 4, mag = 10 ** Math.floor(Math.log10(raw)); return [1, 2, 2.5, 5, 10].map((f) => f * mag).find((v) => v >= raw); })();
  const hiX = Math.ceil(maxX / xStep) * xStep;
  const loY = Math.min(0, ...points.map((p) => p.y)), hiY = 1;
  const x = (v) => L + (v / hiX) * (W - L - R), y = (v) => T + (1 - (v - loY) / (hiY - loY)) * (H - T - B);
  const xt = []; for (let v = 0; v <= hiX + xStep / 2; v += xStep) xt.push(v);
  const yt = [loY < 0 ? loY : null, 0, 0.25, 0.5, 0.75, 1].filter((v) => v != null);
  const avg = points.reduce((s, p) => s + p.y, 0) / points.length;
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" role="img" aria-label="Margin against price for each campaign">
    <g class="grid">${yt.map((v) => `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" ${v === 0 ? 'class="zero"' : ""}/><text x="${L - 8}" y="${y(v) + 4}" text-anchor="end">${Math.round(v * 100)}%</text>`).join("")}</g>
    <g class="xaxis">${xt.map((v, i) => `<text x="${x(v)}" y="${H - 8}" text-anchor="${i === 0 ? "start" : i === xt.length - 1 ? "end" : "middle"}">${usdShort(v)}</text>`).join("")}</g>
    <line x1="${L}" x2="${W - R}" y1="${y(avg)}" y2="${y(avg)}" stroke="${ONE}" stroke-width="1" opacity="0.5"/>
    <text class="avg-label" x="${W - R}" y="${y(avg) - 6}" text-anchor="end">Average ${pct(avg)}</text>
    ${points.map((p, i) => `<circle cx="${x(p.x)}" cy="${y(p.y)}" r="5" fill="${ONE}" stroke="#fff" stroke-width="2"/>
      <circle class="hit" cx="${x(p.x)}" cy="${y(p.y)}" r="12" fill="transparent" data-tip="sc:${i}" tabindex="0"/>`).join("")}
  </svg>`;
}

export async function renderAnalytics(app, sb, { isCurrent, go }) {
  app.innerHTML = `<p class="muted pad">Loading analytics…</p>`;
  const [snap, fx, camps, daily, folders, markets] = await Promise.all([
    sb.from("overview_snapshot").select("sheet,headers,rows,synced_at").eq("id", 1).maybeSingle(),
    sb.from("fx_rates").select("currency,per_usd,rate_date"),
    sb.from("campaign_summary").select("id,artist,song,po_number,status,currency,budget,spend,total_plays,live_posts,cost_per_view"),
    sb.from("campaign_daily_stats").select("campaign_id,stat_date,plays").order("stat_date"),
    sb.from("campaign_folders").select("id,campaign_id,name,market"),
    sb.from("campaign_markets").select("campaign_id,market,share_percent,amount"),
  ]);
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
  const st = { period: "", region: "", dri: "" };

  app.innerHTML = `
    <div class="page-head">
      <div><h1>Analytics</h1>
        <p class="muted small" style="margin:6px 0 0">${esc(s.sheet ?? "Campaign Overview")} · ${all.length} campaigns · amounts in USD${rateDate ? ` at ECB rates from ${esc(rateDate)}` : ""}</p></div>
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

  function draw() {
    const list = all.filter((x) =>
      (!st.period || (st.period.startsWith("m:") ? x.month === st.period.slice(2) : inQuarter(x.month, st.period))) &&
      (!st.region || x.region === st.region) && (!st.dri || x.dris.includes(st.dri)));
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
    const regionSeries = [...REGIONS.map(([k, l, c]) => ({ name: l, color: c, match: (x) => x.region === k })), { name: "Not set", color: GREY, match: (x) => !REGIONS.some(([k]) => k === x.region) }]
      .map((se) => ({ ...se, values: months.map((m) => priced.filter((x) => x.month === m.key && se.match(x)).reduce((t, x) => t + x.priceUsd, 0)) }))
      .filter((se) => se.values.some((v) => v > 0));
    // 3. finished but not invoiced
    const toInvoice = priced.filter((x) => x.status === "Completed" && !x.invoiced).sort((a, b) => b.priceUsd - a.priceUsd);
    // 4. clients
    const byClient = new Map();
    for (const x of priced) { const c = byClient.get(x.client) ?? { label: x.client, value: 0, n: 0, labels: new Set() }; c.value += x.priceUsd; c.n++; c.labels.add(x.label); byClient.set(x.client, c); }
    const clients = [...byClient.values()].sort((a, b) => b.value - a.value);
    const topClients = clients.slice(0, 10).map((c) => ({ label: c.label, value: c.value, sub: `${c.n} campaign${c.n === 1 ? "" : "s"}`, tag: [...c.labels].filter((l) => l !== "Unknown").join("/") }));
    const restClients = clients.slice(10);
    if (restClients.length) topClients.push({ label: `Other (${restClients.length} clients)`, value: restClients.reduce((t, c) => t + c.value, 0), sub: `${restClients.reduce((t, c) => t + c.n, 0)} campaigns`, color: GREY });
    const labelSplit = ["Major", "Indie", "Other"].map((l, i) => ({ l, color: SLOT[i], v: priced.filter((x) => x.label === l).reduce((t, x) => t + x.priceUsd, 0), n: priced.filter((x) => x.label === l).length }));
    const labelTotal = labelSplit.reduce((t, x) => t + x.v, 0);
    // 5. budget by market
    const byMarket = ALLOC.map((m) => ({ label: m, value: list.reduce((t, x) => t + (x.allocs[m] ?? 0), 0), n: list.filter((x) => x.allocs[m]).length })).filter((m) => m.value > 0).sort((a, b) => b.value - a.value);
    const allocN = list.filter((x) => Object.keys(x.allocs).length).length;
    // 6. team (shared campaigns split equally)
    const byPerson = new Map();
    for (const x of priced) for (const p of x.dris) { const e = byPerson.get(p) ?? { label: p, value: 0, n: 0 }; e.value += x.priceUsd / x.dris.length; e.n++; byPerson.set(p, e); }
    const team = [...byPerson.values()].sort((a, b) => b.value - a.value).map((e) => ({ ...e, sub: `${e.n} campaign${e.n === 1 ? "" : "s"}` }));
    // 7. margin
    const marginPts = withCost.map((x) => ({ x: x.priceUsd, y: (x.priceUsd - x.costUsd) / x.priceUsd, name: `${x.artist}${x.song ? ` – ${x.song}` : ""}`, cost: x.costUsd }));
    // 8. performance (tracker)
    const tracked = list.filter((x) => x.camp);
    const trackedIds = new Set(tracked.map((x) => x.camp.id));
    const dailyRows = (daily.data ?? []).filter((r) => trackedIds.has(r.campaign_id));
    const dates = [...new Set(dailyRows.map((r) => r.stat_date))].sort();
    const viewsByDate = dates.map((d) => dailyRows.filter((r) => r.stat_date === d).reduce((t, r) => t + Number(r.plays ?? 0), 0));
    const topViews = tracked.filter((x) => Number(x.camp.total_plays) > 0).sort((a, b) => b.camp.total_plays - a.camp.total_plays).slice(0, 10)
      .map((x) => ({ label: `${x.artist}${x.song ? ` – ${x.song}` : ""}`, value: Number(x.camp.total_plays), sub: x.priceUsd ? `${usdShort((x.priceUsd / x.camp.total_plays) * 1000)} per 1K` : "" }));
    const cpmRows = tracked.filter((x) => x.priceUsd && Number(x.camp.total_plays) > 0);
    const totalViews = tracked.reduce((t, x) => t + Number(x.camp.total_plays ?? 0), 0);
    const cpm = cpmRows.length ? (cpmRows.reduce((t, x) => t + x.priceUsd, 0) / cpmRows.reduce((t, x) => t + Number(x.camp.total_plays), 0)) * 1000 : null;

    const kpi = (label, value, sub) => `<div class="stat"><div class="n">${value}</div><div class="l">${esc(label)}</div>${sub ? `<div class="d muted">${sub}</div>` : ""}</div>`;
    out.innerHTML = `
      <div class="stats an-kpis">
        ${kpi("Revenue booked", usdShort(booked), `${priced.length} priced campaign${priced.length === 1 ? "" : "s"}`)}
        ${kpi("Campaigns", num(list.length), `${list.filter((x) => x.status === "Active").length} active now`)}
        ${kpi("Average deal", usdShort(priced.length ? booked / priced.length : null), "price per campaign")}
        ${kpi("Invoiced", pct(booked ? invoiced / booked : null), `${usdShort(booked - invoiced)} still to invoice`)}
        ${kpi("Paid", usdShort(paid), `${priced.filter((x) => x.paid).length} campaigns marked paid`)}
        ${kpi("Average margin", pct(avgMargin), `${withCost.length} of ${priced.length} have a cost`)}
      </div>
      <div class="an-grid">
        ${card({ id: "an-months", wide: true, title: "Revenue by start month", note: `By client market · ${priced.filter((x) => x.month).length} campaigns with a start date`,
          body: `<div class="legend">${regionSeries.map((se) => `<span><i style="background:${se.color}"></i>${esc(se.name)}</span>`).join("")}</div><div class="an-svg" id="an-months-svg"></div>`,
          table: tableHtml(["Month", ...regionSeries.map((se) => se.name), "Total"], months.map((m, i) => [m.label, ...regionSeries.map((se) => usd(se.values[i])), usd(regionSeries.reduce((t, se) => t + se.values[i], 0))])) })}
        ${card({ id: "an-cash", title: "Booked, invoiced and paid", note: `${priced.length} campaigns`,
          body: hbars([{ label: "Booked", value: booked }, { label: "Invoiced", value: invoiced, sub: pct(booked ? invoiced / booked : null) }, { label: "Paid", value: paid, sub: pct(booked ? paid / booked : null) }], { key: "cash" })
            + (toInvoice.length ? `<div class="an-list"><h4>Finished, not invoiced yet <span class="muted">${toInvoice.length} · ${usdShort(toInvoice.reduce((t, x) => t + x.priceUsd, 0))}</span></h4>
              <ul>${toInvoice.slice(0, 6).map((x) => `<li><span>${esc(x.artist)}${x.song ? ` – ${esc(x.song)}` : ""} <span class="muted">${esc(x.client)}</span></span><b>${usd(x.priceUsd)}</b></li>`).join("")}</ul>
              ${toInvoice.length > 6 ? `<a href="#/" class="small" data-go-inv>See all ${toInvoice.length} in the Campaign overview</a>` : ""}</div>` : `<p class="muted small">Every finished campaign is invoiced.</p>`),
          table: tableHtml(["Campaign", "Client", "Price (USD)"], toInvoice.map((x) => [`${x.artist}${x.song ? ` – ${x.song}` : ""}`, x.client, usd(x.priceUsd)])) })}
        ${card({ id: "an-clients", title: "Top clients", note: `${clients.length} clients`,
          body: (labelTotal ? `<div class="an-split" aria-label="Major, indie and other share of revenue">${labelSplit.filter((x) => x.v).map((x, i) => `<i style="flex:${x.v};background:${x.color}" data-tip="lbl:${i}" tabindex="0"></i>`).join("")}</div>
            <div class="legend">${labelSplit.filter((x) => x.v).map((x) => `<span><i style="background:${x.color}"></i>${x.l} ${pct(x.v / labelTotal)}</span>`).join("")}</div>` : "") + hbars(topClients, { key: "cl" }),
          table: tableHtml(["Client", "Campaigns", "Revenue (USD)"], clients.map((c) => [c.label, String(c.n), usd(c.value)])) })}
        ${card({ id: "an-markets", title: "Where budgets go", note: `Budget allocations · ${allocN} of ${list.length} campaigns have a split`,
          body: hbars(byMarket.map((m) => ({ ...m, sub: `${m.n} campaign${m.n === 1 ? "" : "s"}` })), { key: "mk" }),
          table: tableHtml(["Market", "Campaigns", "Budget (USD)"], byMarket.map((m) => [m.label, String(m.n), usd(m.value)])) })}
        ${card({ id: "an-team", title: "Team", note: "Revenue per DRI · shared campaigns split equally",
          body: hbars(team, { key: "tm" }),
          table: tableHtml(["DRI", "Campaigns", "Revenue (USD)"], team.map((t) => [t.label, String(t.n), usd(t.value)])) })}
        ${card({ id: "an-margin", wide: true, title: "Margin by deal size", note: `${withCost.length} of ${priced.length} campaigns have a cost`,
          body: withCost.length >= 3 ? `<div class="an-svg" id="an-margin-svg"></div><p class="muted small">Each dot is a campaign: price across, margin up. Add campaign costs in the sheet (or record creator costs in the tracker) to fill this in.</p>`
            : `<p class="muted small an-empty">Only ${withCost.length} campaign${withCost.length === 1 ? " has" : "s have"} a cost so far. Margins appear here once a few more do.</p>`,
          table: tableHtml(["Campaign", "Price (USD)", "Cost (USD)", "Margin"], marginPts.sort((a, b) => b.y - a.y).map((p) => [p.name, usd(p.x), usd(p.cost), pct(p.y)])) })}
      </div>
      <div class="section-head"><h2>Performance</h2><span class="muted small">From the tracker · ${tracked.length} of ${list.length} campaigns are tracked</span></div>
      ${!tracked.length ? `<div class="panel"><p class="muted">None of these campaigns are in the tracker yet. Use <b>Create</b> on the Campaign overview to start tracking them; views and cost per view appear here.</p></div>` : `
      <div class="stats an-kpis">
        ${kpi("Views", compactN(totalViews), `across ${tracked.length} tracked campaign${tracked.length === 1 ? "" : "s"}`)}
        ${kpi("Price per 1,000 views", cpm != null ? `$${cpm.toFixed(2)}` : "–", `${cpmRows.length} campaigns with a price and views`)}
        ${kpi("Live posts", num(tracked.reduce((t, x) => t + Number(x.camp.live_posts ?? 0), 0)), "in tracked campaigns")}
      </div>
      <div class="an-grid">
        ${card({ id: "an-views", wide: true, title: "Views over time", note: "All tracked campaigns together", body: `<div id="an-views-chart"></div>` })}
        ${card({ id: "an-top", wide: true, title: "Top campaigns by views", note: "With price per 1,000 views", body: hbars(topViews, { fmt: compactN, key: "tv" }),
          table: tableHtml(["Campaign", "Views", "Price per 1K views"], topViews.map((t) => [t.label, num(t.value), t.sub])) })}
      </div>`}`;

    // Charts drawn at their real width.
    const mEl = document.getElementById("an-months-svg");
    if (mEl) mEl.innerHTML = months.length ? monthColumns(months, regionSeries, mEl.clientWidth || W) : `<p class="muted small an-empty">No start dates in this selection.</p>`;
    const sEl = document.getElementById("an-margin-svg");
    if (sEl) sEl.innerHTML = scatter(marginPts, sEl.clientWidth || half);
    const vEl = document.getElementById("an-views-chart");
    if (vEl) chart(vEl, { dates, panels: [{ label: "Views", series: [{ name: "Views", color: ONE, values: viewsByDate }] }], empty: "Views over time appear once the tracker has collected numbers on two or more days." });

    // Hover read-outs
    const lists = { cash: [["Booked", booked], ["Invoiced", invoiced], ["Paid", paid]], cl: topClients, mk: byMarket, tm: team, tv: topViews };
    bindTips(out, (k) => {
      const [kind, iStr] = k.split(":"); const i = Number(iStr);
      if (kind === "mc") return { title: months[i]?.label, rows: [...regionSeries.filter((se) => se.values[i] > 0).map((se) => [se.color, se.name, usd(se.values[i])]), ["", "Total", usd(regionSeries.reduce((t, se) => t + se.values[i], 0))]] };
      if (kind === "sc") { const p = marginPts[i]; return { title: p.name, rows: [["", "Price", usd(p.x)], ["", "Cost", usd(p.cost)], ["", "Margin", pct(p.y)]] }; }
      if (kind === "lbl") { const x = labelSplit.filter((y) => y.v)[i]; return { title: x.l, rows: [[x.color, "Revenue", usd(x.v)], ["", "Share", pct(x.v / labelTotal)], ["", "Campaigns", String(x.n)]] }; }
      if (kind === "cash") { const [l, v] = lists.cash[i]; return { title: l, rows: [["", "Amount", usd(v)], ["", "Share of booked", pct(booked ? v / booked : null)]] }; }
      const it = lists[kind]?.[i]; if (!it) return null;
      return { title: it.label, rows: [["", kind === "tv" ? "Views" : "Revenue", kind === "tv" ? num(it.value) : usd(it.value)], ...(it.sub ? [["", "", it.sub]] : [])] };
    });
    out.querySelectorAll("[data-tbl]").forEach((b) => (b.onclick = () => {
      const t = out.querySelector(`[data-tblbody="${b.dataset.tbl}"]`); t.hidden = !t.hidden; b.textContent = t.hidden ? "Show as table" : "Hide table";
    }));
    out.querySelector("[data-go-inv]")?.addEventListener("click", (e) => { e.preventDefault(); try { sessionStorage.setItem("ov-status", "Completed"); } catch { /* ignore */ } go("#/"); });
  }
  const bind = (id, key) => { const el = document.getElementById(id); el.value = st[key]; el.onchange = () => { st[key] = el.value; out.style.opacity = "0.55"; requestAnimationFrame(() => { draw(); out.style.opacity = ""; }); }; };
  bind("an-period", "period"); bind("an-region", "region"); bind("an-dri", "dri");
  draw();
  let t;
  const onResize = () => { clearTimeout(t); t = setTimeout(() => { if (isCurrent() && document.getElementById("an-out")) draw(); else removeEventListener("resize", onResize); }, 200); };
  addEventListener("resize", onResize);
}
