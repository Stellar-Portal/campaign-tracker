// sheet-sync: writes campaigns to the Campaign Overview Google Sheet.
//
// Any change to a campaign, its market splits or its creator costs puts the campaign in a
// queue (table campaign_sheet_sync). A schedule calls this function every minute while
// something is waiting. It takes no input: it only pushes the tracker's current data for
// queued campaigns, so calling it is harmless.
//
// The sheet side is an Apps Script web app (sheets/CampaignOverviewSync.gs) that finds the row
// by Artist + Song + PO and writes only the columns the tracker owns.
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

const STATUS: Record<string, string> = { draft: "Upcoming", active: "Active", on_hold: "On Hold", finished: "Completed" };
const MARKETS = ["US", "Brazil", "Mexico", "All LATAM", "Canada", "UK", "Germany", "France", "Africa", "Other",
  "Japan", "Korea", "China", "India", "SEA", "Global"];
const REGION_ORDER = ["West", "Central", "East"];

const norm = (s: unknown) => String(s ?? "").trim().toLowerCase().replace(/\s+/g, " ");
const sheetKey = (c: any) => [c.artist, c.song, c.po_number].map(norm).join("|");
const sel = (v: unknown) => (v === null || v === undefined || v === "" ? "Select" : v);
const num = (n: unknown, format?: string) => ({ number: n === null || n === undefined ? null : Number(n), format });

function duration(start: string | null, end: string | null): string | null {
  if (!start) return null;
  if (!end) return "Indefinite";
  const days = Math.round((Date.parse(end) - Date.parse(start)) / 86_400_000) + 1;
  if (days <= 0) return null;
  const pl = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
  if (days >= 56 && Math.abs(days / 30.4 - Math.round(days / 30.4)) < 0.15) return pl(Math.round(days / 30.4), "month");
  if (days % 7 === 0) return pl(days / 7, "week");
  return pl(days, "day");
}

export function buildFields(c: any): Record<string, unknown> {
  const alloc: Record<string, number> = {};
  const regions = new Set<string>();
  for (const a of c.allocations ?? []) {
    if (a.amount != null) alloc[a.market] = (alloc[a.market] ?? 0) + Number(a.amount);   // countries add up into their column
    regions.add(a.region);
  }
  let market = REGION_ORDER.filter((r) => regions.has(r)).join(", ");
  if (!market && regions.has("Other")) market = "Global";

  const f: Record<string, unknown> = {
    "Status": STATUS[c.status] ?? "Select",
    "Artist Name": c.artist,
    "Song Name (s) or Project Name": c.song ?? "",
    "Type (NR or Cat)": sel(c.release_type),
    "Client": c.client ?? "",
    "Invoicing Entity": c.invoicing_entity ?? "",
    "Client Location (Country)": c.client_country ?? "",
    "Client Market": sel(c.client_market),
    "Client Contact Name": c.client_contact_name ?? "",
    "Client Contact eMail": c.client_contact_email ?? "",
    "Major / Indie / Other": sel(c.label_type),
    "Under NDA?": c.under_nda === true ? "Yes" : c.under_nda === false ? "No" : "Select",
    "Stellar DRI": c.comms_owner ?? "",
    "Campaign Market": sel(market),
    "Campaign Type": sel(c.campaign_type),
    "Start Date": c.start_date ? { date: c.start_date } : null,
    "Duration": duration(c.start_date, c.end_date) ?? "",
    "Price": num(c.budget),
    "Currency": sel(c.currency),
    "Stellar PO no.": c.po_number,
  };
  // Cost and margin only once creator costs are recorded in the tracker; until then the
  // sheet keeps whatever the team typed there.
  if (Number(c.cost_lines) > 0) {
    f["Campaign Cost"] = num(c.cost);
    f["Margin"] = num(c.budget ? (Number(c.budget) - Number(c.cost)) / Number(c.budget) : null, "0.00%");
  }
  for (const m of MARKETS) f[m] = num(alloc[m] ?? null, "#,##0");
  return f;
}

