// Vendor form (vendor-form.html#t=<token>): a client tells Stellar who to invoice, once per company.
// The link comes from a campaign in Stellar OS ("Vendor form"); the `vendor-form` function saves the answers in
// Clients (client, invoicing company, invoice contact) and fills the campaign.
import { SUPABASE_URL } from "./config.js?v=20261126a";
import { COUNTRIES as countries } from "./countries.js?v=20261126a";

const FN = `${SUPABASE_URL}/functions/v1/vendor-form`;
const W8 = "https://drive.google.com/file/d/1SX9x5W96cZ-voYvt5BHDtHomHS78h352/view?usp=sharing";
const card = document.getElementById("card");
const token = (new URLSearchParams(location.hash.slice(1)).get("t") || "").trim().toLowerCase();
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const EMAIL = /^[^\s@<>()",;]+@[^\s@<>()",;]+\.[a-z]{2,}$/i;

async function call(body) {
  // text/plain keeps this a simple request (no preflight); the function reads JSON either way.
  const res = await fetch(FN, { method: "POST", headers: { "Content-Type": "text/plain" }, body: JSON.stringify({ token, ...body }) });
  let data = {};
  try { data = await res.json(); } catch { /* empty */ }
  if (!res.ok) throw new Error(data.error || "Something went wrong. Please try again.");
  return data;
}
function message(title, text, tick = false) {
  card.innerHTML = `<div class="done">${tick ? `<div class="tick" aria-hidden="true">✓</div>` : ""}<h1>${esc(title)}</h1><p class="sub" style="margin:0">${text}</p></div>`;
}
const input = (name, label, opts = {}) => `<label>${label}${opts.hint ? `<span class="hint">${opts.hint}</span>` : ""}<input name="${name}" type="${opts.type ?? "text"}" maxlength="${opts.max ?? 200}"${opts.ac ? ` autocomplete="${opts.ac}"` : ""}${opts.value ? ` value="${esc(opts.value)}"` : ""}></label>`;

function form(st) {
  card.innerHTML = `
    <h1>Vendor form</h1>
    <p class="sub">So we can invoice you correctly${st.artist ? ` for <span class="handle">${esc(st.artist)}${st.song ? ` – ${esc(st.song)}` : ""}</span>` : ""}. It takes about two minutes.</p>
    <form id="f" novalidate>
      <h2>Invoicing information</h2>
      ${input("company", "Company name", { ac: "organization", hint: "The legal name to put on the invoice." })}
      ${input("company_id", "Company ID number", { max: 60, hint: `VAT, EIN, BN, ABN, CVR or similar. EU companies: your VAT number (<a href="https://ec.europa.eu/taxation_customs/vies/#/vat-validation" target="_blank" rel="noopener">check it here</a>). US companies: usually your EIN. No number? Write why.` })}
      <h2>Address</h2>
      ${input("street", "Street and number", { ac: "street-address" })}
      <div class="row">${input("zip", "Zip code", { max: 20, ac: "postal-code" })}${input("city", "City", { max: 100, ac: "address-level2" })}</div>
      <label>Country<select name="country"><option value="">Choose a country</option>${countries.map((x) => `<option value="${x.c}">${esc(x.n)}</option>`).join("")}</select></label>
      <h2>Contact person for invoices</h2>
      <div class="row">${input("contact_name", "Name", { max: 120, ac: "name" })}${input("contact_email", "Email", { type: "email", ac: "email" })}</div>
      <h2>Campaign information</h2>
      ${input("stellar_contact", "Your Stellar contact", { max: 120, value: st.contact })}
      <div class="row">${input("artists", "Artist(s)", { max: 300, value: st.artist })}${input("songs", "Song(s)", { max: 300, value: st.song })}</div>
      <h2>Signature</h2>
      ${input("print_name", "Print name", { max: 120, ac: "name" })}
      <div class="lbl" role="group" aria-label="Signature">Sign here<div class="sig" id="sig"><canvas aria-label="Signature pad: draw your signature"></canvas><span class="ph" id="sig-ph">Draw your signature with your mouse or finger</span></div>
        <span class="sig-tools"><span>Signing confirms these details are correct.</span><button type="button" class="linkbtn" id="sig-clear">Clear</button></span></div>
      <label>Notes <span class="hint">Optional: anything we should know, e.g. a reference to put on the invoice.</span><textarea name="notes" maxlength="2000"></textarea></label>
      <p class="err" id="err" role="alert"></p>
      <button type="submit" id="go">Send</button>
    </form>
    <p class="fine">US company and need our W-8BEN-E? <a href="${W8}" target="_blank" rel="noopener">Download it here</a>. Questions: <a href="mailto:invoice@stellarmusic.dk">invoice@stellarmusic.dk</a>. Stellar uses these details only for invoicing. <a href="privacy.html" target="_blank" rel="noopener">Privacy policy</a></p>`;
  const f = card.querySelector("#f"), err = card.querySelector("#err"), go = card.querySelector("#go");
  const pad = signaturePad(card.querySelector("#sig"), card.querySelector("#sig-ph"));
  card.querySelector("#sig-clear").onclick = () => pad.clear();
  f.onsubmit = async (e) => {
    e.preventDefault();
    const v = Object.fromEntries(["company", "company_id", "street", "zip", "city", "country", "contact_name", "contact_email", "stellar_contact", "artists", "songs", "print_name", "notes"].map((k) => [k, f[k].value.trim()]));
    const need = { company: "company name", company_id: "company ID number", street: "street", zip: "zip code", city: "city", country: "country", contact_name: "contact name", contact_email: "contact email", stellar_contact: "your Stellar contact", artists: "artist(s)", songs: "song(s)", print_name: "print name" };
    const bad = [];
    for (const [k, label] of Object.entries(need)) {
      const wrong = !v[k] || (k === "contact_email" && !EMAIL.test(v[k]));
      f[k].classList.toggle("bad-in", wrong);
      if (wrong) bad.push(label);
    }
    card.querySelector("#sig").classList.toggle("bad-in", pad.empty());
    if (pad.empty()) bad.push("your signature");
    if (bad.length) { err.textContent = `Please add ${bad.join(", ")}.`; f.querySelector(".bad-in")?.scrollIntoView({ block: "center", behavior: "smooth" }); return; }
    go.disabled = true; go.textContent = "Sending…"; err.textContent = "";
    try {
      const r = await call({ action: "submit", ...v, signature: pad.png() });
      if (r.state === "done") return message("Already sent", "This form was already filled in. If something changed, write to invoice@stellarmusic.dk.");
      if (r.state === "gone") return message("This link has expired", "Ask your Stellar contact for a new one.");
      message("Thank you!", "We've got everything we need to invoice you. You can close this page.", true);
      scrollTo({ top: 0 });
    } catch (x) { err.textContent = x.message; go.disabled = false; go.textContent = "Send"; }
  };
}

