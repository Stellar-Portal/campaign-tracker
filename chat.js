// Team chat on a campaign page: a panel docked on the right that pushes the dashboard aside (never covers it),
// so people can keep scrolling and clicking the page while it's open. It starts with a short recap of what
// changed since this person last opened the campaign (database function campaign_recap: new videos, views
// gained, edits, payouts, invoices, folders, client links, new messages), then the conversation.
// Tables: campaign_messages (live via Supabase Realtime), campaign_visits (last visit per person),
// campaign_activity (filled by triggers). Team only; clients never reach any of it.
import { statusLabel } from "./sheet-lists.js?v=20261114c";

const OPEN_KEY = "stellar-chat-open";   // the panel stays open from campaign to campaign until closed
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const cf = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });
const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
};
const time = (iso) => new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
const dayKey = (iso) => new Date(iso).toDateString();
function dayLabel(iso) {
  const d = new Date(iso), t = new Date(), y = new Date(Date.now() - 86400000);
  if (d.toDateString() === t.toDateString()) return "Today";
  if (d.toDateString() === y.toDateString()) return "Yesterday";
  return d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
}
const when = (iso) => {
  const d = new Date(iso), days = (Date.now() - d) / 86400000;
  return days < 1 && d.getDate() === new Date().getDate() ? `today ${time(iso)}` : days < 6 ? `${d.toLocaleDateString("en-GB", { weekday: "long" })} ${time(iso)}` : d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
};
const PAYOUT = { contacted: "Contacted", waiting_draft: "Waiting for draft", drafted: "Drafted", waiting_payment: "Waiting to post", posted: "Posted · to pay", paid: "Paid" };
const INVOICE = { requested: "requested an invoice", returned: "had an invoice sent back", invoiced: "invoice sent to the client", paid: "invoice paid", cancelled: "invoice cancelled" };
const list = (xs) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const ICON = {
  chat: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 5.5h14a1.5 1.5 0 0 1 1.5 1.5v8.5A1.5 1.5 0 0 1 19 17H10l-4.5 3.5V17H5A1.5 1.5 0 0 1 3.5 15.5V7A1.5 1.5 0 0 1 5 5.5Z"/></svg>',
  close: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/></svg>',
  send: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h13M12.5 6.5 18 12l-5.5 5.5"/></svg>',
};

let S = null;   // the chat on screen: { id, campaign, me, team, since, first, recap, messages, channel, ... }

