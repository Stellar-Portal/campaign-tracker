import { createClient } from "./vendor/supabase.esm.js";
import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from "./config.js?v=20261027d";
import { mountReport, renderWall, openPostModal, flag, regionName, ago, engagement, ICON, copyLink, pct, isYT, platformName } from "./report.js?v=20261027d";
import { renderRoster } from "./roster.js?v=20261027d";
import { renderDiscover } from "./discover.js?v=20261027d";
import { renderAnalytics, drillTitle } from "./analytics.js?v=20261027d";
import { renderTrending } from "./trending.js?v=20261027d";
import { renderInvoices, requestInvoiceDialog, statusPill as invoicePill } from "./invoices.js?v=20261027d";
import { confirmDialog } from "./dialog.js?v=20261027d";
import { splitPeople, renderCampaignPayouts, renderPayoutsHome } from "./payouts.js?v=20261027d";
import { INVOICING_ENTITIES, CLIENT_COUNTRIES, CLIENT_MARKETS, CAMPAIGN_TYPES, RELEASE_TYPES, LABEL_TYPES, STATUSES, statusLabel, normalisePO } from "./sheet-lists.js?v=20261027d";

const sb = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
// Any write (or Edge Function call) means kept pages may be out of date, so they're dropped.
{
  const from = sb.from.bind(sb);
  sb.from = (t) => {
    const q = from(t);
    for (const m of ["insert", "update", "upsert", "delete"]) { const f = q[m].bind(q); q[m] = (...a) => { pageCache.clear(); return f(...a); }; }
    return q;
  };
  const invoke = sb.functions.invoke.bind(sb.functions);
  sb.functions.invoke = (...a) => { if (a[0] !== "share" || a[1]?.body?.action) pageCache.clear(); return invoke(...a); };
}
const app = document.getElementById("app");
const who = document.getElementById("who");
let routeToken = 0; // the token of the page on screen; stale timers and fetches stop when it changes
let tokenSeq = 0;   // tokens are never reused, so a page restored from the cache gets its own token back
const newToken = () => (routeToken = ++tokenSeq);

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

// ---------- Back, Home, back to top ----------
// Each sidebar section keeps its own trail of pages. Back walks up that trail and stops at the section's
// first page (it never jumps to another section); Home goes straight to the section's first page.
const SECTION_HOME = { overview: "#/", campaigns: "#/campaigns", roster: "#/roster", discover: "#/discover", analytics: "#/analytics", trending: "#/trending", payouts: "#/payouts", payments: "#/payments", invoices: "#/invoices" };
const SECTION_NAME = { overview: "Campaign overview", campaigns: "Tracker", roster: "Roster", discover: "Discover", analytics: "Analytics", trending: "Trending", payouts: "Payouts", payments: "Creator payments", invoices: "Invoices" };
const normHash = (h) => (!h || h === "#" || h === "#/overview" ? "#/" : h);
function sectionOf(hash) {
  const p = hash.replace(/^#\/?/, "").split("/").filter(Boolean);
  if (!p.length || p[0] === "overview") return "overview";
  if (p[0] === "creator" || p[0] === "roster") return "roster";
  if (["c", "new", "report", "campaigns"].includes(p[0])) return "campaigns";
  return SECTION_HOME[p[0]] ? p[0] : "campaigns";
}
let trails = (() => { try { return JSON.parse(sessionStorage.getItem("navtrails") ?? "{}"); } catch { return {}; } })();
let lastHash = null, prevHash = null;
// How deep a page sits in its section: 0 = the section's first page (or one of its tabs).
function depthOf(hash) {
  const p = hash.replace(/^#\/?/, "").split("/").filter(Boolean);
  if (!p.length) return 0;
  if (p[0] === "roster") {
    const base = p[p.length - 2] === "c" ? p.slice(0, -2) : p;
    return (base[1] === "list" ? 1 : 0) + (base.length !== p.length ? 1 : 0);
  }
  if (p[0] === "creator") return 2;
  if (p[0] === "c") return p[2] && p[2] !== "payouts" ? 2 : 1;
  if (p[0] === "new" || p[0] === "report") return 1;
  if (p[0] === "trending") return p[1] === "artist" ? 1 : 0;
  if (p[0] === "analytics") return Math.floor((p.length - 1) / 2);
  return 0;
}
function trackHistory() {
  const h = normHash(location.hash), sec = sectionOf(h), home = SECTION_HOME[sec];
  let t = trails[sec] ?? [];
  const cameFrom = lastHash ? sectionOf(lastHash) : null;
  if (h === home) t = [home];                                         // a section's first page starts its trail afresh
  else if ((cameFrom && cameFrom !== sec) || (!cameFrom && t[t.length - 1] !== h)) t = [h];   // arrived from another section, or a reload
  else {
    const i = t.lastIndexOf(h);
    t = i >= 0 ? t.slice(0, i + 1) : [...t, h];                       // returning to a page drops what came after it
  }
  trails[sec] = t.slice(-40);
  prevHash = lastHash; lastHash = h;
  try { sessionStorage.setItem("navtrails", JSON.stringify(trails)); } catch { /* private window */ }
}
function parentOf(hash) {
  const p = hash.replace(/^#\/?/, "").split("/").filter(Boolean);
  if (!p.length) return null;
  if (p[0] === "c" && p[1]) return p[2] && p[2] !== "payouts" ? `#/c/${p[1]}` : "#/campaigns";
  if (p[0] === "new" || p[0] === "report") return "#/campaigns";
  if (p[0] === "creator") return "#/roster";
  if (p[0] === "roster" && p.length > 1) {
    if (p[p.length - 2] === "c") return `#/${p.slice(0, -2).join("/")}`;
    if (p[1] === "list" && p[3]) return `#/roster/list/${p[2]}`;
    return "#/roster";
  }
  if (p[0] === "trending" && p.length > 1) return p[1] === "artist" ? "#/trending/artists" : "#/trending";
  if (p[0] === "analytics" && p.length > 2) return `#/${p.slice(0, -2).join("/")}`;
  return null;
}
function pageName(hash) {
  const p = hash.replace(/^#\/?/, "").split("/").filter(Boolean);
  if (!p.length || p[0] === "overview") return "Campaign overview";
  if (p[0] === "campaigns") return "Tracker";
  if (p[0] === "c") return p[2] === "edit" ? "Edit campaign" : p[2] === "add" ? "Add links" : "Campaign";
  if (p[0] === "new") return "New campaign";
  if (p[0] === "report") return "Client view";
  if (p[0] === "creator") return "Creator";
  if (p[0] === "roster") return p[p.length - 2] === "c" ? "Creator" : p[1] === "list" ? (p[3] === "compare" ? "Comparison" : "List") : "Roster";
  if (p[0] === "analytics" && p.length > 2) return drillTitle(p[p.length - 2], decodeURIComponent(p[p.length - 1]));
  if (p[0] === "trending") return p[1] === "artist" ? "Artist" : p[1] === "artists" ? "Trending artists" : "Trending";
  return { analytics: "Analytics", discover: "Discover", payouts: "Payouts", payments: "Creator payments", invoices: "Invoices" }[p[0]] ?? "Previous page";
}
// Page titles as they were shown ("Football clubs", a campaign's song), so Back can name the page it returns to.
const pageTitles = (() => { try { return JSON.parse(sessionStorage.getItem("navtitles") ?? "{}"); } catch { return {}; } })();
function rememberTitle(hash) {
  setTimeout(() => {
    if (normHash(location.hash) !== hash) return;
    const h = document.querySelector(".content > main h1");
    const hc = h?.cloneNode(true); hc?.querySelectorAll("details, button").forEach((x) => x.remove());
    const t = hc?.textContent?.trim();
    if (!t || t.length > 60) return;
    pageTitles[hash] = t;
    try { sessionStorage.setItem("navtitles", JSON.stringify(pageTitles)); } catch { /* private window */ }
  }, 1500);
}
function updateBack() {
  const bar = document.getElementById("backbar");
  if (!bar) return;
  const here = normHash(location.hash), sec = sectionOf(here), home = SECTION_HOME[sec];
  const t = trails[sec] ?? [];
  // Where Back goes: the previous page in this section's trail, else one level up, never outside the section.
  // Back goes up a level: to the last page you were on that sits above this one (a list above a creator,
  // the tracker above a campaign), else to the page directly above, else to the section's first page.
  const d = depthOf(here);
  const fromTrail = [...t.slice(0, -1)].reverse().find((x) => depthOf(x) < d);
  const up = parentOf(here);
  // Of the two, the one closest above this page wins (a list beats the roster for a creator opened from it).
  let target = [fromTrail, up].filter((x) => x && sectionOf(x) === sec && depthOf(x) < d).sort((a, b) => depthOf(b) - depthOf(a))[0];
  if (!target) target = home;
  const show = here !== home && !document.body.classList.contains("signin");
  bar.hidden = !show;
  document.body.classList.toggle("has-back", show);
  if (!show) return;
  const generic = pageName(target);
  const named = pageTitles[target];
  document.getElementById("back-label").textContent = target === home ? `Back to ${SECTION_NAME[sec]}` : `Back to ${named && ["List", "Campaign", "Artist", "Comparison", "Creator"].includes(generic) ? named : generic}`;
  document.getElementById("back-btn").onclick = () => { if (prevHash === target) history.back(); else go(target); };
  const homeBtn = document.getElementById("home-btn");
  homeBtn.hidden = target === home;   // Back already goes there
  homeBtn.title = `${SECTION_NAME[sec]}: first page`;
  homeBtn.setAttribute("aria-label", `Go to the first page of ${SECTION_NAME[sec]}`);
  document.getElementById("home-label").textContent = SECTION_NAME[sec];
  homeBtn.onclick = () => go(home);
}

// Back to top: appears once you've scrolled a screen or so down.
(() => {
  const btn = document.getElementById("to-top");
  if (!btn) return;
  const sync = () => { btn.classList.toggle("on", window.scrollY > Math.max(600, window.innerHeight * 0.9)); };
  window.addEventListener("scroll", sync, { passive: true });
  btn.onclick = () => window.scrollTo({ top: 0, behavior: "smooth" });
  sync();
})();

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
      <img class="logo" src="assets/stellar-blue.png" alt="Stellar" width="160" height="44">
      <h1>Stellar <em>OS</em></h1>
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
  who.innerHTML = `<span class="email" title="${esc(user.email)}">${esc(user.email)}</span><button id="signout" type="button" title="Sign out"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 4h4v16h-4M10 8l-4 4 4 4M6 12h10"/></svg><span>Sign out</span></button>`;
  // The account's saved menu choice wins over this browser's copy.
  loadPrefs().catch(() => {});
  document.getElementById("signout").onclick = async () => { await sb.auth.signOut(); };
}

// ---------- Stellar OS navigation ----------
const TOOL_ICON = {
  edit: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16v4zM14 6l4 4"/></svg>',
  del: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6"/></svg>',
  sheet: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 4h16v16H4zM4 10h16M4 15h16M10 4v16"/></svg>',
};
const NAV_ICON = {
  overview: '<path d="M4 5h16M4 10h16M4 15h10M4 20h7"/>',
  tracker: '<path d="M4 19V9M10 19V5M16 19v-7M22 19H2"/>',
  payouts: '<path d="M3 7h18v10H3zM3 11h18M7 15h3"/>',
  creators: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0M16 4.5a3.5 3.5 0 0 1 0 7M18 14a6.5 6.5 0 0 1 3.5 6"/>',
  invoices: '<path d="M6 3h9l4 4v14H6zM14 3v5h5M9 13h7M9 17h5"/>',
  analytics: '<path d="M3 20l5-7 4 4 8-11"/><path d="M16 6h4v4"/>',
  roster: '<path d="M12 3.5l2.6 5.3 5.8.8-4.2 4.1 1 5.8L12 16.8l-5.2 2.7 1-5.8-4.2-4.1 5.8-.8z"/>',
  discover: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m15.5 15.5 5 5M10.5 7.5v6M7.5 10.5h6"/>',
  trending: '<path d="M9 18V6l11-2v12"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="17.5" cy="16" r="2.5"/>',
};
const NAV = [
  ["Campaigns", [
    { key: "overview", href: "#/", label: "Campaign overview", icon: "overview" },
    { key: "campaigns", href: "#/campaigns", label: "Tracker", icon: "tracker" },
    { key: "roster", href: "#/roster", label: "Roster", icon: "roster" },
    { key: "discover", href: "#/discover", label: "Discover", icon: "discover" },
  ]],
  ["Money", [
    { key: "payouts", href: "#/payouts", label: "Payouts", icon: "payouts" },
    { key: "invoices", href: "#/invoices", label: "Invoices", icon: "invoices" },
  ]],
  ["Insights", [
    { key: "analytics", href: "#/analytics", label: "Analytics", icon: "analytics" },
    { key: "trending", href: "#/trending", label: "Trending", icon: "trending" },
  ]],
];
// Menu: icons only on desktop. Hovering for a moment opens it over the page; it closes again
// as soon as the pointer leaves (or straight away on a click in the page). Ctrl/⌘ + \ toggles it.
const NAV_OPEN_DELAY = 120, NAV_CLOSE_DELAY = 150;
const autoNav = matchMedia("(hover: hover) and (min-width: 901px)");
let navOpenT = 0, navCloseT = 0;
function navPeek(on) {
  clearTimeout(navOpenT); clearTimeout(navCloseT);
  if (!autoNav.matches) return;
  document.body.classList.toggle("nav-collapsed", !on);
  document.body.classList.toggle("nav-peek", on);
}
function applyNavMode() {
  clearTimeout(navOpenT); clearTimeout(navCloseT);
  document.body.classList.remove("nav-peek");
  document.body.classList.toggle("nav-collapsed", autoNav.matches);
}
applyNavMode();
autoNav.addEventListener?.("change", applyNavMode);
{
  const side = document.getElementById("sidebar");
  side?.addEventListener("mouseenter", () => {
    clearTimeout(navCloseT);
    if (document.body.classList.contains("nav-collapsed")) navOpenT = setTimeout(() => navPeek(true), NAV_OPEN_DELAY);
  });
  side?.addEventListener("mouseleave", () => {
    clearTimeout(navOpenT);
    if (document.body.classList.contains("nav-peek")) navCloseT = setTimeout(() => navPeek(false), NAV_CLOSE_DELAY);
  });
  side?.addEventListener("focusin", (e) => { if (e.target.matches(":focus-visible") && document.body.classList.contains("nav-collapsed")) navPeek(true); });
  document.addEventListener("pointerdown", (e) => { if (document.body.classList.contains("nav-peek") && !side?.contains(e.target)) navPeek(false); });
  document.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "\\") { e.preventDefault(); navPeek(!document.body.classList.contains("nav-peek")); }
  });
}

// Pop-ups (menus, filter panels, dropdowns) close on a click anywhere outside them or on Escape.
// One handler for the whole app, so it keeps working on pages restored from the page cache.
const POPUP_DETAILS = "details.ov2-menu, details.camp-menu, details.ro-more, details.ro-lists, details.df";
function closePopups(except) {
  document.querySelectorAll(`${POPUP_DETAILS}`).forEach((d) => { if (d.open && !(except && (d.contains(except) || except.closest?.(".camp-menu-pop")))) d.open = false; });
  document.querySelectorAll("[data-pop]:not([hidden])").forEach((p) => {
    const btn = p.id ? document.querySelector(`[aria-controls="${CSS.escape(p.id)}"]`) : null;
    if (except && (p.contains(except) || btn?.contains(except))) return;
    p.hidden = true; btn?.setAttribute("aria-expanded", "false");
  });
}
document.addEventListener("pointerdown", (e) => closePopups(e.target), true);
// Pop-up windows (dialogs) close on a click on the dimmed area around them, like Escape does.
let downOn = null;
document.addEventListener("pointerdown", (e) => { downOn = e.target; }, true);
document.addEventListener("click", (e) => {
  const d = e.target;
  if (!(d instanceof HTMLDialogElement) || !d.open || downOn !== d) return;
  const r = d.getBoundingClientRect();
  if (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom) return;
  if (d.dispatchEvent(new Event("cancel", { cancelable: true }))) d.close();
});
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closePopups(null); });

function renderNav(active) {
  document.getElementById("nav").innerHTML = NAV.map(([group, items]) => `
    <div class="nav-group"><div class="nav-label">${esc(group)}</div>
      ${items.map((it) => `<a href="${it.href}" aria-label="${esc(it.label)}${it.soon ? " (soon)" : ""}" class="nav-item${it.key === active ? " on" : ""}"${it.key === active ? ' aria-current="page"' : ""}>
        <svg viewBox="0 0 24 24" aria-hidden="true">${NAV_ICON[it.icon]}</svg><span>${esc(it.label)}</span>${it.soon ? '<i class="soon">Soon</i>' : ""}</a>`).join("")}
    </div>`).join("");
  document.querySelector('.nav-item.on')?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
}

// Sections that are planned but not built yet: say what they'll do.
const SOON = {
  "creator-payments": ["Creator payments", "Every creator deal in one place.", ["Agreed price per creator and campaign, in any currency", "What's paid and what's still owed", "Payment details kept private to the team"]],
};
function renderSoon(key) {
  const [title, lead, points] = SOON[key];
  app.innerHTML = `<div class="page-head"><div><h1>${esc(title)}</h1><p class="voice muted" style="margin:8px 0 0;font-size:20px">${esc(lead)}</p></div></div>
    <section class="panel soon-panel"><span class="badge">Coming soon</span>
      <p>This part of Stellar OS isn't built yet. What it will do:</p>
      <ul>${points.map((x) => `<li>${esc(x)}</li>`).join("")}</ul></section>`;
}

// ---------- copy buttons (PO numbers etc.) ----------
const COPY_SVG = '<svg viewBox="0 0 20 20" aria-hidden="true"><rect class="c1" x="7" y="7" width="10" height="10" rx="2"/><path class="c1" d="M13 4.5V4a1.5 1.5 0 0 0-1.5-1.5h-7A1.5 1.5 0 0 0 3 4v7a1.5 1.5 0 0 0 1.5 1.5h.5"/><path class="c2" d="M5 10.5l3.2 3.2L15.5 6"/></svg>';
const copyBtn = (text, what = "PO number") => `<button type="button" class="copy-btn" data-copy="${esc(text)}" data-stop title="Copy ${esc(what)}" aria-label="Copy ${esc(what)} ${esc(text)}">${COPY_SVG}</button>`;
// One listener for every copy button; runs before row clicks so copying never opens or closes a row.
document.addEventListener("click", async (e) => {
  const b = e.target.closest?.("[data-copy]");
  if (!b) return;
  e.preventDefault(); e.stopPropagation();
  try {
    await navigator.clipboard.writeText(b.dataset.copy);
    b.classList.add("done"); setTimeout(() => b.classList.remove("done"), 1400);
    toast(`Copied ${b.dataset.copy}`);
  } catch { toast("Couldn't copy here; select the text instead"); }
}, true);

