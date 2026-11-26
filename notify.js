// Alerts: a bell in the menu with an unread count, and a panel with the latest alerts (table `notifications`,
// filled by database triggers; each person only sees their own). Click an alert = mark it read and open the place.
// Live through Realtime (INSERT/UPDATE on the person's own rows), with a 60 s check as fallback.
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const BELL = '<path d="M6 9a6 6 0 0 1 12 0c0 6 2 7.5 2 7.5H4S6 15 6 9zM10 20a2 2 0 0 0 4 0"/>';
const SHOW = 50;

export const ago = (iso) => {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 90) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  if (s < 86400 * 7) return `${Math.round(s / 86400)} d ago`;
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
};
// Only in-app hashes are followed.
export const safeLink = (l) => (/^#\/[A-Za-z0-9_\-\/]*$/.test(String(l ?? "")) ? String(l) : "");

let S = null;   // { sb, email, items, channel, poll, live, wrap, btn, panel, onVis }

function unread() { return S ? S.items.filter((n) => !n.read_at).length : 0; }

function badge() {
  if (!S) return;
  const n = unread(), b = S.btn.querySelector(".bell-n");
  b.hidden = !n; b.textContent = n > 99 ? "99+" : String(n);
  S.btn.setAttribute("aria-label", n ? `Alerts, ${n} unread` : "Alerts");
}

function drawPanel() {
  if (!S) return;
  const n = unread();
  S.panel.innerHTML = `<div class="bell-head"><b>Alerts</b>${n ? `<button type="button" class="link-btn small" id="bell-all">Mark all read</button>` : ""}</div>
    <div class="bell-list">${S.items.length ? S.items.map((a) => `<button type="button" class="bell-item${a.read_at ? "" : " unread"}" data-id="${esc(a.id)}" data-link="${esc(safeLink(a.link))}">
        <span class="bell-dot" aria-hidden="true"></span>
        <span class="bell-txt"><b>${esc(a.title)}</b>${a.body ? `<span class="bell-body">${esc(a.body)}</span>` : ""}<span class="bell-time">${esc(ago(a.created_at))}</span></span>
      </button>`).join("") : `<p class="muted bell-empty">Nothing here yet. You'll see new drafts, mentions and invoice updates for your campaigns.</p>`}</div>`;
  S.panel.querySelector("#bell-all")?.addEventListener("click", markAll);
  S.panel.querySelectorAll(".bell-item").forEach((b) => (b.onclick = () => open(b.dataset.id, b.dataset.link)));
}

async function markRead(ids) {
  if (!S) return;
  const now = new Date().toISOString();
  for (const a of S.items) if (!ids || ids.includes(a.id)) a.read_at ??= now;
  badge(); drawPanel();
  await S.sb.rpc("notifications_mark_read", { p_ids: ids });
}
const markAll = () => markRead(null);

function open(id, link) {
  if (S?.items.find((a) => a.id === id && !a.read_at)) markRead([id]);
  setPanel(false);
  if (link) { if (location.hash === link) window.dispatchEvent(new HashChangeEvent("hashchange")); else location.hash = link; }
}

function setPanel(on) {
  if (!S) return;
  S.panel.hidden = !on;
  S.btn.setAttribute("aria-expanded", String(on));
  if (on) { drawPanel(); S.panel.querySelector(".bell-list")?.scrollTo(0, 0); }
}

async function load() {
  if (!S) return;
  const { data, error } = await S.sb.from("notifications").select("*").order("created_at", { ascending: false }).limit(SHOW);
  if (error || !S) return;
  S.items = data ?? [];
  badge();
  if (!S.panel.hidden) drawPanel();
}

function incoming(row, toast) {
  if (!S || !row?.id) return;
  const i = S.items.findIndex((a) => a.id === row.id);
  if (i >= 0) S.items[i] = row;
  else {
    S.items.unshift(row); S.items = S.items.slice(0, SHOW);
    if (!row.read_at) toast?.(row.title);
  }
  badge();
  if (!S.panel.hidden) drawPanel();
}

export async function mountNotifications(sb, user, { toast } = {}) {
  const email = String(user?.email ?? "").toLowerCase();
  if (!email) return;
  if (S?.email === email && S.wrap.isConnected) return;   // already running for this person
  unmountNotifications();
  const who = document.getElementById("who");
  if (!who) return;
  const wrap = document.createElement("div");
  wrap.className = "bell-wrap"; wrap.id = "bell-wrap";
  wrap.innerHTML = `<button type="button" class="nav-item bell-btn" id="bell-btn" aria-expanded="false" aria-controls="bell-panel" aria-label="Alerts"><svg viewBox="0 0 24 24" aria-hidden="true">${BELL}</svg><span>Alerts</span><i class="bell-n" hidden></i></button>`;
  who.before(wrap);
  const panel = document.createElement("div");
  panel.className = "bell-panel"; panel.id = "bell-panel"; panel.setAttribute("role", "dialog"); panel.setAttribute("aria-label", "Alerts");
  panel.setAttribute("data-pop", ""); panel.hidden = true;
  document.body.append(panel);
  const btn = wrap.querySelector("#bell-btn");
  S = { sb, email, items: [], channel: null, poll: 0, live: false, wrap, btn, panel, onVis: null };
  btn.onclick = () => { const on = S.panel.hidden; setPanel(on); if (on) load(); };
  await load();
  if (!S || S.email !== email) return;
  try {
    S.channel = sb.channel(`notify:${email}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "notifications", filter: `email=eq.${email}` }, (p) => incoming(p.new, toast))
      .subscribe((status) => { if (S) { if (status === "SUBSCRIBED") S.live = true; else if (status !== "CLOSED") S.live = false; } });
  } catch { S.live = false; }
  S.poll = setInterval(() => { if (S && !S.live && !document.hidden) load(); }, 60000);
  S.onVis = () => { if (document.visibilityState === "visible") load(); };
  document.addEventListener("visibilitychange", S.onVis);
}

export function unmountNotifications() {
  if (!S) return;
  clearInterval(S.poll);
  document.removeEventListener("visibilitychange", S.onVis);
  try { S.channel && S.sb.removeChannel(S.channel); } catch { /* ignore */ }
  S.wrap.remove(); S.panel.remove();
  S = null;
}

// For the My work page: the newest unread alerts, and a way to open the bell.
export const openBell = () => { if (S) { setPanel(true); load(); } };
