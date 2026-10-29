// Clients: one list of client companies (per team, e.g. "Warner Brasil", grouped under "Warner Music Group"),
// their people, their invoicing companies, and everything Stellar has done with them: campaigns in the OS,
// campaigns in the Campaign Overview sheet, invoices and deck views (viewers matched by email).
// Routes: #/clients, #/clients/<id>. Team only; the client-facing share function never reads these tables.
import { confirmDialog } from "./dialog.js?v=20261029c";
import { esc, flag, regionName } from "./report.js?v=20261029c";
import { statusPill } from "./invoices.js?v=20261029c";
import { statusLabel } from "./sheet-lists.js?v=20261029c";

export const MARKETS = ["West", "Central", "East"];
const TYPES = ["Major", "Indie", "Other"];
const money = (v, cur) => {
  if (v == null || v === "" || !Number.isFinite(Number(v))) return "–";
  try { return new Intl.NumberFormat("en", { style: "currency", currency: cur || "USD", maximumFractionDigits: 0 }).format(v); }
  catch { return `${Number(v).toLocaleString("en")} ${cur ?? ""}`.trim(); }
};
const num = (v) => { const x = parseFloat(String(v ?? "").replace(/,/g, "").replace(/[^0-9.\-]/g, "")); return Number.isFinite(x) ? x : null; };
const day = (d) => (d ? new Date(`${String(d).slice(0, 10)}T00:00:00`).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "–");
const mins = (ms) => { const s = Math.round((ms ?? 0) / 1000); return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`; };
const low = (s) => String(s ?? "").trim().toLowerCase();
const list = (s) => String(s ?? "").split(/[,\n]/).map((x) => x.trim()).filter(Boolean);
const domainOf = (email) => low(email).split("@")[1] ?? "";
const place = (cc) => (cc ? `${flag(cc)} ${esc(regionName(cc))}` : "–");
// Countries for the picker (ISO codes; the sheet uses a few of its own spellings, see SHEET_COUNTRY).
const COUNTRIES = (() => {
  try {
    const dn = new Intl.DisplayNames(["en"], { type: "region" }), out = [];
    for (let a = 65; a <= 90; a++) for (let b = 65; b <= 90; b++) {
      const code = String.fromCharCode(a, b), name = dn.of(code);
      if (name && name !== code && !/^(EU|EZ|UN|QO|XA|XB|ZZ)$/.test(code)) out.push([code, name]);
    }
    return out.sort((x, y) => x[1].localeCompare(y[1]));
  } catch { return []; }
})();
// Campaign form fields use the sheet's spellings.
export const SHEET_COUNTRY = { GB: "UK", AU: "AUS", ES: "SP" };
export const sheetMarket = (m) => (m ? `Stellar ${m}` : "");

// ---------- loading + matching (also used by the campaign form and Decks) ----------
export async function loadClients(sb) {
  const [c, g, p, e] = await Promise.all([
    sb.from("clients").select("*").order("name"),
    sb.from("client_groups").select("*").order("name"),
    sb.from("client_contacts").select("*").order("name"),
    sb.from("client_entities").select("*").order("legal_name"),
  ]);
  const err = c.error ?? g.error ?? p.error ?? e.error;
  if (err) throw err;
  const clients = c.data, groups = g.data, byId = new Map(clients.map((x) => [x.id, x])), groupById = new Map(groups.map((x) => [x.id, x]));
  for (const x of clients) { x.people = []; x.entities = []; x.group = groupById.get(x.group_id) ?? null; }
  for (const x of p.data) byId.get(x.client_id)?.people.push(x);
  for (const x of e.data) byId.get(x.client_id)?.entities.push(x);
  // Names and other spellings → client; email → person/client; domains → client or group.
  const byName = new Map(), byEntity = new Map(), byEmail = new Map(), byDomain = new Map(), groupByDomain = new Map();
  for (const x of clients) {
    for (const n of [x.name, ...x.aliases]) if (!byName.has(low(n))) byName.set(low(n), x);
    for (const en of x.entities) { const k = low(en.legal_name); byEntity.set(k, [...(byEntity.get(k) ?? []), x]); }
    for (const d of x.email_domains) byDomain.set(low(d), x);
    for (const pp of x.people) if (pp.email) byEmail.set(low(pp.email), { client: x, person: pp });
  }
  for (const gr of groups) for (const d of gr.email_domains) groupByDomain.set(low(d), gr);
  const findByName = (name) => byName.get(low(name)) ?? null;
  // A sheet row: its client name, unless its invoicing company belongs to another client
  // (e.g. "SONY" invoiced through Sony Music Singapore → Sony Singapore).
  const matchRow = (name, entity) => {
    const a = findByName(name), ents = byEntity.get(low(entity)) ?? [];
    if (a && (!ents.length || ents.includes(a))) return a;
    if (ents.length === 1) return ents[0];
    return a ?? ents[0] ?? null;
  };
  // A deck viewer: exact person first, then a domain only one client uses, then a shared group domain.
  const matchEmail = (email) => {
    const k = low(email);
    if (!k.includes("@")) return null;
    const hit = byEmail.get(k);
    if (hit) return { client: hit.client, person: hit.person, group: hit.client.group };
    const d = domainOf(k), cl = byDomain.get(d);
    if (cl) return { client: cl, person: null, group: cl.group };
    const gr = groupByDomain.get(d);
    return gr ? { client: null, person: null, group: gr } : null;
  };
  return { clients, groups, byId, groupById, findByName, matchRow, matchEmail };
}

// The Campaign Overview sheet's rows, read from the last sync.
export async function loadSheetRows(sb) {
  const { data } = await sb.from("overview_snapshot").select("headers,rows").limit(1).maybeSingle();
  if (!data?.headers) return [];
  const h = data.headers, col = (name) => h.findIndex((x) => low(x) === low(name));
  const ix = { status: col("Status"), artist: col("Artist Name"), song: col("Song Name (s) or Project Name"), client: col("Client"), entity: col("Invoicing Entity"),
    start: col("Start Date"), price: col("Price"), currency: col("Currency"), po: col("Stellar PO no."), invoice: col("Invoice Status"), type: col("Campaign Type"), dri: col("Stellar DRI") };
  const g = (r, k) => (ix[k] >= 0 ? String(r.values?.[ix[k]] ?? "").trim() : "");
  return (data.rows ?? []).map((r) => ({ row: r.row, status: g(r, "status"), artist: g(r, "artist"), song: g(r, "song"), client: g(r, "client"), entity: g(r, "entity"),
    start: g(r, "start"), price: num(g(r, "price")), currency: g(r, "currency"), po: g(r, "po"), invoice: g(r, "invoice"), type: g(r, "type"), dri: g(r, "dri") }))
    .filter((r) => r.artist || r.client);
}
const normPO = (po) => String(po ?? "").replace(/[^0-9a-z]/gi, "").toUpperCase();
const keyAS = (artist, song) => `${low(artist).normalize("NFD").replace(/[\u0300-\u036f]/g, "")}|${low(song)}`;
// Sheet rows already in the tracker (same PO, or same artist + song) are shown once, as tracker campaigns.
const inTracker = (os) => {
  const pos = new Set(os.map((x) => normPO(x.po_number)).filter(Boolean)), as = new Set(os.map((x) => keyAS(x.artist, x.song)));
  return (r) => (r.po && pos.has(normPO(r.po))) || as.has(keyAS(r.artist, r.song));
};

// ---------- a small form dialog ----------
// fields: [{ k, label, type: text|email|url|number|select|textarea|check, options: [[value,label]], hint, required, placeholder, wide }]
function formDialog({ title, intro = "", fields, values = {}, submit = "Save", onSubmit }) {
  return new Promise((resolve) => {
    const d = document.createElement("dialog");
    d.className = "po-dialog cl-dialog";
    const input = (f) => {
      const v = values[f.k] ?? "", id = `cf-${f.k}`;
      if (f.type === "select") return `<select id="${id}" data-k="${f.k}">${f.options.map(([val, lab]) => `<option value="${esc(val)}"${String(val) === String(v ?? "") ? " selected" : ""}>${esc(lab)}</option>`).join("")}</select>`;
      if (f.type === "textarea") return `<textarea id="${id}" data-k="${f.k}" rows="3" placeholder="${esc(f.placeholder ?? "")}">${esc(v)}</textarea>`;
      if (f.type === "check") return `<input id="${id}" data-k="${f.k}" type="checkbox"${v ? " checked" : ""}>`;
      return `<input id="${id}" data-k="${f.k}" type="${f.type ?? "text"}" value="${esc(v)}" placeholder="${esc(f.placeholder ?? "")}"${f.required ? " required" : ""}${f.type === "number" ? ' min="0" step="1"' : ""} autocomplete="off">`;
    };
    d.innerHTML = `<form method="dialog" novalidate><h2>${esc(title)}</h2>${intro ? `<p class="muted small">${intro}</p>` : ""}
      <div class="cl-form">${fields.map((f) => f.type === "check"
        ? `<label class="check cl-wide" for="cf-${f.k}">${input(f)} <span>${esc(f.label)}</span></label>`
        : `<label class="${f.wide || f.type === "textarea" ? "cl-wide" : ""}" for="cf-${f.k}" data-row="${f.k}"${f.hidden ? " hidden" : ""}>${esc(f.label)}${f.required ? " *" : ""}${input(f)}${f.hint ? `<span class="hint">${esc(f.hint)}</span>` : ""}</label>`).join("")}</div>
      <p class="small error" id="cf-err" hidden></p>
      <div class="actions"><button type="submit" class="primary" value="ok">${esc(submit)}</button><button type="button" value="cancel" id="cf-cancel">Cancel</button></div></form>`;
    document.body.append(d);
    const read = () => Object.fromEntries([...d.querySelectorAll("[data-k]")].map((el) => [el.dataset.k, el.type === "checkbox" ? el.checked : el.value.trim()]));
    const err = d.querySelector("#cf-err");
    let done = false;
    const finish = (v) => { if (done) return; done = true; resolve(v); d.close(); };
    d.querySelector("#cf-cancel").onclick = () => finish(null);
    d.addEventListener("close", () => { if (!done) { done = true; resolve(null); } setTimeout(() => d.remove(), 0); });
    d.querySelector("form").onsubmit = async (e) => {
      e.preventDefault();
      const v = read();
      const missing = fields.find((f) => f.required && !v[f.k]);
      if (missing) { err.textContent = `Fill in ${missing.label.toLowerCase()}.`; err.hidden = false; return; }
      const btn = d.querySelector("button[type=submit]"); btn.disabled = true;
      try { const r = onSubmit ? await onSubmit(v) : v; finish(r ?? v); }
      catch (x) { btn.disabled = false; err.textContent = x?.code === "23505" ? "A client with that name already exists." : (x?.message ?? String(x)); err.hidden = false; }
    };
    fields.forEach((f) => f.onChange && d.querySelector(`#cf-${f.k}`).addEventListener("change", (e) => f.onChange(e.target.value, d)));
    d.showModal();
  });
}
const marketOpts = [["", "Not set"], ...MARKETS.map((m) => [m, m])];
const typeOpts = [["", "Not set"], ...TYPES.map((t) => [t, t])];
const countryOpts = [["", "Not set"], ...COUNTRIES.map(([c, n]) => [c, `${n} (${c})`])];
const throwIf = ({ error }) => { if (error) throw error; };