// ---------- recap ----------
function recapLines(r) {
  const out = [];
  if (r.new_posts > 0) {
    const f = (r.new_posts_folders ?? []).filter((x) => x.folder);
    out.push({ k: "videos", ic: "▶", go: "posts", t: `<b>${plural(r.new_posts, "new video")}</b>${f.length ? ` · ${f.map((x) => `${x.n} in ${esc(x.folder)}`).join(", ")}` : ""}${r.new_posts_by?.length ? ` · added by ${esc(list(r.new_posts_by))}` : ""}` });
  }
  if (r.views_gained > 0) out.push({ k: "views", ic: "↗", go: "report", t: `<b>+${cf.format(r.views_gained)} views</b> · ${cf.format(r.views_total)} in total now` });
  const acts = r.activity ?? [];
  // Campaign edits: one line per person, with every field they changed.
  const edits = {};
  for (const a of acts.filter((x) => x.kind === "edit")) {
    const k = a.who ?? "";
    (edits[k] ??= { fields: new Set(), status: null });
    for (const f of a.detail?.fields ?? []) edits[k].fields.add(f);
    if (a.detail?.status) edits[k].status = a.detail.status;
  }
  for (const [who, e] of Object.entries(edits)) {
    const fields = [...e.fields].filter((f) => f !== "status");
    const parts = [e.status ? `set the status to <b>${esc(statusLabel(e.status))}</b>` : "", fields.length ? `changed the ${esc(list(fields))}` : ""].filter(Boolean);
    out.push({ ic: "✎", go: "details", t: `<b>${who ? esc(who) : "The Campaign Overview sheet"}</b> ${parts.join(" and ")}` });
  }
  // Payouts: added / removed creators per person, status changes grouped by the new status.
  const by = (kind) => acts.filter((x) => x.kind === kind);
  const people = (xs) => list([...new Set(xs.map((x) => x.who ?? "automatically"))].map(esc));
  const added = by("payout_added"), removed = by("payout_removed"), moved = by("payout_status");
  if (added.length) out.push({ ic: "+", go: "payouts", t: `<b>${plural(added.length, "creator")}</b> added to payouts by ${people(added)}` });
  const st = {};
  for (const m of moved) (st[m.detail?.status] ??= []).push(m);
  for (const [s, xs] of Object.entries(st)) out.push({ ic: "€", go: "payouts", t: `<b>${plural(xs.length, "creator")}</b> moved to ${esc(PAYOUT[s] ?? s)}${xs.every((x) => !x.who) ? " (automatically)" : ` by ${people(xs)}`}` });
  if (removed.length) out.push({ ic: "−", go: "payouts", t: `<b>${plural(removed.length, "creator")}</b> removed from payouts by ${people(removed)}` });
  for (const a of by("invoice")) out.push({ ic: "◫", go: "invoices", t: a.detail?.status === "requested" ? `<b>${esc(a.who ?? "Someone")}</b> requested an invoice${a.detail?.ref ? ` (${esc(a.detail.ref)})` : ""}` : `<b>${a.detail?.ref ? esc(a.detail.ref) : "Invoice"}</b>: ${esc((INVOICE[a.detail?.status] ?? a.detail?.status ?? "").replace(/^(requested an invoice|had an invoice sent back)$/, "sent back for changes"))}` });
  const folders = by("folder");
  if (folders.length) out.push({ ic: "▣", go: "posts", t: `New folder${folders.length > 1 ? "s" : ""} ${list(folders.map((f) => `<b>${esc(f.detail?.name)}</b>`))} by ${people(folders)}` });
  const links = by("share_link");
  if (links.length) out.push({ ic: "↗", go: null, t: `<b>${people(links)}</b> made ${links.length === 1 ? "a client link" : `${links.length} client links`}` });
  if (r.messages > 0) out.push({ k: "msgs", ic: "✉", go: "messages", t: `<b>${plural(r.messages, "new message")}</b> below` });
  return out;
}
function recapSummary(r, lines) {
  const updates = lines.filter((l) => !l.k).length;   // edits, payouts, invoices, folders, client links
  return [
    r.new_posts > 0 ? plural(r.new_posts, "new video") : "",
    r.views_gained > 0 ? `+${cf.format(r.views_gained)} views` : "",
    updates ? plural(updates, "update") : "",
    r.messages > 0 ? plural(r.messages, "message") : "",
  ].filter(Boolean).join(" · ");
}
function recapHTML() {
  const r = S.recap ?? {}, lines = recapLines(r);
  const head = S.first ? "Last 7 days" : `Since ${esc(when(S.since))}`;
  if (!lines.length) return `<p class="cc-recap-none">${S.first ? "Nothing new in the last 7 days." : `Nothing new since ${esc(when(S.since))}.`}</p>`;
  return `<section class="cc-recap${S.recapOpen ? " open" : ""}" aria-label="What changed">
    <button type="button" class="cc-recap-head" aria-expanded="${S.recapOpen}">
      <span class="cc-recap-t"><b>${head}</b><span>${esc(recapSummary(r, lines))}</span></span>
      <svg class="cc-chev" viewBox="0 0 24 24" aria-hidden="true"><path d="m7 10 5 5 5-5"/></svg>
    </button>
    <ul${S.recapOpen ? "" : " hidden"}>${lines.map((l) => `<li>${l.go ? `<button type="button" data-go="${l.go}">${l.t}</button>` : `<span>${l.t}</span>`}</li>`).join("")}</ul>
  </section>`;
}

