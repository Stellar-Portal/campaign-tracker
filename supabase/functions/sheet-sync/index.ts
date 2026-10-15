// sheet-sync: writes campaigns to the Campaign Overview Google Sheet.
//
// Any change to a campaign, its market splits or its creator costs puts the campaign in a
// queue (table campaign_sheet_sync). A schedule calls this function every minute while
// something is waiting. It takes no input: it only pushes the tracker's current data for
// queued campaigns, so calling it is harmless.
//
// It also mirrors the sheet into overview_snapshot for the Campaign Overview page ("pull_overview"),
// and suggests the next free PO number ("next_po").
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

// ---------- sheet → tracker ----------
// The sheet's values for one campaign, in tracker terms. Compared with what was last seen to spot
// edits made directly in the sheet; only the fields that changed are copied into the tracker.
const STATUS_IN: Record<string, string> = { Upcoming: "draft", Active: "active", "On Hold": "on_hold", Completed: "finished" };
const FIELD_LABEL: Record<string, string> = {
  status: "status", artist: "artist", song: "song", po_number: "PO number", release_type: "type", client: "client",
  invoicing_entity: "invoicing entity", client_country: "client location", client_market: "client market",
  client_contact_name: "contact", client_contact_email: "contact email", label_type: "label", under_nda: "NDA",
  comms_owner: "DRI", campaign_type: "campaign type", start_date: "start date", duration: "duration",
  budget: "price", currency: "currency", alloc: "budget split",
};
function sheetDateIso(v: string, sheetName: string): string | null {
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  const m = v.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/);
  if (!m) return null;
  const d = Number(m[1]), mo = Number(m[2]);
  if (d < 1 || d > 31 || mo < 1 || mo > 12) return null;
  const pad = (x: number) => String(x).padStart(2, "0");
  if (m[3]) return `${m[3].length === 2 ? "20" + m[3] : m[3]}-${pad(mo)}-${pad(d)}`;
  const fy = sheetName.match(/FY\s*(\d{2})\s*\/\s*(\d{2})/i);
  if (fy) return `20${mo >= 4 ? fy[1] : fy[2]}-${pad(mo)}-${pad(d)}`;
  const now = Date.now(), y = new Date().getFullYear();
  return [y - 1, y, y + 1].map((yy) => `${yy}-${pad(mo)}-${pad(d)}`).sort((a, b) => Math.abs(Date.parse(a) - now) - Math.abs(Date.parse(b) - now))[0];
}
function readSheetFields(headers: string[], values: string[], sheetName: string) {
  const idx: Record<string, number> = {};
  headers.forEach((h, i) => { const k = norm(h); if (!(k in idx)) idx[k] = i; });
  const g = (h: string) => { const i = idx[norm(h)]; const v = i == null ? "" : String(values[i] ?? "").trim(); return v === "Select" ? "" : v; };
  const n = (x: string) => { const t = x.replace(/[^\d.\-]/g, ""); return t && !isNaN(Number(t)) ? Number(t) : null; };
  const pick = (v: string, allowed: string[]) => (allowed.includes(v) ? v : null);
  const alloc: Record<string, number> = {};
  for (const m of MARKETS) { const v = n(g(m)); if (v) alloc[m] = v; }
  const cur = g("Currency").toUpperCase().replace("JYP", "JPY");
  return {
    status: STATUS_IN[g("Status")] ?? null,
    artist: g("Artist Name") || null, song: g("Song Name (s) or Project Name") || null, po_number: g("Stellar PO no.") || null,
    release_type: pick(g("Type (NR or Cat)"), ["New Release", "Catalogue", "Other"]),
    client: g("Client") || null, invoicing_entity: g("Invoicing Entity") || null, client_country: g("Client Location (Country)") || null,
    client_market: pick(g("Client Market"), ["Stellar West", "Stellar Central", "Stellar East"]),
    client_contact_name: g("Client Contact Name") || null, client_contact_email: g("Client Contact eMail") || null,
    label_type: pick(g("Major / Indie / Other"), ["Major", "Indie", "Other"]),
    under_nda: g("Under NDA?") === "Yes" ? true : g("Under NDA?") === "No" ? false : null,
    comms_owner: g("Stellar DRI") || null, campaign_type: g("Campaign Type") || null,
    start_date: sheetDateIso(g("Start Date"), sheetName), duration: g("Duration").toLowerCase() || null,
    budget: n(g("Price")), currency: /^[A-Z]{3}$/.test(cur) ? cur : null,
    alloc,
  } as Record<string, any>;
}
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
function endFromDuration(start: string | null, v: string | null): string | null | undefined {
  if (!start || !v) return undefined;
  if (/indefinite|ongoing/i.test(v)) return null;
  const m = v.match(/(\d+)\s*(day|week|month)/);
  if (!m) return undefined;
  const k = Number(m[1]), dt = new Date(start + "T00:00:00Z");
  if (m[2] === "day") dt.setUTCDate(dt.getUTCDate() + k - 1);
  else if (m[2] === "week") dt.setUTCDate(dt.getUTCDate() + k * 7 - 1);
  else { dt.setUTCMonth(dt.getUTCMonth() + k); dt.setUTCDate(dt.getUTCDate() - 1); }
  return dt.toISOString().slice(0, 10);
}
// Copy what changed in the sheet into the tracker campaign. Returns the labels of what changed.
async function applyFromSheet(cid: string, prev: Record<string, any>, now: Record<string, any>): Promise<string[]> {
  const changed = Object.keys(now).filter((k) => !same(now[k], prev[k]));
  if (!changed.length) return [];
  const { data: c } = await db.from("campaigns").select("*").eq("id", cid).maybeSingle();
  if (!c) return [];
  const upd: Record<string, unknown> = {};
  for (const k of changed) {
    if (k === "alloc" || k === "duration") continue;
    if ((k === "status" || k === "artist") && !now[k]) continue;   // never blank out required fields
    upd[k] = now[k];
  }
  if (changed.includes("start_date") || changed.includes("duration")) {
    const end = endFromDuration(now.start_date ?? c.start_date, now.duration);
    if (end !== undefined) upd.end_date = end;
  }
  if (Object.keys(upd).length) {
    const { error } = await db.from("campaigns").update(upd).eq("id", cid);
    if (error) throw new Error(error.code === "23505" ? "another campaign already has that artist, song and PO" : error.message);
  }
  if (changed.includes("alloc")) {
    const budget = Number((upd.budget ?? c.budget) || 0);
    const [{ data: cm }, { data: mk }] = await Promise.all([
      db.from("campaign_markets").select("market,amount,share_percent").eq("campaign_id", cid),
      db.from("markets").select("name,sheet_column,position"),
    ]);
    const colOf = Object.fromEntries((mk ?? []).map((m) => [m.name, m.sheet_column]));
    const cols = new Set([...Object.keys(prev.alloc ?? {}), ...Object.keys(now.alloc ?? {})]);
    for (const col of cols) {
      const v = now.alloc?.[col] ?? null;
      if (same(v, prev.alloc?.[col] ?? null)) continue;
      const rows = (cm ?? []).filter((r) => colOf[r.market] === col);
      const share = (a: number) => (budget ? Math.round((a / budget) * 10000) / 100 : null);
      if (!v) { if (rows.length) await db.from("campaign_markets").delete().eq("campaign_id", cid).in("market", rows.map((r) => r.market)); continue; }
      if (!rows.length) {
        await db.from("campaign_markets").insert({ campaign_id: cid, market: col, amount: v, share_percent: share(v) });
        if (c.folders_by_market) await db.from("campaign_folders").insert({ campaign_id: cid, name: col, market: col, position: (mk ?? []).find((m) => m.name === col)?.position ?? 0 });
      } else if (rows.length === 1) {
        await db.from("campaign_markets").update({ amount: v, share_percent: share(v) }).eq("campaign_id", cid).eq("market", rows[0].market);
      } else {
        // Several countries share this sheet column: scale them so they add up to the new figure.
        const total = rows.reduce((t, r) => t + Number(r.amount ?? 0), 0) || rows.length;
        for (const r of rows) {
          const a = Math.round(((Number(r.amount ?? 0) || 1) / total) * v * 100) / 100;
          await db.from("campaign_markets").update({ amount: a, share_percent: share(a) }).eq("campaign_id", cid).eq("market", r.market);
        }
      }
    }
  }
  return changed.map((k) => FIELD_LABEL[k] ?? k);
}