// ---------- per-person view settings ----------
// Sorting and filters are saved for whoever is signed in (table user_prefs, readable only by them),
// so changing them never changes anyone else's view. A copy in this browser makes pages open instantly.
let PREFS = { email: null, data: {} };
async function loadPrefs() {
  const user = await signedInUser();
  const email = user?.email?.toLowerCase() ?? null;
  if (PREFS.email === email && PREFS.loaded) return PREFS.data;
  let data = {};
  try { data = JSON.parse(localStorage.getItem(`prefs:${email}`) || "{}") || {}; } catch { /* private window */ }
  const { data: row } = await sb.from("user_prefs").select("prefs").maybeSingle();
  if (row?.prefs) data = row.prefs;
  PREFS = { email, data, loaded: true };
  return data;
}
let prefsTimer = null;
function savePrefs(section, value) {
  PREFS.data = { ...PREFS.data, [section]: value };
  try { localStorage.setItem(`prefs:${PREFS.email}`, JSON.stringify(PREFS.data)); } catch { /* ignore */ }
  clearTimeout(prefsTimer);
  prefsTimer = setTimeout(() => {
    if (PREFS.email) sb.from("user_prefs").upsert({ email: PREFS.email, prefs: PREFS.data, updated_at: new Date().toISOString() }).then(() => {});
  }, 500);
}

// ---------- Campaign overview: the backlog sheet, linked to the tracker ----------
// The sheet ("Copy of CAMPAIGN OVERVIEW FY26/27") is mirrored into overview_snapshot every 5 minutes.
// Each row is matched to a tracker campaign by Artist + Song + PO (or the row the tracker last wrote).
const SHEET_URL = "https://docs.google.com/spreadsheets/d/1e3ce1Q7uW5iH4FQqN9Oo_Dw5Y51UcBx87nOAz1wp6Tk/edit#gid=1649746959";
const normKey = (...v) => v.map((x) => String(x ?? "").trim().toLowerCase().replace(/\s+/g, " ")).join("|");
const blankCell = (v) => { const t = String(v ?? "").trim(); return t === "" || t === "Select"; };
const sheetNumber = (v) => { const t = String(v ?? "").replace(/[^\d.\-]/g, ""); return t && !isNaN(Number(t)) ? Number(t) : null; };
const OV_STATUS = { Upcoming: "draft", Active: "active", "On Hold": "on_hold", Completed: "finished" };
const ALLOC_COLUMNS = ["US", "Brazil", "Mexico", "All LATAM", "Canada", "UK", "Germany", "France", "Africa", "Other", "Japan", "Korea", "China", "India", "SEA", "Global"];

// "01/07" (and "01/07/26") → an ISO date. A tab named "…FY26/27" is a financial year from April:
// April–December are 2026, January–March 2027. Otherwise the year closest to today.
let OV_SHEET = "";
function sheetDate(v) {
  const m = String(v ?? "").trim().match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/);
  if (!m) return null;
  const d = Number(m[1]), mo = Number(m[2]);
  if (d < 1 || d > 31 || mo < 1 || mo > 12) return null;
  const pad = (x) => String(x).padStart(2, "0");
  if (m[3]) return `${m[3].length === 2 ? "20" + m[3] : m[3]}-${pad(mo)}-${pad(d)}`;
  const fy = OV_SHEET.match(/FY\s*(\d{2})\s*\/\s*(\d{2})/i);
  if (fy) return `20${mo >= 4 ? fy[1] : fy[2]}-${pad(mo)}-${pad(d)}`;
  const now = new Date(), y = now.getFullYear();
  const best = [y - 1, y, y + 1].map((yy) => `${yy}-${pad(mo)}-${pad(d)}`).sort((a, b) => Math.abs(Date.parse(a) - now) - Math.abs(Date.parse(b) - now))[0];
  return best;
}
// "2 weeks", "3 months", "10 days" → an end date after the start
function endFromDuration(start, v) {
  const m = String(v ?? "").toLowerCase().match(/(\d+)\s*(day|week|month)/);
  if (!start || !m) return null;
  const k = Number(m[1]), dt = new Date(start + "T00:00:00Z");
  if (m[2] === "day") dt.setUTCDate(dt.getUTCDate() + k - 1);
  else if (m[2] === "week") dt.setUTCDate(dt.getUTCDate() + k * 7 - 1);
  else { dt.setUTCMonth(dt.getUTCMonth() + k); dt.setUTCDate(dt.getUTCDate() - 1); }
  return dt.toISOString().slice(0, 10);
}

// Turn a sheet row into the campaign form's fields, for "Create in tracker".
function prefillFromRow(r) {
  const g = (h) => (blankCell(r.f[h]) ? null : String(r.f[h]).trim());
  const start = sheetDate(g("Start Date"));
  const cur = (g("Currency") ?? "").toUpperCase().replace("JYP", "JPY");
  const markets = ALLOC_COLUMNS.map((m) => ({ market: m, amount: sheetNumber(r.f[m]) })).filter((x) => x.amount);
  return {
    campaign: {
      artist: g("Artist Name"), song: g("Song Name (s) or Project Name"), po_number: g("Stellar PO no."),
      status: OV_STATUS[g("Status")] ?? "draft", release_type: RELEASE_TYPES.includes(g("Type (NR or Cat)")) ? g("Type (NR or Cat)") : null,
      client: g("Client"), invoicing_entity: g("Invoicing Entity"), client_country: g("Client Location (Country)"),
      client_market: CLIENT_MARKETS.includes(g("Client Market")) ? g("Client Market") : null,
      client_contact_name: g("Client Contact Name"), client_contact_email: g("Client Contact eMail"),
      label_type: LABEL_TYPES.includes(g("Major / Indie / Other")) ? g("Major / Indie / Other") : null,
      under_nda: g("Under NDA?") === "Yes" ? true : g("Under NDA?") === "No" ? false : null,
      comms_owner: g("Stellar DRI"), campaign_type: g("Campaign Type"),
      start_date: start, end_date: endFromDuration(start, g("Duration")),
      budget: sheetNumber(g("Price")), currency: /^[A-Z]{3}$/.test(cur) ? cur : null,
      notes: g("Comments"), folders_by_market: true, invoiced: g("Invoice Status") === "Invoiced",
    },
    markets,
    sheetRow: r.row,
  };
}