// ---------- messages ----------
const nameOf = (email) => S.team.find((t) => t.email === email)?.name || String(email).split("@")[0];
const initials = (name) => name.split(/\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase();
function bodyHTML(text) {
  let h = esc(text).replace(/(https?:\/\/[^\s<]+[^\s<.,;:!?)\]'"])/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
  for (const t of S.team) if (t.name) h = h.replace(new RegExp(`@${t.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "g"), `<span class="cc-at${t.email === S.me ? " me" : ""}">@${esc(t.name)}</span>`);
  return h.replace(/\n/g, "<br>");
}
function messagesHTML() {
  const ms = S.messages.filter((m) => !m.deleted_at);
  if (!ms.length) return `<p class="cc-empty">No messages yet.<br>Anything about this campaign goes here. Type @ to mention someone.</p>`;
  let html = "", prev = null, divided = false;
  for (const m of ms) {
    if (!prev || dayKey(prev.created_at) !== dayKey(m.created_at)) { html += `<p class="cc-day">${esc(dayLabel(m.created_at))}</p>`; prev = null; }
    if (!divided && !S.first && m.author_email !== S.me && m.created_at > S.since) { html += `<p class="cc-new" id="cc-new">New</p>`; divided = true; prev = null; }
    const grouped = prev && prev.author_email === m.author_email && Date.parse(m.created_at) - Date.parse(prev.created_at) < 5 * 60000;
    const mine = m.author_email === S.me;
    html += `<div class="cc-msg${mine ? " mine" : ""}${grouped ? " cont" : ""}" data-mid="${m.id}">
      ${grouped ? "" : `<p class="cc-meta">${mine ? "" : `<b>${esc(nameOf(m.author_email))}</b>`}<time datetime="${m.created_at}">${time(m.created_at)}</time></p>`}
      <div class="cc-bubble">${bodyHTML(m.body)}${mine && !m.pending ? `<button type="button" class="cc-del" data-del="${m.id}" aria-label="Delete this message" title="Delete">${ICON.close}</button>` : ""}</div>
    </div>`;
    prev = m;
  }
  return html;
}

// ---------- panel ----------
function ensureShell() {
  let panel = document.getElementById("cc");
  if (panel) return panel;
  panel = document.createElement("aside");
  panel.id = "cc"; panel.className = "cc"; panel.setAttribute("aria-label", "Team chat"); panel.hidden = true;
  document.body.append(panel);
  const tab = document.createElement("button");
  tab.type = "button"; tab.id = "cc-tab"; tab.className = "cc-tab"; tab.hidden = true;
  tab.innerHTML = `${ICON.chat}<span>Chat</span><em class="cc-badge" hidden></em>`;
  tab.onclick = () => openChat(true);
  document.body.append(tab);
  return panel;
}
function people() {
  const c = S.campaign, run = String(c.campaign_runner ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  return [...new Set([c.comms_owner, ...run].filter(Boolean))].join(", ");
}
function draw() {
  const panel = ensureShell();
  const c = S.campaign;
  panel.innerHTML = `
    <header class="cc-head">
      <div class="cc-title"><b>Chat</b>${people() ? `<small title="DRI and the people running this campaign">${esc(people())}</small>` : ""}</div>
      <div class="cc-here" id="cc-here"></div>
      <button type="button" class="cc-x" id="cc-close" aria-label="Close the chat" title="Close (Esc)">${ICON.close}</button>
    </header>
    <div id="cc-recap" class="cc-recap-wrap">${recapHTML()}</div>
    <div class="cc-scroll" id="cc-scroll"><div class="cc-msgs" id="cc-msgs">${messagesHTML()}</div></div>
    <form class="cc-compose" id="cc-form" autocomplete="off">
      <ul class="cc-suggest" id="cc-suggest" role="listbox" hidden></ul>
      <textarea id="cc-text" rows="1" maxlength="4000" placeholder="Message" aria-label="Message the team, type @ to mention someone"></textarea>
      <button type="submit" class="cc-send" aria-label="Send" title="Send (Enter)">${ICON.send}</button>
    </form>`;
  wire();
  drawHere();
  scrollToStart();
}
function redrawMessages(stick = true) {
  const box = document.getElementById("cc-scroll"), msgs = document.getElementById("cc-msgs");
  if (!box || !msgs) return;
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
  msgs.innerHTML = messagesHTML();
  wireMessages();
  if (stick && atBottom) box.scrollTop = box.scrollHeight;
}
function scrollToStart() {
  const box = document.getElementById("cc-scroll");
  if (!box) return;
  const nw = document.getElementById("cc-new");
  // Open at the first new message, or the latest one (the recap stays pinned above the conversation).
  requestAnimationFrame(() => { box.scrollTop = nw ? Math.max(0, nw.offsetTop - 140) : box.scrollHeight; });
}
function drawHere() {
  const el = document.getElementById("cc-here");
  if (!el || !S) return;
  const others = [...(S.here ?? new Set())].filter((e) => e !== S.me);
  el.innerHTML = others.slice(0, 3).map((e) => `<span class="cc-av" title="${esc(nameOf(e))} has this campaign open too">${esc(initials(nameOf(e)))}</span>`).join("");
}
function badge() {
  if (!S) return;
  const n = recapLines(S.recap ?? {}).length + S.unseenLive;
  for (const b of document.querySelectorAll(".cc-badge")) { b.hidden = !n || S.open; b.textContent = n > 9 ? "9+" : String(n); }
}

function wire() {
  document.getElementById("cc-close").onclick = () => openChat(false);
  const recap = document.querySelector("#cc-recap .cc-recap-head");
  const redrawRecap = () => { document.getElementById("cc-recap").innerHTML = recapHTML(); wireRecap(); };
  function wireRecap() {
    const head = document.querySelector("#cc-recap .cc-recap-head");
    if (head) head.onclick = () => { S.recapOpen = !S.recapOpen; redrawRecap(); };
    document.querySelectorAll("#cc-recap [data-go]").forEach((b) => (b.onclick = () => go(b.dataset.go)));
  }
  wireRecap();
  wireMessages();
  const form = document.getElementById("cc-form"), ta = document.getElementById("cc-text"), sug = document.getElementById("cc-suggest");
  ta.value = S.draft ?? "";
  const grow = () => { ta.style.height = "auto"; ta.style.height = `${Math.min(ta.scrollHeight, 160)}px`; };
  grow();
  let pick = -1, matches = [];
  const closeSug = () => { sug.hidden = true; pick = -1; matches = []; };
  const mentionAt = () => {
    const upto = ta.value.slice(0, ta.selectionStart), m = upto.match(/(^|\s)@([\p{L}\s]{0,20})$/u);
    return m ? { start: upto.length - m[2].length - 1, q: m[2].toLowerCase() } : null;
  };
  const showSug = () => {
    const at = mentionAt();
    if (!at) return closeSug();
    matches = S.team.filter((t) => t.name && t.email !== S.me && t.name.toLowerCase().startsWith(at.q.trimStart())).slice(0, 6);
    if (!matches.length) return closeSug();
    pick = Math.max(0, Math.min(pick, matches.length - 1));
    sug.innerHTML = matches.map((t, i) => `<li role="option" aria-selected="${i === pick}" data-i="${i}"><span class="cc-av sm">${esc(initials(t.name))}</span>${esc(t.name)}</li>`).join("");
    sug.hidden = false;
    sug.querySelectorAll("li").forEach((li) => (li.onmousedown = (e) => { e.preventDefault(); choose(+li.dataset.i); }));
  };
  const choose = (i) => {
    const at = mentionAt(), t = matches[i];
    if (!at || !t) return;
    ta.value = `${ta.value.slice(0, at.start)}@${t.name} ${ta.value.slice(ta.selectionStart)}`;
    const pos = at.start + t.name.length + 2; ta.setSelectionRange(pos, pos);
    closeSug(); grow(); S.draft = ta.value;
  };
  ta.oninput = () => { S.draft = ta.value; grow(); showSug(); };
  ta.onkeydown = (e) => {
    if (!sug.hidden && matches.length) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); pick = (pick + (e.key === "ArrowDown" ? 1 : matches.length - 1)) % matches.length; showSug(); return; }
      if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); choose(pick); return; }
      if (e.key === "Escape") { e.stopPropagation(); closeSug(); return; }
    }
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); form.requestSubmit(); }
  };
  ta.onblur = () => setTimeout(closeSug, 120);
  form.onsubmit = async (e) => {
    e.preventDefault();
    const body = ta.value.trim();
    if (!body) return;
    ta.value = ""; S.draft = ""; grow();
    const temp = { id: `tmp-${Date.now()}`, campaign_id: S.id, author_email: S.me, body, created_at: new Date().toISOString(), pending: true };
    S.messages.push(temp); redrawMessages(); scrollBottom();
    const { data, error } = await S.sb.from("campaign_messages").insert({ campaign_id: S.id, body }).select("*").single();
    S.messages = S.messages.filter((m) => m !== temp);
    if (error) { S.toast?.("Couldn't send the message. Check your connection and try again."); ta.value = body; S.draft = body; grow(); }
    else if (!S.messages.some((m) => m.id === data.id)) S.messages.push(data);
    redrawMessages(); scrollBottom();
  };
}
function wireMessages() {
  document.querySelectorAll("#cc-msgs [data-del]").forEach((b) => (b.onclick = async () => {
    const m = S.messages.find((x) => x.id === b.dataset.del);
    if (!m) return;
    m.deleted_at = new Date().toISOString(); redrawMessages(false);
    const { error } = await S.sb.from("campaign_messages").update({ deleted_at: m.deleted_at }).eq("id", m.id);
    if (error) { m.deleted_at = null; redrawMessages(false); S.toast?.("Couldn't delete the message."); }
    else S.toast?.("Message deleted");
  }));
}
const scrollBottom = () => { const box = document.getElementById("cc-scroll"); if (box) box.scrollTop = box.scrollHeight; };
function go(where) {
  const app = document.getElementById("app");
  // On a phone the chat covers the page, so it steps aside to show what was tapped.
  if (where !== "messages" && window.innerWidth < 1100) openChat(false);
  if (where === "messages") { const nw = document.getElementById("cc-new"), box = document.getElementById("cc-scroll"); if (nw && box) box.scrollTo({ top: nw.offsetTop - 60, behavior: "smooth" }); return; }
  if (where === "invoices") { location.hash = "#/invoices"; return; }
  const tab = where === "payouts" ? "payouts" : "report";
  app.querySelector(`[data-ctab="${tab}"]`)?.click();
  const target = where === "posts" ? document.getElementById("posts") : where === "details" ? app.querySelector(".camp-details") : where === "payouts" ? document.getElementById("camp-payouts") : app.querySelector(".ws-switch");
  target?.scrollIntoView({ behavior: "smooth", block: "start" });
}

// ---------- closing from outside ----------
// A click on empty page space closes the chat. Clicks on anything you use on the dashboard (buttons, links,
// tabs, fields, videos, menus) leave it open, so the two can still be used side by side.
const INTERACTIVE = "a, button, input, select, textarea, label, summary, details, video, iframe, canvas, svg, [role=button], [role=tab], [role=option], [tabindex]:not([tabindex='-1']), [contenteditable], dialog, .post, .cover, [data-pop]";
function outsideClick(e) {
  if (!S?.open || e.button !== 0) return;
  const t = e.target;
  if (!(t instanceof Element) || t.closest("#cc, #cc-tab, #chat-btn, .td-drawer, .td-fab, #toast, dialog[open]")) return;
  if (t.closest(INTERACTIVE)) return;
  if (String(window.getSelection?.() ?? "").length) return;   // finishing a text selection isn't a "close"
  openChat(false);
}
function escClose(e) {
  if (e.key !== "Escape" || !S?.open || e.defaultPrevented) return;
  if (document.querySelector("dialog[open], details[open].camp-menu, .td-drawer:not([hidden])")) return;
  if (document.activeElement?.closest?.("#cc .cc-compose") && document.getElementById("cc-suggest")?.hidden === false) return;
  openChat(false);
}
document.addEventListener("click", outsideClick);
document.addEventListener("keydown", escClose);

// ---------- open / close ----------
export function openChat(on) {
  if (!S) return;
  S.open = on;
  store.set(OPEN_KEY, on ? "1" : "0");
  const panel = ensureShell(), tab = document.getElementById("cc-tab");
  if (on && !panel.innerHTML) draw();
  panel.hidden = false;
  requestAnimationFrame(() => {
    document.body.classList.toggle("cc-open", on);
    if (on) { S.unseenLive = 0; setTimeout(() => document.getElementById("cc-text")?.focus({ preventScroll: true }), 260); }
  });
  if (!on) setTimeout(() => { if (!S?.open) panel.hidden = true; }, 320);
  tab.hidden = on;
  document.getElementById("chat-btn")?.setAttribute("aria-pressed", String(on));
  badge();
}

// ---------- mount on a campaign page ----------
export async function mountCampaignChat(sb, { campaign, user, toast, isCurrent }) {
  const me = String(user?.email ?? "").toLowerCase();
  if (S && S.id === campaign.id) { S.campaign = campaign; wireHeroButton(); badge(); return; }
  unmountCampaignChat();
  const id = campaign.id;
  const { data: visit } = await sb.from("campaign_visits").select("last_seen_at").eq("campaign_id", id).eq("email", me).maybeSingle();
  const first = !visit;
  const since = visit?.last_seen_at ?? new Date(Date.now() - 7 * 86400000).toISOString();
  const [recap, msgs, team] = await Promise.all([
    sb.rpc("campaign_recap", { p_campaign: id, p_since: since }),
    sb.from("campaign_messages").select("*").eq("campaign_id", id).order("created_at", { ascending: false }).limit(200),
    sb.from("team_members").select("email,name"),
  ]);
  if (!isCurrent()) return;
  S = {
    sb, id, campaign, me, toast, since, first, recap: recap.data ?? {}, recapOpen: false, unseenLive: 0, draft: "",
    messages: (msgs.data ?? []).reverse(),
    team: (team.data ?? []).map((t) => ({ email: String(t.email).toLowerCase(), name: t.name && t.name !== "Admin" ? t.name : String(t.email).split("@")[0] })),
    here: new Set(), open: false,
  };
  // This visit counts from now; the recap above keeps showing the previous one while the page is open.
  sb.from("campaign_visits").upsert({ campaign_id: id, email: me, last_seen_at: new Date().toISOString() }).then(() => {});
  ensureShell();
  document.getElementById("cc").innerHTML = "";
  document.getElementById("cc-tab").hidden = false;
  wireHeroButton();
  listen();
  openChat(store.get(OPEN_KEY) === "1" && window.innerWidth >= 1100);
  badge();
}
function wireHeroButton() {
  const b = document.getElementById("chat-btn");
  if (b) { b.onclick = () => openChat(!S.open); b.setAttribute("aria-pressed", String(!!S.open)); }
}
function listen() {
  const s = S, sb = s.sb;
  const add = (m) => {
    if (!S || S !== s || m.campaign_id !== s.id) return;
    const i = s.messages.findIndex((x) => x.id === m.id);
    if (i >= 0) s.messages[i] = m; else { s.messages.push(m); if (!s.open && m.author_email !== s.me && !m.deleted_at) { s.unseenLive++; badge(); } }
    if (s.open) redrawMessages();
  };
  try {
    s.channel = sb.channel(`campaign-chat:${s.id}`, { config: { presence: { key: s.me } } })
      .on("postgres_changes", { event: "*", schema: "public", table: "campaign_messages", filter: `campaign_id=eq.${s.id}` }, (p) => p.new?.id && add(p.new))
      .on("presence", { event: "sync" }, () => { s.here = new Set(Object.keys(s.channel.presenceState())); drawHere(); })
      .subscribe((status) => { if (status === "SUBSCRIBED") { s.live = true; s.channel.track({ at: Date.now() }).catch(() => {}); } else if (status !== "CLOSED") s.live = false; });
  } catch { s.live = false; }
  // If live updates aren't connected, check for new messages every 20 seconds while the page is open.
  s.poll = setInterval(async () => {
    if (S !== s || s.live || document.hidden) return;
    const last = s.messages.filter((m) => !String(m.id).startsWith("tmp")).at(-1)?.created_at ?? s.since;
    const { data } = await sb.from("campaign_messages").select("*").eq("campaign_id", s.id).gt("created_at", last).order("created_at").limit(100);
    for (const m of data ?? []) add(m);
  }, 20000);
  s.onHide = () => { if (document.visibilityState === "hidden" && S === s) sb.from("campaign_visits").upsert({ campaign_id: s.id, email: s.me, last_seen_at: new Date().toISOString() }).then(() => {}); };
  document.addEventListener("visibilitychange", s.onHide);
}
export function unmountCampaignChat() {
  if (!S) { document.getElementById("cc-tab")?.setAttribute("hidden", ""); return; }
  const s = S;
  S = null;
  clearInterval(s.poll);
  document.removeEventListener("visibilitychange", s.onHide);
  try { s.channel && s.sb.removeChannel(s.channel); } catch { /* ignore */ }
  // Leaving the page counts as the last visit, so what was seen here isn't recapped next time.
  s.sb.from("campaign_visits").upsert({ campaign_id: s.id, email: s.me, last_seen_at: new Date().toISOString() }).then(() => {});
  document.body.classList.remove("cc-open");
  const panel = document.getElementById("cc"), tab = document.getElementById("cc-tab");
  if (panel) { panel.hidden = true; panel.innerHTML = ""; }
  if (tab) tab.hidden = true;
}
export const chatIcon = ICON.chat;