// Called after every read of the sheet: bring edits made in the sheet into linked tracker campaigns.
async function pullEdits(x: any) {
  const [{ data: syncs }, { data: camps }] = await Promise.all([
    db.from("campaign_sheet_sync").select("campaign_id,due_at,sheet_row,sheet_key,sheet_fields"),
    db.from("campaigns").select("id,artist,song,po_number"),
  ]);
  const syncBy = new Map((syncs ?? []).map((r) => [r.campaign_id, r]));
  const byKey = new Map((camps ?? []).filter((c) => c.po_number).map((c) => [sheetKey(c), c.id]));
  const now = new Date().toISOString();
  const results: string[] = [];
  for (const r of x.rows ?? []) {
    const fields = readSheetFields(x.headers, r.values, x.sheet ?? "");
    const cid = r.cid ?? byKey.get([fields.artist, fields.song, fields.po_number].map(norm).join("|"));
    const sy = cid ? syncBy.get(cid) : null;
    if (!cid || !sy) continue;
    if (!sy.sheet_fields) { await db.from("campaign_sheet_sync").update({ sheet_fields: fields, sheet_row: r.row }).eq("campaign_id", cid); continue; }
    if (same(fields, sy.sheet_fields)) continue;
    if (sy.due_at) {
      // Also changed in the platform and not sent yet: the platform's version wins and overwrites the row.
      await db.from("campaign_sheet_sync").update({ sheet_note: "Changed in the sheet and in the platform at the same time; the platform's version was kept.", sheet_note_at: now }).eq("campaign_id", cid);
      continue;
    }
    try {
      const labels = await applyFromSheet(cid, sy.sheet_fields, fields);
      await db.from("campaign_sheet_sync").update({ sheet_fields: fields, sheet_row: r.row, sheet_note: labels.length ? `Updated from the sheet: ${labels.join(", ")}` : null, sheet_note_at: labels.length ? now : null }).eq("campaign_id", cid);
      if (labels.length) results.push(`${cid}: ${labels.join(", ")}`);
    } catch (e) {
      await db.from("campaign_sheet_sync").update({ sheet_fields: fields, sheet_note: `Couldn't take the sheet's changes: ${String((e as Error).message).slice(0, 200)}`, sheet_note_at: now }).eq("campaign_id", cid);
    }
  }
  return results;
}

