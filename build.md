# Consumables Barcode Tracker — Build Plan

Companion to `architecture.md`. That document says **what** the system is; this one says **what to build, in what order**, and tracks progress.

**How to use this file**
- Work phases in order. Each phase ends with a demoable result and a "Done when" check.
- Tick a task `[x]` when finished. When every task in a phase is ticked **and** its "Done when" check passes, change the phase status to `COMPLETE` and add the date.
- Phase numbers match the milestones in `architecture.md` section 14 (Phase 1 = M1, and so on). Phase 0 is setup.
- If scope changes, edit this file in the same change so it stays true.

**Status legend:** `NOT STARTED` · `IN PROGRESS` · `COMPLETE (date)`

**Task markers:** `[ ]` not started · `[~]` code written, **not yet built or tested** · `[x]` done and verified

## Working agreement: code first, test after

To keep momentum, we **write the code for a phase (or a coherent chunk of it) first, and do not run `build`, `lint`, `typecheck` or tests after each step.** Testing happens in one pass afterwards.

- New work is ticked `[~]` when the code is written. It becomes `[x]` only after the test pass for that phase.
- Each phase has a **Test pass** checklist at the end. Run it when the code for the phase is written: install dependencies, then `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`, then the manual checks listed.
- Fixes found in the test pass are made in that pass. A phase moves to `COMPLETE` only when its test pass is green and its "Done when" check passes.
- The phase 1 migrations and the earlier `[x]` items were verified when they were written; the rule above applies from the Phase 1 UI work onward.
- Test-suite note (2026-10-07): the ledger test for `TRUNCATE` accepts either the append-only trigger message or Postgres's foreign key refusal. Once `links.issue_event_id` references `events`, Postgres refuses `TRUNCATE` on the foreign key check before the statement trigger can fire. The ledger is still protected either way.

## Progress overview

| Phase | Scope | Status |
|---|---|---|
| 0 | Project and Supabase setup | COMPLETE (2026-10-06) |
| 1 | Auth, locations, item types, stock-in, serial labels | IN PROGRESS |
| 2 | Dispatch and receive, discrepancy flagging | IN PROGRESS |
| 3 | Issue, return, void | IN PROGRESS |
| 4 | Reports: reconciliation, outstanding, bottle history | IN PROGRESS |
| 5 | Offline queue and sync | IN PROGRESS |
| 6 | CSV cross-checks (investigations) | IN PROGRESS |
| Ext | Staff portal Chrome extension (side panel) | IN PROGRESS |
| 7 | Removed (2026-10-21): Pharmacy API layering dropped | REMOVED |
| 8 | EMR reference provider | NOT STARTED |
| 9 | Fit to the hospital's list (corrections.md) | IN PROGRESS |

**Pilot gate:** after Phase 4, pilot sample bottles (`SERIAL`) at the EPU side lab before extending to other consumables.

---

## Supabase decisions (apply to every phase)

These adjust the stack assumed in `architecture.md` section 3. Confirm or change before Phase 0.

| Concern | Decision |
|---|---|
| Database | Supabase Postgres. Tracker tables live in their own schema, `consumables` (per architecture 16.6), so they can move into the EMR database later |
| Migrations | Supabase CLI, SQL files in `supabase/migrations/` (replaces the `drizzle/` folder). Triggers, views and RLS are hand-written SQL anyway |
| Data access | Server only (Next.js route handlers and services) over the Postgres connection, using the service role or a pooled connection string. The browser never queries tables directly |
| Typed queries | **Decided:** Drizzle ORM + postgres.js over the Supabase connection string (needed for multi-statement transactions). Supabase CLI SQL migrations stay the source of truth; `server/db/schema.ts` mirrors them |
| Auth | Supabase Auth instead of Auth.js/Lucia. Staff log in with their **staff ID**; map it to a synthetic email such as `<staff_id>@tracker.local`. `users` table holds role and home location, keyed to `auth.users.id` |
| Authorization | Role checks in `server/auth/permissions.ts`, with RLS enabled as a second layer: deny all by default on `consumables` tables, since only the server touches them |
| Schema exposure | Do **not** add `consumables` to the API's exposed schemas unless a feature needs it. Keep it server-only |
| Secrets | Service role key and DB URL only in server env vars, never `NEXT_PUBLIC_` |
| Environments | Separate Supabase projects for dev and production at minimum |
| Notifications | **Decided (Phase 2):** no email or Realtime for now. "Notify" means the dashboard panel and the discrepancies report, which list the exact serials. Email would need SMTP credentials, so it is deferred |

---

## Phase 0 — Project and Supabase setup
**Status:** COMPLETE (2026-10-06)

_Verified: `/api/health` returned `{"ok":true,"database":"reachable","schemaVersion":"0"}` against the hosted Supabase project; `tsc`, `lint` and unit tests pass._

