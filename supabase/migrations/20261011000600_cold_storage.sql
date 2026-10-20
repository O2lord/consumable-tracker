-- Fit to the hospital's consumables list (corrections.md, C9): a cold-storage flag on item types.
--
-- Display only. It marks items that must be kept in the fridge so a "Keep cold" tag shows on the admin
-- Item types screen, on Stock here, on the transfer page and on the receive screen. Nothing is blocked or
-- measured (no temperatures, no alerts): whether the tracker should do more is for the blood bank to say.
--
-- Every item starts as not cold (false). The anti-sera and AHG are fridge reagents, so the items already
-- seeded from the hospital's list are flagged once here; the seed script sets the same flag on a fresh
-- database. Test kits and strips are left unflagged because the storage condition depends on the maker:
-- tick "Needs cold storage" on the item type if the lab says so.

alter table consumables.item_types
  add column cold_storage boolean not null default false;

update consumables.item_types
  set cold_storage = true
  where code in ('ANTI-A', 'ANTI-B', 'ANTI-D', 'AHG');
