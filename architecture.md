# Consumables Barcode Tracker — Architecture

A system for tracking **all hospital consumables** (starting with sample bottles and specimen containers) from the main store to the point of use, and on to the investigation, admission, or procedure they were used for, with full accountability at every step. It layers on top of the EMR's Lab module instead of replacing it.

> **Status:** design document. The stack in section 3 is an assumption and can be swapped; the data model, tracking modes, state machine, and rules in sections 2 and 4–9 are the part that matters. Section 16 covers the EMR/Lab integration.

---

## 1. Goals

1. **Two-step traceability for all consumables (the CMD's requirement):**
   - Step 1, at the store: stock is bound to its **destination** (e.g. EPU Side Lab, a ward, a theatre).
   - Step 2, at the point of distribution: stock is bound to a **reference** when it is handed out: an investigation (lab), an admission, an outpatient visit, a procedure, a surgery, or a department.
2. **Answer "where did the others go?"** For any location and period, every unit or quantity is dispatched, received, issued, returned, wasted/voided, or flagged missing. Nothing disappears silently.
3. **Know exactly *which* item is missing** for serialized items (per-unit scanning at dispatch and receipt), and exactly *how many* for bulk items.
4. **Layer on the EMR instead of duplicating it.** The tracker adds identity, custody, and usage on top of the EMR's investigations.

## 2. Core principles

- **Two tracking modes, chosen per item type:**

  | Mode | Used for | What is scanned | Missing items are found by |
  |---|---|---|---|
  | `SERIAL` | Sample bottles, specimen containers, blood-collection tubes, and any item where individual accountability matters | Every unit has its own serial barcode; every step scans each unit | Exact serial |
  | `QUANTITY` | Gloves, syringes, gauze, cannulas, and other bulk items | The batch/box barcode plus a counted quantity | Quantity difference per batch and location |

- **One unique serial per trackable unit (`SERIAL` mode).** The barcode is printed once and never re-encoded. "Encoding" a destination or a reference is a **database event** that binds the serial to something.
- **Append-only event ledger.** Every scan writes an immutable event (who, what, where, when, why). Corrections are new events, never edits.
- **State machine enforced on the server.** The client can propose a scan; only the server decides whether the transition is legal.
- **Idempotent, offline-tolerant events.** Each scan carries a client-generated UUID so queued scans can sync safely after a connection drop.
- **The tracker owns stock, identity and custody.** Batches, expiry, quantities, transfers, serials, who-handled-what, and usage links all live in the tracker.
- **Integration seam.** Reference lookup (`ReferenceProvider`) sits behind an interface, with manual and CSV implementations now and the EMR API later.

## 3. Tech stack (assumed)

| Concern | Choice | Notes |
|---|---|---|
| App framework | Next.js (App Router) + TypeScript | UI and API in one codebase; installable as a PWA |
| Database | PostgreSQL | Strong constraints, triggers (to keep the ledger append-only), views for reports |
| ORM / migrations | Drizzle ORM + postgres.js; Supabase CLI SQL migrations | Migrations in `supabase/migrations/` are the source of truth; `schema.ts` mirrors them |
| Validation | Zod | Shared between client and server |
| Auth | Supabase Auth (see `build.md`, Supabase decisions) | Staff log in with their EMR staff ID, mapped to a synthetic email, so accounts merge cleanly later |
| Barcodes | `bwip-js` | Code 128 for serials; QR/Data Matrix optional |
| Label printing | ZPL over network/USB to a Zebra-class printer; PDF fallback | |
| Offline | Service worker + IndexedDB queue | Scans queue locally and sync when online |
| Scanners | USB/Bluetooth HID scanners (act as a keyboard) | No drivers needed |
| Tests | Vitest (unit/integration), Playwright (e2e) | |

## 4. Unit lifecycle (state machine for `SERIAL` items)

```
                      dispatch                receive (per-bottle scan)
  IN_STOCK (store) ───────────────► IN_TRANSIT ───────────────────────► IN_STOCK (lab) ◄─────────┐
        │                               │                                    │                   │
        │                               │ receipt closed, never scanned      │ issue (bound to   │ return unused
        │                               ▼                                    │ reference link)   │ (link cleared)
        │                      MISSING_IN_TRANSIT                            ▼                   │
        │                          │         │                            ISSUED ───────────────┘
        │                  found   │         │ written off                  │
        │                          ▼         ▼                              │ return used
        │                   IN_STOCK (lab)  WRITTEN_OFF                     │ (filled bottle)
        │                                                                   ▼
        │                                                              RETURNED (terminal)
        │
        └── void (reason) from IN_STOCK, ISSUED or MISSING_IN_TRANSIT ──► VOIDED (terminal)
```

At the return scan there are **three outcomes**: *used* (`RETURNED`), *unused and intact* (back to `IN_STOCK` at the lab, investigation link cleared, history kept), and *unusable* (`VOIDED` with a reason). If a location has `allow_unused_reuse` turned off, the "unused" outcome voids the bottle with reason `UNUSED` instead of restocking it.

| State | Meaning | Terminal? |
|---|---|---|
| `IN_STOCK` | On hand at `current_location` (store or lab). Includes bottles returned unused and restocked | No |
| `IN_TRANSIT` | Dispatched on a transfer, not yet received | No |
| `MISSING_IN_TRANSIT` | Transfer receipt closed and this bottle was never scanned | No (can be resolved) |
| `ISSUED` | Bound to an investigation and handed to the patient/collector | No (becomes `RETURNED`, back to `IN_STOCK`, or `VOIDED`) |
| `RETURNED` | Used bottle (sample inside) scanned back at the lab bench | Yes |
| `VOIDED` | Unusable, with a reason code | Yes |
| `WRITTEN_OFF` | Missing bottle formally written off by a supervisor | Yes |

**Outstanding** = bottles `ISSUED` for longer than a configurable threshold (default 24 h) without being returned (used, unused, or voided).

In this section and the next, "bottle" means any serialized unit. **`QUANTITY` items have no per-unit states.** They use movement events on a batch at a location (`STOCKED`, `DISPATCHED`, `RECEIVED`, `USED`, `RETURNED_UNUSED`, `WASTED`, `ADJUSTED`), and the on-hand balance is derived from those events (`v_quantity_balance`).

## 5. Data model

All tables use `id` (UUID) primary keys and `created_at`/`updated_at` unless noted.

| Table | Purpose | Key columns |
|---|---|---|
| `users` | Staff accounts | `staff_id` (unique), `name`, `role`, `home_location_id`, `active` (keyed to `auth.users.id`; Supabase Auth holds passwords) |
| `locations` | Main store, labs, wards, theatres, any holder of stock | `code`, `name`, `type` (`STORE`/`LAB`/`WARD`/`THEATRE`/`OTHER`), `external_system` (`LAB_DESTINATION`/`WARD`/null), `external_id` (the EMR record this maps to), `allow_unused_reuse` (bool, default true), `service_role` (`STORE`/`COLLECTION_POINT`/`BENCH`/`BLOOD_BANK`/null; what the place does for stock, null means unrestricted), `active` |
| `item_types` | Kinds of consumable | `code`, `name`, `category` (e.g. `SAMPLE_CONTAINER`, `SURGICAL`, `GENERAL`), `tracking_mode` (`SERIAL`/`QUANTITY`), `container_type` (for sample containers, e.g. EDTA, plain, fluoride, formalin), `unit_of_measure`, `reorder_level`, `allowed_service_roles` (`text[]`, null means it may go anywhere), `pack_size` (integer, default 1; information only, the ledger never converts), `pack_size_confirmed` (bool, false until the lab corrects the placeholder), `cold_storage` (bool, default false; display only: shows a "Keep cold" tag on the item types, stock, transfer and receive screens, blocks nothing) |
| `batches` | A delivery of one item type | `item_type_id`, `lot_no`, `expiry_date`, `supplier`, `quantity`, `source` (`MANUAL`), `received_by` |
| `units` | One row per physical item, **`SERIAL` items only** | `serial` (unique), `item_type_id`, `batch_id`, `state`, `current_location_id`, `current_transfer_id` |
| `links` | **Many-to-many** link between an item and what it was used for | `unit_id` (null for `QUANTITY`), `batch_id`, `quantity` (1 for serial units), `reference_type` (`INVESTIGATION`/`ADMISSION`/`VISIT`/`PROCEDURE`/`SURGERY`/`DEPARTMENT`), `reference_ref`, `reference_source` (`manual`/`slip_scan`/`csv`/`emr`), `patient_hospital_no`, `patient_type` (`OUTPATIENT`/`INPATIENT`/`WALK_IN`), `payment_check` (`VERIFIED`/`UNVERIFIED`/`NOT_REQUIRED`), `issue_event_id`, `cleared_at` (set when returned unused) |
| `transfers` | A movement of stock between two locations | `code` (barcoded on the slip), `from_location_id`, `to_location_id`, `status`, `carried_by_name` (who carried the stock; required at dispatch, write-once), `dispatched_by/at`, `receipt_started_by/at`, `receipt_closed_by/at` |
| `transfer_items` | What is on a transfer | `transfer_id`, `unit_id` (serial items) or `batch_id` (quantity items), `quantity_dispatched`, `quantity_received`, `received_at` (null until scanned or counted), `resolution` (`FOUND`/`WRITTEN_OFF`/null) |
| `events` | **Append-only ledger of every scan** | `id` (client UUID), `unit_id` (null for quantity events), `batch_id`, `quantity`, `type`, `from_state`, `to_state`, `location_id`, `user_id`, `transfer_id`, `reference_type`, `reference_ref`, `reason_code`, `note`, `payload` (JSON), `occurred_at` (device), `recorded_at` (server), `device_id` |
| `issue_policies` | Whether payment or a charge is needed before issuing | `reference_type`, `patient_type`, `rule` (`MUST_BE_PAID`/`CHARGE_TO_ADMISSION`/`NONE`) |
| `void_reasons` | Controlled list of void/wastage reasons (incl. `BROKEN`, `CONTAMINATED`, `WRONG_TUBE`, `EXPIRED`, `UNUSED`, `CANCELLED_INVESTIGATION`) | `code`, `label`, `active` |
| `test_catalog` | Local copy of tests and their required container | `code`, `name`, `required_container_type`, `alternate_container_types` (`text[]`, other containers that also satisfy the test), `containers_confirmed` (bool, false until the lab confirms the container and its alternates; display only, blocks nothing), `consumption_confirmed` (bool, false until the lab confirms the test's standard items; display only, blocks nothing). Entered through the admin screen now, later synced from the EMR |
| `test_standard_items` | The bulk items one run of a test normally uses; pre-fills "Issue for test". It never moves stock | `test_id`, `item_type_id` (unique together), `quantity` (1 to 100,000, per test, in the item's stock unit). Only `QUANTITY` item types are accepted (the service enforces it) |
| `par_levels` | Target stock per location and item type. It never moves stock; it feeds the low flag and "suggest a request" | `location_id`, `item_type_id` (unique together), `target_quantity` (1 to 1,000,000), `minimum_quantity` (0 means no minimum; never above the target) |
| `stock_counts` | One periodic count of bulk batches at a location | `location_id`, `status` (`OPEN`/`POSTED`/`CANCELLED`), `counted_by`, `counted_at`, `note`, `posted_by`, `posted_at` |
| `stock_count_lines` | One counted batch within a count | `count_id`, `batch_id` (unique together), `counted_quantity`, `expected_quantity` (the ledger balance when the count was submitted, refreshed at posting if stock moved), `reason_code`, `note`, `adjustment_event_id` (the `ADJUSTED` event it posted, null when there was no variance) |
| `investigation_imports` | Rows from the EMR export, **one row per test** | `investigation_ref` (`IXS…`), `patient_hospital_no`, `test_code`, `patient_type`, `payment_status`, `destination`, `status`, `raised_at`, `imported_at` |
| `sync_log` | Records of CSV imports and later EMR syncs | `source`, `started_at`, `rows`, `errors` |

**Constraints and triggers**
- `events`: a database trigger rejects `UPDATE`, `DELETE` and `TRUNCATE`, and write privileges are revoked. The ledger is append-only.
- `units.serial` unique; `transfer_items` unique per (`transfer_id`, `unit_id`) or (`transfer_id`, `batch_id`).
- One serialized unit can be on at most one open transfer (partial unique index).
- **Investigations are per test, so links are many-to-many.** One bottle can serve several investigations of the same patient (several `links` rows for one `unit_id`), and one investigation can use several bottles. `links` is unique only per (`unit_id`, `reference_type`, `reference_ref`) while `cleared_at` is null.
- Returning a unit unused sets `cleared_at` on its links and writes an event; the history is never deleted.
- `transfers.carried_by_name`: a trigger rejects any change once it is set. Transfers dispatched before this column existed keep null and show "Not recorded".
- Changing `item_types.pack_size` never changes a stock count or rewrites an event. Stock is counted in the item's own unit (packs or pieces); pack size only drives displayed equivalents. Equivalents ("about 4,000 pieces", with an "unconfirmed" marker until the lab confirms the size) appear beside pack quantities on Stock here (bulk tab), the Expiring stock report, the count review page and the count variance report; items whose unit is not a pack, or whose pack size is 1, show nothing.
- `stock_counts`: a partial unique index allows only one `OPEN` count per location, so two people cannot post competing adjustments. `stock_counts`, `stock_count_lines` and `par_levels` have row-level security on with no policies, like the other tables (server access only).
- A count variance is posted as one `ADJUSTED` event per line, whose `quantity` is the signed variance (counted minus expected). `v_quantity_balance` already adds `ADJUSTED` quantities, so the ledger needs no change.

**Reporting views**
- `v_location_reconciliation`: per location and period, dispatched / received / issued / returned (used) / restocked (returned unused) / voided or wasted / missing / on hand / unaccounted, for both modes.
- `v_quantity_balance`: on-hand quantity per batch per location, derived from the ledger.
- `v_outstanding_issued`: serialized units still `ISSUED` past the threshold.
- `v_open_discrepancies`: transfers closed with unscanned units or quantity shortfalls.
- `v_orphan_issues`: links whose `reference_ref` is missing from `investigation_imports` (or the EMR).

## 6. Project structure

```
consumables-tracker/
├── README.md                          Setup, env vars, run/deploy instructions
├── architecture.md                    This document
├── package.json                       Dependencies and scripts
├── tsconfig.json                      TypeScript config
├── next.config.ts                     Next.js config, PWA headers
├── .env.example                       SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY, DATABASE_URL, SESSION_SECRET, PRINTER_HOST, OUTSTANDING_HOURS, ...
│
├── supabase/migrations/               SQL migrations (hand-written, applied with the Supabase CLI)
│   ├── ..._consumables_schema.sql     The consumables schema
│   ├── ..._init.sql                   Core tables
│   ├── ..._events_append_only.sql     Trigger blocking UPDATE/DELETE/TRUNCATE on events
│   └── (later)                        Reporting views: reconciliation and outstanding
│
├── public/
│   ├── manifest.json                  PWA manifest (installable on store/lab PCs and tablets)
│   ├── sw.js                          Service worker: cache app shell, background sync
│   └── icons/                         App icons
│
├── extension/                         Chrome extension (Manifest V3) for the staff portal; see section 17
│   ├── manifest.json                  Permissions, side panel, and the portal hosts the scripts run on
│   ├── background.js                  Opens the side panel from the toolbar icon; holds no state and no tokens
│   ├── page-hook.js                   Runs inside the portal page: reads a copy of its investigation API responses, keeps a field whitelist
│   ├── content.js                     Bridges the page and the side panel; forwards scanner input; navigates the portal
│   ├── sidepanel.html / .css          Panel layout (Issue, Return and Look up tabs)
│   └── sidepanel.js                   Panel logic: sign-in, sync, issue, return, look up
│
├── scripts/
│   ├── bootstrap-admin.ts             Create the very first ADMIN account (Supabase Auth user + users row); the only seeded record
│   ├── import-investigations.ts       CLI: load the EMR's nightly investigations CSV into investigation_imports
│   └── print-test-labels.ts           Generate a sheet of sample labels for scanner/printer testing
│
├── app/                           Routes (UI pages + API handlers)
│   ├── (auth)/
│   │   └── login/page.tsx         Staff ID + password login
│   │
│   ├── (app)/                     Authenticated area
│   │   ├── layout.tsx             Nav, role-based menu, offline/sync status indicator
│   │   ├── dashboard/page.tsx     Stock levels, open transfers, discrepancies, outstanding bottles
│   │   │
│   │   ├── store/                 STORE_KEEPER screens
│   │   │   ├── stock-in/page.tsx          Receive a manual batch, mint serials for SERIAL items, print labels
│   │   │   ├── dispatch/page.tsx          Create transfer; scan each unit or enter batch quantity; print transfer slip
│   │   │   └── transfers/
│   │   │       ├── page.tsx               List of transfers and their status
│   │   │       └── [id]/page.tsx          Transfer detail: serials, receipt status, discrepancies
│   │   │
│   │   ├── distribution/          DISTRIBUTOR screens (labs, wards, theatres, any point of use)
│   │   │   ├── receive/page.tsx           Scan slip; SERIAL items scanned one by one, QUANTITY items counted per batch; live "x of y" and missing list
│   │   │   ├── issue/page.tsx             Pick reference (investigation by MRN, admission, visit, procedure, surgery, department); scan item(s) or enter quantity; policy check; record collector; print label
│   │   │   ├── return/page.tsx            Scan bottle, then choose outcome: Used / Unused (back to stock) / Unusable (void + reason)
│   │   │   ├── void/page.tsx              Scan bottle, choose reason (for bottles voided outside the return flow)
│   │   │   └── stock/page.tsx             Serials and quantities on hand at this location
│   │   │
│   │   ├── reports/               SUPERVISOR / AUDITOR screens
│   │   │   ├── reconciliation/page.tsx    Per location/period; drill down to staff, day, bottle
│   │   │   ├── discrepancies/page.tsx     Open transfer discrepancies; resolve as found / written off
│   │   │   ├── outstanding/page.tsx       Issued but not returned past the threshold
│   │   │   ├── orphans/page.tsx           Issued items whose reference isn't in the EMR export
│   │   │   └── bottle/[serial]/page.tsx   Full life history of one bottle
│   │   │
│   │   └── admin/                 ADMIN screens
│   │       ├── users/page.tsx             Manage staff accounts and roles
│   │       ├── locations/page.tsx         Stores, labs, wards and theatres, each mapped to its EMR record
│   │       ├── item-types/page.tsx        Consumable types: category, tracking mode (SERIAL/QUANTITY), reorder levels
│   │       ├── tests/page.tsx             Test catalog: required container type per test
│   │       ├── policies/page.tsx          Issue policies: payment or charge rule per reference type and patient type
│   │       ├── void-reasons/page.tsx      Controlled reason list
│   │       └── imports/page.tsx           Upload investigation CSV, view import history
│   │
│   └── api/                       Route handlers (used by the offline queue and the UI)
│       ├── events/route.ts                POST batched scan events (idempotent by event id)
│       ├── batches/route.ts               POST new batch and generate units
│       ├── transfers/route.ts             Create/list transfers
│       ├── transfers/[id]/route.ts        Transfer detail, close receipt, resolve discrepancy
│       ├── units/[serial]/route.ts        Look up a bottle's current state and history
│       ├── references/lookup/route.ts     Validate/lookup an investigation, admission, visit, ... via the provider
│       ├── labels/route.ts                Render label/slip as ZPL or PDF
│       ├── reports/[name]/route.ts        Report data endpoints
│       └── imports/route.ts               Upload and process investigation CSVs
│
├── server/
│   ├── db/
│   │   ├── client.ts                      DB connection/pool
│   │   ├── schema.ts                      Table definitions (source of truth for the data model)
│   │   └── queries/                       Reusable typed queries (units, transfers, reports)
│   │
│   ├── domain/                            Pure business logic, no I/O (easiest to unit-test)
│   │   ├── state-machine.ts               Allowed transitions between unit states (SERIAL items)
│   │   ├── rules.ts                       Checks: right location, right container type, not already linked, not expired, issue policy (payment/charge)
│   │   ├── errors.ts                      Typed domain errors (WrongLocation, AlreadyIssued, ...)
│   │   └── types.ts                       Shared domain types and enums
│   │
│   ├── services/                          Use-case orchestration: validate, write events, update state in one transaction
│   │   ├── stock-in.service.ts            Create batch, mint serials for SERIAL items
│   │   ├── transfer.service.ts            Create transfer, dispatch units/quantities (bind destination)
│   │   ├── receive.service.ts             Open receipt, per-unit scans (SERIAL) or counted quantities (QUANTITY), close receipt, flag MISSING_IN_TRANSIT or quantity shortfall
│   │   ├── discrepancy.service.ts         Resolve missing bottles as found or written off
│   │   ├── issue.service.ts               Check issue policy, link unit/quantity to one or more references, record collector
│   │   ├── return.service.ts              Handle the three return outcomes: used → RETURNED, unused → IN_STOCK (clears investigation link, honours allow_unused_reuse), unusable → delegates to void.service
│   │   ├── void.service.ts                Void with reason
│   │   ├── reconciliation.service.ts      Build reconciliation and outstanding reports
│   │   ├── labels.service.ts              Compose label and slip content
│   │   └── import.service.ts              Parse and load investigation CSVs
│   │
│   ├── integrations/
│   │   └── reference/                     Resolves what an item is issued against
│   │       ├── provider.ts                ReferenceProvider interface: lookup(type, ref) → { exists, patientNo, patientType, paymentStatus, items[], destination }
│   │       ├── manual.provider.ts         Format validation only (current default)
│   │       ├── csv.provider.ts            Validates against investigation_imports
│   │       └── emr.provider.ts            Future EMR API: investigations, admissions, visits, procedures, surgeries
│   │
│   ├── auth/
│   │   ├── session.ts                     Session handling
│   │   └── permissions.ts                 Role → allowed actions map
│   │
│   └── audit/
│       └── events.ts                      Single place that appends to the events ledger
│
├── components/
│   ├── scanner/
│   │   ├── ScanInput.tsx                  Always-focused input that captures HID scanner input; beep/flash feedback
│   │   ├── ScanSession.tsx                Manages a batch scan session (dispatch, receive) with undo of last scan
│   │   └── ScanFeedback.tsx               Clear success/error states for fast, eyes-off scanning
│   ├── forms/                             Collector details, void reason, batch entry
│   ├── tables/                            Bottle lists, transfer lists, report tables
│   ├── labels/                            On-screen label previews
│   └── ui/                                Buttons, dialogs, layout primitives
│
├── lib/
│   ├── serial.ts                          Serial format and check digit generation/validation
│   ├── barcode.ts                         bwip-js wrappers (Code 128, QR)
│   ├── zpl.ts                             ZPL templates for the label printer
│   ├── reference-formats.ts               Format rules: investigation ^IXS\d+$, MRN ^UATH/PT/\d+$, admission/visit/procedure/surgery formats (to confirm)
│   └── time.ts                            Timezone-safe helpers
│
├── offline/
│   ├── queue.ts                           IndexedDB queue of pending scan events
│   ├── sync.ts                            Flush queue to /api/events, handle conflicts and retries
│   └── device.ts                          Stable device_id for event provenance
│
├── types/                                 Shared TS types and Zod schemas (client + server)
│
└── tests/
    ├── unit/                                  state-machine, rules, serial/check digit, reference-formats, issue policies
    ├── integration/                           Services against a test DB; ledger append-only guarantee
    └── e2e/                                   Playwright: full store → lab → patient flow incl. missing bottle
```

## 7. Key flows

### 7.1 Stock in (store)
1. A supplier delivery is received by the store keeper, who enters the batch in the tracker (`source = MANUAL`).
2. For `SERIAL` item types, `stock-in.service` creates N `units` (`IN_STOCK`, location = the store) with serials from `lib/serial.ts`, and the labels print. For `QUANTITY` item types it records the batch quantity, with a batch/box label.
3. A `STOCKED` event is written per unit (or per batch for quantity items).

### 7.2 Dispatch, step 1 of the CMD's encoding (store)
1. The store keeper creates a transfer: Main Store → EPU Side Lab (or any destination).
2. `SERIAL` items: they scan each unit. Each scan validates `state = IN_STOCK` at the store and not expired, then adds the unit to `transfer_items`. `QUANTITY` items: they scan the batch/box and enter the quantity. When a scanned box has a sibling batch of the same item that expires sooner and still has stock at the sending location, an amber note suggests sending that one first. It never blocks (a batch with no expiry counts as last; expired batches are ignored, since dispatch already refuses them; bottles scanned without a box get no suggestion).
   - **Who can send:** a location may dispatch if its type is `STORE` (Main lab reception is seeded as a `STORE`, so stock can pass main store → reception → ward or bench).
   - **Where an item may go:** at confirm, each item's `allowed_service_roles` is checked against the destination's `service_role`. A destination with the role `STORE` is always allowed, so the restriction is enforced at the next hop. Example refusal: "Anti-A can't be sent to MMW. It can go to: BENCH, BLOOD_BANK".
3. The store keeper types the name of the person carrying the stock (**required**; the last few names are offered as suggestions). It applies to transfers made from requests as well.
4. On confirm, units go `IN_TRANSIT` (quantities are recorded as `DISPATCHED`), `carried_by_name` is stored in the same update, and the **transfer slip** prints with its own barcode (`TRF-…`), the expected quantity and the carrier's name. The name also shows on the transfer detail page and under the heading of the receive screen, so the receiver sees who brought the stock. On the discrepancy report it appears with the other people details (the dispatch trail on open transfers and a "Carried by" column in the history), visible only to roles with `view_discrepancy_people`.

### 7.3 Receive (point of distribution), per-unit scanning
1. The attendant scans the transfer slip. The system opens a receipt and shows "0 of 50 scanned".
2. `SERIAL` items: they scan each unit. A scan marks `transfer_items.received_at`, moves the unit to `IN_STOCK` at the destination, and writes `RECEIVED`.
   - A unit **not on this transfer** is rejected immediately (wrong slip or wrong location).
   - A duplicate scan is ignored with a clear message.
   - `QUANTITY` items: they scan the batch and type the counted quantity **before** the expected figure is shown.
3. When they close the receipt:
   - Everything accounted for → transfer `RECEIVED`.
   - Some units unscanned → those serials become `MISSING_IN_TRANSIT`, the transfer becomes `RECEIVED_WITH_DISCREPANCY`, and the store keeper and supervisor are notified **with the exact serials**. For quantity items a shortfall is recorded the same way, by batch.
4. A supervisor later resolves each missing unit or quantity as **found** (back in stock at the destination) or **written off**.

### 7.4 Issue, step 2 of the CMD's encoding (point of use)
**Lab (investigations).** Investigations are per test (IXS181 for an LFT, IXS180 for an FBS), so one tube can serve several of a patient's tests.
1. The attendant finds the patient by MRN (or scans the request slip). `ReferenceProvider` returns the patient's pending investigations.
2. The system groups them by required container type and proposes the bottles needed (e.g. one plain tube for the LFT, one fluoride tube for the FBS).
3. They scan a bottle. `rules.ts` checks it is `IN_STOCK` at **this** location, matches the container type, and is not expired. One scan creates a `links` row for **every investigation in that group**.
4. A label prints with the investigation numbers, the patient's MRN, tests, and date. The collector (patient / nurse / porter, plus name) is recorded.

In practice this flow starts on the staff portal: the extension's side panel (section 17) shows the open investigation, finds the other tests that can share the bottle, and issues it, so nothing is retyped.

**Other references (ward, theatre, procedure, department).** The attendant picks the reference type and number (admission, visit, procedure, surgery) or a department for general use, then scans each unit or enters a quantity for bulk items.

**Where each kind of issue is allowed (by the location's `service_role`).** A collection point, a store, or a location with no role may issue against any reference. A **bench section or the blood bank issues for its department only**: patient-linked references (investigation, admission, visit, procedure, surgery) are refused there with "X is a bench section: it uses stock for the department, not per patient. Issue it for a Department instead". The rule is checked in `issueUnit` and `issueQuantity` before any reference lookup, so the Issue page and the extension both obey it, and a supervisor override does not bypass it. The Issue page offers only Department in "Issued for" while the place being worked at is a bench or the blood bank (supervisors see the choices follow the "Working at" pick), and the extension panel shows a blocking message for a signed-in person whose home location is one of those.

**Issue for a test (standard consumption).** A third way to issue on the Issue page, for the bulk items a test uses at a bench. The person picks a test and the number of tests run; the screen pre-fills the test's `test_standard_items` (quantity per test x number) and they can change a quantity, remove a line or add another bulk item, then enter the department. `issueForTest` then draws each line from the batches held at the working location, earliest expiry first, skipping expired batches and locking each batch in a fixed order; if any line cannot be filled from stock, nothing is issued. It writes one `ISSUED` event and one link per batch drawn (reference type `DEPARTMENT`, the test code on the link, no collector, no patient). The event payload carries `consumption: { testCode, tests, edited }`, where `edited` is true when the confirmed lines differ from the standard (compared on the server). Serialized items are refused: a bottle or tube is scanned and issued on its own. The standard lists are the lab's to define and are flagged unconfirmed on the Test catalog until they tick them; the flag blocks nothing. No report reads `edited` yet.

**Payment policy (`issue_policies`).** The EMR owns payment. Through the extension (section 17) the tracker receives the payment status from the portal's own API response and treats it as the EMR's answer; it never stores it on the investigation record. A policy rule only decides whether a bottle may go out:
- `MUST_BE_PAID` blocks the issue while the investigation shows as unpaid, and records `payment_check = UNVERIFIED` when payment can't be read. It is meant for outpatient and walk-in investigations.
- `CHARGE_TO_ADMISSION` never blocks: inpatient tests and consumables are added to the admission's bills.
- `NONE` applies no check, and new links are recorded `NOT_REQUIRED`.

**Current setting: every rule is `NONE`, so the tracker does not block issuing on payment** (migration `20261007001200_issue_policies_none.sql`). Whether the tracker should also stop bottles going out for unpaid investigations will be decided in a discussion with the CMD. If the answer is yes, an admin sets the outpatient and walk-in investigation rules to `MUST_BE_PAID` on the Issue policies screen; no code change is needed.

### 7.5 Return (point of distribution)
The attendant scans the unit and picks one of three outcomes:

| Outcome | Result | Notes |
|---|---|---|
| **Used** (sample inside) | `ISSUED → RETURNED` | Closes the loop for that investigation or reference |
| **Unused and intact** | `ISSUED → IN_STOCK` (same location) | `cleared_at` is set on its `links`; the earlier `ISSUED` and this `RETURNED_UNUSED` event stay in the ledger. If the location has `allow_unused_reuse` off, this outcome voids the unit with reason `UNUSED` instead |
| **Unusable** | `ISSUED → VOIDED` | Reason required (broken, contaminated, wrong tube, ...) |

For `QUANTITY` items the same three outcomes apply to a quantity: used (nothing to return), unused (`RETURNED_UNUSED` adds it back to the batch balance), or wasted (`WASTED` with a reason).

Anything still `ISSUED` past the threshold appears on the outstanding report.

### 7.6 Void
Used for units voided outside a return, for example expired or damaged stock found on the shelf, or a bottle whose investigation was cancelled. Scan the unit (or enter a quantity) and choose a reason; the state becomes `VOIDED` (or `WASTED` for quantities). Items that come back from a patient go through the return flow (7.5) instead.

### 7.7 Stock count (bulk items)
For `QUANTITY` items nobody scans every use, so accountability comes from regular counts compared with what the ledger expects (`/distribution/counts`).

1. **Count blind.** The attendant sees every bulk batch the ledger says is on the shelf at the location, with no quantities, and enters what is physically there. A blank row means "not counted" and is left out; 0 means "none left".
2. **Submit.** The server reads the ledger balance for each counted batch and stores it as the expected figure. Only now are the expected figures and variances shown. Only batches already on the books at the location can be counted; extra stock with no batch still goes through stock-in.
3. **Review and post.** Each line with a variance needs a reason of the matching direction (short: used but not recorded, damaged or expired, lost or cannot be found, other; over: a receipt was counted short, returned or restocked and not recorded, other). "Other" also needs a note. Posting writes one `ADJUSTED` event per variance line and marks the count `POSTED`.
4. **If stock moved** while the count was open, posting refreshes the expected figures and writes nothing; the person reviews the new variances and posts again.
5. **Cancel.** An open count can be cancelled with no change to stock, and the attendant can count again.

A location's target and minimum per item are set on `/admin/par-levels` (one form per location). On the new-request page, **Suggest from target stock** pre-fills the request with `target - on hand - on the way` per item, never below zero. "On hand" is the ledger balance (the last posted count plus anything received since; bottles are counted from their units). "On the way" is submitted requests, approved quantities not yet dispatched, and dispatched quantities not yet received; drafts are ignored. This differs from the first spec ("target minus counted"), because it avoids asking again for stock that is already coming. Nothing is created until the person saves the request.

## 8. Business rules (enforced in `domain/rules.ts`)

- A unit can only be dispatched from the location where it currently is, and only from `IN_STOCK`.
- A unit can only be received on the transfer it was dispatched on.
- A unit can only be issued at the location it was received into.
- Container type must match the test's requirement; mismatches are blocked (supervisor override is logged).
- Expired stock cannot be dispatched or issued.
- Issue follows `issue_policies`: `MUST_BE_PAID` blocks issuing while the EMR-reported payment is unpaid (and records `UNVERIFIED` when payment can't be read), `CHARGE_TO_ADMISSION` allows issuing to inpatients without prepayment, `NONE` applies no check and records `NOT_REQUIRED`. Payment is whatever the EMR's own response says; the tracker does not judge it. Currently every rule is `NONE` (see 7.4).
- One serialized unit may be linked to several investigations of the **same patient**; linking one unit to different patients is blocked.
- Terminal states (`RETURNED`, `VOIDED`, `WRITTEN_OFF`) cannot transition further.
- A unit returned unused goes back to `IN_STOCK` only at the location it was issued from, and only if that location allows reuse; its links are cleared, but the earlier events are never altered.
- Every state change writes exactly one event, in the same DB transaction.
- Supervisor overrides require a reason and are flagged in reports.

## 9. Reference integration (investigations and more)

Formats confirmed from the staff portal: investigation numbers are `IXS` plus a sequence (e.g. `IXS181`), one per test; MRNs are `UATH/PT/` plus digits.

```ts
type ReferenceType =
  'INVESTIGATION' | 'ADMISSION' | 'VISIT' | 'PROCEDURE' | 'SURGERY' | 'DEPARTMENT';

interface ReferenceProvider {
  lookup(type: ReferenceType, ref: string): Promise<{
    exists: boolean | 'unknown';
    patientHospitalNo?: string;
    patientType?: 'OUTPATIENT' | 'INPATIENT' | 'WALK_IN';
    paymentStatus?: 'PAID' | 'UNPAID' | 'CHARGED_TO_ADMISSION' | 'unknown';
    destination?: string;           // e.g. Main Lab, FAST TRACK
    items?: { code: string; name: string; requiredContainer?: string }[];
  }>;
  listPendingForPatient(mrn: string): Promise<ReferenceSummary[]>; // powers the MRN-first issue screen
}
```

| Provider | Stage | Behaviour |
|---|---|---|
| `manual` | Now | Validates format only (`lib/reference-formats.ts`); returns `unknown` for existence and payment |
| `csv` | Reads `investigation_imports` | Checks against `investigation_imports`, which the extension now fills from the portal (an upload is only for a one-off backfill); powers the orphan-issue report and the MRN-first issue screen |
| `extension` | Live | The Chrome extension (section 17) reads the portal's own investigation responses and records them; `reference_source = extension` |
| `emr` | Later | Real lookup against the EMR; `reference_source` becomes `emr` |

Also check whether the EMR's printed request slip carries a barcode or QR. If it does, issuing becomes two scans (bottle, slip) with no typing, which removes most typo risk before any integration exists.

## 10. Offline and sync

- Each scan creates an event with a client-generated UUID and is stored in IndexedDB immediately.
- `sync.ts` posts batches to `/api/events`; the server processes each event idempotently by `id`.
- The server re-validates every event against current state. Events that are no longer valid (e.g. a bottle was voided elsewhere meanwhile) are rejected and surfaced in a "needs attention" list instead of failing silently.
- `occurred_at` (device time) and `recorded_at` (server time) are both kept, so delayed syncs are visible in audits.

## 11. Labels and hardware

- **Bottle serial label:** Code 128 of the serial plus human-readable text; small enough for sample bottles.
- **Batch/box label (`QUANTITY` items):** Code 128 of the batch code, item name, lot, and expiry.
- **Transfer slip:** `TRF-…` barcode, from/to locations, expected quantity, date, dispatching staff.
- **Issue label:** investigation numbers (all tests sharing the tube), patient MRN, tests, date.
- **Scanners:** any USB/Bluetooth HID scanner; `ScanInput` keeps focus and treats Enter as end-of-scan.
- **Printer:** Zebra-class label printer via ZPL; PDF output as a fallback for office printers.

## 12. Roles and permissions

| Role | Can |
|---|---|
| `STORE_KEEPER` | Stock in, create/dispatch transfers, view store reports |
| `DISTRIBUTOR` (lab attendant, ward store nurse, theatre store, and so on) | Receive, issue, return (used / unused / unusable), void at their own location |
| `SUPERVISOR` | Everything above plus resolve discrepancies, approve overrides, all reports |
| `AUDITOR` | Read-only access to all reports and bottle histories |
| `ADMIN` | Manage users, locations, item types, issue policies, test catalog, imports |

Two permissions were added with stock counts (chosen per role on Admin > Roles like the others): `count_stock` (count bulk items at the person's own location and post the variance; given to `STORE_KEEPER`, `DISTRIBUTOR`, `SUPERVISOR` and `ADMIN`) and `manage_par_levels` (set target and minimum stock per location; given to `SUPERVISOR` and `ADMIN`). Custom roles get neither until an admin ticks them.

Every event stores `user_id` (the EMR staff ID), so the reconciliation report can drill down to who handled what.

## 13. Reports

1. **Reconciliation:** dispatched, received, issued, returned (used), restocked (returned unused), voided or wasted, missing, on hand, **unaccounted**, per location and period, for serial and quantity items.
2. **Open discrepancies:** transfers with unscanned units or quantity shortfalls, with exact serials.
3. **Outstanding:** issued but not returned (used, unused or voided) past the threshold.
4. **Orphan issues:** links whose reference isn't in the EMR export.
5. **Unverified issues:** links recorded with `payment_check = UNVERIFIED`, for review until payment lookup is live.
6. **Bottle history:** the full event trail for one serial.
7. **Usage by reference:** which items and quantities were used per investigation, admission, procedure or department.
8. **Stock and reorder:** on hand per location against `reorder_level`.
9. **Expiring stock** (`/reports/expiring`): shelf stock per location and batch, soonest expiry first, over 30, 60 or 90 days. It also lists stock already expired but still on the shelf so it can be removed. Bottles already issued to a patient are left out.
10. **Count variances** (`/reports/stock-counts`): posted counts in a period (default the last 90 days), filtered by location. The table lists the lines that differed, with counted, expected, difference, reason and who counted; the totals above it cover all counted lines (lines counted, lines that differed, units short, units over). Needs `view_reports`.

## 14. Build order

| Milestone | Scope | Demo value |
|---|---|---|
| M1 | Auth, locations, item types (with tracking mode), manual batches, stock-in, serial labels | Labels print and scan |
| M2 | Dispatch and receive: per-unit for `SERIAL`, counted for `QUANTITY`, with discrepancy flagging | Shows the "which bottles are missing" answer |
| M3 | Issue against references with issue policies and many-to-many links; return (used / unused / unusable); void | Full store → patient trail |
| M4 | Reconciliation, outstanding, bottle-history reports | What the CMD actually wants to see |
| M5 | Offline queue and sync | Reliable in poor connectivity |
| M6 | CSV cross-checks: investigations (orphans, MRN-first issue screen) | Catches typos and phantom investigations |
| M7 | Removed (2026-10-21): the Pharmacy layering was dropped | |
| M8 | EMR reference provider: live investigation, admission and payment lookup | Native lookup, verified payment checks, optional charge write-back |

Pilot with sample bottles (`SERIAL`) at one side lab (EPU) after M4, then extend to other consumables.

**Change to M6 (2026-10-07):** investigations reach the tracker through the Chrome extension (section 17) instead of CSV uploads, so the investigation upload was removed.

## 15. Open questions

- Does the EMR's request slip already carry a barcode or QR?
- How are inpatient consumables billed today (Charges tab, Default Lab Consumables)? The tracker must not double-bill, and its usage links could later feed those charges.
- Formats of admission, visit, procedure and surgery numbers (for `reference-formats.ts`).
- Which item types are `SERIAL` and which are `QUANTITY` on day one? Proposed: sample bottles and specimen containers `SERIAL`, everything else `QUANTITY`.
- Which of the EMR's Lab Destinations map to the tracker's locations (including the EPU side lab)?
- Hospital policy on reusing bottles that left the lab unused: if not allowed, set `allow_unused_reuse` to false for those locations.
- Overdue threshold for outstanding bottles (default 24 h).
- Which label printer and scanner models will actually be used?
- **Should the tracker also prevent issuing bottles for unpaid investigations, or leave payment entirely to the EMR?** Pending a discussion with the CMD. Every issue policy is currently `NONE` (nothing blocked); the outpatient and walk-in rules can be set to `MUST_BE_PAID` without code changes.
- Production and staging portal hosts, and the LAN addresses and tracker certificate once the system moves to the hospital LAN (extension host matches, section 17.6).
- Should the extension sync only the open investigation and those with active bottle links, instead of every investigation the portal has loaded (section 17.5)?
- **From the hospital's consumables list (2026-10-11), none of these block building:**
  - What are the real pack sizes for each "Pack" item? (Placeholders are flagged unconfirmed until corrected.)
  - Which tests use plain tubes, which use gel, and which accept either (`alternate_container_types`)? (Serum tests that name a plain tube are seeded as also accepting GEL, as a best guess; every test is flagged unconfirmed on the Test catalog screen until the lab says so.)
  - Is "Main lab reception" a sub-store that holds stock, or only a reception desk? (Seeded as a `STORE`; if not, relax the sender rule to "holds stock".)
  - What are the target stock levels per service point? (Enter them on `/admin/par-levels`; until then "Suggest from target stock" has nothing to suggest.)
  - What does "LNG" stand for, and is "Pasture pipettes" a typo for "Pasteur"?
  - Parked: should the tracker accept the manufacturer's barcode on blood bags; should it do more than the display-only "Keep cold" tag it now shows for anti-sera and AHG (temperatures, alerts), and which kits and strips need it; and are formalin or histology containers, blood culture bottles and culture media supplied separately and to be tracked? Expected consumption per test is no longer parked: the lab defines a standard list per test (section 7.4, "Issue for a test") and confirms the quantities; whether the EMR's Default Lab Consumables setting should also be compared is still open.


## 16. EMR integration: layering on the Lab

### 16.1 Who owns what

| System | Owns |
|---|---|
| **Lab Tests / Inpatient / Outpatient** | Investigations (one per test), payment status, specimens, admissions, charges and invoices |
| **Tracker** | Item identity (serials), custody trail (who handled what, where, when), links from items to references, discrepancy detection |

The tracker answers "which one, who had it, and what was it used for".

### 16.2 How the layers connect
1. **Usage → references.** Links point at the EMR's investigation, admission, or procedure; later they can feed the existing charge and consumable-billing mechanisms.

### 16.3 What the EMR needs to expose
1. **Lab:** investigations by MRN and by number, with status, payment status, patient type, tests, destination, and cancellations.
2. **Inpatient and Outpatient:** admission and visit lookup by number or MRN, so non-lab issues can be linked.
3. **Departments and Destinations:** wards and lab destinations, for mapping `locations.external_id`.
4. **Staff identity:** SSO or shared staff IDs.
5. **Optional write-back:** show on the investigation which bottle was used, and push consumable charges to an admission.

### 16.4 Rollout
1. **Prepare mappings:** locations to Lab Destinations, staff IDs.
2. **Shadow mode:** run the Reference provider alongside manual or CSV data and log mismatches without blocking anyone.
3. **Turn on payment and reference lookup.**
4. **Add SSO and sync** of locations and the test catalog.
5. **Link the UIs:** an "Issue bottle" action on the investigation page that opens the tracker already on that patient.
6. **Backfill:** a one-time check of historical links against the EMR, then retire the CSV imports.

### 16.5 When the two systems disagree
- For *which* units exist and where they are, the tracker's scans win.
- Any difference is flagged and resolved by a supervisor with a reason; neither system is silently corrected to match the other.

Two things to do now to keep this easy: put the tracker's tables in their own Postgres schema (e.g. `consumables`) so they can move into the EMR's database later, and store only the reference and the patient's MRN, fetching anything else live so patient data stays in the EMR.

## 17. Staff portal extension (Chrome side panel)

### 17.1 Purpose
Attendants already work in the staff portal. The extension adds a side panel beside it so they can issue and return bottles for the investigation that is open, without switching tabs and without typing an investigation number. It also gives the tracker its investigation data without exports or EMR API access, which replaces the investigation CSV upload planned for M6.

### 17.2 How it works
The portal is a Flutter web app that paints onto a canvas, so there is no page text to read. The extension listens to the portal's own data instead.

| File | Role |
|---|---|
| `manifest.json` | Manifest V3; side panel; permissions `sidePanel` and `storage`; runs on the portal hosts |
| `page-hook.js` | Runs in the portal page before its own code. Reads a copy of the investigation and lab-test API responses and keeps only a whitelist of fields. Never alters what the portal sends or receives |
| `content.js` | Receives the kept fields from the page, relays them to the panel, forwards scanner input, and navigates the portal to an investigation |
| `sidepanel.html/.css/.js` | The panel: sign-in to the tracker, sync, Issue, Return and Look up |
| `background.js` | Opens the panel from the toolbar icon; holds no state and no tokens |

**Fields kept in the page:** investigation id and number, MRN, test name, payment status, status, destination, invoice number, admission id (used only to find other tests of the same admission that can share a bottle), whether an outpatient id is present, and the progress timestamps and names of the staff who started, prepared and verified. The patient's name, phone, date of birth, clinical summary, diagnosis, specimen and anything that looks like a result are dropped inside the page and never leave it.

### 17.3 The panel
- **Issue:** shows the open investigation; the attendant scans a bottle. Tests of the same patient that can share it (same container type, and same invoice for outpatients and walk-ins or same admission for inpatients) are offered with it, so one scan links them all. A supervisor can override a container mismatch (or an unpaid investigation, where a policy blocks it) with a reason. The issue label can be printed (see "Issue from stock" and "Printing" below).
- **Issue from stock and print:** a second way to issue, for when the attendant has no bottle in hand to scan. The panel sends the request with no serial and `fromStock: true`. The server picks a bottle from stock at the user's working location: only `IN_STOCK` bottles whose container type every test in the group accepts, expired batches skipped, earliest expiry first (no expiry last), at most five candidates looked up. `issueUnit` then runs all the usual checks (container, payment policy, patient, location, expiry) on the first candidate. If someone else issued that bottle between the lookup and the issue, the next candidate is tried; if all are gone the user is asked to try again. If nothing suitable is in stock, or the tests in one group need different containers, the request is refused with a plain message and nothing is issued. The scan path is unchanged and is the fallback when stock is empty.
- **Several bottles for one patient:** when the same patient has other pending tests that need a different container, the panel lists them under "These need a different bottle". The ticked tests are split into a plan of groups: tests that can share a bottle (same container, same invoice or admission) form one group and get one bottle, and each other group gets its own. Scanning issues the next bottle in the plan, one scan at a time. **Issue from stock** issues every bottle in the plan in one go (one `/api/ext/issue` call per group, in order). If a later group fails (for example nothing in stock), the bottles already issued stay issued, the error is shown with a button to print their labels, and the remaining groups can still be scanned.
- **Items used with the bottle:** the bulk items for the open test (swabs and so on, pre-filled from the test's standard items and editable in the panel) are sent with the open investigation's bottle only, and are issued in the same database transaction as that bottle, so a shortage of swabs leaves no bottle issued. They are never repeated for the other bottles of the plan.
- **Printing:** each issued bottle's label is fetched from the tracker (`/api/issues/[serial]/label?format=tspl`) and sent to the label print helper on the same PC (`scripts/print_bridge.py`, a localhost WebSocket on port 8767). The helper only accepts the tracker's address and the extension's ID, and only passes on plain label commands. After an issue from stock the labels print straight away; after a scanned issue the attendant presses Print. With several bottles the labels go through the helper one after the other, and a reprint prints them all again.
- **Return:** the same three outcomes as 7.5 (used, unused and intact, unusable).
- **Look up:** scan any bottle to see what it was issued for, or see which bottles an investigation has.
- **Sync:** every investigation the portal loads is recorded in `investigation_imports` the first time it is seen (`raw.source = portal`, queue `LAB`), and its status, invoice and progress are kept current. A sync failure never blocks issuing or returning.

### 17.4 Server endpoints (`/api/ext/*`)
Bearer-token authenticated and permission-checked like the web app; `/api/ext/issue` runs the same `issueUnit` rules as the Issue page (container, payment policy, patient, location, expiry). Logic lives in `extension.service.ts`.

| Endpoint | Purpose |
|---|---|
| `login`, `refresh`, `me` | Sign in with staff ID and password; refresh the token; who am I |
| `sync` | Record or update investigations read from the portal (batches of up to 50) |
| `test-match` | Which item types fit a test (container match) |
| `investigation-bottles` | Bottles already linked to an investigation |
| `issue`, `return` | Issue a bottle to the open investigation (and sharing tests); return it. `issue` takes either a `serial` (scanned) or `fromStock: true` (the server chooses the bottle); it is refused with "Scan the bottle" when neither is given |
| `active-refs` | Investigation numbers that have a bottle linked right now |
| `bulk-items` | Bulk items that can be added to the "items used" list in the panel |
| `unit/[serial]`, `bottle/[serial]` | Bottle state for the Issue/Return and Look up tabs |
| `void-reasons` | Reason list for unusable returns |

### 17.5 Security and privacy
- Tokens are kept in `chrome.storage.session`, which is cleared when the browser closes, so a shared lab PC does not keep a sign-in.
- The tracker address must be `https`; the panel refuses plain `http`.
- The page hook is read-only, and each step is wrapped so a failure cannot break the portal.
- What leaves the browser is the whitelisted fields above, sent to the tracker. As of this writing the sync sends every investigation the portal has loaded, not only the ones being issued. This is health data: it needs the hospital's sign-off and a data-protection review, and narrowing the sync is an open item (section 15).
- The tracker never stores payment on the investigation record. Payment is read at issue time and used only as input to the issue policy (7.4); the check result is stored on the link. With every policy currently `NONE`, issuing is not blocked on payment.

### 17.6 Deployment
- Needs a Chrome version with side panel support.
- Install through a managed Chrome policy, not as an unpacked extension.
- Until a managed install exists, each lab PC loads the `extension` folder unpacked, from one fixed folder that is a git clone (a sparse checkout of `extension/` is enough). Updating is a pull, then the refresh icon on the extension's card in `chrome://extensions`. An unpacked extension's ID comes from its folder path, so loading it from a new folder changes the ID, and the print helper then refuses the extension until its `--extension-id` is updated once.
- **Print helper:** each lab PC that prints labels also runs `scripts/print_bridge.py`, started at sign-in by a startup shortcut (the installer creates it; on a PC where the installer is blocked it is made by hand with `pythonw.exe`, the helper path, `--printer`, `--origin` and `--extension-id`). The setup steps and troubleshooting are in `scripts/print-helper/README.md`.
- **Server and extension are deployed separately.** A change to the app (for example the `fromStock` field on `/api/ext/issue`) reaches the lab only when the app is redeployed. An old server answers a newer extension with validation errors such as "expected string, received undefined"; the cure is to redeploy the server, not to reload the extension.
- The scripts currently run on `https://*.betacare.com.ng/*` (staging and production). Narrow this to the real hosts. When the system moves to the hospital LAN, update the host matches, make the tracker's certificate trusted on every lab PC, and pre-grant the tracker host permission by policy so attendants see no prompts.

### 17.7 Known limits
- It depends on the portal's undocumented API field names, so a portal update can break the reader. A diagnostic view shows the shapes of calls seen, without values. Ask Beta Care for a stable read endpoint or advance notice of changes.
- It only sees investigations the browser has loaded.
- Scanner input is recognised by its serial shape outside text fields; if the serial format changes, the recogniser must change with it.
- Issue from stock chooses by expiry only; it does not know which bottle is physically at the top of the shelf, so the label printed is the one for the bottle the server chose. If the attendant takes a different bottle, they should scan it instead.
- Printing needs the helper running on the same PC. If the helper is stopped, the issue still succeeds and the labels can be printed again later from the panel once the helper is running.
