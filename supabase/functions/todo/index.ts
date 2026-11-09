// todo: personal to-do list (beta, todo.html). One list per person; owner = their email.
// Who may call it:
//   - a signed-in Stellar OS session (Authorization: Bearer <jwt>) whose email is in private.settings.todo_beta_users
//   - a private link key (x-todo-key), made from a signed-in session; only its SHA-256 hash is stored
// Actions:
//   config                         who am I, is the AI on
//   load                           open tasks + recently finished ones + week states
//   save {item}                    add or change one task
//   add_many {items, source}       add several (from a photo or a pasted list)
//   apply {ops}                    apply changes (from the AI box, after the person confirmed them)
//   close_week {week}              end the Friday recap: open tasks carry over to next week
//   plan_done {week}               the Monday overview was gone through
//   snap {image, media_type}       read a photo of handwritten notes into tasks (not stored)
//   ai {prompt, tasks}             turn "task 1 was done, but I still have to do X" into proposed changes
//   link_create / link_list / link_revoke   private links (signed-in session only)
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
const AI_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
const AI_MODEL = Deno.env.get("TODO_AI_MODEL") ?? "claude-sonnet-5-5";
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-todo-key",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" } });
const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
const sha256 = async (s: string) => hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const clean = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "") || null;

// ---------- Copenhagen time: weeks start on Monday ----------
function cph(d = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Copenhagen", year: "numeric", month: "2-digit", day: "2-digit", weekday: "short", hour: "2-digit", hour12: false })
    .formatToParts(d).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, weekday: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(p.weekday), hour: Number(p.hour) % 24 };
}
const addDays = (date: string, n: number) => { const t = new Date(`${date}T12:00:00Z`); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
const mondayOf = (d = new Date()) => { const c = cph(d); return addDays(c.date, -c.weekday); };

// ---------- who is calling ----------
async function who(req: Request): Promise<{ owner: string; via: "session" | "link" } | { error: string; status: number }> {
  const key = req.headers.get("x-todo-key") ?? "";
  if (key) {
    if (!/^[A-Za-z0-9_-]{32,100}$/.test(key)) return { error: "This link isn't valid.", status: 401 };
    const { data: link } = await db.from("todo_links").select("id,owner,revoked_at,last_used_at").eq("key_hash", await sha256(key)).maybeSingle();
    if (!link || link.revoked_at) {
      const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || "unknown";
      await db.rpc("deck_rate_ok", { p_key: "todo-bad:" + (await sha256(ip)).slice(0, 22), p_limit: 20, p_seconds: 600 });
      return { error: "This link has been switched off or isn't valid.", status: 401 };
    }
    if (!(await db.rpc("todo_beta_allowed", { p_email: link.owner })).data) return { error: "This list isn't available.", status: 403 };
    if (!link.last_used_at || Date.now() - new Date(link.last_used_at).getTime() > 3600_000) await db.from("todo_links").update({ last_used_at: new Date().toISOString() }).eq("id", link.id);
    return { owner: link.owner, via: "link" };
  }
  const jwt = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!jwt.startsWith("ey")) return { error: "Open your private link, or sign in to Stellar OS in this browser.", status: 401 };
  const { data } = await db.auth.getUser(jwt);
  const email = data.user?.email?.toLowerCase();
  if (!email) return { error: "Your Stellar OS session has expired. Sign in again.", status: 401 };
  if (!(await db.rpc("todo_beta_allowed", { p_email: email })).data) return { error: "The to-do beta isn't switched on for your account yet.", status: 403 };
  return { owner: email, via: "session" };
}

