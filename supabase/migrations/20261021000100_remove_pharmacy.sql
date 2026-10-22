-- Remove everything to do with Pharmacy.
--
-- The tracker no longer reads, imports, reconciles against or links to the EMR's Pharmacy module. The earlier
-- migrations are left as they were (they are already applied); this one undoes what they added.
--
-- What it drops:
--   views    v_pharmacy_mismatch, v_pharmacy_transfer_check
--   tables   pharmacy_reconcile_runs, pharmacy_imports (and the Pharmacy rows in sync_log)
--   columns  transfers.pharmacy_transfer_id / pharmacy_quantity / pharmacy_sync_status / quantity_mismatch_note,
--            batches.pharmacy_grn_id / pharmacy_batch_id, item_types.pharmacy_catalog_id
--   values   batch_source 'PHARMACY_GRN', locations.external_system 'PHARMACY', sync_log.kind 'PHARMACY_*'
--
-- Data this deletes: every Pharmacy import row and reconcile run, and the Pharmacy link on any transfer, batch or
-- item type. Batches received from a GRN line stay, as MANUAL batches. Locations mapped to 'PHARMACY' stay, with
-- no EMR mapping. Take a backup first if any of it might still be wanted.

-- Views first: they read pharmacy_imports and transfers.pharmacy_transfer_id.
drop view if exists consumables.v_pharmacy_transfer_check;
drop view if exists consumables.v_pharmacy_mismatch;

-- Tables. pharmacy_imports points at sync_log, so it goes before the sync_log rows do.
drop table if exists consumables.pharmacy_reconcile_runs;
drop table if exists consumables.pharmacy_imports;

-- sync_log: forget the Pharmacy imports and allow only INVESTIGATIONS again.
delete from consumables.sync_log where kind in ('PHARMACY_INVENTORY', 'PHARMACY_GRN', 'PHARMACY_TRANSFERS');
alter table consumables.sync_log drop constraint if exists sync_log_kind_check;
alter table consumables.sync_log add constraint sync_log_kind_check
  check (kind in ('INVESTIGATIONS'));

-- transfers: the link to a Pharmacy transfer and the note explaining a quantity difference against it.
alter table consumables.transfers drop constraint if exists transfers_pharmacy_pair;
alter table consumables.transfers
  drop column if exists pharmacy_transfer_id,
  drop column if exists pharmacy_quantity,
  drop column if exists pharmacy_sync_status,
  drop column if exists quantity_mismatch_note;

-- batches: the GRN link, then the 'PHARMACY_GRN' source value. Postgres cannot remove a value from an enum, so
-- the type is replaced.
drop index if exists consumables.batches_pharmacy_line_uq;
alter table consumables.batches
  drop column if exists pharmacy_grn_id,
  drop column if exists pharmacy_batch_id;

update consumables.batches set source = 'MANUAL' where source::text = 'PHARMACY_GRN';

alter type consumables.batch_source rename to batch_source_old;
create type consumables.batch_source as enum ('MANUAL');
alter table consumables.batches alter column source drop default;
alter table consumables.batches
  alter column source type consumables.batch_source using source::text::consumables.batch_source;
alter table consumables.batches alter column source set default 'MANUAL';
drop type consumables.batch_source_old;

-- item_types: the Pharmacy catalog link.
alter table consumables.item_types drop column if exists pharmacy_catalog_id;

-- locations: no 'PHARMACY' mapping any more.
update consumables.locations
set external_system = null, external_id = null
where external_system = 'PHARMACY';

alter table consumables.locations drop constraint if exists locations_external_system_check;
alter table consumables.locations add constraint locations_external_system_check
  check (external_system in ('LAB_DESTINATION', 'WARD'));
