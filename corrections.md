# Corrections: fitting the tracker to the hospital's consumables list

Date: 2026-10-11
Source: the hospital's "List of consumables and service points" (37 laboratory consumables, 14 service-point lines).

The list shows that the tracker's one-model-fits-all design needs adjusting. This document says what to change, in which files, and how to know each change is done. It is written so the work can start before the hospital confirms every detail: anything unconfirmed is editable and visibly marked as unconfirmed.

---

## 1. Decisions already made

1. **Every service point is its own location.** The grouped lines in the list ("NEW A&E, LNG, & DIALYSIS", "OLD A&E, MMW, FMW, MSW, FSW", "GYNAE & PNW") are separate points with separate stock. The 14 lines become **21 locations**.
2. **Build now, confirm later.** Details the lab hasn't confirmed (pack sizes, which tests use plain or gel tubes, target stock levels) are editable and flagged until corrected.
3. **Pack size is editable.** Each item type gets a default pack size now and is marked "unconfirmed" until someone corrects it.
4. **Dispatch records who is carrying the stock.** The store keeper types the name of the person transporting the transfer.

## 2. Corrections at a glance

| ID | Correction | Priority |
|---|---|---|
| C1 | Seed the 37 item types and 21 locations | Now |
| C2 | Location service role, and which roles an item may be sent to | Now |
| C3 | Editable pack size with an "unconfirmed" flag | Now |
| C4 | More container types, and tests that accept more than one | Now |
| C5 | Name of the person transporting, at dispatch | Now |
| C6 | Dispatch from locations other than the main store | Next |
| C7 | Target stock per location and periodic stock counts | Next |
| C8 | Expiry: earliest-expiry-first suggestion and an expiring-soon report | Next |
| C9 | Parked items that need the hospital's input | Parked |
| C10 | Update the documents | With each change |

Suggested order: C1 + C2 + C3 in one migration, then C5 in its own migration, then C4, then C6 to C8.

---

## C1. Seed data

**Why:** the tracker has no item types or locations from the hospital's list yet. Loading them is what lets anyone try the real flow.

**What:** one idempotent seed script, `scripts/seed-consumables.sql`, using `on conflict (code) do nothing` so it can be re-run and never overwrites edits. Names are kept exactly as written in the hospital's list (including "Pasture pipettes"; fix the spelling later if it is a typo).

### C1a. Item types

Tracking mode follows how each item is used. `SERIAL` items are handed out for patients and counted one by one; `QUANTITY` items are counted per batch and reconciled by transfers and stock counts. Pack size is a placeholder (see C3). "Allowed at" is a starting point and can be edited (see C2).

