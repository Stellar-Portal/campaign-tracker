// Client report: the page behind a "Share with client" link (share.html#t=<token>).
// No login. The token in the link is checked by the `share` function, which returns only
// what the link's settings allow, and never budgets or costs.
import { SUPABASE_URL } from "./config.js?v=20261015h";
import { mountReport, esc } from "./report.js?v=20261015h";

const app = document.getElementById("app");
const FN = `${SUPABASE_URL}/functions/v1/share`;
const token = (new URLSearchParams(location.hash.slice(1)).get("t") || new URLSearchParams(location.search).get("t") || "").trim();

async function call(body) {
  const res = await fetch(FN, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token, ...body }) });
  if (!res.ok) { const e = new Error(`HTTP ${res.status}`); e.status = res.status; throw e; }
  return res.json();
}

function renderGone(msg) {
  document.body.classList.add("signin");
  app.innerHTML = `<section class="login on-blue">
    <img class="logo" src="assets/stellar-blue.png" alt="Stellar" width="160" height="44">
    <h1>Campaign <em>report</em></h1>
    <p>${esc(msg ?? "This link isn't active. Ask your Stellar contact for a new one.")}</p></section>`;
}

if (!/^[0-9a-f]{40,128}$/i.test(token)) renderGone();
else mountReport(app, {
  mode: "client",
  load: () => call({}),
  loadCovers: async (ids) => (await call({ covers: ids })).covers,
  postDaily: async (vid) => (await call({ post: vid })).daily,
  onError: (e) => renderGone(e.status === 404 ? null : "We couldn't load this report. Check your connection and try again in a minute."),
});
window.addEventListener("hashchange", () => location.reload());
