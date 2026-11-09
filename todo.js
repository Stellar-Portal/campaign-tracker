// Personal to-do list (beta). A separate page for now (todo.html); later it moves into Stellar OS as the
// floating to-do button + right-hand sidebar, so everything renders into one panel element.
// Access: a private link (todo.html#k=<key>, kept in this browser) or the Stellar OS session in this browser.
// Weeks run Monday to Sunday, Copenhagen time. The Friday recap opens from 17:00 on Friday; the week overview
// from 08:00 on Monday. Both light up the week button with a pulsing blue dot until they're gone through.
import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from "./config.js?v=20261109a";
import { confirmDialog } from "./dialog.js?v=20261109a";

const FN = `${SUPABASE_URL}/functions/v1/todo`;
const KEY_STORE = "stellar-todo-key";
const root = document.getElementById("todo");
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const store = { get(k) { try { return localStorage.getItem(k); } catch { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } }, del(k) { try { localStorage.removeItem(k); } catch { /* */ } } };

// ---------- icons (OS line style) ----------
const svg = (body, cls = "td-ico") => `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true">${body}</svg>`;
export const ICON_TODO = svg('<rect x="4.5" y="4" width="15" height="17.5" rx="3"/><path d="M9 4V3.2C9 2.5 9.5 2 10.2 2h3.6c.7 0 1.2.5 1.2 1.2V4M7.8 10.2l1.4 1.4 2.6-2.6M13.6 10.6h2.6M13.6 15.8h2.6"/><circle cx="9.4" cy="15.8" r="1.3"/>');
const I = {
  camera: svg('<path d="M4 8.5A2.5 2.5 0 0 1 6.5 6h1.3l1.4-2h5.6l1.4 2h1.3A2.5 2.5 0 0 1 20 8.5v8a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 16.5z"/><circle cx="12" cy="12.5" r="3.4"/>'),
  week: svg('<rect x="3.5" y="5" width="17" height="15" rx="3"/><path d="M3.5 10h17M8 3v4M16 3v4M8 14h2M14 14h2"/>'),
  more: svg('<circle cx="5.5" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="18.5" cy="12" r="1.2"/>'),
  spark: svg('<path d="M12 3.5l1.7 4.8 4.8 1.7-4.8 1.7L12 16.5l-1.7-4.8L5.5 10l4.8-1.7zM18.5 15.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z"/>'),
  mail: svg('<rect x="3.5" y="5.5" width="17" height="13" rx="2.5"/><path d="m4.5 7 7.5 6 7.5-6"/>'),
  cal: svg('<rect x="3.5" y="5" width="17" height="15" rx="3"/><path d="M3.5 10h17M8 3v4M16 3v4"/>'),
  reply: svg('<path d="M10 7 5 12l5 5"/><path d="M5.5 12H14a5 5 0 0 1 5 5v1"/>'),
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
// The moment a Copenhagen wall-clock time happens, as a timestamp.
function cphMs(date, hour = 0) {
  const guess = Date.parse(`${date}T${String(hour).padStart(2, "0")}:00:00Z`);
  const c = cph(new Date(guess));
  const shown = Date.parse(`${c.date}T${String(c.hour).padStart(2, "0")}:${String(c.min).padStart(2, "0")}:00Z`);
  return guess - (shown - guess);
}
const fmtDay = (date) => new Date(`${date}T12:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
const weekLabel = (monday) => `Week of ${fmtDay(monday)}`;
function dueLabel(due) {
  if (!due) return "";
  const t = cph().date, diff = Math.round((Date.parse(due) - Date.parse(t)) / 86400000);
  if (diff < 0) return { text: diff === -1 ? "Was due yesterday" : `Was due ${fmtDay(due)}`, late: true };
  if (diff === 0) return { text: "Due today", late: false };
  if (diff === 1) return { text: "Due tomorrow", late: false };
  if (diff < 7) return { text: `Due ${new Date(`${due}T12:00:00Z`).toLocaleDateString("en-GB", { weekday: "long", timeZone: "UTC" })}`, late: false };
  return { text: `Due ${fmtDay(due)}`, late: false };
}

// ---------- talking to the server ----------
let auth = null;   // { header, value }
async function setupAuth() {
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
  if (auth) headers[auth.header] = auth.value;
  const r = await fetch(FN, { method: "POST", headers, body: JSON.stringify({ action, ...body }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(j.error || "Something went wrong. Please try again."); e.locked = !!j.locked; throw e; }
  return j;
}

// ---------- state ----------
const S = { items: [], weeks: [], cfg: null, view: "list", step: 0, preview: false, flowWeek: null, proposal: null, aiBusy: false };
const byId = (id) => S.items.find((x) => x.id === id);
const weekRow = (w) => S.weeks.find((x) => x.week_start === w) ?? {};
const isOpen = (t) => t.status === "open" || t.status === "partial";
function upsert(rows) { for (const r of [].concat(rows || [])) { const i = S.items.findIndex((x) => x.id === r.id); if (i >= 0) S.items[i] = r; else S.items.push(r); } }

function toast(msg) {
  document.querySelector(".td-toast")?.remove();
  const t = document.createElement("div"); t.className = "td-toast"; t.setAttribute("role", "status"); t.textContent = msg;
  document.body.append(t); setTimeout(() => t.remove(), 3200);
}
async function act(fn, okMsg) {
  try { const r = await fn(); if (okMsg) toast(okMsg); return r; }
  catch (e) { toast(e.message); if (e.locked) return boot(); return null; }
}

// Order of the main list: urgent, then by due date, then as added. Numbers follow this order (the AI box uses them).
function sortOpen(list) {
  return [...list].sort((a, b) => (b.urgent - a.urgent) || ((a.due_date ?? "9999") < (b.due_date ?? "9999") ? -1 : (a.due_date ?? "9999") > (b.due_date ?? "9999") ? 1 : 0) || (a.position - b.position));
}

// ---------- the week button: Friday recap / Monday overview ----------
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

// ---------- rendering ----------
function render() {
  if (S.view === "recap") return renderRecap();
  if (S.view === "plan") return renderPlan();
  renderList();
}

function headHTML() {
  const rp = recapPending(), pp = planPending(), pending = rp || pp;
  const label = rp ? "Friday recap" : pp ? "Your week" : "Week";
  return `<header class="td-head">
    <h1 class="td-title">${ICON_TODO}To-do <span class="td-beta">Beta</span></h1>
    <span class="td-sp"></span>
    <button type="button" class="td-iconbtn td-week${pending ? " pending" : ""}" id="td-week" aria-label="${pending ? `${label} is ready` : "Week overview"}">${I.week}<span class="td-hide-sm">${label}</span>${pending ? '<i class="td-dot" aria-hidden="true"></i>' : ""}</button>
    <button type="button" class="td-iconbtn" id="td-snap" title="Turn a photo of your notes into tasks" aria-label="Snap your notes">${I.camera}<span class="td-hide-sm">Snap notes</span></button>
    <details class="td-menu"><summary class="btn td-iconbtn" aria-label="More">${I.more}</summary><div class="td-menu-pop">
      <button type="button" data-m="link">Private link for your phone</button>
      <button type="button" data-m="recap">Try the Friday recap now</button>
      <button type="button" data-m="plan">Try the Monday overview now</button>
      ${auth?.header === "x-todo-key" ? '<button type="button" data-m="forget">Forget this device</button>' : ""}
    </div></details>
  </header>
  <input type="file" id="td-file" accept="image/*" hidden>`;
}
function wireHead() {
  document.getElementById("td-week").onclick = () => openFlow();
  document.getElementById("td-snap").onclick = () => document.getElementById("td-file").click();
  document.getElementById("td-file").onchange = (e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) snap(f); };
  const menu = root.querySelector(".td-menu");
  menu.querySelectorAll("[data-m]").forEach((b) => (b.onclick = () => {
    menu.open = false;
    const m = b.dataset.m;
    if (m === "link") linkDialog();
    if (m === "recap") openFlow("recap", true);
    if (m === "plan") openFlow("plan", true);
    if (m === "forget") confirmDialog({ title: "Forget this device?", body: "This browser stops opening your list. Your tasks stay saved, and your private link still works on other devices.", confirm: "Forget" })
      .then((ok) => { if (ok) { store.del(KEY_STORE); boot(); } });
  }));
}

function itemHTML(t, n, opts = {}) {
  const due = dueLabel(t.due_date);
  const chips = [
    t.urgent && isOpen(t) ? '<span class="td-chip urgent">Urgent</span>' : "",
    t.status === "partial" ? `<span class="td-chip part">Partly done${t.remaining ? ` · left: ${esc(t.remaining)}` : ""}</span>` : "",
    due && isOpen(t) ? `<span class="td-chip${due.late ? " late" : ""}">${esc(due.text)}</span>` : "",
    t.project ? `<span class="td-chip proj">${esc(t.project)}</span>` : "",
    t.follows_id && byId(t.follows_id) ? `<span class="td-chip">Follows “${esc(byId(t.follows_id).title)}”</span>` : "",
  ].join("");
  const state = t.status === "done" ? "on" : t.status === "partial" ? "half" : "";
  return `<li class="td-item${t.status === "done" ? " done" : ""}" data-id="${esc(t.id)}">
    <button type="button" class="td-check ${state}" data-toggle aria-label="${t.status === "done" ? "Mark as not done" : "Mark as done"}: ${esc(t.title)}">${I.check}</button>
    ${n ? `<span class="td-num">${n}</span>` : ""}
    <div class="td-body" data-edit tabindex="0" role="button" aria-label="Edit ${esc(t.title)}">
      <div class="td-t">${esc(t.title)}</div>
      ${chips ? `<div class="td-meta">${chips}</div>` : ""}
      ${t.notes ? `<p class="td-notes">${esc(t.notes)}</p>` : ""}
      ${opts.qa ? `<div class="td-qa">${opts.qa(t)}</div>` : ""}
    </div></li>`;
}
function wireItems(scope) {
  scope.querySelectorAll(".td-item").forEach((li) => {
    const t = byId(li.dataset.id);
    li.querySelector("[data-toggle]").onclick = () => setStatus(t, t.status === "done" ? "open" : "done");
    const body = li.querySelector("[data-edit]");
    body.onclick = (e) => { if (!e.target.closest("button")) editDialog(t); };
    body.onkeydown = (e) => { if ((e.key === "Enter" || e.key === " ") && e.target === body) { e.preventDefault(); editDialog(t); } };
    li.querySelectorAll("[data-qa]").forEach((b) => (b.onclick = (e) => { e.stopPropagation(); quick(t, b.dataset.qa); }));
  });
}

function aiHTML(placeholder) {
  return `<section class="td-card">
    <p class="td-ai-label">${I.spark}Tell me what changed</p>
    <form class="td-ai" id="td-ai-form"><textarea id="td-ai-in" rows="1" placeholder="${esc(placeholder)}" ${S.cfg?.ai ? "" : "disabled"}></textarea>
      <button type="submit" class="primary" ${S.cfg?.ai ? "" : "disabled"}>Update</button></form>
    ${S.cfg?.ai ? "" : '<p class="small muted" style="margin:8px 0 0">The AI isn\'t switched on yet. Your tasks work without it.</p>'}
    <div id="td-prop"></div></section>`;
}
function wireAI(numbered) {
  const f = document.getElementById("td-ai-form"), input = document.getElementById("td-ai-in");
  if (!f) return;
  grow(input);
  input.onkeydown = (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); f.requestSubmit(); } };
  f.onsubmit = async (e) => {
    e.preventDefault();
    const prompt = input.value.trim();
    if (!prompt || S.aiBusy) return;
    S.aiBusy = true;
    const box = document.getElementById("td-prop");
    box.innerHTML = `<div class="td-prop"><p class="muted small">Working it out…</p></div>`;
    const r = await act(() => api("ai", { prompt, tasks: numbered.map((t, i) => ({ n: i + 1, id: t.id })) }));
    S.aiBusy = false;
    if (!r) { box.innerHTML = ""; return; }
    S.proposal = r;
    input.value = "";
    showProposal(box);
  };
}
const OP_WORD = { done: "Done", partial: "Partly done", reopen: "Not done", update: "Change", add: "New task", drop: "Remove" };
function opText(o) {
  if (o.op === "add") return `${esc(o.title)}${o.follows_title ? ` <span class="muted">(follows “${esc(o.follows_title)}”)</span>` : ""}${o.due_date ? ` · due ${esc(fmtDay(o.due_date))}` : ""}`;
  const bits = [];
  if (o.op === "partial" && o.remaining) bits.push(`left: ${esc(o.remaining)}`);
  if (o.op === "update") {
    if (o.title) bits.push(`title → ${esc(o.title)}`);
    if (o.due_date) bits.push(`due ${esc(fmtDay(o.due_date))}`);
    if (o.urgent != null) bits.push(o.urgent ? "urgent" : "not urgent");
    if (o.project) bits.push(`project ${esc(o.project)}`);
    if (o.notes) bits.push("notes updated");
  }
  return `${esc(o.current)}${bits.length ? ` <span class="muted">· ${bits.join(" · ")}</span>` : ""}`;
}
function showProposal(box) {
  const p = S.proposal;
  if (!p.ops.length) { box.innerHTML = `<div class="td-prop"><p>${esc(p.reply || "Nothing to change.")}</p></div>`; return; }
  box.innerHTML = `<div class="td-prop"><p>${esc(p.reply)}</p>
    <ul>${p.ops.map((o, i) => `<li><label><input type="checkbox" data-op="${i}" checked><span><span class="td-op">${OP_WORD[o.op] ?? o.op}:</span> ${opText(o)}</span></label></li>`).join("")}</ul>
    <div class="td-row-actions"><button type="button" class="primary" id="td-apply">Apply</button><button type="button" id="td-cancel">Cancel</button></div></div>`;
  box.querySelector("#td-cancel").onclick = () => { S.proposal = null; box.innerHTML = ""; };
  box.querySelector("#td-apply").onclick = async () => {
    const ops = p.ops.filter((_, i) => box.querySelector(`[data-op="${i}"]`).checked);
    const r = await act(() => api("apply", { ops }), ops.length ? "List updated" : null);
    if (r) { upsert(r.items); S.proposal = null; render(); }
  };
}
const grow = (ta) => { const f = () => { ta.style.height = "auto"; ta.style.height = `${Math.min(ta.scrollHeight, 160)}px`; }; ta.addEventListener("input", f); f(); };

function renderList() {
  const week = mondayOf(), weekStartMs = cphMs(week), sundayEnd = addDays(week, 6);
  const open = sortOpen(S.items.filter(isOpen));
  const urgent = open.filter((t) => t.urgent || (t.due_date && t.due_date < cph().date));
  const later = open.filter((t) => !urgent.includes(t) && t.due_date && t.due_date > sundayEnd);
  const now = open.filter((t) => !urgent.includes(t) && !later.includes(t));
  const numbered = [...urgent, ...now, ...later];
  const done = S.items.filter((t) => t.status === "done" && Date.parse(t.done_at ?? t.updated_at) >= weekStartMs).sort((a, b) => Date.parse(b.done_at) - Date.parse(a.done_at));
  let n = 0;
  const group = (title, list) => list.length ? `<h2 class="td-sec">${title} <span class="n">${list.length}</span></h2><ul class="td-list">${list.map((t) => itemHTML(t, ++n)).join("")}</ul>` : "";
  root.innerHTML = `${headHTML()}
    <p class="td-sub">${weekLabel(week)} · ${open.length} open · ${done.length} done this week</p>
    <section class="td-card"><form class="td-add" id="td-add"><textarea id="td-new" rows="1" placeholder="Add a task. Paste several lines to add them all." aria-label="New task"></textarea><button type="submit" class="primary">Add</button></form></section>
    ${aiHTML("e.g. “1 is done, but I still have to send the invoice”")}
    ${open.length ? group("Urgent", urgent) + group("This week", now) + group("Later", later) : `<div class="td-empty">Nothing on your list. Add a task, or snap a photo of your notepad.</div>`}
    ${done.length ? `<details class="td-done-toggle"><summary>Done this week (${done.length})</summary><ul class="td-list">${done.map((t) => itemHTML(t, 0)).join("")}</ul></details>` : ""}`;
  wireHead(); wireItems(root); wireAI(numbered); wireAdd();
}
function wireAdd(formId = "td-add", inputId = "td-new") {
  const f = document.getElementById(formId), input = document.getElementById(inputId);
  if (!f) return;
  grow(input);
  input.onkeydown = (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); f.requestSubmit(); } };
  f.onsubmit = async (e) => {
    e.preventDefault();
    const lines = input.value.split(/\n+/).map((s) => s.replace(/^\s*(?:[-*•]|\d+[.)]|\[ ?\])\s*/, "").trim()).filter(Boolean);
    if (!lines.length) return;
    const r = await act(() => api("add_many", { source: "manual", items: lines.map((title) => ({ title: title.slice(0, 300) })) }), lines.length > 1 ? `${lines.length} tasks added` : null);
    if (r) { upsert(r.items); input.value = ""; render(); document.getElementById(inputId)?.focus(); }
  };
}

// ---------- changing tasks ----------
async function save(t, patch, msg) {
  const r = await act(() => api("save", { item: { id: t.id, ...patch } }), msg);
  if (r?.item) { upsert(r.item); render(); }
}
const setStatus = (t, status) => save(t, { status });
async function quick(t, what) {
  if (what === "done") return setStatus(t, "done");
  if (what === "reopen") return setStatus(t, "open");
  if (what === "keep") return save(t, { urgent: false }, "Kept for next week");
  if (what === "partial") return editDialog(t, { partial: true });
  if (what === "drop") return save(t, { status: "dropped" }, "Removed");
  if (what === "monday") return save(t, { due_date: addDays(mondayOf(), 7), urgent: false }, "Moved to Monday");
  if (what === "urgent") return save(t, { urgent: !t.urgent });
}

function editDialog(t, opts = {}) {
  const d = document.createElement("dialog");
  d.className = "po-dialog td-dialog";
  const status = opts.partial ? "partial" : t.status === "dropped" ? "open" : t.status;
  d.innerHTML = `<form method="dialog" novalidate><h2>${opts.partial ? "Partly done" : "Edit task"}</h2>
    <div class="td-form">
      <label class="wide" for="te-title">Task<input id="te-title" value="${esc(t.title)}" maxlength="300" required></label>
      <label for="te-status">Status<select id="te-status"><option value="open"${status === "open" ? " selected" : ""}>Not started / in progress</option><option value="partial"${status === "partial" ? " selected" : ""}>Partly done</option><option value="done"${status === "done" ? " selected" : ""}>Done</option></select></label>
      <label for="te-due">Due<input id="te-due" type="date" value="${esc(t.due_date ?? "")}"></label>
      <label class="wide" for="te-rem" id="te-rem-l"${status === "partial" ? "" : " hidden"}>What's still left?<input id="te-rem" value="${esc(t.remaining ?? "")}" maxlength="1000" placeholder="e.g. send the final invoice"></label>
      <label for="te-proj">Project or client<input id="te-proj" value="${esc(t.project ?? "")}" maxlength="80" placeholder="e.g. Sydney FC"></label>
      <label class="check" style="align-self:end"><input type="checkbox" id="te-urgent"${t.urgent ? " checked" : ""}> Urgent</label>
      <label class="wide" for="te-notes">Notes<textarea id="te-notes" rows="3" maxlength="4000">${esc(t.notes ?? "")}</textarea></label>
    </div>
    <p class="small error" id="te-err" hidden></p>
    <div class="actions"><button type="submit" class="primary">Save</button><button type="button" id="te-cancel">Cancel</button><span class="td-sp"></span><button type="button" id="te-drop">Remove task</button></div></form>`;
  document.body.append(d);
  const $ = (id) => d.querySelector(`#${id}`);
  $("te-status").onchange = () => { $("te-rem-l").hidden = $("te-status").value !== "partial"; };
  $("te-cancel").onclick = () => d.close();
  $("te-drop").onclick = async () => { d.close(); await save(t, { status: "dropped" }, "Removed"); };
  d.querySelector("form").onsubmit = async (e) => {
    e.preventDefault();
    const title = $("te-title").value.trim();
    if (!title) { $("te-err").textContent = "Give the task a title."; $("te-err").hidden = false; return; }
    d.close();
    await save(t, { title, status: $("te-status").value, due_date: $("te-due").value || null, remaining: $("te-status").value === "partial" ? $("te-rem").value : null,
      project: $("te-proj").value, urgent: $("te-urgent").checked, notes: $("te-notes").value });
  };
  d.addEventListener("close", () => setTimeout(() => d.remove(), 0));
  d.addEventListener("click", (e) => { if (e.target === d) d.close(); });
  d.showModal();
  if (opts.partial) $("te-rem").focus();
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
  const d = document.createElement("dialog");
  d.className = "po-dialog td-dialog";
  d.innerHTML = `<div style="text-align:center;padding:12px 0"><div class="td-spin"></div><b>Reading your notes…</b><p class="small muted" style="margin:6px 0 0">This takes about 10–20 seconds. The photo isn't saved.</p></div>`;
  document.body.append(d);
  d.addEventListener("close", () => setTimeout(() => d.remove(), 0));
  d.showModal();
  let r;
  try { r = await api("snap", { image: await shrink(file), media_type: "image/jpeg" }); }
  catch (e) { d.close(); return toast(e.message || "That photo couldn't be read."); }
  if (!r.items.length) { d.close(); return toast(r.unreadable?.length ? "Couldn't read any tasks in that photo. Try a closer, brighter one." : "No tasks found in that photo."); }
  d.innerHTML = `<form method="dialog"><h2>${r.items.length} task${r.items.length === 1 ? "" : "s"} from your notes</h2>
    <p class="small muted" style="margin:-6px 0 0">Check them and fix anything that was misread. Crossed-out items are unticked.</p>
    <ul class="td-snap-list">${r.items.map((it, i) => `<li><input type="checkbox" data-i="${i}" ${it.done ? "" : "checked"} aria-label="Add this task">
      <div class="f"><input data-t="${i}" value="${esc(it.title)}" maxlength="300" aria-label="Task">
      <div class="row">${it.project ? `<span class="td-chip proj">${esc(it.project)}</span>` : ""}${it.due_date ? `<span class="td-chip">${esc(dueLabel(it.due_date).text || it.due_date)}</span>` : ""}${it.urgent ? '<span class="td-chip urgent">Urgent</span>' : ""}${it.done ? "<span>Crossed out on paper</span>" : ""}${it.unsure ? "<span>Hard to read, check it</span>" : ""}${it.notes ? `<span>${esc(it.notes)}</span>` : ""}</div></div></li>`).join("")}</ul>
    ${r.unreadable?.length ? `<p class="small muted">Couldn't read: ${esc(r.unreadable.join("; "))}</p>` : ""}
    <div class="actions"><button type="submit" class="primary" id="sn-add">Add tasks</button><button type="button" id="sn-cancel">Cancel</button></div></form>`;
  const count = () => { const k = d.querySelectorAll("[data-i]:checked").length; d.querySelector("#sn-add").textContent = `Add ${k} task${k === 1 ? "" : "s"}`; d.querySelector("#sn-add").disabled = !k; };
  d.querySelectorAll("[data-i]").forEach((c) => (c.onchange = count)); count();
  d.querySelector("#sn-cancel").onclick = () => d.close();
  d.querySelector("form").onsubmit = async (e) => {
    e.preventDefault();
    const items = r.items.map((it, i) => ({ ...it, title: d.querySelector(`[data-t="${i}"]`).value.trim() })).filter((it, i) => d.querySelector(`[data-i="${i}"]`).checked && it.title)
      .map(({ title, notes, project, due_date, urgent }) => ({ title, notes, project, due_date, urgent }));
    d.close();
    const res = await act(() => api("add_many", { source: "photo", items }), `${items.length} task${items.length === 1 ? "" : "s"} added from your notes`);
    if (res) { upsert(res.items); render(); }
  };
}

// ---------- Friday recap ----------
function openFlow(which, preview = false) {
  S.preview = preview; S.step = 0; S.proposal = null;
  S.view = which ?? (recapPending() ? "recap" : planPending() ? "plan" : "plan");
  S.flowWeek = S.view === "recap" ? (preview ? mondayOf() : recapWeek()) : mondayOf();
  render(); window.scrollTo(0, 0);
}
const RECAP_STEPS = [
  { key: "done", label: "Done", title: "Done and partly done", text: "What you finished this week, and what's partly there. Untick anything that isn't really done." },
  { key: "moving", label: "Moving", title: "Moved forward, carrying over", text: "You worked on these this week but they're not finished. They'll carry over to next week." },
  { key: "urgent", label: "Urgent", title: "Needs an update before the week ends", text: "Urgent or due this week and still open. Finish them, push them to Monday, or say what happened." },
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
function renderRecap() {
  const week = S.flowWeek, g = recapGroups(week), all = [...g.done, ...g.moving, ...g.urgent, ...g.untouched];
  const nOf = new Map(all.map((t, i) => [t.id, i + 1]));
  const last = S.step >= RECAP_STEPS.length;
  const qa = {
    done: (t) => t.status === "done" ? '<button type="button" data-qa="reopen">Not done</button>' : '<button type="button" data-qa="done">Done</button><button type="button" data-qa="partial">What\'s left?</button>',
    moving: () => '<button type="button" data-qa="done">Done</button><button type="button" data-qa="partial">Partly done</button><button type="button" data-qa="drop">Remove</button>',
    urgent: () => '<button type="button" data-qa="done">Done</button><button type="button" data-qa="monday">Push to Monday</button><button type="button" data-qa="partial">Partly done</button><button type="button" data-qa="drop">Remove</button>',
    untouched: () => '<button type="button" data-qa="done">Done</button><button type="button" data-qa="keep">Keep for next week</button><button type="button" data-qa="drop">Remove</button>',
  };
  let body;
  if (!last) {
    const st = RECAP_STEPS[S.step], list = g[st.key];
    body = `<div class="td-step-intro"><h3>${st.title}</h3><p>${st.text}</p></div>
      ${list.length ? `<ul class="td-list">${list.map((t) => itemHTML(t, nOf.get(t.id), { qa: qa[st.key] })).join("")}</ul>` : '<div class="td-empty">Nothing here.</div>'}
      <div style="margin-top:14px">${aiHTML("e.g. “3 was done, but I still have to send the contract”")}</div>`;
  } else {
    const done = g.done.filter((t) => t.status === "done").length, carry = all.filter(isOpen).length;
    const removed = S.items.filter((t) => t.status === "dropped" && Date.parse(t.updated_at) >= cphMs(week)).length;
    body = `<div class="td-step-intro"><h3>Ready to close the week</h3><p>${carry ? `${carry} open task${carry === 1 ? "" : "s"} will carry over to ${weekLabel(addDays(week, 7)).toLowerCase()}.` : "Nothing carries over. Clean slate."}</p></div>
      <div class="td-sum"><div><b>${done}</b><span>done</span></div><div><b>${g.done.filter((t) => t.status === "partial").length}</b><span>partly done</span></div><div><b>${carry}</b><span>carrying over</span></div></div>
      ${removed ? `<p class="small muted">${removed} removed this week.</p>` : ""}`;
  }
  root.innerHTML = `<div class="td-flow-head"><button type="button" class="link-btn" id="td-back">‹ Back to the list</button>
      <div class="td-kicker" style="margin-top:12px">Friday recap${S.preview ? " · preview" : ""}</div><h2>${weekLabel(week)}</h2>
      <div class="td-steps">${RECAP_STEPS.map((s, i) => `<button type="button" class="td-step${i === S.step ? " on" : i < S.step ? " past" : ""}" data-step="${i}"><i></i><span>${i + 1}. ${s.label} (${g[s.key].length})</span></button>`).join("")}</div></div>
    ${body}
    <div class="td-flow-foot">${S.step > 0 ? '<button type="button" id="td-prev">Back</button>' : "<span></span>"}
      ${last ? `<button type="button" class="primary" id="td-close">${S.preview ? "Finish preview" : "Close the week"}</button>` : `<button type="button" class="primary" id="td-next">${S.step === RECAP_STEPS.length - 1 ? "Finish" : "Next"}</button>`}</div>`;
  document.getElementById("td-back").onclick = () => { S.view = "list"; render(); };
  root.querySelectorAll("[data-step]").forEach((b) => (b.onclick = () => { S.step = Number(b.dataset.step); S.proposal = null; render(); }));
  document.getElementById("td-prev")?.addEventListener("click", () => { S.step--; S.proposal = null; render(); window.scrollTo(0, 0); });
  document.getElementById("td-next")?.addEventListener("click", () => { S.step++; S.proposal = null; render(); window.scrollTo(0, 0); });
  document.getElementById("td-close")?.addEventListener("click", async () => {
    if (S.preview) { S.view = "list"; toast("Preview finished. Nothing was carried over."); return render(); }
    const r = await act(() => api("close_week", { week }));
    if (!r) return;
    await load();
    S.view = "list"; render();
    toast(r.carried ? `Week closed. ${r.carried} task${r.carried === 1 ? "" : "s"} carried over.` : "Week closed.");
  });
  wireItems(root); wireAI(all);
}

// ---------- Monday overview ----------
function renderPlan() {
  const week = S.flowWeek, start = cphMs(week);
  const carried = sortOpen(S.items.filter((t) => isOpen(t) && Date.parse(t.created_at) < start));
  const added = sortOpen(S.items.filter((t) => isOpen(t) && Date.parse(t.created_at) >= start));
  const all = [...carried, ...added];
  let n = 0;
  const qa = () => '<button type="button" data-qa="done">Done</button><button type="button" data-qa="urgent">Urgent</button><button type="button" data-qa="drop">Remove</button>';
  root.innerHTML = `<div class="td-flow-head"><button type="button" class="link-btn" id="td-back">‹ Back to the list</button>
      <div class="td-kicker" style="margin-top:12px">Your week${S.preview ? " · preview" : ""}</div><h2>${weekLabel(week)}</h2>
      <p class="muted" style="margin:0">${carried.length ? `${carried.length} task${carried.length === 1 ? "" : "s"} carried over from last week.` : "Nothing carried over from last week."}</p></div>
    <h3 class="td-sec">Carried over <span class="n">${carried.length}</span></h3>
    ${carried.length ? `<ul class="td-list">${carried.map((t) => itemHTML(t, ++n, { qa })).join("")}</ul>` : '<div class="td-empty">Nothing carried over.</div>'}
    <h3 class="td-sec">Anything you didn't get to?</h3>
    <section class="td-card"><form class="td-add" id="td-plan-add"><textarea id="td-plan-new" rows="2" placeholder="Add what's on your mind for this week, one per line." aria-label="New tasks"></textarea><button type="submit" class="primary">Add</button></form>
      <p class="small muted" style="margin:8px 0 0">Or <button type="button" class="link-btn" id="td-plan-snap">snap a photo of your notes</button>.</p></section>
    ${added.length ? `<h3 class="td-sec">New this week <span class="n">${added.length}</span></h3><ul class="td-list">${added.map((t) => itemHTML(t, ++n, { qa })).join("")}</ul>` : ""}
    <h3 class="td-sec">Popped up while you were away</h3>
    <div class="td-away">
      <div class="td-away-tile">${I.mail}<div><b>Unread emails that need you<span class="td-soon">After Gmail is connected</span></b><span>Unread client emails from the weekend that look like they need an answer.</span></div></div>
      <div class="td-away-tile">${I.cal}<div><b>Meeting requests waiting<span class="td-soon">After Calendar is connected</span></b><span>Invites you haven't accepted or declined yet.</span></div></div>
      <div class="td-away-tile">${I.reply}<div><b>Follow-ups<span class="td-soon">After Gmail is connected</span></b><span>Threads where someone is waiting on your reply, or you're waiting on theirs. Threads you mark "ignore reminders" stay quiet.</span></div></div>
    </div>
    ${aiHTML("e.g. “2 is urgent, push 4 to Thursday”")}
    <div class="td-flow-foot"><span></span><button type="button" class="primary" id="td-start">${S.preview ? "Finish preview" : "Start the week"}</button></div>`;
  document.getElementById("td-back").onclick = () => { S.view = "list"; render(); };
  document.getElementById("td-plan-snap").onclick = () => { const f = Object.assign(document.createElement("input"), { type: "file", accept: "image/*" }); f.onchange = () => f.files?.[0] && snap(f.files[0]); f.click(); };
  document.getElementById("td-start").onclick = async () => {
    if (!S.preview) { const r = await act(() => api("plan_done", { week })); if (!r) return; S.weeks = S.weeks.filter((w) => w.week_start !== week).concat({ ...weekRow(week), week_start: week, plan_done_at: new Date().toISOString() }); }
    S.view = "list"; render(); toast(S.preview ? "Preview finished." : "Have a good week.");
  };
  wireItems(root); wireAI(all); wireAdd("td-plan-add", "td-plan-new");
}

// ---------- private links ----------
async function linkDialog() {
  const d = document.createElement("dialog");
  d.className = "po-dialog td-dialog";
  document.body.append(d);
  d.addEventListener("close", () => setTimeout(() => d.remove(), 0));
  d.addEventListener("click", (e) => { if (e.target === d) d.close(); });
  const draw = async (fresh) => {
    const { links } = await api("link_list").catch(() => ({ links: [] }));
    const viaSession = S.cfg?.via === "session";
    d.innerHTML = `<h2>Private link for your phone</h2>
      <p class="small muted" style="margin:0">Opens your list with no sign-in. Anyone who has the link can see and change your list, so keep it to yourself: send it to yourself, then add it to your phone's home screen.</p>
      ${fresh ? `<div class="td-linkbox"><input id="lk-url" readonly value="${esc(fresh)}" aria-label="Your private link"><button type="button" class="primary" id="lk-copy">Copy</button></div>
        <p class="small" style="margin:0">This is the only time the link is shown. If you lose it, make a new one.</p>` : ""}
      ${viaSession ? (fresh ? "" : '<p style="margin:14px 0 0"><button type="button" class="primary" id="lk-new">Make a private link</button></p>') : '<p class="small muted">You opened this page with a private link. New links are made from a computer where you\'re signed in to Stellar OS.</p>'}
      ${links.length ? `<h3 class="td-sec">Links that work</h3><ul class="td-links">${links.map((l) => `<li><span>${esc(l.label)} · made ${esc(fmtDay(l.created_at.slice(0, 10)))}${l.last_used_at ? ` · last used ${esc(fmtDay(l.last_used_at.slice(0, 10)))}` : ""}</span>${viaSession ? `<button type="button" class="link-btn" data-off="${esc(l.id)}">Switch off</button>` : ""}</li>`).join("")}</ul>` : ""}
      <div class="actions"><button type="button" id="lk-close">Close</button></div>`;
    d.querySelector("#lk-close").onclick = () => d.close();
    d.querySelector("#lk-new")?.addEventListener("click", async () => {
      const r = await act(() => api("link_create", { label: "Phone" }));
      if (r?.key) draw(`${location.origin}${location.pathname}#k=${r.key}`);
    });
    d.querySelector("#lk-copy")?.addEventListener("click", async () => {
      const inp = d.querySelector("#lk-url");
      try { await navigator.clipboard.writeText(inp.value); toast("Link copied"); } catch { inp.select(); toast("Select the link and copy it"); }
    });
    d.querySelectorAll("[data-off]").forEach((b) => (b.onclick = async () => {
      if (!(await confirmDialog({ title: "Switch this link off?", body: "Any device using it stops opening your list. Your tasks stay saved.", confirm: "Switch off" }))) return;
      await act(() => api("link_revoke", { id: b.dataset.off }), "Link switched off");
      draw(fresh);
    }));
  };
  d.innerHTML = '<p class="muted">Loading…</p>';
  d.showModal();
  draw(null);
}

// ---------- start ----------
async function load() {
  const r = await api("load");
  S.items = r.items; S.weeks = r.weeks;
}
function locked(msg) {
  root.innerHTML = `<div class="td-locked">${ICON_TODO}<h1>Your to-do list</h1>
    <p class="muted">${esc(msg || "Open your private link, or sign in to Stellar OS in this browser.")}</p>
    <p><a class="btn" href="./">Open Stellar OS</a></p></div>`;
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
  render();
}
// Close the "more" menu on a click outside it or Escape.
document.addEventListener("click", (e) => { const m = root.querySelector(".td-menu[open]"); if (m && !m.contains(e.target)) m.open = false; });
document.addEventListener("keydown", (e) => { if (e.key === "Escape") root.querySelector(".td-menu[open]")?.removeAttribute("open"); });
// Keep the week button honest if the page stays open across Friday 17:00 or Monday 08:00.
setInterval(() => { if (S.view === "list" && S.cfg && !document.querySelector("dialog[open]") && document.activeElement?.tagName !== "TEXTAREA") render(); }, 5 * 60_000);
// A private link opened in a tab that already shows this page.
window.addEventListener("hashchange", () => { if (/[#&]k=/.test(location.hash)) boot(); });
boot();
