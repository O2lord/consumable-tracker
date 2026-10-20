-- Phase 3 / M3: issue, return and void.
-- Adds the test catalog, issue policies and the `links` table that ties an item to what it was
-- used for, and teaches v_quantity_balance about issue, return and wastage events.
-- Same rules as before: server-only access, RLS on with no policies.

-- ---------------------------------------------------------------------------
-- test_catalog: local copy of tests and the container each one needs. Entered through the admin
-- screen now, later synced from the EMR (Phase 8).
-- ---------------------------------------------------------------------------
create table consumables.test_catalog (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  required_container_type text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- issue_policies: whether payment or a charge is needed before issuing.
--   MUST_BE_PAID         block when the reference is known to be unpaid; record UNVERIFIED when
--                        payment cannot be checked (never silently passed)
--   CHARGE_TO_ADMISSION  inpatient: no prepayment, the charge goes to the admission bill
--   NONE                 no check
-- patient_type 'ANY' is the fallback for a reference type.
-- ---------------------------------------------------------------------------
create table consumables.issue_policies (
  id uuid primary key default gen_random_uuid(),
  reference_type text not null check (reference_type in (
    'INVESTIGATION', 'ADMISSION', 'VISIT', 'PROCEDURE', 'SURGERY', 'DEPARTMENT'
  )),
  patient_type text not null check (patient_type in ('OUTPATIENT', 'INPATIENT', 'WALK_IN', 'ANY')),
  rule text not null check (rule in ('MUST_BE_PAID', 'CHARGE_TO_ADMISSION', 'NONE')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint issue_policies_unique unique (reference_type, patient_type)
);

insert into consumables.issue_policies (reference_type, patient_type, rule) values
  ('INVESTIGATION', 'OUTPATIENT', 'MUST_BE_PAID'),
  ('INVESTIGATION', 'WALK_IN', 'MUST_BE_PAID'),
  ('INVESTIGATION', 'INPATIENT', 'CHARGE_TO_ADMISSION'),
  ('ADMISSION', 'ANY', 'CHARGE_TO_ADMISSION'),
  ('VISIT', 'ANY', 'NONE'),
  ('PROCEDURE', 'ANY', 'NONE'),
  ('SURGERY', 'ANY', 'NONE'),
  ('DEPARTMENT', 'ANY', 'NONE');

-- ---------------------------------------------------------------------------
-- links: many-to-many between an item and what it was used for. One bottle can serve several
-- investigations of the same patient (several rows for one unit_id), and one investigation can
-- use several bottles. Returning a unit unused sets cleared_at; history is never deleted.
--   unit_id is null for QUANTITY items (batch_id and quantity say what was issued).
--   issue_event_id points at the ISSUED ledger event that created the link.
--   override_*: set when a supervisor overrode a block (container mismatch, unpaid), and reported.
-- ---------------------------------------------------------------------------
create table consumables.links (
  id uuid primary key default gen_random_uuid(),
  unit_id uuid references consumables.units (id),
  batch_id uuid not null references consumables.batches (id),
  quantity integer not null default 1 check (quantity > 0),
  reference_type text not null check (reference_type in (
    'INVESTIGATION', 'ADMISSION', 'VISIT', 'PROCEDURE', 'SURGERY', 'DEPARTMENT'
  )),
  reference_ref text not null,
  reference_source text not null default 'manual'
    check (reference_source in ('manual', 'slip_scan', 'csv', 'emr')),
  test_code text,
  patient_hospital_no text,
  patient_type text check (patient_type in ('OUTPATIENT', 'INPATIENT', 'WALK_IN')),
  payment_check text not null check (payment_check in ('VERIFIED', 'UNVERIFIED', 'NOT_REQUIRED')),
  issue_event_id uuid not null references consumables.events (id),
  issued_by uuid not null references consumables.users (id),
  location_id uuid not null references consumables.locations (id),
  collector_type text check (collector_type in ('PATIENT', 'NURSE', 'PORTER', 'OTHER')),
  collector_name text,
  override_by uuid references consumables.users (id),
  override_reason text,
  cleared_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint links_serial_is_one check (unit_id is null or quantity = 1),
  constraint links_override_pair check ((override_by is null) = (override_reason is null))
);
create unique index links_unit_reference_active_uq
  on consumables.links (unit_id, reference_type, reference_ref)
  where cleared_at is null and unit_id is not null;
create index links_unit_idx on consumables.links (unit_id) where unit_id is not null;
create index links_reference_idx on consumables.links (reference_type, reference_ref);
create index links_patient_idx on consumables.links (patient_hospital_no) where patient_hospital_no is not null;
create index links_batch_idx on consumables.links (batch_id);

-- ---------------------------------------------------------------------------
-- updated_at triggers and RLS
-- ---------------------------------------------------------------------------
create trigger test_catalog_updated_at before update on consumables.test_catalog
  for each row execute function consumables.set_updated_at();
create trigger issue_policies_updated_at before update on consumables.issue_policies
  for each row execute function consumables.set_updated_at();
create trigger links_updated_at before update on consumables.links
  for each row execute function consumables.set_updated_at();

alter table consumables.test_catalog enable row level security;
alter table consumables.issue_policies enable row level security;
alter table consumables.links enable row level security;

-- ---------------------------------------------------------------------------
-- v_quantity_balance, now with issue, return and wastage (replaces the Phase 2 version).
--   ISSUED           leaves the location's shelf
--   RETURNED_UNUSED  goes back on the shelf
--   WASTED           payload.source = 'RETURN': the quantity already left the shelf when it was
--                    issued, so no change; any other source (a shelf void) removes it now
--   USED             no change (it was counted out at issue)
-- Same columns as before, so `create or replace` is allowed.
-- ---------------------------------------------------------------------------
create or replace view consumables.v_quantity_balance with (security_invoker = true) as
select
  e.batch_id,
  b.code as batch_code,
  it.id as item_type_id,
  it.name as item_name,
  e.location_id,
  sum(
    case
      when e.type = 'STOCKED' then e.quantity
      when e.type = 'RECEIVED' then e.quantity
      when e.type = 'FOUND' then e.quantity
      when e.type = 'DISPATCHED' then -e.quantity
      when e.type = 'ADJUSTED' then e.quantity
      when e.type = 'ISSUED' then -e.quantity
      when e.type = 'RETURNED_UNUSED' then e.quantity
      when e.type = 'WASTED' and coalesce(e.payload ->> 'source', '') <> 'RETURN' then -e.quantity
      else 0
    end
  )::int as on_hand
from consumables.events e
join consumables.batches b on b.id = e.batch_id
join consumables.item_types it on it.id = b.item_type_id
where e.unit_id is null and e.batch_id is not null
group by e.batch_id, b.code, it.id, it.name, e.location_id;

-- ---------------------------------------------------------------------------
-- v_quantity_issued_outstanding: quantity issued from a location and not yet returned or written
-- off through the return flow. A return can never exceed this.
-- ---------------------------------------------------------------------------
create view consumables.v_quantity_issued_outstanding with (security_invoker = true) as
select
  e.batch_id,
  e.location_id,
  sum(
    case
      when e.type = 'ISSUED' then e.quantity
      when e.type = 'RETURNED_UNUSED' then -e.quantity
      when e.type = 'WASTED' and e.payload ->> 'source' = 'RETURN' then -e.quantity
      else 0
    end
  )::int as outstanding
from consumables.events e
where e.unit_id is null and e.batch_id is not null
group by e.batch_id, e.location_id;
