// Tracked deck viewer: the page behind a deck link (deck.html#t=<token>).
// No login. The `deck-view` function checks the link, hands out slide images and videos as
// short-lived links, and records time per slide. Time only counts while this tab is visible;
// totals are running sums, so resending them (heartbeat, page close, retry) never double-counts.
import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from "./config.js?v=20261113a";

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
// A pass carried over from the old address (#t=…&p=…): keep it here, then take it out of the address bar.
{
  const hp = new URLSearchParams(location.hash.slice(1)), carried = hp.get("p");
  if (carried && token) {
    if (!store.get(PASS_KEY)) store.set(PASS_KEY, carried);
    hp.delete("p");
    try { history.replaceState(null, "", `${location.pathname}${location.search}#${hp.toString()}`); } catch { /* ignore */ }
  }
}
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

function renderMessage(msg, sub = "Ask your Stellar contact for a new link.") {
  document.body.className = "";
  app.innerHTML = `<section class="gate">
    <img class="wm" src="assets/stellar-white.png" alt="Stellar" width="150" height="41">
    <h1>${esc(msg)}</h1>
    <p class="sub">${esc(sub)}</p></section>`;
}

let verify = false;   // this link checks the viewer's email with a one-time code

function renderGate(errMsg = "") {
  document.body.className = "";
  app.innerHTML = `<section class="gate">
    <img class="wm" src="assets/stellar-white.png" alt="Stellar" width="150" height="41">
    <h1>You've been sent a deck</h1>
    <p class="sub">${verify ? "Enter your work email and we'll send you a code to open it." : "Enter your work email to view it."}</p>
    <form novalidate>
      <label for="em" style="position:absolute;left:-9999px">Work email</label>
      <input id="em" type="email" inputmode="email" autocomplete="email" placeholder="name@company.com" required>
      <p class="err" role="alert">${esc(errMsg)}</p>
      <button type="submit">${verify ? "Send me a code" : "View deck"}</button>
    </form>
    <p class="legal">Stellar records your email, which slides you view and for how long, and the links you open, to follow up on this deck. <a href="privacy.html" target="_blank" rel="noopener">Privacy policy</a></p>
  </section>`;
  const form = app.querySelector("form"), input = form.querySelector("input"), btn = form.querySelector("button"), err = form.querySelector(".err");
  setTimeout(() => input.focus(), 50);
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = input.value.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) { err.textContent = "Enter a valid email address."; input.focus(); return; }
    const label = btn.textContent;
    btn.disabled = true; btn.textContent = verify ? "Sending…" : "Opening…"; err.textContent = "";
    try {
      if (verify) { await call({ action: "code", email }); renderCode(email); }
      else start(await call({ action: "open", email, tz: tz() }));
    } catch (x) { btn.disabled = false; btn.textContent = label; err.textContent = x.data?.error || "Something went wrong. Check your connection and try again."; }
  });
}

const HELP_KEY = `stellar-deck-help:${token}`;   // a "let me in" request waiting on this device
const RESEND_WAIT = 30;

