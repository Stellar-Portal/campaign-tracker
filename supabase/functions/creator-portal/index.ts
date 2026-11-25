// creator-portal: the public side of a creator's personal campaign link (creator.html#t=<token>).
// One link per creator per folder (creator_portal_links). The token is the link id plus a signature
// (private.portal_token), checked by public.creator_portal_check, so the team can copy it again any time.
// Requests are rate-limited per hashed IP. No login.
//   status {token}                              -> campaign, folder, brief, the creator's drafts and posted links
//   upload_url {token, name, size, type}        -> signed upload link for one draft video (private "drafts" bucket)
//   draft_done {token, path, name, size, type, note?, replaces?} -> records the uploaded draft
//   withdraw {token, draft_id}                  -> takes back a draft that hasn't been reviewed yet
//   post_link {token, url}                      -> a posted TikTok/YouTube link goes into the campaign folder
//   payment {token, legal_name, country, paypal_email, paypal_username?} -> saved on the roster card (only if empty)
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

function serviceKey(): string {
  const raw = Deno.env.get("SUPABASE_SECRET_KEYS");
  if (raw) { try { const k = JSON.parse(raw); const v = k.default ?? Object.values(k)[0]; if (v) return String(v); } catch { /* ignore */ } }
  return Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
}
const URL_BASE = Deno.env.get("SUPABASE_URL")!;
const db = createClient(URL_BASE, serviceKey(), { auth: { persistSession: false } });
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" } });
const sha = async (t: string) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(t)))).map((b) => b.toString(16).padStart(2, "0")).join("");
const ipKey = async (req: Request) => sha("ip:" + ((req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || "unknown"));
const EMAIL = /^[^\s@<>()",;]+@[^\s@<>()",;]+\.[a-z]{2,}$/i;
const clean = (v: unknown, max: number) => String(v ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
const MAX_BYTES = 500 * 1024 * 1024, MAX_WAITING = 5;
const VIDEO = /^video\/(mp4|quicktime|webm|x-m4v|3gpp)$/;
const EXT: Record<string, string> = { "video/mp4": "mp4", "video/quicktime": "mov", "video/webm": "webm", "video/x-m4v": "m4v", "video/3gpp": "3gp" };
const LINK = /^https?:\/\/((www\.|m\.|vm\.|vt\.)?tiktok\.com|(www\.|m\.)?youtube\.com|youtu\.be)\//i;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Not found" }, 404);
  const body = await req.json().catch(() => ({}));
  try {
    const limit = body.action === "status" ? 120 : 40;
    if (!(await db.rpc("deck_rate_ok", { p_key: "cp:" + (await ipKey(req)), p_limit: limit, p_seconds: 600 })).data) return json({ error: "Too many tries. Please wait a few minutes." }, 429);
    const { data: linkId } = await db.rpc("creator_portal_check", { p_token: clean(body.token, 120) });
    if (!linkId) return json({ state: "gone" });
    const { data: link } = await db.from("creator_portal_links").select("id,campaign_id,folder_id,creator_id").eq("id", linkId).single();
    const [{ data: camp }, { data: folder }, { data: cr }] = await Promise.all([
      db.from("campaigns").select("id,artist,song,status,portal_drafts,portal_client_review,portal_brief").eq("id", link.campaign_id).single(),
      link.folder_id ? db.from("campaign_folders").select("id,name").eq("id", link.folder_id).maybeSingle() : Promise.resolve({ data: null }),
      db.from("creators").select("id,username,platform,paypal_email,payout_method,wise_email").eq("id", link.creator_id).single(),
    ]);
    if (!camp || !cr) return json({ state: "gone" });
    const now = new Date().toISOString();

    if (body.action === "status") {
      await db.from("creator_portal_links").update({ last_seen_at: now }).eq("id", link.id);
      await db.from("creator_portal_links").update({ opened_at: now }).eq("id", link.id).is("opened_at", null);
      const [{ data: drafts }, { data: posts }] = await Promise.all([
        db.from("creator_drafts").select("id,file_name,status,team_note,client_note,creator_note,created_at,replaces_id").eq("link_id", link.id).neq("status", "withdrawn").order("created_at"),
        db.from("creator_portal_posts").select("id,url,created_at,job_item_id").eq("link_id", link.id).order("created_at"),
      ]);
      const items = (posts ?? []).map((p) => p.job_item_id).filter(Boolean);
      const { data: ji } = items.length ? await db.from("link_job_items").select("id,status,error").in("id", items) : { data: [] };
      const jiBy = Object.fromEntries((ji ?? []).map((x) => [x.id, x]));
      const masked = cr.paypal_email ? cr.paypal_email.replace(/^(.).*?(@.*)$/, "$1•••$2") : null;
      return json({
        state: "open",
        campaign: { artist: camp.artist, song: camp.song, brief: camp.portal_brief, drafts: camp.portal_drafts, client_review: camp.portal_client_review, finished: camp.status === "finished" },
        folder: folder?.name ?? null, handle: cr.username, platform: cr.platform,
        payment: { has: !!(cr.paypal_email || (cr.payout_method === "wise" && cr.wise_email)), paypal: masked },
        drafts: drafts ?? [],
        posts: (posts ?? []).map((p) => ({ url: p.url, created_at: p.created_at, status: jiBy[p.job_item_id]?.status ?? "pending", error: jiBy[p.job_item_id]?.error ?? null })),
      });
    }

    if (camp.status === "finished") return json({ error: "This campaign is finished. Contact Stellar if you need anything." }, 400);

    if (body.action === "upload_url") {
      const type = clean(body.type, 40).toLowerCase(), size = Number(body.size);
      if (!camp.portal_drafts) return json({ error: "This campaign doesn't need drafts: post your video and send the link below." }, 400);
      if (!VIDEO.test(type)) return json({ error: "Please send a video file (MP4 or MOV)." }, 400);
      if (!(size > 0) || size > MAX_BYTES) return json({ error: "The video is too big. Please send one under 500 MB." }, 400);
      const { count } = await db.from("creator_drafts").select("id", { count: "exact", head: true }).eq("link_id", link.id).in("status", ["submitted", "team_ok"]);
      if ((count ?? 0) >= MAX_WAITING) return json({ error: `You already have ${MAX_WAITING} drafts waiting for review. Please wait for feedback first.` }, 400);
      const path = `${camp.id}/${link.id}/${crypto.randomUUID()}.${EXT[type]}`;
      const { data, error } = await db.storage.from("drafts").createSignedUploadUrl(path);
      if (error || !data) return json({ error: "Couldn't start the upload. Please try again." }, 500);
      return json({ path, url: `${URL_BASE}/storage/v1/object/upload/sign/drafts/${path}?token=${data.token}` });
    }

    if (body.action === "draft_done") {
      const path = clean(body.path, 300);
      if (!path.startsWith(`${camp.id}/${link.id}/`) || path.includes("..")) return json({ error: "Upload not found." }, 400);
      const dir = path.slice(0, path.lastIndexOf("/")), file = path.slice(path.lastIndexOf("/") + 1);
      const { data: found } = await db.storage.from("drafts").list(dir, { search: file, limit: 1 });
      if (!found?.some((f) => f.name === file)) return json({ error: "The upload didn't finish. Please try again." }, 400);
      if ((await db.from("creator_drafts").select("id").eq("file_path", path).maybeSingle()).data) return json({ ok: true });
      let replaces: string | null = null;
      if (body.replaces) {
        const { data: old } = await db.from("creator_drafts").select("id,status").eq("id", clean(body.replaces, 40)).eq("link_id", link.id).maybeSingle();
        if (old && ["changes", "client_changes"].includes(old.status)) { replaces = old.id; await db.from("creator_drafts").update({ status: "withdrawn" }).eq("id", old.id); }
      }
      const { error } = await db.from("creator_drafts").insert({
        link_id: link.id, campaign_id: camp.id, folder_id: link.folder_id, creator_id: cr.id, file_path: path,
        file_name: clean(body.name, 160) || "video", size_bytes: Number(body.size) || null, mime: clean(body.type, 40) || null,
        creator_note: clean(body.note, 1000) || null, replaces_id: replaces,
      });
      if (error) return json({ error: "Couldn't save the draft. Please try again." }, 500);
      return json({ ok: true });
    }

    if (body.action === "withdraw") {
      const { data: d } = await db.from("creator_drafts").select("id,status,file_path").eq("id", clean(body.draft_id, 40)).eq("link_id", link.id).maybeSingle();
      if (!d || d.status !== "submitted") return json({ error: "That draft is already being reviewed." }, 400);
      await db.from("creator_drafts").update({ status: "withdrawn" }).eq("id", d.id);
      await db.storage.from("drafts").remove([d.file_path]);
      return json({ ok: true });
    }

    if (body.action === "post_link") {
      const url = clean(body.url, 500);
      if (!LINK.test(url)) return json({ error: "Please paste the link to your TikTok (or YouTube) video." }, 400);
      if (camp.portal_drafts) {
        const { count } = await db.from("creator_drafts").select("id", { count: "exact", head: true }).eq("link_id", link.id).eq("status", "approved");
        if (!count) return json({ error: "Please wait until a draft is approved before you post." }, 400);
      }
      if ((await db.from("creator_portal_posts").select("id").eq("link_id", link.id).eq("url", url).maybeSingle()).data) return json({ ok: true });
      const { count: sent } = await db.from("creator_portal_posts").select("id", { count: "exact", head: true }).eq("link_id", link.id);
      if ((sent ?? 0) >= 30) return json({ error: "That's a lot of links. Please contact Stellar." }, 400);
      const { data: job, error: je } = await db.from("link_jobs").insert({ campaign_id: camp.id, folder_id: link.folder_id, submitted_by: `creator @${cr.username}` }).select("id").single();
      if (je || !job) return json({ error: "Couldn't send the link. Please try again." }, 500);
      const { data: item } = await db.from("link_job_items").insert({ job_id: job.id, url }).select("id").single();
      await db.from("creator_portal_posts").insert({ link_id: link.id, campaign_id: camp.id, folder_id: link.folder_id, creator_id: cr.id, url, job_item_id: item?.id ?? null });
      return json({ ok: true });
    }

    if (body.action === "payment") {
      if (cr.paypal_email || (cr.payout_method === "wise" && cr.wise_email)) return json({ error: "Stellar already has your payment details. Contact Stellar to change them." }, 400);
      const name = clean(body.legal_name, 120), country = clean(body.country, 2).toUpperCase();
      const email = clean(body.paypal_email, 200).toLowerCase();
      const user = clean(body.paypal_username, 80).replace(/^(https?:\/\/)?(www\.)?paypal\.me\//i, "").replace(/^@/, "").replace(/\/.*$/, "");
      const problems: string[] = [];
      if (name.length < 2) problems.push("your full name");
      if (!/^[A-Z]{2}$/.test(country)) problems.push("the country you live in");
      if (!EMAIL.test(email)) problems.push("a valid PayPal email");
      if (user && !/^[A-Za-z0-9._-]{1,40}$/.test(user)) problems.push("a PayPal username with letters and numbers only");
      if (problems.length) return json({ error: `Please add ${problems.join(", ")}.` }, 400);
      const { error } = await db.from("creators").update({
        legal_name: name, residence_country: country, paypal_email: email, paypal_username: user || null,
        payout_method: "paypal", payout_updated_at: now, payout_updated_by: "the creator",
      }).eq("id", cr.id).is("paypal_email", null);
      if (error) return json({ error: "Couldn't save. Please try again." }, 500);
      return json({ ok: true });
    }
    return json({ error: "Unknown action" }, 400);
  } catch (e) {
    console.error("creator-portal", String((e as Error).message));
    return json({ error: "Something went wrong. Please try again." }, 500);
  }
});