| # | Code | Name | Category | Mode | Unit | Container | Pack size | Allowed at |
|---|---|---|---|---|---|---|---|---|
| 1 | TUBE-EDTA-4ML | EDTA tube 4 mL | SAMPLE_CONTAINER | SERIAL | Pieces | EDTA | 1 | any |
| 2 | TUBE-PLAIN-5ML | Plain tube 5 mL | SAMPLE_CONTAINER | SERIAL | Pieces | PLAIN | 1 | any |
| 3 | TUBE-GEL-9ML | Gel tube 9ml | SAMPLE_CONTAINER | SERIAL | Pieces | GEL | 1 | any |
| 4 | TUBE-FLUORIDE-4ML | Fluoride tube, 4 mL | SAMPLE_CONTAINER | SERIAL | Pieces | FLUORIDE | 1 | any |
| 5 | TUBE-CITRATE-4ML | Citrate tube 4 mL | SAMPLE_CONTAINER | SERIAL | Pieces | CITRATE | 1 | any |
| 6 | TUBE-ESR | ESR tube | SAMPLE_CONTAINER | SERIAL | Pieces | ESR | 1 | any |
| 7 | NEEDLE-VAC-21G | Vacutainer needles 21G | PHLEBOTOMY | QUANTITY | Pack | | 100 | any |
| 8 | NEEDLE-VAC-23G | Vacutainer needles 23G | PHLEBOTOMY | QUANTITY | Pack | | 100 | any |
| 9 | NEEDLE-BUTTERFLY | Butterfly needle | PHLEBOTOMY | QUANTITY | Pack | | 100 | any |
| 10 | SWAB-ALCOHOL | Alcohol swabs | PHLEBOTOMY | QUANTITY | Pack | | 100 | any |
| 11 | COTTON-WOOL-500G | Cotton wool 500g | PHLEBOTOMY | QUANTITY | Roll | | 1 | any |
| 12 | TOURNIQUET | Tourniquets | PHLEBOTOMY | QUANTITY | Pieces | | 1 | any |
| 13 | PLASTER-ADHESIVE | Adhesive plaster | PHLEBOTOMY | QUANTITY | Pack | | 100 | any |
| 14 | GLOVES-LATEX | Latex gloves | PPE | QUANTITY | Pack | | 100 | any |
| 15 | CONT-STOOL-30ML | Stool container, 30 mL | SAMPLE_CONTAINER | SERIAL | Pieces | STOOL | 1 | any |
| 16 | CONT-URINE-30ML | Urine container, 30mL | SAMPLE_CONTAINER | SERIAL | Pieces | URINE | 1 | any |
| 17 | CRYOVIAL-2ML | Cryovials, 2 mL | LAB_SUPPLY | QUANTITY | Pack | | 100 | any |
| 18 | SWAB-STICK | Swab sticks | LAB_SUPPLY | QUANTITY | Pack | | 100 | any |
| 19 | BAG-ZIPLOCK | Zip-lock bags | LAB_SUPPLY | QUANTITY | Pack | | 100 | any |
| 20 | SLIDE-FROSTED | Frosted microscope slides | LAB_SUPPLY | QUANTITY | Pack | | 100 | any |
| 21 | COVERSLIP | Cover slips | LAB_SUPPLY | QUANTITY | Pack | | 100 | any |
| 22 | SPIRIT-METHYL-2L | Methylated spirit, 2L | LAB_SUPPLY | QUANTITY | Pieces | | 1 | any |
| 23 | TIP-MICROPIPETTE | Micropipette tips | LAB_SUPPLY | QUANTITY | Pack | | 100 | any |
| 24 | STICKER-SAMPLE | Sample sticker | LABELLING | QUANTITY | Roll | | 1 | any |
| 25 | MARKER-SAMPLE | Sample marker | LABELLING | QUANTITY | Pieces | | 1 | any |
| 26 | MASK-FACE | Face mask | PPE | QUANTITY | Pack | | 100 | any |
| 27 | BAG-BLOOD | Blood bag | BLOOD_BANK | SERIAL | Pieces | | 1 | BLOOD_BANK |
| 28 | STRIP-HBV | HBV strip | REAGENT | QUANTITY | Pack | | 100 | BENCH, BLOOD_BANK |
| 29 | STRIP-HCV | HCV strip | REAGENT | QUANTITY | Pack | | 100 | BENCH, BLOOD_BANK |
| 30 | STRIP-VDRL | VDRL strip | REAGENT | QUANTITY | Pack | | 100 | BENCH, BLOOD_BANK |
| 31 | KIT-HIV-DETERMINE | HIV Determine | REAGENT | QUANTITY | Pack | | 100 | BENCH, BLOOD_BANK |
| 32 | TUBE-ROHREN | Rohren tubes | LAB_SUPPLY | QUANTITY | Pack | | 100 | any |
| 33 | PIPETTE-PASTEUR | Pasture pipettes | LAB_SUPPLY | QUANTITY | Pack | | 100 | any |
| 34 | ANTI-A | Anti-A | REAGENT | QUANTITY | Pieces | | 1 | BENCH, BLOOD_BANK |
| 35 | ANTI-B | Anti-B | REAGENT | QUANTITY | Pieces | | 1 | BENCH, BLOOD_BANK |
| 36 | ANTI-D | Anti-D | REAGENT | QUANTITY | Pieces | | 1 | BENCH, BLOOD_BANK |
| 37 | AHG | AHG | REAGENT | QUANTITY | Pieces | | 1 | BENCH, BLOOD_BANK |

All rows are created with `pack_size_confirmed = false`. Pack size only matters for `QUANTITY` items; for `SERIAL` items it stays 1.

### C1b. Locations

