// Personal to-do list (beta). Runs in two places from this one file:
//   - todo.html: a page of its own (opened with a private link, or the Stellar OS session in this browser)
//   - Stellar OS: a floating to-do button bottom-right on every page that opens a right-hand sidebar
//     (mountTodoInOS, called from app.js after sign-in; it uses the OS session and only shows for people
//     the beta is switched on for).
// Everything renders into one panel element (root), one "view" at a time, and views slide in and out:
//   setup (first open: focus areas + letters) · list · task (edit one task) · snap (photo review)
//   · recap (Friday) · plan (Monday) · link (private link for the phone)
// Focus areas: each person picks theirs, with a short letter (e.g. CC = Campaign Central, S = Sports) to write
// next to tasks on paper; M = Meetings & calls is there for everyone. Photos, quick add and the AI box use them.
// Weeks run Monday to Sunday, Copenhagen time. The Friday recap opens from 17:00 on Friday; the week overview
// from 08:00 on Monday. Both light up the week button (and the OS button) until they're gone through.
import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from "./config.js?v=20261109e";
import { confirmDialog } from "./dialog.js?v=20261109e";

const FN = `${SUPABASE_URL}/functions/v1/todo`;
const KEY_STORE = "stellar-todo-key";
let root = null;
// Where it's running: the page (standalone) or the OS sidebar.
let HOST = { standalone: true, sb: null, scroller: null, onClose: null, onPending: null };
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const store = { get(k) { try { return localStorage.getItem(k); } catch { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } }, del(k) { try { localStorage.removeItem(k); } catch { /* */ } } };

// ---------- icons (OS line style) ----------
const svg = (body, cls = "td-ico") => `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true">${body}</svg>`;
export const ICON_TODO = svg('<rect x="4.5" y="4" width="15" height="17.5" rx="3"/><path d="M9 4V3.2C9 2.5 9.5 2 10.2 2h3.6c.7 0 1.2.5 1.2 1.2V4M7.8 10.2l1.4 1.4 2.6-2.6M13.6 10.6h2.6M13.6 15.8h2.6"/><circle cx="9.4" cy="15.8" r="1.3"/>');
const I = {
  camera: svg('<path d="M4 8.5A2.5 2.5 0 0 1 6.5 6h1.3l1.4-2h5.6l1.4 2h1.3A2.5 2.5 0 0 1 20 8.5v8a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 16.5z"/><circle cx="12" cy="12.5" r="3.4"/>'),
  week: svg('<rect x="3.5" y="5" width="17" height="15" rx="3"/><path d="M3.5 10h17M8 3v4M16 3v4M8 14h2M14 14h2"/>'),
  more: svg('<circle cx="5.5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="18.5" cy="12" r="1.3"/>'),
  spark: svg('<path d="M12 3.5l1.7 4.8 4.8 1.7-4.8 1.7L12 16.5l-1.7-4.8L5.5 10l4.8-1.7zM18.5 15.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z"/>'),
  mail: svg('<rect x="3.5" y="5.5" width="17" height="13" rx="2.5"/><path d="m4.5 7 7.5 6 7.5-6"/>'),
  cal: svg('<rect x="3.5" y="5" width="17" height="15" rx="3"/><path d="M3.5 10h17M8 3v4M16 3v4"/>'),
  reply: svg('<path d="M10 7 5 12l5 5"/><path d="M5.5 12H14a5 5 0 0 1 5 5v1"/>'),
  plus: svg('<path d="M12 5v14M5 12h14"/>'),
  back: svg('<path d="M14.5 5.5 8 12l6.5 6.5"/>'),
  chev: svg('<path d="m9.5 5.5 6.5 6.5-6.5 6.5"/>'),
  close: svg('<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>'),
  flag: svg('<path d="M6 20.5V4.5M6 5h10.5l-2 3.8 2 3.7H6"/>'),
  clock: svg('<circle cx="12" cy="12" r="8"/><path d="M12 7.5V12l3 2"/>'),
  check: '<svg viewBox="0 0 14 14" aria-hidden="true"><path d="m3 7.3 2.6 2.6L11 4.5"/></svg>',
};

