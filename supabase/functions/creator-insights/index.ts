// creator-insights: audience demographics and contact details for one creator, from Influencers.club
// ("Enrich by handle – full", 1 credit per successful lookup; nothing is charged when no data comes back).
// Results are cached in creator_insights for 60 days so the same creator is never paid for twice.
// Body: { handle, platform: "tiktok" | "instagram" | "youtube", refresh?: boolean }.
// Signed-in team members only (or the internal cron secret, for checks).
// Needs the Supabase secret INFLUENCERS_CLUB_API_KEY.
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
const KEY = Deno.env.get("INFLUENCERS_CLUB_API_KEY") ?? "";
const CACHE_DAYS = 60;
const PLATFORMS = ["tiktok", "instagram", "youtube"];

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
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

// "@Name", "tiktok.com/@name", "instagram.com/name/" → "name"
function cleanHandle(raw: string): string {
  let h = String(raw ?? "").trim();
  try { if (/^https?:\/\//i.test(h)) { const u = new URL(h); h = u.pathname.split("/").filter(Boolean)[0] ?? ""; } } catch { /* keep as typed */ }
  return h.replace(/^@/, "").toLowerCase();
}

// The handful of numbers the roster needs, pulled out of the (large) full response.
function summary(platform: string, d: any) {
  const r = d?.result ?? d ?? {};
  const p = r?.[platform] ?? {};
  const af = p?.audience?.audience_followers ?? p?.audience_followers ?? null;
  return {
    name: r.full_name ?? r.name ?? p.full_name ?? null,
    followers: p.follower_count ?? p.subscriber_count ?? null,
    engagement_percent: p.engagement_percent ?? null,
    avg_views: p.avg_views ?? p.play_count_avg ?? null,
    median_views: p.play_count_median ?? null,
    location: r.location ?? null,
    email: r.email ?? null, email_status: r.email_status ?? null,
    audience: af ? {
      countries: af.geo_countries ?? af.countries ?? af.geo ?? null,
      genders: af.genders ?? af.gender ?? null,
      ages: af.ages ?? af.age ?? null,
      credibility: af.credibility ?? af.audience_credibility ?? null,
    } : null,
    audience_keys: af ? Object.keys(af) : [],
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const { data: secret } = await db.rpc("trending_cron_secret");
  const internal = !!secret && req.headers.get("x-cron-secret") === secret;
  if (!internal && !(await teamMember(req))) return json({ error: "Sign in as a Stellar team member." }, 401);
  let body: any = {};
  try { body = await req.json(); } catch { /* ignore */ }
  const platform = String(body?.platform ?? "tiktok").toLowerCase();
  const handle = cleanHandle(body?.handle);
  if (!PLATFORMS.includes(platform)) return json({ error: "Platform must be tiktok, instagram or youtube" }, 400);
  if (!handle) return json({ error: "Missing handle" }, 400);

  if (!body?.refresh) {
    const { data: cached } = await db.from("creator_insights").select("*").eq("platform", platform).eq("handle", handle).maybeSingle();
    if (cached && !cached.error && Date.now() - Date.parse(cached.fetched_at) < CACHE_DAYS * 86_400_000) {
      return json({ cached: true, fetched_at: cached.fetched_at, summary: summary(platform, cached.data), ...(internal && body?.raw ? { data: cached.data } : {}) });
    }
  }
  if (!KEY) return json({ error: "Influencers.club key is missing: add INFLUENCERS_CLUB_API_KEY in Supabase → Edge Functions → Secrets" }, 503);

  const r = await fetch("https://api-dashboard.influencers.club/public/v1/creators/enrich/handle/full/", {
    method: "POST",
    headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ handle, platform, include_audience_data: true, email_required: "preferred" }),
    signal: AbortSignal.timeout(60_000),
  }).catch((e) => ({ ok: false, status: 0, text: async () => String(e?.message ?? e) } as any));
  const text = await r.text();
  let d: any = null;
  try { d = JSON.parse(text); } catch { /* not JSON */ }
  const now = new Date().toISOString();
  if (!r.ok) {
    const msg = `Influencers.club replied ${r.status}: ${String(d?.detail ?? d?.message ?? d?.error ?? text).slice(0, 200)}`;
    await db.from("creator_insights").upsert({ platform, handle, fetched_at: now, data: d, error: msg }, { onConflict: "platform,handle" });
    return json({ error: msg }, 502);
  }
  await db.from("creator_insights").upsert({ platform, handle, fetched_at: now, data: d, error: null }, { onConflict: "platform,handle" });
  return json({ cached: false, fetched_at: now, summary: summary(platform, d), ...(internal && body?.raw ? { data: d } : {}) });
});
