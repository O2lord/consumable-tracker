-- Partial send by scanning a pack: a draft line can name the pack its pieces come from.
--
-- A transfer line is still one row per batch, and the batch ledger still moves the stock exactly as before. pack_id only
-- records which scanned pack the pieces were taken from, so that confirming the transfer can lower that pack's
-- pieces_remaining (see 20261015000400_pack_labels.sql). It is null for whole-pack lines, for pieces typed without
-- scanning a pack, and for every line made before this change.

alter table consumables.transfer_items
  add column pack_id uuid references consumables.packs (id);

create index transfer_items_pack_idx on consumables.transfer_items (pack_id) where pack_id is not null;
