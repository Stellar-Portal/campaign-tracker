// Tracked deck viewer: the page behind a deck link (deck.html#t=<token>).
// No login. The `deck-view` function checks the link, hands out slide images and videos as
// short-lived links, and records time per slide. Time only counts while this tab is visible;
// totals are running sums, so resending them (heartbeat, page close, retry) never double-counts.
import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from "./config.js?v=20261027h";

const FN = `${SUPABASE_URL}/functions/v1/deck-view`;
const app = document.getElementById("app");
const token = (new URLSearchParams(location.hash.slice(1)).get("t") || new URLSearchParams(location.search).get("t") || "").trim().toLowerCase();
const PASS_KEY = `stellar-deck-pass:${token}`;
const HEARTBEAT = 15000, IDLE_LIMIT = 5 * 60 * 1000;
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
};
const ARROW = (d) => `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${d === "prev" ? "M15 18l-6-6 6-6" : "M9 6l6 6-6 6"}"/></svg>`;

// Stellar team members signed in to the OS in this browser view without being tracked.
async function teamToken() {
  try {
    const has = Object.keys(localStorage).some((k) => k.startsWith("sb-") && k.endsWith("-auth-token"));
    if (!has) return null;
    const { createClient } = await import("./vendor/supabase.esm.js");
    const { data } = await createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY).auth.getSession();
    return data.session?.access_token ?? null;
  } catch { return null; }
}

async function call(body, auth) {
  const headers = { "Content-Type": "text/plain" };
  if (auth) headers.Authorization = `Bearer ${auth}`;
  const res = await fetch(FN, { method: "POST", headers, body: JSON.stringify({ token, ...body }) });
  let data = {};
  try { data = await res.json(); } catch { /* empty */ }
  if (!res.ok) { const e = new Error(data.error || `HTTP ${res.status}`); e.status = res.status; e.data = data; throw e; }
  return data;
}

function renderMessage(msg) {
  document.body.className = "";
  app.innerHTML = `<section class="gate">
    <img class="wm" src="assets/stellar-white.png" alt="Stellar" width="150" height="41">
    <h1>${esc(msg)}</h1>
    <p class="sub">Ask your Stellar contact for a new link.</p></section>`;
}

function renderGate(errMsg = "") {
  document.body.className = "";
  app.innerHTML = `<section class="gate">
    <img class="wm" src="assets/stellar-white.png" alt="Stellar" width="150" height="41">
    <h1>You've been sent a deck</h1>
    <p class="sub">Enter your work email to view it.</p>
    <form novalidate>
      <label for="em" style="position:absolute;left:-9999px">Work email</label>
      <input id="em" type="email" inputmode="email" autocomplete="email" placeholder="name@company.com" required>
      <p class="err" role="alert">${esc(errMsg)}</p>
      <button type="submit">View deck</button>
    </form>
    <p class="legal">Stellar records your email, which slides you view and for how long, and the links you open, to follow up on this deck. <a href="privacy.html" target="_blank" rel="noopener">Privacy policy</a></p>
  </section>`;
  const form = app.querySelector("form"), input = form.querySelector("input"), btn = form.querySelector("button"), err = form.querySelector(".err");
  setTimeout(() => input.focus(), 50);
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = input.value.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) { err.textContent = "Enter a valid email address."; input.focus(); return; }
    btn.disabled = true; btn.textContent = "Opening…"; err.textContent = "";
    try { start(await call({ action: "open", email, tz: tz() })); }
    catch (x) { btn.disabled = false; btn.textContent = "View deck"; err.textContent = x.data?.error || "We couldn't open the deck. Check your connection and try again."; }
  });
}

const tz = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return null; } };

async function boot() {
  if (!/^[a-f0-9]{24,64}$/.test(token)) return renderMessage("This link isn't valid.");
  const auth = await teamToken();
  try {
    const st = await call({ action: "status" });
    if (!st.live) return renderMessage(st.message || "This link isn't active.");
    const pass = store.get(PASS_KEY);
    if (st.require_email && !pass && !auth) return renderGate();
    start(await call({ action: "open", pass, tz: tz() }, auth));
  } catch (e) {
    if (e.data?.gate) { store.del(PASS_KEY); return renderGate(); }
    if (e.status === 404) return renderMessage(e.data?.error || "This link isn't active.");
    renderMessage(e.data?.error || "We couldn't load this deck. Check your connection and try again.");
  }
}