// POST to the Apps Script web app. It runs the request, then redirects to a one-time URL with the answer.
// While a new script version is being published Google briefly answers "Script function not found",
// so a failed call is retried once after a short pause before it counts as an error.
async function callSheet(cfg: Record<string, string>, payload: Record<string, unknown>) {
  try { return await callSheetOnce(cfg, payload); } catch (e) {
    const msg = String((e as Error).message);
    if (/Not allowed|Nothing identifies|More than one row/.test(msg)) throw e;   // real answers from the script
    await new Promise((r) => setTimeout(r, 2000));
    return await callSheetOnce(cfg, payload);
  }
}
async function callSheetOnce(cfg: Record<string, string>, payload: Record<string, unknown>) {
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
  const j = await callSheet(cfg, { action: "upsert", campaign_id: row.campaign_id, key, prev_key: row.sheet_key, fields: buildFields(c) });
  const note = j.missing?.length ? `Columns not found in the sheet: ${j.missing.join(", ")}` : null;
  await db.from("campaign_sheet_sync").update({
    sheet_row: j.row, sheet_key: key, synced_at: new Date().toISOString(), attempts: 0, last_error: note,
    ...(j.values && j.headers ? { sheet_fields: readSheetFields(j.headers, j.values, j.sheet ?? "") } : {}),
  }).eq("campaign_id", row.campaign_id);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const { data: cfg } = await db.rpc("sheet_sync_config");
  // A signed-in team member asking for the next PO number (new campaign form).
  let body: any = {};
  try { body = await req.json(); } catch { /* scheduled calls send {} */ }
  // Mirror the sheet for the Campaign Overview page: every 5 minutes (schedule) or "Refresh" (team member).
  if (body?.action === "pull_overview") {
    const fromCron = !!cfg?.sheet_sync_secret && req.headers.get("x-cron-secret") === cfg.sheet_sync_secret;
    if (!fromCron && !(await teamMember(req))) return json({ error: "Not allowed" }, 401);
    if (!cfg?.sheet_sync_url) return json({ error: "The sheet connection isn't set up yet." }, 503);
    const now = new Date().toISOString();
    try {
      const x = await callSheet(cfg, { action: "export" });
      await db.from("overview_snapshot").update({ sheet: x.sheet, sections: x.sections, headers: x.headers, rows: x.rows, synced_at: now, last_attempt_at: now, last_error: null }).eq("id", 1);
      const pulled = await pullEdits(x);
      return json({ ok: true, rows: x.rows.length, synced_at: now, updated_from_sheet: pulled });
    } catch (e) {
      const msg = String((e as Error).message).slice(0, 300);
      await db.from("overview_snapshot").update({ last_attempt_at: now, last_error: msg }).eq("id", 1);
      return json({ error: msg }, 502);
    }
  }
  // Delete a campaign's row from the sheet (team member, from the platform's delete buttons).
  if (body?.action === "delete_row") {
    if (!(await teamMember(req))) return json({ error: "Sign in as a Stellar team member." }, 401);
    if (!cfg?.sheet_sync_url) return json({ error: "The sheet connection isn't set up yet." }, 503);
    const keys: string[] = [];
    if (body.key) keys.push(String(body.key));
    if (body.campaign_id) {
      const [{ data: sy }, { data: c }] = await Promise.all([
        db.from("campaign_sheet_sync").select("sheet_key,sheet_row").eq("campaign_id", body.campaign_id).maybeSingle(),
        db.from("campaigns").select("artist,song,po_number").eq("id", body.campaign_id).maybeSingle(),
      ]);
      if (sy?.sheet_key) keys.push(sy.sheet_key);
      if (c?.po_number) keys.push(sheetKey(c));
      if (!body.row && sy?.sheet_row) body.row = sy.sheet_row;
    }
    try {
      const r = await callSheet(cfg, { action: "delete_row", campaign_id: body.campaign_id ?? null, keys: [...new Set(keys)], row: body.row ?? null });
      if (r.row) {
        // Rows below moved up by one.
        const { data: below } = await db.from("campaign_sheet_sync").select("campaign_id,sheet_row").gt("sheet_row", r.row);
        for (const x of below ?? []) await db.from("campaign_sheet_sync").update({ sheet_row: x.sheet_row - 1 }).eq("campaign_id", x.campaign_id);
        if (body.campaign_id) await db.from("campaign_sheet_sync").update({ sheet_row: null, sheet_key: null }).eq("campaign_id", body.campaign_id);
      }
      // Refresh the overview straight away.
      try {
        const x = await callSheet(cfg, { action: "export" });
        const now = new Date().toISOString();
        await db.from("overview_snapshot").update({ sheet: x.sheet, sections: x.sections, headers: x.headers, rows: x.rows, synced_at: now, last_attempt_at: now, last_error: null }).eq("id", 1);
      } catch { /* the 5-minute refresh will catch up */ }
      return json({ ok: true, row: r.row, note: r.note ?? null });
    } catch (e) {
      return json({ error: String((e as Error).message).slice(0, 300) }, 502);
    }
  }
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