async function clientDialog(sb, data, client = null) {
  const g = client?.group;
  const groupOpts = [["", "No group"], ...data.groups.map((x) => [x.id, x.name]), ["__new", "New group…"]];
  return formDialog({
    title: client ? `Edit ${client.name}` : "New client",
    intro: client ? "" : "A client is the team Stellar works with, e.g. Warner Brasil. Put teams of the same company in one group, e.g. Warner Music Group.",
    values: client ? { ...client, aliases: client.aliases.join(", "), email_domains: client.email_domains.join(", "), group_id: client.group_id ?? "", group_domains: g?.email_domains.join(", ") ?? "" } : {},
    fields: [
      { k: "name", label: "Name", required: true, placeholder: "e.g. Warner Brasil" },
      { k: "group_id", label: "Group", type: "select", options: groupOpts, onChange: (v, d) => { d.querySelector('[data-row="group_name"]').hidden = v !== "__new"; } },
      { k: "group_name", label: "Name of the new group", placeholder: "e.g. Warner Music Group", hidden: true },
      { k: "market", label: "Market", type: "select", options: marketOpts },
      { k: "country", label: "Country", type: "select", options: countryOpts },
      { k: "label_type", label: "Major, indie or other", type: "select", options: typeOpts },
      { k: "website", label: "Website", type: "url", placeholder: "https://" },
      { k: "aliases", label: "Other spellings", wide: true, placeholder: "e.g. Warner Brazil, WMG Brasil", hint: "How it's written in the Campaign Overview sheet. Campaigns with these names link to this client." },
      { k: "email_domains", label: "Email domains only this client uses", wide: true, placeholder: "e.g. because.tv", hint: "Deck viewers with these emails count as this client. Leave out shared ones like gmail.com." },
      ...(g ? [{ k: "group_domains", label: `Email domains of ${g.name}`, wide: true, placeholder: "e.g. warnermusic.com", hint: "Shared by all teams in the group: viewers with these emails count as the group." }] : []),
      { k: "notes", label: "Notes", type: "textarea" },
    ],
    onSubmit: async (v) => {
      let group_id = v.group_id || null;
      if (group_id === "__new") {
        if (!v.group_name) throw new Error("Give the new group a name.");
        const { data: ng, error } = await sb.from("client_groups").insert({ name: v.group_name }).select("id").single();
        if (error) throw error.code === "23505" ? new Error("That group already exists: pick it from the list.") : error;
        group_id = ng.id;
      }
      const row = { name: v.name, group_id, market: v.market || null, country: v.country || null, label_type: v.label_type || null, website: v.website || null,
        aliases: list(v.aliases).filter((a) => low(a) !== low(v.name)), email_domains: list(v.email_domains).map((x) => low(x).replace(/^@/, "")), notes: v.notes || null };
      if (g && v.group_domains !== undefined) throwIf(await sb.from("client_groups").update({ email_domains: list(v.group_domains).map((x) => low(x).replace(/^@/, "")) }).eq("id", g.id));
      if (client) { throwIf(await sb.from("clients").update(row).eq("id", client.id)); await sb.rpc("link_campaign_clients"); return { id: client.id }; }
      const me = (await sb.auth.getUser()).data.user?.email ?? null;
      const { data: nc, error } = await sb.from("clients").insert({ ...row, created_by: me }).select("id").single();
      if (error) throw error;
      await sb.rpc("link_campaign_clients");
      return { id: nc.id };
    },
  });
}