The main store already exists and is not re-created. Names are exactly as in the hospital's list. `type` is the physical kind of place; `service_role` is what it does for stock (see C2).

| Code | Name | Type | Service role |
|---|---|---|---|
| MAIN-LAB-RECEPTION | Main lab reception | STORE | STORE (assumption, see C6) |
| BLOOD-BANK | Blood bank | LAB | BLOOD_BANK |
| GOPD | GOPD | OTHER | COLLECTION_POINT |
| FAST-TRACK | Fast-track | OTHER | COLLECTION_POINT |
| AMENITY | Amenity | OTHER | COLLECTION_POINT |
| EPU | EPU | OTHER | COLLECTION_POINT |
| SCBU | SCBU | WARD | COLLECTION_POINT |
| NEW-AE | NEW A&E | OTHER | COLLECTION_POINT |
| LNG | LNG | OTHER | COLLECTION_POINT |
| DIALYSIS | DIALYSIS | OTHER | COLLECTION_POINT |
| OLD-AE | OLD A&E | OTHER | COLLECTION_POINT |
| MMW | MMW | WARD | COLLECTION_POINT |
| FMW | FMW | WARD | COLLECTION_POINT |
| MSW | MSW | WARD | COLLECTION_POINT |
| FSW | FSW | WARD | COLLECTION_POINT |
| GYNAE | GYNAE | WARD | COLLECTION_POINT |
| PNW | PNW | WARD | COLLECTION_POINT |
| CHEM-PATH | Chem Path | LAB | BENCH |
| MICROBIOLOGY | Microbiology | LAB | BENCH |
| HAEMATOLOGY | Haematology | LAB | BENCH |
| HISTO-PATH | Histo Path | LAB | BENCH |

**Done when:** after running the script, the admin item-types screen lists 37 items and the locations screen lists the main store plus the 21 above; running it a second time changes nothing.

---

## C2. Location service role and allowed roles per item

**Why:** the 21 points are two different kinds of place. Collection points hand bottles to patients, so step 2 links to an investigation or admission. Bench sections and the blood bank consume items in the lab, not per patient. Reagents such as Anti-A and the HIV kit must not be sent to a ward by mistake.

**What**
- Migration `supabase/migrations/20261011000100_consumables_list_fit.sql` (shared with C3):
  ```sql
  alter table consumables.locations
    add column service_role text
      check (service_role in ('STORE', 'COLLECTION_POINT', 'BENCH', 'BLOOD_BANK'));
  alter table consumables.item_types
    add column allowed_service_roles text[];
  ```
  A null `service_role` or null `allowed_service_roles` means "no restriction", so existing rows keep working.
  **A destination with the role `STORE` is always allowed**, so reagents can go main store → Main lab reception → a bench; the restriction is enforced at the next hop (decided 2026-10-11).
- Mirror the columns in `server/db/schema.ts`; add `SERVICE_ROLES` to `server/domain/types.ts`.
- `types/admin.ts`: add `serviceRole` to `locationInputSchema` and `allowedServiceRoles` to `itemTypeInputSchema`; update both admin screens (`app/(app)/admin/locations`, `app/(app)/admin/item-types`).
- `server/services/transfer.service.ts`: in `confirmTransfer`, reject the dispatch when the destination's role is not in an item's `allowed_service_roles`. The message names the item, the destination and the allowed roles, for example "Anti-A can't be sent to MMW. It can go to: BENCH, BLOOD_BANK".
- Issue screen and extension panel: show only collection points for patient-linked issues; bench and blood-bank locations use department-level use (reference type `DEPARTMENT`).

**Done when:** dispatching Anti-A to MMW is refused with that message; dispatching it to Haematology or to Main lab reception works; an item with no restriction can go anywhere.

---

## C3. Editable pack size

**Why:** the list mixes Pieces, Packs and Rolls, and the real pack sizes aren't known yet. We need a default now and a way to correct it later without disturbing any records.

**Rule that keeps this safe:** the ledger counts in the item's own stock unit (packs for "Pack" items, pieces for "Pieces" items) and never converts. Pack size is information for displaying equivalents ("40 packs, about 4,000 pieces") and for future per-use calculations. **Changing a pack size therefore never changes a stock count or rewrites any event.**