function renderCode(email, errMsg = "") {
  app.innerHTML = `<section class="gate">
    <img class="wm" src="assets/stellar-white.png" alt="Stellar" width="150" height="41">
    <h1>Check your email</h1>
    <p class="sub">We sent a 6-digit code to <b>${esc(email)}</b>. It works for 15 minutes.</p>
    <p class="hint">Can't find it? It can take a minute to arrive. Check your spam or junk folder too.</p>
    <form novalidate>
      <label for="code" style="position:absolute;left:-9999px">Code</label>
      <input id="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" pattern="[0-9]*" placeholder="••••••" class="code">
      <p class="err" role="alert">${esc(errMsg)}</p>
      <button type="submit">View deck</button>
    </form>
    <p class="legal"><button type="button" class="lnk" id="again"></button> · <button type="button" class="lnk" id="other">Use a different email</button></p>
    <p class="help"><button type="button" class="lnk" id="help">Didn't get a code? Ask Stellar to let you in</button></p>
  </section>`;
  const form = app.querySelector("form"), input = form.querySelector("input"), btn = form.querySelector("button"), err = form.querySelector(".err");
  const again = app.querySelector("#again");
  setTimeout(() => input.focus(), 50);
  input.addEventListener("input", () => { input.value = input.value.replace(/\D/g, "").slice(0, 6); if (input.value.length === 6) form.requestSubmit(); });
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!/^\d{6}$/.test(input.value)) { err.textContent = "Enter the 6-digit code from the email."; return; }
    btn.disabled = true; btn.textContent = "Opening…"; err.textContent = "";
    try { start(await call({ action: "open", email, code: input.value, tz: tz() })); }
    catch (x) { btn.disabled = false; btn.textContent = "View deck"; input.value = ""; err.textContent = x.data?.error || "Something went wrong. Check your connection and try again."; }
  });
  // "Send a new code" waits 30 seconds, so the first email has time to arrive.
  let left = RESEND_WAIT, timer = null;
  const tick = () => {
    if (!again.isConnected) return clearInterval(timer);
    again.disabled = left > 0;
    again.textContent = left > 0 ? `Send a new code (${left}s)` : "Send a new code";
    if (left-- <= 0) clearInterval(timer);
  };
  const wait = () => { left = RESEND_WAIT; clearInterval(timer); tick(); timer = setInterval(tick, 1000); };
  wait();
  again.onclick = async () => {
    again.disabled = true; again.textContent = "Sending…";
    try { await call({ action: "code", email }); err.textContent = "New code sent. Either code works."; wait(); }
    catch (x) { err.textContent = x.data?.error || "Couldn't send a new code."; left = 0; tick(); }
  };
  app.querySelector("#other").onclick = () => { clearInterval(timer); renderGate(); };
  app.querySelector("#help").onclick = async (e) => {
    const b = e.currentTarget; b.disabled = true; b.textContent = "Asking Stellar…";
    try {
      const r = await call({ action: "help", email });
      store.set(HELP_KEY, JSON.stringify({ id: r.id, sig: r.sig, email }));
      clearInterval(timer); renderWaiting({ id: r.id, sig: r.sig, email });
    } catch (x) { b.disabled = false; b.textContent = "Didn't get a code? Ask Stellar to let you in"; err.textContent = x.data?.error || "Couldn't reach Stellar. Check your connection and try again."; }
  };
}

// Waiting for the Stellar team to let this person in (they get a Slack message and a button in Decks).
function renderWaiting(req) {
  document.body.className = "";
  app.innerHTML = `<section class="gate">
    <img class="wm" src="assets/stellar-white.png" alt="Stellar" width="150" height="41">
    <div class="spin" aria-hidden="true"></div>
    <h1>We've asked Stellar to let you in</h1>
    <p class="sub">The team has been told that <b>${esc(req.email)}</b> couldn't get a code. Keep this page open: the deck opens by itself as soon as they let you in.</p>
    <p class="err" role="status" aria-live="polite"></p>
    <p class="legal"><button type="button" class="lnk" id="code-again">I found the code after all</button></p>
  </section>`;
  const note = app.querySelector(".err");
  let stop = false, tries = 0;
  app.querySelector("#code-again").onclick = () => { stop = true; renderCode(req.email); };
  const poll = async () => {
    if (stop || !app.isConnected) return;
    tries++;
    try {
      const r = await call({ action: "help_status", id: req.id, sig: req.sig });
      if (r.status === "approved" && r.pass) {
        stop = true; store.del(HELP_KEY); store.set(PASS_KEY, r.pass);
        return start(await call({ action: "open", pass: r.pass, tz: tz() }));
      }
      if (r.status === "declined" || r.status === "gone") {
        stop = true; store.del(HELP_KEY);
        return r.status === "declined" ? renderMessage("Stellar couldn't confirm this request.", "Please get in touch with your Stellar contact directly.")
          : renderMessage("This request has expired.", "Reload the page to try again, or get in touch with your Stellar contact.");
      }
      note.textContent = "";
    } catch { note.textContent = "Still waiting… (connection problem, trying again)"; }
    // Every 5 seconds for 10 minutes, then every 30 seconds.
    setTimeout(poll, tries < 120 ? 5000 : 30000);
  };
  poll();
}

const tz = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return null; } };

