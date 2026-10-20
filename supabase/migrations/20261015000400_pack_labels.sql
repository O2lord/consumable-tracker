-- Pack labels: a barcode on every pack or roll that is received.
--
-- Packs and rolls stay QUANTITY items. The batch ledger (v_quantity_balance, v_loose_pieces) is still the only
-- authority on how much stock a location holds, and nothing that reads it changes. This table only adds an
-- identity to each physical pack, so a label can be stuck on it and scanned later.
--
-- Why a table of its own and not `units`: `units` means "a serialized bottle" all over the app (issue, transfer,
-- receive, return, stock and reports all treat a unit as something that moves between states), and the batch views
-- ignore every event that has a unit_id. A pack in `units` would be picked up by those screens as a bottle, and a
-- pack event with a unit_id would drop out of the batch balance. Here nothing reads these rows except the code that
-- prints and scans pack labels.
--
-- pieces_per_pack is the item's pack size when the pack was received (1 for a roll or a pack with no size set), and
-- pieces_remaining starts at the same number. Sending part of a pack will lower pieces_remaining; it never goes below
-- zero or above what the pack held. The ledger still carries the movement itself (an event with `pieces`), and names
-- the pack in the event payload.
--
-- location_id is where the pack was received. It is not kept in step with transfers yet; the step that sends packs by
-- scanning them will keep it current.
--
-- Existing batches get no pack rows: stock received before this change keeps its single batch label.

create table consumables.packs (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  batch_id uuid not null references consumables.batches (id),
  item_type_id uuid not null references consumables.item_types (id),
  location_id uuid not null references consumables.locations (id),
  pieces_per_pack integer not null check (pieces_per_pack >= 1),
  pieces_remaining integer not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint packs_pieces_remaining_range check (pieces_remaining >= 0 and pieces_remaining <= pieces_per_pack)
);
create index packs_batch_idx on consumables.packs (batch_id);
create index packs_location_idx on consumables.packs (location_id);

create trigger packs_updated_at before update on consumables.packs
  for each row execute function consumables.set_updated_at();

-- Same as every other table: RLS on, no policies (server-only access).
alter table consumables.packs enable row level security;