// ---------- tasks ----------
const FIELDS = ["title", "notes", "status", "remaining", "urgent", "due_date", "project", "position", "week_start"] as const;
function tidy(item: any) {
  const out: Record<string, unknown> = {};
  if ("title" in item) out.title = clean(item.title, 300);
  if ("notes" in item) out.notes = clean(item.notes, 4000);
  if ("remaining" in item) out.remaining = clean(item.remaining, 1000);
  if ("project" in item) out.project = clean(item.project, 80);
  if ("status" in item && ["open", "partial", "done", "dropped"].includes(item.status)) out.status = item.status;
  if ("urgent" in item) out.urgent = !!item.urgent;
  if ("due_date" in item) out.due_date = typeof item.due_date === "string" && DATE.test(item.due_date) ? item.due_date : null;
  if ("week_start" in item && typeof item.week_start === "string" && DATE.test(item.week_start)) out.week_start = item.week_start;
  if ("position" in item && Number.isFinite(Number(item.position))) out.position = Number(item.position);
  return out;
}
async function insertItems(owner: string, items: any[], source: string) {
  const week = mondayOf(), now = Date.now();
  const rows = items.map((it, i) => ({ ...tidy(it), owner, source, week_start: week, position: now / 1000 + i, ...(it.status === "done" ? { done_at: new Date().toISOString() } : {}) }))
    .filter((r) => r.title);
  if (!rows.length) return [];
  const { data, error } = await db.from("todo_items").insert(rows).select("*");
  if (error) throw error;
  await db.from("todo_events").insert(data.map((r) => ({ item_id: r.id, owner, kind: "created", detail: { source } })));
  return data;
}
async function changeItem(owner: string, id: string, patch: Record<string, unknown>, kind = "edited") {
  const { data: cur } = await db.from("todo_items").select("*").eq("id", id).eq("owner", owner).maybeSingle();
  if (!cur) throw new Error("That task doesn't exist any more.");
  const only = Object.keys(patch).every((k) => k === "position");
  const next: Record<string, unknown> = { ...patch };
  if (!only) next.touched_at = new Date().toISOString();
  if (patch.status && patch.status !== cur.status) {
    next.done_at = patch.status === "done" ? new Date().toISOString() : null;
    kind = "status";
  }
  const { data, error } = await db.from("todo_items").update(next).eq("id", id).eq("owner", owner).select("*").single();
  if (error) throw error;
  if (!only) await db.from("todo_events").insert({ item_id: id, owner, kind, detail: patch });
  return data;
}

// ---------- AI (Claude) ----------
// The model answers by calling the one tool it's given (forcing a tool isn't supported by every model,
// so it's asked to, and asked once more if it answered in plain text).
async function claude(system: string, content: unknown[], tool: Record<string, unknown>) {
  const sys = `${system}\nAlways answer by calling the ${tool.name} tool exactly once. Never answer in plain text.`;
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": AI_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: AI_MODEL, max_tokens: 4000, system: sys, tools: [tool], tool_choice: { type: "auto" }, messages: [{ role: "user", content }] }),
    });
    const j = await r.json().catch(() => null);
    if (!r.ok) { console.error("todo ai", r.status, JSON.stringify(j).slice(0, 300)); throw new Error("The AI couldn't answer right now. Try again in a minute."); }
    const use = (j?.content ?? []).find((c: any) => c.type === "tool_use" && c.name === tool.name);
    if (use) return use.input;
    console.error("todo ai: no tool call", JSON.stringify(j?.content ?? []).slice(0, 200));
  }
  throw new Error("The AI didn't return anything usable. Try again.");
}
const today = () => { const c = cph(); return `${c.date} (${["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"][c.weekday]}), Copenhagen time`; };

const SNAP_TOOL = {
  name: "tasks_from_notes",
  description: "The tasks read from the photo.",
  input_schema: {
    type: "object",
    properties: {
      items: { type: "array", items: { type: "object", properties: {
        title: { type: "string", description: "Short, clear action in the writer's own words and language, spelling fixed. Keep names, artists, clients, numbers." },
        notes: { type: "string", description: "Sub-points or details written under the task." },
        project: { type: "string", description: "Client, artist or project the task belongs to, if the notes show it (heading, bracket, arrow, margin)." },
        due_date: { type: "string", description: "YYYY-MM-DD if a date or deadline is written (Fri, 12/11, EOD = today, EOW = this Friday, tmrw)." },
        urgent: { type: "boolean", description: "Marked urgent: !, ASAP, urgent, circled, starred, underlined twice." },
        done: { type: "boolean", description: "Crossed out or ticked off on paper." },
        unsure: { type: "boolean", description: "True if part of it was hard to read and you guessed." },
      }, required: ["title"] } },
      unreadable: { type: "array", items: { type: "string" }, description: "Bits you couldn't read at all, described briefly." },
    },
    required: ["items"],
  },
};
const SNAP_SYSTEM = `You turn a photo of someone's handwritten notes (a notepad, whiteboard or sticky notes) into a clean to-do list.
Rules:
- One task per item. Rewrite each as a short, clear action. Keep the writer's language and their names for people, clients, artists and songs. Fix spelling. Never invent tasks.
- Merge exact duplicates. Put sub-points under their task as notes rather than separate tasks, unless they are clearly separate actions.
- If the notes are grouped (headings, boxes, brackets, arrows), use the group as the project.
- Items that are crossed out or ticked are done: include them with done = true.
- Turn written deadlines into dates using today's date. EOD = today, EOW = this Friday, "Mon" = the next Monday.
- Order the list: urgent first, then by deadline, then in the order written.
- If something can't be read, don't guess wildly: add it to unreadable.`;