async function boot() {
  if (!/^[a-f0-9]{24,64}$/.test(token)) return renderMessage("This link isn't valid.");
  const auth = await teamToken();
  try {
    const st = await call({ action: "status" });
    if (!st.live) return renderMessage(st.message || "This link isn't active.");
    verify = !!st.verify;
    const pass = store.get(PASS_KEY);
    if (st.require_email && !pass && !auth) {
      let waiting = null; try { waiting = JSON.parse(store.get(HELP_KEY) || "null"); } catch { /* ignore */ }
      return waiting?.id ? renderWaiting(waiting) : renderGate();
    }
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
  const preload = (i) => {
    const s = slides[i];
    if (!s || cache[i]) return;
    cache[i] = [s.url, ...(spotsBy[s.n] ?? []).flatMap((sp) => (sp.overlays ?? []).map((o) => o.url))].filter(Boolean).map((u) => { const im = new Image(); im.src = u; return im; });
  };

  // ---- Tracking (skipped entirely for signed-in team) ----
  const session = d.session;
  // A reopened visit (same link within 30 minutes) continues from the times already recorded.
  const times = Object.fromEntries(Object.entries(session?.base ?? {}).map(([k, v]) => [k, Number(v) || 0])), pendingClicks = new Map();
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

  let soundOn = false;
  const SPEAKER = (on) => `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 5 6 9H2v6h4l5 4z"/>${on ? '<path d="M15.5 8.5a5 5 0 0 1 0 7M19 5a10 10 0 0 1 0 14"/>' : '<path d="m22 9-6 6M16 9l6 6"/>'}</svg>`;
  function drawSound() {
    const on = [...stage.querySelectorAll("video")].some((x) => !x.muted);
    stage.querySelectorAll(".snd").forEach((b) => { b.innerHTML = `${SPEAKER(on)}<span>${on ? "Sound on" : "Tap for sound"}</span>`; b.setAttribute("aria-pressed", String(on)); b.classList.toggle("on", on); });
  }
  function setSound(on) {
    soundOn = on;
    stage.querySelectorAll("video").forEach((x) => { x.muted = !on; if (on) x.play().catch(() => {}); });
    drawSound();
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
        Object.assign(v, { src: sp.url, muted: !soundOn, loop: true, autoplay: true, playsInline: true, preload: "auto" });
        v.setAttribute("playsinline", "");
        if (!soundOn) v.setAttribute("muted", "");
        v.addEventListener("click", () => setSound(v.muted));
        const c = sp.clip?.w > 0 && sp.clip?.h > 0 ? sp.clip : null;
        if (c) {
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
        // Layers that sit above the video in Figma (a phone's frame, a caption) go back on top of it.
        const parts = [stage.lastElementChild];
        for (const o of sp.overlays ?? []) {
          const im = document.createElement("img");
          im.className = "over"; im.alt = ""; im.src = o.url; im.draggable = false;
          im.style.cssText = `left:${o.x}%;top:${o.y}%;width:${o.w}%;height:${o.h}%`;
          stage.append(im);
          parts.push(im);
        }
        // Until the video is playing and the layers above it have loaded, the slide image (which already shows
        // the phone and the video's first frame) stays visible on its own, so nothing jumps.
        parts.forEach((el) => el.classList.add("wait"));
        const imgs = parts.filter((el) => el.tagName === "IMG");
        const reveal = () => { if (v.readyState >= 3 && imgs.every((im) => im.complete)) parts.forEach((el) => el.classList.remove("wait")); };
        v.addEventListener("playing", reveal);
        imgs.forEach((im) => { im.addEventListener("load", reveal, { once: true }); im.addEventListener("error", () => { im.remove(); imgs.splice(imgs.indexOf(im), 1); reveal(); }, { once: true }); });
        // Browsers start videos muted; this button turns sound on (and keeps it on for the next videos).
        const a = c ?? sp, btn = document.createElement("button");
        btn.type = "button"; btn.className = "snd";
        btn.style.cssText = `left:calc(${a.x + a.w}% - 12px);top:calc(${a.y + a.h}% - 12px)`;
        btn.addEventListener("click", (e) => { e.stopPropagation(); setSound(!soundOn); });
        stage.append(btn);
        v.play().catch(() => { v.muted = true; v.play().catch(() => {}); drawSound(); });
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
    drawSound();
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
    if (e.target.closest("a,video,button")) return;
    const r = stage.getBoundingClientRect(), x = (e.clientX - r.left) / r.width;
    if (x > 0.66) show(cur + 1); else if (x < 0.33) show(cur - 1);
  });

  const start0 = Math.min(total, Math.max(1, +new URLSearchParams(location.hash.slice(1)).get("s") || 1)) - 1;
  show(start0);
}

boot();
