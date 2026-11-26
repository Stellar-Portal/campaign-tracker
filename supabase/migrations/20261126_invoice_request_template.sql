-- Invoice request: the fields of Sam's email template to finance (applied 2026-11-26).
-- All nullable free text (the UI offers the choices). Existing columns already cover:
-- Stellar PO = po_number (the client PO got its own column client_po, see 20261126_invoice_requests_client_po.sql), Client full legal name = invoicing_entity / client_entity_id,
-- Budget + currency = amount + currency. uses_portal / portal_name stay; the UI fills them from send_via.
-- Table-level grants to authenticated (select/insert/update) and the existing RLS policies cover new columns.
alter table public.invoice_requests
  add column if not exists responsible   text,   -- Campaign responsible (DRI name)
  add column if not exists artist        text,
  add column if not exists song          text,
  add column if not exists label_type    text,   -- Major / Indie / Other
  add column if not exists territory     text,   -- West / Central / East
  add column if not exists project       text,
  add column if not exists contact_name  text,
  add column if not exists contact_email text,
  add column if not exists send_via      text,   -- UNIPORT / ARIBA / FIT / E-mail / other text
  add column if not exists allocation    jsonb;  -- [{"region":"West","amount":6000}, ...]

alter table public.invoice_requests
  add constraint invoice_requests_allocation_array
  check (allocation is null or jsonb_typeof(allocation) = 'array');