// ---------- Copenhagen time ----------
function cph(d = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Copenhagen", year: "numeric", month: "2-digit", day: "2-digit", weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false })
    .formatToParts(d).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, wd: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(p.weekday), hour: Number(p.hour) % 24, min: Number(p.minute) };
}
const addDays = (date, n) => { const t = new Date(`${date}T12:00:00Z`); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
const mondayOf = (d = new Date()) => { const c = cph(d); return addDays(c.date, -c.wd); };
const mondayOfDate = (date) => { const wd = (new Date(`${date}T12:00:00Z`).getUTCDay() + 6) % 7; return addDays(date, -wd); };
// The moment a Copenhagen wall-clock time happens, as a timestamp.
function cphMs(date, hour = 0) {
  const guess = Date.parse(`${date}T${String(hour).padStart(2, "0")}:00:00Z`);
  const c = cph(new Date(guess));
  const shown = Date.parse(`${c.date}T${String(c.hour).padStart(2, "0")}:${String(c.min).padStart(2, "0")}:00Z`);
  return guess - (shown - guess);
}
const fmtDay = (date) => new Date(`${date}T12:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
const fmtWd = (date, style = "short") => new Date(`${date}T12:00:00Z`).toLocaleDateString("en-GB", { weekday: style, timeZone: "UTC" });
const weekLabel = (monday) => `Week of ${fmtDay(monday)}`;

// ---------- "when": EOD, EOW, this week, a day, a time ----------
// Stored as due_date + due_kind (eod | eow | week | day) + optional due_time.
function whenPreset(key, day) {
  const t = cph().date, mon = mondayOf();
  if (key === "today") return { due_kind: "eod", due_date: t };
  if (key === "tomorrow") return { due_kind: "day", due_date: addDays(t, 1) };
  if (key === "eow") { const fri = addDays(mon, 4); return { due_kind: "eow", due_date: t > fri ? addDays(fri, 7) : fri }; }
  if (key === "week") return { due_kind: "week", due_date: addDays(mon, 6) };
  if (key === "next") return { due_kind: "week", due_date: addDays(mon, 13) };
  if (key === "day") return { due_kind: "day", due_date: day };
  return { due_kind: null, due_date: null, due_time: null };
}
function presetOf(t) {
  if (!t.due_date) return "none";
  const p = (k) => { const x = whenPreset(k); return x.due_date === t.due_date && x.due_kind === (t.due_kind ?? "day"); };
  return ["today", "tomorrow", "eow", "week", "next"].find(p) ?? "day";
}
function whenLabel(t) {
  if (!t.due_date) return null;
  const today = cph().date, d = t.due_date, kind = t.due_kind ?? "day";
  const time = t.due_time ? ` · ${String(t.due_time).slice(0, 5)}` : "";
  const open = t.status === "open" || t.status === "partial";
  const thisMon = mondayOf(), dMon = mondayOfDate(d);
  if (open && kind !== "week" && d < today) return { text: `Overdue · ${d === addDays(today, -1) ? "yesterday" : fmtDay(d)}`, late: true };
  if (open && kind === "week" && d < today) return { text: `Overdue · week of ${fmtDay(dMon)}`, late: true };
  if (kind === "week") return { text: dMon === thisMon ? "This week" : dMon === addDays(thisMon, 7) ? "Next week" : `Week of ${fmtDay(dMon)}` };
  if (kind === "eow") return { text: dMon === thisMon ? "EOW" : `EOW · ${fmtDay(d)}` };
  const rel = d === today ? "Today" : d === addDays(today, 1) ? "Tomorrow" : dMon === thisMon ? fmtWd(d, "long") : `${fmtWd(d)} ${fmtDay(d)}`;
  if (kind === "eod") return { text: d === today ? `EOD${time}` : `EOD · ${rel}${time}`, today: d === today };
  return { text: `${rel}${time}`, today: d === today };
}

// ---------- focus areas ----------
const TINTS = [["#e9edfd", "#0626c7"], ["#f1ebfc", "#6a3dc2"], ["#e6f4ec", "#16794a"], ["#fbf1e1", "#985a00"], ["#fcebef", "#b4234a"], ["#e5f3f6", "#0d6f82"], ["#efeff3", "#4b4b57"], ["#f9ece3", "#a24a12"]];
const areaById = (id) => S.areas.find((a) => a.id === id) ?? null;
const areaByCode = (code) => S.areas.find((a) => a.code === String(code ?? "").toUpperCase()) ?? null;
function tint(a) { const i = a?.builtin ? 0 : (S.areas.filter((x) => !x.builtin).indexOf(a) + 1) % TINTS.length; return TINTS[Math.max(0, i)]; }
const badge = (a, big = false) => a ? `<span class="td-badge${big ? " big" : ""}" style="--bg:${tint(a)[0]};--fg:${tint(a)[1]}" title="${esc(a.name)}">${esc(a.code)}</span>` : "";
const SUGGESTIONS = ["Campaigns", "Campaign Central", "Proposals", "Sports", "Organizational", "Clients", "Creators", "Pitches", "Finance", "Admin", "Personal"];
// Some areas (e.g. Campaign Central, Sports) are only offered to the people the server allows.
function suggestions() {
  const acc = S.cfg?.areas_access ?? { restricted: ["Campaign Central", "Sports"], allowed: [] };
  const lc = (x) => x.toLowerCase();
  return SUGGESTIONS.filter((n) => !acc.restricted.map(lc).includes(lc(n)) || acc.allowed.map(lc).includes(lc(n)));
}
const PRIOS = [1, 2, 3, 4, 5];
function suggestCode(name, taken) {
  const words = name.toUpperCase().replace(/[^A-Z ]/g, "").split(/\s+/).filter(Boolean);
  const tries = [];
  if (words.length > 1) tries.push(words.map((w) => w[0]).join("").slice(0, 3));
  if (words[0]) tries.push(words[0][0], words[0].slice(0, 2), words[0].slice(0, 3));
  for (const c of tries) if (c && c !== "M" && !taken.has(c)) return c;
  for (const ch of "ABCDEFGHIJKLNOPQRSTUVWXYZ") { const c = (words[0]?.[0] ?? "X") + ch; if (!taken.has(c) && c !== "M") return c; }
  return "";
}

// ---------- talking to the server ----------
let auth = null;   // { header, value } or { fromOS }
async function setupAuth() {
  if (HOST.sb) return (auth = { header: "Authorization", fromOS: true });
  const m = location.hash.match(/[#&]k=([A-Za-z0-9_-]{32,100})/);
  if (m) { store.set(KEY_STORE, m[1]); history.replaceState(null, "", location.pathname + location.search); }
  const key = store.get(KEY_STORE);
  if (key) return (auth = { header: "x-todo-key", value: key });
  try {
    const { createClient } = await import("./vendor/supabase.esm.js");
    const { data } = await createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY).auth.getSession();
    if (data.session?.access_token) return (auth = { header: "Authorization", value: `Bearer ${data.session.access_token}` });
  } catch { /* no session */ }
  return (auth = null);
}
async function api(action, body = {}) {
  const headers = { "Content-Type": "application/json", apikey: SUPABASE_PUBLISHABLE_KEY };
  if (auth?.fromOS) {
    const { data } = await HOST.sb.auth.getSession();   // always the current token (it refreshes)
    if (data.session?.access_token) headers.Authorization = `Bearer ${data.session.access_token}`;
  } else if (auth) headers[auth.header] = auth.value;
  const r = await fetch(FN, { method: "POST", headers, body: JSON.stringify({ action, ...body }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(j.error || "Something went wrong. Please try again."); e.locked = !!j.locked; throw e; }
  return j;
}

// ---------- state ----------
const S = { items: [], weeks: [], areas: [], cfg: null, view: "list", prev: "list", taskId: null, filter: "all", step: 0, preview: false,
  flowWeek: null, proposal: null, aiBusy: false, aiOpen: false, setup: null, snap: null, linkFresh: null, links: null, skipSetup: false };
const byId = (id) => S.items.find((x) => x.id === id);
const weekRow = (w) => S.weeks.find((x) => x.week_start === w) ?? {};
const isOpen = (t) => t.status === "open" || t.status === "partial";
function upsert(rows) { for (const r of [].concat(rows || [])) { if (!r) continue; const i = S.items.findIndex((x) => x.id === r.id); if (i >= 0) S.items[i] = r; else S.items.push(r); } }

function toast(msg, action) {
  document.querySelector(".td-toast")?.remove();
  const t = document.createElement("div"); t.className = "td-toast"; t.setAttribute("role", "status");
  t.innerHTML = `<span>${esc(msg)}</span>${action ? `<button type="button">${esc(action.label)}</button>` : ""}`;
  if (action) t.querySelector("button").onclick = () => { t.remove(); action.run(); };
  document.body.append(t);
  requestAnimationFrame(() => t.classList.add("in"));
  setTimeout(() => { t.classList.remove("in"); setTimeout(() => t.remove(), 250); }, action ? 5000 : 2800);
}
async function act(fn, okMsg) {
  try { const r = await fn(); if (okMsg) toast(okMsg); return r; }
  catch (e) { toast(e.message); if (e.locked && HOST.standalone) return boot(); return null; }
}

// Order: urgent, then by date (and time), then as added. Numbers follow the order on screen (the AI box uses them).
const dueKey = (t) => `${t.due_date ?? "9999-99-99"} ${t.due_time ?? "99:99"}`;
const prioOf = (t) => areaById(t.area_id)?.priority ?? 99;
function sortOpen(list) { return [...list].sort((a, b) => (b.urgent - a.urgent) || (dueKey(a) < dueKey(b) ? -1 : dueKey(a) > dueKey(b) ? 1 : 0) || (prioOf(a) - prioOf(b)) || (a.position - b.position)); }

// ---------- Friday recap / Monday overview timing ----------
function recapWeek() {
  const c = cph(), mon = addDays(c.date, -c.wd);
  return (c.wd === 4 && c.hour >= 17) || c.wd >= 5 ? mon : addDays(mon, -7);
}
function recapPending() {
  const w = recapWeek(), fri17 = cphMs(addDays(w, 4), 17);
  if (Date.now() < fri17 || weekRow(w).recap_done_at) return false;
  return S.items.some((t) => Date.parse(t.created_at) < fri17 && (isOpen(t) || Date.parse(t.updated_at) >= cphMs(w)));
}
function planPending() {
  const c = cph(), mon = addDays(c.date, -c.wd);
  if (Date.now() < cphMs(mon, 8) || weekRow(mon).plan_done_at) return false;
  return S.items.some((t) => isOpen(t) && Date.parse(t.created_at) < cphMs(mon));
}

// ---------- rendering: one view at a time, with a transition ----------
// dir: "fwd" (slides in from the right), "back" (from the left), "up" (rises), "none".
function render(dir = "none") {
  if (!root) return;
  const v = S.view;
  const html = v === "setup" ? setupHTML() : v === "task" ? taskHTML() : v === "snap" ? snapHTML() : v === "recap" ? recapHTML()
    : v === "plan" ? planHTML() : v === "link" ? linkHTML() : listHTML();
  root.classList.toggle("td-wide", v === "list" && isWide());
  root.innerHTML = `<div class="td-view${dir !== "none" ? ` td-in-${dir}` : ""}">${html}</div>`;
  ({ setup: wireSetup, task: wireTask, snap: wireSnap, recap: wireRecap, plan: wirePlan, link: wireLink }[v] ?? wireList)();
  HOST.onPending?.(recapPending() || planPending());
}
function go(view, dir = "fwd") { S.prev = S.view === "task" ? S.prev : S.view; S.view = view; S.proposal = null; render(dir); toTop(); }
const toTop = () => (HOST.scroller ? (HOST.scroller.scrollTop = 0) : window.scrollTo(0, 0));
const closeBtn = () => HOST.onClose ? `<button type="button" class="td-ghost td-x" data-close aria-label="Close the to-do list">${I.close}</button>` : "";
const backBar = (label = "Back", extra = "") => `<div class="td-bar"><button type="button" class="td-ghost td-back" data-back>${I.back}<span>${esc(label)}</span></button><span class="td-sp"></span>${extra}${closeBtn()}</div>`;
function wireCommon(onBack) {
  root.querySelectorAll("[data-close]").forEach((b) => (b.onclick = () => HOST.onClose?.()));
  root.querySelectorAll("[data-back]").forEach((b) => (b.onclick = onBack ?? (() => { S.view = "list"; render("back"); toTop(); })));
}

// ---------- list ----------
function headHTML() {
  const rp = recapPending(), pp = planPending(), pending = rp || pp;
  const label = rp ? "Friday recap" : pp ? "Your week" : "Week";
  return `<header class="td-head">
    <h1 class="td-title">${ICON_TODO}<span>To-do</span><span class="td-beta">Beta</span></h1>
    <span class="td-sp"></span>
    <button type="button" class="td-ghost td-week${pending ? " pending" : ""}" id="td-week" title="${pending ? `${label} is ready` : "Week overview"}" aria-label="${pending ? `${label} is ready` : "Week overview"}">${I.week}${pending ? `<span class="td-week-l">${label}</span><i class="td-dot" aria-hidden="true"></i>` : ""}</button>
    <button type="button" class="td-ghost" id="td-snap" title="Snap your notes" aria-label="Snap your notes">${I.camera}</button>
    <details class="td-menu"><summary class="td-ghost" aria-label="More" title="More">${I.more}</summary><div class="td-menu-pop">
      <button type="button" data-m="areas">Focus areas &amp; letters</button>
      <button type="button" data-m="link">Private link for your phone</button>
      <button type="button" data-m="recap">Try the Friday recap now</button>
      <button type="button" data-m="plan">Try the Monday overview now</button>
      ${auth?.header === "x-todo-key" ? '<button type="button" data-m="forget">Forget this device</button>' : ""}
      ${HOST.standalone ? "" : '<button type="button" data-m="page">Open as a full page</button>'}
    </div></details>
    ${closeBtn()}
  </header>
  <input type="file" id="td-file" accept="image/*" hidden>`;
}
function wireHead() {
  wireCommon();
  document.getElementById("td-week").onclick = () => openFlow();
  document.getElementById("td-snap").onclick = () => document.getElementById("td-file").click();
  document.getElementById("td-file").onchange = (e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) snap(f); };
  const menu = root.querySelector(".td-menu");
  menu.querySelectorAll("[data-m]").forEach((b) => (b.onclick = () => {
    menu.open = false;
    const m = b.dataset.m;
    if (m === "areas") startSetup(true);
    if (m === "link") { S.linkFresh = null; S.links = null; go("link"); }
    if (m === "recap") openFlow("recap", true);
    if (m === "plan") openFlow("plan", true);
    if (m === "page") window.open("todo.html", "_blank", "noopener");
    if (m === "forget") confirmDialog({ title: "Forget this device?", body: "This browser stops opening your list. Your tasks stay saved, and your private link still works on other devices.", confirm: "Forget", danger: false })
      .then((ok) => { if (ok) { store.del(KEY_STORE); boot(); } });
  }));
}

function rowHTML(t, n, opts = {}) {
  const a = areaById(t.area_id), w = whenLabel(t);
  const meta = [
    t.urgent && isOpen(t) ? `<span class="td-tag urgent">${I.flag}Urgent</span>` : "",
    w && isOpen(t) ? `<span class="td-tag${w.late ? " late" : w.today ? " today" : ""}">${I.clock}${esc(w.text)}</span>` : "",
    t.status === "partial" ? `<span class="td-tag part">Partly done${t.remaining ? ` · ${esc(t.remaining)}` : ""}</span>` : "",
    t.project ? `<span class="td-tag plain">${esc(t.project)}</span>` : "",
  ].join("");
  const state = t.status === "done" ? "on" : t.status === "partial" ? "half" : "";
  return `<li class="td-item${t.status === "done" ? " done" : ""}" data-id="${esc(t.id)}" style="--i:${Math.min(n || 0, 14)}">
    <button type="button" class="td-check ${state}" data-toggle aria-label="${t.status === "done" ? "Mark as not done" : "Mark as done"}: ${esc(t.title)}">${I.check}</button>
    <div class="td-body" data-open tabindex="0" role="button" aria-label="Open ${esc(t.title)}">
      <div class="td-t">${n ? `<span class="td-num">${n}</span>` : ""}${esc(t.title)}</div>
      ${meta ? `<div class="td-meta">${meta}</div>` : ""}
      ${opts.qa ? `<div class="td-qa">${opts.qa(t)}</div>` : ""}
    </div>
    ${a && !opts.noBadge ? `<span class="td-row-badge">${badge(a)}</span>` : ""}
  </li>`;
}
function wireRows(scope = root) {
  scope.querySelectorAll(".td-item").forEach((li) => {
    const t = byId(li.dataset.id);
    if (!t) return;
    li.querySelector("[data-toggle]").onclick = () => toggleDone(t, li);
    const body = li.querySelector("[data-open]");
    body.onclick = (e) => { if (!e.target.closest("button")) openTask(t.id); };
    body.onkeydown = (e) => { if ((e.key === "Enter" || e.key === " ") && e.target === body) { e.preventDefault(); openTask(t.id); } };
    li.querySelectorAll("[data-qa]").forEach((b) => (b.onclick = (e) => { e.stopPropagation(); quick(t, b.dataset.qa, li); }));
  });
}

function aiHTML(placeholder) {
  if (!S.cfg?.ai) return "";
  return `<section class="td-ai${S.aiOpen ? " open" : ""}">
    <button type="button" class="td-ai-toggle" id="td-ai-toggle" aria-expanded="${S.aiOpen}">${I.spark}<span>Tell me what changed</span></button>
    <div class="td-ai-body"><div><form class="td-ai-form" id="td-ai-form"><textarea id="td-ai-in" rows="1" placeholder="${esc(placeholder)}"></textarea><button type="submit" class="primary">Update</button></form><div id="td-prop"></div></div></div>
  </section>`;
}
function wireAI(numbered) {
  const sec = root.querySelector(".td-ai");
  if (!sec) return;
  const f = document.getElementById("td-ai-form"), input = document.getElementById("td-ai-in");
  document.getElementById("td-ai-toggle").onclick = () => {
    S.aiOpen = !S.aiOpen; sec.classList.toggle("open", S.aiOpen);
    document.getElementById("td-ai-toggle").setAttribute("aria-expanded", S.aiOpen);
    if (S.aiOpen) setTimeout(() => input.focus(), 180);
  };
  grow(input);
  input.onkeydown = (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); f.requestSubmit(); } };
  f.onsubmit = async (e) => {
    e.preventDefault();
    const prompt = input.value.trim();
    if (!prompt || S.aiBusy) return;
    S.aiBusy = true;
    const box = document.getElementById("td-prop");
    box.innerHTML = `<div class="td-prop"><p class="td-thinking"><i></i><i></i><i></i></p></div>`;
    const r = await act(() => api("ai", { prompt, tasks: numbered.map((t, i) => ({ n: i + 1, id: t.id })) }));
    S.aiBusy = false;
    if (!r) { box.innerHTML = ""; return; }
    S.proposal = r; input.value = ""; input.style.height = "";
    showProposal(box);
  };
}
const OP_WORD = { done: "Done", partial: "Partly done", reopen: "Not done", update: "Change", add: "New", drop: "Remove" };
function opText(o) {
  const w = o.due_date ? whenLabel({ ...o, status: "open" })?.text : null;
  const area = o.area_code ? areaByCode(o.area_code) : null;
  if (o.op === "add") return `${area ? badge(area) + " " : ""}${esc(o.title)}${w ? ` <span class="muted">· ${esc(w)}</span>` : ""}${o.follows_title ? ` <span class="muted">· follows “${esc(o.follows_title)}”</span>` : ""}`;
  const bits = [];
  if (o.op === "partial" && o.remaining) bits.push(`left: ${esc(o.remaining)}`);
  if (o.op === "update") {
    if (o.title) bits.push(`→ ${esc(o.title)}`);
    if (w) bits.push(esc(w));
    if (o.urgent != null) bits.push(o.urgent ? "urgent" : "not urgent");
    if (area) bits.push(`${esc(area.code)} · ${esc(area.name)}`);
    if (o.notes) bits.push("notes");
  }
  return `${esc(o.current)}${bits.length ? ` <span class="muted">· ${bits.join(" · ")}</span>` : ""}`;
}
function showProposal(box) {
  const p = S.proposal;
  if (!p.ops.length) { box.innerHTML = `<div class="td-prop"><p>${esc(p.reply || "Nothing to change.")}</p></div>`; return; }
  box.innerHTML = `<div class="td-prop"><p>${esc(p.reply)}</p>
    <ul>${p.ops.map((o, i) => `<li><label><input type="checkbox" data-op="${i}" checked><span><b class="td-op">${OP_WORD[o.op] ?? o.op}</b> ${opText(o)}</span></label></li>`).join("")}</ul>
    <div class="td-row-actions"><button type="button" class="primary" id="td-apply">Apply</button><button type="button" class="td-ghost-text" id="td-cancel">Cancel</button></div></div>`;
  box.querySelector("#td-cancel").onclick = () => { S.proposal = null; box.innerHTML = ""; };
  box.querySelector("#td-apply").onclick = async () => {
    const ops = p.ops.filter((_, i) => box.querySelector(`[data-op="${i}"]`).checked);
    const r = await act(() => api("apply", { ops }), ops.length ? "Updated" : null);
    if (r) { upsert(r.items); S.proposal = null; render(); }
  };
}
// Text boxes grow with their text. Measured again once the view has finished sliding in (its width changes).
const grow = (ta) => { const f = () => { if (!ta.isConnected || !ta.offsetWidth) return; ta.style.height = "auto"; ta.style.height = `${Math.min(ta.scrollHeight, 160)}px`; }; ta.addEventListener("input", f); f(); requestAnimationFrame(f); setTimeout(f, 380); };

function listGroups(open) {
  const today = cph().date, sunday = addDays(mondayOf(), 6);
  const g = { urgent: [], today: [], week: [], later: [], none: [] };
  for (const t of open) {
    const late = t.due_date && t.due_date < today && (t.due_kind ?? "day") !== "week" || (t.due_kind === "week" && t.due_date && t.due_date < today);
    if (t.urgent || late) g.urgent.push(t);
    else if (!t.due_date) g.none.push(t);
    else if (t.due_date === today) g.today.push(t);
    else if (t.due_date <= sunday) g.week.push(t);
    else g.later.push(t);
  }
  return g;
}
// Full page on a laptop: every folder side by side, highest priority first (same priority = next to each other).
const isWide = () => !!HOST.standalone && window.innerWidth >= 1100 && S.areas.length > 0;
function boardCols() {
  const open = sortOpen(S.items.filter(isOpen));
  const cols = S.areas.map((a) => ({ a, items: open.filter((t) => t.area_id === a.id) }));
  const none = open.filter((t) => !areaById(t.area_id));
  if (none.length) cols.push({ a: null, items: none });
  return cols;
}
function boardHTML() {
  const week = mondayOf(), weekStartMs = cphMs(week);
  const openAll = S.items.filter(isOpen);
  const done = S.items.filter((t) => t.status === "done" && Date.parse(t.done_at ?? t.updated_at) >= weekStartMs).sort((a, b) => Date.parse(b.done_at) - Date.parse(a.done_at));
  const groups = [];
  for (const c of boardCols()) {
    const p = c.a?.priority ?? null, last = groups.at(-1);
    if (last && last.p === p) last.cols.push(c); else groups.push({ p, cols: [c] });
  }
  let n = 0;
  const col = ({ a, items }) => `<div class="td-col">
      <header class="td-col-h">${a ? badge(a) : '<span class="td-badge" style="--bg:#efeff3;--fg:#86868b">–</span>'}<span>${a ? esc(a.name) : "No area"}</span><em>${items.length}</em></header>
      ${items.length ? `<ul class="td-list">${items.map((t) => rowHTML(t, ++n, { noBadge: !!a })).join("")}</ul>` : `<p class="td-col-empty">Nothing here.</p>`}
      ${a ? `<form class="td-col-add" data-add="${esc(a.id)}" autocomplete="off">${I.plus}<input placeholder="Add a task" aria-label="Add a task to ${esc(a.name)}" maxlength="300"></form>` : ""}
    </div>`;
  return `${headHTML()}
    <div class="td-wide-top">
      <p class="td-sub">${weekLabel(week)} · ${openAll.length} open${done.length ? ` · ${done.length} done` : ""}</p>
      <form class="td-compose" id="td-add" autocomplete="off">
        <span class="td-compose-ico">${I.plus}</span>
        <textarea id="td-new" rows="1" placeholder="Add a task" aria-label="New task"></textarea>
        <button type="submit" class="primary td-compose-go" aria-label="Add">Add</button>
      </form>
      <p class="td-hint">Start with a letter to file it, e.g. “${esc(S.areas.find((a) => !a.builtin)?.code ?? "M")}: …”. Add EOD or EOW at the end. Paste several lines to add them all.</p>
      ${aiHTML("e.g. “1 is done, but I still have to send the invoice”")}
    </div>
    <div class="td-board stagger">
      ${groups.map((g) => `<section class="td-pgroup${g.p === 1 ? " p1" : ""}" style="--c:${g.cols.length}">
        <h2 class="td-plabel">${g.p ? `Priority ${g.p}` : "Other"}</h2>
        <div class="td-pcols">${g.cols.map(col).join("")}</div>
      </section>`).join("")}
    </div>
    ${done.length ? `<div class="td-wide-top"><details class="td-done-toggle"><summary>Done this week · ${done.length}</summary><ul class="td-list">${done.map((t) => rowHTML(t, 0)).join("")}</ul></details></div>` : ""}`;
}
function listHTML() {
  if (isWide()) return boardHTML();
  const week = mondayOf(), weekStartMs = cphMs(week);
  const inFilter = (t) => S.filter === "all" || (S.filter === "none" ? !t.area_id : t.area_id === S.filter);
  const openAll = S.items.filter(isOpen);
  const open = sortOpen(openAll.filter(inFilter));
  const g = listGroups(open);
  const done = S.items.filter((t) => t.status === "done" && inFilter(t) && Date.parse(t.done_at ?? t.updated_at) >= weekStartMs).sort((a, b) => Date.parse(b.done_at) - Date.parse(a.done_at));
  let n = 0;
  const group = (title, list) => list.length ? `<h2 class="td-sec">${title}<span>${list.length}</span></h2><ul class="td-list">${list.map((t) => rowHTML(t, ++n)).join("")}</ul>` : "";
  const counts = (id) => openAll.filter((t) => (id === "none" ? !t.area_id : t.area_id === id)).length;
  const noArea = counts("none");
  const chips = S.areas.length ? `<nav class="td-folders" aria-label="Focus areas">
      <button type="button" class="td-folder${S.filter === "all" ? " on" : ""}" data-f="all">All<span>${openAll.length}</span></button>
      ${S.areas.map((a) => `<button type="button" class="td-folder${S.filter === a.id ? " on" : ""}" data-f="${esc(a.id)}">${badge(a)}${esc(a.name)}<span>${counts(a.id)}</span></button>`).join("")}
      ${noArea ? `<button type="button" class="td-folder${S.filter === "none" ? " on" : ""}" data-f="none">No area<span>${noArea}</span></button>` : ""}
    </nav>` : "";
  const fa = S.filter !== "all" && S.filter !== "none" ? areaById(S.filter) : null;
  const tip = S.areas.length > 1 ? `Tip: start with a letter, e.g. “${esc(S.areas.find((a) => !a.builtin)?.code ?? "M")}: …”. Add EOD or EOW at the end.` : "Add EOD or EOW at the end to set when.";
  return `${headHTML()}
    <p class="td-sub">${weekLabel(week)} · ${openAll.length} open${done.length ? ` · ${done.length} done` : ""}</p>
    ${chips}
    <form class="td-compose" id="td-add" autocomplete="off">
      <span class="td-compose-ico">${I.plus}</span>
      <textarea id="td-new" rows="1" placeholder="${fa ? `Add to ${esc(fa.name)}` : "Add a task"}" aria-label="New task"></textarea>
      <button type="submit" class="primary td-compose-go" aria-label="Add">Add</button>
    </form>
    <p class="td-hint">${tip} Paste several lines to add them all.</p>
    ${aiHTML("e.g. “1 is done, but I still have to send the invoice”")}
    <div class="td-lists stagger">
    ${open.length ? group("Urgent", g.urgent) + group("Today", g.today) + group("This week", g.week) + group("Later", g.later) + group("No date", g.none)
      : `<div class="td-empty">${ICON_TODO}<p>${S.filter === "all" ? "Nothing on your list." : "Nothing in this area."}</p><span>Add a task above, or snap a photo of your notepad.</span></div>`}
    ${done.length ? `<details class="td-done-toggle"><summary>Done this week · ${done.length}</summary><ul class="td-list">${done.map((t) => rowHTML(t, 0)).join("")}</ul></details>` : ""}
    </div>`;
}
let numbered = [];
function wireList() {
  wireHead(); wireRows();
  const inFilter = (t) => S.filter === "all" || (S.filter === "none" ? !t.area_id : t.area_id === S.filter);
  const wide = isWide();
  const g = listGroups(sortOpen(S.items.filter(isOpen).filter(inFilter)));
  numbered = wide ? boardCols().flatMap((c) => c.items) : [...g.urgent, ...g.today, ...g.week, ...g.later, ...g.none];
  root.querySelectorAll("[data-add]").forEach((f) => (f.onsubmit = async (e) => {
    e.preventDefault();
    const inp = f.querySelector("input"), v = inp.value.trim();
    if (!v) return;
    const item = parseQuick(v, areaById(f.dataset.add));
    inp.value = "";
    const r = await act(() => api("add_many", { source: "manual", items: [item] }));
    if (r) { upsert(r.items); render(); const again = root.querySelector(`[data-add="${f.dataset.add}"] input`); again?.focus(); root.querySelector(`[data-id="${r.items[0]?.id}"]`)?.classList.add("td-new-row"); }
  }));
  wireAI(numbered);
  root.querySelectorAll("[data-f]").forEach((b) => (b.onclick = () => { S.filter = b.dataset.f; render("fade"); }));
  root.querySelector(".td-folder.on")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  const f = document.getElementById("td-add"), input = document.getElementById("td-new");
  grow(input);
  input.onkeydown = (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); f.requestSubmit(); } };
  f.onsubmit = async (e) => {
    e.preventDefault();
    const lines = input.value.split(/\n+/).map((s) => s.replace(/^\s*(?:[-*•]|\d+[.)]|\[ ?\])\s*/, "").trim()).filter(Boolean);
    if (!lines.length) return;
    const items = lines.map((l) => parseQuick(l, wide ? null : undefined));
    const r = await act(() => api("add_many", { source: "manual", items }), items.length > 1 ? `${items.length} tasks added` : null);
    if (r) { upsert(r.items); render(); const ni = document.getElementById("td-new"); ni?.focus(); root.querySelector(`[data-id="${r.items[0]?.id}"]`)?.classList.add("td-new-row"); }
  };
}
// "S: call Juventus EOW" → area S, due end of week. The active folder is used when no letter is given.
// fallback: the area to use without a letter (undefined = the folder you're in, null = none).
function parseQuick(line, fallback) {
  let title = line, area = null, when = null;
  const m = title.match(/^\s*([A-Za-z]{1,3})\s*[:\-–—)]\s+(.+)$/);
  if (m && areaByCode(m[1])) { area = areaByCode(m[1]); title = m[2]; }
  const w = title.match(/\s+(EOD|EOW|today|tomorrow|this week|next week)\s*[.!]?$/i);
  if (w) { title = title.slice(0, w.index); when = { eod: "today", eow: "eow", today: "today", tomorrow: "tomorrow", "this week": "week", "next week": "next" }[w[1].toLowerCase()]; }
  const urgent = /(^|\s)!{1,3}$/.test(title) || /\bASAP\b/i.test(title);
  title = title.replace(/\s*!+$/, "").trim();
  if (!area) area = fallback !== undefined ? fallback : (S.filter !== "all" && S.filter !== "none" ? areaById(S.filter) : null);
  return { title: title.slice(0, 300), urgent, ...(area ? { area_id: area.id } : {}), ...(when ? whenPreset(when) : {}) };
}

// ---------- changing tasks ----------
async function save(t, patch, msg) {
  const r = await act(() => api("save", { item: { id: t.id, ...patch } }), msg);
  if (r?.item) upsert(r.item);
  return r?.item ?? null;
}
// Ticking a task off: the circle fills, the row fades and folds away, then the list settles.
async function toggleDone(t, li) {
  const to = t.status === "done" ? "open" : "done";
  if (li && to === "done" && S.view === "list") {
    li.classList.add("td-leaving"); li.querySelector(".td-check")?.classList.add("on");
    await new Promise((r) => setTimeout(r, 420));
  }
  const prev = t.status;
  if (await save(t, { status: to })) {
    render();
    if (to === "done") toast("Done", { label: "Undo", run: async () => { await save(t, { status: prev }); render(); } });
  } else render();
}
async function quick(t, what, li) {
  if (what === "done") return toggleDone(t, li);
  if (what === "reopen") { await save(t, { status: "open" }); return render(); }
  if (what === "keep") { await save(t, { urgent: false }, "Kept for next week"); return render(); }
  if (what === "partial") return openTask(t.id, { partial: true });
  if (what === "drop") return removeTask(t);
  if (what === "monday") { await save(t, { ...whenPreset("day", addDays(mondayOf(), 7)), urgent: false }, "Moved to Monday"); return render(); }
  if (what === "urgent") { await save(t, { urgent: !t.urgent }); return render(); }
}
async function removeTask(t) {
  const prev = t.status;
  if (await save(t, { status: "dropped" })) {
    if (S.view === "task") { S.view = S.prev || "list"; render("back"); } else render();
    toast("Task removed", { label: "Undo", run: async () => { await save(t, { status: prev }); render(); } });
  }
}

// ---------- one task: slides in, saves as you go ----------
let taskOpts = {};
function openTask(id, opts = {}) { taskOpts = opts; S.prev = S.view === "task" ? S.prev : S.view; S.taskId = id; S.view = "task"; render("fwd"); toTop(); }
function taskHTML() {
  const t = byId(S.taskId);
  if (!t) return `${backBar()}<p class="muted td-pad">This task isn't there any more.</p>`;
  const pre = presetOf(t), status = taskOpts.partial ? "partial" : t.status === "dropped" ? "open" : t.status;
  const whenChip = (k, label) => `<button type="button" class="td-chip${pre === k ? " on" : ""}" data-when="${k}">${label}</button>`;
  const prevName = { list: "To-do", recap: "Recap", plan: "Your week" }[S.prev] ?? "Back";
  return `${backBar(prevName, '<span class="td-saved" id="td-saved" aria-live="polite"></span>')}
    <div class="td-task">
      <textarea class="td-task-title" id="tt-title" rows="1" maxlength="300" aria-label="Task">${esc(t.title)}</textarea>
      <section class="td-field"><h3>Focus area</h3>
        <div class="td-chips">${S.areas.map((a) => `<button type="button" class="td-chip area${t.area_id === a.id ? " on" : ""}" data-area="${esc(a.id)}">${badge(a)}${esc(a.name)}</button>`).join("")}
          <button type="button" class="td-chip${!t.area_id ? " on" : ""}" data-area="">None</button>
          ${S.areas.length <= 1 ? '<button type="button" class="td-chip ghost" data-setup>Set up focus areas</button>' : ""}</div></section>
      <section class="td-field"><h3>When</h3>
        <div class="td-chips">${whenChip("none", "No date")}${whenChip("today", "Today · EOD")}${whenChip("tomorrow", "Tomorrow")}${whenChip("eow", "EOW")}${whenChip("week", "This week")}${whenChip("next", "Next week")}${whenChip("day", pre === "day" && t.due_date ? `${fmtWd(t.due_date)} ${fmtDay(t.due_date)}` : "Pick a day")}</div>
        <div class="td-when-more${pre === "day" || t.due_date ? " show" : ""}"><div>
          <label class="td-inline${pre === "day" ? "" : " hide"}" id="tt-day-l">Day <input type="date" id="tt-day" value="${esc(t.due_date ?? "")}"></label>
          <label class="td-inline" id="tt-time-l">Time <input type="time" id="tt-time" value="${esc(t.due_time ? String(t.due_time).slice(0, 5) : "")}"></label>
          <span class="td-hint-inline">optional</span>
        </div></div></section>
      <section class="td-field td-switch-row"><div><h3>Urgent</h3><p>Shows at the top and in the Friday check.</p></div>
        <button type="button" class="td-switch${t.urgent ? " on" : ""}" id="tt-urgent" role="switch" aria-checked="${t.urgent}" aria-label="Urgent"><i></i></button></section>
      <section class="td-field"><h3>Status</h3>
        <div class="td-seg" role="radiogroup" aria-label="Status">${[["open", "To do"], ["partial", "Partly done"], ["done", "Done"]].map(([k, l]) => `<button type="button" role="radio" aria-checked="${status === k}" class="${status === k ? "on" : ""}" data-status="${k}">${l}</button>`).join("")}<i class="td-seg-pill"></i></div>
        <div class="td-reveal${status === "partial" ? " show" : ""}" id="tt-rem-w"><div><input id="tt-rem" maxlength="1000" placeholder="What's still left?" value="${esc(t.remaining ?? "")}"></div></div></section>
      <section class="td-field"><h3>Project or client</h3><input id="tt-proj" maxlength="80" placeholder="e.g. Sydney FC" value="${esc(t.project ?? "")}"></section>
      <section class="td-field"><h3>Notes</h3><textarea id="tt-notes" rows="3" maxlength="4000" placeholder="Anything to remember">${esc(t.notes ?? "")}</textarea></section>
      ${t.follows_id && byId(t.follows_id) ? `<p class="td-follows">Follows “${esc(byId(t.follows_id).title)}”</p>` : ""}
      <button type="button" class="td-remove" id="tt-drop">Remove task</button>
    </div>`;
}
function wireTask() {
  const t = byId(S.taskId);
  const $ = (id) => document.getElementById(id);
  let timer = null, pending = {};
  const saved = () => { const s = $("td-saved"); if (!s) return; s.textContent = "Saved"; s.classList.add("show"); clearTimeout(s._t); s._t = setTimeout(() => s.classList.remove("show"), 1400); };
  const flush = async () => { clearTimeout(timer); if (!Object.keys(pending).length) return; const p = pending; pending = {}; if (await save(t, p)) saved(); };
  const later = (patch) => { Object.assign(pending, patch); clearTimeout(timer); timer = setTimeout(flush, 650); };
  const now = async (patch) => { Object.assign(pending, patch); await flush(); };
  const back = async () => { await flush(); taskOpts = {}; S.view = S.prev || "list"; render("back"); toTop(); };
  wireCommon(back);
  if (!t) return;
  const title = $("tt-title"); grow(title);
  title.oninput = () => { if (title.value.trim()) later({ title: title.value.trim() }); };
  title.onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); title.blur(); } };
  root.querySelectorAll("[data-area]").forEach((b) => (b.onclick = () => {
    root.querySelectorAll("[data-area]").forEach((x) => x.classList.toggle("on", x === b));
    now({ area_id: b.dataset.area || null });
  }));
  root.querySelector("[data-setup]")?.addEventListener("click", async () => { await flush(); startSetup(true); });
  const more = root.querySelector(".td-when-more");
  root.querySelectorAll("[data-when]").forEach((b) => (b.onclick = () => {
    const k = b.dataset.when;
    root.querySelectorAll("[data-when]").forEach((x) => x.classList.toggle("on", x === b));
    $("tt-day-l").classList.toggle("hide", k !== "day");
    more.classList.toggle("show", k !== "none");
    if (k === "day") { if (!$("tt-day").value) $("tt-day").value = addDays(cph().date, 2); b.textContent = `${fmtWd($("tt-day").value)} ${fmtDay($("tt-day").value)}`; try { $("tt-day").showPicker?.(); } catch { /* not supported */ } now({ ...whenPreset("day", $("tt-day").value), due_time: $("tt-time").value || null }); return; }
    if (k === "none") { $("tt-time").value = ""; }
    now({ ...whenPreset(k), ...(k === "none" ? {} : { due_time: $("tt-time").value || null }) });
  }));
  $("tt-day").onchange = () => { if ($("tt-day").value) { root.querySelector('[data-when="day"]').textContent = `${fmtWd($("tt-day").value)} ${fmtDay($("tt-day").value)}`; now({ ...whenPreset("day", $("tt-day").value) }); } };
  $("tt-time").onchange = () => { const cur = byId(t.id); if (!cur?.due_date) { root.querySelectorAll("[data-when]").forEach((x) => x.classList.toggle("on", x.dataset.when === "today")); now({ ...whenPreset("today"), due_time: $("tt-time").value || null }); } else now({ due_time: $("tt-time").value || null }); };
  $("tt-urgent").onclick = () => { const on = !$("tt-urgent").classList.contains("on"); $("tt-urgent").classList.toggle("on", on); $("tt-urgent").setAttribute("aria-checked", on); now({ urgent: on }); };
  const seg = root.querySelector(".td-seg"), pill = seg.querySelector(".td-seg-pill");
  const place = () => { const on = seg.querySelector("button.on"); if (on) { pill.style.width = `${on.offsetWidth}px`; pill.style.transform = `translateX(${on.offsetLeft - 3}px)`; } };
  requestAnimationFrame(place);
  seg.querySelectorAll("[data-status]").forEach((b) => (b.onclick = () => {
    seg.querySelectorAll("[data-status]").forEach((x) => { x.classList.toggle("on", x === b); x.setAttribute("aria-checked", x === b); });
    place();
    const st = b.dataset.status;
    $("tt-rem-w").classList.toggle("show", st === "partial");
    if (st === "partial") setTimeout(() => $("tt-rem").focus(), 200);
    now({ status: st, ...(st === "partial" ? { remaining: $("tt-rem").value } : {}) });
  }));
  if (taskOpts.partial && t.status !== "partial") now({ status: "partial" });
  if (taskOpts.partial) setTimeout(() => $("tt-rem").focus(), 350);
  $("tt-rem").oninput = () => later({ remaining: $("tt-rem").value });
  $("tt-proj").oninput = () => later({ project: $("tt-proj").value });
  const notes = $("tt-notes"); grow(notes);
  notes.oninput = () => later({ notes: notes.value });
  $("tt-drop").onclick = async () => { await flush(); removeTask(byId(t.id)); };
}