**What**
- Same migration as C2:
  ```sql
  alter table consumables.item_types
    add column pack_size integer not null default 1 check (pack_size >= 1),
    add column pack_size_confirmed boolean not null default false;
  ```
- `types/admin.ts`: `packSize` (whole number, 1 to 100000) and `packSizeConfirmed` on the item-type schemas; mirror in `server/db/schema.ts`.
- Item-type admin screen: show pack size next to the unit; an "Unconfirmed" badge while `pack_size_confirmed` is false; saving a changed pack size with "Confirmed" ticked marks it confirmed.
- Admin list view: a filter or banner "N items with unconfirmed pack size".
- Wherever stock is shown for a `QUANTITY` item whose unit is "Pack", show the piece equivalent in lighter text, with a small "unconfirmed" marker until confirmed.

**Done when:** changing an item's pack size from 100 to 50 changes only the displayed equivalents; every on-hand figure, transfer quantity and report total stays the same; the item shows "Unconfirmed" until someone ticks confirmed.

---

## C4. Container types, and tests that accept more than one

**Why:** the code suggests EDTA, PLAIN, FLUORIDE, FORMALIN, CITRATE and HEPARIN. The hospital also stocks gel, ESR, urine and stool containers. And since both plain and gel tubes are stocked, many chemistry tests can probably use either, but a test currently names exactly one container.