- [x] Create the Next.js (App Router) + TypeScript project with the folder layout from architecture section 6 (app moved to `/app`, `@/` alias now points to `/`, skeleton folders added)
- [x] Add Zod, Vitest and Playwright; set up lint and format (lint and Vitest verified passing; Playwright installed, its e2e test not yet run)
- [x] Create the Supabase project (dev). The CLI `init` and `link` step moved to the start of Phase 1, so later migrations are tracked and pushed with `db:push`
- [x] Create the `consumables` schema and set default privileges (no public access): migration `20261006000000_consumables_schema.sql`, applied to the hosted project through the SQL Editor
- [x] Write `.env.example`: `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `DATABASE_URL`, `SESSION_SECRET`, `PRINTER_HOST`, `OUTSTANDING_HOURS` (also un-ignored in `.gitignore`)
- [x] Server-side DB client in `server/db/client.ts` and a health-check route that reads from the database
- [x] Decide typed-query approach (generated types vs Drizzle) and record it in `README.md` — **Drizzle + postgres.js**, because the ledger needs real multi-statement transactions that the Supabase REST API cannot do
- [x] `README.md` with setup, env vars, how to run migrations, how to run tests
- [x] CI step that runs lint, typecheck and unit tests (`.github/workflows/ci.yml`; first run happens on your first push)

**Done when:** a fresh clone can run `npm run dev`, connect to Supabase, and the health route returns OK.

---

## Phase 1 — Auth, locations, item types, stock-in, serial labels (M1)
**Status:** IN PROGRESS

**Setup carried over from Phase 0**
- [x] Run `npx supabase init` and `npx supabase link --project-ref <ref>` so migrations are tracked; first migration marked applied with `migration repair`

**Database**
- [x] Migration `20261006000100_init.sql`: `users`, `locations`, `item_types`, `batches`, `units`, `events`, `void_reasons` (void reasons seeded in the migration; `users` has no `password_hash` because Supabase Auth holds passwords; `batches.code` added for box labels)
- [x] Migration `20261006000200_events_append_only.sql`: trigger rejecting `UPDATE`, `DELETE` and `TRUNCATE` on `events`, plus revoked privileges
- [x] Unique constraints (`units.serial`, `users.staff_id`) and RLS deny-by-default on all tables
- [x] `scripts/bootstrap-admin.ts`: creates the very first `ADMIN` account (Supabase Auth user + `users` row), prompting for staff ID, name and password. This is the only seeded record. Locations, item types, staff and roles are all created through the admin screens, not seeded

**Domain and services**
- [x] `domain/types.ts`, `domain/errors.ts`, `domain/state-machine.ts` (full transition table, even for later states)
- [x] `lib/serial.ts`: serial format (`CT` + 8 random chars + Luhn mod 32 check character, 11 characters) with validation and normalisation
- [x] `server/audit/events.ts`: the single place that appends to the ledger (idempotent by event id)
- [x] `stock-in.service.ts`: create a manual batch, mint serials for `SERIAL` items, write `STOCKED` events in one transaction (permission check is the caller's job; it comes with auth)

**Auth**
- [x] Login with staff ID and password through Supabase Auth (`app/(auth)/login`; `server/auth/session.ts` calls the Supabase Auth REST API, so no extra package is needed; login also requires an active `users` row)
- [x] Session handling, `permissions.ts` role map, role-based nav in `(app)/layout.tsx` (access token in an httpOnly cookie, checked with Supabase on each request; no silent refresh yet, so staff log in again when the token expires)

**UI and labels**
- [~] Admin screens: users, locations, item types, void reasons (`app/(app)/admin/*`; services in `catalog.service.ts` and `users.service.ts`; creating users and resetting passwords uses the Supabase Auth admin API with the service role key)
- [~] `store/stock-in` page, plus `store/stock-in/[batchCode]` for printing labels right after receiving
- [~] `lib/barcode.ts` (Code 128 via `bwip-js`), `lib/zpl.ts`, `lib/label-pdf.ts` (PDF fallback via `pdf-lib`, one label per page or an A4 sheet), `lib/printer.ts` (raw TCP to `PRINTER_HOST`, port 9100), `labels.service.ts`, `api/labels/route.ts` (GET for PDF/ZPL, POST to print)
- [x] `scripts/print-test-labels.ts` (`npm run print-test-labels`; writes `tmp/test-labels/`, add `--print` to send to the printer). Ran: 24 labels in PDF sheet, one-per-page PDF and ZPL
- [~] `ScanInput` component that keeps focus and treats Enter as end-of-scan
- [~] `store/label-check`: scan a printed label and see what the system knows about it (the "scanner reads it back" check). Added beyond the original list so the Phase 1 done-check can be demonstrated
- [~] Nav links and a `check_labels` permission (store keeper, distributor, supervisor)

**Tests**
- [x] Unit: state machine, serial and check digit, role permissions (42 tests)
- [x] Integration: ledger rejects update/delete/truncate; stock-in writes one `STOCKED` event per unit (run against the dev database inside a transaction that always rolls back)
- [x] Unit tests for ZPL output, printer host parsing, form helpers and admin schemas (`tests/unit/labels-and-forms.test.ts`, `tests/unit/admin-schemas.test.ts`); part of the 66 passing

**Test pass (run once, after the code above)**
- [x] `npm install` (new: `bwip-js`, `pdf-lib`), then `npm run typecheck`, `npm run lint`, `npm test` (66 passed), `npm run build` (all routes compile) — passed
- [x] Import styles for `bwip-js/node` and `pdf-lib` work in the Next build and in `npm run print-test-labels` (Node type-stripping); Zod `coerce` + `default` and the `Response` cast typecheck. Still to confirm by eye: that the generated PDFs open and the barcodes scan
- [ ] Log in as the bootstrap admin: add a STORE location, a SERIAL item type, a QUANTITY item type, a store keeper account; try to deactivate yourself and to change your own role (both must be refused); reset a password and log in with it
- [ ] Log in as the store keeper: stock in 10 sample bottles; the batch page opens; PDF (both layouts) and ZPL open or download; with `PRINTER_HOST` set, the print button sends them
- [ ] Stock in a QUANTITY batch: one box label, no units created
- [ ] Try to stock in an expired batch and into a non-store location (both refused with a clear message)
- [ ] `npm run print-test-labels`, print the sheet, scan each label on `store/label-check` with the hardware scanner: every code reads back exactly. Test labels should show "valid format, not in the system"; labels from a real batch should show the bottle's item, state and location
- [ ] Scan a label with one character altered by hand: reported as not a valid code
- [ ] Confirm the printed label size and layout on the actual printer; adjust `lib/zpl.ts` constants if the stock is not 50 x 25 mm

**Done when:** a store keeper logs in, creates a batch of sample bottles, prints labels, and a hardware scanner reads a printed label back correctly.

---

## Phase 2 — Dispatch and receive, discrepancy flagging (M2)
**Status:** IN PROGRESS (code written, test pass not run)

**Decisions made in this phase**
- Notification: dashboard panel plus the discrepancies report with exact serials; no email yet.
- Overcounts: a blind quantity count above what was dispatched is rejected with a "count again" message (it reveals only that the number is too high).
- Undo: only the dispatch draft can be undone (remove a line or the last scan). Receive scans have no undo, since a correction would need a new event type.
- `api/events` was read-only in Phase 2 (filter by serial or transfer). It now also accepts POST from the offline queue (Phase 5).
- Transfer code: `TRF` plus 8 random characters and a check character, no hyphen, matching the serial format.
- The slip prints the total expected only, never per-batch quantities, so bulk counts stay blind. A distributor's API view also hides per-batch dispatched quantities until the receipt closes.

**Database**
- [~] Migration `20261007000000_transfers.sql`: `transfers`, `transfer_items`, and the partial unique index (one serialized unit on at most one open transfer). **Not yet applied** (`npm run db:push`)
- [~] Same migration: `v_open_discrepancies`, `v_quantity_balance`

**Services**
- [~] `rules.ts`: right location, `IN_STOCK`, not expired, wrong-transfer rejection
- [~] `transfer.service.ts`: create transfer, scan units or enter batch quantities, confirm (units go `IN_TRANSIT`)
- [~] `receive.service.ts`: open receipt from the slip, per-unit scans for `SERIAL`, blind counts for `QUANTITY`, duplicate-scan handling, close receipt
- [~] On close: unscanned units become `MISSING_IN_TRANSIT`, transfer becomes `RECEIVED_WITH_DISCREPANCY`, quantity shortfalls recorded by batch
- [~] `discrepancy.service.ts`: supervisor resolves each item as found or written off, with a reason
- [~] Notify store keeper and supervisor with the exact serials (dashboard panel and discrepancies report; see decisions)

**UI and API**
- [~] `store/transfers` list (Drafts and History tabs, Start transfer pop-up) and detail (draft builder: scan bottles, bulk quantities, confirm, cancel)
- [~] `distribution/receive` (scan the slip) and `receive/[code]` with live "x of y", blind bulk counts, missing list and close
- [~] `reports/discrepancies` with resolve forms for supervisors; dashboard panel
- [~] Transfer slip with `TRF…` barcode (`lib/slip-pdf.ts`, `api/transfers/[ref]?format=pdf`)
- [~] `ScanSession` (with undo of last scan) and `ScanFeedback`
- [~] `api/transfers`, `api/transfers/[ref]`, `api/events` (read-only), `api/units/[serial]`

**Tests**
- [~] Unit: dispatch, receive and discrepancy rules (`tests/unit/transfer-rules.test.ts`)
- [~] Integration: dispatch 50, receive 48 ends with exactly those 2 serials missing and resolvable; wrong-transfer, duplicate and wrong-location scans; bulk short count resolved as a split (`tests/integration/transfers.test.ts`, rolls back; the 50/48 test is slow, with a 5 minute timeout)
- [~] Every state change writes exactly one event in the same transaction (asserted in the 50/48 test: 100 events for 50 + 48 + 2)

**Test pass (run once, after the code above)**
- [x] `npm run db:push` to apply the transfers migration (only now that the schema and services have landed together)
- [x] `npm run typecheck`, `npm run lint`, `npm run build` pass (2026-10-07; fixed one wrong import path in `receive/[code]/ReceiveSession.tsx`)
- [x] `npm test` green after `db:push` (2026-10-07; the 50/48 transfer test passes, about 4.5 minutes; re-run green with all later phases, 167 tests)
- [ ] Manual: as a store keeper, start a transfer, scan bottles, add a bulk batch, confirm, open the slip PDF and scan its barcode on `store/label-check`
- [ ] Manual: as a distributor at the destination, scan the slip, scan all but two bottles, count the bulk batch short, close; confirm the missing list names the two serials
- [ ] Manual: as a supervisor, resolve both on the discrepancies page; check the dashboard counts fall to zero
- [ ] Manual: a distributor at another location cannot open the transfer; a bottle from another transfer is rejected on scan

**Done when:** dispatching 50 bottles and receiving 48 produces a discrepancy naming the exact 2 missing serials, and a supervisor can resolve them.

---

## Phase 3 — Issue, return, void (M3)
**Status:** IN PROGRESS (code written 2026-10-07, test pass not run)

**Decisions made in this phase**
- Payment: `MUST_BE_PAID` blocks only when a reference is *known* to be unpaid. When payment cannot be checked (the manual provider always says unknown) the link is recorded `UNVERIFIED` and shown in reports, never passed silently.
- Overrides: a supervisor can override a container mismatch or an unpaid reference, with a reason. It is stored on the links (`override_by`, `override_reason`) and in the event payload, for the reports.
- Unused return where `allow_unused_reuse` is off: voided with reason `UNUSED`, links cleared. Unusable returns keep their links (history of what the bottle was issued for); voiding an issued bottle outside a return clears them.
- Quantity items: `ISSUED` and shelf `WASTED` leave the balance; `RETURNED_UNUSED` adds back; a `WASTED` from a return (`payload.source = 'RETURN'`) changes nothing, because the quantity already left at issue. A return can never exceed `v_quantity_issued_outstanding`.
- A bottle is linked to all references of one group in a single scan. Adding a further investigation to an already-issued bottle is not supported yet (issue the group together, or return it and re-issue).
- Existing test and container data: a test's `required_container_type` must equal the item type's `container_type` (both upper-case).

**Database**
- [~] Migration `20261007000100_issue_return_void.sql`: `links`, `issue_policies`, `test_catalog`, plus `v_quantity_issued_outstanding` and a new `v_quantity_balance`. **Not yet applied** (`npm run db:push`)
- [~] Constraint: `links` unique per (`unit_id`, `reference_type`, `reference_ref`) while `cleared_at` is null
- [~] Default issue policies seeded in the migration (outpatient/walk-in `MUST_BE_PAID`, inpatient `CHARGE_TO_ADMISSION`, others per reference type); the test catalog is entered through its admin screen

**Integration seam**
- [~] `ReferenceProvider` interface and `manual.provider.ts` (format validation only), selected in `server/integrations/reference/index.ts`
- [~] `lib/reference-formats.ts` (`^IXS\d+$`, `^UATH/PT/\d+$`; others permissive, to confirm)

**Services**
- [~] `issue.service.ts`: policy check, one bottle linked to several investigations of the same patient, block cross-patient linking, record collector, `payment_check = UNVERIFIED` when unverifiable
- [~] `return.service.ts`: three outcomes (used, unused back to `IN_STOCK` with links cleared, unusable voids), honouring `allow_unused_reuse`
- [~] `void.service.ts`: void with reason, `WASTED` for quantities
- [~] Quantity-item equivalents for issue, return and wastage
- [~] Supervisor override with a mandatory reason, stored for the reports (the report itself is Phase 4)
- [~] `stock.service.ts`, `policy.service.ts`, and `domain/issue-rules.ts` (pure rules)

**UI**
- [~] `distribution/issue`, `return`, `void`, `stock` (supervisors pick the location they work at; everyone else uses their own)
- [~] Issue label printing (investigation numbers, MRN, tests, date): `lib/issue-label-pdf.ts`, `api/issues/[serial]/label`, linked from the issue screen
- [~] Admin: test catalog, issue policies
- [~] Nav links for all of the above

**Tests**
- [~] Unit: issue policies, container-type match, expiry, terminal states, return decisions, reference formats (`tests/unit/issue-rules.test.ts`)
- [ ] Integration: issue, return unused, re-issue to another patient keeps the full history (not written yet)
- [ ] E2E (Playwright): store → lab → patient, including a missing bottle

**Test pass (run once, after the code above)**
- [x] `npm run db:push` (applies the Phase 3 migration; pushed 2026-10-07 together with the Phase 4 migration)
- [x] `npm test` green (2026-10-07, 167 tests, including `issue-rules.test.ts`), and `npm run typecheck`, `npm run lint` and `npm run build` pass with the Phase 3 routes in the build. Note that no integration test exercises issue, return or void against the database yet, so the manual checks below are the only proof of those flows
- [ ] Manual: as an admin add a test (for example LFT needing PLAIN) and check the default policies; as a distributor issue one bottle to two investigations of one patient (one scan, two links), print the label, scan it back on return as used
- [ ] Manual: issue with the wrong container (blocked), then as a supervisor override with a reason; try to link a bottle to a second patient (blocked)
- [ ] Manual: return unused (back in stock, links cleared), then re-issue to another patient; at a location with reuse off, the same return voids it as UNUSED
- [ ] Manual: issue 5 of a bulk batch, return 2 unused and waste 1, confirm the stock page shows the right on-hand and out figures; void a bottle on the shelf

**Done when:** a bottle can be traced from stock-in to a patient's investigation and back through each return outcome, with every step in the ledger.

---

## Phase 4 — Reports (M4)
**Status:** IN PROGRESS (code written 2026-10-07, not run against the database)

**Decisions made in this phase**
- The reconciliation is a SQL function `location_reconciliation(from, to)` rather than the planned view, because it takes a period. Every figure comes from the ledger; each event has a shelf effect on the location where it happened (the same arithmetic as `v_quantity_balance`, applied to serialized units too).
- "Unaccounted" exists for serialized items only: units actually `IN_STOCK` now (the units table) minus the ledger balance now. Bulk items have no independent count to compare with, so they show n/a until physical stock counts exist.
- `v_unit_ledger_mismatch` is the second integrity check: units whose state differs from their latest event's `to_state`, or that have no events.
- The report service is `report.service.ts` (not `reconciliation.service.ts`) because it also serves the outstanding, unverified, override, mismatch and bottle reports.
- Stock levels per location stay on `distribution/stock` (Phase 3); the dashboard shows the report counts.
- Reports are for `view_reports` (supervisor and auditor); the discrepancies report keeps its own `view_discrepancies` permission.

- [~] Migration `20261007000200_reports.sql`: `location_reconciliation()`, `v_outstanding_issued`, `v_unverified_issues`, `v_issue_overrides`, `v_unit_ledger_mismatch`. **Not yet applied** (`npm run db:push`)
- [~] `report.service.ts`
- [~] Reconciliation report per location and period (serial and quantity): `reports/reconciliation`. Drill-down to staff and day is not built; the bottle page covers the per-bottle drill-down
- [x] Discrepancies report (Phase 2)
- [~] Outstanding report using `OUTSTANDING_HOURS` (default 24): `reports/outstanding`
- [~] Bottle history page (`reports/bottle/[serial]`, with a search page at `reports/bottle`), including everything the bottle was issued for
- [~] Unverified-issues report, with supervisor overrides and ledger mismatches: `reports/exceptions`
- [~] Dashboard: open transfers, discrepancies, outstanding bottles, exceptions
- [~] `api/reports/[name]` endpoints (reconciliation, outstanding, unverified, overrides, discrepancies, mismatches); role gating for `SUPERVISOR` and `AUDITOR`
- [ ] Integration test: "unaccounted" is zero on a clean test dataset and non-zero when a unit is changed without an event (not written yet)
- [x] `npm run db:push` (Phase 4 migration applied 2026-10-07) and `npm test` green (167 tests)
- [x] Typecheck, lint and build pass (2026-10-07; the build includes the report routes)
- [ ] Manual: run the Phase 2 and 3 flows, then check the reconciliation lines add up and the exceptions page is empty of mismatches

**Done when:** the CMD can pick a location and period and see where every bottle went. **Start the EPU pilot here.**

---

## Phase 5 — Offline queue and sync (M5)
**Status:** IN PROGRESS (code written 2026-10-07; typecheck, lint, build and all tests pass; the manual offline checks are still to do)

**Decisions made in this phase**
- **What can be queued:** receiving a bottle (`RECEIVE_UNIT`), which is the scan that happens in dead-Wi-Fi spots and the one the done-check names. The queue and endpoint are built to take more kinds later (issue and return are the likely next ones), but none are queued yet.
- **What still needs a connection:** opening a receipt (scanning the slip), counting bulk items, and closing the receipt. Closing is blocked while any scan on the device is unsent, so a bottle that is only waiting to sync is never reported missing.
- **Saved first, then sent:** every scan is written to IndexedDB, then sent. If the connection is up the person gets the server's answer for that scan straight away; if not it shows as "saved on this device" (a new `queued` state in the scan feedback) and waits.
- **Under the right name:** each queued scan carries who scanned it, and the server only applies it under that person's sign-in. Scans made under a different sign-in on a shared device are held (and listed), never applied under the wrong name.
- **Replays:** a repeated event id is a no-op whatever has happened since, including after the receipt closed. The server checks the id before anything else.
- **Stale scans:** re-checked by the same rules as an online scan (`receiveUnit`). A refused scan is shown at once when the person is waiting for the answer; one that is refused later goes on the needs-attention list, which lives on that device only (it is not stored on the server).
- **Device time:** `occurred_at` is the device's clock, `recorded_at` the server's. A device time more than 5 minutes in the future is replaced by the server's time and flagged in the payload (`clockSkew`).
- **Service worker:** caches the app's scripts and styles, the icon, an offline page, and the receive pages only (so an open receipt can be reloaded offline). Everything else signed-in is never kept, and the kept pages are deleted when the login page loads, so the next person on a shared PC does not inherit them. Registered in production only.
- **Manifest:** `app/manifest.ts` (Next's convention) instead of `public/manifest.json`.
- **Not done:** no silent session refresh exists yet (an existing limitation), so after about an hour offline the first sync shows "Sign in again to send" and sends once the person has. Queued scans are kept meanwhile.

- [~] `offline/device.ts`: stable `device_id`
- [~] `offline/queue.ts`: IndexedDB queue of scan events with client-generated UUIDs
- [~] `offline/sync.ts` (loop, retry with backoff) and `offline/sync-core.ts` (the pure parts)
- [~] `POST /api/events`: `sync.service.ts` processes events idempotently by `id` and re-validates each against current state
- [~] "Needs attention" list for rejected events (`/needs-attention`)
- [~] Service worker (`public/sw.js`), offline page, PWA manifest and icon
- [~] Offline and sync indicator in the layout (`components/offline/SyncStatus.tsx`)
- [x] Tests: `tests/unit/offline-sync-core.test.ts`; `tests/integration/sync.test.ts` covers duplicate delivery as a no-op, a retry after the receipt closed, a stale scan rejected with its reason, a scan under another user held, a future device time clamped, and `occurred_at` and `recorded_at` both stored
- [x] Test pass: `npm test` (2026-10-07, 12 files, 167 tests): `offline-sync-core.test.ts` (18) and all 8 `sync.test.ts` tests pass. The earlier 141-test run simply predated these two files; `vitest.config.ts` picks them up
- [ ] Manual test, with a production build (`npm run build && npm start`; the service worker does not run in dev): open a receipt online, switch the network off in the browser's dev tools, scan several bottles (each shows "saved on this device"; the header says Offline and counts them), reload the page offline (the receipt still opens), switch the network back on and watch the count drop to zero and the "x of y scanned" figure match
- [ ] Manual: scan the same bottle twice offline (second is flagged at once); close the receipt from a second device while the first is offline, then reconnect the first (its scans appear under Needs attention with the reason); sign out and in as someone else with scans waiting (they are held, not sent)

**Done when:** a receipt scanned entirely offline syncs correctly after reconnecting, with no duplicates and any conflicts visible.

---

## Phase 6 — CSV cross-checks (M6)
**Status:** IN PROGRESS

Built (2026-10-07): typecheck, lint and `npm test` (13 files, 181 tests) pass; migrations `20261007000300` and `20261007000400` are on the hosted project.

**Change of direction (2026-10-07): investigations come from the Chrome extension, not uploads.** Hundreds of investigations are raised daily, so exporting and uploading files does not scale, and all staff will use the extension. The extension now records each investigation in `investigation_imports` the first time it reads it or issues a bottle against it (`recordPortalInvestigation` in `extension.service.ts`; rows are marked `raw.source = "portal"`, queue `LAB`), and keeps status and invoice number current. The investigation upload was removed from `/admin/imports`. `importInvestigations` and `lib/import-parse.ts` are kept in the code, unused by any screen, in case a one-off backfill is needed. Payment is not stored from the portal and no longer blocks the extension panel: the EMR decides whether a test goes ahead. To stop the server blocking too, migration `20261007001200_issue_policies_none.sql` sets every issue policy rule to `NONE` (written, **not yet applied**: run `npm run db:push`). The orphan report now means "issued against a number never seen on the portal" (typed by hand, so a possible typo), not "not in an export". Not yet tested; needs a typecheck and a run through the extension.

**Pharmacy removed (2026-10-21):** everything to do with the EMR's Pharmacy module was taken out (imports, mismatch views and reports, reconcile runs, GRN receiving, the Pharmacy transfer link and the Pharmacy catalog link). Migration `20261021000100_remove_pharmacy.sql` drops the database side (**not yet applied**: run `npm run db:push`; take a backup first if any Pharmacy data might be wanted).

- [x] Migration: `investigation_imports`, `sync_log`, `v_orphan_issues`
- [x] `import.service.ts` (`importInvestigations`), `lib/import-parse.ts`
- [ ] `scripts/import-investigations.ts` (the upload page covers it; the CLI is optional)
- [x] `admin/imports` page (import history)
- [x] `csv.provider.ts` for references; MRN-first issue screen using `listPendingForPatient`
- [x] Orphan issues report (`/reports/orphans`)
- [ ] Check whether the EMR request slip carries a barcode or QR; if so, add slip-scan issuing

**Done when:** a typo'd or non-existent investigation number appears on the orphan report.

---

## Extension track — Staff portal side panel (architecture section 17)
**Status:** IN PROGRESS (code written, extension version 0.2.0; no automated tests yet, manual checks not run)

Added after the original plan. It replaces the investigation CSV upload planned for Phase 6 (see the Phase 6 change of direction) and is the way investigations reach the tracker today. It is a separate folder, `extension/`, loaded into Chrome; the server side is `app/api/ext/*` and `server/services/extension.service.ts`.

**Decisions made in this track**
- **Source of investigation data:** the portal's own API responses, read inside the page by `page-hook.js`; the portal is a Flutter canvas app, so nothing is read from the screen. Only a field whitelist is kept; the patient's name, phone, date of birth, diagnosis, specimen and results never leave the page.
- **Sharing a bottle:** tests of the same patient with the same container type can share one bottle: same invoice for outpatient and walk-in investigations, same admission for inpatient ones (inpatient tests have no invoice).
- **Payment:** read from the portal response and handed to the issue policy; never stored on the investigation record. **Every issue policy is currently `NONE`, so the tracker does not block issuing on payment.** Whether it should also stop bottles going out for unpaid investigations is to be discussed with the CMD; if yes, set the outpatient and walk-in investigation rules to `MUST_BE_PAID` on the Issue policies screen (no code change).
- **Tracker address:** `https` only.
- **Tokens:** kept in `chrome.storage.session`, cleared when the browser closes.
- **Issue from stock (added 2026-10-21):** a second way to issue with no scan. `/api/ext/issue` accepts `fromStock: true` in place of `serial`; the server picks the bottle (in stock at the working location, container accepted by every test in the group, expiry not passed, earliest expiry first) and `issueUnit` still runs every rule. If a candidate was taken meanwhile, the next one is tried. The panel then prints the label straight away.
- **Several bottles for one patient (added 2026-10-21):** tests that need a different container are listed under "These need a different bottle" and grouped into a plan, one bottle per group. Scanning issues one bottle at a time; Issue from stock issues the whole plan. If a later bottle fails, the ones already issued stay issued and their labels can still be printed. The items used (swabs) go only with the open investigation's bottle, in the same transaction.
- **Deployment of updates (added 2026-10-21):** each lab PC loads `extension/` unpacked from one fixed git clone and updates by pull plus refresh; the folder path decides the extension ID, which the print helper checks. The server is redeployed separately; an old server rejects the new request with "expected string, received undefined".

- [~] `extension/` (manifest, background, page-hook, content, side panel): Issue, Return and Look up tabs, scanner forwarding, portal navigation
- [~] `app/api/ext/*` routes and `extension.service.ts` (login, refresh, me, sync, test-match, investigation-bottles, issue, return, unit, bottle, void-reasons, active-refs, bulk-items)
- [~] Issue from stock: `fromStock` on `portalIssueSchema`, `stockBottleCandidates` in `extension.service.ts`, the "Issue from stock and print" button in `sidepanel.html/.js`. Written 2026-10-21; not yet seen working on a lab PC (the first try failed only because the hosted server still ran the old code)
- [~] Several bottles in one go: `issuePlan()` and the "Issue all N bottles from stock and print" button; partial failure keeps what was issued and offers to print it
- [~] Label printing from the panel through the local print helper (`scripts/print_bridge.py`, port 8767; setup in `scripts/print-helper/README.md`, manual start-at-login steps and extension-update steps added 2026-10-21)
- [~] Investigations recorded from the portal into `investigation_imports` (`raw.source = portal`), status, invoice and progress kept current
- [~] Inpatient tests grouped by admission so they can share a bottle
- [~] https-only tracker address
- [ ] Tests: unit tests for the field whitelist (page-hook) and the sibling-grouping rule; integration tests for `extension.service.ts` (issue, return, sync) against the database, including issue from stock (earliest expiry first, expired skipped, wrong container refused, nothing in stock, candidate taken meanwhile) and the several-bottle plan
- [ ] Manual: sign in from the panel, open an investigation on the portal, scan a bottle, check one scan links the sharing tests; return it in each outcome; supervisor override; token expiry and sign-in again; scanner input while the cursor is in a portal text field (must not be captured)
- [ ] Manual, issue from stock: press the button on a lab PC and check the label prints; with a patient who has tests needing two containers, check two bottles issue and two labels print; stop the helper and check the error offers a reprint; restart the PC without opening a terminal and check the helper starts by itself (`pythonw.exe` in Task Manager)
- [ ] Lab PC setup: for each PC that prints, a fixed extension folder (git clone), the startup shortcut for the helper with the right `--printer`, `--origin` and `--extension-id`, and a restart test
- [ ] Narrow the script host matches (`https://*.betacare.com.ng/*`) to the real staging and production hosts
- [ ] Narrow the sync to the open investigation and those with active bottle links, instead of every investigation the portal has loaded (privacy)
- [ ] Hospital sign-off and data-protection review for sending these fields to the tracker
- [ ] Managed install through a Chrome policy; confirm the Chrome version on the lab PCs supports the side panel
- [ ] LAN move: update the host matches, make the tracker's certificate trusted on the lab PCs, pre-grant the tracker host permission by policy
- [ ] Ask Beta Care for a stable read endpoint or advance notice of portal API changes

**Done when:** an attendant opens an investigation on the portal, scans a bottle in the side panel, and the bottle is issued to that investigation (and the tests that share it) without typing anything.

---

## Phase 7 — Removed (2026-10-21)
The Pharmacy API layering (GRN → batch, linked transfers, daily reconcile) was dropped together with all other Pharmacy code. Batches are entered manually (`source = MANUAL`). See the note under Phase 6.

---

## Phase 8 — EMR reference provider (M8)
**Status:** NOT STARTED

- [ ] `reference/emr.provider.ts`: investigation, admission, visit, procedure and surgery lookup; `reference_source = emr`
- [ ] Verified payment checks (`payment_check = VERIFIED`)
- [ ] Confirm admission, visit, procedure and surgery number formats and update `reference-formats.ts`
- [ ] SSO or shared staff IDs
- [ ] Sync locations and the test catalog from the EMR
- [ ] "Issue bottle" action on the EMR investigation page that opens the tracker on that patient
- [ ] Optional: write-back of the bottle used, and consumable charges to an admission
- [ ] One-time backfill check of historical links against the EMR, then retire the CSV imports

**Done when:** issuing a bottle verifies the investigation and payment live in the EMR, with no CSV involved.

---

## Phase 9 — Fit to the hospital's list (corrections.md)

Source: `corrections.md` (2026-10-11), written from the hospital's "List of consumables and service points". Items follow the working agreement: `[~]` = code written, `[x]` = test pass green.

**Status at 2026-10-11 08:15** (test pass updated 09:17: green, 348 of 348)
- Code complete and test pass green, awaiting live check: C1, C2, C3, C4 (apart from the lab's tube mappings), C5, C6, C7, C8.
- Code complete, docs done: C10.
- Code still to write: none for C1 to C8. The C3 piece-equivalent gaps were closed 2026-10-11 after 09:25 (see C3). Build-now work for C4 and C9 was also added then (see below).
- Values the lab still has to confirm (none of it blocks building; each is edited on an admin screen and flagged until confirmed): plain/gel mappings (C4), real pack sizes (C3), whether Main lab reception holds stock (C6), target levels (C7), and the parked C9 items.
- Migrations applied to the remote database: `20261011000100` to `20261011000400` (`000400` pushed 2026-10-11 08:07). **Not yet applied: `20261011000500_container_confirmed.sql` and `20261011000600_cold_storage.sql`.** Apply them (`supabase db push` for the hosted database, or `supabase db reset` for a local one) BEFORE running the integration tests or the app: the code now selects the new columns, so everything that reads `test_catalog` or `item_types` fails until they exist.
- Written 2026-10-11 after 09:25, not yet run or opened on screen: piece equivalents on the remaining pages, `test_catalog.containers_confirmed`, `item_types.cold_storage`. `tsc` shows only the stale `.next/types` errors and lint only the known ones. New unit tests are in `tests/unit/admin-schemas.test.ts` (not yet run: the project connector cannot run only unit tests).

- [~] **C1 Seed data.** `scripts/seed-consumables.sql` (idempotent): 37 item types and 21 locations. *Done when:* the admin screens list them, and a second run changes nothing. Seed applied to the dev database 2026-10-11.
- [~] **C2 Service roles.** Migration `20261011000100_consumables_list_fit.sql` (`locations.service_role`, `item_types.allowed_service_roles`), admin screens for both, and the dispatch rule in `confirmTransfer` (`assertServiceRoleAllowed`). A `STORE` destination is always allowed so reagents can pass through Main lab reception. Issue side (written 2026-10-11, not yet opened on screen): a bench section or the blood bank issues for its department only. The rule is `assertReferenceAllowedAtLocation` (`issue-rules.ts`, helper in `lib/issue-location.ts`), checked in `issueUnit` and `issueQuantity`, so the Issue page and the extension both obey it and an override does not bypass it. The Issue page offers only Department in "Issued for" at those places (supervisors: it follows the "Working at" pick). The extension panel gets `departmentOnly` from `/api/ext/me` and blocks issuing with a message. Collection points, stores and locations with no role are unrestricted. Unit tests in `tests/unit/issue-location.test.ts`. *Done when:* Anti-A to MMW is refused; to Haematology or Main lab reception it works; issuing a bottle to an investigation at Haematology is refused and a department issue there works.
- [~] **C3 Editable pack size.** `item_types.pack_size` and `pack_size_confirmed` (same migration), admin screen with an "Unconfirmed" badge and banner. Piece equivalents (written 2026-10-11, not yet opened on screen): `lib/pack-size.ts` and `components/ui/PackEquivalent.tsx` show "about 4,000 pieces" in lighter text, with an "unconfirmed" marker, beside pack quantities on Stock here (bulk tab), the Expiring stock report, the count review page and the count variance report. Items not counted in packs, or with a pack size of 1, show nothing. Unit tests in `tests/unit/pack-size.test.ts`. Also covered (written 2026-10-11 after 09:25, not yet opened on screen): the reconciliation report (Start and End columns; `getReconciliation` now returns the unit and pack size), the transfer detail page (Sent and Received on the bulk tab), the request page (Requested, Approved, Sent and Received, in the review table and the items table), the "Suggest from target stock" table on the new-request page (Suggested column), and the dashboard's Stock health tooltip (on hand, with the piece figure). The dashboard's "Bottles per location" chart counts serialized bottles, not packs, so it has nothing to convert. *Done when:* changing a pack size changes only displayed equivalents.
- [~] **C5 Carrier name at dispatch.** Migration `20261011000200_transfer_carrier.sql` (`transfers.carried_by_name`, write-once trigger); `confirmTransferSchema.carriedByName` required (2 to 100 characters); stored in `confirmTransfer`; "Carried by" field with recent-name suggestions on the dispatch confirm bar; shown on the transfer slip and the transfer detail page, under the heading on the receive screen (before opening, while receiving and on the closed summary), and on the discrepancy report (a "Carried by" entry in the people trail of each open transfer and a column in the history tab, both only for roles with `view_discrepancy_people`, with "Not recorded" for transfers sent before it was kept). Written 2026-10-11, not yet opened on screen. *Done when:* a dispatch without a carrier is refused, and editing it afterwards is rejected by the database.
- [~] **C4 Container types and alternates.** Migration `20261011000300_container_alternates.sql` (`test_catalog.alternate_container_types`), admin test-catalog screen, issue check (`issue.service.ts`) and extension matching (`extension.service.ts`) use the alternates. Build-now step (written 2026-10-11 after 09:25): serum tests that name a plain tube (VDRL, RVS, HIV-RDT, HBSAG, WIDAL, LIPID, RFT, LFT) are set to also accept GEL by `scripts/test-catalog.sql`, as a best guess, and every test carries `containers_confirmed` (migration `20261011000500_container_confirmed.sql`, false by default). The admin Test catalog screen shows an "Unconfirmed" badge per test, a banner with the count, and a "Container and alternates confirmed with the lab" tick in the add and edit forms. The flag blocks nothing. The seed only fills a test that is still unconfirmed and has no alternates, so confirmed or hand-edited tests are left alone. *Still to do:* the lab confirms or corrects each mapping (LFT and GXM were already marked "confirm with your lab"). *Done when:* a test accepting PLAIN or GEL can be issued either tube without an override, and a bottle outside both is still refused.
- [~] **C9 Parked items, build-now part: standard consumption per test.** Written 2026-10-12, not run and not opened on screen. Migration `20261012000100_test_standard_items.sql` (table `test_standard_items`: test, item type, quantity per test, one row per pair, RLS on with no policies; `test_catalog.consumption_confirmed`, false by default). Admin: the Test catalog screen has an "Items per test" column with an "Unconfirmed" badge, an "Items" dialog (`StandardItemsEditor.tsx`, `setStandardItemsAction`, `setTestStandardItems` in `policy.service.ts`) and a banner with the count; only QUANTITY item types can be listed, because a serialized bottle or tube is scanned and issued on its own. Issue: a third button, "Issue for test" on `/distribution/issue` (`TestFields` in `IssueForms.tsx`, `issueForTestAction`, `issueForTest` in `issue.service.ts`). Picking a test and a number of tests pre-fills the list (quantity per test x number); the person can change a quantity, remove a line or add another bulk item, and enters the department. On confirm, each line is drawn from the batches held at the working location, earliest expiry first, expired batches skipped, locking each batch; a shortfall refuses the whole issue. One `ISSUED` event and one link per batch drawn (reference type DEPARTMENT, test code on the link, no collector). The event payload carries `consumption: { testCode, tests, edited }`; `edited` is worked out on the server by comparing the confirmed lines with the standard. No standard quantities are seeded: the lab defines them. The flag blocks nothing. *Not built:* a report that separates edited issues from standard ones; the payload is stored but nothing reads it yet. *Done when:* a test with listed items issues them in one confirm, an edited list is marked `edited: true`, and a shortage issues nothing.
- [~] **C9 Parked items, build-now part: cold-storage flag.** Migration `20261011000600_cold_storage.sql` (`item_types.cold_storage`, false by default; sets ANTI-A, ANTI-B, ANTI-D and AHG once, and the seed sets the same on a fresh database). Display only: a "Keep cold" tag (`components/ui/ColdStorageTag.tsx`) on the Item types screen (with a tick in the add and edit forms), Stock here (bulk tab), the transfer detail page (bulk tab), the live receive screen and the closed receive summary. No temperatures, no alerts, nothing blocked. Kits and strips are not flagged, because the condition depends on the maker. Written 2026-10-11 after 09:25, not yet opened on screen. *Still parked, needs the hospital:* blood bag barcodes, and the missing items (formalin containers, blood culture bottles, culture media). *Done when:* an anti-serum shows "Keep cold" on those screens and a ticked item type shows it too.
- [~] **C6 Dispatch from locations other than the main store.** No code needed: the seed makes Main lab reception a `STORE`. If the lab says it is not a store, relax `createTransfer` to "the location holds stock". *Done when:* the main store dispatches to Main lab reception, and reception dispatches on to MMW.
- [~] **C7 Target stock per location and periodic stock counts.** Code written in three steps, not yet run against the database or opened on any screen.
  - Step 1, tables and par levels: migration `20261011000400_stock_counts.sql` (`par_levels`, `stock_counts`, `stock_count_lines`, one open count per location, RLS on with no policies, and the `count_stock` / `manage_par_levels` permissions added to the built-in roles); `par-level.service.ts`; `/admin/par-levels` (one bulk form per location; a blank target removes the par level).
  - Step 2, counts and variance posting: `stock-count-rules.ts` and `stock-count.service.ts`; `/distribution/counts` (blind count sheet) and `/distribution/counts/[id]` (expected figures and variances shown after submit, a reason per difference, post or cancel). Posting writes one `ADJUSTED` event per variance line. If stock moved while the count was open, the expected figures are refreshed and the person posts again.
  - Step 3, suggestion and report: "Suggest from target stock" on `/store/requests/new` (target minus on hand minus on the way, pre-fills the request); report `/reports/stock-counts` (sidebar, `view_reports`).
  - Migration `20261011000400` applied to the remote database 2026-10-11.
  - *Still to do:* try a count end to end (short, over, matching, and a movement while the count is open); try the suggestion on a location with a target; check the page for a location with no countable batches. *Done when:* a count lower than expected shows the variance, posts the adjustment with a reason, and the request screen proposes the shortfall.
- [~] **C8 Expiry.** `findEarlierBatch` in `transfer.service.ts` adds an amber "an earlier-expiring batch has stock here" note on the dispatch box card (never blocks); new report `/reports/expiring` (30, 60, 90 days, plus expired stock still on the shelf; issued bottles excluded), in the sidebar for `view_reports`. Not run against the database; neither screen opened. *Done when:* with two batches of HIV Determine, the dispatch screen proposes the one expiring first, and the report lists anything inside the window.
- [x] **C10 Documents:** `architecture.md` sections 5, 7.2, 13 and 15 updated (2026-10-11). C7 entries added the same day: section 5 (three tables and their constraints), new 7.7 (stock count flow and the request suggestion), section 12 (two permissions), section 13 (report 11) and section 15.

**Full test pass, 2026-10-11 09:05: 25 files, 348 tests, all green** (run against the hosted dev database, 613 seconds). Fixes that got it there: the permissions test now allows `manage_par_levels` for the Supervisor as documented in `architecture.md` section 12 (the code was right, the test was stale); the unused `totalBottles` prop was removed from the dashboard, so the only `tsc` errors left are in the stale `.next/types` folder (clears with `rm -rf .next`); and the integration timeouts were raised because each query to the hosted database costs a few hundred milliseconds (global limit 60s to 120s in `vitest.config.ts`; the 50/48 transfer test 300s to 900s, it took about 430s). The 50/48 test has now been seen to pass.

The checkboxes above stay `[~]` until the C5, C7 and C8 screens have had a live check in the browser; the code and the tests are green. A local database (Docker and `supabase start`, with `DATABASE_URL` in `.env.test.local`) is the way to make the suite fast; it has not been used for a full run yet.

`.env.example` held real Supabase credentials and was not git-ignored; they were replaced with placeholders. The database password and the service-role key should be rotated in the Supabase dashboard (then update `.env.local` and the hosting environment variables).

Test pass: C1 to C8 were checked with `tsc` only (two known errors: the `totalBottles` prop on the dashboard, since fixed, and a stale `.next/types` folder; lint errors in `SidebarNav.tsx` and `OfflineNotice.tsx` and a warning in `extension/content.js` are not from this phase). The last full test run, 2026-10-11 09:05, was 348 of 348 passing (see above). Migrations `20261011000200`, `20261011000300` and `20261011000400` are applied, but the C5, C7 and C8 screens still need a live check.

C5, C2 and C3 leftovers check (2026-10-11): `tsc` and lint show only the same known errors, none in the files changed. New unit tests: `tests/unit/issue-location.test.ts` and `tests/unit/pack-size.test.ts`; like the C7 tests they have not been run, because the project connector cannot complete a full test run.

C7 check (2026-10-11): `tsc` shows only the same errors as above (none in C7 files; one C7 error in `stock-count.service.ts` was fixed), and lint shows only the known errors. New unit tests are in `tests/unit/stock-count-rules.test.ts` (variance rules, reasons, shortfall maths, and the par-level, submit and post schemas). A full `test` run through the project connector timed out at its 230-second limit with no result, so those tests and the integration suite have not been seen to pass.

---

## Open items to resolve (from architecture section 15)

Tick each when answered and note the answer.

- [ ] Are consumables already in Pharmacy Catalogs and Inventory? (blocks Phase 7 design)
- [ ] Does the EMR request slip carry a barcode or QR? (Phase 6)
- [ ] How are inpatient consumables billed today, and how do we avoid double-billing? (Phase 8)
- [ ] Formats of admission, visit, procedure and surgery numbers (Phase 3 / 8)
- [ ] Which item types are `SERIAL` and which `QUANTITY` on day one? (Phase 1; proposed: bottles and containers `SERIAL`, the rest `QUANTITY`)
- [ ] Mapping of EMR Pharmacy Locations and Lab Destinations to tracker locations, including EPU side lab (entered through the Phase 1 admin screens, then mapped in Phase 7)
- [ ] Hospital policy on reusing unused bottles, to set `allow_unused_reuse` (Phase 3)
- [ ] Overdue threshold for outstanding bottles (Phase 4; default 24 h)
- [ ] Label printer and scanner models (Phase 1)
- [ ] Supabase: typed-query approach, notification channel, and whether `consumables` ever needs API exposure (Phases 0 and 2)
- [ ] Should the tracker also prevent issuing bottles for unpaid investigations, or leave payment entirely to the EMR? Pending a discussion with the CMD; every issue policy is `NONE` for now (Extension track)
- [ ] Production and staging portal hosts, and LAN addresses plus the tracker certificate for the LAN move (Extension track)