// ---------- snap your notes ----------
async function shrink(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
    const scale = Math.min(1, 2000 / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement("canvas");
    c.width = Math.round(img.naturalWidth * scale); c.height = Math.round(img.naturalHeight * scale);
    c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL("image/jpeg", 0.85);
  } finally { URL.revokeObjectURL(url); }
}
async function snap(file) {
  if (!S.cfg?.ai) return toast("Reading photos needs the AI to be switched on.");
  S.snap = { loading: true };
  go("snap");
  try {
    const r = await api("snap", { image: await shrink(file), media_type: "image/jpeg" });
    if (S.view !== "snap") return;
    if (!r.items.length) { S.view = "list"; render("back"); return toast(r.unreadable?.length ? "Couldn't read any tasks. Try a closer, brighter photo." : "No tasks found in that photo."); }
    S.snap = { items: r.items.map((it) => ({ ...it, keep: !it.done, area_id: areaByCode(it.area)?.id ?? null })), unreadable: r.unreadable ?? [] };
    render("fade");
  } catch (e) { S.view = "list"; render("back"); toast(e.message || "That photo couldn't be read."); }
}
function snapHTML() {
  if (S.snap?.loading) return `${backBar("Cancel")}<div class="td-reading"><div class="td-scan">${I.camera}<i></i></div><h2>Reading your notes…</h2><p>Usually 10–20 seconds. The photo isn't saved.</p></div>`;
  const it = S.snap?.items ?? [];
  const k = it.filter((x) => x.keep).length;
  return `${backBar("Cancel")}
    <div class="td-flow-head"><div class="td-kicker">From your notes</div><h2>${it.length} task${it.length === 1 ? "" : "s"} found</h2>
      <p class="muted">Check them and fix anything that was misread. Crossed-out ones are left out.</p></div>
    <ul class="td-snap-list stagger">${it.map((x, i) => `<li class="${x.keep ? "" : "off"}" style="--i:${Math.min(i, 14)}">
      <button type="button" class="td-check${x.keep ? " on" : ""}" data-keep="${i}" aria-label="${x.keep ? "Leave out" : "Add"}">${I.check}</button>
      <div class="f"><input data-t="${i}" value="${esc(x.title)}" maxlength="300" aria-label="Task">
        <div class="row"><select data-a="${i}" aria-label="Focus area"><option value="">No area</option>${S.areas.map((a) => `<option value="${esc(a.id)}"${x.area_id === a.id ? " selected" : ""}>${esc(a.code)} · ${esc(a.name)}</option>`).join("")}</select>
          ${x.due_date ? `<span class="td-tag">${I.clock}${esc(whenLabel({ ...x, status: "open" })?.text ?? x.due_date)}</span>` : ""}${x.urgent ? `<span class="td-tag urgent">${I.flag}Urgent</span>` : ""}
          ${x.done ? '<span class="td-note">Crossed out</span>' : ""}${x.unsure ? '<span class="td-note">Hard to read</span>' : ""}</div>
        ${x.notes ? `<p class="td-notes">${esc(x.notes)}</p>` : ""}</div></li>`).join("")}</ul>
    ${S.snap.unreadable.length ? `<p class="small muted">Couldn't read: ${esc(S.snap.unreadable.join("; "))}</p>` : ""}
    <div class="td-flow-foot"><span></span><button type="button" class="primary" id="sn-add"${k ? "" : " disabled"}>Add ${k} task${k === 1 ? "" : "s"}</button></div>`;
}
function wireSnap() {
  wireCommon(() => { S.snap = null; S.view = "list"; render("back"); });
  if (S.snap?.loading) return;
  root.querySelectorAll("[data-keep]").forEach((b) => (b.onclick = () => { const x = S.snap.items[+b.dataset.keep]; x.keep = !x.keep; syncInputs(); render(); }));
  const syncInputs = () => root.querySelectorAll("[data-t]").forEach((inp) => { S.snap.items[+inp.dataset.t].title = inp.value; });
  root.querySelectorAll("[data-t]").forEach((inp) => (inp.oninput = () => { S.snap.items[+inp.dataset.t].title = inp.value; }));
  root.querySelectorAll("[data-a]").forEach((sel) => (sel.onchange = () => { S.snap.items[+sel.dataset.a].area_id = sel.value || null; }));
  document.getElementById("sn-add").onclick = async () => {
    syncInputs();
    const items = S.snap.items.filter((x) => x.keep && x.title.trim()).map(({ title, notes, project, due_date, due_kind, due_time, urgent, area_id }) => ({ title, notes, project, due_date, due_kind, due_time, urgent, area_id }));
    const r = await act(() => api("add_many", { source: "photo", items }), `${items.length} task${items.length === 1 ? "" : "s"} added from your notes`);
    if (r) { upsert(r.items); S.snap = null; S.view = "list"; render("back"); }
  };
}

// ---------- first open: focus areas and letters ----------
function startSetup(editing = false) {
  const custom = S.areas.filter((a) => !a.builtin);
  S.setup = { editing, step: editing ? 1 : 0, picked: custom.map((a) => ({ id: a.id, name: a.name, code: a.code, priority: a.priority ?? null })),
    mPrio: S.areas.find((a) => a.builtin)?.priority ?? null, err: "" };
  S.prev = S.view === "setup" ? S.prev : S.view;
  S.view = "setup"; render("fwd"); toTop();
}
function setupHTML() {
  const st = S.setup, step = st.step;
  const dots = `<div class="td-dots" aria-hidden="true">${[0, 1, 2, 3].map((i) => `<i class="${i === step ? "on" : i < step ? "past" : ""}"></i>`).join("")}</div>`;
  const top = st.editing || step > 0 ? backBar(step === 0 || (st.editing && step === 1) ? "To-do" : "Back") : `<div class="td-bar"><span class="td-sp"></span>${closeBtn()}</div>`;
  if (step === 0) return `${top}<div class="td-setup">${dots}
      <div class="td-hero">${ICON_TODO}</div>
      <h2>Your to-do, sorted your way</h2>
      <p>Group tasks by what they're about: your <b>focus areas</b>. Give each one a short letter, write it next to a task on paper, and when you snap your notes the to-do files it in the right place.</p>
      <div class="td-example"><span>${badge({ code: "S", builtin: false })} call Juventus about the preseason EOW</span><span>${badge({ code: "M", builtin: true })} catch-up with Ming Thu 14:00</span></div>
      <div class="td-setup-actions"><button type="button" class="primary" id="su-next">Set up my focus areas</button><button type="button" class="td-ghost-text" id="su-skip">Skip for now</button></div></div>`;
  if (step === 1) {
    const names = new Set(st.picked.map((p) => p.name.toLowerCase()));
    const offer = suggestions();
    const extra = st.picked.filter((p) => !offer.some((s) => s.toLowerCase() === p.name.toLowerCase()));
    return `${top}<div class="td-setup">${dots}
      <h2>What do you focus on?</h2>
      <p>Pick the areas your work falls into, or add your own. Meetings &amp; calls is there for everyone.</p>
      <div class="td-pick">
        <span class="td-pick-chip fixed">${badge({ code: "M", builtin: true })}Meetings &amp; calls</span>
        ${[...offer, ...extra.map((e) => e.name)].map((s) => `<button type="button" class="td-pick-chip${names.has(s.toLowerCase()) ? " on" : ""}" data-pick="${esc(s)}"><span class="td-tick">${I.check}</span>${esc(s)}</button>`).join("")}
      </div>
      <form class="td-own" id="su-own"><input id="su-own-in" maxlength="60" placeholder="Add your own, e.g. Live Marketing"><button type="submit" class="td-ghost-text">Add</button></form>
      <div class="td-setup-actions"><button type="button" class="primary" id="su-next"${st.picked.length ? "" : " disabled"}>Next</button>${st.editing ? "" : '<button type="button" class="td-ghost-text" id="su-skip">Skip for now</button>'}</div></div>`;
  }
  if (step === 2) {
    return `${top}<div class="td-setup">${dots}
      <h2>Letters and priorities</h2>
      <p>One to three letters you'd write next to a task, all different. The priority sets the order on the full page: priority 1 comes first, and areas with the same number sit side by side.</p>
      <ul class="td-letters">
        <li class="fixed">${badge({ code: "M", builtin: true }, true)}<span>Meetings &amp; calls</span>${prioSelect("m", st.mPrio, "Meetings & calls")}</li>
        ${st.picked.map((p, i) => `<li><input class="td-letter" data-code="${i}" value="${esc(p.code ?? "")}" maxlength="3" aria-label="Letter for ${esc(p.name)}" autocapitalize="characters" spellcheck="false"><span>${esc(p.name)}</span>${prioSelect(i, p.priority, p.name)}</li>`).join("")}
      </ul>
      <p class="td-err" id="su-err" aria-live="polite">${esc(st.err)}</p>
      <div class="td-paper"><span>On paper:</span> <b id="su-ex">${esc(st.picked[0]?.code || "S")} – ${esc(st.picked[0] ? `${st.picked[0].name.toLowerCase()} task` : "call Juventus")}</b></div>
      <div class="td-setup-actions"><button type="button" class="primary" id="su-next">Save</button></div></div>`;
  }
  return `${top.replace(/<button[^>]*data-back[^>]*>.*?<\/button>/s, "")}<div class="td-setup">${dots}
      <div class="td-hero done">${I.check}</div>
      <h2>You're set</h2>
      <p>Your letters:</p>
      <ul class="td-legend">${S.areas.map((a) => `<li>${badge(a, true)}<span>${esc(a.name)}</span>${a.priority ? `<em>Priority ${a.priority}</em>` : ""}</li>`).join("")}</ul>
      <p class="muted small">Change them any time from ⋯ → Focus areas &amp; letters.</p>
      <div class="td-setup-actions"><button type="button" class="primary" id="su-next">${st.editing ? "Back to my list" : "Start"}</button></div></div>`;
}
const prioSelect = (key, val, name) => `<select class="td-prio-sel" data-prio="${key}" aria-label="Priority for ${esc(name)}"><option value="">No priority</option>${PRIOS.map((n) => `<option value="${n}"${val === n ? " selected" : ""}>Priority ${n}</option>`).join("")}</select>`;
function validateLetters() {
  const st = S.setup, seen = new Set();
  for (const p of st.picked) {
    const c = (p.code ?? "").toUpperCase();
    if (!/^[A-Z]{1,3}$/.test(c)) return `Give “${p.name}” a letter (A–Z, up to 3).`;
    if (c === "M") return "M is taken by Meetings & calls.";
    if (seen.has(c)) return `“${c}” is used twice.`;
    seen.add(c);
  }
  return "";
}
function wireSetup() {
  const st = S.setup;
  const step = (n, dir) => { st.step = n; st.err = ""; render(dir); toTop(); };
  wireCommon(() => {
    if (st.step === 0 || (st.editing && st.step === 1)) { S.view = st.editing ? (S.prev === "setup" ? "list" : S.prev || "list") : "list"; render("back"); }
    else step(st.step - 1, "back");
  });
  const skip = document.getElementById("su-skip");
  if (skip) skip.onclick = async () => {
    const r = await act(() => api("areas_save", { areas: [] }));
    if (r) S.areas = r.areas;
    S.view = "list"; render("back");
  };
  const next = document.getElementById("su-next");
  if (st.step === 0) next.onclick = () => step(1, "fwd");
  if (st.step === 1) {
    root.querySelectorAll("[data-pick]").forEach((b) => (b.onclick = () => {
      const name = b.dataset.pick, i = st.picked.findIndex((p) => p.name.toLowerCase() === name.toLowerCase());
      if (i >= 0) st.picked.splice(i, 1); else st.picked.push({ name });
      b.classList.toggle("on", i < 0);
      next.disabled = !st.picked.length;
    }));
    document.getElementById("su-own").onsubmit = (e) => {
      e.preventDefault();
      const v = document.getElementById("su-own-in").value.trim();
      if (!v || st.picked.some((p) => p.name.toLowerCase() === v.toLowerCase())) return;
      st.picked.push({ name: v }); render("none");
      document.getElementById("su-own-in")?.focus();
    };
    next.onclick = () => {
      const taken = new Set(st.picked.map((p) => p.code).filter(Boolean));
      for (const p of st.picked) if (!p.code) { p.code = suggestCode(p.name, taken); taken.add(p.code); }
      step(2, "fwd");
    };
  }
  if (st.step === 2) {
    const ex = document.getElementById("su-ex"), err = document.getElementById("su-err");
    root.querySelectorAll("[data-code]").forEach((inp) => (inp.oninput = () => {
      inp.value = inp.value.toUpperCase().replace(/[^A-Z]/g, "");
      st.picked[+inp.dataset.code].code = inp.value;
      const p = st.picked[0]; ex.textContent = `${p.code || "?"} – ${p.name.toLowerCase()} task`;
      err.textContent = ""; inp.classList.remove("bad");
    }));
    root.querySelectorAll("[data-prio]").forEach((sel) => (sel.onchange = () => {
      const v = sel.value ? Number(sel.value) : null;
      if (sel.dataset.prio === "m") st.mPrio = v; else st.picked[+sel.dataset.prio].priority = v;
    }));
    next.onclick = async () => {
      const msg = validateLetters();
      if (msg) { err.textContent = msg; root.querySelectorAll("[data-code]").forEach((inp) => inp.classList.toggle("bad", !inp.value || inp.value === "M")); return; }
      next.disabled = true;
      const r = await act(() => api("areas_save", { areas: st.picked.map((p) => ({ id: p.id, code: p.code, name: p.name, priority: p.priority ?? null })), m_priority: st.mPrio }));
      next.disabled = false;
      if (!r) return;
      S.areas = r.areas; step(3, "fwd");
    };
  }
  if (st.step === 3) next.onclick = () => { S.view = "list"; S.filter = "all"; render("back"); toTop(); };
}

// ---------- Friday recap ----------
function openFlow(which, preview = false) {
  S.preview = preview; S.step = 0; S.proposal = null;
  S.view = which ?? (recapPending() ? "recap" : "plan");
  S.flowWeek = S.view === "recap" ? (preview ? mondayOf() : recapWeek()) : mondayOf();
  render("fwd"); toTop();
}
const RECAP_STEPS = [
  { key: "done", label: "Done", title: "Done and partly done", text: "What you finished this week, and what's partly there. Untick anything that isn't really done." },
  { key: "moving", label: "Moving", title: "Moved forward", text: "You worked on these but they're not finished yet. They carry over to next week." },
  { key: "urgent", label: "Urgent", title: "Needs an update before the weekend", text: "Urgent or due this week and still open. Finish them, push them to Monday, or say what happened." },
  { key: "untouched", label: "Not touched", title: "Not touched this week", text: "Nothing happened on these. Keep them for next week, or remove what's no longer needed." },
];
function recapGroups(week) {
  const start = cphMs(week), end = cphMs(addDays(week, 7)), sunday = addDays(week, 6);
  const g = { done: [], moving: [], urgent: [], untouched: [] };
  for (const t of S.items) {
    if (Date.parse(t.created_at) >= end) continue;
    if ((t.status === "done" && Date.parse(t.done_at ?? t.updated_at) >= start) || t.status === "partial") g.done.push(t);
    else if (t.status !== "open") continue;
    else if (t.urgent || (t.due_date && t.due_date <= sunday)) g.urgent.push(t);
    else if (Date.parse(t.touched_at) >= start && Date.parse(t.touched_at) - Date.parse(t.created_at) > 60000) g.moving.push(t);
    else g.untouched.push(t);
  }
  for (const k in g) g[k] = sortOpen(g[k]);
  return g;
}
const qaBtn = (k, l) => `<button type="button" class="td-qbtn" data-qa="${k}">${l}</button>`;
const RECAP_QA = {
  done: (t) => t.status === "done" ? qaBtn("reopen", "Not done") : qaBtn("done", "Done") + qaBtn("partial", "What's left?"),
  moving: () => qaBtn("done", "Done") + qaBtn("partial", "Partly done") + qaBtn("drop", "Remove"),
  urgent: () => qaBtn("done", "Done") + qaBtn("monday", "Push to Monday") + qaBtn("partial", "Partly done") + qaBtn("drop", "Remove"),
  untouched: () => qaBtn("done", "Done") + qaBtn("keep", "Keep") + qaBtn("drop", "Remove"),
};
function recapHTML() {
  const week = S.flowWeek, g = recapGroups(week), all = [...g.done, ...g.moving, ...g.urgent, ...g.untouched];
  const nOf = new Map(all.map((t, i) => [t.id, i + 1]));
  const last = S.step >= RECAP_STEPS.length;
  let body;
  if (!last) {
    const st = RECAP_STEPS[S.step], list = g[st.key];
    body = `<div class="td-step-intro"><h3>${st.title}</h3><p>${st.text}</p></div>
      ${list.length ? `<ul class="td-list stagger">${list.map((t) => rowHTML(t, nOf.get(t.id), { qa: RECAP_QA[st.key] })).join("")}</ul>` : '<div class="td-empty slim"><p>Nothing here.</p></div>'}
      ${aiHTML("e.g. “3 was done, but I still have to send the contract”")}`;
  } else {
    const done = g.done.filter((t) => t.status === "done").length, carry = all.filter(isOpen).length;
    body = `<div class="td-step-intro"><h3>Ready to close the week</h3><p>${carry ? `${carry} open task${carry === 1 ? "" : "s"} carry over to ${weekLabel(addDays(week, 7)).toLowerCase()}.` : "Nothing carries over. Clean slate."}</p></div>
      <div class="td-sum stagger"><div style="--i:0"><b>${done}</b><span>done</span></div><div style="--i:1"><b>${g.done.filter((t) => t.status === "partial").length}</b><span>partly done</span></div><div style="--i:2"><b>${carry}</b><span>carry over</span></div></div>`;
  }
  return `${backBar("To-do")}
    <div class="td-flow-head"><div class="td-kicker">Friday recap${S.preview ? " · preview" : ""}</div><h2>${weekLabel(week)}</h2>
      <div class="td-steps">${RECAP_STEPS.map((s, i) => `<button type="button" class="td-step${i === S.step ? " on" : i < S.step ? " past" : ""}" data-step="${i}"><i></i><span>${s.label} ${g[s.key].length}</span></button>`).join("")}</div></div>
    ${body}
    <div class="td-flow-foot">${S.step > 0 ? '<button type="button" class="td-ghost-text" id="td-prev">Back</button>' : "<span></span>"}
      ${last ? `<button type="button" class="primary" id="td-close">${S.preview ? "Finish preview" : "Close the week"}</button>` : `<button type="button" class="primary" id="td-next">${S.step === RECAP_STEPS.length - 1 ? "Finish" : "Next"}</button>`}</div>`;
}
function wireRecap() {
  wireCommon(); wireRows();
  const week = S.flowWeek, g = recapGroups(week);
  wireAI([...g.done, ...g.moving, ...g.urgent, ...g.untouched]);
  root.querySelectorAll("[data-step]").forEach((b) => (b.onclick = () => { const to = Number(b.dataset.step); const dir = to > S.step ? "fwd" : "back"; S.step = to; S.proposal = null; render(dir); }));
  document.getElementById("td-prev")?.addEventListener("click", () => { S.step--; S.proposal = null; render("back"); toTop(); });
  document.getElementById("td-next")?.addEventListener("click", () => { S.step++; S.proposal = null; render("fwd"); toTop(); });
  document.getElementById("td-close")?.addEventListener("click", async () => {
    if (S.preview) { S.view = "list"; render("back"); return toast("Preview finished. Nothing was carried over."); }
    const r = await act(() => api("close_week", { week }));
    if (!r) return;
    await load();
    S.view = "list"; render("back");
    toast(r.carried ? `Week closed. ${r.carried} task${r.carried === 1 ? "" : "s"} carried over.` : "Week closed.");
  });
}

// ---------- Monday overview ----------
function planHTML() {
  const week = S.flowWeek, start = cphMs(week);
  const carried = sortOpen(S.items.filter((t) => isOpen(t) && Date.parse(t.created_at) < start));
  const added = sortOpen(S.items.filter((t) => isOpen(t) && Date.parse(t.created_at) >= start));
  let n = 0;
  const qa = () => qaBtn("done", "Done") + qaBtn("urgent", "Urgent") + qaBtn("drop", "Remove");
  return `${backBar("To-do")}
    <div class="td-flow-head"><div class="td-kicker">Your week${S.preview ? " · preview" : ""}</div><h2>${weekLabel(week)}</h2>
      <p class="muted">${carried.length ? `${carried.length} task${carried.length === 1 ? "" : "s"} carried over from last week.` : "Nothing carried over from last week."}</p></div>
    ${carried.length ? `<h3 class="td-sec">Carried over<span>${carried.length}</span></h3><ul class="td-list stagger">${carried.map((t) => rowHTML(t, ++n, { qa })).join("")}</ul>` : ""}
    <h3 class="td-sec">Anything you didn't get to?</h3>
    <form class="td-compose" id="td-plan-add"><span class="td-compose-ico">${I.plus}</span><textarea id="td-plan-new" rows="1" placeholder="One per line, e.g. “S: call Juventus EOW”" aria-label="New tasks"></textarea><button type="submit" class="primary td-compose-go">Add</button></form>
    <p class="td-hint">Or <button type="button" class="td-link" id="td-plan-snap">snap a photo of your notes</button>.</p>
    ${added.length ? `<h3 class="td-sec">New this week<span>${added.length}</span></h3><ul class="td-list">${added.map((t) => rowHTML(t, ++n, { qa })).join("")}</ul>` : ""}
    <h3 class="td-sec">Popped up while you were away</h3>
    <div class="td-away stagger">
      <div class="td-away-tile" style="--i:0">${I.mail}<div><b>Unread emails that need you</b><span>Unread client emails from the weekend that look like they need an answer.</span></div><em>Soon</em></div>
      <div class="td-away-tile" style="--i:1">${I.cal}<div><b>Meeting requests waiting</b><span>Invites you haven't accepted or declined yet.</span></div><em>Soon</em></div>
      <div class="td-away-tile" style="--i:2">${I.reply}<div><b>Follow-ups</b><span>Threads where someone's waiting on you, or you on them.</span></div><em>Soon</em></div>
    </div>
    <p class="td-hint">These fill in once Gmail and Calendar are connected.</p>
    ${aiHTML("e.g. “2 is urgent, push 4 to Thursday”")}
    <div class="td-flow-foot"><span></span><button type="button" class="primary" id="td-start">${S.preview ? "Finish preview" : "Start the week"}</button></div>`;
}
function wirePlan() {
  wireCommon(); wireRows();
  const week = S.flowWeek, start = cphMs(week);
  wireAI(sortOpen(S.items.filter((t) => isOpen(t) && Date.parse(t.created_at) < start)).concat(sortOpen(S.items.filter((t) => isOpen(t) && Date.parse(t.created_at) >= start))));
  document.getElementById("td-plan-snap").onclick = () => { const f = Object.assign(document.createElement("input"), { type: "file", accept: "image/*" }); f.onchange = () => f.files?.[0] && snap(f.files[0]); f.click(); };
  document.getElementById("td-start").onclick = async () => {
    if (!S.preview) { const r = await act(() => api("plan_done", { week })); if (!r) return; S.weeks = S.weeks.filter((w) => w.week_start !== week).concat({ ...weekRow(week), week_start: week, plan_done_at: new Date().toISOString() }); }
    S.view = "list"; render("back"); toast(S.preview ? "Preview finished." : "Have a good week.");
  };
  const f = document.getElementById("td-plan-add"), input = document.getElementById("td-plan-new");
  grow(input);
  input.onkeydown = (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); f.requestSubmit(); } };
  f.onsubmit = async (e) => {
    e.preventDefault();
    const lines = input.value.split(/\n+/).map((s) => s.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").trim()).filter(Boolean);
    if (!lines.length) return;
    const r = await act(() => api("add_many", { source: "manual", items: lines.map(parseQuick) }), lines.length > 1 ? `${lines.length} tasks added` : "Added");
    if (r) { upsert(r.items); render(); document.getElementById("td-plan-new")?.focus(); }
  };
}

// ---------- private link for the phone ----------
function linkHTML() {
  const viaSession = S.cfg?.via === "session", links = S.links;
  return `${backBar("To-do")}
    <div class="td-flow-head"><div class="td-kicker">Your phone</div><h2>Private link</h2>
      <p class="muted">Opens your list with no sign-in. Anyone with the link can see and change your list, so keep it to yourself: send it to yourself, then add it to your phone's home screen.</p></div>
    ${S.linkFresh ? `<div class="td-card"><div class="td-linkbox"><input id="lk-url" readonly value="${esc(S.linkFresh)}" aria-label="Your private link"><button type="button" class="primary" id="lk-copy">Copy</button></div>
      <p class="small muted" style="margin:8px 0 0">Shown only this once. If you lose it, make a new one.</p></div>`
      : viaSession ? '<p><button type="button" class="primary" id="lk-new">Make a private link</button></p>' : '<p class="muted small">New links are made from a computer where you\'re signed in to Stellar OS.</p>'}
    <h3 class="td-sec">Links that work<span>${links ? links.length : ""}</span></h3>
    ${links == null ? '<p class="muted small">Loading…</p>' : links.length ? `<ul class="td-links">${links.map((l) => `<li><span>${esc(l.label)} · made ${esc(fmtDay(l.created_at.slice(0, 10)))}${l.last_used_at ? ` · last used ${esc(fmtDay(l.last_used_at.slice(0, 10)))}` : ""}</span>${viaSession ? `<button type="button" class="td-ghost-text" data-off="${esc(l.id)}">Switch off</button>` : ""}</li>`).join("")}</ul>` : '<p class="muted small">None yet.</p>'}`;
}
function wireLink() {
  wireCommon();
  if (S.links == null) api("link_list").then((r) => { S.links = r.links; if (S.view === "link") render(); }).catch(() => { S.links = []; if (S.view === "link") render(); });
  document.getElementById("lk-new")?.addEventListener("click", async () => {
    const r = await act(() => api("link_create", { label: "Phone" }));
    if (r?.key) { S.linkFresh = `${location.origin}${location.pathname.replace(/[^/]*$/, "")}todo.html#k=${r.key}`; S.links = null; render(); }
  });
  document.getElementById("lk-copy")?.addEventListener("click", async () => {
    const inp = document.getElementById("lk-url");
    try { await navigator.clipboard.writeText(inp.value); toast("Link copied"); } catch { inp.select(); toast("Select the link and copy it"); }
  });
  root.querySelectorAll("[data-off]").forEach((b) => (b.onclick = async () => {
    if (!(await confirmDialog({ title: "Switch this link off?", body: "Any device using it stops opening your list. Your tasks stay saved.", confirm: "Switch off" }))) return;
    await act(() => api("link_revoke", { id: b.dataset.off }), "Link switched off");
    S.links = null; render();
  }));
}

