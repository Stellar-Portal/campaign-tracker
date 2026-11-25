// Client report: the page behind a "Share with client" link (share.html#t=<token>).
// No login. The token in the link is checked by the `share` function, which returns only
// what the link's settings allow, and never budgets or costs.
import { SUPABASE_URL } from "./config.js?v=20261125c";
import { mountReport, esc } from "./report.js?v=20261125c";

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
  load: async () => { const d = await call({}); if (d.drafts_review) mountDrafts(); return d; },
  loadCovers: async (ids) => (await call({ covers: ids })).covers,
  postDaily: async (vid) => (await call({ post: vid })).daily,
  onError: (e) => renderGone(e.status === 404 ? null : "We couldn't load this report. Check your connection and try again in a minute."),
});
window.addEventListener("hashchange", () => location.reload());

// Drafts for the client to approve (only when Stellar switched client review on for the campaign).
// Approving or asking for changes goes straight back to the creator's page.
async function mountDrafts() {
  let box = document.getElementById("cdr");
  if (!box) { box = document.createElement("section"); box.id = "cdr"; box.className = "cdr"; box.setAttribute("aria-label", "Drafts to approve"); app.after(box); }
  let list = [];
  try { list = (await call({ drafts: true })).drafts ?? []; } catch { return; }
  const waiting = list.filter((d) => d.status === "team_ok");
  let pill = document.getElementById("cdr-pill");
  if (waiting.length && !pill) { pill = document.createElement("a"); pill.id = "cdr-pill"; pill.className = "cdr-pill"; pill.href = "#cdr"; document.body.append(pill); pill.onclick = (e) => { e.preventDefault(); box.scrollIntoView({ behavior: "smooth" }); }; }
  if (pill) { pill.hidden = !waiting.length; pill.textContent = `${waiting.length} draft${waiting.length === 1 ? "" : "s"} to review`; }
  const label = { team_ok: ["wait", "Waiting for you"], approved: ["ok", "Approved"], client_changes: ["fix", "Changes asked"] };
  const day = (d) => new Date(d).toLocaleDateString(undefined, { day: "numeric", month: "short" });
  box.innerHTML = `<div class="cdr-in"><h2>Drafts${waiting.length ? ` <span class="cdr-n">${waiting.length} to review</span>` : ""}</h2>
    <p class="muted">Creators' drafts that Stellar has checked. Approve them, or tell the creator what to change: they see your answer straight away.</p>
    ${list.length ? `<div class="cdr-grid">${list.map((d) => { const [c, l] = label[d.status] ?? ["", d.status]; return `<article class="cdr-card">
      ${d.video ? `<video src="${esc(d.video)}" controls playsinline preload="metadata"></video>` : `<div class="cdr-novid">Video unavailable</div>`}
      <div class="cdr-body"><div class="cdr-h"><b>@${esc(d.creator?.username ?? "creator")}</b><span class="cdr-pill-s ${c}">${l}</span></div>
      <div class="muted small">${[d.song, d.folder, `sent ${day(d.sent_at)}`].filter(Boolean).map(esc).join(" · ")}</div>
      ${d.stellar_note ? `<p class="cdr-note"><b>Stellar:</b> ${esc(d.stellar_note)}</p>` : ""}
      ${d.client_note ? `<p class="cdr-note you"><b>You:</b> ${esc(d.client_note)}</p>` : ""}
      ${d.status === "team_ok" ? `<form class="cdr-act" data-id="${esc(d.id)}"><textarea name="note" rows="2" maxlength="1000" placeholder="Feedback for the creator (needed if you ask for changes)" aria-label="Feedback for the creator"></textarea>
        <div class="cdr-btns"><button type="submit" value="approve" class="primary">Approve</button><button type="submit" value="changes">Ask for changes</button></div><p class="cdr-err" role="alert"></p></form>` : ""}
      </div></article>`; }).join("")}</div>` : `<p class="muted">No drafts to review yet.</p>`}</div>`;
  box.querySelectorAll(".cdr-act").forEach((f) => (f.onsubmit = async (e) => {
    e.preventDefault();
    const decision = e.submitter?.value === "changes" ? "changes" : "approve", note = f.note.value.trim(), err = f.querySelector(".cdr-err");
    if (decision === "changes" && !note) { err.textContent = "Tell the creator what to change."; f.note.focus(); return; }
    f.querySelectorAll("button").forEach((b) => (b.disabled = true));
    try {
      const res = await fetch(FN, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token, draft_decide: f.dataset.id, decision, note }) });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.error || "Couldn't save. Please try again.");
      await mountDrafts();
    } catch (x) { err.textContent = x.message; f.querySelectorAll("button").forEach((b) => (b.disabled = false)); }
  }));
}
