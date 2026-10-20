-- Phase 1 / M1: core tables.
-- Server-only access (Postgres role / service_role). RLS is enabled everywhere with no policies,
-- so anon and authenticated roles get nothing even if the schema were ever exposed.

-- ---------------------------------------------------------------------------
-- Enums (stable vocabularies). Event types use a CHECK constraint instead,
-- because that list will grow in later phases.
-- ---------------------------------------------------------------------------
create type consumables.location_type as enum ('STORE', 'LAB', 'WARD', 'THEATRE', 'OTHER');
create type consumables.tracking_mode as enum ('SERIAL', 'QUANTITY');
create type consumables.unit_state as enum (
  'IN_STOCK', 'IN_TRANSIT', 'MISSING_IN_TRANSIT', 'ISSUED', 'RETURNED', 'VOIDED', 'WRITTEN_OFF'
);
create type consumables.user_role as enum (
  'STORE_KEEPER', 'DISTRIBUTOR', 'SUPERVISOR', 'AUDITOR', 'ADMIN'
);
create type consumables.batch_source as enum ('PHARMACY_GRN', 'MANUAL');

-- Keeps updated_at honest on mutable tables.
create function consumables.set_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- locations
-- ---------------------------------------------------------------------------
create table consumables.locations (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  type consumables.location_type not null,
  external_system text check (external_system in ('PHARMACY', 'LAB_DESTINATION', 'WARD')),
  external_id text,
  allow_unused_reuse boolean not null default true,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- users: one row per staff member, keyed to Supabase Auth.
-- Passwords live in auth.users, so there is no password_hash column here.
-- ---------------------------------------------------------------------------
create table consumables.users (
  id uuid primary key references auth.users (id) on delete restrict,
  staff_id text not null unique,
  name text not null,
  role consumables.user_role not null,
  home_location_id uuid references consumables.locations (id),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- item_types
-- ---------------------------------------------------------------------------
create table consumables.item_types (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  category text not null,
  tracking_mode consumables.tracking_mode not null,
  container_type text,
  unit_of_measure text not null default 'each',
  reorder_level integer not null default 0 check (reorder_level >= 0),
  pharmacy_catalog_id text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- batches: one delivery of one item type.
-- `code` is the value printed on the batch/box label for QUANTITY items.
-- ---------------------------------------------------------------------------
create table consumables.batches (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  item_type_id uuid not null references consumables.item_types (id),
  lot_no text,
  expiry_date date,
  supplier text,
  quantity integer not null check (quantity > 0),
  source consumables.batch_source not null default 'MANUAL',
  pharmacy_grn_id text,
  pharmacy_batch_id text,
  received_by uuid not null references consumables.users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index batches_item_type_idx on consumables.batches (item_type_id);

-- ---------------------------------------------------------------------------
-- units: one row per physical item, SERIAL items only.
-- current_transfer_id gets its foreign key in Phase 2, when transfers exist.
-- ---------------------------------------------------------------------------
create table consumables.units (
  id uuid primary key default gen_random_uuid(),
  serial text not null unique,
  item_type_id uuid not null references consumables.item_types (id),
  batch_id uuid not null references consumables.batches (id),
  state consumables.unit_state not null default 'IN_STOCK',
  current_location_id uuid not null references consumables.locations (id),
  current_transfer_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index units_state_idx on consumables.units (state);
create index units_location_idx on consumables.units (current_location_id);
create index units_batch_idx on consumables.units (batch_id);

-- ---------------------------------------------------------------------------
-- events: the append-only ledger. `id` is the client-generated UUID, which is what
-- makes offline sync idempotent (a duplicate insert hits the primary key).
-- No updated_at: rows are never changed.
-- ---------------------------------------------------------------------------
create table consumables.events (
  id uuid primary key,
  unit_id uuid references consumables.units (id),
  batch_id uuid references consumables.batches (id),
  quantity integer not null default 1 check (quantity <> 0),
  type text not null check (type in (
    'STOCKED', 'DISPATCHED', 'RECEIVED', 'ISSUED', 'USED', 'RETURNED', 'RETURNED_UNUSED',
    'VOIDED', 'WASTED', 'ADJUSTED', 'MISSING_IN_TRANSIT', 'FOUND', 'WRITTEN_OFF'
  )),
  from_state consumables.unit_state,
  to_state consumables.unit_state,
  location_id uuid not null references consumables.locations (id),
  user_id uuid not null references consumables.users (id),
  transfer_id uuid,
  reference_type text,
  reference_ref text,
  reason_code text,
  note text,
  payload jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null,
  recorded_at timestamptz not null default now(),
  device_id text,
  constraint events_has_subject check (unit_id is not null or batch_id is not null)
);
create index events_unit_idx on consumables.events (unit_id, recorded_at);
create index events_batch_idx on consumables.events (batch_id, recorded_at);
create index events_location_idx on consumables.events (location_id, recorded_at);
create index events_user_idx on consumables.events (user_id, recorded_at);

-- ---------------------------------------------------------------------------
-- void_reasons: controlled list. Application rules rely on these codes, so they ship here.
-- ---------------------------------------------------------------------------
create table consumables.void_reasons (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  label text not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

insert into consumables.void_reasons (code, label) values
  ('BROKEN', 'Broken or damaged'),
  ('CONTAMINATED', 'Contaminated'),
  ('WRONG_TUBE', 'Wrong tube or container type'),
  ('EXPIRED', 'Expired'),
  ('UNUSED', 'Returned unused (reuse not allowed at this location)'),
  ('CANCELLED_INVESTIGATION', 'Investigation cancelled');

-- ---------------------------------------------------------------------------
-- updated_at triggers
-- ---------------------------------------------------------------------------
create trigger locations_updated_at before update on consumables.locations
  for each row execute function consumables.set_updated_at();
create trigger users_updated_at before update on consumables.users
  for each row execute function consumables.set_updated_at();
create trigger item_types_updated_at before update on consumables.item_types
  for each row execute function consumables.set_updated_at();
create trigger batches_updated_at before update on consumables.batches
  for each row execute function consumables.set_updated_at();
create trigger units_updated_at before update on consumables.units
  for each row execute function consumables.set_updated_at();
create trigger void_reasons_updated_at before update on consumables.void_reasons
  for each row execute function consumables.set_updated_at();

-- ---------------------------------------------------------------------------
-- RLS: on, no policies (deny by default for everything except the table owner / service role)
-- ---------------------------------------------------------------------------
alter table consumables.locations enable row level security;
alter table consumables.users enable row level security;
alter table consumables.item_types enable row level security;
alter table consumables.batches enable row level security;
alter table consumables.units enable row level security;
alter table consumables.events enable row level security;
alter table consumables.void_reasons enable row level security;
