-- C7: target stock per location (par levels) and periodic stock counts.
--
-- Bulk items are not scanned at every use, so accountability comes from regular counts compared with what
-- the ledger expects. Rules (the service enforces them; the checks below are the backstop):
--   * A par level is a target (and a minimum) for one item type at one location. It never moves stock.
--   * A count covers batches of QUANTITY items at one location. The attendant enters counted quantities
--     before seeing the expected figure; the expected figure is captured when the count is submitted.
--   * A count is OPEN until it is posted or cancelled. Only one count can be open per location.
--   * Posting writes one ADJUSTED event per line whose counted and expected quantities differ (the event's
--     quantity is the signed variance, which v_quantity_balance already adds). A reason is required then.
-- Same rules as the other tables: server-only access, RLS on with no policies.

create table consumables.par_levels (
  id uuid primary key default gen_random_uuid(),
  location_id uuid not null references consumables.locations (id),
  item_type_id uuid not null references consumables.item_types (id),
  target_quantity integer not null check (target_quantity > 0 and target_quantity <= 1000000),
  -- At or below this the item is flagged as low. 0 means no minimum.
  minimum_quantity integer not null default 0 check (minimum_quantity >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint par_levels_location_item_uq unique (location_id, item_type_id),
  check (minimum_quantity <= target_quantity)
);
create index par_levels_item_idx on consumables.par_levels (item_type_id);
create trigger par_levels_updated_at before update on consumables.par_levels
  for each row execute function consumables.set_updated_at();

create table consumables.stock_counts (
  id uuid primary key default gen_random_uuid(),
  location_id uuid not null references consumables.locations (id),
  status text not null default 'OPEN' check (status in ('OPEN', 'POSTED', 'CANCELLED')),
  counted_by uuid not null references consumables.users (id),
  counted_at timestamptz not null default now(),
  note text,
  posted_by uuid references consumables.users (id),
  posted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (status <> 'POSTED' or (posted_by is not null and posted_at is not null))
);
create index stock_counts_location_idx on consumables.stock_counts (location_id, counted_at desc);
-- One open count per location, so two people cannot post competing adjustments.
create unique index stock_counts_one_open_per_location on consumables.stock_counts (location_id) where status = 'OPEN';
create trigger stock_counts_updated_at before update on consumables.stock_counts
  for each row execute function consumables.set_updated_at();

create table consumables.stock_count_lines (
  id uuid primary key default gen_random_uuid(),
  count_id uuid not null references consumables.stock_counts (id) on delete restrict,
  batch_id uuid not null references consumables.batches (id),
  counted_quantity integer not null check (counted_quantity >= 0 and counted_quantity <= 10000000),
  -- The ledger balance when the count was submitted (refreshed at posting if stock moved).
  expected_quantity integer not null,
  -- Why the count differs. Required at posting when counted and expected differ.
  reason_code text,
  note text,
  -- The ADJUSTED event this line posted. Null until posted, and for lines with no variance.
  adjustment_event_id uuid references consumables.events (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint stock_count_lines_batch_uq unique (count_id, batch_id)
);
create index stock_count_lines_count_idx on consumables.stock_count_lines (count_id);
create index stock_count_lines_batch_idx on consumables.stock_count_lines (batch_id);
create trigger stock_count_lines_updated_at before update on consumables.stock_count_lines
  for each row execute function consumables.set_updated_at();

alter table consumables.par_levels enable row level security;
alter table consumables.stock_counts enable row level security;
alter table consumables.stock_count_lines enable row level security;

-- Two new permissions, chosen per role on Admin > Roles like every other one.
--   count_stock        enter and post stock counts at the person's own location
--   manage_par_levels  set target and minimum stock per location
-- The built-in roles that already run stock get them; custom roles do not until an admin ticks them.
-- ADMIN is locked (its permissions come from the code); it is updated so the stored row matches.
-- Safe to run again.
update consumables.roles
set permissions = array_append(permissions, 'count_stock')
where code in ('STORE_KEEPER', 'DISTRIBUTOR', 'SUPERVISOR', 'ADMIN')
  and not ('count_stock' = any (permissions));

update consumables.roles
set permissions = array_append(permissions, 'manage_par_levels')
where code in ('SUPERVISOR', 'ADMIN')
  and not ('manage_par_levels' = any (permissions));
