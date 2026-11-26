// Creator portal (creator.html#t=<token>): a creator's personal page for one campaign folder.
// Send drafts → see feedback (Stellar's, and the client's if the campaign has client review on) → post →
// send the posted link (it lands in the campaign folder in Stellar OS) → leave payment details if missing.
// Talks only to the `creator-portal` function; draft videos upload straight to private storage with a signed link.
import { SUPABASE_URL } from "./config.js?v=20261126b";
import { COUNTRIES as countries } from "./countries.js?v=20261126b";

const FN = `${SUPABASE_URL}/functions/v1/creator-portal`;
const card = document.getElementById("card");
const token = (new URLSearchParams(location.hash.slice(1)).get("t") || "").trim().toLowerCase();
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const EMAIL = /^[^\s@<>()",;]+@[^\s@<>()",;]+\.[a-z]{2,}$/i;
const day = (d) => new Date(d).toLocaleDateString(undefined, { day: "numeric", month: "short" });
const MB = 1024 * 1024;

async function call(body) {
  // text/plain keeps this a simple request (no preflight); the function reads JSON either way.
  const res = await fetch(FN, { method: "POST", headers: { "Content-Type": "text/plain" }, body: JSON.stringify({ token, ...body }) });
  let data = {};
  try { data = await res.json(); } catch { /* empty */ }
  if (!res.ok) throw new Error(data.error || "Something went wrong. Please try again.");
  return data;
}
function message(title, text) {
  card.innerHTML = `<div class="done"><h1>${esc(title)}</h1><p class="sub" style="margin:0">${text}</p></div>`;
}

// What each draft status means for the creator.
const LABEL = {
  submitted: ["wait", "Waiting for review"],
  team_ok: ["wait", "Approved by Stellar, waiting for the client"],
  approved: ["ok", "Approved: you can post it"],
  changes: ["fix", "Changes needed"],
  client_changes: ["fix", "Changes needed"],
};

let st = null, busy = false;
async function load() {
  try { st = await call({ action: "status" }); }
  catch (e) { message("Couldn't open your page", esc(e.message)); return; }
  if (st.state !== "open") { message("This link doesn't work any more", "Ask Stellar for a new link."); return; }
  draw();
}

function draw() {
  const c = st.campaign, d = st.drafts, approved = d.some((x) => x.status === "approved");
  const canPost = !c.drafts || approved;
  const steps = [...(c.drafts ? [["Send a draft", d.length > 0], ["Get approval", approved]] : []), ["Post and send the link", st.posts.length > 0], ["Payment details", st.payment.has]];
  const next = steps.findIndex(([, done]) => !done);
  card.innerHTML = `
    <h1>Hi @${esc(st.handle)}</h1>
    <p class="sub">${esc(c.artist)}${c.song ? ` – ${esc(c.song)}` : ""}${st.folder ? ` · ${esc(st.folder)}` : ""}. Everything for this campaign happens on this page: keep the link.</p>
    <div class="steps">${steps.map(([s, done], i) => `<span class="${done ? "ok" : i === next ? "on" : ""}">${done ? "✓" : `${i + 1}.`} ${s}</span>`).join("")}</div>
    ${c.brief ? `<div class="brief">${esc(c.brief)}</div>` : ""}
    ${c.finished ? `<p class="locked">This campaign is finished. Thank you!</p>` : ""}

    ${c.drafts ? `<h2>Your drafts</h2>
      ${d.length ? d.map(draftHtml).join("") : `<p class="muted">Send your draft video before you post. Stellar${c.client_review ? " and the client" : ""} will check it and you'll see the answer here.</p>`}
      ${c.finished ? "" : `<label class="drop" id="drop">＋ Send a draft video<input type="file" id="file" accept="video/*"></label>
      <div id="up" hidden><div class="muted" id="up-name"></div><div class="bar"><i id="up-bar"></i></div></div>
      <label>Note for Stellar <span class="hint">Optional</span><textarea id="note" rows="2" maxlength="1000" placeholder="Anything we should know about this draft"></textarea></label>`}
      <p class="err" id="d-err" role="alert"></p>` : ""}

    <h2>Your posted videos</h2>
    ${st.posts.map((p) => `<div class="item"><div class="item-h"><b>${esc(p.url.replace(/^https?:\/\/(www\.)?/, ""))}</b>${postPill(p)}</div>${p.status === "failed" && p.error ? `<div class="note">${esc(p.error)}</div>` : ""}</div>`).join("")}
    ${c.finished ? "" : canPost ? `<form id="pf" class="inline" novalidate><input name="url" type="url" inputmode="url" placeholder="Paste your TikTok link" aria-label="Link to your posted video"><button type="submit">Send</button></form>
      <p class="err" id="p-err" role="alert"></p>` : `<p class="locked">Once a draft is approved, post it and paste the link here.</p>`}

    <h2>How you get paid</h2>
    ${st.payment.has ? `<p class="locked">✓ We have your payment details${st.payment.paypal ? ` (PayPal ${esc(st.payment.paypal)})` : ""}. To change them, contact Stellar.</p>` : payForm()}

    <p class="fine">Stellar keeps your drafts only for this campaign. <a href="privacy.html" target="_blank" rel="noopener">Privacy policy</a></p>`;
  bind();
}
function draftHtml(x) {
  const [cls, label] = LABEL[x.status] ?? ["", x.status];
  const fix = ["changes", "client_changes"].includes(x.status);
  return `<div class="item"><div class="item-h"><b>${esc(x.file_name)}</b><span class="pill ${cls}">${label}</span></div>
    <div class="muted">Sent ${day(x.created_at)}${x.creator_note ? ` · “${esc(x.creator_note)}”` : ""}</div>
    ${x.team_note ? `<div class="note"><b>Stellar:</b> ${esc(x.team_note)}</div>` : ""}
    ${x.client_note ? `<div class="note client"><b>The client:</b> ${esc(x.client_note)}</div>` : ""}
    ${fix && !st.campaign.finished ? `<label class="linkbtn" style="display:inline-block;cursor:pointer">Send a new version<input type="file" accept="video/*" data-replace="${esc(x.id)}" style="position:absolute;width:1px;height:1px;opacity:0"></label>` : ""}
    ${x.status === "submitted" && !st.campaign.finished ? `<button type="button" class="linkbtn" data-withdraw="${esc(x.id)}">Take it back</button>` : ""}</div>`;
}
function postPill(p) {
  if (p.status === "done") return `<span class="pill ok">Added ✓</span>`;
  if (p.status === "failed") return `<span class="pill bad">Couldn't add it</span>`;
  return `<span class="pill wait">Checking…</span>`;
}
function payForm() {
  return `<form id="pay" novalidate>
    <p class="muted" style="margin:0 0 12px">Stellar pays through PayPal. Fill this in once; it's saved for future campaigns too.</p>
    <label>Full name<span class="hint">As on your PayPal account</span><input name="legal_name" maxlength="120" autocomplete="name"></label>
    <label>Country you live in<select name="country"><option value="">Choose a country</option>${countries.map((x) => `<option value="${x.c}">${esc(x.n)}</option>`).join("")}</select></label>
    <label>PayPal email<input name="paypal_email" type="email" maxlength="200" autocomplete="email"></label>
    <label>PayPal username<span class="hint">Optional, e.g. paypal.me/yourname</span><input name="paypal_username" maxlength="80"></label>
    <p class="err" id="pay-err" role="alert"></p>
    <button type="submit">Save payment details</button></form>`;
}

