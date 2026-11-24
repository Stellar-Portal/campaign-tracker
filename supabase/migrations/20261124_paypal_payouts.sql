-- PayPal payouts from Stellar OS (2026-11-24). Additive only.
-- Money only moves through the paypal-payouts Edge Function; the team can read these tables, never write them.

-- The creator's PayPal address for this payout (filled from creators.paypal_email when known).
alter table public.payout_rows add column if not exists paypal_email text;

-- One PayPal batch = one "Pay with PayPal" click on a campaign.
create table if not exists public.payout_batches (
  id uuid primary key default gen_random_uuid(),          -- also PayPal's sender_batch_id
  campaign_id uuid not null references public.campaigns(id) on delete restrict,
  env text not null check (env in ('live', 'sandbox')),
  paypal_batch_id text,
  status text not null default 'queued',                  -- queued, pending, processing, success, denied, canceled, failed, error
  currency text not null,
  total numeric not null,
  item_count integer not null,
  po_number text not null,
  invoices jsonb not null default '[]'::jsonb,            -- the campaign's invoice requests at the moment of paying
  note text not null,
  sent_by text not null,
  error text,
  created_at timestamptz not null default now(),
  checked_at timestamptz
);

-- One payment to one creator. The PO number travels with it (also in PayPal's note).
create table if not exists public.payout_payments (
  id uuid primary key default gen_random_uuid(),          -- also PayPal's sender_item_id
  batch_id uuid not null references public.payout_batches(id) on delete restrict,
  campaign_id uuid not null references public.campaigns(id) on delete restrict,
  row_id uuid references public.payout_rows(id) on delete set null,
  creator_id uuid references public.creators(id) on delete set null,
  handle text,
  recipient text not null,
  amount numeric not null check (amount > 0),
  currency text not null,
  po_number text not null,
  note text not null,
  env text not null check (env in ('live', 'sandbox')),
  status text not null default 'queued',                  -- queued, pending, success, unclaimed, onhold, failed, returned, blocked, refunded, reversed, denied, canceled
  paypal_item_id text,
  transaction_id text,
  fee numeric,
  error text,
  sent_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists payout_payments_campaign_idx on public.payout_payments(campaign_id);
create index if not exists payout_payments_batch_idx on public.payout_payments(batch_id);
create index if not exists payout_batches_campaign_idx on public.payout_batches(campaign_id);
create index if not exists payout_batches_open_idx on public.payout_batches(status) where status in ('queued', 'pending', 'processing');
-- A payout row can never be paid twice: at most one payment per row that is on its way or done.
create unique index if not exists payout_payments_one_per_row on public.payout_payments(row_id)
  where status in ('queued', 'pending', 'success', 'unclaimed', 'onhold');

alter table public.payout_batches enable row level security;
alter table public.payout_payments enable row level security;
create policy "team can read" on public.payout_batches for select to authenticated using (private.is_team_member());
create policy "team can read" on public.payout_payments for select to authenticated using (private.is_team_member());
grant select on public.payout_batches, public.payout_payments to authenticated;
revoke all on public.payout_batches, public.payout_payments from anon;
revoke insert, update, delete, truncate, references, trigger on public.payout_batches, public.payout_payments from authenticated;

-- Sending switch: 'off' (nothing can be sent), 'sandbox' (PayPal test money) or 'live'. Only Sam turns on 'live'.
insert into private.settings(key, value) values ('paypal_mode', 'off') on conflict (key) do nothing;
create or replace function public.paypal_mode() returns text language sql security definer set search_path = '' stable
  as $$ select coalesce((select value from private.settings where key = 'paypal_mode'), 'off') $$;
revoke all on function public.paypal_mode() from public, anon, authenticated;
grant execute on function public.paypal_mode() to service_role;

-- Status check every 5 minutes, only while something is on its way (applied as paypal_payouts_cron).
select cron.schedule('paypal-sync', '*/5 * * * *', $$
  select net.http_post(url := 'https://vmzbpuootzchpdnvtfhb.supabase.co/functions/v1/paypal-payouts', body := '{}'::jsonb,
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-deck-secret', public.deck_secret()), timeout_milliseconds := 60000)
  where exists (select 1 from public.payout_payments where status in ('queued', 'pending', 'unclaimed', 'onhold'));
$$);
