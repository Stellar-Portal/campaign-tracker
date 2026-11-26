-- Email switch for alerts (applied 2026-11-26). private.settings key 'notify_email' = 'on' | 'off' (default off).
-- Read by the notify-email edge function only (service role).
create or replace function public.notify_email_mode()
returns text language sql stable security definer set search_path = '' as $$
  select coalesce((select value from private.settings where key = 'notify_email'), 'off')
$$;
revoke execute on function public.notify_email_mode() from public, anon, authenticated;
grant execute on function public.notify_email_mode() to service_role;

-- To start the alert emails later (Sam's OK first), schedule the function, then flip the switch:
-- select cron.schedule('notify-email', '*/5 * * * *', $$
--   select net.http_post(url := 'https://vmzbpuootzchpdnvtfhb.supabase.co/functions/v1/notify-email', body := '{}'::jsonb,
--     headers := jsonb_build_object('Content-Type','application/json','x-deck-secret', public.deck_secret()), timeout_milliseconds := 30000);
-- $$);
-- update private.settings set value = 'on' where key = 'notify_email';
