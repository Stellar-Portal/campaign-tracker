-- Email switch for alerts (applied 2026-11-26). private.settings key 'notify_email' = 'on' | 'off' (default off).
-- Read by the notify-email edge function only (service role).
create or replace function public.notify_email_mode()
returns text language sql stable security definer set search_path = '' as $$
  select coalesce((select value from private.settings where key = 'notify_email'), 'off')
$$;
revoke execute on function public.notify_email_mode() from public, anon, authenticated;
grant execute on function public.notify_email_mode() to service_role;
