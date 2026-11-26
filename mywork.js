// My work (#/me): what needs the signed-in person right now, on the campaigns they run (DRI or runner).
// Sections only appear when they have something in them. Everything links to the exact place.
import { loadMoney, flagsFor, money } from "./money.js?v=20261126b";
import { ago, safeLink, openBell } from "./notify.js?v=20261126b";

const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const todayIso = () => new Date().toISOString().slice(0, 10);
const dayLabel = (d) => (d ? new Date(`${String(d).slice(0, 10)}T00:00:00`).toLocaleDateString("en-GB", { day: "numeric", month: "short" }) : "");
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const key = (s) => String(s ?? "").trim().toLowerCase().replace(/\s+/g, " ");
const names = (s) => String(s ?? "").split(",").map(key).filter(Boolean);
const label = (c) => `${c.artist ?? "Untitled"}${c.song ? ` – ${c.song}` : ""}`;
const refOf = (r) => `REQ-${String(r.ref).padStart(4, "0")}`;
const amountOf = (r) => (r.amount != null ? Number(r.amount) : r.videos != null && r.price_per_video != null ? Number(r.videos) * Number(r.price_per_video) : 0);

const row = (href, tag, title, sub, right) => `<a class="mw-row" href="${esc(href)}">
  <span class="mw-tag ${esc(tag[0])}">${esc(tag[1])}</span>
  <span class="mw-main"><b>${title}</b>${sub ? `<span class="muted small">${sub}</span>` : ""}</span>${right ? `<span class="mw-right">${right}</span>` : ""}</a>`;
const section = (title, count, body, extra = "") => `<section class="mw-sec"><div class="mw-head"><h2>${esc(title)}${count != null ? ` <span class="inv-count">${count}</span>` : ""}</h2>${extra}</div><div class="mw-list">${body}</div></section>`;

