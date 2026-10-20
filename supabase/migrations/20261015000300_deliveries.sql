-- Deliveries: one record for everything that arrives from a supplier together.
--
-- Until now every item in a delivery became its own batch with its own code, and the supplier was copied onto
-- each one, so nothing tied a delivery's batches together. A delivery is the parent: its own code, the supplier,
-- the store it was received into, who received it and when. Each item line is still a batch (own lot, expiry,
-- quantity and label), and now points at its delivery.
--
-- batches.delivery_id is nullable: batches received before this change, and single-item and Pharmacy GRN receipts
-- for now, have no delivery. Nothing that reads batches (stock, issue, transfer, counts, reports) is affected.
--
-- `reference` is free text for the supplier's invoice or delivery note number, filled in later if wanted.

create table consumables.deliveries (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  supplier text,
  location_id uuid not null references consumables.locations (id),
  reference text,
  received_by uuid not null references consumables.users (id),
  received_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index deliveries_location_idx on consumables.deliveries (location_id, received_at);

create trigger deliveries_updated_at before update on consumables.deliveries
  for each row execute function consumables.set_updated_at();

-- Same as every other table: RLS on, no policies (server-only access).
alter table consumables.deliveries enable row level security;

alter table consumables.batches
  add column delivery_id uuid references consumables.deliveries (id);
create index batches_delivery_idx on consumables.batches (delivery_id) where delivery_id is not null;