const OPS_TOOL = {
  name: "update_tasks",
  description: "Changes to make to the to-do list, plus a one-line reply.",
  input_schema: {
    type: "object",
    properties: {
      ops: { type: "array", items: { type: "object", properties: {
        op: { type: "string", enum: ["done", "partial", "reopen", "update", "add", "drop"] },
        n: { type: "integer", description: "Number of the existing task (as shown to the person). Not used for add." },
        title: { type: "string" }, notes: { type: "string" },
        remaining: { type: "string", description: "For partial: what is still left to do." },
        due_date: { type: "string", description: "YYYY-MM-DD" }, urgent: { type: "boolean" }, project: { type: "string" },
        follows_n: { type: "integer", description: "For add: the task this new one follows on from." },
      }, required: ["op"] } },
      reply: { type: "string", description: "One short sentence saying what you changed, or a question if it was unclear." },
    },
    required: ["ops", "reply"],
  },
};
const OPS_SYSTEM = `You update someone's to-do list from a quick message they type. The tasks are numbered the way they see them.
How to read common messages:
- "1 is done" → done.
- "1 is done, but I still have to do X" → done for 1, and add X as a new task with follows_n = 1 (it carries over).
- "1 is half done / partly done, X left" → partial with remaining = X.
- "push 2 to Thursday" → update due_date. "2 is urgent" → update urgent = true.
- "forget 3 / not needed" → drop.
- "add: ..." or anything new → add.
Only change what the message is about. Never touch other tasks. If a number or task is unclear, make no change and ask in reply.
Keep titles short and in the person's language. Dates as YYYY-MM-DD.`;