// A simple signature pad: pointer events, smooth lines, exported as PNG.
function signaturePad(box, ph) {
  const cv = box.querySelector("canvas"), ctx = cv.getContext("2d");
  let drawn = false, last = null;
  const fit = () => {
    const r = cv.getBoundingClientRect(), d = devicePixelRatio || 1;
    const keep = drawn ? cv.toDataURL() : null;
    cv.width = Math.round(r.width * d); cv.height = Math.round(r.height * d);
    ctx.setTransform(d, 0, 0, d, 0, 0); ctx.lineWidth = 2.2; ctx.lineCap = "round"; ctx.lineJoin = "round"; ctx.strokeStyle = "#1d1d1f";
    if (keep) { const img = new Image(); img.onload = () => ctx.drawImage(img, 0, 0, r.width, r.height); img.src = keep; }
  };
  const at = (e) => { const r = cv.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  cv.addEventListener("pointerdown", (e) => { cv.setPointerCapture(e.pointerId); last = at(e); ctx.beginPath(); ctx.arc(last.x, last.y, 1.1, 0, Math.PI * 2); ctx.fillStyle = "#1d1d1f"; ctx.fill(); drawn = true; ph.hidden = true; box.classList.remove("bad-in"); });
  cv.addEventListener("pointermove", (e) => { if (!last) return; const p = at(e); ctx.beginPath(); ctx.moveTo(last.x, last.y); ctx.lineTo(p.x, p.y); ctx.stroke(); last = p; });
  const end = () => { last = null; };
  cv.addEventListener("pointerup", end); cv.addEventListener("pointercancel", end);
  addEventListener("resize", fit); fit();
  return {
    empty: () => !drawn,
    clear: () => { ctx.clearRect(0, 0, cv.width, cv.height); drawn = false; ph.hidden = false; },
    png: () => cv.toDataURL("image/png"),
  };
}

(async () => {
  if (!/^[0-9a-f]{64}$/.test(token)) return message("This link doesn't work", "Check that you copied the whole link, or ask your Stellar contact for a new one.");
  try {
    const st = await call({ action: "status" });
    if (st.state === "open") return form(st);
    if (st.state === "done") return message("Already sent", "This form was already filled in. If something changed, write to invoice@stellarmusic.dk.");
    message("This link has expired", "Ask your Stellar contact for a new one.");
  } catch (x) { message("Something went wrong", esc(x.message)); }
})();