// Upload straight to storage with the signed link, with a progress bar.
function put(url, file, onProgress) {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open("PUT", url);
    x.setRequestHeader("Content-Type", file.type || "video/mp4");
    x.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    x.onload = () => (x.status >= 200 && x.status < 300 ? resolve() : reject(new Error(x.status === 413 ? "The video is too big." : "The upload didn't go through. Please try again.")));
    x.onerror = () => reject(new Error("The connection dropped. Please try again."));
    x.send(file);
  });
}
async function sendDraft(file, replaces = null) {
  const err = document.getElementById("d-err");
  if (busy || !file) return;
  if (!/^video\//.test(file.type)) { err.textContent = "Please choose a video file."; return; }
  if (file.size > 500 * MB) { err.textContent = "The video is too big. Please send one under 500 MB."; return; }
  busy = true; err.textContent = "";
  const up = document.getElementById("up"), bar = document.getElementById("up-bar");
  if (up) { up.hidden = false; document.getElementById("up-name").textContent = `Sending ${file.name} (${Math.round(file.size / MB)} MB)…`; }
  try {
    const u = await call({ action: "upload_url", name: file.name, size: file.size, type: file.type });
    await put(u.url, file, (f) => { if (bar) bar.style.width = `${Math.round(f * 100)}%`; });
    await call({ action: "draft_done", path: u.path, name: file.name, size: file.size, type: file.type, note: document.getElementById("note")?.value ?? "", replaces });
    busy = false; await load();
  } catch (e) { busy = false; if (up) up.hidden = true; err.textContent = e.message; }
}

function bind() {
  document.getElementById("file")?.addEventListener("change", (e) => sendDraft(e.target.files[0]));
  card.querySelectorAll("[data-replace]").forEach((i) => i.addEventListener("change", (e) => sendDraft(e.target.files[0], i.dataset.replace)));
  card.querySelectorAll("[data-withdraw]").forEach((b) => (b.onclick = async () => {
    b.disabled = true;
    try { await call({ action: "withdraw", draft_id: b.dataset.withdraw }); await load(); }
    catch (e) { document.getElementById("d-err").textContent = e.message; b.disabled = false; }
  }));
  const pf = document.getElementById("pf");
  if (pf) pf.onsubmit = async (e) => {
    e.preventDefault();
    const err = document.getElementById("p-err"), url = pf.url.value.trim(), btn = pf.querySelector("button");
    if (!/^https?:\/\//i.test(url)) { err.textContent = "Paste the full link, starting with https://"; return; }
    btn.disabled = true; err.textContent = "";
    try { await call({ action: "post_link", url }); await load(); setTimeout(load, 15000); }
    catch (x) { err.textContent = x.message; btn.disabled = false; }
  };
  const pay = document.getElementById("pay");
  if (pay) pay.onsubmit = async (e) => {
    e.preventDefault();
    const err = document.getElementById("pay-err"), v = Object.fromEntries(new FormData(pay));
    const miss = [v.legal_name.trim().length < 2 && "your full name", !v.country && "your country", !EMAIL.test(v.paypal_email.trim()) && "a valid PayPal email"].filter(Boolean);
    if (miss.length) { err.textContent = `Please add ${miss.join(", ")}.`; return; }
    const btn = pay.querySelector("button"); btn.disabled = true; err.textContent = "";
    try { await call({ action: "payment", ...v }); await load(); }
    catch (x) { err.textContent = x.message; btn.disabled = false; }
  };
}

if (!token) message("This link is missing a part", "Open the full link Stellar sent you.");
else load();