export async function renderMyWork(app, sb, { isCurrent }) {
  app.innerHTML = `<p class="muted pad">Loading your work…</p>`;
  const email = ((await sb.auth.getSession()).data.session?.user?.email ?? "").toLowerCase();
  const { data: me } = await sb.from("team_members").select("email,name,role").eq("email", email).maybeSingle();
  if (!isCurrent()) return;
  const myName = key(me?.name);
  const finance = ["admin", "finance"].includes(me?.role);

  const { data: all, error } = await sb.from("campaigns").select("id,artist,song,status,budget,currency,client,client_entity_id,comms_owner,campaign_runner,created_at,start_date,end_date");
  if (error) { app.innerHTML = `<p class="error pad">${esc(error.message)}</p>`; return; }
  const mine = (all ?? []).filter((c) => myName && (names(c.comms_owner).includes(myName) || names(c.campaign_runner).includes(myName)));
  const live = mine.filter((c) => c.status !== "finished");
  const ids = live.map((c) => c.id), byId = Object.fromEntries(mine.map((c) => [c.id, c]));
  const deckRows = await sb.from("decks").select("id,title").eq("created_by", email);
  const deckIds = (deckRows.data ?? []).map((d) => d.id);

  const [drafts, payouts, requests, moneyData, alerts, unreadN, access, finReqs] = await Promise.all([
    ids.length ? sb.from("creator_drafts").select("id,campaign_id").eq("status", "submitted").in("campaign_id", ids) : { data: [] },
    ids.length ? sb.from("payout_rows").select("campaign_id,status,amount,videos,price_per_video").in("campaign_id", ids) : { data: [] },
    sb.from("invoice_requests").select("id,ref,campaign_id,status,amount,currency,client,requested_by,requested_at,finance_note").in("status", ["requested", "returned"]),
    ids.length ? loadMoney(sb) : { invoices: {}, vendors: {}, plans: {} },
    sb.from("notifications").select("*").is("read_at", null).order("created_at", { ascending: false }).limit(5),
    sb.from("notifications").select("id", { count: "exact", head: true }).is("read_at", null),
    deckIds.length ? sb.from("deck_access_requests").select("id,deck_id,email,created_at").eq("status", "pending").in("deck_id", deckIds) : { data: [] },
    finance ? sb.from("invoice_requests").select("id,ref,campaign_id,amount,currency,client,requested_by,requested_at").eq("status", "requested").order("requested_at") : { data: [] },
  ]);
  if (!isCurrent()) return;

  // ----- Needs you now -----
  const need = [];
  const perCamp = (rows) => { const m = new Map(); for (const r of rows ?? []) m.set(r.campaign_id, [...(m.get(r.campaign_id) ?? []), r]); return m; };
  for (const [cid, list] of perCamp(drafts.data)) {
    const c = byId[cid]; if (!c) continue;
    need.push(row(`#/c/${cid}/creators`, ["draft", "Drafts"], `${plural(list.length, "draft", "drafts")} to review`, esc(label(c))));
  }
  for (const [cid, list] of perCamp((payouts.data ?? []).filter((r) => r.status === "posted"))) {
    const c = byId[cid]; if (!c) continue;
    const sum = list.reduce((t, r) => t + amountOf(r), 0);
    need.push(row(`#/c/${cid}/payouts`, ["pay", "Pay"], `${plural(list.length, "creator", "creators")} ready to pay${sum ? ` · ${esc(money(sum, c.currency))}` : ""}`, esc(label(c))));
  }
  for (const r of requests.data ?? []) {
    const c = byId[r.campaign_id];
    if (r.status !== "returned" || !(c || r.requested_by === email)) continue;
    need.push(row("#/invoices", ["back", "Sent back"], `${esc(refOf(r))} was sent back`, `${c ? `${esc(label(c))}` : esc(r.client ?? "")}${r.finance_note ? ` · “${esc(r.finance_note)}”` : ""}`, esc(money(r.amount, r.currency))));
  }
  // Parts of an invoice plan that are due and have no request yet (invoice-plan.js).
  for (const c of live) {
    for (const p of moneyData.plans?.[c.id]?.due ?? []) {
      need.push(row(`#/c/${c.id}`, ["todo", "Invoice due"], `Invoice due: ${esc(p.label || "a part")}`, esc(label(c)), esc(money(p.amount, p.effective_currency || c.currency))));
    }
  }
  for (const c of live) {
    for (const f of flagsFor(c, moneyData.invoices[c.id], moneyData.vendors[c.id], moneyData.plans?.[c.id])) {
      if (f.key === "returned" || f.key === "plan" || (f.who === "finance" && !finance)) continue;   // sent-back requests and due plan parts have their own rows
      need.push(row(f.act === "invoices" ? "#/invoices" : `#/c/${c.id}`, [f.who === "finance" ? "fin" : "todo", f.who === "finance" ? "Finance" : "To do"], f.text, esc(label(c))));
    }
  }
  const ended = live.filter((c) => ["active", "on_hold"].includes(c.status) && c.end_date && String(c.end_date).slice(0, 10) < todayIso())
    .sort((a, b) => String(b.end_date).localeCompare(String(a.end_date))).slice(0, 8);
  const wraps = await Promise.all(ended.map(async (c) => { const { data } = await sb.rpc("campaign_wrapup", { p_campaign: c.id }); return data?.summary ?? null; }));
  if (!isCurrent()) return;
  ended.forEach((c, i) => {
    const s = wraps[i];
    if (s?.all_done) return;
    const done = s ? Number(s.auto_ok ?? 0) + Number(s.manual_done ?? 0) : null, total = s ? Number(s.auto_total ?? 0) + Number(s.manual_total ?? 0) : null;
    need.push(row(`#/c/${c.id}`, ["wrap", "Wrap-up"], `${esc(label(c))} ended ${esc(dayLabel(c.end_date))}`, total ? `${done} of ${total} done` : "Close it out and mark it completed"));
  });
  const deckTitle = Object.fromEntries((deckRows.data ?? []).map((d) => [d.id, d.title]));
  for (const a of access.data ?? []) need.push(row(`#/decks/${a.deck_id}`, ["deck", "Deck"], `${esc(a.email)} asked to be let in`, esc(deckTitle[a.deck_id] ?? "A deck"), esc(ago(a.created_at))));

  // ----- Finance -----
  const fin = (finReqs.data ?? []).map((r) => {
    const c = (all ?? []).find((x) => x.id === r.campaign_id);
    return row("#/invoices", ["req", "Request"], esc(r.client || "No client"), `${esc(c ? label(c) : "Deleted campaign")} · ${esc(refOf(r))}`, `${esc(money(r.amount, r.currency))} <span class="muted small">${esc(ago(r.requested_at))}</span>`);
  });

  // ----- Alerts -----
  const al = (alerts.data ?? []).map((a) => `<a class="mw-row mw-alert" href="${esc(safeLink(a.link) || "#/me")}" data-read="${esc(a.id)}">
    <span class="bell-dot" aria-hidden="true"></span><span class="mw-main"><b>${esc(a.title)}</b>${a.body ? `<span class="muted small mw-clip">${esc(a.body)}</span>` : ""}</span><span class="mw-right muted small">${esc(ago(a.created_at))}</span></a>`);

  // ----- My campaigns (active) -----
  const act = live.filter((c) => c.status === "active").sort((a, b) => (a.end_date ?? "9999").localeCompare(b.end_date ?? "9999"));
  const pics = new Map();
  if (act.length) {
    const { data: arts } = await sb.from("artists").select("name_key,image_url").in("name_key", [...new Set(act.map((c) => key(c.artist)))]);
    for (const a of arts ?? []) if (a.image_url) pics.set(a.name_key, a.image_url);
  }
  if (!isCurrent()) return;
  const prog = {};
  for (const r of payouts.data ?? []) { const p = (prog[r.campaign_id] ??= { total: 0, done: 0 }); p.total++; if (["posted", "paid"].includes(r.status)) p.done++; }
  const camps = act.map((c) => {
    const p = prog[c.id], pic = pics.get(key(c.artist));
    return `<a class="mw-camp" href="#/c/${esc(c.id)}">
      <span class="mw-pic" aria-hidden="true">${pic ? `<img src="${esc(pic)}" alt="" width="44" height="44" loading="lazy" data-fail="hide">` : ""}</span>
      <span class="mw-main"><b>${esc(label(c))}</b><span class="muted small">${[c.client, c.end_date ? `ends ${dayLabel(c.end_date)}` : "no end date"].filter(Boolean).map(esc).join(" · ")}</span>
      ${p ? `<span class="mw-bar" role="img" aria-label="${p.done} of ${p.total} creators posted or paid"><i style="width:${Math.round((p.done / p.total) * 100)}%"></i></span>` : ""}</span>
      ${p ? `<span class="mw-right muted small">${p.done}/${p.total} posted</span>` : ""}</a>`;
  });

  const unread = unreadN.count ?? al.length;
  const body = [
    need.length ? section("Needs you now", need.length, need.join("")) : "",
    fin.length ? section("Invoice requests to handle", fin.length, fin.join("")) : "",
    al.length ? section("Unread alerts", unread, al.join(""), `<button type="button" class="link-btn small" id="mw-bell">Open all</button>`) : "",
    camps.length ? section("My campaigns", camps.length, camps.join("")) : "",
  ].join("");
  app.innerHTML = `<div class="page-head"><div><h1>My work</h1></div></div>
    ${body ? `<div class="mw">${need.length || fin.length ? "" : `<p class="muted mw-calm">Nothing needs you right now.</p>`}${body}</div>` : `<div class="panel"><p class="muted" style="margin:0">You're all caught up. Campaigns you run, and what needs you on them, will show up here.</p></div>`}`;
  app.querySelector("#mw-bell")?.addEventListener("click", openBell);
  app.querySelectorAll("[data-read]").forEach((a) => a.addEventListener("click", () => { sb.rpc("notifications_mark_read", { p_ids: [a.dataset.read] }); }));
}
