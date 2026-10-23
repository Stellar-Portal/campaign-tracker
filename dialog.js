// In-app confirmation dialog (instead of the browser's own confirm box).
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
export function confirmDialog({ title, body = "", checks = [], confirm = "Delete", danger = true }) {
  return new Promise((resolve) => {
    const back = document.createElement("div");
    back.className = "dlg-back";
    back.innerHTML = `<div class="dlg" role="dialog" aria-modal="true" aria-labelledby="dlg-t">
      <h3 id="dlg-t">${esc(title)}</h3>${body ? `<p>${body}</p>` : ""}
      ${checks.map((c) => `<label class="check"><input type="checkbox" data-k="${esc(c.id)}" ${c.checked ? "checked" : ""}><span>${c.label}</span></label>`).join("")}
      <div class="actions"><button type="button" data-no>Cancel</button><button type="button" class="${danger ? "danger-solid" : "primary"}" data-yes>${esc(confirm)}</button></div></div>`;
    document.body.appendChild(back);
    const done = (v) => { back.remove(); document.removeEventListener("keydown", key); resolve(v); };
    const key = (e) => { if (e.key === "Escape") done(null); };
    document.addEventListener("keydown", key);
    back.onclick = (e) => { if (e.target === back) done(null); };
    back.querySelector("[data-no]").onclick = () => done(null);
    back.querySelector("[data-yes]").onclick = () => done(Object.fromEntries([...back.querySelectorAll("[data-k]")].map((i) => [i.dataset.k, i.checked])));
    back.querySelector("[data-yes]").focus();
  });
}