async function renderOverview(token) {
  app.innerHTML = `<p class="muted pad">Loading the campaign overview…</p>`;
  const [snap, camps, syncs, fx, prefs] = await Promise.all([
    sb.from("overview_snapshot").select("*").eq("id", 1).maybeSingle(),
    fetchAll(() => sb.from("campaign_summary").select("id,artist,song,po_number,status,total_plays,live_posts").order("created_at")).catch(() => []),
    sb.from("campaign_sheet_sync").select("campaign_id,sheet_row,last_error"),
    sb.from("fx_rates").select("currency,per_usd"),
    loadPrefs().catch(() => ({})),
  ]);
  if (token !== routeToken) return;
  const s = snap.data ?? {};
  OV_SHEET = s.sheet ?? "";
  const headers = s.headers ?? [];
  // Section of each column (row 1 of the sheet is merged across each section).
  let sec = "";
  const sectionOf = (s.sections ?? []).map((x) => (sec = String(x || "").trim() || sec));
  const firstIndex = {};
  headers.forEach((h, i) => { if (!(h in firstIndex)) firstIndex[h] = i; });
  const rows = (s.rows ?? []).map((r) => {
    const f = {};
    for (const h in firstIndex) f[h] = r.values[firstIndex[h]];
    return { row: r.row, values: r.values, f, cid: r.cid };
  });
  // Link each sheet row to its tracker campaign: the row's hidden tag first (survives renames and
  // re-sorting), then Artist + Song + PO, then the row the tracker last wrote.
  const byId = new Map((camps ?? []).map((c) => [c.id, c]));
  const byKey = new Map((camps ?? []).filter((c) => c.po_number).map((c) => [normKey(c.artist, c.song, c.po_number), c]));
  const byRow = new Map((syncs.data ?? []).filter((x) => x.sheet_row).map((x) => [x.sheet_row, byId.get(x.campaign_id)]));
  for (const r of rows) r.camp = (r.cid && byId.get(r.cid)) || byKey.get(normKey(r.f["Artist Name"], r.f["Song Name (s) or Project Name"], r.f["Stellar PO no."])) || byRow.get(r.row) || null;
  const linked = new Set(rows.map((r) => r.camp?.id).filter(Boolean));
  const notInSheet = (camps ?? []).filter((c) => !linked.has(c.id));

  const v = (r, h) => (blankCell(r.f[h]) ? "" : String(r.f[h]).trim());
  const uniq = (h) => [...new Set(rows.map((r) => v(r, h)).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  // Amounts in other currencies are converted with the day's ECB rate, so totals and price sorting
  // compare like with like. The original currencies stay visible on hover.
  const rate = Object.fromEntries((fx.data ?? []).map((x) => [x.currency, Number(x.per_usd)]));
  const curOf = (r) => v(r, "Currency").toUpperCase().replace("JYP", "JPY");
  const toUsd = (x, c) => (x == null ? null : c === "USD" ? x : rate[c] ? x / rate[c] : null);
  const priceUsd = (r) => toUsd(sheetNumber(v(r, "Price")), curOf(r));
  const STATUS_RANK = { Active: 0, Upcoming: 1, "On Hold": 2, Completed: 3 };
  // Each sort: the direction it starts in, and its two labels (first direction, then the other).
  const SORTS = {
    added: { first: "desc", labels: ["Recently added", "Oldest added"], get: (r) => r.row },
    start: { first: "desc", labels: ["Start date, latest first", "Start date, earliest first"], get: (r) => sheetDate(v(r, "Start Date")) },
    price: { first: "desc", labels: ["Price, highest first", "Price, lowest first"], get: priceUsd },
    artist: { first: "asc", labels: ["Artist A–Z", "Artist Z–A"], get: (r) => v(r, "Artist Name").toLowerCase() || null },
    client: { first: "asc", labels: ["Client A–Z", "Client Z–A"], get: (r) => v(r, "Client").toLowerCase() || null },
    dri: { first: "asc", labels: ["DRI A–Z", "DRI Z–A"], get: (r) => v(r, "Stellar DRI").toLowerCase() || null },
    status: { first: "asc", labels: ["Status, active first", "Status, completed first"], get: (r) => STATUS_RANK[v(r, "Status")] ?? null },
  };
  const other = (d) => (d === "asc" ? "desc" : "asc");
  const sortLabel = (k, d) => SORTS[k].labels[d === SORTS[k].first ? 0 : 1];
  const FILTERS = [
    { key: "dri", label: "Stellar DRI", col: "Stellar DRI", all: "Everyone" },
    { key: "market", label: "Client market", col: "Client Market", all: "All markets" },
    { key: "invoice", label: "Invoice", col: "Invoice Status", all: "Invoiced or not" },
    { key: "tracker", label: "Tracker", all: "In the tracker or not", options: [["yes", "In the tracker"], ["no", "Not in the tracker"]] },
  ];
  const optionsFor = (f) => f.options ?? uniq(f.col).map((x) => [x, x]);
  const saved = prefs?.overview ?? {};
  const st = { q: "", status: "", dri: "", market: "", invoice: "", tracker: "", sort: SORTS[saved.sort] ? saved.sort : "added", dir: saved.dir === "asc" || saved.dir === "desc" ? saved.dir : null };
  st.dir ??= SORTS[st.sort].first;
  // Only keep saved filters that still exist in the sheet (a DRI who left, a renamed market…).
  if (uniq("Status").includes(saved.status)) st.status = saved.status;
  for (const f of FILTERS) if (optionsFor(f).some(([x]) => x === saved[f.key])) st[f.key] = saved[f.key];
  const persist = () => savePrefs("overview", { sort: st.sort, dir: st.dir, status: st.status, ...Object.fromEntries(FILTERS.map((f) => [f.key, st[f.key]])) });
  const totalsUsd = (list) => {
    let usd = 0, unconverted = 0;
    const by = {};
    for (const r of list) {
      const p = sheetNumber(v(r, "Price")), c = curOf(r);
      if (!p || !c) continue;
      by[c] = (by[c] ?? 0) + p;
      const u = toUsd(p, c);
      if (u == null) unconverted++; else usd += u;
    }
    const curs = Object.entries(by).sort((a, b) => (a[0] === "USD" ? -1 : b[0] === "USD" ? 1 : b[1] - a[1]));
    return { usd, curs, unconverted };
  };
  const moneyTile = (list, label) => {
    const t = totalsUsd(list);
    const breakdown = t.curs.map(([c, x]) => `${c} ${Math.round(x).toLocaleString("en-GB")}`).join(" · ");
    const sub = !t.curs.length ? "" : t.curs.length > 1 ? `${t.curs.length} currencies, in USD` : t.curs[0][0] === "USD" ? "All in USD" : `Converted from ${t.curs[0][0]}`;
    return `<div class="stat" title="${esc(breakdown)}${t.unconverted ? ` (${t.unconverted} without an exchange rate left out)` : ""}">
      <div class="n">${t.curs.length ? `USD ${Math.round(t.usd).toLocaleString("en-GB")}` : "–"}</div>
      <div class="l">${label}</div>${sub ? `<div class="sub">${esc(sub)}</div>` : ""}</div>`;
  };
  const ago = s.synced_at ? timeAgo(s.synced_at) : null;

  const STATUS_TABS = [["Active", "Live"], ["Upcoming", "Upcoming"], ["On Hold", "On hold"], ["Completed", "Completed"], ["", "All"]];
  if (!saved.status && saved.status !== "") st.status = rows.some((r) => v(r, "Status") === "Active") ? "Active" : "";
  if (!saved.sort) { st.sort = "start"; st.dir = "desc"; }
  const syncLine = `${s.sheet ? `In sync with <a href="${SHEET_URL}" target="_blank" rel="noopener">${esc(s.sheet)}</a>` : "From the Campaign Overview sheet"}${ago ? ` · updated ${esc(ago)}` : ""}`;
  const failed = s.last_error && (!s.synced_at || s.last_attempt_at > s.synced_at);
  app.innerHTML = `
    <div class="page-head ov2-head">
      <div><h1>Campaign overview</h1>
        <p class="ov2-sync" id="ov-sync"><i class="${failed ? "bad" : ""}"></i>${syncLine}${failed ? ` · <span class="warn-note">last refresh failed: ${esc(s.last_error)}</span>` : ""}
          · <button type="button" class="link-btn" id="ov-refresh">Refresh now</button></p></div>
      <div class="actions" style="margin:0"><a class="btn primary" href="#/new">New campaign</a></div>
    </div>
    ${!rows.length ? `<div class="panel"><p>${s.synced_at ? "The sheet has no campaigns yet." : "The overview hasn't been read from the sheet yet. Click <b>Refresh now</b>; if that fails, the sheet script needs its latest version deployed."}</p></div>` : `
    <div class="ov2-sum" id="ov-stats"></div>
    <div class="ov2-bar">
      <div class="ov2-tabs" role="tablist" aria-label="Status">${STATUS_TABS.map(([k, l]) => `<button type="button" role="tab" data-ovtab="${esc(k)}">${l}<b data-ovcount="${esc(k)}"></b></button>`).join("")}</div>
      <label class="ov2-search" id="ov-searchwrap"><svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="8.5" cy="8.5" r="5.5"/><path d="m13 13 4 4"/></svg><input id="ov-q" type="search" placeholder="Search artist, song, client, PO…" aria-label="Search the overview"></label>
      <div class="ov-filt">
        <button type="button" class="ov2-icon" id="ov-fbtn" aria-expanded="false" aria-controls="ov-fpanel" title="Filter and sort"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3.5 6h13M6 10.5h8M8.5 15h3"/></svg><span class="ov-count" id="ov-fcount" hidden></span></button>
        <div class="ov-fpanel" id="ov-fpanel" role="dialog" aria-label="Filter and sort" data-pop hidden>
          <label class="ov2-sortlbl"><span>Sort by</span><select id="ov-sort">${Object.keys(SORTS).map((k) => [SORTS[k].first, other(SORTS[k].first)].map((d) => `<option value="${k}:${d}">${esc(sortLabel(k, d))}</option>`).join("")).join("")}</select></label>
          ${FILTERS.map((f) => `<label><span>${esc(f.label)}</span><select id="ov-${f.key}"><option value="">${esc(f.all)}</option>${optionsFor(f).map(([x, l]) => `<option value="${esc(x)}">${esc(l)}</option>`).join("")}</select></label>`).join("")}
          <div class="ov-fpanel-foot"><button type="button" class="link-btn" id="ov-fclear">Clear filters</button><span class="muted small">Saved for you only</span></div>
        </div>
      </div>
    </div>
    <div id="ov-list"></div>`}
    ${notInSheet.length ? `<div class="panel ov-missing"><h3>In the tracker, not in the sheet yet</h3>
      <p class="small muted">These campaigns are sent to the sheet once they have a PO number.</p>
      <ul>${notInSheet.map((c) => `<li><a href="#/c/${esc(c.id)}">${esc(c.artist)}${c.song ? ` – ${esc(c.song)}` : ""}</a> <span class="muted small">${c.po_number ? esc(c.po_number) + " · on its way" : "no PO number"}</span></li>`).join("")}</ul></div>` : ""}`;

  document.getElementById("ov-refresh").onclick = async (e) => {
    const b = e.currentTarget; b.disabled = true; b.textContent = "Reading the sheet…";
    const { data, error } = await sb.functions.invoke("sheet-sync", { body: { action: "pull_overview" } });
    if (token !== routeToken) return;
    if (error || data?.error) { b.disabled = false; b.textContent = "Refresh now"; toast(`Couldn't read the sheet: ${data?.error ?? error.message}`); return; }
    toast(`Read ${data.rows} campaigns from the sheet`);
    renderOverview(newToken());
  };
  if (!rows.length) return;

  // Artist pictures: the same ones the campaign pages use (table artists). Missing ones are looked up once.
  const artKey = (x) => String(x ?? "").trim().toLowerCase();
  const pics = new Map();
  try {
    const { data: arts } = await sb.from("artists").select("name_key,image_url").not("image_url", "is", null);
    for (const a of arts ?? []) pics.set(a.name_key, a.image_url);
  } catch { /* pictures are optional */ }
  if (token !== routeToken) return;
  const initials = (x) => String(x || "?").split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase();
  const avatar = (r, big = false) => {
    const name = v(r, "Artist Name"), img = pics.get(artKey(name));
    return `<span class="ov2-av${big ? " big" : ""}" data-art="${esc(artKey(name))}">${img ? `<img src="${esc(img)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : esc(initials(name))}</span>`;
  };
  (async () => {
    const tried = (() => { try { return JSON.parse(sessionStorage.getItem("art-tried") ?? "[]"); } catch { return []; } })();
    const want = [...new Set(rows.map((r) => v(r, "Artist Name")).filter(Boolean))].filter((nm) => !pics.has(artKey(nm)) && !tried.includes(artKey(nm))).slice(0, 25);
    for (const nm of want) {
      if (token !== routeToken && !document.getElementById("ov-list")) return;
      tried.push(artKey(nm)); try { sessionStorage.setItem("art-tried", JSON.stringify(tried)); } catch { /* ignore */ }
      try {
        const hits = await searchArtists(nm);
        const hit = hits.find((h) => artKey(h.name) === artKey(nm) && h.image);
        if (!hit) continue;
        const { error } = await sb.from("artists").upsert({ name: nm.trim(), deezer_id: hit.deezer_id ?? null, cm_artist: hit.cm_artist ?? null, image_url: hit.image, updated_at: new Date().toISOString() }, { onConflict: "name_key", ignoreDuplicates: true });
        if (error) continue;
        pics.set(artKey(nm), hit.image);
        document.querySelectorAll(`.ov2-av[data-art="${CSS.escape(artKey(nm))}"]`).forEach((el) => { el.innerHTML = `<img src="${esc(hit.image)}" alt="" referrerpolicy="no-referrer">`; });
      } catch { /* try again another day */ }
    }
  })();

  const listEl = document.getElementById("ov-list");
  const filtered = (ignoreStatus = false) => {
    const q = st.q.trim().toLowerCase();
    let list = rows.filter((r) =>
      (ignoreStatus || !st.status || v(r, "Status") === st.status) && (!st.dri || v(r, "Stellar DRI") === st.dri) &&
      (!st.market || v(r, "Client Market") === st.market) && (!st.invoice || v(r, "Invoice Status") === st.invoice) &&
      (!st.tracker || (st.tracker === "yes") === !!r.camp) &&
      (!q || ["Artist Name", "Song Name (s) or Project Name", "Client", "Stellar PO no.", "Client Contact Name", "Client Contact eMail", "Invoicing Entity"].some((h) => v(r, h).toLowerCase().includes(q))));
    // Empty values always go last; ties fall back to the most recently added.
    const get = SORTS[st.sort].get, sign = st.dir === "asc" ? 1 : -1;
    const keyed = list.map((r) => [get(r), r]);
    keyed.sort(([a, ra], [b, rb]) => {
      if (a == null && b == null) return rb.row - ra.row;
      if (a == null) return 1;
      if (b == null) return -1;
      const c = typeof a === "number" ? a - b : String(a).localeCompare(String(b));
      return c ? c * sign : rb.row - ra.row;
    });
    return keyed.map(([, r]) => r);
  };
  const STATUS_PILL = { Active: ["live", "Live"], Upcoming: ["soon", "Upcoming"], "On Hold": ["hold", "On hold"], Completed: ["done", "Completed"] };
  const statusPill = (x) => { const [c, l] = STATUS_PILL[x] ?? ["done", x || "No status"]; return `<span class="ov2-pill ${c}">${esc(l)}</span>`; };
  const poPill = (r) => v(r, "Stellar PO no.") ? `<span class="ov2-po">${esc(v(r, "Stellar PO no."))}${copyBtn(v(r, "Stellar PO no."))}</span>` : `<span class="ov2-po none">No PO yet</span>`;
  const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const shortDate = (x) => { const d = sheetDate(x); return d ? `${Number(d.slice(8))} ${MON[Number(d.slice(5, 7)) - 1]}` : ""; };
  const invoiceDue = (r) => v(r, "Status") === "Completed" && v(r, "Invoice Status") !== "Invoiced" && !!v(r, "Price");
  // One campaign, laid out for reading (shown under "All details" in the side panel).
  const COUNTRY_FIX = { UK: "GB", SP: "ES", AUS: "AU" };
  const place = (x) => {
    if (!x) return "";
    const code = COUNTRY_FIX[x.toUpperCase()] ?? x.toUpperCase();
    return /^[A-Z]{2}$/.test(code) ? `${flag(code)} ${esc(regionName(code))}` : esc(x);
  };
  const longDate = (x) => {
    const d = sheetDate(x);
    return d ? new Date(d + "T00:00:00Z").toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }) : esc(x);
  };
  const line = (label, value) => (value ? `<div class="ovd-line"><span>${esc(label)}</span><b>${value}</b></div>` : "");
  const details = (r) => {
    const cur = v(r, "Currency");
    const cost = sheetNumber(v(r, "Campaign Cost"));
    const amt = (x) => (x == null ? "" : `${Math.round(x).toLocaleString("en-GB")} <span class="muted">${esc(cur)}</span>`);
    const allocs = ALLOC_COLUMNS.map((m, i) => ({ m, x: sheetNumber(v(r, m)) })).filter((a) => a.x);
    const allocTotal = allocs.reduce((t, a) => t + a.x, 0);
    const COL = ["#0f25bf", "#3a4fd0", "#6577dd", "#8b9cec", "#b4c0f4", "#4a9d6e"];
    return `<div class="ov2-all">
      <section><h4>Campaign</h4>
        ${line("Starts", v(r, "Start Date") ? `${longDate(v(r, "Start Date"))}${v(r, "Duration") ? ` <span class="muted">· ${esc(v(r, "Duration"))}</span>` : ""}` : "")}
        ${line("Type", [v(r, "Type (NR or Cat)"), v(r, "Campaign Type")].filter(Boolean).map(esc).join(" · "))}
        ${line("Regions", esc(v(r, "Campaign Market")))}
        ${line("Campaign cost", cost != null ? amt(cost) : "")}
        ${allocs.length ? `<div class="ovd-alloc"><div class="ovd-alloc-head">Budget split</div>
          <div class="ovd-bar">${allocs.map((a, i) => `<i style="flex:${a.x};background:${COL[i % COL.length]}" title="${esc(a.m)}"></i>`).join("")}</div>
          ${allocs.map((a, i) => `<div class="ovd-line"><span><i class="dot" style="background:${COL[i % COL.length]}"></i>${esc(a.m)}</span><b>${amt(a.x)}${allocTotal ? ` <span class="muted small">${Math.round((a.x / allocTotal) * 100)}%</span>` : ""}</b></div>`).join("")}</div>` : `<p class="muted small">No budget split yet.</p>`}
      </section>
      <section><h4>Client</h4>
        ${line("Based in", place(v(r, "Client Location (Country)")))}
        ${line("Client market", esc(v(r, "Client Market")))}
        ${line("Label", esc(v(r, "Major / Indie / Other")))}
        ${line("Under NDA", esc(v(r, "Under NDA?")))}
        ${line("Email", v(r, "Client Contact eMail") ? `<a href="mailto:${esc(v(r, "Client Contact eMail"))}">${esc(v(r, "Client Contact eMail"))}</a>` : "")}
      </section>
      <section><h4>Invoicing</h4>
        ${line("Invoice", `${esc(v(r, "Invoice Status") || "Not invoiced")}${v(r, "Invoice #") ? ` · #${esc(v(r, "Invoice #"))}` : ""}`)}
        ${line("Payment", v(r, "Paid") === "Paid" ? `Paid${v(r, "Date Paid") ? ` · ${esc(longDate(v(r, "Date Paid")))}` : ""}` : "Not paid")}
      </section>
      ${v(r, "Comments") ? `<section><h4>Comments</h4><p>${esc(v(r, "Comments"))}</p></section>` : ""}
    </div>`;
  };

  // ---------- side panel ----------
  let current = [], openRow = null;
  const drawer = document.createElement("div");
  drawer.className = "ov2-drawer"; drawer.hidden = true;
  drawer.innerHTML = `<div class="ov2-back"></div><aside class="ov2-panel" role="dialog" aria-modal="true" aria-label="Campaign"></aside>`;
  app.appendChild(drawer);
  const panel = drawer.querySelector(".ov2-panel");
  const closePanel = () => { drawer.classList.remove("in"); openRow = null; listEl.querySelectorAll(".ov2-row.sel").forEach((x) => x.classList.remove("sel")); setTimeout(() => { if (!openRow) { drawer.hidden = true; panel.innerHTML = ""; } }, 220); };
  drawer.querySelector(".ov2-back").onclick = closePanel;
  const onKey = (e) => {
    if (!document.body.contains(drawer)) { document.removeEventListener("keydown", onKey); return; }
    if (drawer.hidden || document.querySelector(".dlg-back, dialog[open]")) return;
    if (e.key === "Escape") closePanel();
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") step(e.key === "ArrowRight" ? 1 : -1);
  };
  document.addEventListener("keydown", onKey);
  function step(d) { const i = current.findIndex((r) => r.row === openRow); const nx = current[i + d]; if (nx) openPanel(nx); }
  function nextStep(r) {
    const status = v(r, "Status"), inv = v(r, "Invoice Status") === "Invoiced", paid = v(r, "Paid") === "Paid";
    if (!r.camp) return { text: "Not in the tracker yet. Create it to track posts and keep this row in sync.", btn: `<button type="button" data-create="${r.row}">Create in tracker</button>` };
    if (paid) return { text: "Paid. Nothing left to do." };
    if (inv) return { text: `Invoiced${v(r, "Invoice #") ? ` (#${esc(v(r, "Invoice #"))})` : ""}. Waiting for the client to pay.`, btn: `<a class="btn" href="#/invoices">Invoices</a>` };
    if (status === "Completed") return { text: "Finished and not invoiced yet.", btn: `<button type="button" data-reqinv="${r.row}">Request invoice</button>`, warn: true };
    if (status === "Active") return { text: `Live${r.camp.live_posts ? ` · ${compact(r.camp.total_plays)} plays from ${n(r.camp.live_posts)} post${r.camp.live_posts === 1 ? "" : "s"}` : " · no posts tracked yet"}.`, btn: `<a class="btn" href="#/c/${esc(r.camp.id)}/add">Add links</a>` };
    return { text: status === "On Hold" ? "On hold." : "Not started yet." };
  }
  function openPanel(r) {
    openRow = r.row;
    listEl.querySelectorAll(".ov2-row").forEach((x) => x.classList.toggle("sel", Number(x.dataset.row) === r.row));
    const i = current.findIndex((x) => x.row === r.row);
    const status = v(r, "Status"), inv = v(r, "Invoice Status") === "Invoiced", paid = v(r, "Paid") === "Paid";
    const at = paid ? 3 : inv ? 2 : status === "Active" || status === "Completed" ? 1 : 0;
    const steps = ["Booked", "Live", "Invoiced", "Paid"];
    const price = sheetNumber(v(r, "Price")), cost = sheetNumber(v(r, "Campaign Cost"));
    const margin = v(r, "Margin") || (price && cost != null ? `${Math.round(((price - cost) / price) * 100)}%` : "–");
    const ns = nextStep(r);
    const contact = v(r, "Client Contact Name") || v(r, "Client Contact eMail");
    panel.innerHTML = `
      <div class="ov2-ptop"><span class="ov2-nav"><button type="button" data-step="-1" aria-label="Previous campaign"${i <= 0 ? " disabled" : ""}>‹</button><button type="button" data-step="1" aria-label="Next campaign"${i >= current.length - 1 ? " disabled" : ""}>›</button><span>${i + 1} of ${current.length}</span></span>
        <button type="button" class="ov2-x" aria-label="Close">×</button></div>
      <div class="ov2-ph">${avatar(r, true)}<div><h2>${esc(v(r, "Artist Name") || "–")}</h2><div class="muted">${esc(v(r, "Song Name (s) or Project Name"))}</div><div class="ov2-phkeys">${poPill(r)}${statusPill(status)}</div></div></div>
      <div class="ov2-track" aria-label="Progress">${steps.map((_, k) => `${k ? `<b class="${k <= at ? "on" : ""}"></b>` : ""}<i class="${k <= at ? "on" : ""}"></i>`).join("")}</div>
      <div class="ov2-trackl">${steps.map((l, k) => `<span class="${k === at ? "on" : ""}">${l}</span>`).join("")}</div>
      <div class="ov2-big">
        <div><b>${price != null ? Math.round(price).toLocaleString("en-GB") : "–"} <small>${esc(v(r, "Currency"))}</small></b><span>Price</span></div>
        <div><b>${esc(margin)}</b><span>Margin</span></div>
        <div><b>${r.camp?.total_plays ? compact(r.camp.total_plays) : "–"}</b><span>Plays</span></div>
      </div>
      <dl class="ov2-facts">
        <div><dt>Client</dt><dd>${esc(v(r, "Client") || "–")}</dd></div>
        <div><dt>Invoicing entity</dt><dd>${esc(v(r, "Invoicing Entity") || "–")}</dd></div>
        <div><dt>Starts</dt><dd>${v(r, "Start Date") ? esc(longDate(v(r, "Start Date"))) : "–"}${v(r, "Duration") ? ` · ${esc(v(r, "Duration"))}` : ""}</dd></div>
        <div><dt>Stellar DRI</dt><dd>${esc(v(r, "Stellar DRI") || "–")}</dd></div>
        <div><dt>Client market</dt><dd>${esc((v(r, "Client Market") || "–").replace(/^Stellar /, ""))}</dd></div>
        <div><dt>Contact</dt><dd>${esc(contact || "–")}</dd></div>
      </dl>
      <details class="ov2-more"><summary>All details</summary>${details(r)}</details>
      <div class="ov2-next${ns.warn ? " warn" : ""}"><small>Next step</small><div><span>${ns.text}</span>${ns.btn ?? ""}</div></div>
      <div class="ov2-pfoot">
        ${r.camp ? `<a class="btn primary" href="#/c/${esc(r.camp.id)}">Open campaign</a>` : `<button type="button" class="primary" data-create="${r.row}">Create in tracker</button>`}
        <details class="ov2-menu"><summary aria-label="More actions">⋯</summary><div>
          ${r.camp ? `<a href="#/c/${esc(r.camp.id)}/edit">Edit campaign</a>` : ""}
          <a href="${SHEET_URL}&range=A${r.row}" target="_blank" rel="noopener">Row ${r.row} in the sheet ↗</a>
          <button type="button" class="danger" data-ovdel="${r.row}">Delete…</button></div></details>
      </div>`;
    panel.querySelector(".ov2-x").onclick = closePanel;
    panel.querySelectorAll("[data-step]").forEach((b) => (b.onclick = () => step(Number(b.dataset.step))));
    bindActions(panel);
    if (drawer.hidden) { drawer.hidden = false; requestAnimationFrame(() => drawer.classList.add("in")); }
    panel.scrollTop = 0;
  }

  function bindActions(root) {
    root.querySelectorAll("[data-ovdel]").forEach((b) => (b.onclick = async () => {
      const r = rows.find((x) => x.row === Number(b.dataset.ovdel));
      const name = `${v(r, "Artist Name") || "this campaign"}${v(r, "Song Name (s) or Project Name") ? ` – ${v(r, "Song Name (s) or Project Name")}` : ""}`;
      if (r.camp) {
        // In the tracker too: one dialog covers both.
        const ans = await confirmDialog({
          title: `Delete ${name}?`,
          body: "Choose what to delete. This can't be undone.",
          checks: [
            { id: "camp", label: "The tracker campaign, with its posts, folders and client links", checked: true },
            { id: "sheet", label: `Row ${r.row} in the Campaign Overview sheet`, checked: true },
          ],
        });
        if (!ans || (!ans.camp && !ans.sheet)) return;
        if (ans.sheet) {
          const { data, error } = await sb.functions.invoke("sheet-sync", { body: { action: "delete_row", campaign_id: r.camp.id, row: r.row, key: normKey(v(r, "Artist Name"), v(r, "Song Name (s) or Project Name"), v(r, "Stellar PO no.")) } });
          if (error || data?.error) { toast(`Couldn't delete the sheet row: ${data?.error ?? error.message}`); return; }
        }
        if (ans.camp) {
          const { error } = await sb.from("campaigns").delete().eq("id", r.camp.id);
          if (error) { toast(error.message); return; }
        }
        toast(ans.camp && ans.sheet ? "Deleted from the tracker and the sheet" : ans.camp ? "Deleted from the tracker" : "Sheet row deleted");
      } else {
        const ans = await confirmDialog({ title: `Delete ${name}?`, body: `This deletes row ${r.row} from the Campaign Overview sheet. This can't be undone.`, confirm: "Delete row" });
        if (!ans) return;
        const { data, error } = await sb.functions.invoke("sheet-sync", { body: { action: "delete_row", row: r.row, key: normKey(v(r, "Artist Name"), v(r, "Song Name (s) or Project Name"), v(r, "Stellar PO no.")) } });
        if (error || data?.error) { toast(`Couldn't delete the sheet row: ${data?.error ?? error.message}`); return; }
        toast("Sheet row deleted");
      }
      renderOverview(newToken());
    }));
    root.querySelectorAll("[data-create]").forEach((b) => (b.onclick = () => {
      const r = rows.find((x) => x.row === Number(b.dataset.create));
      sessionStorageSet("prefill", JSON.stringify(prefillFromRow(r)));
      go("#/new");
    }));
    root.querySelectorAll("[data-reqinv]").forEach((b) => (b.onclick = async () => {
      const r = rows.find((x) => x.row === Number(b.dataset.reqinv));
      const { data: c } = await sb.from("campaign_summary").select("*").eq("id", r.camp.id).maybeSingle();
      if (c) requestInvoiceDialog(sb, c, { toast, onDone: () => { b.disabled = true; b.textContent = "Requested"; } });
    }));
  }

  function drawStats(list) {
    const live = list.filter((r) => v(r, "Status") === "Active");
    const notInv = list.filter((r) => v(r, "Invoice Status") && v(r, "Invoice Status") !== "Invoiced");
    const usdTxt = (t) => (t.curs.length ? `$${Math.round(t.usd).toLocaleString("en-US")}` : "–");
    const all = totalsUsd(list), ni = totalsUsd(notInv);
    const tip = (t) => esc(t.curs.map(([c, x]) => `${c} ${Math.round(x).toLocaleString("en-GB")}`).join(" · "));
    document.getElementById("ov-stats").innerHTML = `
      <div><div class="n">${n(live.length)}</div><div class="l">Live now</div></div>
      <div title="${tip(all)}"><div class="n">${usdTxt(all)}</div><div class="l">Booked${list.length !== rows.length ? " in this view" : ""} · ${n(list.length)} campaign${list.length === 1 ? "" : "s"}</div></div>
      <div class="warn" title="${tip(ni)}"><div class="n">${usdTxt(ni)}</div><div class="l">Still to invoice · ${n(notInv.length)}</div></div>
      <div><div class="n">${n(list.filter((r) => r.camp).length)}</div><div class="l">In the tracker</div></div>`;
  }
  const COLS = [["artist", "Artist and song", "first"], [null, "PO number", "po-h"], ["client", "Client"], ["dri", "Stellar DRI"], ["start", "Starts"], ["price", "Price", "num"], ["status", "Status"]];
  function draw() {
    const base = filtered(true);
    STATUS_TABS.forEach(([k]) => { const el = app.querySelector(`[data-ovcount="${CSS.escape(k)}"]`); if (el) el.textContent = n(k ? base.filter((r) => v(r, "Status") === k).length : base.length); });
    app.querySelectorAll("[data-ovtab]").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.ovtab === st.status)));
    const list = filtered();
    current = list;
    drawStats(st.status ? base : list);
    if (!list.length) { listEl.innerHTML = `<div class="panel ov2-empty"><p>No campaigns ${st.status ? `are ${esc((STATUS_PILL[st.status] ?? [, st.status])[1].toLowerCase())}` : "match"}${st.q || FILTERS.some((f) => st[f.key]) ? " with these filters" : ""}.</p></div>`; return; }
    const head = `<div class="ov2-cols">${COLS.map(([k, label, cls]) => !k ? `<span class="${cls ?? ""}">${label}</span>`
      : `<button type="button" class="${cls ?? ""}${st.sort === k ? " on" : ""}" data-sort="${k}" title="Sort by ${label.toLowerCase()}">${label}${st.sort === k ? `<i>${st.dir === "asc" ? "↑" : "↓"}</i>` : ""}</button>`).join("")}</div>`;
    const rowHtml = (r) => `
      <div class="ov2-row${openRow === r.row ? " sel" : ""}" data-row="${r.row}" tabindex="0" role="button" aria-label="${esc(v(r, "Artist Name"))} ${esc(v(r, "Song Name (s) or Project Name"))}">
        ${avatar(r)}
        <div class="ov2-t"><b>${esc(v(r, "Artist Name") || "–")}</b><span>${esc(v(r, "Song Name (s) or Project Name") || "—")}</span></div>
        <div>${poPill(r)}</div>
        <div class="ov2-c" title="${esc(v(r, "Client"))}">${esc(v(r, "Client") || "—")}</div>
        <div class="ov2-c">${esc(v(r, "Stellar DRI") || "—")}</div>
        <div class="ov2-when">${v(r, "Start Date") ? `<b>${esc(shortDate(v(r, "Start Date")) || v(r, "Start Date"))}</b>` : `<b class="muted">—</b>`}<small>${esc(v(r, "Duration"))}</small></div>
        <div class="ov2-price" title="${priceUsd(r) != null && curOf(r) !== "USD" ? `≈ $${Math.round(priceUsd(r)).toLocaleString("en-US")}` : ""}">${v(r, "Price") ? `${Math.round(sheetNumber(v(r, "Price")) ?? 0).toLocaleString("en-GB")}<span>${esc(v(r, "Currency"))}</span>` : "–"}${invoiceDue(r) ? `<em>Invoice due</em>` : ""}</div>
        <div class="ov2-st">${statusPill(v(r, "Status"))}</div>
      </div>`;
    let body;
    if (st.sort === "start") {
      const groups = new Map();
      for (const r of list) { const d = sheetDate(v(r, "Start Date")); const k = d ? d.slice(0, 7) : ""; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r); }
      body = [...groups.entries()].map(([k, rs]) => {
        const t = totalsUsd(rs);
        return `<div class="ov2-month"><span>${k ? `${MON[Number(k.slice(5)) - 1]} ${k.slice(0, 4)}` : "No start date"}</span><span>${n(rs.length)}${t.curs.length ? ` · $${Math.round(t.usd / 1000)}K` : ""}</span></div>
          <div class="ov2-list">${rs.map(rowHtml).join("")}</div>`;
      }).join("");
    } else body = `<div class="ov2-list ov2-flat">${list.map(rowHtml).join("")}</div>`;
    listEl.innerHTML = head + body;
    listEl.querySelectorAll(".ov2-row").forEach((el) => {
      const r = rows.find((x) => x.row === Number(el.dataset.row));
      el.onclick = (e) => { if (e.target.closest("[data-copy],a,button")) return; openPanel(r); };
      el.onkeydown = (e) => { if ((e.key === "Enter" || e.key === " ") && e.target === el) { e.preventDefault(); openPanel(r); } };
    });
  }
  const sortSel = document.getElementById("ov-sort");
  const fcount = document.getElementById("ov-fcount");
  const refreshControls = () => {
    sortSel.value = `${st.sort}:${st.dir}`;
    const k = FILTERS.filter((f) => st[f.key]).length;
    fcount.hidden = !k; fcount.textContent = k;
    document.getElementById("ov-fbtn").classList.toggle("on", !!k);
  };
  const bind = (elId, key) => {
    const el = document.getElementById(elId); el.value = st[key];
    el.oninput = () => { st[key] = el.value; if (key !== "q") persist(); refreshControls(); draw(); };
  };
  bind("ov-q", "q");
  FILTERS.forEach((f) => bind(`ov-${f.key}`, f.key));
  app.querySelectorAll("[data-ovtab]").forEach((b) => (b.onclick = () => { st.status = b.dataset.ovtab; persist(); draw(); }));
  sortSel.onchange = () => { [st.sort, st.dir] = sortSel.value.split(":"); persist(); draw(); };
  // Column labels sort too: click once for the natural direction, again to flip it.
  listEl.addEventListener("click", (e) => {
    const b = e.target.closest("[data-sort]");
    if (!b) return;
    const k = b.dataset.sort;
    st.dir = st.sort === k ? other(st.dir) : SORTS[k].first; st.sort = k;
    persist(); refreshControls(); draw();
  });
  // Filters panel: opens under its button, closes on Escape or a click elsewhere.
  const fbtn = document.getElementById("ov-fbtn"), fpanel = document.getElementById("ov-fpanel");
  const setPanel = (open) => { fpanel.hidden = !open; fbtn.setAttribute("aria-expanded", open); if (open) fpanel.querySelector("select")?.focus(); };
  fbtn.onclick = () => setPanel(fpanel.hidden);
  // Clicking outside and Escape are handled for every pop-up by closePopups() below.
  document.getElementById("ov-fclear").onclick = () => {
    FILTERS.forEach((f) => { st[f.key] = ""; document.getElementById(`ov-${f.key}`).value = ""; });
    persist(); refreshControls(); draw();
  };
  refreshControls();
  draw();
}

