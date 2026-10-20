-- C9 (parked item, build-now part): standard consumption per test.
--
-- Each test in the catalog can list the bulk items one run of it normally uses, with a quantity per test.
-- At the point of issue the person picks a test and a number of tests, the screen pre-fills those items
-- (quantity per test x number of tests), and they can change a quantity, remove a line or add another item
-- before confirming. What they confirm is what leaves stock; this table never moves stock by itself.
--
-- The quantities are the lab's to correct. Until they have confirmed a test's list, it is flagged
-- "Unconfirmed" on the Test catalog screen. The flag is display only and blocks nothing.
--
-- Only QUANTITY items (reagents, kits, strips) can be listed. A serialized bottle or tube is still scanned
-- and issued on its own, because the ledger needs to know which one it was (the service enforces this).
-- Same rules as the other tables: server-only access, RLS on with no policies.

create table consumables.test_standard_items (
  id uuid primary key default gen_random_uuid(),
  test_id uuid not null references consumables.test_catalog (id) on delete cascade,
  item_type_id uuid not null references consumables.item_types (id),
  -- How much one run of the test uses, in the item's stock unit.
  quantity integer not null check (quantity > 0 and quantity <= 100000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint test_standard_items_test_item_uq unique (test_id, item_type_id)
);
create index test_standard_items_item_idx on consumables.test_standard_items (item_type_id);
create trigger test_standard_items_updated_at before update on consumables.test_standard_items
  for each row execute function consumables.set_updated_at();

alter table consumables.test_standard_items enable row level security;

-- True once the lab has confirmed this test's list of items and quantities. Display only.
-- A test with no items listed has nothing to confirm, so the screen leaves it out of the count.
alter table consumables.test_catalog
  add column consumption_confirmed boolean not null default false;
