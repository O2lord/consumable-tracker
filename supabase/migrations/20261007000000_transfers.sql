-- Phase 2 / M2: transfers (dispatch and receive), discrepancy tracking, reporting views.
-- Same rules as before: server-only access, RLS on with no policies.

-- ---------------------------------------------------------------------------
-- transfers: one movement of stock between two locations. `code` is printed on the slip.
-- Status is text with a CHECK (not an enum) so it can grow in later phases.
--   DRAFT                      being built by the store keeper; nothing has left the store yet
--   DISPATCHED                 confirmed; SERIAL units are IN_TRANSIT
--   RECEIVING                  receipt opened at the destination
--   RECEIVED                   receipt closed, everything accounted for
--   RECEIVED_WITH_DISCREPANCY  receipt closed with unscanned units or a quantity shortfall
--   DISCREPANCY_RESOLVED       every missing item has been resolved by a supervisor
--   CANCELLED                  draft abandoned
-- ---------------------------------------------------------------------------
create table consumables.transfers (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  from_location_id uuid not null references consumables.locations (id),
  to_location_id uuid not null references consumables.locations (id),
  status text not null default 'DRAFT' check (status in (
    'DRAFT', 'DISPATCHED', 'RECEIVING', 'RECEIVED',
    'RECEIVED_WITH_DISCREPANCY', 'DISCREPANCY_RESOLVED', 'CANCELLED'
  )),
  -- Manual link to the matching Pharmacy transfer until the API integration (Phase 7).
  pharmacy_transfer_id text,
  pharmacy_quantity integer check (pharmacy_quantity is null or pharmacy_quantity >= 0),
  pharmacy_sync_status text,
  -- Required at confirm time when the scanned total differs from pharmacy_quantity.
  quantity_mismatch_note text,
  note text,
  created_by uuid not null references consumables.users (id),
  dispatched_by uuid references consumables.users (id),
  dispatched_at timestamptz,
  receipt_started_by uuid references consumables.users (id),
  receipt_started_at timestamptz,
  receipt_closed_by uuid references consumables.users (id),
  receipt_closed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint transfers_different_locations check (from_location_id <> to_location_id),
  constraint transfers_pharmacy_pair check ((pharmacy_transfer_id is null) = (pharmacy_quantity is null))
);
create index transfers_status_idx on consumables.transfers (status);
create index transfers_from_idx on consumables.transfers (from_location_id);
create index transfers_to_idx on consumables.transfers (to_location_id);

-- ---------------------------------------------------------------------------
-- transfer_items: what is on a transfer. Either one serialized unit (unit_id) or a quantity of
-- one batch (batch_id), never both.
--   open: true while the transfer is DRAFT, DISPATCHED or RECEIVING. The services set it false
--         when the receipt closes or the draft is cancelled. It backs the rule "one serialized
--         unit on at most one open transfer" (a partial unique index cannot look at transfers.status).
--   quantity_missing / quantity_found / quantity_written_off: set when the receipt closes (and as a
--         supervisor resolves). A serialized unit is 1 missing, then 1 found or 1 written off.
-- ---------------------------------------------------------------------------
create table consumables.transfer_items (
  id uuid primary key default gen_random_uuid(),
  transfer_id uuid not null references consumables.transfers (id) on delete restrict,
  unit_id uuid references consumables.units (id),
  batch_id uuid references consumables.batches (id),
  quantity_dispatched integer not null default 1 check (quantity_dispatched > 0),
  quantity_received integer check (quantity_received is null or quantity_received >= 0),
  received_at timestamptz,
  received_by uuid references consumables.users (id),
  quantity_missing integer not null default 0 check (quantity_missing >= 0),
  quantity_found integer not null default 0 check (quantity_found >= 0),
  quantity_written_off integer not null default 0 check (quantity_written_off >= 0),
  resolution text check (resolution in ('FOUND', 'WRITTEN_OFF', 'SPLIT')),
  resolved_by uuid references consumables.users (id),
  resolved_at timestamptz,
  resolution_note text,
  open boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint transfer_items_one_subject check ((unit_id is null) <> (batch_id is null)),
  constraint transfer_items_serial_is_one check (unit_id is null or quantity_dispatched = 1),
  constraint transfer_items_resolved_within_missing
    check (quantity_found + quantity_written_off <= quantity_missing)
);
create unique index transfer_items_unit_uq
  on consumables.transfer_items (transfer_id, unit_id) where unit_id is not null;