// ---------- campaign list ----------
async function renderList(token) {
  app.innerHTML = `
    <div class="page-head">
      <div><h1>Campaigns</h1><p class="voice muted" id="summary" style="margin:8px 0 0;font-size:20px">&nbsp;</p></div>
      <a class="btn primary" href="#/new">New campaign</a>
    </div>
    <div class="filters">
      <input id="q" type="search" placeholder="Search artist, song, PO, client or owner" aria-label="Search campaigns">
      <select id="st" aria-label="Status">
        <option value="active">Active</option><option value="draft">Upcoming</option><option value="on_hold">On hold</option>
        <option value="finished">Completed</option><option value="">All</option>
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
      (!term || [r.artist, r.song, r.po_number, r.client, r.campaign_runner, r.comms_owner].some((v) => (v ?? "").toLowerCase().includes(term))));
    document.getElementById("list").innerHTML = shown.length === 0
      ? `<div class="panel"><p>${rows.length === 0 ? "No campaigns yet. Create the first one to start adding links." : "No campaigns match these filters."}</p></div>`
      : `<div class="table-wrap"><table>
          <thead><tr><th>Artist and song</th><th>Client</th><th>Runner</th><th>Dates</th><th class="num">Budget</th><th class="num">Spend</th><th class="num">Live posts</th><th class="num">Plays</th><th class="num">Cost per view</th><th>Status</th><th><span class="sr">Edit or delete</span></th></tr></thead>
          <tbody>${shown.map((r) => `
            <tr data-id="${esc(r.id)}" tabindex="0">
              <td><div class="artist">${esc(r.artist)}</div><div class="song small">${esc(r.song)}${r.po_number ? ` <span class="po">${esc(r.po_number)}</span>` : ""}</div></td>
              <td>${esc(r.client)}</td>
              <td>${esc(r.campaign_runner)}</td>
              <td class="small">${esc(date(r.start_date))}${r.end_date ? ` to ${esc(date(r.end_date))}` : ""}</td>
              <td class="num">${money(r.budget, r.currency)}</td>
              <td class="num">${Number(r.spend) ? money(r.spend, r.currency) : "–"}</td>
              <td class="num">${n(r.live_posts)}</td>
              <td class="num plays-cell">${compact(r.total_plays)}</td>
              <td class="num">${cpv(r.cost_per_view, r.currency)}</td>
              <td><span class="status ${esc(r.status)}">${esc(statusLabel(r.status))}</span>${r.invoiced ? ` <span class="status finished">invoiced</span>` : ""}</td>
              <td><div class="row-tools"><a href="#/c/${esc(r.id)}/edit" title="Edit" aria-label="Edit ${esc(r.artist)}" data-stop>${TOOL_ICON.edit}</a><button type="button" class="del" data-del="${esc(r.id)}" title="Delete" aria-label="Delete ${esc(r.artist)}">${TOOL_ICON.del}</button></div></td>
            </tr>`).join("")}</tbody></table></div>`;
    document.querySelectorAll("[data-del]").forEach((b) => (b.onclick = (e) => {
      e.stopPropagation();
      deleteCampaignFlow(rows.find((r) => r.id === b.dataset.del), () => renderList(newToken()));
    }));
    document.querySelectorAll("tbody tr").forEach((tr) => {
      tr.onclick = (e) => { if (e.target.closest("[data-stop],[data-del]")) return; go(`#/c/${tr.dataset.id}`); };
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
const CURRENCIES = ["USD", "EUR", "GBP", "AUD", "JPY", "DKK", "SGD", "IDR", "THB", "PHP", "MYR", "VND", "BRL", "MXN", "COP", "ARS", "CLP"];
let MARKETS = null;   // [{ name, region, position }], the sheet's allocation columns
async function marketList() {
  if (!MARKETS) {
    const { data } = await sb.from("markets").select("name,region,position,sheet_column").order("position");
    MARKETS = data ?? [];
  }
  return MARKETS;
}

async function renderForm(token, id) {
  let c = { status: "active", currency: "USD", invoiced: false, folders_by_market: true };
  let rows = [];
  let sync = null;
  let fromSheet = null;
  if (!id) {
    // "Create in tracker" on the Campaign overview hands over the sheet row's values.
    try { fromSheet = JSON.parse(sessionStorageGet("prefill") ?? "null"); } catch { fromSheet = null; }
    sessionStorageSet("prefill", "null");
    if (fromSheet) {
      c = { ...c, ...Object.fromEntries(Object.entries(fromSheet.campaign).filter(([, x]) => x !== null && x !== undefined)) };
      rows = fromSheet.markets ?? [];
    }
  }
  const allMarkets = await marketList();
  const teamNames = ((await sb.from("team_members").select("name")).data ?? []).map((t) => t.name).filter((x) => x && x !== "Admin").sort();
  if (id) {
    const [{ data, error }, m, s] = await Promise.all([
      sb.from("campaigns").select("*").eq("id", id).single(),
      sb.from("campaign_markets").select("market,share_percent,amount").eq("campaign_id", id),
      sb.from("campaign_sheet_sync").select("*").eq("campaign_id", id).maybeSingle(),
    ]);
    if (token !== routeToken) return;
    if (error) { app.innerHTML = fail(error); return; }
    c = data; rows = m.data ?? []; sync = s.data;
  }
  if (token !== routeToken) return;
  const v = (k) => esc(c[k] ?? "");
  const opt = (list, cur, blank = "Choose…") => `<option value="">${blank}</option>${list.map((x) => {
    const [val, label] = Array.isArray(x) ? x : [x, x];
    return `<option value="${esc(val)}" ${cur === val ? "selected" : ""}>${esc(label)}</option>`;
  }).join("")}`;
  const list = (idName, items) => `<datalist id="${idName}">${items.map((x) => `<option value="${esc(x)}">`).join("")}</datalist>`;
  // Splits are entered one way for the whole campaign: % of the budget, or amounts.
  let mode = c?.split_mode ?? (rows.some((r) => r.amount != null) && !rows.some((r) => r.share_percent != null) ? "amount" : "percent");

  app.innerHTML = `
    <div class="page-head"><h1>${id ? "Edit campaign" : "New campaign"}</h1></div>
    ${fromSheet ? `<p class="panel small prefill-note">Filled in from row ${esc(fromSheet.sheetRow)} of the Campaign Overview sheet. Check the details, then create it: the tracker will keep that same row up to date.</p>` : ""}
    <form id="cf" class="panel form-sections" novalidate>
      <h2>Campaign</h2>
      <div class="form-grid">
        <div class="artist-pick"><label for="artist">Artist</label><div class="pick-wrap"><input id="artist" required value="${v("artist")}" placeholder="Start typing to search">
          <div class="art-results" id="artist-results" hidden></div></div>
          <div class="art-chosen" id="artist-chosen"></div></div>
        <div><label for="song">Song or project</label><input id="song" value="${v("song")}"></div>
        <div><label for="po_number">PO number</label><input id="po_number" placeholder="#ST2109" value="${v("po_number")}" autocomplete="off">
          <p class="hint" id="po-hint">Shared with the Campaign Overview sheet. Artist, song and PO together identify the campaign.</p></div>
        <div><label for="status">Status</label><select id="status">${opt(STATUSES, c.status, "").replace('<option value=""></option>', "")}</select></div>
        <div><label for="campaign_type">Campaign type</label><input id="campaign_type" list="ctypes" value="${v("campaign_type")}" placeholder="Phase 1">${list("ctypes", CAMPAIGN_TYPES)}</div>
        <div><label for="release_type">New release or catalogue</label><select id="release_type">${opt(RELEASE_TYPES, c.release_type)}</select></div>
        <div><label for="start_date">Start date</label><input id="start_date" type="date" value="${v("start_date")}"></div>
        <div><label for="end_date">End date</label><input id="end_date" type="date" value="${v("end_date")}">
          <p class="hint">Leave empty for an ongoing campaign.</p></div>
        <div><label for="budget">Price (budget)</label><input id="budget" type="number" min="0" step="0.01" value="${v("budget")}"></div>
        <div><label for="currency">Currency</label><input id="currency" list="currencies" maxlength="3" value="${v("currency")}">${list("currencies", CURRENCIES)}</div>
        <div><label for="comms_owner">Stellar DRI</label><input id="comms_owner" value="${v("comms_owner")}"></div>
        <div class="runner-field"><label id="runner-l">Running the campaign</label>
          <div class="people-pick" id="runner-pick" role="group" aria-labelledby="runner-l">${(() => {
            const sel = splitPeople(c.campaign_runner);
            return [...new Set([...teamNames, ...sel])].map((nm) => `<button type="button" class="pp" data-pp="${esc(nm)}" aria-pressed="${sel.includes(nm)}">${esc(nm)}</button>`).join("") || `<span class="muted small">Add team members first.</span>`;
          })()}</div>
          <input type="hidden" id="campaign_runner" value="${v("campaign_runner")}">
          <p class="hint">The people who reach out to and pay creators. Only they are offered in the payout sheet.</p></div>
      </div>

      <h2>Client</h2>
      <div class="form-grid">
        <div><label for="client">Client</label><input id="client" placeholder="Label or brand" value="${v("client")}"></div>
        <div><label for="invoicing_entity">Invoicing entity</label><input id="invoicing_entity" list="entities" value="${v("invoicing_entity")}">${list("entities", INVOICING_ENTITIES)}</div>
        <div><label for="client_country">Client location</label><input id="client_country" list="ccountries" value="${v("client_country")}" placeholder="US">${list("ccountries", CLIENT_COUNTRIES)}</div>
        <div><label for="client_market">Client market</label><select id="client_market">${opt(CLIENT_MARKETS, c.client_market)}</select></div>
        <div><label for="client_contact_name">Contact name</label><input id="client_contact_name" value="${v("client_contact_name")}"></div>
        <div><label for="client_contact_email">Contact email</label><input id="client_contact_email" type="email" value="${v("client_contact_email")}"></div>
        <div><label for="label_type">Major, indie or other</label><select id="label_type">${opt(LABEL_TYPES, c.label_type)}</select></div>
        <div><label for="under_nda">Under NDA</label><select id="under_nda">${opt([["yes", "Yes"], ["no", "No"]], c.under_nda === true ? "yes" : c.under_nda === false ? "no" : "")}</select></div>
      </div>

      <h2>Markets</h2>
      <div class="split-head">
        <p class="muted small" style="margin:0">Add each market and its share of the budget. Countries add up into their column in the sheet, e.g. Indonesia and Philippines both count towards SEA.</p>
        <div class="seg" role="group" aria-label="Enter splits as">
          <button type="button" data-mode="percent">%</button><button type="button" data-mode="amount">Amount</button>
        </div>
      </div>
      <div id="markets"></div>
      <div class="split-foot"><button type="button" id="add-market">Add market</button><span class="small muted" id="split-total"></span></div>
      <p class="small muted split-rule" id="split-rule"></p>
      <label class="check folder-opt"><input id="folders_by_market" type="checkbox" ${c.folders_by_market ? "checked" : ""}>
        <span>Create a folder for each market<br><span class="muted small">Untick to organise posts your own way, for example by creative. You can add folders on the campaign page.</span></span></label>

      <h2>Notes</h2>
      <div class="form-grid">
        <div class="field-wide"><label class="check"><input id="invoiced" type="checkbox" ${c.invoiced ? "checked" : ""}> Invoiced</label></div>
        <div class="field-wide"><label for="notes" class="sr">Notes</label><textarea id="notes" style="min-height:80px" placeholder="Anything the team should know">${v("notes")}</textarea></div>
      </div>
      ${sheetLine(sync, c)}
      <div id="form-msg"></div>
      <div class="actions">
        <button class="primary" type="submit">${id ? "Save changes" : "Create campaign"}</button>
        <a class="btn" href="${id ? `#/c/${esc(id)}` : "#/campaigns"}">Cancel</a>
        ${id ? `<button type="button" id="delete" class="danger" style="margin-left:auto">Delete campaign</button>` : ""}
      </div>
    </form>`;

  const box = document.getElementById("markets");
  const $ = (k) => document.getElementById(k);

  // Artist: search the music catalogue as you type; the chosen picture brands the dashboards.
  let artistPick = null;          // { cm_artist or deezer_id, image, thumb, name } chosen in this form
  let artistSaved = null;         // what the artists table already has for this name
  const showChosen = () => {
    const pic = artistPick?.thumb ?? artistPick?.image ?? (artistSaved?.image_url && artistKey(artistSaved.name) === artistKey($("artist").value) ? artistSaved.image_url : null);
    $("artist-chosen").innerHTML = pic ? `<img src="${esc(pic)}" alt="" referrerpolicy="no-referrer"><span>${artistPick ? "Picture selected" : "Picture on file"}</span>${artistPick ? ` <button type="button" class="link-btn small" id="artist-clear">Remove</button>` : ""}`
      : $("artist").value.trim() ? `<span>No picture yet: pick the artist from the search results to add one.</span>` : "";
    $("artist-clear")?.addEventListener("click", () => { artistPick = null; showChosen(); });
  };
  const loadSaved = async () => {
    const k = artistKey($("artist").value);
    if (!k) { artistSaved = null; showChosen(); return; }
    const { data } = await sb.from("artists").select("name,image_url").eq("name_key", k).maybeSingle();
    artistSaved = data ?? null; showChosen();
  };
  attachArtistSearch($("artist"), $("artist-results"), (a) => { $("artist").value = a.name; artistPick = a; showChosen(); });
  $("artist").addEventListener("change", () => { if (artistPick && artistKey(artistPick.name) !== artistKey($("artist").value)) artistPick = null; loadSaved(); });
  loadSaved();
  const budget = () => ($("budget").value === "" ? null : Number($("budget").value));
  const cur = () => $("currency").value.trim().toUpperCase() || "";
  const fmt = (x) => Number(x).toLocaleString("en-GB", { maximumFractionDigits: 2 });

  const addRow = (m = {}) => {
    const row = document.createElement("div");
    row.className = "markets-row";
    const val = mode === "percent" ? (m.share_percent ?? (m.amount != null && budget() ? +(m.amount / budget() * 100).toFixed(2) : ""))
      : (m.amount ?? (m.share_percent != null && budget() != null ? +(budget() * m.share_percent / 100).toFixed(2) : ""));
    const groups = [["West", "West"], ["Central", "Central"], ["East", "East"], ["Other", "Global"]];
    row.innerHTML = `<select aria-label="Market"><option value="">Choose a market</option>${groups.map(([r, label]) => `<optgroup label="${label}">${allMarkets.filter((x) => x.region === r).map((x) =>
        `<option value="${esc(x.name)}" ${m.market === x.name ? "selected" : ""}>${esc(x.name)}${x.sheet_column && x.sheet_column !== x.name ? ` (${esc(x.sheet_column)})` : ""}</option>`).join("")}</optgroup>`).join("")}</select>
      <input aria-label="${mode === "percent" ? "Share in percent" : "Amount"}" type="number" min="0" ${mode === "percent" ? 'max="100"' : ""} step="0.01" placeholder="${mode === "percent" ? "%" : "Amount"}" value="${esc(val)}">
      <span class="small muted other"></span>
      <button type="button" class="link-btn danger">Remove</button>`;
    row.querySelector("button").onclick = () => { row.remove(); totals(); };
    row.querySelectorAll("input,select").forEach((i) => (i.oninput = totals));
    box.appendChild(row);
  };
  const readRows = () => [...box.querySelectorAll(".markets-row")].map((r) => {
    const market = r.querySelector("select").value;
    const raw = r.querySelector("input").value;
    const x = raw === "" ? null : Number(raw);
    const b = budget();
    return mode === "percent"
      ? { market, share_percent: x, amount: x != null && b != null ? Math.round(b * x) / 100 : null, _row: r }
      : { market, amount: x, share_percent: x != null && b ? Math.round((x / b) * 10000) / 100 : null, _row: r };
  });
  function totals() {
    const rs = readRows();
    for (const r of rs) {
      r._row.querySelector(".other").textContent = mode === "percent"
        ? (r.amount != null ? `${fmt(r.amount)} ${cur()}` : "")
        : (r.share_percent != null ? `${fmt(r.share_percent)}%` : "");
    }
    const pct = rs.reduce((s, r) => s + (r.share_percent ?? 0), 0);
    const amt = rs.reduce((s, r) => s + (r.amount ?? 0), 0);
    $("split-total").textContent = !rs.length ? "" : mode === "percent"
      ? `${fmt(pct)}% allocated${budget() != null ? ` · ${fmt(amt)} of ${fmt(budget())} ${cur()}` : ""}`
      : `${fmt(amt)}${budget() != null ? ` of ${fmt(budget())}` : ""} ${cur()} allocated${budget() ? ` · ${fmt(pct)}%` : ""}`;
  }
  const ruleText = () => { $("split-rule").textContent = mode === "percent"
    ? "Split by %: if the price changes, here or in the sheet, each market keeps its % and its amount follows."
    : "Split by amount: if the price changes, each market keeps its amount."; };
  const setMode = (m) => {
    const current = readRows().filter((r) => r.market || r.share_percent != null || r.amount != null);
    mode = m;
    document.querySelectorAll("[data-mode]").forEach((b) => b.setAttribute("aria-pressed", b.dataset.mode === mode));
    box.innerHTML = "";
    current.forEach(addRow);
    totals(); ruleText();
  };
  document.querySelectorAll("[data-mode]").forEach((b) => (b.onclick = () => setMode(b.dataset.mode)));
  document.querySelectorAll("[data-mode]").forEach((b) => b.setAttribute("aria-pressed", b.dataset.mode === mode));
  ruleText();
  rows.sort((a, b) => allMarkets.findIndex((x) => x.name === a.market) - allMarkets.findIndex((x) => x.name === b.market)).forEach(addRow);
  if (!rows.length) addRow();
  totals();
  $("add-market").onclick = () => addRow();
  if (!id) suggestPO();
  $("po_number").onblur = () => { const po = normalisePO($("po_number").value); if (po) $("po_number").value = po; };
  $("budget").oninput = totals;
  $("currency").oninput = totals;
  document.querySelectorAll("#runner-pick [data-pp]").forEach((b) => (b.onclick = () => {
    b.setAttribute("aria-pressed", String(b.getAttribute("aria-pressed") !== "true"));
    $("campaign_runner").value = [...document.querySelectorAll('#runner-pick [aria-pressed="true"]')].map((x) => x.dataset.pp).join(", ");
  }));

  $("cf").addEventListener("submit", async (e) => {
    e.preventDefault();
    const msg = $("form-msg");
    const val = (k) => $(k).value.trim();
    const currency = cur();
    if (!val("artist")) { msg.innerHTML = fail("Add the artist's name."); $("artist").focus(); return; }
    if (currency && !/^[A-Z]{3}$/.test(currency)) { msg.innerHTML = fail("Currency must be a three-letter code, such as EUR or USD."); return; }
    if (val("start_date") && val("end_date") && val("end_date") < val("start_date")) { msg.innerHTML = fail("The end date is before the start date."); return; }
    const ms = readRows().filter((r) => r.market || r.share_percent != null || r.amount != null);
    if (ms.some((r) => !r.market)) { msg.innerHTML = fail("Choose a market for each row, or remove the empty row."); return; }
    if (new Set(ms.map((r) => r.market)).size !== ms.length) { msg.innerHTML = fail("Each market can only be listed once."); return; }
    const pct = ms.reduce((s, r) => s + (r.share_percent ?? 0), 0);
    const amt = ms.reduce((s, r) => s + (r.amount ?? 0), 0);
    if (mode === "percent" && pct > 100.001) { msg.innerHTML = fail(`Market shares add up to ${fmt(pct)}%. They can't be more than 100%.`); return; }
    if (mode === "amount" && budget() != null && amt > budget() + 0.001) { msg.innerHTML = fail(`Market amounts add up to ${fmt(amt)}, more than the ${fmt(budget())} budget.`); return; }

    const record = {
      artist: val("artist"), song: val("song") || null, po_number: normalisePO(val("po_number")),
      status: val("status"), campaign_type: val("campaign_type") || null, release_type: val("release_type") || null,
      start_date: val("start_date") || null, end_date: val("end_date") || null,
      budget: budget(), currency: currency || null,
      comms_owner: val("comms_owner") || null, campaign_runner: val("campaign_runner") || null,
      client: val("client") || null, invoicing_entity: val("invoicing_entity") || null, client_country: val("client_country") || null,
      client_market: val("client_market") || null, client_contact_name: val("client_contact_name") || null,
      client_contact_email: val("client_contact_email") || null, label_type: val("label_type") || null,
      under_nda: val("under_nda") === "yes" ? true : val("under_nda") === "no" ? false : null,
      folders_by_market: $("folders_by_market").checked, split_mode: mode,
      invoiced: $("invoiced").checked, notes: val("notes") || null,
    };
    const btn = e.submitter ?? document.querySelector("#cf button[type=submit]"); btn.disabled = true;
    const failWith = (err) => {
      btn.disabled = false;
      msg.innerHTML = fail(err?.code === "23505" ? "Another campaign already has this artist, song and PO number." : err);
    };
    const res = id
      ? await sb.from("campaigns").update(record).eq("id", id).select("id").single()
      : await sb.from("campaigns").insert(record).select("id").single();
    if (res.error) return failWith(res.error);
    const cid = res.data.id;
    if (artistPick) await saveArtist(record.artist, artistPick);

    // Market splits: remove the ones taken off, then save the rest.
    const keep = ms.map((r) => r.market);
    let del = sb.from("campaign_markets").delete().eq("campaign_id", cid);
    if (keep.length) del = del.not("market", "in", `(${keep.map((k) => `"${k}"`).join(",")})`);
    const d = await del;
    if (d.error) return failWith(d.error);
    if (ms.length) {
      const up = await sb.from("campaign_markets").upsert(ms.map(({ market, share_percent, amount }) => ({ campaign_id: cid, market, share_percent, amount })), { onConflict: "campaign_id,market" });
      if (up.error) return failWith(up.error);
    }
    if (record.folders_by_market) {
      const err = await syncMarketFolders(cid, keep, allMarkets);
      if (err) return failWith(err);
    }
    toast(id ? "Changes saved" : "Campaign created");
    go(`#/c/${cid}`);
  });

  const del = $("delete");
  if (del) del.onclick = () => deleteCampaignFlow(c);
}

