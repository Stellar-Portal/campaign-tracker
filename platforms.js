// The social platforms the roster and Discover work with: names, icons and profile links.
const svg = (d, vb = "0 0 24 24") => `<svg viewBox="${vb}" aria-hidden="true" class="pf-ico">${d}</svg>`;

export const PLATFORMS = {
  instagram: {
    name: "Instagram",
    icon: svg('<rect x="3" y="3" width="18" height="18" rx="5" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="12" r="4" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="17.3" cy="6.7" r="1.2" fill="currentColor"/>'),
    url: (u) => `https://www.instagram.com/${encodeURIComponent(u)}/`,
  },
  youtube: {
    name: "YouTube",
    icon: svg('<rect x="2" y="5" width="20" height="14" rx="4" fill="currentColor"/><path d="M10 9v6l5-3z" fill="var(--canvas, #fff)"/>'),
    url: (u) => (/^UC[\w-]{22}$/.test(u) ? `https://www.youtube.com/channel/${u}` : `https://www.youtube.com/@${encodeURIComponent(u)}`),
  },
  tiktok: {
    name: "TikTok",
    icon: svg('<path d="M14 3v11.5a3.5 3.5 0 1 1-3-3.46V8.1A6.5 6.5 0 1 0 17 14.5V8.6a6.8 6.8 0 0 0 4 1.3V6.9A4 4 0 0 1 17 3z" fill="currentColor"/>'),
    url: (u) => `https://www.tiktok.com/@${encodeURIComponent(u)}`,
  },
  twitch: {
    name: "Twitch",
    icon: svg('<path d="M5 3 3.5 7v12H8v2.5h2.5L13 19h3.5l4-4V3zm13.5 11-2.5 2.5h-4L9.5 19v-2.5H6V5h12.5z" fill="currentColor"/><path d="M11 8h2v5h-2zM15.5 8h2v5h-2z" fill="currentColor"/>'),
    url: (u) => `https://www.twitch.tv/${encodeURIComponent(u)}`,
  },
  twitter: {
    name: "X",
    icon: svg('<path d="M17.8 3h3.1l-6.8 7.8L22 21h-6.3l-4.9-6.4L5.2 21H2.1l7.3-8.3L1.8 3h6.4l4.4 5.9zm-1.1 16.2h1.7L7.4 4.7H5.6z" fill="currentColor"/>'),
    url: (u) => `https://x.com/${encodeURIComponent(u)}`,
  },
};
export const PLATFORM_ORDER = ["instagram", "youtube", "tiktok", "twitch", "twitter"];
export const platformOf = (p) => PLATFORMS[p] ?? PLATFORMS.tiktok;

// Which platform a pasted link belongs to (null for a bare handle).
export function detectPlatform(raw) {
  const s = String(raw ?? "").trim().toLowerCase();
  if (/tiktok\.com/.test(s)) return "tiktok";
  if (/instagram\.com/.test(s)) return "instagram";
  if (/youtube\.com|youtu\.be/.test(s)) return "youtube";
  if (/(^|\/\/|\.)(x|twitter)\.com/.test(s)) return "twitter";
  if (/twitch\.tv/.test(s)) return "twitch";
  return null;
}