create unique index transfer_items_batch_uq
  on consumables.transfer_items (transfer_id, batch_id) where batch_id is not null;
create unique index transfer_items_one_open_transfer_per_unit
  on consumables.transfer_items (unit_id) where open and unit_id is not null;
create index transfer_items_transfer_idx on consumables.transfer_items (transfer_id);

-- ---------------------------------------------------------------------------
-- Foreign keys that waited for this table (Phase 1 left them as plain uuid columns).
-- ---------------------------------------------------------------------------
alter table consumables.units
  add constraint units_current_transfer_fk
  foreign key (current_transfer_id) references consumables.transfers (id);

alter table consumables.events
  add constraint events_transfer_fk
  foreign key (transfer_id) references consumables.transfers (id);

create index events_transfer_idx on consumables.events (transfer_id, recorded_at)
  where transfer_id is not null;

-- ---------------------------------------------------------------------------
-- updated_at triggers and RLS
-- ---------------------------------------------------------------------------
create trigger transfers_updated_at before update on consumables.transfers
  for each row execute function consumables.set_updated_at();
create trigger transfer_items_updated_at before update on consumables.transfer_items
  for each row execute function consumables.set_updated_at();

alter table consumables.transfers enable row level security;
alter table consumables.transfer_items enable row level security;

-- ---------------------------------------------------------------------------
-- v_quantity_balance: on-hand quantity per batch per location, derived from the ledger.
-- Only QUANTITY movements count (events with no unit). The event's location_id is where the
-- movement happened: DISPATCHED at the sending location, RECEIVED and FOUND at the destination.
-- MISSING_IN_TRANSIT and WRITTEN_OFF do not change any location's balance: the quantity already
-- left the sender at dispatch and never arrived.
-- Phase 3 replaces this view to add issue, return and wastage events.
-- ---------------------------------------------------------------------------
create view consumables.v_quantity_balance with (security_invoker = true) as
select
  e.batch_id,
  b.code as batch_code,
  it.id as item_type_id,
  it.name as item_name,
  e.location_id,
  sum(
    case e.type
      when 'STOCKED' then e.quantity
      when 'RECEIVED' then e.quantity
      when 'FOUND' then e.quantity
      when 'DISPATCHED' then -e.quantity
      when 'ADJUSTED' then e.quantity
      else 0
    end
  )::int as on_hand
from consumables.events e
join consumables.batches b on b.id = e.batch_id
join consumables.item_types it on it.id = b.item_type_id
where e.unit_id is null and e.batch_id is not null
group by e.batch_id, b.code, it.id, it.name, e.location_id;

-- ---------------------------------------------------------------------------
-- v_open_discrepancies: transfers closed with unscanned units or quantity shortfalls, listing the
-- exact serial or batch and how much is still unresolved.
-- ---------------------------------------------------------------------------
create view consumables.v_open_discrepancies with (security_invoker = true) as
select
  ti.id as transfer_item_id,
  t.id as transfer_id,
  t.code as transfer_code,
  t.status as transfer_status,
  t.from_location_id,
  lf.name as from_location_name,
  t.to_location_id,
  lt.name as to_location_name,
  t.receipt_closed_at,
  ti.unit_id,
  u.serial,
  u.state as unit_state,
  b.id as batch_id,
  b.code as batch_code,
  it.name as item_name,
  ti.quantity_dispatched,
  coalesce(ti.quantity_received, 0) as quantity_received,
  ti.quantity_missing,
  ti.quantity_found,
  ti.quantity_written_off,
  ti.quantity_missing - ti.quantity_found - ti.quantity_written_off as quantity_outstanding
from consumables.transfer_items ti
join consumables.transfers t on t.id = ti.transfer_id
join consumables.locations lf on lf.id = t.from_location_id
join consumables.locations lt on lt.id = t.to_location_id
left join consumables.units u on u.id = ti.unit_id
join consumables.batches b on b.id = coalesce(ti.batch_id, u.batch_id)
join consumables.item_types it on it.id = b.item_type_id
where ti.quantity_missing > ti.quantity_found + ti.quantity_written_off;
