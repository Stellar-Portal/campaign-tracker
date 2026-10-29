// Import creators into the roster from a CSV file (e.g. a Google Sheet downloaded as CSV).
// Each row needs a handle or a profile link; platform, name, country, email, notes and followers are optional.
// Rows are added through the import_creators database function: no credits are used. Their numbers are
// fetched by the nightly roster refresh, or straight away if the person ticks "Fetch their numbers now".
import { PLATFORMS, PLATFORM_ORDER } from "./platforms.js?v=20261029b";

const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const CREDITS = { tiktok: 3, instagram: 1, twitter: 1, twitch: 1, youtube: 0 };   // per creator, when fetched now

// ---------- CSV ----------
export function parseCsv(text) {
  text = String(text ?? "").replace(/^﻿/, "");
  const firstLine = text.split(/\r?\n/, 1)[0] ?? "";
  const count = (ch) => (firstLine.match(new RegExp(`\\${ch}`, "g")) ?? []).length;
  const delim = [",", ";", "\t"].sort((a, b) => count(b) - count(a))[0];
  const rows = [];
  let row = [], cell = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; }
      else cell += c;
    } else if (c === '"' && cell === "") q = true;
    else if (c === delim) { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); cell = "";
      if (row.some((x) => x.trim() !== "")) rows.push(row);
      row = [];
    } else cell += c;
  }
  row.push(cell);
  if (row.some((x) => x.trim() !== "")) rows.push(row);
  return rows.map((r) => r.map((x) => x.trim()));
}

// Which column holds what, guessed from the header names.
const GUESS = [
  ["handle", /^(@|handle|user ?name|username|account|creator|creator handle|tiktok|instagram|ig|youtube|yt|x|twitter|twitch|profile|profile ?link|profile ?url|link|url|channel)$/i],
  ["platform", /^(platform|network|social|social network|channel type)$/i],
  ["name", /^(name|full ?name|display ?name|creator ?name|real ?name)$/i],
  ["country", /^(country|market|location|region|country code|geo)$/i],
  ["email", /(e-?mail)/i],
  ["notes", /^(notes?|comments?|remarks?|info)$/i],
  ["followers", /(followers?|subscribers?|subs)$/i],
];
const FIELDS = [["handle", "Handle or profile link"], ["platform", "Platform"], ["name", "Name"], ["country", "Country"], ["email", "Email"], ["notes", "Notes"], ["followers", "Followers"]];
function guessColumns(header) {
  const map = {};
  for (const [field, re] of GUESS) {
    const i = header.findIndex((h, j) => re.test(h.trim()) && !Object.values(map).includes(j));
    if (i >= 0) map[field] = i;
  }
  // No handle column by name: take the first column that looks like handles or links.
  return map;
}

// ---------- one row → { platform, handle } ----------
const PF_ALIASES = { tiktok: "tiktok", tt: "tiktok", "tik tok": "tiktok", instagram: "instagram", ig: "instagram", insta: "instagram",
  youtube: "youtube", yt: "youtube", "youtube shorts": "youtube", x: "twitter", twitter: "twitter", twitch: "twitch" };