function start(d) {
  if (d.pass) store.set(PASS_KEY, d.pass);
  if (!d.slides?.length) return renderMessage("This deck isn't ready yet.");
  document.title = d.title ? `${d.title} · Stellar` : "Stellar";
  document.body.className = "viewing";
  const slides = d.slides, total = slides.length;
  const spotsBy = {};
  for (const s of d.spots ?? []) (spotsBy[s.n] ??= []).push(s);
  app.innerHTML = `<div class="viewer">
    <div class="stage-wrap">
      <button class="nav prev" type="button" aria-label="Previous slide">${ARROW("prev")}</button>
      <div class="stage" role="region" aria-roledescription="slide" aria-live="polite"></div>
      <button class="nav next" type="button" aria-label="Next slide">${ARROW("next")}</button>
      <p class="turn">Turn your phone for a bigger view · swipe to move</p>
    </div>
    <div class="bar"><img src="assets/stellar-white.png" alt="Stellar" width="66" height="18"><span class="count"></span></div>
    <div class="progress"><i></i></div>
  </div>`;
  const stage = app.querySelector(".stage"), prev = app.querySelector(".prev"), next = app.querySelector(".next");
  const count = app.querySelector(".count"), bar = app.querySelector(".progress i");
  const cache = {};
  const preload = (i) => { const s = slides[i]; if (s?.url && !cache[i]) { cache[i] = new Image(); cache[i].src = s.url; } };

  // ---- Tracking (skipped entirely for signed-in team) ----
  const session = d.session;
  const times = {}, pendingClicks = new Map();
  let cur = 0, segStart = null, lastInput = Date.now();
  const counting = () => document.visibilityState === "visible" && Date.now() - lastInput < IDLE_LIMIT;
  function flushSegment() {
    if (segStart != null) { const n = slides[cur].n; times[n] = (times[n] || 0) + Math.max(0, Date.now() - segStart); }
    segStart = counting() ? Date.now() : null;
  }
  const payload = () => JSON.stringify({ action: "track", session: session.id, sig: session.sig, slides: Object.fromEntries(Object.entries(times).map(([k, v]) => [k, Math.round(v)])), clicks: [...pendingClicks.values()] });
  async function send() {
    if (!session) return;
    flushSegment();
    const sent = [...pendingClicks.keys()];
    try {
      const r = await fetch(FN, { method: "POST", headers: { "Content-Type": "text/plain" }, body: payload(), keepalive: true });
      if (r.ok) sent.forEach((k) => pendingClicks.delete(k));
    } catch { /* retried on the next heartbeat */ }
  }
  function beacon() {
    if (!session) return;
    flushSegment();
    try { if (!navigator.sendBeacon(FN, new Blob([payload()], { type: "text/plain" }))) send(); } catch { send(); }
  }
  if (session) {
    setInterval(() => { if (document.visibilityState === "visible") send(); }, HEARTBEAT);
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") beacon(); else { lastInput = Date.now(); flushSegment(); } });
    window.addEventListener("pagehide", beacon);
    for (const ev of ["pointerdown", "keydown", "wheel", "touchstart", "mousemove"]) window.addEventListener(ev, () => { const was = counting(); lastInput = Date.now(); if (!was) flushSegment(); }, { passive: true });
    setInterval(() => { if (segStart != null && !counting()) flushSegment(); }, 10000);
    send();
  }

  function show(i) {
    if (i < 0 || i >= total) return;
    flushSegment();
    cur = i;
    const s = slides[i];
    stage.querySelectorAll("video").forEach((v) => v.pause());
    stage.innerHTML = s.url ? `<img class="slide" src="${esc(s.url)}" alt="Slide ${i + 1} of ${total}" draggable="false">` : "";
    const img = stage.querySelector("img");
    if (img) {
      const done = () => { img.classList.add("in"); stage.classList.add("ready"); };
      stage.classList.remove("ready");
      img.complete && img.naturalWidth ? done() : img.addEventListener("load", done, { once: true });
      img.addEventListener("error", () => stage.classList.add("ready"), { once: true });
    }
    for (const sp of spotsBy[s.n] ?? []) {
      const pos = `left:${sp.x}%;top:${sp.y}%;width:${sp.w}%;height:${sp.h}%`;
      if (sp.kind === "video" && sp.url) {
        const v = document.createElement("video");
        Object.assign(v, { src: sp.url, muted: true, loop: true, autoplay: true, playsInline: true, preload: "auto" });
        v.setAttribute("playsinline", ""); v.setAttribute("muted", "");
        v.addEventListener("click", () => { v.muted = !v.muted; });
        v.title = "Tap for sound";
        const c = sp.clip;
        if (c?.w > 0 && c?.h > 0) {
          // A parent frame (e.g. a phone mockup) shows only part of the video: clip to that area, rounded like the frame.
          const box = document.createElement("div");
          box.className = "spot vclip";
          box.style.cssText = `left:${c.x}%;top:${c.y}%;width:${c.w}%;height:${c.h}%;border-radius:${c.r || 0}cqw`;
          v.style.cssText = `left:${((sp.x - c.x) / c.w) * 100}%;top:${((sp.y - c.y) / c.h) * 100}%;width:${(sp.w / c.w) * 100}%;height:${(sp.h / c.h) * 100}%`;
          box.append(v);
          stage.append(box);
        } else {
          v.className = "spot"; v.style.cssText = pos;
          stage.append(v);
        }
        v.play().catch(() => {});
      } else if (sp.kind === "link") {
        const a = document.createElement("a");
        a.className = "spot"; a.style.cssText = pos; a.href = sp.url; a.target = "_blank"; a.rel = "noopener noreferrer";
        a.setAttribute("aria-label", sp.label || "Open link");
        a.addEventListener("click", () => {
          if (!session) return;
          const id = (crypto.randomUUID?.() ?? `${Date.now()}-${Math.random()}`);
          pendingClicks.set(id, { id, n: s.n, url: sp.url });
          send();
        });
        stage.append(a);
      }
    }
    prev.disabled = i === 0; next.disabled = i === total - 1;
    count.textContent = `${i + 1} / ${total}`;
    bar.style.width = `${((i + 1) / total) * 100}%`;
    preload(i + 1); preload(i + 2); preload(i - 1);
    try { history.replaceState(null, "", `#t=${token}&s=${i + 1}`); } catch { /* ignore */ }
  }

  prev.addEventListener("click", () => show(cur - 1));
  next.addEventListener("click", () => show(cur + 1));
  window.addEventListener("keydown", (e) => {
    if (e.key === "ArrowRight" || e.key === "PageDown" || ((e.key === " " || e.key === "Enter") && !e.target.closest?.("a,button"))) { e.preventDefault(); show(cur + 1); }
    else if (e.key === "ArrowLeft" || e.key === "PageUp") { e.preventDefault(); show(cur - 1); }
    else if (e.key === "Home") show(0);
    else if (e.key === "End") show(total - 1);
  });
  // Swipe on touch screens; a tap on the left or right third also moves.
  const wrap = app.querySelector(".stage-wrap");
  let tx = null, ty = null;
  wrap.addEventListener("touchstart", (e) => { tx = e.touches[0].clientX; ty = e.touches[0].clientY; }, { passive: true });
  wrap.addEventListener("touchend", (e) => {
    if (tx == null) return;
    const dx = e.changedTouches[0].clientX - tx, dy = e.changedTouches[0].clientY - ty;
    if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy)) show(cur + (dx < 0 ? 1 : -1));
    tx = null;
  }, { passive: true });
  stage.addEventListener("click", (e) => {
    if (e.target.closest("a,video")) return;
    const r = stage.getBoundingClientRect(), x = (e.clientX - r.left) / r.width;
    if (x > 0.66) show(cur + 1); else if (x < 0.33) show(cur - 1);
  });

  const start0 = Math.min(total, Math.max(1, +new URLSearchParams(location.hash.slice(1)).get("s") || 1)) - 1;
  show(start0);
}

boot();
