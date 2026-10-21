// discover: find creators through Influencers.club's Discovery API (team members only).
//
// Body:
//   { action: "search", platform, mode: "ai" | "lookalike" | "filters", query?, filters?, sort?, page?, limit? }
//       ai:        query is a plain-language brief (nlp_search); Influencers.club turns it into filters
//       lookalike: query is a @handle or profile link; finds creators similar to it
//       filters:   filters only
//     Cost: 0.01 Influencers.club credits per creator returned (a page of 25 = 0.25 credits). The same
//     search run again within 24 hours is answered from discovery_searches for free (profile pictures
//     from Influencers.club expire after 24 hours, so older results are fetched again).
//   { action: "dict", kind, platform? }  filter values (locations, languages, niches…), cached 30 days, free
//   { action: "credits" }                 Influencers.club balance, free
//
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
const API = "https://api-dashboard.influencers.club/public/v1";
const PLATFORMS = ["instagram", "youtube", "tiktok", "twitter", "twitch"];
const CACHE_MS = 23 * 3600_000;
const DICTS: Record<string, string> = {
  languages: "/discovery/classifier/languages/",
  locations: "/discovery/classifier/locations/{platform}/",
  niche: "/discovery/classifier/niche/",
  sub_niche: "/discovery/classifier/sub-niche/",
  audience_interests: "/discovery/classifier/audience-interests/",
  audience_locations: "/discovery/classifier/audience-locations/",
  games: "/discovery/classifier/games/",
};

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

async function teamMember(req: Request): Promise<string | null> {
  const jwt = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!jwt.startsWith("ey")) return null;
  const { data } = await db.auth.getUser(jwt);
  const email = data.user?.email?.toLowerCase();
  if (!email) return null;
  const { data: m } = await db.from("team_members").select("email").eq("email", email).maybeSingle();
  return m ? email : null;
}

class ApiError extends Error { constructor(msg: string, public status = 502) { super(msg); } }
async function ic(path: string, init: { method?: string; body?: unknown } = {}): Promise<any> {
  if (!KEY) throw new ApiError("Influencers.club key is missing: add INFLUENCERS_CLUB_API_KEY in Supabase → Edge Functions → Secrets", 503);
  const r = await fetch(`${API}${path}`, {
    method: init.method ?? "GET",
    headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json", Accept: "application/json" },
    ...(init.body ? { body: JSON.stringify(init.body) } : {}),
    signal: AbortSignal.timeout(90_000),
  }).catch((e) => { throw new ApiError(`Couldn't reach Influencers.club: ${e?.message ?? e}`); });
  const text = await r.text();
  let j: any = null;
  try { j = JSON.parse(text); } catch { /* not JSON */ }
  if (!r.ok) {
    const code = j?.error_code ?? "";
    if (r.status === 429) throw new ApiError(code === "daily_limit_exceeded" ? "Influencers.club's daily search limit is reached; try again tomorrow" : "Influencers.club is busy or the search allowance is used up; try again shortly", 429);
    if (r.status === 402 || /credit/i.test(code)) throw new ApiError("Out of Influencers.club credits", 402);
    throw new ApiError(`Influencers.club: ${readable(j?.error ?? j?.message ?? text)}`, r.status >= 500 ? 502 : 400);
  }
  return j;
}
// {"filters":{"location":["Expected a list"]}} → "filters.location: Expected a list"
function readable(e: unknown, path = ""): string {
  if (e == null) return "";
  if (typeof e === "string") return path ? `${path}: ${e}` : e;
  if (Array.isArray(e)) return e.map((x) => readable(x, path)).join("; ");
  if (typeof e === "object") return Object.entries(e as Record<string, unknown>).map(([k, v]) => readable(v, path ? `${path}.${k}` : k)).join("; ");
  return String(e);
}

