-- Bench supplies: a flag on item types for shared supplies that are not used up one test or one patient at a time.
--
-- Cotton wool (a roll), gloves, markers, sample stickers and the like serve many patients. They are sent to the
-- lab with a transfer and counted down in stock counts. They are not listed against a test, offered in the
-- extension's "items used" list, or issued on the Issue for test screen, so they are never tied to one patient.
--
-- The flag blocks nothing on stock: transfers, receiving, issuing in bulk and counting work as before.
--
-- The items below are flagged once here (the seed script sets the same on a fresh database). Slides and cover
-- slips are left unflagged until the lab says whether they are per test or shared. Tick or untick "Bench supply"
-- on the item type to change any of them.
--
-- Any bench item already listed against a test is removed from that list, so the rule holds for data entered
-- before this change. Saving a test's items never touches stock.

alter table consumables.item_types
  add column bench_supply boolean not null default false;

update consumables.item_types
  set bench_supply = true
  where code in (
    'COTTON-WOOL-500G', 'STICKER-SAMPLE', 'MARKER-SAMPLE', 'TOURNIQUET', 'SPIRIT-METHYL-2L',
    'GLOVES-LATEX', 'MASK-FACE', 'BAG-ZIPLOCK', 'PIPETTE-PASTEUR', 'TIP-MICROPIPETTE', 'TUBE-ROHREN',
    'ANTI-A', 'ANTI-B', 'ANTI-D', 'AHG'
  );

delete from consumables.test_standard_items
  where item_type_id in (select id from consumables.item_types where bench_supply);