// One folder per market: add folders for new markets; remove folders for markets taken off,
// but only when they're empty and have no client link.
async function syncMarketFolders(cid, keep, allMarkets) {
  const { data: folders, error } = await sb.from("campaign_folders").select("id,name,market").eq("campaign_id", cid);
  if (error) return error;
  const have = new Set((folders ?? []).flatMap((f) => [f.market, f.name]).filter(Boolean));
  const add = keep.filter((m) => !have.has(m)).map((m) => ({ campaign_id: cid, name: m, market: m, position: allMarkets.find((x) => x.name === m)?.position ?? 0 }));
  if (add.length) {
    const r = await sb.from("campaign_folders").insert(add);
    if (r.error) return r.error;
  }
  const gone = (folders ?? []).filter((f) => f.market && !keep.includes(f.market));
  for (const f of gone) {
    const [{ count }, { data: links }] = await Promise.all([
      sb.from("posts").select("id", { count: "exact", head: true }).eq("folder_id", f.id),
      sb.from("share_links").select("id").eq("folder_id", f.id).eq("revoked", false).limit(1),
    ]);
    if (!count && !links?.length) await sb.from("campaign_folders").delete().eq("id", f.id);
  }
  return null;
}

// New campaigns: fill in the next free PO number (one above the highest in the sheet and the tracker).
async function suggestPO() {
  const input = document.getElementById("po_number"), hint = document.getElementById("po-hint");
  if (!input || input.value) return;
  input.placeholder = "Finding the next PO…";
  const { data, error } = await sb.functions.invoke("sheet-sync", { body: { action: "next_po" } });
  if (!document.body.contains(input)) return;
  input.placeholder = "#ST2109";
  if (error || !data?.po) return;
  if (!input.value) {
    input.value = data.po;
    hint.textContent = data.sheet_error
      ? `Suggested from the tracker only (couldn't read the sheet). Check it's free before saving.`
      : `Next free PO after ${data.po.replace(/\d+$/, (d) => d - 1)} in the Campaign Overview sheet. Change it if you need to.`;
  }
}

// Where this campaign stands in the Campaign Overview sheet.
function sheetLine(sync, c) {
  if (!c?.id) return `<p class="sheet-line small muted">Saving adds this campaign to the Campaign Overview sheet once it has a PO number.</p>`;
  if (!c.po_number) return `<p class="sheet-line small muted">Not in the Campaign Overview sheet yet: add a PO number to send it.</p>`;
  if (!sync) return "";
  // A recent edit made directly in the sheet (or a clash with one) gets its own line.
  const note = sync.sheet_note && sync.sheet_note_at && Date.now() - new Date(sync.sheet_note_at) < 14 * 864e5
    ? `<p class="sheet-line small ${/same time|^Couldn/i.test(sync.sheet_note) ? "warn-note" : "muted"}">${esc(sync.sheet_note)} (${esc(timeAgo(sync.sheet_note_at))})</p>` : "";
  return note + sheetStatus(sync);
}
function sheetStatus(sync) {
  if (sync.due_at && !sync.synced_at) return `<p class="sheet-line small muted">Sending to the Campaign Overview sheet…</p>`;
  if (sync.last_error && !(sync.last_error.startsWith("Columns not found") && sync.synced_at)) return `<p class="sheet-line small warn-note">Campaign Overview sheet: ${esc(sync.last_error)}${sync.due_at ? " Trying again shortly." : ""}</p>`;
  if (sync.synced_at) return `<p class="sheet-line small muted">In the Campaign Overview sheet, row ${esc(sync.sheet_row)}. Updated ${esc(timeAgo(sync.synced_at))}${sync.due_at ? "; new changes are on their way" : ""}.</p>`;
  return "";
}

// ---------- campaign dashboard ----------
// ---------- small dialogs ----------
// confirmDialog: a clean yes/no box with optional tick boxes. Resolves to { ...ticks } or null.

// Delete a tracker campaign in one step, optionally with its row in the Campaign Overview sheet.
async function deleteCampaignFlow(c, after = () => go("#/campaigns")) {
  const { data: sync } = await sb.from("campaign_sheet_sync").select("sheet_row,sheet_key").eq("campaign_id", c.id).maybeSingle();
  const inSheet = !!(sync?.sheet_key || c.po_number);
  const ans = await confirmDialog({
    title: `Delete ${c.artist}${c.song ? ` – ${c.song}` : ""}?`,
    body: "Its posts, folders and client links are removed from the tracker. This can't be undone.",
    checks: inSheet ? [{ id: "sheet", label: `Also delete its row in the Campaign Overview sheet${sync?.sheet_row ? ` (row ${sync.sheet_row})` : ""}`, checked: false }] : [],
    confirm: "Delete campaign",
  });
  if (!ans) return false;
  if (ans.sheet) {
    const { data, error } = await sb.functions.invoke("sheet-sync", { body: { action: "delete_row", campaign_id: c.id } });
    if (error || data?.error) { toast(`Couldn't delete the sheet row: ${data?.error ?? error.message}. Nothing was deleted.`); return false; }
  }
  const { error } = await sb.from("campaigns").delete().eq("id", c.id);
  if (error) { toast(error.message); return false; }
  toast(ans.sheet ? "Campaign and sheet row deleted" : "Campaign deleted");
  after();
  return true;
}

// ---------- artist pictures ----------
const artistKey = (s) => String(s ?? "").trim().toLowerCase().replace(/\s+/g, " ");
async function searchArtists(q) {
  const { data, error } = await sb.functions.invoke("artist-search", { body: { q } });
  if (error || data?.error) throw new Error(data?.error ?? error.message);
  return data.artists ?? [];
}
async function saveArtist(name, pick) {
  const row = { name: name.trim(), deezer_id: pick?.deezer_id ?? null, cm_artist: pick?.cm_artist ?? null, image_url: pick?.image ?? null, updated_at: new Date().toISOString() };
  const { error } = await sb.from("artists").upsert(row, { onConflict: "name_key" });
  if (error) toast(`Couldn't save the artist picture: ${error.message}`);
  return !error;
}
// Live search under an input (Chartmetric, Deezer as fallback). onPick({ name, cm_artist | deezer_id, image, thumb }).
function attachArtistSearch(input, box, onPick) {
  let timer, seq = 0;
  const close = () => { box.hidden = true; box.innerHTML = ""; };
  input.setAttribute("autocomplete", "off");
  input.addEventListener("input", () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < 2) { close(); return; }
    timer = setTimeout(async () => {
      const my = ++seq;
      box.hidden = false; box.innerHTML = `<div class="none">Searching…</div>`;
      let list = [];
      try { list = await searchArtists(q); } catch { if (my === seq) box.innerHTML = `<div class="none">Couldn't search right now. You can still type the name.</div>`; return; }
      if (my !== seq) return;
      box.innerHTML = list.length
        ? list.map((a, i) => `<button type="button" data-i="${i}">${a.thumb ? `<img src="${esc(a.thumb)}" alt="" referrerpolicy="no-referrer">` : `<span class="ph"></span>`}<span>${esc(a.name)}</span><span class="fans">${a.fans ? `${compact(a.fans)} ${esc(a.fans_label ?? "fans")}` : ""}</span></button>`).join("") + `<div class="none">Not listed? Keep typing the name; you can add a picture later.</div>`
        : `<div class="none">No match. Keep the name as typed; you can add a picture later.</div>`;
      box.querySelectorAll("[data-i]").forEach((b) => (b.onmousedown = (e) => { e.preventDefault(); onPick(list[Number(b.dataset.i)]); close(); }));
    }, 300);
  });
  input.addEventListener("blur", () => setTimeout(close, 150));
  input.addEventListener("keydown", (e) => { if (e.key === "Escape") close(); });
}
// Dialog to choose a picture for an existing artist (campaign page).
function artistPictureDialog(name) {
  return new Promise((resolve) => {
    const back = document.createElement("div");
    back.className = "dlg-back";
    back.innerHTML = `<div class="dlg" role="dialog" aria-modal="true" aria-labelledby="ad-t">
      <h3 id="ad-t">Picture for ${esc(name)}</h3>
      <p>Search the music catalogue and pick the right artist. Their photo becomes the banner here and on client links.</p>
      <div class="artist-pick"><input id="ad-q" value="${esc(name)}" aria-label="Search artists"><div class="art-results" id="ad-r" hidden></div></div>
      <div class="actions"><button type="button" data-no>Cancel</button></div></div>`;
    document.body.appendChild(back);
    const done = (v) => { back.remove(); resolve(v); };
    back.onclick = (e) => { if (e.target === back) done(null); };
    back.querySelector("[data-no]").onclick = () => done(null);
    const q = back.querySelector("#ad-q");
    attachArtistSearch(q, back.querySelector("#ad-r"), (a) => done(a));
    q.focus(); q.select(); q.dispatchEvent(new Event("input"));
  });
}