// ---------- #/clients ----------
const st = { q: "", market: "", group: "" };
export async function renderClients(app, sb, ctx) {
  if (ctx.parts[1]) return renderClient(app, sb, ctx, ctx.parts[1]);
  const { isCurrent, go, toast } = ctx;
  app.innerHTML = `<p class="muted pad">Loading clients…</p>`;
  let data;
  const [cl, sheet, camps, views] = await Promise.all([
    loadClients(sb).catch((e) => ({ error: e })), loadSheetRows(sb),
    sb.from("campaigns").select("id,client_id,po_number,artist,song"),
    sb.from("deck_sessions").select("email").not("email", "is", null).limit(5000),
  ]);
  if (!isCurrent()) return;
  if (cl.error) { app.innerHTML = `<div class="panel"><p class="warn-note">${esc(cl.error.message)}</p></div>`; return; }
  data = cl;
  const dupe = inTracker(camps.data ?? []);
  const count = {};
  for (const c of camps.data ?? []) if (c.client_id) count[c.client_id] = (count[c.client_id] ?? 0) + 1;
  const unmatched = new Map();
  for (const r of sheet) {
    if (dupe(r)) continue;
    const m = data.matchRow(r.client, r.entity);
    if (m) count[m.id] = (count[m.id] ?? 0) + 1;
    else if (r.client) unmatched.set(r.client, (unmatched.get(r.client) ?? 0) + 1);
  }
  const viewsBy = {};
  for (const v of views.data ?? []) { const m = data.matchEmail(v.email); if (m?.client) viewsBy[m.client.id] = (viewsBy[m.client.id] ?? 0) + 1; }
  const groupsUsed = data.groups.filter((g) => data.clients.some((c) => c.group_id === g.id));

  app.innerHTML = `
    <div class="page-head"><div><h1>Clients</h1>
      <p class="muted small" style="margin:6px 0 0">The teams Stellar works with, their people and invoicing details. Campaigns pick their client from here.</p></div>
      <button type="button" class="primary" id="cl-new">New client</button></div>
    ${unmatched.size ? `<details class="panel cl-unmatched"><summary><b>${[...unmatched.values()].reduce((a, b) => a + b, 0)} campaigns in the sheet</b> have a client name that isn't in the list yet</summary>
      <p class="small muted">Add the name as a new client, or open the right client and add it under <b>Other spellings</b>.</p>
      <ul class="cl-um">${[...unmatched].map(([n, k]) => `<li><span>${esc(n)} <span class="muted small">· ${k} campaign${k === 1 ? "" : "s"}</span></span><button type="button" class="link-btn" data-add="${esc(n)}">Add as client</button></li>`).join("")}</ul></details>` : ""}
    <div class="ov-bar cl-bar">
      <label class="ov-search"><svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="8.5" cy="8.5" r="5.5"/><path d="m13 13 4 4"/></svg><input id="cl-q" type="search" placeholder="Search clients, people or emails" aria-label="Search clients" value="${esc(st.q)}"></label>
      <select id="cl-market" class="ov-pill" aria-label="Market"><option value="">All markets</option>${MARKETS.map((m) => `<option${st.market === m ? " selected" : ""}>${m}</option>`).join("")}</select>
      ${groupsUsed.length ? `<select id="cl-group" class="ov-pill" aria-label="Group"><option value="">All groups</option>${groupsUsed.map((g) => `<option value="${esc(g.id)}"${st.group === g.id ? " selected" : ""}>${esc(g.name)}</option>`).join("")}<option value="none"${st.group === "none" ? " selected" : ""}>No group</option></select>` : ""}
    </div>
    <div id="cl-list"></div>`;

  const draw = () => {
    const q = low(st.q);
    const rows = data.clients.filter((c) => (!st.market || c.market === st.market) && (!st.group || (st.group === "none" ? !c.group_id : c.group_id === st.group))
      && (!q || [c.name, ...c.aliases, c.group?.name, ...c.people.flatMap((p) => [p.name, p.email]), ...c.entities.map((e) => e.legal_name)].some((x) => low(x).includes(q))));
    document.getElementById("cl-list").innerHTML = rows.length ? `<div class="table-wrap"><table class="cl-table"><thead><tr><th>Client</th><th class="cl-m">Group</th><th>Market</th><th class="cl-m">Country</th><th class="cl-m">Type</th><th class="num cl-m">People</th><th class="num">Campaigns</th><th class="num">Deck views</th></tr></thead><tbody>
      ${rows.map((c) => `<tr class="row-link" data-go="#/clients/${esc(c.id)}"><td><a href="#/clients/${esc(c.id)}"><b>${esc(c.name)}</b></a>${c.group ? `<div class="muted small cl-g">${esc(c.group.name)}</div>` : ""}${c.aliases.length ? `<div class="muted small">also ${esc(c.aliases.join(", "))}</div>` : ""}</td>
        <td class="cl-m">${esc(c.group?.name ?? "–")}</td><td>${esc(c.market ?? "–")}</td><td class="cl-m">${place(c.country)}</td><td class="cl-m">${esc(c.label_type ?? "–")}</td>
        <td class="num cl-m">${c.people.length}</td><td class="num">${count[c.id] ?? 0}</td><td class="num">${viewsBy[c.id] ?? 0}</td></tr>`).join("")}
      </tbody></table></div>` : `<section class="panel"><p class="muted">No clients match.</p></section>`;
    document.querySelectorAll("#cl-list tr[data-go]").forEach((tr) => (tr.onclick = (e) => { if (!e.target.closest("a")) go(tr.dataset.go); }));
  };
  draw();
  document.getElementById("cl-q").oninput = (e) => { st.q = e.target.value; draw(); };
  document.getElementById("cl-market").onchange = (e) => { st.market = e.target.value; draw(); };
  const gs = document.getElementById("cl-group"); if (gs) gs.onchange = (e) => { st.group = e.target.value; draw(); };
  const create = async () => {
    const r = await clientDialog(sb, data, null);
    if (r?.id) { toast("Client added"); go(`#/clients/${r.id}`); }
  };
  document.getElementById("cl-new").onclick = () => create();
  app.querySelectorAll("[data-add]").forEach((b) => (b.onclick = async () => {
    const name = b.dataset.add;
    const { data: nc, error } = await sb.from("clients").insert({ name, created_by: (await sb.auth.getUser()).data.user?.email ?? null }).select("id").single();
    if (error) return toast(error.code === "23505" ? "A client with that name already exists." : error.message);
    await sb.rpc("link_campaign_clients");
    toast(`${name} added: fill in its details`); go(`#/clients/${nc.id}`);
  }));
}