// POST to the Apps Script web app. It runs the request, then redirects to a one-time URL with the answer.
async function callSheet(cfg: Record<string, string>, payload: Record<string, unknown>) {
  let res = await fetch(cfg.sheet_sync_url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ secret: cfg.sheet_sync_secret, ...payload }),
    redirect: "manual",
  });
  const next = res.headers.get("location");
  if (res.status >= 300 && res.status < 400 && next) { await res.body?.cancel(); res = await fetch(next); }
  const text = await res.text();
  let j: any = null;
  try { j = JSON.parse(text); } catch { /* not JSON */ }
  if (!res.ok || !j?.ok) {
    // Google answers errors with an HTML page; keep just its message.
    const plain = text.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&quot;/g, '"').replace(/\s+/g, " ").trim();
    throw new Error(j?.error ?? `Sheet replied ${res.status}: ${plain.slice(0, 240)}`);
  }
  return j;
}

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

// The next free PO: one above the highest in the sheet and in the tracker.
async function nextPo(cfg: Record<string, string>) {
  const { data } = await db.from("campaigns").select("po_number").not("po_number", "is", null);
  const inTracker = (data ?? []).map((r) => Number((String(r.po_number).match(/ST\s*(\d+)/i) ?? [])[1] ?? 0)).reduce((a, b) => Math.max(a, b), 0);
  let inSheet = 0, sheetError: string | null = null;
  try { inSheet = Number((await callSheet(cfg, { action: "max_po" })).max) || 0; } catch (e) { sheetError = String((e as Error).message); }
  const max = Math.max(inTracker, inSheet);
  return { po: max ? `#ST${max + 1}` : null, from_sheet: inSheet, from_tracker: inTracker, sheet_error: sheetError };
}

async function syncOne(row: any, cfg: Record<string, string>) {
  const { data: c, error } = await db.from("campaign_sheet_rows").select("*").eq("id", row.campaign_id).maybeSingle();
  if (error) throw new Error(error.message);
  if (!c) return;
  if (!c.po_number) {
    await db.from("campaign_sheet_sync").update({ last_error: "Add a PO number to send this campaign to the sheet." }).eq("campaign_id", row.campaign_id);
    return;
  }
  const key = sheetKey(c);
  const j = await callSheet(cfg, { action: "upsert", key, prev_key: row.sheet_key, fields: buildFields(c) });
  const note = j.missing?.length ? `Columns not found in the sheet: ${j.missing.join(", ")}` : null;
  await db.from("campaign_sheet_sync").update({
    sheet_row: j.row, sheet_key: key, synced_at: new Date().toISOString(), attempts: 0, last_error: note,
  }).eq("campaign_id", row.campaign_id);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const { data: cfg } = await db.rpc("sheet_sync_config");
  // A signed-in team member asking for the next PO number (new campaign form).
  let body: any = {};
  try { body = await req.json(); } catch { /* scheduled calls send {} */ }
  if (body?.action === "next_po") {
    if (!(await teamMember(req))) return json({ error: "Sign in as a Stellar team member." }, 401);
    if (!cfg?.sheet_sync_url) return json({ po: null, sheet_error: "not configured" });
    return json(await nextPo(cfg));
  }
  const { data: rows, error } = await db.rpc("claim_sheet_sync", { n: 20 });
  if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500 });
  if (!rows?.length) return new Response(JSON.stringify({ synced: 0 }));
  if (!cfg?.sheet_sync_url) {
    for (const r of rows) await db.from("campaign_sheet_sync").update({ last_error: "The sheet connection isn't set up yet." }).eq("campaign_id", r.campaign_id);
    return new Response(JSON.stringify({ synced: 0, error: "not configured" }));
  }
  let ok = 0;
  const failures: string[] = [];
  for (const r of rows) {   // one at a time: the sheet script takes a lock anyway
    try { await syncOne(r, cfg); ok++; } catch (e) {
      const attempts = (r.attempts ?? 0) + 1;
      const wait = Math.min(2 ** attempts, 60);    // minutes
      failures.push(String((e as Error).message));
      await db.from("campaign_sheet_sync").update({
        attempts, last_error: String((e as Error).message).slice(0, 300),
        due_at: attempts <= 8 ? new Date(Date.now() + wait * 60_000).toISOString() : null,
      }).eq("campaign_id", r.campaign_id).is("due_at", null);
    }
  }
  return new Response(JSON.stringify({ synced: ok, failed: failures.length, failures }), { headers: { "Content-Type": "application/json" } });
});
