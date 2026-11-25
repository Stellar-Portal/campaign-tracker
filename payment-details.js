// Payment details page (payment-details.html#t=<token>): a creator tells Stellar, once, how to pay them.
// The one-time link comes from their roster card in Stellar OS; the `creator-details` function checks it and saves
// the details on the card, where every future payment picks them up.
import { SUPABASE_URL } from "./config.js?v=20261125a";
import { COUNTRIES as countries } from "./countries.js?v=20261125a";

const FN = `${SUPABASE_URL}/functions/v1/creator-details`;
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

function form(st) {
  card.innerHTML = `
    <h1>How should we pay you?</h1>
    <p class="sub">Fill this in once${st.handle ? ` for <span class="handle">@${esc(st.handle)}</span>` : ""}. Stellar saves it and uses it for every campaign you do with us, so we won't ask again.</p>
    <form id="f" novalidate>
      <label>Full name <span class="hint">As it appears on your PayPal account.</span><input name="legal_name" autocomplete="name" maxlength="120" required></label>
      <label>Country you live in<select name="country" required><option value="">Choose your country</option>${countries.map((x) => `<option value="${x.c}">${esc(x.n)}</option>`).join("")}</select></label>
      <label>PayPal email <span class="hint">The email address of your PayPal account. Payments go here.</span><input name="paypal_email" type="email" autocomplete="email" inputmode="email" maxlength="200" required></label>
      <label>PayPal username <span class="hint">Optional: your paypal.me name, if you have one.</span><input name="paypal_username" autocomplete="off" maxlength="80" placeholder="e.g. paypal.me/yourname"></label>
      <p class="err" id="err" role="alert"></p>
      <button type="submit" id="go">Save my details</button>
    </form>
    <p class="fine">Stellar uses these details only to pay you for campaigns, through PayPal. The link works once. <a href="privacy.html" target="_blank" rel="noopener">Privacy policy</a></p>`;
  const f = card.querySelector("#f"), err = card.querySelector("#err"), go = card.querySelector("#go");
  f.onsubmit = async (e) => {
    e.preventDefault();
    const v = { legal_name: f.legal_name.value.trim(), country: f.country.value, paypal_email: f.paypal_email.value.trim(), paypal_username: f.paypal_username.value.trim() };
    const bad = [];
    f.legal_name.classList.toggle("bad-in", v.legal_name.length < 2); if (v.legal_name.length < 2) bad.push("your full name");
    f.country.classList.toggle("bad-in", !v.country); if (!v.country) bad.push("your country");
    f.paypal_email.classList.toggle("bad-in", !EMAIL.test(v.paypal_email)); if (!EMAIL.test(v.paypal_email)) bad.push("your PayPal email");
    if (bad.length) { err.textContent = `Please add ${bad.join(", ")}.`; return; }
    go.disabled = true; go.textContent = "Saving…"; err.textContent = "";
    try {
      const r = await call({ action: "submit", ...v });
      if (r.state === "used") return message("Already saved", "Your details were already sent through this link. If something changed, ask your Stellar contact for a new link.");
      if (r.state === "gone") return message("This link has expired", "Ask your Stellar contact for a new one.");
      message("Thank you!", "Your payment details are saved. You can close this page.", true);
    } catch (x) { err.textContent = x.message; go.disabled = false; go.textContent = "Save my details"; }
  };
}

(async () => {
  if (!/^[0-9a-f]{64}$/.test(token)) return message("This link doesn't work", "Check that you copied the whole link, or ask your Stellar contact for a new one.");
  try {
    const st = await call({ action: "status" });
    if (st.state === "open") return form(st);
    if (st.state === "used") return message("Already saved", "Your details were already sent through this link. If something changed, ask your Stellar contact for a new link.");
    message("This link has expired", "Ask your Stellar contact for a new one.");
  } catch (x) { message("Something went wrong", esc(x.message)); }
})();
