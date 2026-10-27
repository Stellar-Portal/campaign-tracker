// "Send to Stellar OS": reads the open Figma Slides deck (slide order, links, videos) and hands it to
// the plugin window, which sends it to Stellar OS. Figma's own API can't list what's inside a Slides
// file from outside Figma, so this runs inside Figma. It never changes the deck.
figma.showUI(__html__, { width: 360, height: 460, themeColors: true });

const KEY = "stellar-os-key";

function slides() {
  return figma.getSlideGrid().flat().filter((s) => !s.isSkippedSlide);
}

function rel(slide, b) {
  const sx = slide.absoluteTransform[0][2], sy = slide.absoluteTransform[1][2];
  return { x: Math.round(b.x - sx), y: Math.round(b.y - sy), w: Math.round(b.width), h: Math.round(b.height) };
}

// The part of a video that its parent frames (e.g. a phone mockup) leave visible, and their corner radius.
function visible(node, slide) {
  const b = node.absoluteBoundingBox;
  let c = { x1: b.x, y1: b.y, x2: b.x + b.width, y2: b.y + b.height };
  let r = typeof node.cornerRadius === "number" ? node.cornerRadius : 0;
  for (let p = node.parent; p && p.type !== "SLIDE"; p = p.parent) {
    if (!p.clipsContent || !p.absoluteBoundingBox) continue;
    const pb = p.absoluteBoundingBox;
    c = { x1: Math.max(c.x1, pb.x), y1: Math.max(c.y1, pb.y), x2: Math.min(c.x2, pb.x + pb.width), y2: Math.min(c.y2, pb.y + pb.height) };
    if (typeof p.cornerRadius === "number" && p.cornerRadius > r) r = p.cornerRadius;
  }
  const sx = slide.absoluteTransform[0][2], sy = slide.absoluteTransform[1][2];
  c = { x1: Math.max(c.x1, sx), y1: Math.max(c.y1, sy), x2: Math.min(c.x2, sx + slide.width), y2: Math.min(c.y2, sy + slide.height) };
  if (c.x2 <= c.x1 || c.y2 <= c.y1) return null;
  const v = rel(slide, { x: c.x1, y: c.y1, width: c.x2 - c.x1, height: c.y2 - c.y1 });
  v.r = Math.round(r);
  return v;
}

function isShown(n, slide) {
  for (let p = n; p && p !== slide; p = p.parent) if (p.visible === false) return false;
  return true;
}

function collect() {
  const list = slides();
  const out = [];
  for (const slide of list) {
    const links = [], videos = [];
    slide.findAll((n) => {
      try {
        if (!isShown(n, slide) || !n.absoluteBoundingBox) return false;
        if (n.type === "TEXT") {
          for (const seg of n.getStyledTextSegments(["hyperlink"])) {
            if (seg.hyperlink && seg.hyperlink.type === "URL") links.push(Object.assign({ url: seg.hyperlink.value, label: seg.characters.trim().slice(0, 80) }, rel(slide, n.absoluteBoundingBox)));
          }
        }
        for (const re of n.reactions || []) {
          for (const a of re.actions || (re.action ? [re.action] : [])) {
            if (a && a.type === "URL" && a.url) links.push(Object.assign({ url: a.url, label: n.name.slice(0, 80) }, rel(slide, n.absoluteBoundingBox)));
          }
        }
        if ("fills" in n && Array.isArray(n.fills) && n.fills.some((f) => f.type === "VIDEO" && f.visible !== false)) {
          const v = Object.assign({ name: n.name }, rel(slide, n.absoluteBoundingBox));
          const clip = visible(n, slide);
          if (clip && (clip.x !== v.x || clip.y !== v.y || clip.w !== v.w || clip.h !== v.h || clip.r)) v.clip = clip;
          videos.push(v);
        }
      } catch (e) { /* skip anything unreadable */ }
      return false;
    });
    const seen = new Set();
    out.push({ node: slide.id, title: slide.name, links: links.filter((l) => { const k = l.url + l.x + l.y; if (seen.has(k)) return false; seen.add(k); return true; }), videos });
  }
  const first = list[0];
  return { file_key: figma.fileKey || null, width: first ? Math.round(first.width) : 1920, height: first ? Math.round(first.height) : 1080, slides: out };
}

figma.ui.onmessage = async (msg) => {
  if (msg.type === "ready") {
    const list = slides();
    const videos = list.reduce((n, s) => n + s.findAll((x) => "fills" in x && Array.isArray(x.fills) && x.fills.some((f) => f.type === "VIDEO")).length, 0);
    figma.ui.postMessage({ type: "init", key: (await figma.clientStorage.getAsync(KEY)) || "", fileKey: figma.fileKey || null, slides: list.length, videos });
  } else if (msg.type === "save-key") {
    await figma.clientStorage.setAsync(KEY, msg.key || "");
  } else if (msg.type === "collect") {
    figma.ui.postMessage({ type: "payload", payload: collect() });
  } else if (msg.type === "close") {
    figma.closePlugin();
  }
};