async function renderCampaign(token, id, tab = "report") {
  app.innerHTML = `<p class="muted pad">Loading campaign…</p>`;
  const { data: c, error } = await sb.from("campaign_summary").select("*").eq("id", id).maybeSingle();
  if (token !== routeToken) return;
  if (error || !c) { app.innerHTML = fail(error ?? "This campaign doesn't exist or was deleted."); return; }

  const [markets, latest, sync, invReqs] = await Promise.all([
    sb.from("campaign_markets").select("market,share_percent,amount").eq("campaign_id", id),
    sb.from("posts").select("last_checked_at").eq("campaign_id", id).not("last_checked_at", "is", null).order("last_checked_at", { ascending: false }).limit(1),
    sb.from("campaign_sheet_sync").select("*").eq("campaign_id", id).maybeSingle(),
    sb.from("invoice_requests").select("id,ref,status,amount,currency,invoice_number,due_date,requested_at").eq("campaign_id", id).neq("status", "cancelled").order("requested_at", { ascending: false }),
  ]);
  if (token !== routeToken) return;
  const all = await marketList();
  const mk = (markets.data ?? []).sort((a, b) => all.findIndex((x) => x.name === a.market) - all.findIndex((x) => x.name === b.market))
    .map((m) => `${m.market}${m.amount != null ? ` ${money(m.amount, c.currency)}` : m.share_percent != null ? ` ${m.share_percent}%` : ""}`).join(", ");
  const lastChecked = latest.data?.[0]?.last_checked_at;
  const detail = (label, value) => (value ? `<div><dt>${esc(label)}</dt><dd>${esc(value)}</dd></div>` : "");
  const call = async (body) => {
    const { data, error: e } = await sb.functions.invoke("share", { body: { campaign_id: id, ...body } });
    if (e || data?.error) throw new Error(data?.error ?? e.message);
    return data;
  };

  // The campaign page is the client's report, plus the team's tools and the money (which clients never see).
  mountReport(app, {
    mode: "team",
    load: () => call({}),
    loadCovers: async (ids) => (await call({ covers: ids })).covers ?? {},
    postDaily: async (vid) => (await sb.from("post_daily_stats").select("stat_date,plays,likes,comments,shares").eq("tiktok_video_id", vid).order("stat_date")).data ?? [],
    remove: async (p) => { const { error: e } = await sb.from("posts").delete().eq("campaign_id", id).eq("tiktok_video_id", p.video_id); if (e) toast(e.message); return !e; },
    loadBoost: async (p) => {
      const { data } = await sb.from("posts").select("boost_code,boost_code_updated_at,boost_code_by").eq("campaign_id", id).eq("tiktok_video_id", p.video_id).maybeSingle();
      Object.assign(p, { boost_code: data?.boost_code ?? null, boost_code_updated_at: data?.boost_code_updated_at ?? null, boost_code_by: data?.boost_code_by ?? null });
    },
    saveBoost: async (p, code) => {
      const at = code ? new Date().toISOString() : null, by = code ? (await sb.auth.getUser()).data.user?.email ?? null : null;
      const { error: e } = await sb.from("posts").update({ boost_code: code, boost_code_updated_at: at, boost_code_by: by }).eq("campaign_id", id).eq("tiktok_video_id", p.video_id);
      if (e) { toast(e.message); return false; }
      Object.assign(p, { boost_code: code, boost_code_updated_at: at, boost_code_by: by });
      toast(code ? "Boost code saved" : "Boost code removed");
      return true;
    },
    header: "",
    heroMeta: `<span class="key-chip status-chip s-${esc(c.status)}">${esc(statusLabel(c.status))}</span>${c.po_number ? `<span class="key-chip po"><span class="key-sub">PO</span><span class="key-text">${esc(c.po_number)}</span>${copyBtn(c.po_number)}</span>` : ""}`,
    heroActions: `
      <button type="button" id="share-btn">Share with client</button>
      <button type="button" id="req-inv">Request invoice</button>
      <details class="camp-menu"><summary aria-label="More actions">⋯</summary><div>
        <a href="#/c/${esc(id)}/edit">Edit campaign</a>
        <button type="button" id="del-camp" class="danger">Delete campaign…</button>
      </div></details>`,
    afterHero: `
      <section class="camp-details" aria-label="Campaign details">
        <dl>
          ${detail("Client", c.client)}
          ${detail("Stellar DRI", c.comms_owner)}
          ${detail("Dates", c.start_date ? `${date(c.start_date)}${c.end_date ? ` – ${date(c.end_date)}` : ""}` : null)}
          ${detail("Markets", mk)}
          ${c.budget != null ? `<div class="camp-budget"><dt>Budget <span class="team-tag">team only</span></dt><dd>${esc(money(c.budget, c.currency))}${(invReqs.data ?? []).length ? ` <a href="#/invoices" class="camp-inv">${invReqs.data.map((r) => `${invoicePill(r)}${r.invoice_number ? ` #${esc(r.invoice_number)}` : ""}`).join(" ")}</a>` : ` <span class="muted small">not invoiced yet</span>`}</dd></div>` : ""}
        </dl>
        ${sheetLine(sync.data, c)}
      </section>
      <div class="ws-switch" role="tablist" aria-label="Campaign views">
        <button type="button" role="tab" data-ctab="report" aria-selected="${tab === "report"}">
          <span class="ws-ic" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M4 19h16M7 16V10M12 16V5M17 16v-4"/></svg></span>
          <span class="ws-t"><b>Report</b><small>Performance and videos, as the client sees them</small></span>
        </button>
        <button type="button" role="tab" data-ctab="payouts" aria-selected="${tab === "payouts"}">
          <span class="ws-ic" aria-hidden="true"><svg viewBox="0 0 24 24"><rect x="3" y="6" width="18" height="13" rx="2.5"/><path d="M3 10h18M16 14.5h2"/></svg></span>
          <span class="ws-t"><b>Payouts</b><small>Creators, costs and margin · team only</small></span>
        </button>
      </div>
      <section id="camp-payouts" class="camp-payouts"${tab === "payouts" ? "" : " hidden"}></section>`,
    postsHtml: `
      <div class="camp-posts">
      <div class="section-head">
        <h2>Posts</h2>
        <div class="posts-tools">
          <a class="btn primary" href="#/c/${esc(id)}/add">+ Add links</a>
          <button type="button" id="refresh" title="${lastChecked ? `Numbers checked ${esc(timeAgo(lastChecked))}` : "Not checked yet"}">Refresh numbers</button>
          <div class="seg" role="group" aria-label="Layout"><button type="button" data-pview="folders">Creators by folder</button><button type="button" data-pview="grid">All videos</button></div>
          <button type="button" id="new-folder">New folder</button>
          <label class="posts-filter" id="folder-filter-wrap" hidden><span class="sr">Folder</span><select id="folder-filter" aria-label="Show videos from"></select></label>
          <label class="posts-filter"><span class="sr">Sort by</span>
            <select id="sort" aria-label="Sort by"><option value="plays">Most views</option><option value="newest">Newest first</option><option value="added">Recently added</option></select>
          </label>
        </div>
      </div>
      <p class="muted small posts-updated" id="updated">${lastChecked ? `Numbers checked ${esc(timeAgo(lastChecked))}. They refresh automatically every day.` : "Numbers are collected once links are added."}</p>
      <form id="new-folder-form" class="nf-panel" hidden>
        <div class="nf-row">
          <label for="nf-name">New folder</label>
          <input id="nf-name" placeholder="For example a creative, a phase or a market" autocomplete="off" maxlength="80">
          <button type="submit" class="primary">Create folder</button>
          <button type="button" class="link-btn" id="nf-cancel">Cancel</button>
        </div>
        <p class="muted small">Folders group creators and their videos inside this campaign, for example by creative. Add video or profile links straight into a folder with its <b>+ Add</b> button, or move a video from its preview.</p>
      </form>
      <div id="posts"><p class="muted">Loading posts…</p></div>
      </div>`,
    onPosts: (root, data) => {
      if (token !== routeToken) return;
      // Report / Payouts switch in place: no reload, and the address follows so a refresh keeps the tab.
      let payoutsDrawn = false;
      const showTab = (t) => {
        app.classList.toggle("camp-on-payouts", t === "payouts");
        document.getElementById("camp-payouts").hidden = t !== "payouts";
        app.querySelectorAll("[data-ctab]").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.ctab === t)));
        history.replaceState(history.state, "", `#/c/${id}${t === "payouts" ? "/payouts" : ""}`);
        if (t === "payouts" && !payoutsDrawn) { payoutsDrawn = true; renderCampaignPayouts(document.getElementById("camp-payouts"), sb, { campaign: c, toast, isCurrent: () => token === routeToken }); }
      };
      app.querySelectorAll("[data-ctab]").forEach((b) => (b.onclick = () => showTab(b.dataset.ctab)));
      showTab(tab);
      loadPosts(token, id, { ...c, artist_image: data.artist_image });
      document.getElementById("share-btn").onclick = () => openShareDialog(c);
      const menu = app.querySelector(".camp-menu");
      if (menu) {
        // The banner is its own layer (and the details card sits on top of it), so the open menu
        // is moved to the page body and floats under its button, above everything.
        const box = menu.querySelector("div");
        box.classList.add("camp-menu-pop");
        const place = () => {
          if (!menu.isConnected) { window.removeEventListener("scroll", place); box.remove(); return; }
          if (!menu.open) return;
          const r = menu.querySelector("summary").getBoundingClientRect();
          box.style.top = `${r.bottom + 6}px`;
          box.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - 214))}px`;
        };
        menu.addEventListener("toggle", () => {
          if (menu.open) { document.body.append(box); place(); } else menu.append(box);
        });
        box.addEventListener("click", (e) => { if (e.target.closest("a,button")) menu.open = false; });
        window.addEventListener("scroll", place, { passive: true });
      }
      document.getElementById("req-inv").onclick = () => requestInvoiceDialog(sb, c, { toast, onDone: () => renderCampaign(newToken(), id, tab) });
      document.getElementById("del-camp").onclick = () => deleteCampaignFlow(c);
      document.getElementById("refresh").onclick = async (e) => {
        const btn = e.currentTarget;
        btn.disabled = true; btn.textContent = "Refreshing…";
        document.getElementById("updated").textContent = "Getting the latest numbers from TikTok and YouTube. This can take a minute.";
        const { data: r, error: err } = await sb.functions.invoke("refresh-stats", { body: { campaign_id: id } });
        if (token !== routeToken) return;
        if (err || r?.error) {
          btn.disabled = false; btn.textContent = "Refresh numbers";
          document.getElementById("updated").textContent = `Couldn't refresh: ${r?.error ?? err.message}`;
          return;
        }
        const ok = r.videos?.ok ?? 0, gone = r.videos?.unavailable ?? 0;
        toast(ok || gone
          ? `Updated ${ok} post${ok === 1 ? "" : "s"}${gone ? `, ${gone} no longer available` : ""}${r.skipped_recent ? `. ${r.skipped_recent} were already up to date` : ""}`
          : "Everything was updated in the last hour already");
        renderCampaign(newToken(), id, app.classList.contains("camp-on-payouts") ? "payouts" : "report");
      };
    },
    onError: (e) => { app.innerHTML = fail(e); },
  });
}

// ---------- client link ----------
// One link per artist: the client sees every non-draft campaign for that artist, with no money.
const shareUrl = (t) => new URL(`share.html#t=${t}`, location.origin + location.pathname).toString();
const sameArtist = (a, b) => (a ?? "").trim().toLowerCase() === (b ?? "").trim().toLowerCase();

// Sharing opens as its own window over the page, with the link first and the settings under it.
async function openShareDialog(c) {
  const d = document.createElement("dialog");
  d.className = "share-dialog";
  d.innerHTML = `<button type="button" class="share-x" aria-label="Close">×</button><div class="share-panel"></div>`;
  document.body.append(d);
  d.querySelector(".share-x").onclick = () => d.close();
  d.addEventListener("click", (e) => { if (e.target === d) d.close(); });
  d.onclose = () => d.remove();
  d.showModal();
  await drawSharePanel(d.querySelector(".share-panel"), c);
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
  const what = `The client sees ${visible.length === 1 ? (visible[0].song ? `the ${esc(visible[0].song)} campaign` : "1 campaign") : `${visible.length} of ${esc(c.artist)}'s campaigns`}, with whatever you switch on below. Upcoming campaigns aren't shown until they go active. <b>Budgets, spend, margins and creator costs are never shown.</b>`;
  const draftNote = c.status === "draft" ? `<p class="small warn-note">This campaign is upcoming, so it won't appear on the client link until you set it to active.</p>` : "";
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
    if (!(await confirmDialog({ title: `Turn off the client link for ${c.artist}?`, body: "Anyone with it will see \"This link isn't active\". You can create a new one afterwards.", confirm: "Turn off" }))) return;
    const { error: err } = await sb.from("share_links").update({ revoked: true }).eq("id", link.id);
    if (err) { toast(err.message); return; }
    toast("Link turned off");
    drawSharePanel(panel, c);
  };
}