// ---------- start ----------
async function load() {
  const r = await api("load");
  S.items = r.items; S.weeks = r.weeks; S.areas = r.areas ?? [];
}
function locked(msg) {
  if (!HOST.standalone) { root.innerHTML = `<p class="muted td-pad">${esc(msg || "The to-do list isn't available right now.")}</p>`; return; }
  root.innerHTML = `<div class="td-locked td-view td-in-up">${ICON_TODO}<h1>Your to-do list</h1>
    <p class="muted">${esc(msg || "Open your private link, or sign in to Stellar OS in this browser.")}</p>
    <p><a class="btn" href="./">Open Stellar OS</a></p></div>`;
}
// What opens first: the first-time setup, then a waiting recap or week overview, else the list.
function firstView() {
  if (!S.areas.length) return startSetup(false);
  if (recapPending()) return openFlow("recap");
  if (planPending()) return openFlow("plan");
  S.view = "list"; render("up");
}
async function boot() {
  await setupAuth();
  if (!auth) return locked();
  try {
    S.cfg = await api("config");
    await load();
  } catch (e) {
    if (e.locked && auth.header === "x-todo-key") store.del(KEY_STORE);
    return locked(e.message);
  }
  const want = new URLSearchParams(location.search).get("open");
  if (want === "recap" || want === "plan") return openFlow(want, false);
  firstView();
}
// Close the "more" menu on a click outside it or Escape.
document.addEventListener("click", (e) => { const m = root?.querySelector(".td-menu[open]"); if (m && !m.contains(e.target)) m.open = false; });
document.addEventListener("keydown", (e) => { if (e.key === "Escape") root?.querySelector(".td-menu[open]")?.removeAttribute("open"); });
const quiet = () => !document.querySelector("dialog[open]") && !["TEXTAREA", "INPUT", "SELECT"].includes(document.activeElement?.tagName);

