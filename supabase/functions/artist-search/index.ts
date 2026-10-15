// artist-search: finds artists by name for the campaign form, with their picture.
// Uses Deezer's public catalogue (no account or key needed). Signed-in team members only.
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
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (!(await teamMember(req))) return json({ error: "Sign in as a Stellar team member." }, 401);
  let body: any = {};
  try { body = await req.json(); } catch { /* ignore */ }
  const q = String(body?.q ?? "").trim().slice(0, 80);
  if (q.length < 2) return json({ artists: [] });
  try {
    const r = await fetch(`https://api.deezer.com/search/artist?limit=8&q=${encodeURIComponent(q)}`);
    const j = await r.json();
    if (j?.error) throw new Error(j.error.message ?? "Deezer error");
    const artists = (j?.data ?? [])
      .filter((a: any) => a?.name)
      .map((a: any) => ({
        deezer_id: a.id,
        name: a.name,
        fans: a.nb_fan ?? null,
        // Deezer's placeholder for artists without a photo has an empty hash in the URL.
        image: a.picture_xl && !/\/artist\/\/|\/images\/artist\/\//.test(a.picture_xl) ? a.picture_xl : null,
        thumb: a.picture_medium && !/\/artist\/\/|\/images\/artist\/\//.test(a.picture_medium) ? a.picture_medium : null,
      }));
    return json({ artists });
  } catch (e) {
    return json({ artists: [], error: String((e as Error).message).slice(0, 200) }, 502);
  }
});