**What**
- `server/domain/types.ts`: add `GEL`, `ESR`, `URINE`, `STOOL`, `SWAB` and `CRYOVIAL` to `CONTAINER_TYPE_SUGGESTIONS`; keep `FORMALIN` and `HEPARIN`.
- Migration `20261011000300_container_alternates.sql`: add `alternate_container_types text[] not null default '{}'` to `test_catalog`. A test is satisfied by its required container or any alternate.
- `server/domain/issue-rules.ts` (`containerMismatch`) and the sibling-grouping logic used by the extension (`app/api/ext/test-match`, the panel's grouping): treat two tests as able to share a bottle when one container type satisfies both.
- `scripts/test-catalog.sql`: the two mappings marked "confirm with your lab" (LFT, GXM) are settled with the lab using the plain/gel question; add alternates where the lab says either tube is fine.

**Done when:** a test that accepts PLAIN or GEL can be issued either tube without an override; an LFT and a U&E that both accept PLAIN or GEL can share one bottle; a bottle outside both is still refused.

---

## C5. Name of the person transporting, at dispatch

**Why:** the hospital's store keepers already note who carried the stock. When a receipt comes up short, "who carried it" is the first question.

**What**
- Migration `20261011000200_transfer_carrier.sql`:
  ```sql
  alter table consumables.transfers add column carried_by_name text;
  -- Write-once: once set at dispatch, it can't be changed.
  create function consumables.transfers_carrier_write_once() returns trigger
  language plpgsql as $$
  begin
    if old.carried_by_name is not null and new.carried_by_name is distinct from old.carried_by_name then
      raise exception 'carried_by_name cannot be changed once set';
    end if;
    return new;
  end;
  $$;
  create trigger transfers_carrier_write_once before update on consumables.transfers
    for each row execute function consumables.transfers_carrier_write_once();
  ```
  Old transfers keep a null value and show "Not recorded".
- `types/transfers.ts` (`confirmTransferSchema`): add `carriedByName`, trimmed, 2 to 100 characters, **required** at confirm.
- `server/services/transfer.service.ts` (`confirmTransfer`): store it in the same update that sets the status to DISPATCHED. It applies to transfers made from requests as well.
- Dispatch screen (`app/(app)/store/dispatch`): a "Carried by" field in the confirm step, with the last few names offered as suggestions to save typing.
- Show it on: the printed transfer slip (`labels.service.ts`), the transfer detail page, the receive screen header (so the receiver sees who brought it), and the discrepancy report as a column.
- The name lives on the transfer, and each DISPATCHED event already points to the transfer through `transfer_id`, so the ledger is not duplicated with names.

**Done when:** confirming a dispatch without a carrier name is refused; with one it prints on the slip and appears on the transfer, the receive screen and the discrepancy report; editing it afterwards is rejected by the database.

---

## C6. Dispatch from locations other than the main store

**Why:** `createTransfer` refuses any sending location whose type isn't `STORE`. If "Main lab reception" holds stock and passes it on to wards and benches, it needs to be able to dispatch.

**What**
- **No code change to start:** the seed creates Main lab reception with type `STORE` (see C1b), which allows it to dispatch.
- If the lab confirms that reception is not a store, relax the rule in `createTransfer` from "type is STORE" to "the location holds stock", and re-check at confirm that every item is actually on hand there.

**Done when:** the main store dispatches to Main lab reception, and Main lab reception dispatches on to, for example, MMW.

---

## C7. Target stock per location and periodic stock counts

**Why:** for the bulk items (gloves, needles, swabs and so on) nobody scans every use, so accountability comes from regular counts compared with what the system expects. The stock requests you've already built are the natural place for the result to land.

**What**
- Tables (RLS on, no policies, like the others):
  - `par_levels (location_id, item_type_id, target_quantity, minimum_quantity)`.
  - `stock_counts (id, location_id, counted_by, counted_at, status)` and `stock_count_lines (count_id, item_type_id, batch_id, counted_quantity, expected_quantity)`.
- A count screen per location: the attendant enters counted quantities per item (and batch for reagents); the system shows the expected figure only after the count is entered; a variance is posted as an `ADJUSTED` event with a reason.
- A "suggest request from targets" action in the stock-request flow: target minus counted, per item.
- A variance report: counted versus expected, per location and period.

**Done when:** a count that is lower than expected shows the variance, posts the adjustment with a reason, and the request screen proposes the shortfall.

---

## C8. Expiry

**Why:** reagents, strips and anti-sera have lot numbers and expiry dates that matter for patient safety.

**What**
- On dispatch of a `QUANTITY` item with several batches at the sending location, suggest the batch with the earliest expiry that still has stock.
- An "expiring within 30, 60, 90 days" report per location (add it only if one doesn't already exist).
- Expired stock stays blocked from dispatch and issue, as today.

**Done when:** with two batches of HIV Determine, the dispatch screen proposes the one expiring first; the report lists anything inside the window.

---

## C9. Parked: needs the hospital's input

These are real needs but can't be built well until the hospital answers.
- **Blood bags** usually carry the manufacturer's own barcode. Decide whether the tracker should accept that barcode as the serial and not print its own, and leave blood-unit tracking after filling to the EMR's Blood Bank module.
- **Cold storage** for the anti-sera, AHG and test kits: whether the tracker should flag it, or leave it to the blood bank's own procedures.
- **Expected consumption per test.** Decided 2026-10-12: do not wait for the EMR. The lab defines a standard list of bulk items and quantities per test in the Test catalog (editable, with the same "Unconfirmed" flag as the other lab-defined values). At the point of issue the chosen test brings up its items, and staff can change a quantity, remove a line or add an item. The confirmed lines are what leave stock, and whether they differ from the standard is recorded. Built; see `build.md` C9. Comparing against the EMR's Default Lab Consumables setting is still open and would need the check on what is configured there.
- **Missing from the list:** formalin or histology specimen containers, blood culture bottles and culture media. Ask whether they're supplied separately and should be tracked.

---

## C10. Update the documents

- `architecture.md`: section 5 (new columns: `locations.service_role`, `item_types.pack_size`, `pack_size_confirmed`, `allowed_service_roles`, `transfers.carried_by_name`, `test_catalog.alternate_container_types`), section 7.2 (carrier name at dispatch), section 15 (open questions below).
- `build.md`: a new phase "Fit to the hospital's list" with C1 to C8 as tasks and their "done when" lines.

---

## To confirm with the lab (does not block building)

- Real pack sizes for each "Pack" item (then correct them and tick confirmed).
- Which tests use plain tubes and which use gel (and which accept either).
- Whether "Main lab reception" is a sub-store that holds stock, or only a reception desk.
- Target stock levels per service point.
- The meaning of "LNG" in the service-point list, and the spelling "Pasture pipettes".
- Whether the items in C9 are tracked or supplied elsewhere.