// What a client link shows. Missing keys mean "on"; the share function enforces these on the server.
const LINK_DEFAULTS = { overview: true, overview_chart: true, sounds: true, songs: true, songs_chart: true, countries: true, countries_chart: true, posts: true, posts_country_filter: true, show_country: true, show_followers: true, folders: true };
function drawLinkSettings(el, link, camps) {
  const S = { ...LINK_DEFAULTS, ...(link.settings ?? {}), hidden_campaigns: [...(link.settings?.hidden_campaigns ?? [])] };
  const row = (key, label, { sub = false, parent = null, off = false, note = "" } = {}) => {
    const disabled = (parent && !S[parent]) || (key !== "show_country" && ["countries", "countries_chart", "posts_country_filter"].includes(key) && !S.show_country);
    return `<label class="row${sub ? " sub" : ""}"><span>${label}${note ? ` <span class="muted small">${note}</span>` : ""}</span>
      <span class="switch"><input type="checkbox" data-key="${key}" ${S[key] && !disabled && !off ? "checked" : ""} ${disabled ? "disabled" : ""}><span></span></span></label>`;
  };
  // Each section has one switch that turns everything in it on or off.
  const GROUPS = {
    analytics: ["overview", "overview_chart", "sounds", "songs", "songs_chart", ...(link.folder_id ? [] : ["folders"]), "countries", "countries_chart"],
    posts: ["posts", "posts_country_filter"],
    creators: ["show_country", "show_followers"],
  };
  const liveCamps = camps.filter((x) => x.status !== "draft");
  const groupOn = (g) => g === "campaigns" ? liveCamps.some((x) => !S.hidden_campaigns.includes(x.id)) : GROUPS[g].some((k) => S[k]);
  const head = (g, label) => `<div class="set-head"><h3>${label}</h3><label class="set-all" title="Turn all ${label.toLowerCase()} settings on or off"><span>All</span><span class="switch"><input type="checkbox" data-group="${g}" ${groupOn(g) ? "checked" : ""}><span></span></span></label></div>`;
  el.innerHTML = `
    <h2 style="margin-bottom:2px">Link settings</h2>
    <p class="muted small" style="margin-top:0">Changes apply to the link straight away. Anything switched off is never sent to the client's browser.</p>
    ${head("analytics", "Analytics")}
    ${row("overview", "Overview numbers")}
    ${row("overview_chart", "Overview chart", { sub: true, parent: "overview" })}
    ${row("sounds", "Sound analytics")}
    ${row("songs", "Song analytics")}
    ${row("songs_chart", "Songs chart", { sub: true, parent: "songs" })}
    ${link.folder_id ? "" : row("folders", "Market and folder breakdown", { note: "folders hidden from clients are never named" })}
    ${row("countries", "Country analytics")}
    ${row("countries_chart", "Countries chart", { sub: true, parent: "countries" })}
    ${head("posts", "Posts")}
    ${row("posts", "Post wall")}
    ${row("posts_country_filter", "Country filter", { sub: true, parent: "posts" })}
    ${liveCamps.length > 1 ? head("campaigns", "Campaigns") : camps.length ? "<h3>Campaigns</h3>" : ""}
    ${camps.map((x) => x.status === "draft"
      ? `<label class="row"><span>${esc(x.song ?? "Untitled")} <span class="muted small">upcoming, not shown yet</span></span><span class="switch"><input type="checkbox" disabled><span></span></span></label>`
      : `<label class="row"><span>${esc(x.song ?? "Untitled")}</span><span class="switch"><input type="checkbox" data-camp="${esc(x.id)}" ${S.hidden_campaigns.includes(x.id) ? "" : "checked"}><span></span></span></label>`).join("")}
    ${head("creators", "Creators")}
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
  el.querySelectorAll("[data-group]").forEach((i) => i.onchange = () => {
    const g = i.dataset.group;
    if (g === "campaigns") S.hidden_campaigns = i.checked ? [] : liveCamps.map((x) => x.id);
    else for (const k of GROUPS[g]) S[k] = i.checked;
    save();
  });
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
    <polygon points="${x(0).toFixed(1)},${H - P} ${pts} ${x(rows.length - 1).toFixed(1)},${H - P}" fill="#0f25bf" fill-opacity="0.08"/>
    <polyline points="${pts}" fill="none" stroke="#0f25bf" stroke-width="2.5" stroke-linejoin="round"/>
    ${rows.map((r, i) => `<circle cx="${x(i)}" cy="${y(r.plays)}" r="3.5" fill="#0f25bf"><title>${esc(date(r.stat_date))}: ${n(r.plays)} plays</title></circle>`).join("")}
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

async function loadPosts(token, id, camp) {
  const el = document.getElementById("posts");
  let posts, folders, folderLinks = {}, fcs = [];
  try {
    [posts, { data: folders }] = await Promise.all([
      fetchAll(() => sb.from("posts")
        .select("id,folder_id,tiktok_video_id,url,caption,published_at,country_code,cover_path,status,created_at,boost_code,boost_code_updated_at,boost_code_by,sound:sounds(title),creator:creators(id,username,display_name,follower_count,is_verified,avatar_url,country_code,on_roster,platform)")
        .eq("campaign_id", id).order("created_at", { ascending: false })),
      sb.from("campaign_folders").select("id,name,market,position,hidden,created_at").eq("campaign_id", id).order("position").order("created_at"),
    ]);
    fcs = (await sb.from("campaign_folder_creators").select("id,folder_id,creator_id,created_at,creator:creators(id,username,display_name,follower_count,is_verified,avatar_url,country_code,on_roster,platform)").eq("campaign_id", id)).data ?? [];
    folderLinks = Object.fromEntries(((await sb.from("share_links").select("id,token,folder_id").eq("campaign_id", id).eq("revoked", false).not("folder_id", "is", null)).data ?? []).map((l) => [l.folder_id, l]));
  } catch (e) { el.innerHTML = fail(e); return; }
  if (token !== routeToken) return;
  folders = folders ?? [];
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
      id: p.id, campaign_id: id, folder_id: p.folder_id, video_id: p.tiktok_video_id, url: p.url, caption: p.caption, published_at: p.published_at, created_at: p.created_at,
      country: p.creator?.country_code ?? p.country_code ?? null, sound_title: p.sound?.title ?? null, gone: p.status !== "active", has_cover: !!p.cover_path,
      creator: p.creator ? { id: p.creator.id, on_roster: p.creator.on_roster, platform: p.creator.platform, username: p.creator.username, name: p.creator.display_name, followers: p.creator.follower_count, verified: p.creator.is_verified, avatar: p.creator.avatar_url } : null,
      plays: st.plays ?? null, likes: st.likes ?? null, comments: st.comments ?? null, shares: st.shares ?? null, stats_date: st.stat_date ?? null,
      boost_code: p.boost_code ?? null, boost_code_updated_at: p.boost_code_updated_at ?? null, boost_code_by: p.boost_code_by ?? null,
    };
  });
  const folderName = (fid) => folders.find((f) => f.id === fid)?.name ?? "";
  let current = sessionStorageGet(`folder-${id}`) ?? "";   // "" all, "none" not in a folder, or a folder id
  if (current && current !== "none" && !folders.some((f) => f.id === current)) current = "";

  const ctx = {
    mode: "team",
    covers: Object.fromEntries(posts.filter((p) => byPath[p.cover_path]).map((p) => [p.tiktok_video_id, byPath[p.cover_path]])),
    postDaily: async (vid) => (await sb.from("post_daily_stats").select("stat_date,plays,likes,comments,shares").eq("tiktok_video_id", vid).order("stat_date")).data ?? [],
    remove: async (p) => { const { error } = await sb.from("posts").delete().eq("id", p.id); if (error) toast(error.message); return !error; },
    onRemoved: () => renderCampaign(++routeToken, id),
    showCountry: true,
    folders,
    folderOf: folders.length ? (p) => folderName(p.folder_id) : null,
    move: async (items, folderId) => {
      const { error } = await sb.from("posts").update({ folder_id: folderId }).in("id", items.map((p) => p.id));
      if (error) { toast(error.message); return false; }
      for (const p of items) { const x = list.find((y) => y.id === p.id); if (x) x.folder_id = folderId; }
      toast(`${items.length === 1 ? "Video" : `${items.length} videos`} moved to ${folderId ? folderName(folderId) : "no folder"}`);
      draw();
      return true;
    },
    saveBoost: async (p, code) => {
      const at = code ? new Date().toISOString() : null, by = code ? (await sb.auth.getUser()).data.user?.email ?? null : null;
      const { error } = await sb.from("posts").update({ boost_code: code, boost_code_updated_at: at, boost_code_by: by }).eq("id", p.id);
      if (error) { toast(error.message); return false; }
      Object.assign(p, { boost_code: code, boost_code_updated_at: at, boost_code_by: by });
      toast(code ? "Boost code saved" : "Boost code removed");
      return true;
    },
  };

  const sortSel = document.getElementById("sort");
  const filterWrap = document.getElementById("folder-filter-wrap"), filterSel = document.getElementById("folder-filter");
  let shown = 48;
  const inView = () => list.filter((p) => !current || (current === "none" ? !p.folder_id : p.folder_id === current));

  // "All videos" view: one clean dropdown to choose which folder's videos to show.
  function drawFilter() {
    const loose = list.filter((p) => !p.folder_id).length;
    filterSel.innerHTML = `<option value="">All videos · ${n(list.length)}</option>`
      + folders.map((f) => `<option value="${esc(f.id)}">${esc(f.name)} · ${n(list.filter((p) => p.folder_id === f.id).length)}</option>`).join("")
      + (folders.length && loose ? `<option value="none">Not in a folder · ${n(loose)}</option>` : "");
    filterSel.value = current;
    filterWrap.hidden = view !== "grid" || !folders.length;
  }
  filterSel.onchange = () => { current = filterSel.value; sessionStorageSet(`folder-${id}`, current); shown = 48; draw(); };

  async function openFolderPanel(f, panel) {
    if (!panel.hidden && panel.dataset.folder === f.id) { panel.hidden = true; return; }
    panel.hidden = false; panel.dataset.folder = f.id;
    panel.innerHTML = `<p class="muted small">Loading…</p>`;
    const { data: link } = await sb.from("share_links").select("id,token,created_at,created_by,settings,folder_id").eq("folder_id", f.id).eq("revoked", false).order("created_at", { ascending: false }).limit(1).maybeSingle();
    const count = list.filter((p) => p.folder_id === f.id).length;
    const url = link ? shareUrl(link.token) : null;
    const what = f.market ? "market" : "folder";
    panel.innerHTML = `
      <div class="fp">
        <div class="fp-head">
          <div class="fp-name"><label for="fp-name" class="sr">Folder name</label><input id="fp-name" value="${esc(f.name)}" autocomplete="off"><span class="muted small" id="fp-saved"></span></div>
          <button type="button" class="link-btn" id="fp-close">Close</button>
        </div>
        <div class="fp-card">
          <div class="fp-line">
            <div><b>Show on client links</b>
              <p class="muted small">When off, its videos still count in the campaign's totals but aren't named as a separate ${what}.</p></div>
            <label class="switch" title="Show on client links"><input type="checkbox" id="fp-visible" ${f.hidden ? "" : "checked"} aria-label="Show this ${what} on client links"><span></span></label>
          </div>
        </div>
        <div class="fp-card">
          <b>Client link for this ${what}</b>
          <p class="muted small">The client sees only this ${what}'s videos and numbers${camp.status === "draft" ? ", once the campaign is active" : ""}. Budgets, spend and margins are never shown.</p>
          ${link ? `<div class="share-row"><input id="fp-url" readonly value="${esc(url)}" aria-label="Folder client link">
              <button type="button" class="primary" id="fp-copy">Copy link</button>
              <a class="btn" href="${esc(url)}" target="_blank" rel="noopener">Open</a></div>
            <p class="muted small fp-meta">Created ${esc(date(link.created_at))}${link.created_by ? ` by ${esc(link.created_by)}` : ""} · <button type="button" class="link-btn danger" id="fp-off">Turn off this link</button></p>
            <details class="fp-more"><summary>What the client sees on this link</summary><div class="settings" id="fp-settings"></div></details>`
          : `<div class="actions" style="margin:10px 0 0"><button type="button" class="primary" id="fp-create">Create client link</button></div>`}
        </div>
        <div class="fp-foot">
          <span class="muted small">${count ? (count === 1 ? "Deleting keeps its video in the campaign, just not in a folder." : `Deleting keeps its ${n(count)} videos in the campaign, just not in a folder.`) : "This folder has no videos."}</span>
          <button type="button" class="danger-lite" id="fp-delete">Delete ${what}</button>
        </div>
      </div>`;
    panel.scrollIntoView({ block: "nearest", behavior: "smooth" });
    const again = () => { const host = el.querySelector(`.fsec[data-key="${f.id}"] .fs-panel`); if (!host) return; host.dataset.folder = ""; openFolderPanel(f, host); };
    panel.querySelector("#fp-close").onclick = () => { panel.hidden = true; };
    const refreshHead = () => {
      const h3 = el.querySelector(`.fsec[data-key="${f.id}"] .fsec-title h3`);
      if (h3) h3.innerHTML = `${h3.querySelector("img")?.outerHTML ?? ""}${esc(f.name)}${f.hidden ? ' <span class="badge">Hidden from clients</span>' : ""}${folderLinks[f.id] ? ' <span class="badge on">Client link on</span>' : ""}`;
    };
    const nameInput = panel.querySelector("#fp-name");
    nameInput.onkeydown = (e) => { if (e.key === "Enter") nameInput.blur(); if (e.key === "Escape") { nameInput.value = f.name; nameInput.blur(); } };
    nameInput.onchange = async () => {
      const name = nameInput.value.trim();
      if (!name || name === f.name) { nameInput.value = f.name; return; }
      const { error } = await sb.from("campaign_folders").update({ name }).eq("id", f.id);
      if (error) { toast(error.code === "23505" ? "There's already a folder with that name." : error.message); nameInput.value = f.name; return; }
      f.name = name; refreshHead();
      const s2 = panel.querySelector("#fp-saved"); s2.textContent = "Saved"; setTimeout(() => (s2.textContent = ""), 1500);
    };
    panel.querySelector("#fp-visible").onchange = async (e) => {
      const hidden = !e.target.checked;
      e.target.disabled = true;
      const { error } = await sb.from("campaign_folders").update({ hidden }).eq("id", f.id);
      e.target.disabled = false;
      if (error) { toast(error.message); e.target.checked = !e.target.checked; return; }
      f.hidden = hidden; refreshHead(); toast(hidden ? "Hidden from client links" : "Shown on client links");
    };
    panel.querySelector("#fp-create")?.addEventListener("click", async (e) => {
      e.currentTarget.disabled = true;
      const { error } = await sb.from("share_links").insert({ campaign_id: id, folder_id: f.id });
      if (error) { toast(error.message); e.currentTarget.disabled = false; return; }
      folderLinks[f.id] = (await sb.from("share_links").select("id,token,folder_id").eq("folder_id", f.id).eq("revoked", false).order("created_at", { ascending: false }).limit(1).maybeSingle()).data;
      toast("Folder link created"); again();
    });
    if (link) {
      drawLinkSettings(panel.querySelector("#fp-settings"), link, []);
      const input = panel.querySelector("#fp-url");
      input.onfocus = () => input.select();
      panel.querySelector("#fp-copy").onclick = () => copyLink(url);
      panel.querySelector("#fp-off").onclick = async () => {
        if (!(await confirmDialog({ title: `Turn off the client link for ${f.name}?`, body: "Anyone with it will see \"This link isn't active\".", confirm: "Turn off" }))) return;
        const { error } = await sb.from("share_links").update({ revoked: true }).eq("id", link.id);
        if (error) { toast(error.message); return; }
        delete folderLinks[f.id];
        toast("Link turned off"); again();
      };
    }
    panel.querySelector("#fp-delete").onclick = async () => {
      if (!(await confirmDialog({ title: `Delete the folder "${f.name}"?`, body: esc(`${count ? `Its ${count} video${count === 1 ? "" : "s"} stay in the campaign. ` : ""}${link ? "Its client link stops working." : ""}`.trim()) }))) return;
      const { error } = await sb.from("campaign_folders").delete().eq("id", f.id);
      if (error) { toast(error.message); return; }
      toast("Folder deleted");
      renderCampaign(++routeToken, id);
    };
  }

  const nfForm = document.getElementById("new-folder-form"), nfBtn = document.getElementById("new-folder"), nfName = document.getElementById("nf-name");
  const closeNewFolder = () => { nfForm.hidden = true; nfName.value = ""; nfBtn.setAttribute("aria-expanded", "false"); };
  nfBtn.setAttribute("aria-expanded", "false");
  nfBtn.onclick = () => {
    if (!nfForm.hidden) return closeNewFolder();
    nfForm.hidden = false; nfBtn.setAttribute("aria-expanded", "true"); nfName.focus();
  };
  document.getElementById("nf-cancel").onclick = closeNewFolder;
  nfName.onkeydown = (e) => { if (e.key === "Escape") closeNewFolder(); };
  nfForm.onsubmit = async (e) => {
    e.preventDefault();
    const name = nfName.value.trim();
    if (!name) { nfName.focus(); return; }
    const btn = nfForm.querySelector("[type=submit]"); btn.disabled = true;
    const { data: f, error } = await sb.from("campaign_folders").insert({ campaign_id: id, name, position: folders.length ? Math.max(...folders.map((x) => x.position)) + 1 : 0 }).select("id,name,market,position,hidden,created_at").single();
    btn.disabled = false;
    if (error) { toast(error.code === "23505" ? "There's already a folder with that name." : error.message); nfName.focus(); return; }
    folders.push(f);
    ctx.folderOf = (p) => folderName(p.folder_id);
    toast(`Folder "${name}" created`);
    closeNewFolder();
    draw();
  };

  let view = sessionStorageGet("posts-view") === "grid" ? "grid" : "folders";
  document.querySelectorAll("[data-pview]").forEach((b) => {
    b.setAttribute("aria-pressed", b.dataset.pview === view);
    b.onclick = () => {
      view = b.dataset.pview; sessionStorageSet("posts-view", view);
      document.querySelectorAll("[data-pview]").forEach((x) => x.setAttribute("aria-pressed", x.dataset.pview === view));
      draw();
    };
  });
  const sortList = (ps) => {
    const by = sortSel.value;
    return [...ps].sort((a, b) =>
      by === "plays" ? (b.plays ?? -1) - (a.plays ?? -1)
      : by === "newest" ? String(b.published_at ?? "").localeCompare(String(a.published_at ?? ""))
      : String(b.created_at).localeCompare(String(a.created_at)));
  };
  const draw = () => {
    drawFilter();
    if (view === "folders") return drawSections();
    if (!list.length) {
      el.innerHTML = `<div class="panel"><p>No videos yet.</p><a class="btn primary" href="#/c/${esc(id)}/add">Add links</a></div>`;
      return;
    }
    renderWall(el, sortList(inView()), ctx, { shown, onMore: () => { shown += 48; draw(); } });
  };
  sortSel.onchange = () => { shown = 48; draw(); };

  // ---------- folder view: the creators in each folder, with their videos rolled up ----------
  const collapsed = new Set(JSON.parse(sessionStorageGet(`collapsed-${id}`) ?? "[]"));
  const saveCollapsed = () => sessionStorageSet(`collapsed-${id}`, JSON.stringify([...collapsed]));
  const flash = JSON.parse(sessionStorageGet(`flash-${id}`) ?? "null");
  sessionStorageSet(`flash-${id}`, "null");
  const CHEVRON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 15l6-6 6 6"/></svg>';
  const asCreator = (c) => (c ? { id: c.id, on_roster: c.on_roster, platform: c.platform, username: c.username, name: c.display_name, followers: c.follower_count, verified: c.is_verified, avatar: c.avatar_url } : null);

  function creatorsIn(key) {
    const ps = list.filter((p) => (key === "none" ? !p.folder_id : p.folder_id === key));
    const map = new Map();
    for (const p of ps) {
      const k = p.creator?.id ?? `u:${p.creator?.username ?? p.id}`;
      if (!map.has(k)) map.set(k, { key: k, creator: p.creator, posts: [], added: null });
      map.get(k).posts.push(p);
    }
    for (const fc of fcs.filter((x) => (x.folder_id ?? "none") === key)) {
      if (map.has(fc.creator_id)) map.get(fc.creator_id).added = fc;
      else map.set(fc.creator_id, { key: fc.creator_id, creator: asCreator(fc.creator), posts: [], added: fc });
    }
    const rows = [...map.values()].map((g) => {
      const live = g.posts.filter((p) => !p.gone);
      const t = (k) => (live.some((p) => p[k] != null) ? live.reduce((s, p) => s + Number(p[k] ?? 0), 0) : null);
      return { ...g, posts: sortList(g.posts), videos: g.posts.length, plays: t("plays"), likes: t("likes"), comments: t("comments"), shares: t("shares"),
        last: g.posts.map((p) => p.published_at).filter(Boolean).sort().at(-1) ?? null, addedAt: g.added?.created_at ?? g.posts.map((p) => p.created_at).sort().at(-1) ?? "" };
    });
    const by = sortSel.value;
    return rows.sort((a, b) => by === "plays" ? (b.plays ?? -1) - (a.plays ?? -1) : by === "newest" ? String(b.last ?? "").localeCompare(String(a.last ?? "")) : String(b.addedAt).localeCompare(String(a.addedAt)));
  }
  const avatarHtml = (c) => `<span class="av">${c?.avatar ? `<img src="${esc(c.avatar)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">` : ""}<span>${esc((c?.name || c?.username || "?").trim().charAt(0).toUpperCase())}</span></span>`;
  const profileHref = (c) => c?.platform === "youtube" ? `https://www.youtube.com/@${encodeURIComponent(c.username)}` : c?.platform === "instagram" ? `https://www.instagram.com/${encodeURIComponent(c.username)}/` : `https://www.tiktok.com/@${encodeURIComponent(c?.username ?? "")}`;

  function creatorTable(rows, key) {
    if (!rows.length) return `<div class="fsec-empty muted small">No creators yet. Use <b>+ Add</b> to paste their profile links or video links.</div>`;
    return `<div class="table-wrap fsec-table"><table class="cr-table">
      <thead><tr><th>Creator</th><th class="num">Videos</th><th class="num">Views</th><th class="num">Likes</th><th class="num">Comments</th><th class="num">Shares</th><th class="num">Eng. rate</th><th class="num">Followers</th><th>Last posted</th><th><span class="sr">Actions</span></th></tr></thead>
      <tbody>${rows.map((r) => {
        const c = r.creator;
        const er = r.plays ? ((r.likes ?? 0) + (r.comments ?? 0) + (r.shares ?? 0)) / r.plays : null;
        return `<tr data-ck="${esc(r.key)}"${r.posts.length ? "" : ' class="no-videos"'}>
        <td><button type="button" class="creator-cell" data-copen="${esc(r.key)}" title="${r.posts.length ? "See their videos" : "Open their profile"}">
          ${avatarHtml(c)}
          <span class="cw"><span class="nm">${esc(c?.name || c?.username || "Unknown")}${c?.verified ? ' <span class="tick" title="Verified">✓</span>' : ""}</span><span class="hd">@${esc(c?.username ?? "unknown")}</span></span>
        </button></td>
        <td class="num">${r.posts.length ? n(r.videos) : `<span class="muted small">None yet</span>`}</td>
        <td class="num plays-cell">${r.posts.length ? n(r.plays) : "–"}</td><td class="num">${r.posts.length ? n(r.likes) : "–"}</td><td class="num">${r.posts.length ? n(r.comments) : "–"}</td><td class="num">${r.posts.length ? n(r.shares) : "–"}</td>
        <td class="num">${pct(er)}</td><td class="num">${compact(c?.followers)}</td>
        <td class="small">${r.last ? esc(ago(r.last)) : "–"}</td>
        <td class="row-actions"><div class="card-actions">
          ${c?.platform === "tiktok" && c?.id ? (c.on_roster
            ? `<a href="#/creator/${esc(c.id)}" class="ro-star on" title="On the roster: open their page" aria-label="Open @${esc(c.username)} on the roster">★</a>`
            : `<button type="button" class="ro-star" data-ract="roster" data-ck="${esc(r.key)}" title="Add @${esc(c.username)} to the roster" aria-label="Add @${esc(c.username)} to the roster">☆</button>`) : ""}
          <a href="${esc(profileHref(c))}" target="_blank" rel="noopener" title="Open their profile" aria-label="Open @${esc(c?.username ?? "")}'s profile">${ICON.open}</a>
          ${r.added && !r.posts.length ? `<button type="button" data-ract="unadd" data-ck="${esc(r.key)}" title="Remove from this folder" aria-label="Remove @${esc(c?.username ?? "")} from this folder">${ICON.trash}</button>` : ""}
        </div></td></tr>`;
      }).join("")}</tbody></table></div>`;
  }

  // What was pasted: video links go through the usual link check; profile links and @handles add creators.
  const VIDEO_RX = /tiktok\.com\/.*\/video\/\d+|(?:^|\/\/)(?:vm|vt)\.tiktok\.com\/|tiktok\.com\/t\/|youtube\.com\/(?:watch|shorts|live)|youtu\.be\//i;
  function splitPaste(text) {
    const tokens = [...new Set(text.split(/[\s,;]+/).map((t) => t.trim().replace(/^[<(\["']+|[>)\]"'.]+$/g, "")).filter(Boolean))];
    const videos = [], profiles = [];
    for (const t of tokens) {
      const url = /^(vm\.|vt\.|www\.|m\.)?(tiktok|instagram|youtube)\.com\//i.test(t) ? `https://${t}` : t;
      if (/^https?:\/\//i.test(url) && VIDEO_RX.test(url)) videos.push(url);
      else if (/^https?:\/\//i.test(url) && /(tiktok\.com\/@|instagram\.com\/[\w.]+|youtube\.com\/(@|channel\/))/i.test(url)) profiles.push(url);
      else if (/^@[\w.]{2,30}$/.test(t)) profiles.push(t);
    }
    return { videos, profiles };
  }
  async function addCreators(profiles, folderId) {
    const done = [], failed = [];
    for (const raw of profiles) {
      try {
        const m = raw.match(/tiktok\.com\/@([\w.]+)/i) ?? raw.match(/^@([\w.]+)$/);
        let c = null;
        if (m) c = (await sb.from("creators").select("id,username").eq("platform", "tiktok").ilike("username", m[1]).maybeSingle()).data;
        if (!c) {
          const { data, error } = await sb.functions.invoke("roster", { body: { action: "lookup", input: raw } });
          if (error || data?.error) throw new Error(data?.error ?? "Couldn't find that account");
          c = data;
        }
        const { error } = await sb.from("campaign_folder_creators").insert({ campaign_id: id, folder_id: folderId, creator_id: c.id, added_by: (await sb.auth.getUser()).data.user?.email ?? null });
        if (error && error.code !== "23505") throw new Error(error.message);
        done.push(`@${c.username}`);
      } catch (e) { failed.push(`${raw} – ${e.message}`); }
    }
    return { done, failed };
  }

  function drawSections() {
    const groups = [
      ...folders.map((f) => ({ key: f.id, f, name: f.name })),
      ...(list.some((p) => !p.folder_id) || fcs.some((x) => !x.folder_id) || !folders.length ? [{ key: "none", f: null, name: folders.length ? "Not in a folder" : "All creators" }] : []),
    ].map((g) => ({ ...g, rows: creatorsIn(g.key) }));
    el.innerHTML = groups.map((g) => {
      const vids = g.rows.flatMap((r) => r.posts).filter((p) => !p.gone);
      const plays = vids.reduce((s, p) => s + Number(p.plays ?? 0), 0);
      const shut = collapsed.has(g.key);
      const fl = flash && flash.key === g.key ? flash.text : "";
      const art = camp.artist_image;
      return `<section class="fsec${shut ? " shut" : ""}" data-key="${esc(g.key)}">
        <header class="fsec-head${art ? " has-art" : ""}"${art ? ` style="--art:url('${esc(art)}')"` : ""}>
          <div class="fsec-title">
            <h3>${art ? `<img class="fsec-art" src="${esc(art)}" alt="" referrerpolicy="no-referrer">` : ""}${esc(g.name)}${g.f?.hidden ? ' <span class="badge">Hidden from clients</span>' : ""}${g.f && folderLinks[g.f.id] ? ' <span class="badge on">Client link on</span>' : ""}</h3>
            <div class="fsec-meta"><b>${n(g.rows.length)}</b> creator${g.rows.length === 1 ? "" : "s"} · <b>${n(vids.length)}</b> video${vids.length === 1 ? "" : "s"} · <b>${compact(plays)}</b> views${vids.length ? ` · ${pct(plays ? vids.reduce((s, p) => s + (p.likes ?? 0) + (p.comments ?? 0) + (p.shares ?? 0), 0) / plays : null)} engagement` : ""}</div>
          </div>
          <div class="fsec-actions">
            <button type="button" class="primary" data-sact="add">+ Add</button>
            ${g.f ? `<button type="button" data-sact="link">${folderLinks[g.f.id] ? "Copy client link" : "Client link"}</button><button type="button" data-sact="edit">Settings</button>` : ""}
            <button type="button" class="icon-btn fsec-chev" data-sact="collapse" aria-expanded="${!shut}" aria-label="${shut ? "Expand" : "Collapse"} ${esc(g.name)}">${CHEVRON}</button>
          </div>
        </header>
        ${fl ? `<div class="fsec-flash small">${fl}</div>` : ""}
        <form class="fsec-add" hidden>
          <label class="sr" for="add-${esc(g.key)}">Video or profile links for ${esc(g.name)}</label>
          <textarea id="add-${esc(g.key)}" placeholder="Paste video links to track them, or profile links / @handles to add creators to ${esc(g.name)}. One per line or separated by spaces."></textarea>
          <div class="fsec-add-row"><span class="small muted" data-count>Nothing pasted yet.</span><span class="spacer"></span>
            <button type="button" class="link-btn" data-sact="cancel">Cancel</button><button type="submit" class="primary" disabled>Add</button></div>
          <div class="progress" hidden><div></div></div>
        </form>
        <div class="fs-panel panel share-panel" hidden></div>
        <div class="fsec-body"${shut ? " hidden" : ""}>${creatorTable(g.rows, g.key)}</div>
      </section>`;
    }).join("");

    el.querySelectorAll(".fsec").forEach((sec) => {
      const key = sec.dataset.key;
      const g = groups.find((x) => x.key === key);
      const addForm = sec.querySelector(".fsec-add");
      const ta = addForm.querySelector("textarea"), go = addForm.querySelector("[type=submit]"), cnt = addForm.querySelector("[data-count]");
      sec.querySelectorAll("[data-sact]").forEach((b) => (b.onclick = async () => {
        const act = b.dataset.sact;
        if (act === "add") { addForm.hidden = !addForm.hidden; if (!addForm.hidden) { if (collapsed.has(key)) { collapsed.delete(key); saveCollapsed(); sec.classList.remove("shut"); sec.querySelector(".fsec-body").hidden = false; } ta.focus(); } }
        if (act === "cancel") { addForm.hidden = true; ta.value = ""; ta.oninput(); }
        if (act === "edit") openFolderPanel(g.f, sec.querySelector(".fs-panel"));
        if (act === "link") {
          const l = folderLinks[g.f.id];
          if (l) { await copyLink(shareUrl(l.token)); } else { const host = sec.querySelector(".fs-panel"); host.dataset.folder = ""; openFolderPanel(g.f, host); }
        }
        if (act === "collapse") {
          if (collapsed.has(key)) collapsed.delete(key); else collapsed.add(key);
          saveCollapsed(); drawSections();
        }
      }));
      const MAX = 500;
      ta.oninput = () => {
        const { videos, profiles } = splitPaste(ta.value);
        const parts = [videos.length ? `${n(videos.length)} video link${videos.length === 1 ? "" : "s"}` : "", profiles.length ? `${n(profiles.length)} creator${profiles.length === 1 ? "" : "s"}` : ""].filter(Boolean);
        cnt.textContent = parts.length ? `${parts.join(" and ")} found.` : ta.value.trim() ? "No video or profile links found." : "Nothing pasted yet.";
        go.disabled = !parts.length || videos.length > MAX;
        go.textContent = parts.length ? `Add ${parts.join(" and ")}` : "Add";
      };
      addForm.onsubmit = async (e) => {
        e.preventDefault();
        const { videos, profiles } = splitPaste(ta.value);
        if (!videos.length && !profiles.length) return;
        go.disabled = true; ta.disabled = true;
        const bar = addForm.querySelector(".progress"), fill = bar.firstElementChild;
        bar.hidden = false;
        let text = "";
        if (profiles.length) {
          cnt.textContent = `Checking ${n(profiles.length)} profile${profiles.length === 1 ? "" : "s"}…`;
          const r = await addCreators(profiles, g.f?.id ?? null);
          text += r.done.length ? `Added ${r.done.map(esc).join(", ")} to ${esc(g.name)}` : "";
          if (r.failed.length) text += `${text ? " · " : ""}${n(r.failed.length)} profile${r.failed.length === 1 ? "" : "s"} not added:<ul>${r.failed.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>`;
        }
        if (!videos.length) { sessionStorageSet(`flash-${id}`, JSON.stringify({ key, text })); renderCampaign(++routeToken, id); return; }
        cnt.textContent = "Starting…";
        const { data: job, error } = await sb.from("link_jobs").insert({ campaign_id: id, folder_id: g.f?.id ?? null }).select("id").single();
        if (error) { cnt.textContent = error.message; go.disabled = false; ta.disabled = false; return; }
        const r = await sb.from("link_job_items").insert(videos.map((url) => ({ job_id: job.id, url })));
        if (r.error) { cnt.textContent = r.error.message; go.disabled = false; ta.disabled = false; return; }
        const tick = async () => {
          if (!document.body.contains(addForm)) return;
          const [{ data: j }, { data: items }] = await Promise.all([
            sb.from("link_jobs").select("status").eq("id", job.id).single(),
            sb.from("link_job_items").select("url,status,error").eq("job_id", job.id),
          ]);
          const all = items ?? [], done = all.filter((i) => i.status !== "pending").length;
          fill.style.width = `${all.length ? Math.round((done / all.length) * 100) : 0}%`;
          cnt.textContent = `Checking links: ${done} of ${all.length}…`;
          if (j?.status !== "done") { setTimeout(tick, 2000); return; }
          const c = (st) => all.filter((i) => i.status === st);
          const failed = c("failed");
          text += `${text ? " · " : ""}Added ${n(c("success").length)} video${c("success").length === 1 ? "" : "s"} to ${esc(g.name)}`
            + (c("duplicate").length ? ` · ${n(c("duplicate").length)} already in this campaign` : "")
            + (failed.length ? ` · ${n(failed.length)} failed:<ul>${failed.map((i) => `<li><span class="u">${esc(i.url)}</span> – ${esc(i.error ?? "")}</li>`).join("")}</ul>` : "");
          sessionStorageSet(`flash-${id}`, JSON.stringify({ key, text }));
          renderCampaign(++routeToken, id);
        };
        tick();
      };
      sec.querySelectorAll("[data-copen]").forEach((b) => (b.onclick = () => {
        const r = g.rows.find((x) => x.key === b.dataset.copen);
        if (r.posts.length) openPostModal(r.posts, 0, ctx);
        else window.open(profileHref(r.creator), "_blank", "noopener");
      }));
      sec.querySelectorAll("[data-ract=roster]").forEach((b) => (b.onclick = async () => {
        const r = g.rows.find((x) => x.key === b.dataset.ck), c = r.creator;
        b.disabled = true; b.textContent = "…";
        const { data: res, error: e } = await sb.functions.invoke("roster", { body: { action: "add", input: `@${c.username}`, platform: c.platform ?? "tiktok" } });
        if (e || res?.error) { b.disabled = false; b.textContent = "☆"; toast(`Couldn't add: ${res?.error ?? e.message}`); return; }
        toast(`Added @${c.username} to the roster`);
        list.filter((x) => x.creator?.username === c.username).forEach((x) => { x.creator.on_roster = true; });
        c.on_roster = true;
        b.outerHTML = `<a href="#/creator/${esc(res.id)}" class="ro-star on" title="On the roster: open their page" aria-label="Open @${esc(c.username)} on the roster">★</a>`;
      }));
      sec.querySelectorAll("[data-ract=unadd]").forEach((b) => (b.onclick = async () => {
        const r = g.rows.find((x) => x.key === b.dataset.ck);
        const { error } = await sb.from("campaign_folder_creators").delete().eq("id", r.added.id);
        if (error) { toast(error.message); return; }
        fcs = fcs.filter((x) => x.id !== r.added.id);
        toast(`@${r.creator?.username ?? "creator"} removed from ${g.name}`);
        drawSections();
      }));
    });
  }
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
        <span>Client view: what a client link shows with every setting on. Upcoming campaigns appear here but not on client links.</span>
        <button type="button" id="rep-share">Share with client</button>
      </div>`,
    onHeader: (root) => {
      if (token !== routeToken) return;
      const b = root.querySelector("#rep-share");
      if (b) b.onclick = () => openShareDialog(c);
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
  const [{ data: c }, { data: folders }] = await Promise.all([
    sb.from("campaigns").select("id,artist,song").eq("id", id).maybeSingle(),
    sb.from("campaign_folders").select("id,name").eq("campaign_id", id).order("position").order("created_at"),
  ]);
  if (token !== routeToken) return;
  if (!c) { app.innerHTML = fail("This campaign doesn't exist or was deleted."); return; }
  const title = `${esc(c.artist)}${c.song ? ` – ${esc(c.song)}` : ""}`;
  if (jobId) return renderJob(token, c, jobId, title);

  app.innerHTML = `
    <a href="#/c/${esc(id)}" class="small">Back to ${title}</a>
    <div class="page-head" style="margin-top:8px"><h1>Add links</h1></div>
    <form id="af" class="panel">
      <label for="links">TikTok or YouTube links</label>
      <textarea id="links" placeholder="Paste TikTok or YouTube video links (Shorts or regular). Short vm.tiktok.com and youtu.be links work too."></textarea>
      <p class="muted small" id="count">No links yet.</p>
      ${folders?.length ? `<label for="folder">Folder</label>
      <select id="folder" style="max-width:360px"><option value="">No folder</option>${folders.map((f) => `<option value="${esc(f.id)}">${esc(f.name)}</option>`).join("")}</select>
      <p class="muted small">Every link in this batch goes into this folder. You can move posts later.</p>` : ""}
      <div id="add-msg"></div>
      <div class="actions"><button class="primary" type="submit" id="go" disabled>Add links</button></div>
    </form>`;
  const ta = document.getElementById("links"), btn = document.getElementById("go"), count = document.getElementById("count");
  const fsel = document.getElementById("folder");
  const lastFolder = sessionStorageGet(`folder-${id}`);
  if (fsel && lastFolder && folders.some((f) => f.id === lastFolder)) fsel.value = lastFolder;
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
    const folderId = document.getElementById("folder")?.value || null;
    const { data: job, error } = await sb.from("link_jobs").insert({ campaign_id: id, folder_id: folderId }).select("id").single();
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
// ---------- instant page switching ----------
// The main pages are kept for a few minutes after you leave them (their live DOM, scroll position and token),
// so going back to one shows it instantly. Any write anywhere drops them, so nothing shown is out of date.
const KEEP_MS = 3 * 60 * 1000;
const KEEPABLE = new Set(["#/", "#/campaigns", "#/roster", "#/discover", "#/analytics", "#/trending", "#/trending/artists", "#/payouts", "#/invoices"]);
const pageCache = new Map();   // hash → { frag, token, at, scroll, cls }
let shown = { hash: null, token: 0 };
function keepShownPage(nextHash) {
  const h = shown.hash;
  if (!h || !KEEPABLE.has(h) || h === nextHash || shown.token !== routeToken) return;
  if (h === "#/roster" && nextHash.startsWith("#/roster")) return;   // the roster manages its own lists and side panel
  if (document.querySelector(".dlg-back, dialog[open]")) return;
  const frag = document.createDocumentFragment();
  while (app.firstChild) frag.appendChild(app.firstChild);
  pageCache.set(h, { frag, token: shown.token, at: Date.now(), scroll: window.scrollY, cls: app.className });
  app.innerHTML = `<p class="muted pad">Loading…</p>`;
}
function restorePage(h, from) {
  const k = pageCache.get(h);
  pageCache.delete(h);
  if (!k || Date.now() - k.at > KEEP_MS) return false;
  app.innerHTML = ""; app.className = k.cls; app.appendChild(k.frag);
  app.querySelectorAll(".an-zooming").forEach((el) => el.classList.remove("an-zooming"));
  // Coming back up from a page inside it (a zoomed-in chart, say): zoom back out.
  if (from && from.startsWith(`${h === "#/" ? "#/overview" : h}/`)) {
    app.style.transformOrigin = "50% 30%";
    app.classList.remove("an-zoom-out"); void app.offsetWidth; app.classList.add("an-zoom-out");
    setTimeout(() => app.classList.remove("an-zoom-out"), 600);
  }
  routeToken = k.token; shown = { hash: h, token: k.token };
  requestAnimationFrame(() => window.scrollTo(0, k.scroll));
  return true;
}
let teamOk = null;   // whether this user is on the team list, checked once per sign-in

async function route() {
  const target = normHash(location.hash);
  const prevShown = shown.hash;
  keepShownPage(target);
  const token = newToken();
  const user = await signedInUser();
  if (token !== routeToken) return;
  if (!user) { teamOk = null; return renderLogin(); }
  if (teamOk?.uid !== user.id) teamOk = { uid: user.id, ok: await isTeamMember() };
  if (token !== routeToken) return;
  if (!teamOk.ok) {
    document.body.classList.add("signin");
    app.innerHTML = `<section class="login no-access on-blue">
      <img class="logo" src="assets/stellar-blue.png" alt="Stellar" width="160" height="44">
      <h1>No access <em>yet</em></h1>
      <p>${esc(user.email)} isn't on the Stellar team list. Ask Sam to add this email, then sign in again.</p>
      <div class="actions"><button type="button" id="signout2">Sign out</button></div></section>`;
    document.getElementById("signout2").onclick = () => sb.auth.signOut();
    return;
  }
  document.body.classList.remove("signin");
  app.classList.remove("camp-on-payouts");
  renderWho(user);
  const parts = location.hash.replace(/^#\/?/, "").split("/").filter(Boolean);
  trackHistory(); updateBack(); rememberTitle(normHash(location.hash));
  // Opening or closing a creator's side panel on the roster keeps the page where it is.
  const pageKey = parts[0] === "roster" && parts[parts.length - 2] === "c" ? `#/${parts.slice(0, -2).join("/")}` : normHash(location.hash);
  const restoring = KEEPABLE.has(target) && pageCache.has(target);
  if (pageKey !== lastPageKey && !restoring) window.scrollTo(0, 0);
  lastPageKey = pageKey;
  const section = !parts[0] || parts[0] === "overview" ? "overview" : parts[0] === "creator" ? "roster" : SOON[parts[0]] || ["analytics", "trending", "roster", "discover", "payouts", "invoices"].includes(parts[0]) ? parts[0] : "campaigns";
  renderNav(section);
  if (KEEPABLE.has(target) && restorePage(target, prevShown)) { lastPageKey = pageKey; return; }
  shown = { hash: target, token };
  if (section === "overview") return renderOverview(token);
  if (section === "analytics") return renderAnalytics(app, sb, { isCurrent: () => token === routeToken, go, parts });
  if (section === "trending") return renderTrending(app, sb, { isCurrent: () => token === routeToken, go, parts, toast });
  if (section === "roster") return renderRoster(app, sb, { isCurrent: () => token === routeToken, go, parts, toast });
  if (section === "invoices") return renderInvoices(app, sb, { isCurrent: () => token === routeToken, go, toast });
  if (section === "payouts") return renderPayoutsHome(app, sb, { isCurrent: () => token === routeToken, go });
  if (section === "discover") return renderDiscover(app, sb, { isCurrent: () => token === routeToken, go, parts, toast });
  if (SOON[parts[0]]) return renderSoon(parts[0]);
  if (parts[0] === "campaigns") return renderList(token);
  if (parts[0] === "new") return renderForm(token);
  if (parts[0] === "report" && parts[1]) return renderReport(token, decodeURIComponent(parts.slice(1).join("/")));
  if (parts[0] === "c" && parts[1]) {
    if (parts[2] === "edit") return renderForm(token, parts[1]);
    if (parts[2] === "add") return renderAdd(token, parts[1], parts[3]);
    return renderCampaign(token, parts[1], parts[2] === "payouts" ? "payouts" : "report");
  }
  return renderList(token);
}

let lastPageKey = null;
window.addEventListener("hashchange", route);
// Supabase also reports SIGNED_IN when a tab regains focus, so only re-render when the user actually changes.
// Work is deferred with setTimeout: calling Supabase inside this callback can deadlock the client.
let lastUserId;
sb.auth.onAuthStateChange((_event, session) => {
  const uid = session?.user?.id ?? null;
  if (lastUserId !== undefined && uid !== lastUserId) { pageCache.clear(); teamOk = null; setTimeout(route, 0); }
  lastUserId = uid;
});
route();
