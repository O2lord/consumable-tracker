-- RESET TEST DATA. Run by hand, once, BEFORE real patient data goes in. Never as a migration.
--
-- What it clears (everything created by using the app):
--   events (the ledger), links, units, batches, deliveries, packs (pack labels),
--   transfers + items + batch parts + item packs, stock requests + lines, stock counts + lines,
--   investigation_imports, pharmacy_imports, pharmacy_reconcile_runs, sync_log.
-- What it keeps (setup you entered through the admin screens):
--   users, roles, locations, item_types, void_reasons, test_catalog, test_standard_items, issue_policies,
--   par_levels, app_meta.
--
-- Keep this list in step with the migrations: when a new migration adds a table that holds data created by
-- using the app (not setup), add it to the preview and the truncate below. If a table that points at one of
-- these is missed, the truncate refuses (no CASCADE) and the whole reset rolls back.
--
-- Why everything together: units, batches and transfers are tied to the ledger by their events. Clearing the
-- ledger alone would leave stock that no event explains, and the reconciliation report would show it all as
-- unaccounted. After this, stock starts again from a fresh receive/GRN.
--
-- Why this is needed at all: the ledger rejects UPDATE, DELETE and TRUNCATE (20261006000200_events_append_only.sql),
-- and older ISSUED events may still hold an MRN, collector name or override reason in their payload from before
-- those were taken out. They cannot be edited, so for test data the only clean fix is to clear the table.
-- The script turns the truncate guard off for this one transaction and turns it back on before it ends.
-- REAL data must never be cleared this way: a correction there is a new event.
--
-- How to run: Supabase dashboard > SQL editor (or psql as the postgres role). Take a backup first
-- (Project Settings > Database > Backups) if there is any chance something here is still wanted.
--
-- Safety: it does nothing until you change 'no' to 'yes' on the line below. If any step fails, the whole
-- thing rolls back and nothing is changed (including the trigger).

begin;

select set_config('app.confirm_reset', 'no', true);   -- <- change 'no' to 'yes' to allow the reset

do $$
begin
  if current_setting('app.confirm_reset', true) is distinct from 'yes' then
    raise exception 'Reset not confirmed. Edit the set_config line to say ''yes'' if you really mean it.';
  end if;
end $$;

-- What is about to go (so the numbers can be checked against what you expect).
select 'events' as tbl, count(*) from consumables.events
union all select 'links', count(*) from consumables.links
union all select 'units', count(*) from consumables.units
union all select 'batches', count(*) from consumables.batches
union all select 'transfers', count(*) from consumables.transfers
union all select 'stock_requests', count(*) from consumables.stock_requests
union all select 'investigation_imports', count(*) from consumables.investigation_imports
union all select 'pharmacy_imports', count(*) from consumables.pharmacy_imports
union all select 'pharmacy_reconcile_runs', count(*) from consumables.pharmacy_reconcile_runs
union all select 'deliveries', count(*) from consumables.deliveries
union all select 'packs', count(*) from consumables.packs
union all select 'transfer_item_packs', count(*) from consumables.transfer_item_packs
union all select 'stock_counts', count(*) from consumables.stock_counts
union all select 'stock_count_lines', count(*) from consumables.stock_count_lines
union all select 'sync_log', count(*) from consumables.sync_log;

alter table consumables.events disable trigger events_no_truncate;

-- One statement, no CASCADE: if a table we are keeping points at one of these, Postgres refuses and
-- the transaction rolls back, instead of silently deleting setup data.
truncate table
  consumables.events,
  consumables.links,
  consumables.units,
  consumables.transfer_batch_parts,
  consumables.transfer_items,
  consumables.transfers,
  consumables.batches,
  consumables.deliveries,
  consumables.packs,
  consumables.transfer_item_packs,
  consumables.stock_count_lines,
  consumables.stock_counts,
  consumables.stock_request_lines,
  consumables.stock_requests,
  consumables.investigation_imports,
  consumables.pharmacy_imports,
  consumables.pharmacy_reconcile_runs,
  consumables.sync_log;

alter table consumables.events enable trigger events_no_truncate;

-- The guard must be back on before we commit. Fails the whole reset if it is not.
do $$
begin
  if (select tgenabled from pg_trigger
      where tgname = 'events_no_truncate' and tgrelid = 'consumables.events'::regclass) <> 'O' then
    raise exception 'events_no_truncate is not enabled again; rolling back.';
  end if;
end $$;

commit;

-- Afterwards: everything above should read 0, and the kept tables should be unchanged.
-- select count(*) from consumables.events;
-- select count(*) from consumables.locations;
-- select count(*) from consumables.par_levels;
-- select count(*) from consumables.test_standard_items;
