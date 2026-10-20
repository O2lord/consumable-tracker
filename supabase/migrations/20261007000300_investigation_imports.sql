-- Phase 6 / M6 (first slice): investigation imports, the import log and the orphan-issue check.
-- Same rules as before: server-only access, RLS on with no policies.
--
-- The tracker defines the import standard (architecture section 9); the EMR exports to fit it.
-- Rows are upserted by investigation number, so a status change in a later export updates the row.
-- Nothing is ever deleted by an import. The original row is kept in `raw`.

-- ---------------------------------------------------------------------------
-- sync_log: one row per import (and later per EMR sync).
-- ---------------------------------------------------------------------------
create table consumables.sync_log (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('INVESTIGATIONS')),
  source text not null default 'FILE' check (source in ('FILE', 'API')),
  file_name text,
  detail jsonb not null default '{}'::jsonb,
  rows_total integer not null default 0,
  rows_inserted integer not null default 0,
  rows_updated integer not null default 0,
  rows_rejected integer not null default 0,
  -- First rejected rows only ({row, message}); the full list is not kept.
  errors jsonb not null default '[]'::jsonb,
  imported_by uuid references consumables.users (id),
  started_at timestamptz not null default now(),
  finished_at timestamptz
);
create index sync_log_started_idx on consumables.sync_log (started_at desc);

-- ---------------------------------------------------------------------------
-- investigation_imports: one row per investigation (one per test).
--   queue           LAB, IMAGING or OTHER: investigation numbers are one sequence across all of them
--   test_code       optional; matching to the test catalog falls back to test_name
--   patient_type    null when the export does not say
--   payment_status  null when the export does not say. Never inferred from an amount.
-- ---------------------------------------------------------------------------
create table consumables.investigation_imports (
  id uuid primary key default gen_random_uuid(),
  investigation_ref text not null unique,
  patient_hospital_no text not null,
  queue text not null default 'LAB' check (queue in ('LAB', 'IMAGING', 'OTHER')),
  test_code text,
  test_name text not null,
  patient_type text check (patient_type in ('OUTPATIENT', 'INPATIENT', 'WALK_IN')),
  payment_status text check (payment_status in ('PAID', 'UNPAID', 'CHARGED_TO_ADMISSION')),
  destination text,
  status text,
  amount numeric(14, 2),
  raised_at timestamptz,
  raw jsonb not null default '{}'::jsonb,
  sync_log_id uuid references consumables.sync_log (id),
  imported_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index investigation_imports_patient_idx on consumables.investigation_imports (patient_hospital_no);
create index investigation_imports_status_idx on consumables.investigation_imports (status);

create trigger investigation_imports_updated_at before update on consumables.investigation_imports
  for each row execute function consumables.set_updated_at();

alter table consumables.sync_log enable row level security;
alter table consumables.investigation_imports enable row level security;

-- ---------------------------------------------------------------------------
-- v_orphan_issues: links against an investigation that the imports do not back.
--   NOT_IN_IMPORT  the number is not in any import (a typo, a phantom investigation, or the import
--                  is stale: the report page says when the last import ran)
--   MRN_MISMATCH   the number exists, but for a different patient than the link recorded
-- Cleared links (a bottle returned unused) stay listed: it was still issued against that number.
-- ---------------------------------------------------------------------------
create view consumables.v_orphan_issues with (security_invoker = true) as
select
  l.id as link_id,
  l.reference_ref,
  l.test_code,
  l.patient_hospital_no,
  case when ii.id is null then 'NOT_IN_IMPORT' else 'MRN_MISMATCH' end as problem,
  ii.patient_hospital_no as imported_patient_hospital_no,
  coalesce(u.serial, b.code) as item_ref,
  it.name as item_name,
  loc.name as location_name,
  usr.name as issued_by_name,
  l.created_at as issued_at,
  l.cleared_at
from consumables.links l
left join consumables.investigation_imports ii on ii.investigation_ref = upper(l.reference_ref)
join consumables.batches b on b.id = l.batch_id
join consumables.item_types it on it.id = b.item_type_id
left join consumables.units u on u.id = l.unit_id
join consumables.locations loc on loc.id = l.location_id
join consumables.users usr on usr.id = l.issued_by
where l.reference_type = 'INVESTIGATION'
  and (
    ii.id is null
    or (
      l.patient_hospital_no is not null
      and upper(replace(ii.patient_hospital_no, ' ', '')) <> upper(replace(l.patient_hospital_no, ' ', ''))
    )
  );
