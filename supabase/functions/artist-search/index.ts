// artist-search: finds artists by name for the campaign form, with their picture.
// First choice: Chartmetric (official Spotify artist photos, ranked by real audience; 1 API credit
// = $0.01 per search, and the result carries the Chartmetric id used by Trending).
// Fallback: Deezer's public catalogue (free, no key) when Chartmetric is unavailable.
// Signed-in team members only (or the internal cron secret, for checks).
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

function serviceKey(): string {
  const raw = Deno.env.get("SUPABASE_SECRET_KEYS");
  if (raw) {
    try { const k = JSON.parse(raw); const v = k.default ?? Object.values(k)[0]; if (v) return String(v); } catch { /* ignore */ }
  }
  return Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
}
const db = createClient(Deno.env.get("SUPABASE_URL")!, serviceKey(), { auth: { persistSession: false } });

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const REFRESH = Deno.env.get("CHARTMETRIC_REFRESH_TOKEN") ?? "";
let cmToken = "", cmUntil = 0;
async function chartmetricSearch(q: string, debug: boolean) {
  if (!REFRESH) throw new Error("no Chartmetric key");
  if (!cmToken || Date.now() > cmUntil) {
    const t = await fetch("https://api.chartmetric.com/api/token", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ refreshtoken: REFRESH }), signal: AbortSignal.timeout(10_000) });
    const tj = await t.json().catch(() => null);
    if (!t.ok || !tj?.token) throw new Error(`Chartmetric sign-in failed (${t.status})`);
    cmToken = tj.token; cmUntil = Date.now() + (Number(tj.expires_in ?? 3600) - 120) * 1000;
  }
  const r = await fetch(`https://api.chartmetric.com/api/search?type=artists&limit=10&q=${encodeURIComponent(q)}`, { headers: { Authorization: `Bearer ${cmToken}` }, signal: AbortSignal.timeout(10_000) });
  const j = await r.json().catch(() => null);
  if (!r.ok) throw new Error(`Chartmetric search failed (${r.status})`);
  const list: any[] = j?.obj?.artists ?? j?.obj?.data?.artists ?? [];
  const num = (v: unknown) => (v == null || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
  const artists = list.filter((a) => a?.name).map((a) => {
    const listeners = num(a.sp_monthly_listeners), followers = num(a.sp_followers);
    const img = a.image_url ?? a.image ?? null;
    return {
      cm_artist: num(a.id) ?? num(a.cm_artist), name: a.name, image: img, thumb: img,
      fans: listeners ?? followers ?? null,
      fans_label: listeners != null ? "monthly listeners" : followers != null ? "Spotify followers" : null,
      verified: !!a.verified,
    };
  });
  return debug ? { artists, raw_keys: list[0] ? Object.keys(list[0]) : [] } : { artists };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

async function teamMember(req: Request): Promise<boolean> {
  const jwt = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!jwt.startsWith("ey")) return false;
  const { data } = await db.auth.getUser(jwt);
  const email = data.user?.email?.toLowerCase();
  if (!email) return false;
  const { data: m } = await db.from("team_members").select("email").eq("email", email).maybeSingle();
  return !!m;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const { data: secret } = await db.rpc("trending_cron_secret");
  const internal = !!secret && req.headers.get("x-cron-secret") === secret;
  if (!internal && !(await teamMember(req))) return json({ error: "Sign in as a Stellar team member." }, 401);
  let body: any = {};
  try { body = await req.json(); } catch { /* ignore */ }
  const q = String(body?.q ?? "").trim().slice(0, 80);
  if (q.length < 2) return json({ artists: [] });
  if (body?.source !== "deezer") {
    try {
      const cm = await chartmetricSearch(q, internal && !!body?.debug);
      if (cm.artists.length) return json({ ...cm, source: "chartmetric" });
    } catch (e) { if (internal) console.log("chartmetric search", String((e as Error).message)); /* fall back to Deezer */ }
  }
  try {
    const r = await fetch(`https://api.deezer.com/search/artist?limit=25&q=${encodeURIComponent(q)}`);
    const j = await r.json();
    if (j?.error) throw new Error(j.error.message ?? "Deezer error");
    // Deezer pads results with tiny same-name accounts. Rank real artists first: an exact name match
    // (ignoring accents and case) with a real following, then by fans; drop near-empty profiles and
    // same-name duplicates, keeping the biggest.
    const norm = (x: string) => x.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
    const nq = norm(q);
    const placeholder = (u: string | undefined) => !u || /\/artist\/\/|\/images\/artist\//.test(u);
    const all = (j?.data ?? []).filter((a: any) => a?.name).map((a: any) => ({
      deezer_id: a.id, name: a.name, fans: a.nb_fan ?? 0,
      image: placeholder(a.picture_xl) ? null : a.picture_xl,
      thumb: placeholder(a.picture_medium) ? null : a.picture_medium,
      exact: norm(a.name) === nq, starts: norm(a.name).startsWith(nq),
    }));
    const biggest = Math.max(0, ...all.map((a: any) => a.fans));
    const floor = biggest >= 1000 ? 100 : 0;   // only drop tiny profiles when a real artist is in the list
    const score = (a: any) => (a.exact && a.fans >= 100 ? 3e9 : 0) + (a.starts ? 1e9 : 0) + a.fans;
    const seen = new Set<string>();
    const artists = all
      .filter((a: any) => a.fans >= floor)
      .sort((a: any, b: any) => score(b) - score(a))
      .filter((a: any) => { const k = norm(a.name); if (seen.has(k)) return false; seen.add(k); return true; })
      .slice(0, 6)
      .map(({ exact, starts, ...a }: any) => a);
    return json({ artists, source: "deezer" });
  } catch (e) {
    return json({ artists: [], error: String((e as Error).message).slice(0, 200) }, 502);
  }
});
