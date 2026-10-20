-- Phase 6/7 bridge: receiving stock from an imported Pharmacy GRN line.
--
-- A batch received from a GRN line stores the GRN number in pharmacy_grn_id and the Pharmacy batch
-- number in both pharmacy_batch_id and lot_no (the Pharmacy mismatch view matches on lot_no).
-- The same GRN line must never create two batches, even when two people press the button together,
-- so this is enforced here as well as in the service. The batch number is compared normalised,
-- like everywhere else ("Bat-342" and "BAT 342" are one batch).
create unique index batches_pharmacy_line_uq
  on consumables.batches (upper(pharmacy_grn_id), consumables.norm_text(pharmacy_batch_id), item_type_id)
  where pharmacy_grn_id is not null;
