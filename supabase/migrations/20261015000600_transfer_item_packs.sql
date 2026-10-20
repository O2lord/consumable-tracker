-- Whole packs on a transfer: each pack or roll that goes out is scanned, so its location follows the stock.
--
-- A whole-pack transfer line is still one row per batch (transfer_items.quantity_dispatched = number of packs) and the
-- batch ledger still moves the stock exactly as before. This table only records WHICH scanned packs make up that line,
-- so that receiving can move each pack's location (consumables.packs.location_id) to the destination.
--
-- Lines made before this change, and lines whose packs were typed rather than scanned, have no rows here. Their packs
-- keep the location they were received at.
--
-- `open` mirrors transfer_items.open: it is true from the moment a pack goes on a draft until the receipt is closed (or
-- the draft is cancelled or the line removed). The partial unique index keeps one pack on at most one open transfer,
-- the same rule bottles follow.
-- `received_at` is set when the pack's label is scanned at the receiving store.

create table consumables.transfer_item_packs (
  id uuid primary key default gen_random_uuid(),
  transfer_item_id uuid not null references consumables.transfer_items (id) on delete cascade,
  pack_id uuid not null references consumables.packs (id),
  open boolean not null default true,
  received_at timestamptz,
  created_at timestamptz not null default now(),
  constraint transfer_item_packs_unique unique (transfer_item_id, pack_id)
);
create unique index transfer_item_packs_one_open_idx on consumables.transfer_item_packs (pack_id) where open;
create index transfer_item_packs_item_idx on consumables.transfer_item_packs (transfer_item_id);

alter table consumables.transfer_item_packs enable row level security;