// ---------- serve ----------
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Not allowed" }, 405);
  let body: any = {};
  try { body = JSON.parse(await req.text()); } catch { return json({ error: "Bad request" }, 400); }
  const me = await who(req);
  if ("error" in me) return json({ error: me.error, locked: true }, me.status);
  const owner = me.owner;
  try {
    switch (body.action) {
      case "config":
        return json({ owner, via: me.via, ai: !!AI_KEY, week: mondayOf(), now: cph() });

      case "load": {
        const since = new Date(Date.now() - 28 * 86400_000).toISOString();
        const [open, recent, weeks] = await Promise.all([
          db.from("todo_items").select("*").eq("owner", owner).in("status", ["open", "partial"]).order("position"),
          db.from("todo_items").select("*").eq("owner", owner).in("status", ["done", "dropped"]).gte("updated_at", since).order("updated_at", { ascending: false }).limit(300),
          db.from("todo_weeks").select("*").eq("owner", owner).gte("week_start", addDays(mondayOf(), -28)),
        ]);
        return json({ items: [...(open.data ?? []), ...(recent.data ?? [])], weeks: weeks.data ?? [], week: mondayOf(), now: cph() });
      }

      case "save": {
        const it = body.item ?? {};
        if (!it.id) return json({ item: (await insertItems(owner, [it], "manual"))[0] ?? null });
        const patch = tidy(it);
        delete patch.week_start;
        if ("title" in patch && !patch.title) return json({ error: "A task needs a title." }, 400);
        return json({ item: await changeItem(owner, String(it.id), patch) });
      }

      case "add_many": {
        const src = ["photo", "ai", "manual"].includes(body.source) ? body.source : "manual";
        const items = Array.isArray(body.items) ? body.items.slice(0, 100) : [];
        return json({ items: await insertItems(owner, items, src) });
      }

      case "apply": {
        const ops = Array.isArray(body.ops) ? body.ops.slice(0, 50) : [];
        const out: any[] = [];
        for (const o of ops) {
          if (o.op === "add") {
            const [row] = await insertItems(owner, [{ title: o.title, notes: o.notes, due_date: o.due_date, urgent: o.urgent, project: o.project }], "ai");
            if (row && o.follows_id) await db.from("todo_items").update({ follows_id: o.follows_id }).eq("id", row.id).eq("owner", owner);
            if (row) out.push(row);
            continue;
          }
          if (!o.id) continue;
          const patch: Record<string, unknown> =
            o.op === "done" ? { status: "done" } :
            o.op === "partial" ? { status: "partial", remaining: clean(o.remaining, 1000) } :
            o.op === "reopen" ? { status: "open" } :
            o.op === "drop" ? { status: "dropped" } :
            o.op === "update" ? tidy(Object.fromEntries(Object.entries(o).filter(([k]) => ["title", "notes", "due_date", "urgent", "project", "remaining"].includes(k)))) : {};
          if (!Object.keys(patch).length) continue;
          out.push(await changeItem(owner, String(o.id), patch));
        }
        return json({ items: out });
      }

      case "close_week": {
        const week = DATE.test(body.week ?? "") ? body.week : mondayOf();
        const next = addDays(week, 7);
        const { data: open } = await db.from("todo_items").select("id").eq("owner", owner).in("status", ["open", "partial"]).lte("week_start", week);
        const ids = (open ?? []).map((r) => r.id);
        if (ids.length) {
          await db.from("todo_items").update({ week_start: next }).in("id", ids).eq("owner", owner);
          await db.from("todo_events").insert(ids.map((id) => ({ item_id: id, owner, kind: "carried", detail: { to: next } })));
        }
        await db.from("todo_weeks").upsert({ owner, week_start: week, recap_done_at: new Date().toISOString() }, { onConflict: "owner,week_start" });
        return json({ carried: ids.length, week: next });
      }

      case "plan_done": {
        const week = DATE.test(body.week ?? "") ? body.week : mondayOf();
        await db.from("todo_weeks").upsert({ owner, week_start: week, plan_done_at: new Date().toISOString() }, { onConflict: "owner,week_start" });
        return json({ ok: true });
      }

      case "snap": {
        if (!AI_KEY) return json({ error: "Reading photos needs the AI to be switched on (the ANTHROPIC_API_KEY secret)." }, 400);
        const img = typeof body.image === "string" ? body.image.replace(/^data:[^,]+,/, "") : "";
        const type = ["image/jpeg", "image/png", "image/webp"].includes(body.media_type) ? body.media_type : "image/jpeg";
        if (img.length < 200 || img.length > 7_000_000) return json({ error: "That photo couldn't be read. Try another one." }, 400);
        const r = await claude(SNAP_SYSTEM + `\nToday is ${today()}.`, [
          { type: "image", source: { type: "base64", media_type: type, data: img } },
          { type: "text", text: "Read these notes into tasks." },
        ], SNAP_TOOL);
        return json({ items: (r.items ?? []).slice(0, 100), unreadable: r.unreadable ?? [] });
      }

      case "ai": {
        if (!AI_KEY) return json({ error: "The AI box needs the ANTHROPIC_API_KEY secret." }, 400);
        const prompt = clean(body.prompt, 2000);
        if (!prompt) return json({ error: "Write what changed." }, 400);
        const shown = (Array.isArray(body.tasks) ? body.tasks : []).slice(0, 150).filter((t: any) => t?.id && Number.isInteger(t.n));
        const ids = shown.map((t: any) => String(t.id));
        const { data: mine } = ids.length ? await db.from("todo_items").select("id,title,status,remaining,due_date,urgent,project,notes").eq("owner", owner).in("id", ids) : { data: [] };
        const byId = new Map((mine ?? []).map((r) => [r.id, r]));
        const list = shown.filter((t: any) => byId.has(String(t.id))).map((t: any) => ({ n: t.n, ...byId.get(String(t.id)) }));
        const lines = list.map((t: any) => `${t.n}. ${t.title}${t.status !== "open" ? ` [${t.status}${t.remaining ? `: left ${t.remaining}` : ""}]` : ""}${t.due_date ? ` (due ${t.due_date})` : ""}${t.urgent ? " (urgent)" : ""}${t.project ? ` · ${t.project}` : ""}`).join("\n");
        const r = await claude(OPS_SYSTEM + `\nToday is ${today()}.`, [{ type: "text", text: `Tasks:\n${lines || "(none)"}\n\nMessage: ${prompt}` }], OPS_TOOL);
        const byN = new Map(list.map((t: any) => [t.n, t]));
        const ops = (r.ops ?? []).slice(0, 50).map((o: any) => {
          const t = o.n != null ? byN.get(o.n) : null;
          const f = o.follows_n != null ? byN.get(o.follows_n) : null;
          return { ...o, id: t?.id ?? null, current: t ? t.title : null, follows_id: f?.id ?? null, follows_title: f?.title ?? null };
        }).filter((o: any) => o.op === "add" ? !!clean(o.title, 300) : !!o.id);
        return json({ ops, reply: String(r.reply ?? "").slice(0, 400) });
      }

      case "link_create": {
        if (me.via !== "session") return json({ error: "Make new links from Stellar OS on your computer." }, 403);
        const key = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
        const { error } = await db.from("todo_links").insert({ owner, key_hash: await sha256(key), label: clean(body.label, 60) ?? "Private link" });
        if (error) throw error;
        return json({ key });
      }
      case "link_list": {
        const { data } = await db.from("todo_links").select("id,label,created_at,last_used_at,revoked_at").eq("owner", owner).is("revoked_at", null).order("created_at");
        return json({ links: data ?? [] });
      }
      case "link_revoke": {
        if (me.via !== "session") return json({ error: "Switch links off from Stellar OS on your computer." }, 403);
        await db.from("todo_links").update({ revoked_at: new Date().toISOString() }).eq("id", String(body.id ?? "")).eq("owner", owner);
        return json({ ok: true });
      }
    }
    return json({ error: "Unknown action" }, 400);
  } catch (e) {
    console.error("todo", String((e as Error).message));
    return json({ error: (e as Error).message?.length < 200 ? (e as Error).message : "Something went wrong. Please try again." }, 500);
  }
});
