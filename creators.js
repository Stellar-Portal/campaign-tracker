// Creators tab on a campaign (team only): personal creator links, draft review, and pre-filled messages.
// Each creator gets one personal page per folder (creator.html#t=<token>, see the creator-portal function):
// they send drafts there, see Stellar's (and, if switched on, the client's) answer, paste their posted
// TikTok link (it lands in that folder) and leave payment details. Messages open in the team's own apps
// (WhatsApp, Instagram, TikTok, email) with the text ready: nothing is sent or stored by the OS.
import { esc } from "./report.js?v=20261126b";

const day = (d) => (d ? new Date(d).toLocaleDateString("en-GB", { day: "numeric", month: "short" }) : "");
const handleOf = (c) => String(c?.username ?? "").replace(/^@/, "");
const DEFAULT_MSG = "Hi @{handle}! Here's your page for {artist} – {song}{folder}. {steps} {link}";
const STATUS = {
  submitted: ["wait", "To review"], team_ok: ["client", "With the client"], approved: ["ok", "Approved"],
  changes: ["fix", "Changes asked"], client_changes: ["fix", "Client asked for changes"],
};

export async function renderCampaignCreators(el, sb, { campaign, toast, isCurrent }) {
  const cid = campaign.id;
  el.innerHTML = `<p class="muted pad">Loading creators…</p>`;
  const [campRes, folderRes, rowRes, fcRes, linkRes, postRes, draftRes] = await Promise.all([
    sb.from("campaigns").select("id,artist,song,portal_drafts,portal_client_review,portal_brief,portal_message").eq("id", cid).single(),
    sb.from("campaign_folders").select("id,name,position").eq("campaign_id", cid).order("position").order("created_at"),
    sb.from("payout_rows").select("creator_id,handle").eq("campaign_id", cid),
    sb.from("campaign_folder_creators").select("creator_id,folder_id").eq("campaign_id", cid),
    sb.from("creator_portal_links").select("id,folder_id,creator_id,opened_at,last_seen_at,revoked_at").eq("campaign_id", cid),
    sb.from("posts").select("creator_id,folder_id").eq("campaign_id", cid).not("creator_id", "is", null),
    sb.from("creator_drafts").select("id,link_id,folder_id,creator_id,file_path,file_name,size_bytes,status,creator_note,team_note,client_note,reviewed_by,reviewed_at,client_reviewed_at,created_at").eq("campaign_id", cid).neq("status", "withdrawn").order("created_at", { ascending: false }),
  ]);
  if (!isCurrent()) return;
  const err = campRes.error ?? draftRes.error ?? linkRes.error;
  if (err) { el.innerHTML = `<div class="panel"><p class="warn-note">${esc(err.message)}</p></div>`; return; }
  const camp = campRes.data, folders = folderRes.data ?? [], links = linkRes.data ?? [], drafts = draftRes.data ?? [];
  const ids = [...new Set([...(rowRes.data ?? []).map((r) => r.creator_id), ...(fcRes.data ?? []).map((r) => r.creator_id), ...links.map((l) => l.creator_id)].filter(Boolean))];
  const { data: crs } = ids.length ? await sb.from("creators").select("id,username,display_name,platform,avatar_url,whatsapp,contact_email,paypal_email").in("id", ids) : { data: [] };
  if (!isCurrent()) return;
  const creatorBy = Object.fromEntries((crs ?? []).map((c) => [c.id, c]));
  const folderName = Object.fromEntries(folders.map((f) => [f.id, f.name]));
  // Which folder a creator's link is for: an existing link, else the folder they're in or post in, else the only folder.
  const choice = {};
  for (const id of ids) {
    const l = links.find((x) => x.creator_id === id && !x.revoked_at);
    const fc = (fcRes.data ?? []).find((x) => x.creator_id === id)?.folder_id ?? (postRes.data ?? []).find((x) => x.creator_id === id && x.folder_id)?.folder_id;
    choice[id] = l ? (l.folder_id ?? "") : fc ?? (folders.length === 1 ? folders[0].id : folders.length ? null : "");
  }
  const tokens = {}; // `${creator}|${folder}` -> token
  const pageUrl = (t) => `${location.origin}${location.pathname.replace(/[^/]*$/, "")}creator.html#t=${t}`;
  async function linkFor(creatorIds, folder) {
    const want = creatorIds.filter((x) => !tokens[`${x}|${folder ?? ""}`]);
    if (want.length) {
      const { data, error } = await sb.rpc("creator_portal_links_for", { p_campaign: cid, p_folder: folder || null, p_creators: want });
      if (error) throw error;
      for (const r of data ?? []) tokens[`${r.creator_id}|${r.folder_id ?? ""}`] = r.token;
    }
    return creatorIds.map((x) => tokens[`${x}|${folder ?? ""}`]);
  }
  const messageFor = (cr, folder, url, tpl = camp.portal_message || DEFAULT_MSG) => tpl
    .replaceAll("{handle}", handleOf(cr)).replaceAll("{name}", cr.display_name || handleOf(cr))
    .replaceAll("{artist}", camp.artist ?? "").replaceAll("{song}", camp.song ?? "")
    .replaceAll("{folder}", folder && folderName[folder] ? ` (${folderName[folder]})` : "")
    .replaceAll("{steps}", camp.portal_drafts ? "Send your draft there, see our feedback, and paste your TikTok link once it's posted." : "Paste your TikTok link there once it's posted.")
    .replaceAll("{link}", url).replace(/\s+\n/g, "\n").trim();

  const draftsBy = {};
  for (const d of drafts) (draftsBy[d.creator_id] ??= []).push(d);
  const toReview = drafts.filter((d) => d.status === "submitted");

  el.innerHTML = `
    <section class="crx-settings panel">
      <div class="crx-set-row">
        <label class="switch-row"><input type="checkbox" id="crx-drafts"${camp.portal_drafts ? " checked" : ""}><span><b>Drafts before posting</b><small>Creators send a draft on their page and post only once it's approved.</small></span></label>
        <label class="switch-row"><input type="checkbox" id="crx-client"${camp.portal_client_review ? " checked" : ""}${camp.portal_drafts ? "" : " disabled"}><span><b>Client approves drafts too</b><small>Drafts you approve go to the client's report link, where they approve or ask for changes.</small></span></label>
      </div>
      <details class="crx-more"><summary>Brief and message for creators</summary>
        <label>Brief on every creator page<textarea id="crx-brief" rows="4" maxlength="4000" placeholder="e.g. Use the sound from 0:15. Show your face in the first 2 seconds. Post between 5 and 12 December.">${esc(camp.portal_brief ?? "")}</textarea></label>
        <label>Message you send with the link<textarea id="crx-msg" rows="3" maxlength="1000">${esc(camp.portal_message || DEFAULT_MSG)}</textarea><span class="muted small">{handle}, {name}, {artist}, {song}, {folder}, {steps} and {link} are filled in for each creator.</span></label>
      </details>
    </section>

    <section class="crx-sec">
      <div class="crx-head"><h2>Drafts${toReview.length ? ` <span class="crx-n">${toReview.length} to review</span>` : ""}</h2></div>
      ${!camp.portal_drafts ? `<p class="muted small">Drafts are off for this campaign: creators paste their posted link straight away.</p>` : ""}
      <div id="crx-drafts-list">${drafts.length ? "" : `<p class="muted small">No drafts yet. They show up here as soon as a creator sends one from their page.</p>`}</div>
    </section>

    <section class="crx-sec">
      <div class="crx-head"><h2>Creator pages</h2>
        <span class="crx-tools"><button type="button" id="crx-copyall" class="primary small-btn">Copy links for selected</button></span></div>
      <p class="muted small">One personal page per creator and folder. Creators on the Payouts tab and in folders are listed here.</p>
      ${ids.length ? `<div class="table-wrap"><table class="crx-table"><thead><tr><th><input type="checkbox" id="crx-all" aria-label="Select all"></th><th>Creator</th><th>Folder</th><th>Page</th><th>Send</th></tr></thead><tbody>
        ${ids.map((id) => rowHtml(creatorBy[id] ?? { id, username: "?" })).join("")}</tbody></table></div>`
        : `<p class="muted">No creators yet. Add them on the Payouts tab (or to a folder) and they show up here.</p>`}
    </section>`;

  function rowHtml(cr) {
    const l = links.find((x) => x.creator_id === cr.id && (x.folder_id ?? "") === (choice[cr.id] ?? "") && !x.revoked_at);
    const ds = draftsBy[cr.id] ?? [];
    const state = !l ? `<span class="muted small">Not sent yet</span>` : l.opened_at ? `<span class="small">Opened ${day(l.opened_at)}</span>` : `<span class="muted small">Not opened yet</span>`;
    const folderSel = folders.length ? `<select data-folder="${esc(cr.id)}" aria-label="Folder for @${esc(handleOf(cr))}">${choice[cr.id] == null ? `<option value="" selected disabled>Choose a folder</option>` : ""}${folders.map((f) => `<option value="${esc(f.id)}"${choice[cr.id] === f.id ? " selected" : ""}>${esc(f.name)}</option>`).join("")}</select>` : `<span class="muted small">Whole campaign</span>`;
    return `<tr data-row="${esc(cr.id)}"><td><input type="checkbox" data-sel="${esc(cr.id)}" aria-label="Select @${esc(handleOf(cr))}"></td>
      <td><b>@${esc(handleOf(cr))}</b>${cr.display_name ? `<div class="muted small">${esc(cr.display_name)}</div>` : ""}</td>
      <td>${folderSel}</td>
      <td>${state}${ds.length ? `<div class="muted small">${ds.length} draft${ds.length === 1 ? "" : "s"}</div>` : ""}</td>
      <td class="crx-send"><button type="button" class="link-btn" data-copy="${esc(cr.id)}">Copy link</button>
        <button type="button" class="crx-app" data-app="whatsapp" data-cr="${esc(cr.id)}" title="WhatsApp">WhatsApp</button>
        ${cr.platform === "instagram" ? `<button type="button" class="crx-app" data-app="instagram" data-cr="${esc(cr.id)}" title="Instagram">Instagram</button>` : ""}
        ${cr.platform !== "instagram" && cr.platform !== "youtube" ? `<button type="button" class="crx-app" data-app="tiktok" data-cr="${esc(cr.id)}" title="TikTok">TikTok</button>` : ""}
        ${cr.contact_email ? `<button type="button" class="crx-app" data-app="email" data-cr="${esc(cr.id)}" title="Email">Email</button>` : ""}</td></tr>`;
  }

  // ---------- drafts ----------
  const list = el.querySelector("#crx-drafts-list");
  if (drafts.length) {
    const groups = [["To review", ["submitted"]], ["With the client", ["team_ok"]], ["Changes asked", ["changes", "client_changes"]], ["Approved", ["approved"]]];
    list.innerHTML = groups.map(([title, sts]) => {
      const ds = drafts.filter((d) => sts.includes(d.status));
      return ds.length ? `<h3 class="crx-g">${title} <span class="muted small">${ds.length}</span></h3><div class="crx-grid">${ds.map(draftCard).join("")}</div>` : "";
    }).join("");
    // Signed links to watch the videos (team only, 1 hour).
    const { data: signed } = await sb.storage.from("drafts").createSignedUrls(drafts.map((d) => d.file_path), 3600);
    if (!isCurrent()) return;
    for (const s of signed ?? []) {
      const d = drafts.find((x) => x.file_path === s.path);
      const v = d && list.querySelector(`video[data-v="${d.id}"]`);
      if (v && s.signedUrl) v.src = s.signedUrl;
    }
  }
  function draftCard(d) {
    const cr = creatorBy[d.creator_id] ?? {};
    const [cls, label] = STATUS[d.status] ?? ["", d.status];
    return `<article class="crx-card"><video data-v="${esc(d.id)}" controls playsinline preload="metadata"></video>
      <div class="crx-body"><div class="crx-ch"><b>@${esc(handleOf(cr))}</b><span class="crx-pill ${cls}">${label}</span></div>
      <div class="muted small">${[d.folder_id ? folderName[d.folder_id] : null, `sent ${day(d.created_at)}`, d.size_bytes ? `${Math.round(d.size_bytes / 1048576)} MB` : null].filter(Boolean).map(esc).join(" · ")}</div>
      ${d.creator_note ? `<p class="crx-note"><b>Creator:</b> ${esc(d.creator_note)}</p>` : ""}
      ${d.team_note ? `<p class="crx-note"><b>Stellar:</b> ${esc(d.team_note)}</p>` : ""}
      ${d.client_note ? `<p class="crx-note client"><b>Client:</b> ${esc(d.client_note)}</p>` : ""}
      ${d.status === "submitted" ? `<form class="crx-act" data-d="${esc(d.id)}"><textarea name="note" rows="2" maxlength="1000" placeholder="Note for the creator (needed if you ask for changes)" aria-label="Note for the creator"></textarea>
        <div class="crx-btns"><button type="submit" value="ok" class="primary">${camp.portal_client_review ? "Approve, send to client" : "Approve"}</button><button type="submit" value="changes">Ask for changes</button></div></form>` : ""}
      ${d.status === "team_ok" ? `<button type="button" class="link-btn" data-skip="${esc(d.id)}">Approve without waiting for the client</button>` : ""}
      ${["approved", "changes", "client_changes"].includes(d.status) ? `<button type="button" class="link-btn" data-tell="${esc(d.creator_id)}" data-tf="${esc(d.folder_id ?? "")}">Tell @${esc(handleOf(cr))} on WhatsApp</button>` : ""}
      </div></article>`;
  }
  const me = async () => (await sb.auth.getUser()).data.user?.email ?? null;
  const reload = () => renderCampaignCreators(el, sb, { campaign, toast, isCurrent });
  el.querySelectorAll(".crx-act").forEach((f) => (f.onsubmit = async (e) => {
    e.preventDefault();
    const ok = e.submitter?.value !== "changes", note = f.note.value.trim();
    if (!ok && !note) { toast("Tell the creator what to change"); f.note.focus(); return; }
    f.querySelectorAll("button").forEach((b) => (b.disabled = true));
    const { error } = await sb.from("creator_drafts").update({ status: ok ? (camp.portal_client_review ? "team_ok" : "approved") : "changes", team_note: note || null, reviewed_by: await me(), reviewed_at: new Date().toISOString() }).eq("id", f.dataset.d).eq("status", "submitted");
    if (error) { toast(error.message); f.querySelectorAll("button").forEach((b) => (b.disabled = false)); return; }
    toast(ok ? (camp.portal_client_review ? "Approved: it's on the client's link now" : "Approved: the creator can post") : "Sent back to the creator");
    reload();
  }));
  el.querySelectorAll("[data-skip]").forEach((b) => (b.onclick = async () => {
    const { error } = await sb.from("creator_drafts").update({ status: "approved", reviewed_by: await me(), reviewed_at: new Date().toISOString() }).eq("id", b.dataset.skip).eq("status", "team_ok");
    if (error) return toast(error.message);
    toast("Approved"); reload();
  }));
  el.querySelectorAll("[data-tell]").forEach((b) => (b.onclick = () => send(b.dataset.tell, "whatsapp", b.dataset.tf || null, "Hi @{handle}, we've checked your draft for {artist} – {song}: see our answer on your page. {link}")));

  // ---------- settings (saved as they change) ----------
  const save = async (patch, msg) => { const { error } = await sb.from("campaigns").update(patch).eq("id", cid); if (error) toast(error.message); else { Object.assign(camp, patch); if (msg) toast(msg); } };
  el.querySelector("#crx-drafts").onchange = async (e) => { await save({ portal_drafts: e.target.checked }, e.target.checked ? "Creators send drafts first" : "Creators post straight away"); el.querySelector("#crx-client").disabled = !e.target.checked; };
  el.querySelector("#crx-client").onchange = (e) => save({ portal_client_review: e.target.checked }, e.target.checked ? "The client approves drafts on their link" : "Only Stellar approves drafts");
  el.querySelector("#crx-brief").onchange = (e) => save({ portal_brief: e.target.value.trim() || null }, "Brief saved");
  el.querySelector("#crx-msg").onchange = (e) => save({ portal_message: e.target.value.trim() === DEFAULT_MSG ? null : e.target.value.trim() || null }, "Message saved");

  // ---------- links and messages ----------
  el.querySelectorAll("[data-folder]").forEach((s) => (s.onchange = () => { choice[s.dataset.folder] = s.value; }));
  async function urlFor(crId, folder) {
    if (folders.length && !folder) { toast("Choose the creator's folder first"); return null; }
    try { const [t] = await linkFor([crId], folder); return pageUrl(t); }
    catch (x) { toast(x.message); return null; }
  }
  async function copy(text, done) {
    try { await navigator.clipboard.writeText(text); toast(done); } catch { toast(text); }
  }
  el.querySelectorAll("[data-copy]").forEach((b) => (b.onclick = async () => {
    const url = await urlFor(b.dataset.copy, choice[b.dataset.copy]);
    if (url) { await copy(url, "Link copied"); markSent(b.dataset.copy); }
  }));
  el.querySelectorAll("[data-app]").forEach((b) => (b.onclick = () => send(b.dataset.cr, b.dataset.app, choice[b.dataset.cr])));
  function markSent(crId) {
    const cell = el.querySelector(`tr[data-row="${crId}"] td:nth-child(4)`);
    if (cell && /Not sent yet/.test(cell.textContent)) cell.firstElementChild.outerHTML = `<span class="muted small">Not opened yet</span>`;
  }
  async function send(crId, app, folder, template = null) {
    const cr = creatorBy[crId];
    if (!cr) return;
    const url = await urlFor(crId, folder);
    if (!url) return;
    const text = messageFor(cr, folder, url, template ?? undefined);
    markSent(crId);
    if (app === "whatsapp") {
      let num = String(cr.whatsapp ?? "").replace(/[^\d]/g, "");
      if (!num) {
        num = await askNumber(cr);
        if (!num) return;
      }
      window.open(`https://wa.me/${num}?text=${encodeURIComponent(text)}`, "_blank", "noopener");
    } else if (app === "email") {
      location.href = `mailto:${encodeURIComponent(cr.contact_email)}?subject=${encodeURIComponent(`${camp.artist ?? "Stellar"}${camp.song ? ` – ${camp.song}` : ""}: your page`)}&body=${encodeURIComponent(text)}`;
    } else {
      // Instagram and TikTok can't take a ready-made message: copy it, then open the chat.
      await copy(text, "Message copied: paste it in the chat");
      window.open(app === "instagram" ? `https://ig.me/m/${encodeURIComponent(handleOf(cr))}` : `https://www.tiktok.com/@${encodeURIComponent(handleOf(cr))}`, "_blank", "noopener");
    }
  }
  // A creator's WhatsApp number, asked once and saved on their roster card.
  function askNumber(cr) {
    return new Promise((resolve) => {
      const d = document.createElement("dialog");
      d.className = "po-dialog";
      d.innerHTML = `<form method="dialog"><h2>WhatsApp number for @${esc(handleOf(cr))}</h2>
        <p class="muted small" style="margin:0 0 10px">With the country code, e.g. +63 917 123 4567. It's saved on their roster card for next time.</p>
        <label>Number<input name="n" type="tel" inputmode="tel" autocomplete="off" required></label>
        <p class="small error" id="wa-err"></p>
        <div class="actions"><button type="submit" value="ok" class="primary">Save and open WhatsApp</button><button type="submit" value="cancel" formnovalidate>Cancel</button></div></form>`;
      document.body.append(d);
      const f = d.querySelector("form");
      f.onsubmit = async (e) => {
        if (e.submitter?.value !== "ok") return;
        e.preventDefault();
        const raw = f.n.value.trim(), digits = raw.replace(/[^\d]/g, "");
        if (!raw.startsWith("+") || digits.length < 8) { d.querySelector("#wa-err").textContent = "Start with + and the country code."; return; }
        const { error } = await sb.from("creators").update({ whatsapp: `+${digits}` }).eq("id", cr.id);
        if (error) { d.querySelector("#wa-err").textContent = error.message; return; }
        cr.whatsapp = `+${digits}`; d.close(); resolve(digits);
      };
      d.addEventListener("click", (e) => { if (e.target === d) d.close(); });
      d.onclose = () => { d.remove(); resolve(null); };
      d.showModal();
    });
  }
  const all = el.querySelector("#crx-all");
  if (all) all.onchange = () => el.querySelectorAll("[data-sel]").forEach((c) => (c.checked = all.checked));
  el.querySelector("#crx-copyall").onclick = async () => {
    const picked = [...el.querySelectorAll("[data-sel]:checked")].map((c) => c.dataset.sel);
    if (!picked.length) return toast("Tick the creators first");
    if (folders.length && picked.some((x) => !choice[x])) return toast("Choose a folder for every ticked creator first");
    const byFolder = {};
    for (const x of picked) (byFolder[choice[x] ?? ""] ??= []).push(x);
    const lines = [];
    try {
      for (const [f, list] of Object.entries(byFolder)) {
        const ts = await linkFor(list, f || null);
        list.forEach((x, i) => lines.push(`@${handleOf(creatorBy[x])}: ${pageUrl(ts[i])}`));
      }
    } catch (x) { return toast(x.message); }
    picked.forEach(markSent);
    await copy(lines.join("\n"), `${lines.length} link${lines.length === 1 ? "" : "s"} copied`);
  };
}
