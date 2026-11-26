-- The client's own PO on an invoice request (po_number is Stellar's PO).
alter table public.invoice_requests add column if not exists client_po text;
comment on column public.invoice_requests.client_po is 'The client''s own PO (if any); po_number is Stellar''s PO.';
