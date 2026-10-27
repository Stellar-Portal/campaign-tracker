// Decks: pitch decks shared as tracked links (the public side is deck.html + the deck-view function).
// Decks come in from Figma Slides through the "Send to Stellar OS" Figma button (figma-plugin/), which
// calls the deck-import function. Here the team makes links, switches them off, sees who viewed what,
// adds videos the import couldn't fetch, and keeps an eye on the Figma connection's expiry date.
import { confirmDialog } from "./dialog.js?v=20261027m";

const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const day = (d) => (d ? new Date(d).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "");
const ago = (iso) => {
  if (!iso) return "";
  const s = (Date.now() - Date.parse(iso)) / 1000;
  return s < 60 ? "just now" : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : s < 7 * 86400 ? `${Math.round(s / 86400)} d ago` : day(iso);
};
const dur = (ms) => { const s = Math.round((ms || 0) / 1000); return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`; };
const place = (tz) => (tz ? tz.split("/").pop().replace(/_/g, " ") : "");
const deckUrl = (token) => `${new URL("deck.html", location.href.split("#")[0]).href}#t=${token}`;
const daysLeft = (d) => (d ? Math.ceil((Date.parse(`${d}T00:00:00`) - Date.now()) / 86400000) : null);
const PLUGIN_ZIP = "figma-plugin/send-to-stellar-os.zip";

async function signed(sb, paths) {
  const out = {};
  const list = [...new Set(paths.filter(Boolean))];
  for (let i = 0; i < list.length; i += 100) {
    const { data } = await sb.storage.from("deck-media").createSignedUrls(list.slice(i, i + 100), 3600);
    for (const s of data ?? []) if (s.signedUrl) out[s.path] = s.signedUrl;
  }
  return out;
}
const myEmail = async (sb) => (await sb.auth.getSession()).data.session?.user?.email?.toLowerCase() ?? null;

async function copy(text, toast, what = "Link copied") {
  try { await navigator.clipboard.writeText(text); toast?.(what); }
  catch { toast?.("Couldn't copy. Select the text and copy it yourself."); }
}

// ---------- Figma connection: expiry countdown ----------
function tokenLine(exp) {
  const n = daysLeft(exp);
  if (n == null) return `<span class="dk-tok">Figma connection: no expiry date saved.</span>`;
  const cls = n <= 3 ? "bad" : n <= 14 ? "warn" : "";
  const txt = n < 0 ? `expired on ${day(exp)}. Imports won't work until a new token is saved.` : n === 0 ? "expires today." : `expires in ${n} day${n === 1 ? "" : "s"} (${day(exp)}).`;
  return `<span class="dk-tok ${cls}">Figma connection ${txt}</span>`;
}

// A reminder across the whole OS in the last 14 days before the Figma token expires.
let reminded = false;
export async function figmaReminder(sb) {
  if (reminded) return;
  reminded = true;
  const { data: exp } = await sb.rpc("figma_token_expiry");
  const n = daysLeft(exp);
  if (n == null || n > 14) return;
  try { if (localStorage.getItem("fig-remind") === new Date().toDateString()) return; } catch { /* ignore */ }
  const bar = document.createElement("div");
  bar.className = `fig-remind${n <= 3 ? " bad" : ""}`;
  bar.setAttribute("role", "status");
  bar.innerHTML = `<span>${n < 0 ? "The Figma connection has expired: decks can't be imported." : `The Figma connection expires ${n === 0 ? "today" : `in ${n} day${n === 1 ? "" : "s"}`}.`} Make a new token in Figma, save it in Supabase as FIGMA_TOKEN, then update the date in Decks.</span>
    <a href="#/decks">Open Decks</a><button type="button" aria-label="Hide until tomorrow">×</button>`;
  bar.querySelector("button").onclick = () => { bar.remove(); try { localStorage.setItem("fig-remind", new Date().toDateString()); } catch { /* ignore */ } };
  document.querySelector(".content")?.prepend(bar);
}

function expiryDialog(sb, exp, onDone) {
  const d = document.createElement("dialog");
  d.className = "po-dialog";
  d.innerHTML = `<form method="dialog">
    <h2>Figma connection</h2>
    <p class="muted small">Figma tokens last up to 90 days. When you make a new one (Figma → Settings → Security → Personal access tokens, with <b>file_content:read</b> and <b>file_metadata:read</b>), save it in Supabase → Edge Functions → Secrets as <b>FIGMA_TOKEN</b>, then enter its expiry date here.</p>
    <label>Expires on <input type="date" name="d" value="${esc(exp ?? "")}" required></label>
    <div class="actions"><button type="submit" value="ok" class="primary">Save date</button><button type="submit" value="cancel" formnovalidate>Cancel</button></div></form>`;
  document.body.append(d);
  d.addEventListener("close", async () => {
    const v = d.querySelector("[name=d]").value;
    if (d.returnValue === "ok" && v) { await sb.rpc("set_figma_token_expiry", { p_date: v }); onDone?.(); }
    d.remove();
  });
  d.showModal();
}

// ---------- the Figma button: setup + personal keys ----------
async function figmaButtonDialog(sb, toast) {
  const d = document.createElement("dialog");
  d.className = "po-dialog dk-setup";
  document.body.append(d);
  const draw = async (newKey) => {
    const { data: keys } = await sb.from("deck_plugin_keys").select("id,hint,created_at,last_used_at,revoked_at").order("created_at", { ascending: false });
    const live = (keys ?? []).filter((k) => !k.revoked_at);
    d.innerHTML = `<form method="dialog">
      <h2>The "Send to Stellar OS" button</h2>
      <p class="muted small">It sends a deck from Figma Slides to Stellar OS with its slides, links and TikTok videos. Each person sets it up once, in the Figma desktop app.</p>
      <ol class="dk-steps">
        <li><b>Download the button</b> and unzip it. <a class="dk-dl" href="${PLUGIN_ZIP}" download>Download (zip)</a></li>
        <li>In the Figma desktop app, open any deck, then <b>Plugins → Development → Import plugin from manifest…</b> and pick <b>manifest.json</b> from the unzipped folder.</li>
        <li><b>Make your key</b> and paste it into the button the first time you open it.
          ${newKey ? `<div class="dk-key"><code>${esc(newKey)}</code><button type="button" data-copy>Copy</button></div><p class="small dk-once">Copy it now: it won't be shown again.</p>`
          : `<div style="margin-top:8px"><button type="button" class="primary" data-make>Make my key</button></div>`}</li>
        <li>From then on: open a deck → <b>Plugins → Development → Send to Stellar OS</b> → <b>Send</b>. Sending the same deck again updates it, and its links show the new version.</li>
      </ol>
      ${live.length ? `<div class="dk-keys"><b class="small">Your keys</b>${live.map((k) => `<div class="dk-keyrow"><span>•••• ${esc(k.hint)}</span><span class="muted small">made ${esc(day(k.created_at))}${k.last_used_at ? ` · used ${esc(ago(k.last_used_at))}` : " · not used yet"}</span><button type="button" class="linkish" data-revoke="${k.id}">Switch off</button></div>`).join("")}</div>` : ""}
      <div class="actions"><button type="submit" value="cancel">Done</button></div></form>`;
    d.querySelector("[data-make]")?.addEventListener("click", async () => {
      const { data, error } = await sb.rpc("create_deck_plugin_key");
      if (error) { toast?.(error.message); return; }
      draw(data);
    });
    d.querySelector("[data-copy]")?.addEventListener("click", () => copy(newKey, toast, "Key copied"));
    d.querySelectorAll("[data-revoke]").forEach((b) => (b.onclick = async () => {
      const ok = await confirmDialog({ title: "Switch off this key?", body: "The Figma button stops working with it. You can make a new one any time.", confirm: "Switch off" });
      if (!ok) return;
      await sb.rpc("revoke_deck_plugin_key", { p_id: b.dataset.revoke });
      draw();
    }));
  };
  await draw();
  d.addEventListener("close", () => d.remove());
  d.showModal();
}

// ---------- list ----------
export async function renderDecks(app, sb, ctx) {
  if (ctx.parts[1]) return renderDeck(app, sb, ctx, ctx.parts[1]);
  app.innerHTML = `<p class="muted pad">Loading decks…</p>`;
  const [dk, ss, exp] = await Promise.all([
    sb.from("decks").select("id,title,current_version_id,updated_at,created_at").order("updated_at", { ascending: false }),
    sb.from("deck_sessions").select("deck_id,email,started_at").order("started_at", { ascending: false }).limit(5000),
    sb.rpc("figma_token_expiry"),
  ]);
  if (!ctx.isCurrent()) return;
  if (dk.error) { app.innerHTML = `<p class="error">${esc(dk.error.message)}</p>`; return; }
  const decks = dk.data ?? [];
  const vids = decks.map((d) => d.current_version_id).filter(Boolean);
  const [vs, covers] = await Promise.all([
    vids.length ? sb.from("deck_versions").select("id,slide_count,note,status").in("id", vids) : { data: [] },
    vids.length ? sb.from("deck_slides").select("version_id,image_path").in("version_id", vids).eq("n", 1) : { data: [] },
  ]);
  const urls = await signed(sb, (covers.data ?? []).map((c) => c.image_path));
  if (!ctx.isCurrent()) return;
  const ver = Object.fromEntries((vs.data ?? []).map((v) => [v.id, v]));
  const cover = Object.fromEntries((covers.data ?? []).map((c) => [c.version_id, urls[c.image_path]]));
  const views = {};
  for (const s of ss.data ?? []) (views[s.deck_id] ??= []).push(s);

  app.innerHTML = `
    <div class="page-head"><div><h1>Decks</h1>
      <p class="muted small" style="margin:6px 0 0">Share a pitch deck as a link and see who opened it, which slides they read and for how long.</p></div>
      <div class="actions" style="margin:0"><button type="button" id="dk-btn" class="primary">Figma button</button></div></div>
    <p class="small dk-tokline">${tokenLine(exp.data)} <button type="button" class="linkish" id="dk-exp">Update date</button></p>
    ${!decks.length ? `<div class="panel dk-empty"><h2>No decks yet</h2>
      <p class="muted">Decks come straight from Figma Slides. Set up the <b>Send to Stellar OS</b> button once (two minutes), then send any deck from Figma.</p>
      <button type="button" class="primary" id="dk-btn2">Set up the Figma button</button></div>` : `
    <div class="dk-grid">${decks.map((d) => {
      const v = ver[d.current_version_id] ?? {}, vw = views[d.id] ?? [];
      const people = new Set(vw.map((s) => s.email).filter(Boolean)).size;
      const issues = (v.note ?? "").split("\n").filter(Boolean).length;
      return `<a class="dk-card" href="#/decks/${d.id}">
        <span class="dk-cover">${cover[d.current_version_id] ? `<img src="${esc(cover[d.current_version_id])}" alt="" loading="lazy">` : ""}${issues ? `<i class="dk-flag">${issues} to fix</i>` : ""}</span>
        <span class="dk-meta"><b>${esc(d.title)}</b>
          <span class="muted small">${v.slide_count ?? 0} slides · updated ${esc(ago(d.updated_at))}</span>
          <span class="small">${vw.length ? `<b>${vw.length}</b> view${vw.length === 1 ? "" : "s"} · ${people} ${people === 1 ? "person" : "people"} · last ${esc(ago(vw[0].started_at))}` : `<span class="muted">No views yet</span>`}</span></span></a>`;
    }).join("")}</div>`}`;
  const again = () => renderDecks(app, sb, ctx);
  app.querySelector("#dk-btn").onclick = () => figmaButtonDialog(sb, ctx.toast);
  app.querySelector("#dk-btn2")?.addEventListener("click", () => figmaButtonDialog(sb, ctx.toast));
  app.querySelector("#dk-exp").onclick = () => expiryDialog(sb, exp.data, again);
}

// ---------- one deck ----------
async function renderDeck(app, sb, ctx, id) {
  app.innerHTML = `<p class="muted pad">Loading deck…</p>`;
  const { data: deck, error } = await sb.from("decks").select("id,title,figma_url,current_version_id,updated_at").eq("id", id).maybeSingle();
  if (!ctx.isCurrent()) return;
  if (error || !deck) { app.innerHTML = `<div class="panel"><p class="muted" style="margin:0">This deck doesn't exist any more.</p></div>`; return; }
  const [ver, slides, spots, links, sess] = await Promise.all([
    sb.from("deck_versions").select("id,version,slide_count,note,created_at,created_by").eq("id", deck.current_version_id).maybeSingle(),
    sb.from("deck_slides").select("n,image_path").eq("version_id", deck.current_version_id).order("n"),
    sb.from("deck_spots").select("id,n,kind,label,layer_name,status,note,video_path").eq("version_id", deck.current_version_id).order("n"),
    sb.from("deck_links").select("id,token,label,enabled,expires_at,require_email,created_at,created_by").eq("deck_id", id).order("created_at", { ascending: false }),
    sb.from("deck_sessions").select("id,link_id,email,started_at,last_seen_at,total_ms,furthest_slide,slide_count,device,browser,os,country,timezone").eq("deck_id", id).order("started_at", { ascending: false }).limit(1000),
  ]);
  const sessIds = (sess.data ?? []).map((s) => s.id);
  const [per, clicks] = sessIds.length ? await Promise.all([
    sb.from("deck_session_slides").select("session_id,n,ms").in("session_id", sessIds.slice(0, 300)),
    sb.from("deck_clicks").select("session_id,n,url,clicked_at").in("session_id", sessIds.slice(0, 300)),
  ]) : [{ data: [] }, { data: [] }];
  const thumbs = await signed(sb, (slides.data ?? []).map((s) => s.image_path));
  if (!ctx.isCurrent()) return;

  const S = slides.data ?? [], L = links.data ?? [], V = sess.data ?? [];
  const thumb = Object.fromEntries(S.map((s) => [s.n, thumbs[s.image_path]]));
  const bySess = {};
  for (const r of per.data ?? []) (bySess[r.session_id] ??= {})[r.n] = Number(r.ms);
  const clicksBy = {};
  for (const c of clicks.data ?? []) (clicksBy[c.session_id] ??= []).push(c);
  const missing = (spots.data ?? []).filter((s) => s.kind === "video" && s.status !== "ready");
  const linkName = Object.fromEntries(L.map((l) => [l.id, l.label || "Link"]));
  const viewsBy = {};
  for (const s of V) viewsBy[s.link_id] = (viewsBy[s.link_id] ?? 0) + 1;
  const people = new Set(V.map((s) => s.email).filter(Boolean));
  const totalMs = V.reduce((t, s) => t + Number(s.total_ms || 0), 0);
  // Average seconds per slide, over the views that reached that slide.
  const slideAvg = S.map((s) => {
    const xs = V.map((v) => bySess[v.id]?.[s.n]).filter((x) => x > 0);
    return { n: s.n, avg: xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0, reached: xs.length };
  });
  const maxAvg = Math.max(1, ...slideAvg.map((x) => x.avg));
  let open = null;

  const draw = () => {
    app.innerHTML = `
      <div class="page-head"><div><p class="muted small" style="margin:0"><a href="#/decks">Decks</a></p><h1>${esc(deck.title)}</h1>
        <p class="muted small" style="margin:6px 0 0">${ver.data?.slide_count ?? S.length} slides · version ${ver.data?.version ?? 1}, sent ${esc(ago(ver.data?.created_at))}${ver.data?.created_by && ver.data.created_by !== "system" ? ` by ${esc(ver.data.created_by.split("@")[0])}` : ""}${deck.figma_url ? ` · <a href="${esc(deck.figma_url)}" target="_blank" rel="noopener">Open in Figma</a>` : ""}</p></div>
        <div class="actions" style="margin:0"><button type="button" id="dk-rename">Rename</button><button type="button" class="primary" id="dk-new">New link</button></div></div>

      <div class="an-hero dk-hero">
        <div class="an-hero-card"><div class="l">Views</div><div class="n">${V.length}</div><div class="d">${people.size} ${people.size === 1 ? "person" : "people"}${V[0] ? ` · last ${esc(ago(V[0].started_at))}` : ""}</div></div>
        <div class="an-hero-card"><div class="l">Average time</div><div class="n">${V.length ? dur(totalMs / V.length) : "–"}</div><div class="d">per view</div></div>
        <div class="an-hero-card"><div class="l">Link clicks</div><div class="n">${(clicks.data ?? []).length}</div><div class="d">links opened from the deck</div></div>
      </div>

      ${missing.length ? `<div class="panel dk-fix"><h2>Needs attention</h2>
        <p class="muted small">These videos show as a still image until a video is added. Upload the MP4, or rename the video layer in Figma to include the TikTok ID and send the deck again.</p>
        ${missing.map((m) => `<div class="dk-fixrow">${thumb[m.n] ? `<img src="${esc(thumb[m.n])}" alt="">` : ""}<span><b>Slide ${m.n}</b> · ${esc(m.layer_name || "Video")}<br><span class="muted small">${esc(m.note || "")}</span></span>
          <label class="dk-up"><input type="file" accept="video/mp4,video/quicktime,video/webm" data-spot="${m.id}" data-n="${m.n}" hidden><span>Upload video</span></label></div>`).join("")}</div>` : ""}

      <div class="panel dk-panel"><div class="dk-head"><h2>Links</h2><span class="muted small">Make one link per company or person, so you know who's viewing.</span></div>
        ${!L.length ? `<p class="muted" style="margin:0">No links yet. <button type="button" class="linkish" id="dk-new2">Make the first link</button></p>` : `
        <div class="table-wrap dk-tbl"><table><thead><tr><th>Name</th><th>Views</th><th>Email asked</th><th>Expires</th><th>On</th><th></th></tr></thead><tbody>
          ${L.map((l) => `<tr class="${l.enabled ? "" : "dk-off"}"><td><b>${esc(l.label || "Link")}</b><br><span class="muted small">made ${esc(day(l.created_at))}</span></td>
            <td>${viewsBy[l.id] ?? 0}</td><td>${l.require_email ? "Yes" : "No"}</td>
            <td><input type="date" value="${esc(l.expires_at ? l.expires_at.slice(0, 10) : "")}" data-exp="${l.id}" aria-label="Expiry date"></td>
            <td><label class="switch"><input type="checkbox" data-on="${l.id}" ${l.enabled ? "checked" : ""} aria-label="Link on"><span></span></label></td>
            <td class="dk-acts"><button type="button" data-copy="${esc(l.token)}">Copy link</button></td></tr>`).join("")}
        </tbody></table></div>`}</div>

      ${S.length ? `<div class="panel dk-panel"><div class="dk-head"><h2>Slides</h2><span class="muted small">Average time on each slide, and how many views reached it.</span></div>
        <div class="dk-slides">${slideAvg.map((x) => `<div class="dk-sl">${thumb[x.n] ? `<img src="${esc(thumb[x.n])}" alt="Slide ${x.n}" loading="lazy">` : `<span class="dk-noimg"></span>`}
          <span class="dk-sl-n">${x.n}</span><span class="dk-bar"><i style="width:${(x.avg / maxAvg) * 100}%"></i></span>
          <span class="small">${x.avg ? dur(x.avg) : "–"} <span class="muted">· ${x.reached}/${V.length || 0}</span></span></div>`).join("")}</div></div>` : ""}

      <div class="panel dk-panel"><div class="dk-head"><h2>Views</h2><span class="muted small">Your own views while signed in aren't counted.</span></div>
        ${!V.length ? `<p class="muted" style="margin:0">No views yet. When someone opens a link, they show up here.</p>` : `
        <div class="dk-views">${V.slice(0, 200).map((s) => {
          const c = clicksBy[s.id] ?? [], seen = Object.keys(bySess[s.id] ?? {}).length;
          return `<div class="dk-view${open === s.id ? " on" : ""}"><button type="button" class="dk-vrow" data-view="${s.id}" aria-expanded="${open === s.id}">
            <span><b>${esc(s.email || "No email")}</b><br><span class="muted small">${esc(ago(s.started_at))} · ${esc(linkName[s.link_id] ?? "Link")}</span></span>
            <span class="small">${dur(s.total_ms)}</span><span class="small">${seen}/${s.slide_count || S.length} slides</span>
            <span class="small muted">${[s.device, s.browser, place(s.timezone) || s.country].filter(Boolean).map(esc).join(" · ")}</span>
            <span class="small">${c.length ? `${c.length} click${c.length === 1 ? "" : "s"}` : ""}</span></button>
            ${open === s.id ? viewDetail(s, bySess[s.id] ?? {}, c) : ""}</div>`;
        }).join("")}</div>`}</div>`;
    bind();
  };

  const viewDetail = (s, ms, c) => {
    const max = Math.max(1, ...Object.values(ms));
    return `<div class="dk-vdetail">
      <div class="dk-slides small-thumbs">${S.map((x) => `<div class="dk-sl${ms[x.n] ? "" : " skip"}">${thumb[x.n] ? `<img src="${esc(thumb[x.n])}" alt="Slide ${x.n}" loading="lazy">` : `<span class="dk-noimg"></span>`}
        <span class="dk-sl-n">${x.n}</span><span class="dk-bar"><i style="width:${((ms[x.n] || 0) / max) * 100}%"></i></span><span class="small">${ms[x.n] ? dur(ms[x.n]) : "not seen"}</span></div>`).join("")}</div>
      ${c.length ? `<p class="small" style="margin:12px 0 0"><b>Links opened:</b> ${c.map((k) => `slide ${k.n}: <a href="${esc(k.url)}" target="_blank" rel="noopener">${esc(k.url.replace(/^https?:\/\/(www\.)?/, "").split(/[?#]/)[0].slice(0, 50))}</a>`).join(" · ")}</p>` : ""}
      <p class="muted small" style="margin:10px 0 0">Opened ${esc(new Date(s.started_at).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" }))}${s.timezone ? ` · their time zone: ${esc(s.timezone)}` : ""}${s.os ? ` · ${esc(s.os)}` : ""}</p></div>`;
  };

  const reload = () => renderDeck(app, sb, ctx, id);
  function bind() {
    app.querySelectorAll("[data-view]").forEach((b) => (b.onclick = () => { open = open === b.dataset.view ? null : b.dataset.view; draw(); }));
    app.querySelectorAll("[data-copy]").forEach((b) => (b.onclick = () => copy(deckUrl(b.dataset.copy), ctx.toast)));
    app.querySelectorAll("[data-on]").forEach((i) => (i.onchange = async () => {
      const { error } = await sb.from("deck_links").update({ enabled: i.checked }).eq("id", i.dataset.on);
      if (error) { ctx.toast?.(error.message); i.checked = !i.checked; return; }
      L.find((l) => l.id === i.dataset.on).enabled = i.checked;
      i.closest("tr").classList.toggle("dk-off", !i.checked);
      ctx.toast?.(i.checked ? "Link is on" : "Link switched off: it now shows \"This link isn't active\"");
    }));
    app.querySelectorAll("[data-exp]").forEach((i) => (i.onchange = async () => {
      const v = i.value ? new Date(`${i.value}T23:59:59`).toISOString() : null;
      const { error } = await sb.from("deck_links").update({ expires_at: v }).eq("id", i.dataset.exp);
      ctx.toast?.(error ? error.message : v ? `Link expires ${day(v)}` : "Link never expires");
    }));
    app.querySelector("#dk-new").onclick = newLink;
    app.querySelector("#dk-new2")?.addEventListener("click", newLink);
    app.querySelector("#dk-rename").onclick = rename;
    app.querySelectorAll("[data-spot]").forEach((inp) => (inp.onchange = () => upload(inp)));
  }

  function newLink() {
    const d = document.createElement("dialog");
    d.className = "po-dialog";
    d.innerHTML = `<form method="dialog">
      <h2>New link</h2>
      <p class="muted small">One link per company or person tells you exactly who's viewing.</p>
      <label>Who is it for? <input name="label" placeholder="e.g. Universal Music · A&amp;R team" required maxlength="120"></label>
      <label class="check"><input type="checkbox" name="email" checked> <span>Ask for an email before showing the deck</span></label>
      <label>Expires <input type="date" name="exp"> <span class="muted small">Leave empty to keep it open.</span></label>
      <div class="actions"><button type="submit" value="ok" class="primary">Make link</button><button type="submit" value="cancel" formnovalidate>Cancel</button></div></form>`;
    document.body.append(d);
    d.addEventListener("close", async () => {
      if (d.returnValue === "ok") {
        const f = d.querySelector("form");
        const exp = f.exp.value ? new Date(`${f.exp.value}T23:59:59`).toISOString() : null;
        const { data, error } = await sb.from("deck_links").insert({ deck_id: id, label: f.label.value.trim(), require_email: f.email.checked, expires_at: exp, created_by: await myEmail(sb) }).select("token").single();
        if (error) ctx.toast?.(error.message);
        else { await copy(deckUrl(data.token), ctx.toast, "Link made and copied"); reload(); }
      }
      d.remove();
    });
    d.showModal();
  }

  function rename() {
    const d = document.createElement("dialog");
    d.className = "po-dialog";
    d.innerHTML = `<form method="dialog"><h2>Rename deck</h2>
      <p class="muted small">Viewers see this name in their browser tab.</p>
      <label>Name <input name="t" value="${esc(deck.title)}" required maxlength="200"></label>
      <div class="actions"><button type="submit" value="ok" class="primary">Save</button><button type="submit" value="cancel" formnovalidate>Cancel</button></div></form>`;
    document.body.append(d);
    d.addEventListener("close", async () => {
      const t = d.querySelector("[name=t]").value.trim();
      if (d.returnValue === "ok" && t && t !== deck.title) {
        const { error } = await sb.from("decks").update({ title: t }).eq("id", id);
        if (error) ctx.toast?.(error.message); else { deck.title = t; draw(); }
      }
      d.remove();
    });
    d.showModal();
  }

  async function upload(inp) {
    const f = inp.files?.[0];
    if (!f) return;
    if (f.size > 100 * 1024 * 1024) { ctx.toast?.("That file is over 100 MB. Export a smaller version and try again."); return; }
    const lab = inp.closest(".dk-up").querySelector("span");
    lab.textContent = "Uploading…";
    const ext = (f.name.split(".").pop() || "mp4").toLowerCase().replace(/[^a-z0-9]/g, "") || "mp4";
    const path = `${id}/${deck.current_version_id}/upload-${inp.dataset.spot}.${ext}`;
    const up = await sb.storage.from("deck-media").upload(path, f, { contentType: f.type || "video/mp4", upsert: true });
    if (up.error) { lab.textContent = "Upload video"; ctx.toast?.(up.error.message); return; }
    const { error } = await sb.from("deck_spots").update({ video_path: path, status: "ready", note: null }).eq("id", inp.dataset.spot);
    if (error) { lab.textContent = "Upload video"; ctx.toast?.(error.message); return; }
    // Clear the "to fix" note on the version once every video is in.
    const left = missing.filter((m) => m.id !== inp.dataset.spot);
    if (!left.length) await sb.from("deck_versions").update({ note: null }).eq("id", deck.current_version_id);
    ctx.toast?.(`Video added to slide ${inp.dataset.n}`);
    reload();
  }

  draw();
}