// ---------- #/clients/<id> ----------
async function renderClient(app, sb, ctx, id) {
  const { isCurrent, go, toast } = ctx;
  app.innerHTML = `<p class="muted pad">Loading…</p>`;
  const [cl, sheet, camps] = await Promise.all([
    loadClients(sb).catch((e) => ({ error: e })), loadSheetRows(sb),
    sb.from("campaigns").select("id,artist,song,status,start_date,end_date,budget,currency,po_number,client_id").eq("client_id", id).order("start_date", { ascending: false, nullsFirst: false }),
  ]);
  if (!isCurrent()) return;
  if (cl.error) { app.innerHTML = `<div class="panel"><p class="warn-note">${esc(cl.error.message)}</p></div>`; return; }
  const data = cl, c = data.byId.get(id);
  if (!c) { app.innerHTML = `<div class="panel"><p>This client doesn't exist any more. It may have been merged into another one.</p><p><a href="#/clients">All clients</a></p></div>`; return; }
  const os = camps.data ?? [];
  const dupe = inTracker((await sb.from("campaigns").select("po_number,artist,song")).data ?? []);
  const fromSheet = sheet.filter((r) => !dupe(r) && data.matchRow(r.client, r.entity) === c);
  const ids = os.map((x) => x.id);
  const [inv, views, decks] = await Promise.all([
    ids.length ? sb.from("invoice_requests").select("id,ref,campaign_id,status,amount,currency,invoice_number,due_date,requested_at").in("campaign_id", ids).order("requested_at", { ascending: false }) : { data: [] },
    sb.from("deck_sessions").select("id,deck_id,email,started_at,total_ms,furthest_slide,slide_count,verified").not("email", "is", null).order("started_at", { ascending: false }).limit(5000),
    sb.from("decks").select("id,title"),
  ]);
  if (!isCurrent()) return;
  const deckName = Object.fromEntries((decks.data ?? []).map((d) => [d.id, d.title]));
  const myViews = (views.data ?? []).map((v) => ({ ...v, m: data.matchEmail(v.email) })).filter((v) => v.m?.client === c);
  const groupViews = c.group ? (views.data ?? []).filter((v) => { const m = data.matchEmail(v.email); return m && !m.client && m.group === c.group; }).length : 0;
  const campName = Object.fromEntries(os.map((x) => [x.id, `${x.artist}${x.song ? ` · ${x.song}` : ""}`]));
  const siblings = c.group ? data.clients.filter((x) => x.group_id === c.group_id && x !== c) : [];

  app.innerHTML = `
    <div class="page-head cl-head"><div>
      <h1>${esc(c.name)}</h1>
      <div class="cl-chips">${c.group ? `<span class="cl-chip">${esc(c.group.name)}</span>` : ""}${c.market ? `<span class="cl-chip">${esc(c.market)}</span>` : ""}${c.country ? `<span class="cl-chip">${place(c.country)}</span>` : ""}${c.label_type ? `<span class="cl-chip">${esc(c.label_type)}</span>` : ""}${c.website ? `<a class="cl-chip" href="${esc(c.website)}" target="_blank" rel="noopener">Website ↗</a>` : ""}</div>
      ${c.aliases.length ? `<p class="muted small" style="margin:8px 0 0">Also written as ${esc(c.aliases.join(", "))}</p>` : ""}
    </div>
    <div class="cl-actions"><button type="button" id="cl-edit">Edit</button>
      <details class="ro-more cl-more"><summary aria-label="More options" title="More options">⋯</summary>
        <div class="ro-more-pop"><button type="button" id="cl-merge">Merge into another client</button><button type="button" id="cl-del" class="danger-lite">Delete client</button></div></details></div></div>
    <div class="stats cl-stats">
      <div class="stat"><div class="n">${os.length + fromSheet.length}</div><div class="l">Campaigns</div></div>
      <div class="stat"><div class="n">${(inv.data ?? []).filter((r) => ["requested", "returned", "invoiced"].includes(r.status)).length}</div><div class="l">Open invoices</div></div>
      <div class="stat"><div class="n">${myViews.length}</div><div class="l">Deck views</div></div>
      <div class="stat"><div class="n">${c.people.length}</div><div class="l">People</div></div>
    </div>
    ${c.notes ? `<section class="panel cl-notes"><p>${esc(c.notes).replace(/\n/g, "<br>")}</p></section>` : ""}

    <section class="cl-sec"><div class="cl-sec-head"><h2>People</h2><button type="button" id="cl-addp">Add person</button></div>
      ${c.people.length ? `<div class="table-wrap"><table><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Market</th><th></th></tr></thead><tbody>
        ${c.people.map((p) => `<tr><td><b>${esc(p.name || "–")}</b>${p.notes ? `<div class="muted small">${esc(p.notes)}</div>` : ""}</td><td>${p.email ? `<a href="mailto:${esc(p.email)}">${esc(p.email)}</a>` : "–"}${p.phone ? `<div class="muted small">${esc(p.phone)}</div>` : ""}</td><td>${esc(p.role || "–")}</td><td>${esc(p.market || "–")}</td>
          <td class="cl-row-act"><button type="button" class="link-btn" data-editp="${esc(p.id)}">Edit</button> <button type="button" class="link-btn danger" data-delp="${esc(p.id)}">Remove</button></td></tr>`).join("")}
      </tbody></table></div>` : `<p class="muted small">No people yet.</p>`}</section>

    <section class="cl-sec"><div class="cl-sec-head"><h2>Invoicing companies</h2><button type="button" id="cl-adde">Add company</button></div>
      ${c.entities.length ? `<div class="table-wrap"><table><thead><tr><th>Legal name</th><th>Country</th><th>VAT number</th><th>Invoice email</th><th>Terms</th><th></th></tr></thead><tbody>
        ${c.entities.map((e) => `<tr><td><b>${esc(e.legal_name)}</b>${e.address ? `<div class="muted small cl-addr">${esc(e.address)}</div>` : ""}${e.uses_portal ? `<div class="small">Upload to ${esc(e.portal_name || "their portal")}</div>` : ""}${e.notes ? `<div class="muted small">${esc(e.notes)}</div>` : ""}</td>
          <td>${place(e.country)}</td><td>${esc(e.vat_number || "–")}</td><td>${e.invoice_email ? `<a href="mailto:${esc(e.invoice_email)}">${esc(e.invoice_email)}</a>` : "–"}</td><td>${e.payment_terms != null ? `${e.payment_terms} days` : "–"}${e.currency ? `<div class="muted small">${esc(e.currency)}</div>` : ""}</td>
          <td class="cl-row-act"><button type="button" class="link-btn" data-edite="${esc(e.id)}">Edit</button> <button type="button" class="link-btn danger" data-dele="${esc(e.id)}">Remove</button></td></tr>`).join("")}
      </tbody></table></div>` : `<p class="muted small">No invoicing company yet.</p>`}</section>

    <section class="cl-sec"><div class="cl-sec-head"><h2>Campaigns</h2><a class="btn" href="#/new">New campaign</a></div>
      ${os.length || fromSheet.length ? `<div class="table-wrap"><table><thead><tr><th>Artist</th><th>Song or project</th><th>Status</th><th>Start</th><th class="num">Price</th><th>PO</th><th></th></tr></thead><tbody>
        ${os.map((x) => `<tr class="row-link" data-go="#/c/${esc(x.id)}"><td><a href="#/c/${esc(x.id)}"><b>${esc(x.artist)}</b></a></td><td>${esc(x.song || "–")}</td><td>${esc(statusLabel(x.status) || "–")}</td><td>${day(x.start_date)}</td><td class="num">${money(x.budget, x.currency)}</td><td>${esc(x.po_number || "–")}</td><td class="muted small">Tracker</td></tr>`).join("")}
        ${fromSheet.map((r) => `<tr><td><b>${esc(r.artist || "–")}</b></td><td>${esc(r.song || "–")}</td><td>${esc(r.status || "–")}</td><td>${esc(r.start || "–")}</td><td class="num">${money(r.price, r.currency)}</td><td>${esc(r.po || "–")}</td><td class="muted small">Sheet row ${esc(r.row)}</td></tr>`).join("")}
      </tbody></table></div>` : `<p class="muted small">No campaigns yet.</p>`}</section>

    <section class="cl-sec"><div class="cl-sec-head"><h2>Invoices</h2></div>
      ${(inv.data ?? []).length ? `<div class="table-wrap"><table><thead><tr><th>Request</th><th>Campaign</th><th class="num">Amount</th><th>Status</th><th>Invoice</th><th>Due</th></tr></thead><tbody>
        ${inv.data.map((r) => `<tr class="row-link" data-go="#/invoices"><td>REQ-${String(r.ref).padStart(4, "0")}</td><td>${esc(campName[r.campaign_id] ?? "–")}</td><td class="num">${money(r.amount, r.currency)}</td><td>${statusPill(r)}</td><td>${esc(r.invoice_number || "–")}</td><td>${day(r.due_date)}</td></tr>`).join("")}
      </tbody></table></div>` : `<p class="muted small">No invoices requested in the OS yet. Invoices from before the OS are in the sheet's invoice columns.</p>`}</section>

    <section class="cl-sec"><div class="cl-sec-head"><h2>Deck views</h2></div>
      ${myViews.length ? `<div class="table-wrap"><table><thead><tr><th>Viewer</th><th>Deck</th><th>When</th><th class="num">Time spent</th><th class="num">Slides seen</th></tr></thead><tbody>
        ${myViews.slice(0, 100).map((v) => `<tr class="row-link" data-go="#/decks/${esc(v.deck_id)}"><td><b>${esc(v.m.person?.name || v.email)}</b>${v.m.person?.name ? `<div class="muted small">${esc(v.email)}</div>` : ""}${v.verified ? ` <span class="dk-ok">✓ checked</span>` : ""}</td><td>${esc(deckName[v.deck_id] ?? "Deck")}</td><td>${day(v.started_at)}</td><td class="num">${mins(v.total_ms)}</td><td class="num">${v.furthest_slide ?? 0}${v.slide_count ? ` of ${v.slide_count}` : ""}</td></tr>`).join("")}
      </tbody></table></div>` : `<p class="muted small">Nobody from ${esc(c.name)} has opened a deck yet. Viewers are matched by their email: a person's exact email, or one of the client's email domains.</p>`}
      ${groupViews ? `<p class="muted small">${groupViews} more view${groupViews === 1 ? "" : "s"} from ${esc(c.group.name)} emails that can't be pinned to one team.</p>` : ""}
    </section>
    ${siblings.length ? `<section class="cl-sec"><h2>Also in ${esc(c.group.name)}</h2><p class="cl-sibs">${siblings.map((x) => `<a class="cl-chip" href="#/clients/${esc(x.id)}">${esc(x.name)}</a>`).join("")}</p></section>` : ""}`;

  const reload = () => renderClient(app, sb, ctx, id);
  app.querySelectorAll("tr[data-go]").forEach((tr) => (tr.onclick = (e) => { if (!e.target.closest("a,button")) go(tr.dataset.go); }));
  document.getElementById("cl-edit").onclick = async () => { if (await clientDialog(sb, data, c)) { toast("Saved"); reload(); } };
  const personDialog = (p = null) => formDialog({
    title: p ? "Edit person" : `Add someone at ${c.name}`, values: p ?? { market: c.market ?? "" },
    fields: [{ k: "name", label: "Name" }, { k: "email", label: "Email", type: "email" }, { k: "role", label: "Role", placeholder: "e.g. Digital marketing manager" },
      { k: "market", label: "Market", type: "select", options: marketOpts }, { k: "phone", label: "Phone or WhatsApp" }, { k: "notes", label: "Notes", type: "textarea" }],
    onSubmit: async (v) => {
      if (!v.name && !v.email) throw new Error("Add a name or an email.");
      if (v.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v.email)) throw new Error("That email doesn't look right.");
      const row = { name: v.name || null, email: v.email ? low(v.email) : null, role: v.role || null, market: v.market || null, phone: v.phone || null, notes: v.notes || null };
      throwIf(p ? await sb.from("client_contacts").update(row).eq("id", p.id) : await sb.from("client_contacts").insert({ ...row, client_id: c.id }));
    },
  });
  const entityDialog = (e = null) => formDialog({
    title: e ? "Edit invoicing company" : "Add invoicing company", values: e ?? { country: c.country ?? "" },
    intro: e ? "" : "The legal company Stellar sends the invoice to.",
    fields: [{ k: "legal_name", label: "Legal name", required: true, wide: true }, { k: "country", label: "Country", type: "select", options: countryOpts },
      { k: "vat_number", label: "VAT or tax number" }, { k: "address", label: "Address", type: "textarea" }, { k: "invoice_email", label: "Send invoices to", type: "email" },
      { k: "payment_terms", label: "Payment terms (days)", type: "number", placeholder: "e.g. 30" }, { k: "currency", label: "Currency", placeholder: "e.g. USD" },
      { k: "uses_portal", label: "Invoices are uploaded to their own portal", type: "check" }, { k: "portal_name", label: "Portal name", placeholder: "e.g. Coupa" }, { k: "notes", label: "Notes", type: "textarea" }],
    onSubmit: async (v) => {
      const cur = v.currency.toUpperCase();
      if (cur && !/^[A-Z]{3}$/.test(cur)) throw new Error("Currency must be a three-letter code, such as EUR or USD.");
      const terms = v.payment_terms === "" ? null : Number(v.payment_terms);
      if (terms != null && !(Number.isInteger(terms) && terms >= 0 && terms <= 365)) throw new Error("Payment terms must be a number of days.");
      const row = { legal_name: v.legal_name, country: v.country || null, vat_number: v.vat_number || null, address: v.address || null, invoice_email: v.invoice_email || null,
        payment_terms: terms, currency: cur || null, uses_portal: v.uses_portal, portal_name: v.portal_name || null, notes: v.notes || null };
      throwIf(e ? await sb.from("client_entities").update(row).eq("id", e.id) : await sb.from("client_entities").insert({ ...row, client_id: c.id }));
    },
  });
  document.getElementById("cl-addp").onclick = async () => { if (await personDialog()) reload(); };
  document.getElementById("cl-adde").onclick = async () => { if (await entityDialog()) reload(); };
  app.querySelectorAll("[data-editp]").forEach((b) => (b.onclick = async () => { if (await personDialog(c.people.find((p) => p.id === b.dataset.editp))) reload(); }));
  app.querySelectorAll("[data-edite]").forEach((b) => (b.onclick = async () => { if (await entityDialog(c.entities.find((e) => e.id === b.dataset.edite))) reload(); }));
  app.querySelectorAll("[data-delp]").forEach((b) => (b.onclick = async () => {
    const p = c.people.find((x) => x.id === b.dataset.delp);
    if (!(await confirmDialog({ title: `Remove ${p.name || p.email}?`, body: `They're removed from ${esc(c.name)}'s people. Campaigns keep the contact details they already have.`, confirm: "Remove" }))) return;
    const { error } = await sb.from("client_contacts").delete().eq("id", p.id);
    if (error) return toast(error.message);
    reload();
  }));
  app.querySelectorAll("[data-dele]").forEach((b) => (b.onclick = async () => {
    const e = c.entities.find((x) => x.id === b.dataset.dele);
    if (!(await confirmDialog({ title: `Remove ${e.legal_name}?`, body: "Campaigns and invoices keep the company name they already have.", confirm: "Remove" }))) return;
    const { error } = await sb.from("client_entities").delete().eq("id", e.id);
    if (error) return toast(error.message);
    reload();
  }));
  document.getElementById("cl-merge").onclick = async () => {
    app.querySelector(".cl-more").open = false;
    const others = data.clients.filter((x) => x !== c);
    const v = await formDialog({
      title: `Merge ${c.name} into…`, submit: "Continue",
      intro: `Pick the client to keep. ${esc(c.name)}'s people, invoicing companies and campaigns move there, and "${esc(c.name)}" becomes one of its other spellings.`,
      fields: [{ k: "into", label: "Client to keep", type: "select", options: [["", "Choose a client"], ...others.map((x) => [x.id, x.group ? `${x.name} (${x.group.name})` : x.name])] }],
      onSubmit: async (val) => { if (!val.into) throw new Error("Choose a client."); },
    });
    if (!v?.into) return;
    const into = data.byId.get(v.into);
    if (!(await confirmDialog({ title: `Merge ${c.name} into ${into.name}?`, body: `${esc(c.name)} disappears from the list and everything moves to ${esc(into.name)}. This can't be undone.`, confirm: "Merge" }))) return;
    const { error } = await sb.rpc("merge_clients", { p_from: c.id, p_into: into.id });
    if (error) return toast(error.message);
    toast(`Merged into ${into.name}`); go(`#/clients/${into.id}`);
  };
  document.getElementById("cl-del").onclick = async () => {
    app.querySelector(".cl-more").open = false;
    if (!(await confirmDialog({ title: `Delete ${c.name}?`, body: `Its people and invoicing companies are deleted too. ${os.length ? `Its ${os.length} campaign${os.length === 1 ? "" : "s"} stay, without a client link.` : ""} If it's a duplicate, use Merge instead.` }))) return;
    const { error } = await sb.from("clients").delete().eq("id", c.id);
    if (error) return toast(error.message);
    toast("Client deleted"); go("#/clients");
  };
}
