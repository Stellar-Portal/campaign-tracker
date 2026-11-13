-- Personal to-do list (beta). Applied live as migrations "todo_beta" and "todo_beta_allowed" on 2026-11-09.
-- Tables: todo_items, todo_events, todo_weeks (owner-only RLS + grants to authenticated), todo_links (no client access).
-- private.settings.todo_beta_users = who may use the beta; public.todo_beta_allowed(email) checks it (service_role only).
-- See the live database for the exact definitions.

-- 2026-11-09 "todo_area_priority" + "todo_area_access_fn": todo_areas.priority (1–9, same number = side by side on the
-- full-page board); private.settings.todo_area_access = {"Campaign Central":[emails],"Sports":[emails]} (who may pick those
-- areas), read by public.todo_area_access() (service_role only).

-- 2026-11-13 "campaign_chat" (+ "campaign_chat_fix_edit_log"): campaign_messages, campaign_visits, campaign_activity (+ triggers on
-- campaigns, payout_rows, invoice_requests, campaign_folders, share_links), RPC campaign_recap(uuid, timestamptz); campaign_messages in
-- the supabase_realtime publication. Applied live through the Supabase tools; the live database is the truth.