function fromLink(raw) {
  let u;
  try { u = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`); } catch { return null; }
  const host = u.hostname.toLowerCase().replace(/^(www|m|mobile|vm|vt)\./, "");
  const seg = u.pathname.split("/").filter(Boolean).map((s) => { try { return decodeURIComponent(s); } catch { return s; } });
  if (/(^|\.)tiktok\.com$/.test(host)) {
    const at = u.pathname.match(/\/@([^/?#]+)/);
    return at ? { platform: "tiktok", handle: at[1] } : { error: "TikTok short or video link without the @name" };
  }
  if (host === "instagram.com") return seg[0] && !["p", "reel", "reels", "tv", "stories", "explore"].includes(seg[0]) ? { platform: "instagram", handle: seg[0] } : { error: "Instagram post link, not a profile" };
  if (host === "x.com" || host === "twitter.com") return seg[0] && !["i", "home", "search", "hashtag"].includes(seg[0]) ? { platform: "twitter", handle: seg[0] } : { error: "Not an X profile link" };
  if (host === "twitch.tv") return seg[0] && !["videos", "directory"].includes(seg[0]) ? { platform: "twitch", handle: seg[0] } : { error: "Not a Twitch channel link" };
  if (host === "youtube.com" || host === "youtu.be") {
    if (seg[0]?.startsWith("@")) return { platform: "youtube", handle: seg[0].slice(1) };
    if (seg[0] === "channel" && seg[1]) return { platform: "youtube", handle: seg[1] };
    return { error: "YouTube video link: use the channel link (youtube.com/@name)" };
  }
  return null;
}
const COUNTRY = (() => {
  const out = {};
  try {
    const dn = new Intl.DisplayNames(["en"], { type: "region" });
    for (let a = 65; a <= 90; a++) for (let b = 65; b <= 90; b++) {
      const code = String.fromCharCode(a, b), name = dn.of(code);
      if (name && name !== code) out[name.toLowerCase()] = code;
    }
  } catch { /* old browser */ }
  Object.assign(out, { usa: "US", "united states of america": "US", us: "US", uk: "GB", "great britain": "GB", england: "GB", korea: "KR", "south korea": "KR", uae: "AE", vietnam: "VN", russia: "RU", "czech republic": "CZ", turkey: "TR" });
  return out;
})();
function countryCode(v) {
  const s = String(v ?? "").trim();
  if (!s) return "";
  if (/^[A-Za-z]{2}$/.test(s)) return s.toUpperCase().replace(/^UK$/, "GB");
  return COUNTRY[s.toLowerCase()] ?? "";
}
function followers(v) {
  const s = String(v ?? "").trim().toLowerCase().replace(/[\s,]/g, "");
  const m = s.match(/^(\d+(?:\.\d+)?)([km])?$/);
  if (!m) return "";
  return String(Math.round(Number(m[1]) * (m[2] === "m" ? 1e6 : m[2] === "k" ? 1e3 : 1)));
}
function readRow(cells, map, defaultPf) {
  const get = (f) => (map[f] != null ? String(cells[map[f]] ?? "").trim() : "");
  const raw = get("handle");
  if (!raw) return { error: "No handle" };
  let platform = PF_ALIASES[get("platform").toLowerCase()] ?? null, handle;
  const looksLink = /^https?:\/\//i.test(raw) || /^(www\.|m\.|vm\.|vt\.)?(tiktok|instagram|youtube|youtu|x|twitter|twitch)\.(com|be|tv)\//i.test(raw);
  if (looksLink) {
    const r = fromLink(raw);
    if (!r) return { error: "Link isn't from TikTok, Instagram, YouTube, X or Twitch" };
    if (r.error) return { error: r.error };
    ({ platform, handle } = r);
  } else {
    handle = raw.replace(/^@/, "").trim();
    platform = platform ?? defaultPf;
  }
  if (!/^[A-Za-z0-9._\-]{1,100}$/.test(handle)) return { error: `"${raw.slice(0, 40)}" isn't a handle` };
  if (platform !== "youtube") handle = handle.toLowerCase();
  return { platform, handle, name: get("name"), country: countryCode(get("country")), email: /@/.test(get("email")) ? get("email") : "",
    notes: get("notes"), followers: followers(get("followers")) };
}

// ---------- the dialog ----------
export function openCreatorImport(sb, { lists = [], existing = [], toast, onDone, invoke }) {
  const known = new Map(existing.map((c) => [`${c.platform}:${String(c.username).toLowerCase()}`, c]));
  const d = document.createElement("dialog");
  d.className = "po-dialog ci-dialog";
  document.body.append(d);
  let rows = [], header = [], map = {}, defaultPf = "tiktok", fileName = "";

  const step1 = () => {
    d.innerHTML = `<form method="dialog">
      <h2>Import creators from a CSV</h2>
      <p class="muted small">One creator per row. The file needs a column with their <b>@handle</b> or <b>profile link</b>. It can also have platform, name, country, email, notes and followers. From Google Sheets: <b>File → Download → Comma-separated values (.csv)</b>.</p>
      <label class="ci-drop" id="ci-drop"><input type="file" accept=".csv,text/csv,text/plain" id="ci-file"><span><b>Choose a CSV file</b> or drop it here</span></label>
      <p class="small error" id="ci-err" hidden></p>
      <p class="small muted">No credits are used to import. Numbers (followers, views, engagement) fill in overnight, or straight away if you choose to on the next step.</p>
      <div class="actions"><button type="submit" value="cancel">Cancel</button></div></form>`;
    const input = d.querySelector("#ci-file"), drop = d.querySelector("#ci-drop"), err = d.querySelector("#ci-err");
    const take = async (file) => {
      if (!file) return;
      if (file.size > 5 * 1024 * 1024) { err.textContent = "That file is over 5 MB. Split it into smaller files."; err.hidden = false; return; }
      const all = parseCsv(await file.text());
      if (all.length < 2) { err.textContent = "The file needs a header row and at least one creator."; err.hidden = false; return; }
      fileName = file.name; header = all[0]; rows = all.slice(1, 5001);
      map = guessColumns(header);
      if (map.handle == null) {
        const i = header.findIndex((_, j) => rows.slice(0, 20).filter((r) => /^@|tiktok\.com|instagram\.com|youtube\.com|x\.com|twitter\.com|twitch\.tv/i.test(r[j] ?? "")).length >= 2);
        if (i >= 0) map.handle = i;
      }
      step2();
    };
    input.onchange = () => take(input.files?.[0]);
    drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
    drop.addEventListener("dragleave", () => drop.classList.remove("over"));
    drop.addEventListener("drop", (e) => { e.preventDefault(); drop.classList.remove("over"); take(e.dataTransfer?.files?.[0]); });
  };

  const analyse = () => {
    const seen = new Set(), ok = [], bad = [];
    let already = 0;
    rows.forEach((cells, i) => {
      const r = readRow(cells, map, defaultPf);
      if (r.error) { bad.push({ line: i + 2, why: r.error }); return; }
      const k = `${r.platform}:${r.handle.toLowerCase()}`;
      if (seen.has(k)) { bad.push({ line: i + 2, why: `@${r.handle} appears twice` }); return; }
      seen.add(k);
      if (known.has(k)) { already++; r.known = true; }
      ok.push(r);
    });
    return { ok, bad, already };
  };

  const step2 = () => {
    const a = analyse();
    const pf = [...new Set(a.ok.filter((r) => !r.known).map((r) => r.platform))];
    const fresh = a.ok.filter((r) => !r.known);
    const credits = fresh.reduce((t, r) => t + (CREDITS[r.platform] ?? 1), 0);
    const opt = (f) => `<option value="">Not in the file</option>${header.map((h, i) => `<option value="${i}"${map[f] === i ? " selected" : ""}>${esc(h || `Column ${i + 1}`)}</option>`).join("")}`;
    d.innerHTML = `<form method="dialog">
      <h2>Import creators</h2>
      <p class="muted small">${esc(fileName)} · ${rows.length} row${rows.length === 1 ? "" : "s"}. Check which column is which:</p>
      <div class="ci-map">${FIELDS.map(([f, label]) => `<label>${label}${f === "handle" ? " *" : ""}<select data-f="${f}">${opt(f)}</select></label>`).join("")}
        <label>Platform for bare @handles<select id="ci-pf">${PLATFORM_ORDER.map((p) => `<option value="${p}"${p === defaultPf ? " selected" : ""}>${PLATFORMS[p].name}</option>`).join("")}</select></label></div>
      <div class="ci-sum">
        <span><b>${a.ok.length - a.already}</b> new</span>
        <span><b>${a.already}</b> already on the roster</span>
        <span class="${a.bad.length ? "warn" : ""}"><b>${a.bad.length}</b> skipped</span>
      </div>
      ${a.bad.length ? `<details class="ci-bad"><summary class="small">Why some rows are skipped</summary><ul class="small">${a.bad.slice(0, 30).map((b) => `<li>Row ${b.line}: ${esc(b.why)}</li>`).join("")}${a.bad.length > 30 ? `<li>…and ${a.bad.length - 30} more</li>` : ""}</ul></details>` : ""}
      ${a.ok.length ? `<div class="table-wrap ci-prev"><table><thead><tr><th>Creator</th><th>Platform</th><th>Name</th><th>Country</th><th>Email</th><th></th></tr></thead><tbody>
        ${a.ok.slice(0, 8).map((r) => `<tr><td>@${esc(r.handle)}</td><td>${esc(PLATFORMS[r.platform]?.name ?? r.platform)}</td><td>${esc(r.name)}</td><td>${esc(r.country)}</td><td>${esc(r.email)}</td><td class="muted small">${r.known ? "already on the roster" : "new"}</td></tr>`).join("")}
      </tbody></table></div>${a.ok.length > 8 ? `<p class="small muted" style="margin:6px 0 0">…and ${a.ok.length - 8} more</p>` : ""}` : ""}
      <label>Also add them to a list
        <select id="ci-list"><option value="">No list</option>${lists.map((l) => `<option value="${esc(l.id)}">${esc(l.name)}</option>`).join("")}<option value="__new">New list…</option></select></label>
      <label id="ci-newlist-l" hidden>Name of the new list <input id="ci-newlist" maxlength="80" placeholder="e.g. Football edits · Brazil"></label>
      ${fresh.length ? `<label class="check ci-now"><input type="checkbox" id="ci-now"> <span>Fetch their numbers now <span class="muted small" style="font-weight:400">(about ${credits} ScrapeCreators credit${credits === 1 ? "" : "s"}, roughly $${(credits * 0.0019).toFixed(2)}, and ${Math.ceil(fresh.length * 8 / 60)} min. Otherwise they fill in over the next nights${pf.includes("youtube") ? "; YouTube is free" : ""}.)</span></span></label>` : ""}
      <p class="small error" id="ci-err" hidden></p>
      <div class="actions"><button type="button" class="primary" id="ci-go"${a.ok.length && map.handle != null ? "" : " disabled"}>Import ${a.ok.length} creator${a.ok.length === 1 ? "" : "s"}</button><button type="button" id="ci-back">Choose another file</button><button type="submit" value="cancel">Cancel</button></div></form>`;
    d.querySelectorAll("[data-f]").forEach((s) => (s.onchange = () => { const v = s.value; if (v === "") delete map[s.dataset.f]; else map[s.dataset.f] = Number(v); step2(); }));
    d.querySelector("#ci-pf").onchange = (e) => { defaultPf = e.target.value; step2(); };
    d.querySelector("#ci-back").onclick = step1;
    const listSel = d.querySelector("#ci-list");
    listSel.onchange = () => { d.querySelector("#ci-newlist-l").hidden = listSel.value !== "__new"; };
    d.querySelector("#ci-go").onclick = () => run(a, listSel.value, d.querySelector("#ci-newlist")?.value.trim(), d.querySelector("#ci-now")?.checked);
  };

  async function run(a, listChoice, newListName, fetchNow) {
    const err = d.querySelector("#ci-err"), go = d.querySelector("#ci-go");
    go.disabled = true; go.textContent = "Importing…";
    try {
      let listId = listChoice && listChoice !== "__new" ? listChoice : null;
      if (listChoice === "__new") {
        if (!newListName) throw new Error("Give the new list a name.");
        const me = (await sb.auth.getUser()).data.user?.email ?? null;
        const { data, error } = await sb.from("roster_lists").insert({ name: newListName, created_by: me }).select("id").single();
        if (error) throw error;
        listId = data.id;
      }
      const payload = a.ok.map(({ platform, handle, name, country, email, notes, followers }) => ({ platform, handle, name, country, email, notes, followers }));
      const { data: res, error } = await sb.rpc("import_creators", { p_rows: payload, p_list: listId });
      if (error) throw error;
      const done = `${res.added} added${res.updated ? `, ${res.updated} put back on the roster` : ""}${res.already ? `, ${res.already} already there` : ""}${res.skipped ? `, ${res.skipped} skipped` : ""}`;
      const fresh = a.ok.filter((r) => !r.known);
      if (!fetchNow || !fresh.length) { toast?.(`Import done: ${done}`); d.close(); onDone?.(listId); return; }
      // Fetch numbers now, two at a time; the person can close the window and it carries on.
      let n = 0, failed = 0;
      d.querySelector("form").innerHTML = `<h2>Fetching their numbers</h2>
        <p class="muted small">Import done: ${esc(done)}. Now reading each new creator's profile and recent posts. You can close this window; it keeps going while the OS is open.</p>
        <div class="ci-bar"><i id="ci-bar"></i></div><p class="small" id="ci-count">0 of ${fresh.length}</p>
        <div class="actions"><button type="submit" value="cancel">Close</button></div>`;
      const queue = [...fresh];
      const worker = async () => {
        while (queue.length) {
          const r = queue.shift();
          try { await invoke(sb, "roster", { action: "add", input: r.handle, platform: r.platform }); } catch { failed++; }
          n++;
          const bar = document.getElementById("ci-bar"), cnt = document.getElementById("ci-count");
          if (bar) bar.style.width = `${(n / fresh.length) * 100}%`;
          if (cnt) cnt.textContent = `${n} of ${fresh.length}${failed ? ` · ${failed} couldn't be found (check the handle)` : ""}`;
        }
      };
      await Promise.all([worker(), worker()]);
      toast?.(`Numbers fetched for ${n - failed} of ${fresh.length} creators${failed ? ` · ${failed} not found` : ""}`);
      if (d.open) d.close();
      onDone?.(listId);
    } catch (e) {
      go.disabled = false; go.textContent = "Try again";
      err.textContent = e.message ?? String(e); err.hidden = false;
    }
  }

  d.addEventListener("close", () => setTimeout(() => d.remove(), 0));
  step1();
  d.showModal();
}
