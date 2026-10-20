-- Fit to the hospital's consumables list (corrections.md, C2 + C3).
--
-- C2: what a location does for stock (service role), and which roles an item type may be sent to.
--     A null service_role or null allowed_service_roles means "no restriction", so existing rows
--     keep working exactly as before.
-- C3: an editable pack size. The ledger counts in the item's own stock unit and never converts,
--     so changing pack_size never changes a stock count or rewrites an event. It is only used to
--     display equivalents ("40 packs, about 4,000 pieces").

alter table consumables.locations
  add column service_role text
    check (service_role in ('STORE', 'COLLECTION_POINT', 'BENCH', 'BLOOD_BANK'));

alter table consumables.item_types
  add column allowed_service_roles text[]
    check (
      allowed_service_roles is null
      or (
        cardinality(allowed_service_roles) > 0
        and allowed_service_roles <@ array['STORE', 'COLLECTION_POINT', 'BENCH', 'BLOOD_BANK']::text[]
      )
    );

alter table consumables.item_types
  add column pack_size integer not null default 1 check (pack_size >= 1),
  add column pack_size_confirmed boolean not null default false;