// Drop empty values so the cache key and the request only carry real filters.
function prune(v: any): any {
  if (Array.isArray(v)) { const a = v.map(prune).filter((x) => x !== undefined); return a.length ? a : undefined; }
  if (v && typeof v === "object") {
    const o: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) { const p = prune(x); if (p !== undefined) o[k] = p; }
    return Object.keys(o).length ? o : undefined;
  }
  if (v === "" || v === null || v === false) return undefined;
  return v;
}
async function sha(s: string) {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
}
const stable = (v: any): string => Array.isArray(v) ? `[${v.map(stable).join(",")}]` : v && typeof v === "object" ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(",")}}` : JSON.stringify(v);

// "@name", profile links on any platform → "name"
function handleOf(raw: string): string {
  let h = String(raw ?? "").trim();
  try {
    if (/^https?:\/\//i.test(h)) {
      const u = new URL(h);
      const seg = u.pathname.split("/").filter(Boolean);
      h = (seg.find((s) => s.startsWith("@")) ?? (seg[0] === "channel" ? seg[1] : seg[0]) ?? "");
    }
  } catch { /* keep as typed */ }
  return h.replace(/^@/, "");
}

async function search(body: any, member: string | null) {
  const platform = String(body.platform ?? "").toLowerCase();
  if (!PLATFORMS.includes(platform)) throw new ApiError("Choose a platform", 400);
  const mode = ["ai", "lookalike", "filters"].includes(body.mode) ? body.mode : "filters";
  const limit = Math.min(50, Math.max(1, Number(body.limit) || 25));
  const page = Math.max(0, Number(body.page) || 0);
  const filters = prune(body.filters ?? {}) ?? {};
  const query = String(body.query ?? "").trim();
  const sortBy = ["relevancy", "engagement_rate", "number_of_followers", "growth_rate"].includes(body.sort) ? body.sort : null;
  let path: string, req: Record<string, unknown>;
  if (mode === "lookalike") {
    const handle = handleOf(query);
    if (!handle) throw new ApiError("Type the @handle or paste the profile link of the creator to find lookalikes of", 400);
    path = "/discovery/creators/similar/";
    req = { platform, filter_key: "username", filter_value: handle, paging: { limit, page }, ...(Object.keys(filters).length ? { filters } : {}) };
  } else {
    if (mode === "ai" && query.length < 3) throw new ApiError("Describe who you're looking for (at least a few words)", 400);
    if (mode === "filters" && !Object.keys(filters).length) throw new ApiError("Add at least one filter, or describe who you're looking for", 400);
    path = "/discovery/";
    req = { platform, paging: { limit, page }, filters, ...(mode === "ai" ? { nlp_search: query.slice(0, 1000) } : {}),
      ...(sortBy ? { sort: { sort_by: sortBy, sort_order: "desc" } } : {}) };
  }
  const hash = await sha(`${path}|${stable(req)}`);
  if (!body.fresh) {
    const { data: hit } = await db.from("discovery_searches").select("id,response,created_at").eq("request_hash", hash)
      .gte("created_at", new Date(Date.now() - CACHE_MS).toISOString()).not("response", "is", null).order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (hit) return { ...hit.response, cached: true, search_id: hit.id, searched_at: hit.created_at };
  }
  const r = await ic(path, { method: "POST", body: req });
  const response = {
    total: r.total ?? 0, limit: r.limit ?? limit, page,
    accounts: (r.accounts ?? []).map((a: any) => ({
      user_id: a.user_id, similarity: a.similarity_score ?? null,
      username: a.profile?.username, name: a.profile?.full_name, picture: a.profile?.picture,
      followers: a.profile?.followers ?? null, engagement: a.profile?.engagement_percent ?? null,
    })),
    applied_filters: r.applied_filters ?? null, nlp: r.nlp_search ?? null,
    credits_left: r.credits_left != null ? Number(r.credits_left) : null, credits_cost: r.credits_cost ?? null,
    trial_searches_left: r.trial_searches_left ?? null,
  };
  const { data: row } = await db.from("discovery_searches").insert({
    request_hash: hash, platform, mode, query: query || null, request: { path, ...req }, response,
    total: response.total, credits_cost: response.credits_cost, created_by: member,
  }).select("id,created_at").single();
  return { ...response, cached: false, search_id: row?.id ?? null, searched_at: row?.created_at ?? new Date().toISOString() };
}

async function dict(kind: string, platform?: string) {
  if (!DICTS[kind]) throw new ApiError("Unknown list", 400);
  const p = kind === "locations" ? (PLATFORMS.includes(String(platform)) ? String(platform) : "instagram") : "";
  const key = p ? `${kind}:${p}` : kind;
  const { data: hit } = await db.from("ic_dictionary").select("values,fetched_at").eq("kind", key).maybeSingle();
  if (hit && Date.now() - Date.parse(hit.fetched_at) < 30 * 86400_000) return { values: hit.values };
  const values = await ic(DICTS[kind].replace("{platform}", p));
  await db.from("ic_dictionary").upsert({ kind: key, values, fetched_at: new Date().toISOString() });
  return { values };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const { data: secret } = await db.rpc("trending_cron_secret");
  const internal = !!secret && req.headers.get("x-cron-secret") === secret;
  const member = internal ? null : await teamMember(req);
  if (!internal && !member) return json({ error: "Sign in as a Stellar team member." }, 401);
  let body: any = {};
  try { body = await req.json(); } catch { /* ignore */ }
  try {
    if (body.action === "search") return json(await search(body, member));
    if (body.action === "dict") return json(await dict(String(body.kind), body.platform));
    if (body.action === "credits") return json(await ic("/accounts/credits/"));
    return json({ error: "Unknown action" }, 400);
  } catch (e) {
    return json({ error: String((e as Error).message).slice(0, 400) }, e instanceof ApiError ? e.status : 500);
  }
});
