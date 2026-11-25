-- Clients rebuild (company first), applied 2026-11-25. The data itself (338 e-conomic customers → 329 companies,
-- 274 new clients) was imported once through the Supabase tools from Sam's e-conomic export; it is not in the repo.
alter table public.client_entities
  add column if not exists economic_numbers integer[] not null default '{}',
  add column if not exists phone text,
  add column if not exists attention text,
  add column if not exists their_ref text,
  add column if not exists aliases text[] not null default '{}',
  add column if not exists also_clients uuid[] not null default '{}';
create index if not exists client_entities_economic_idx on public.client_entities using gin (economic_numbers);
-- private.campaigns_link_entity(): also matches aliases and prefers companies of the campaign's client (or also_clients).
-- public.merge_client_entities(p_from, p_into): team only; moves campaigns, invoice requests and vendor requests,
-- unions e-conomic numbers/aliases/also_clients, fills empty fields, deletes p_from. Full bodies: see the live database.
