-- Phase 7: a log of Pharmacy reconcile runs.
--
-- A run snapshots the two Pharmacy comparisons (stock per location and batch, and transfer totals) so the
-- count of problems can be followed over time, and so "shadow mode" has something to read: mismatches are
-- recorded without blocking anyone. Runs come from the daily job (POST /api/pharmacy/sync with the shared
-- secret) or from a person pressing the button on the Pharmacy report. Same rules as before: server-only
-- access, RLS on with no policies.
create table consumables.pharmacy_reconcile_runs (
  id uuid primary key default gen_random_uuid(),
  triggered_by text not null check (triggered_by in ('JOB', 'USER')),
  -- Which Pharmacy provider the run compared against (csv: the imported exports).
  provider text not null check (provider in ('manual', 'csv', 'emr')),
  run_by uuid references consumables.users (id),
  -- Problem counts by kind, as returned by the reconcile summary.
  summary jsonb not null default '{}'::jsonb,
  problems_total integer not null default 0,
  -- How old the data compared against was; a run on stale exports proves little.
  inventory_imported_at timestamptz,
  transfers_imported_at timestamptz,
  started_at timestamptz not null default now(),
  finished_at timestamptz
);
create index pharmacy_reconcile_runs_started_idx on consumables.pharmacy_reconcile_runs (started_at desc);

alter table consumables.pharmacy_reconcile_runs enable row level security;