// ---------- todo.html: the page of its own ----------
if (document.body.classList.contains("td-page")) {
  root = document.getElementById("todo");
  // Keep the week button honest if the page stays open across Friday 17:00 or Monday 08:00.
  setInterval(() => { if (S.view === "list" && S.cfg && quiet()) render(); }, 5 * 60_000);
  // A private link opened in a tab that already shows this page.
  window.addEventListener("hashchange", () => { if (/[#&]k=/.test(location.hash)) boot(); });
  let wasWide = null;
  window.addEventListener("resize", () => { const w = isWide(); if (w !== wasWide && S.view === "list" && S.cfg && quiet()) render(); wasWide = w; });
  boot();
}

// ---------- Stellar OS: floating button + right-hand sidebar ----------
let os = null;   // { user, fab, drawer, close }
export async function mountTodoInOS(sb, user) {
  if (os?.user === user.id) return;
  unmountTodoInOS();
  const mine = { user: user.id };
  os = mine;
  HOST = { standalone: false, sb, scroller: null, onClose: null, onPending: null };
  await setupAuth();
  try { S.cfg = await api("config"); await load(); }
  catch { if (os === mine) os = { user: user.id, off: true }; return; }   // not in the beta (or offline): no button
  if (os !== mine) return;

  const fab = document.createElement("button");
  fab.type = "button"; fab.className = "td-fab"; fab.title = "To-do";
  fab.setAttribute("aria-label", "To-do list"); fab.setAttribute("aria-haspopup", "dialog");
  fab.innerHTML = `${ICON_TODO}<i class="td-dot" aria-hidden="true"></i>`;
  const drawer = document.createElement("div");
  drawer.className = "td-drawer"; drawer.hidden = true;
  drawer.innerHTML = `<div class="td-drawer-back"></div><aside class="td-drawer-panel" role="dialog" aria-modal="false" aria-label="To-do list" tabindex="-1"><div class="td-panel td-side"></div></aside>`;
  document.body.append(fab, drawer);
  document.body.classList.add("has-todo");
  const panel = drawer.querySelector(".td-drawer-panel");
  root = drawer.querySelector(".td-panel");

  let closing;
  const isOpenNow = () => !drawer.hidden && drawer.classList.contains("in");
  const close = () => {
    if (drawer.hidden) return;
    drawer.classList.remove("in"); fab.setAttribute("aria-expanded", "false"); fab.classList.remove("hide");
    clearTimeout(closing); closing = setTimeout(() => { drawer.hidden = true; }, 300);
    fab.focus({ preventScroll: true });
  };
  const open = async () => {
    clearTimeout(closing);
    drawer.hidden = false; fab.setAttribute("aria-expanded", "true"); fab.classList.add("hide");
    if (!root.firstChild) root.innerHTML = '<p class="muted td-pad">Loading…</p>';
    requestAnimationFrame(() => drawer.classList.add("in"));
    try { await load(); } catch { /* show what we have */ }
    if (S.view === "task" || S.view === "setup" || S.view === "snap" || S.view === "link") { render(); }   // carry on where you were
    else firstView();
    panel.focus({ preventScroll: true });
  };
  HOST.scroller = panel;
  HOST.onClose = close;
  HOST.onPending = (p) => {
    fab.classList.toggle("pending", p);
    fab.setAttribute("aria-label", p ? (recapPending() ? "To-do list: your Friday recap is ready" : "To-do list: your week overview is ready") : "To-do list");
  };
  fab.onclick = () => (isOpenNow() ? close() : open());
  drawer.querySelector(".td-drawer-back").onclick = close;
  const onKey = (e) => {
    if (e.key !== "Escape" || !isOpenNow() || document.querySelector("dialog[open], .dlg-back") || root.querySelector(".td-menu[open]")) return;
    if (S.view !== "list" && root.querySelector("[data-back]")) root.querySelector("[data-back]").click();   // Escape steps back first
    else close();
  };
  document.addEventListener("keydown", onKey);
  // The dot appears by itself at Friday 17:00 / Monday 08:00 even if nobody opens the list.
  const tick = setInterval(async () => {
    if (isOpenNow()) { if (S.view === "list" && quiet()) render(); return; }
    try { await load(); } catch { /* keep the last state */ }
    HOST.onPending?.(recapPending() || planPending());
  }, 10 * 60_000);
  HOST.onPending(recapPending() || planPending());
  os = { user: user.id, fab, drawer, close, open, cleanup: () => { document.removeEventListener("keydown", onKey); clearInterval(tick); } };
}
export function unmountTodoInOS() {
  if (!os) return;
  os.cleanup?.(); os.fab?.remove(); os.drawer?.remove();
  document.body.classList.remove("has-todo");
  os = null; root = null; S.items = []; S.weeks = []; S.areas = []; S.view = "list"; auth = null;
}
// Lets other parts of the OS open the list (e.g. a link to the Friday recap later).
export const openTodo = () => os?.open?.();
