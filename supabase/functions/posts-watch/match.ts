// posts-watch: the pure parts (no network, no database), so they can be tested with plain node.

export const GAP_MS = 20 * 3600_000;          // a creator is fetched at most once per ~day (cron)
export const MANUAL_GAP_MS = 3600_000;        // "check now" may re-fetch after an hour
export const START_SLACK_MS = 14 * 3600_000;  // a creator in Asia can post on the start date before it starts in Copenhagen

// "@Some.Name " -> "some.name"
export const normHandle = (h: unknown): string => String(h ?? "").trim().replace(/^@+/, "").toLowerCase();
export const validHandle = (h: string): boolean => /^[a-z0-9._]{1,40}$/.test(h);

// ScrapeCreators' video lists use TikTok's own format; the sound is `music` (sometimes `music_info`).
export function musicIdOf(v: any): string | null {
  const m = v?.music ?? v?.music_info ?? null;
  const id = m?.id_str ?? m?.id ?? m?.mid ?? v?.music_id ?? v?.musicId ?? null;
  return id == null || id === "" ? null : String(id);
}
export const videoIdOf = (v: any): string | null => {
  const id = v?.aweme_id ?? v?.id;
  return id == null || id === "" ? null : String(id);
};
export const videoTimeMs = (v: any): number | null => {
  const t = Number(v?.create_time ?? v?.createTime);
  return Number.isFinite(t) && t > 0 ? t * 1000 : null;
};
export const videoList = (j: any): any[] => {
  const l = j?.aweme_list ?? j?.videos ?? j?.itemList ?? [];
  return Array.isArray(l) ? l : [];
};

// Campaign window start: its start date (minus slack); without one, the last 7 days.
export function startMs(startDate: string | null | undefined, now = Date.now()): number {
  const t = startDate ? Date.parse(`${startDate}T00:00:00Z`) : NaN;
  return Number.isFinite(t) ? t - START_SLACK_MS : now - 7 * 86400_000;
}

// Which of a creator's newest videos belong to a campaign: posted on/after its start, using one of its sounds,
// and not already in the tracker. Returns { id, url } per new video; also says whether any video carried sound info at all.
export function pickMatches(videos: any[], opts: { sounds: Set<string>; since: number; known: Set<string>; handle: string }) {
  const out: { id: string; url: string }[] = [];
  let withSound = 0;
  for (const v of videos) {
    const id = videoIdOf(v);
    const mid = musicIdOf(v);
    if (mid) withSound++;
    if (!id || !mid || !opts.sounds.has(mid)) continue;
    const t = videoTimeMs(v);
    if (t == null || t < opts.since) continue;
    if (opts.known.has(id)) continue;
    if (out.some((o) => o.id === id)) continue;
    out.push({ id, url: `https://www.tiktok.com/@${opts.handle}/video/${id}` });
  }
  return { matches: out, withSound };
}

// Which folder a creator's new videos go to: the folder they were added to for the campaign, else the folder
// holding most of their existing posts there, else none.
export function pickFolder(added: (string | null)[], postFolders: (string | null)[]): string | null {
  const a = added.find((f) => f);
  if (a) return a;
  const count = new Map<string, number>();
  for (const f of postFolders) if (f) count.set(f, (count.get(f) ?? 0) + 1);
  let best: string | null = null, n = 0;
  for (const [f, c] of count) if (c > n) { best = f; n = c; }
  return best;
}

// After a failed fetch: try again in 3 h, then 6 h, 12 h, then once a day (stored as a back-dated checked_at).
export function failedCheckedAt(fails: number, now = Date.now(), gap = GAP_MS): string {
  const wait = Math.min(24 * 3600_000, 3 * 3600_000 * 2 ** Math.max(0, fails));
  return new Date(now + Math.min(wait, gap) - gap).toISOString();
}

// Is a creator due? (never checked, or checked longer ago than the gap)
export const isDue = (checkedAt: string | null | undefined, gap: number, now = Date.now()): boolean =>
  !checkedAt || Date.parse(checkedAt) <= now - gap;
