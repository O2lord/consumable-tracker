import { sql } from "drizzle-orm";
import {
  boolean,
  customType,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgSchema,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import {
  BATCH_SOURCES,
  COLLECTOR_TYPES,
  EVENT_TYPES,
  IMPORT_KINDS,
  IMPORT_PAYMENT_STATUSES,
  INVESTIGATION_QUEUES,
  ISSUE_RULES,
  ITEM_RESOLUTIONS,
  LOCATION_TYPES,
  PATIENT_TYPES,
  PAYMENT_CHECKS,
  PHARMACY_IMPORT_KINDS,
  POLICY_PATIENT_TYPES,
  REFERENCE_SOURCES,
  REFERENCE_TYPES,
  REQUEST_STATUSES,
  SERVICE_ROLES,
  STOCK_COUNT_STATUSES,
  TRACKING_MODES,
  TRANSFER_STATUSES,
  UNIT_STATES,
} from "../domain/types";
import { decryptField, encryptField } from "../security/field-crypto";

// Mirrors supabase/migrations/*.sql. The SQL is the source of truth: change it there first.
// All tracker tables live in their own Postgres schema (architecture 16.6),
// so they can later move into the EMR's database.
export const consumables = pgSchema("consumables");

/**
 * A text column that is encrypted on the way in and decrypted on the way out, so the rest of the code sees the
 * plain value and the database only ever holds scrambled text (server/security/field-crypto.ts). The stored
 * value is different every time, so it can NOT be compared or searched: use the matching `_idx` blind index
 * column for that. Raw SQL and the report views return the scrambled value; decrypt it with decryptField.
 */
const encryptedText = (name: string, context: string) =>
  customType<{ data: string; driverData: string }>({
    dataType: () => "text",
    toDriver: (value) => (value == null ? value : encryptField(value, context)),
    fromDriver: (value) => (value == null ? value : decryptField(value, context)),
  })(name);

/** The column context each encrypted column is bound to (also what raw-SQL readers pass to decryptField). */
export const ENC_CONTEXT = {
  linksMrn: "links.patient_hospital_no",
  importsMrn: "investigation_imports.patient_hospital_no",
} as const;

const createdAt = timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();

// --- enums (values come from domain/types.ts) --------------------------------
export const locationType = consumables.enum("location_type", LOCATION_TYPES);
export const trackingMode = consumables.enum("tracking_mode", TRACKING_MODES);
export const unitState = consumables.enum("unit_state", UNIT_STATES);
export const batchSource = consumables.enum("batch_source", BATCH_SOURCES);

// --- Phase 0 ---------------------------------------------------------------
export const appMeta = consumables.table("app_meta", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  createdAt,
});

// --- Phase 1 ---------------------------------------------------------------
export const locations = consumables.table("locations", {
  id: uuid("id").primaryKey().defaultRandom(),
  code: text("code").notNull().unique(),
  name: text("name").notNull(),
  type: locationType("type").notNull(),
  externalSystem: text("external_system", { enum: ["PHARMACY", "LAB_DESTINATION", "WARD"] }),
  externalId: text("external_id"),
  allowUnusedReuse: boolean("allow_unused_reuse").notNull().default(true),
  // What this location does for stock (C2). Null means no restriction.
  serviceRole: text("service_role", { enum: SERVICE_ROLES }),
  active: boolean("active").notNull().default(true),
  createdAt,
  updatedAt,
});

/** What a person may do. Edited under Admin > Roles; the built-in rows are seeded by the SQL migration. */
export const roles = consumables.table("roles", {
  // Stable. Users point at it, so it never changes even when the name does.
  code: text("code").primaryKey(),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  permissions: text("permissions").array().notNull().default([]),
  locked: boolean("locked").notNull().default(false),
  createdAt,
  updatedAt,
});

export const users = consumables.table("users", {
  // Same id as auth.users.id (foreign key is defined in SQL).
  id: uuid("id").primaryKey(),
  staffId: text("staff_id").notNull().unique(),
  name: text("name").notNull(),
  // The role's code (roles.code).
  role: text("role").notNull().references(() => roles.code),
  homeLocationId: uuid("home_location_id").references(() => locations.id),
  active: boolean("active").notNull().default(true),
  createdAt,
  updatedAt,
});

export const itemTypes = consumables.table("item_types", {
  id: uuid("id").primaryKey().defaultRandom(),
  code: text("code").notNull().unique(),
  name: text("name").notNull(),
  category: text("category").notNull(),
  trackingMode: trackingMode("tracking_mode").notNull(),
  containerType: text("container_type"),
  unitOfMeasure: text("unit_of_measure").notNull().default("each"),
  reorderLevel: integer("reorder_level").notNull().default(0),
  pharmacyCatalogId: text("pharmacy_catalog_id"),
  // Which location service roles this item may be sent to (C2). Null means anywhere.
  allowedServiceRoles: text("allowed_service_roles").array(),
  // Display only: the ledger counts in the stock unit and never converts (C3).
  packSize: integer("pack_size").notNull().default(1),
  packSizeConfirmed: boolean("pack_size_confirmed").notNull().default(false),
  // Display only: items that must be kept in the fridge show a "Keep cold" tag (C9). Blocks nothing.
  coldStorage: boolean("cold_storage").notNull().default(false),
  // A shared bench supply (cotton wool, gloves, markers...): sent to the lab with a transfer, then taken off the
  // shelf by what the lab records under Used for test and checked in stock counts. Never listed against a test or a
  // patient. Blocks nothing on stock; it keeps the item out of the per-test lists, the extension's items-used list
  // and the Issue screen.
  benchSupply: boolean("bench_supply").notNull().default(false),
  active: boolean("active").notNull().default(true),
  createdAt,
  updatedAt,
});

/**
 * Everything that arrived from a supplier together. Each item line is a batch (own lot, expiry, quantity and label)
 * that points back here. Mirrors 20261015000300_deliveries.sql.
 */
export const deliveries = consumables.table(
  "deliveries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    code: text("code").notNull().unique(),
    supplier: text("supplier"),
    locationId: uuid("location_id")
      .notNull()
      .references(() => locations.id),
    // The supplier's invoice or delivery note number. Optional.
    reference: text("reference"),
    receivedBy: uuid("received_by")
      .notNull()
      .references(() => users.id),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt,
    updatedAt,
  },
  (t) => [index("deliveries_location_idx").on(t.locationId, t.receivedAt)],
);

export const batches = consumables.table(
  "batches",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    code: text("code").notNull().unique(),
    itemTypeId: uuid("item_type_id")
      .notNull()
      .references(() => itemTypes.id),
    lotNo: text("lot_no"),
    expiryDate: date("expiry_date"),
    supplier: text("supplier"),
    quantity: integer("quantity").notNull(),
    source: batchSource("source").notNull().default("MANUAL"),
    pharmacyGrnId: text("pharmacy_grn_id"),
    pharmacyBatchId: text("pharmacy_batch_id"),
    // The delivery this batch arrived in. Null for batches received before deliveries existed.
    deliveryId: uuid("delivery_id").references(() => deliveries.id),
    receivedBy: uuid("received_by")
      .notNull()
      .references(() => users.id),
    createdAt,
    updatedAt,
  },
  (t) => [index("batches_item_type_idx").on(t.itemTypeId)],
);

export const transfers = consumables.table(
  "transfers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    code: text("code").notNull().unique(),
    fromLocationId: uuid("from_location_id")
      .notNull()
      .references(() => locations.id),
    toLocationId: uuid("to_location_id")
      .notNull()
      .references(() => locations.id),
    status: text("status", { enum: TRANSFER_STATUSES }).notNull().default("DRAFT"),
    pharmacyTransferId: text("pharmacy_transfer_id"),
    pharmacyQuantity: integer("pharmacy_quantity"),
    pharmacySyncStatus: text("pharmacy_sync_status"),
    quantityMismatchNote: text("quantity_mismatch_note"),
    note: text("note"),
    // The stock request this transfer fills, if any (stock_requests, defined below).
    requestId: uuid("request_id"),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    dispatchedBy: uuid("dispatched_by").references(() => users.id),
    dispatchedAt: timestamp("dispatched_at", { withTimezone: true }),
    // Typed by the store keeper at dispatch; write-once in the database (C5). Null on transfers from before it existed.
    carriedByName: text("carried_by_name"),
    receiptStartedBy: uuid("receipt_started_by").references(() => users.id),
    receiptStartedAt: timestamp("receipt_started_at", { withTimezone: true }),
    receiptClosedBy: uuid("receipt_closed_by").references(() => users.id),
    receiptClosedAt: timestamp("receipt_closed_at", { withTimezone: true }),
    createdAt,
    updatedAt,
  },
  (t) => [
    index("transfers_status_idx").on(t.status),
    index("transfers_from_idx").on(t.fromLocationId),
    index("transfers_to_idx").on(t.toLocationId),
  ],
);

export const units = consumables.table(
  "units",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    serial: text("serial").notNull().unique(),
    itemTypeId: uuid("item_type_id")
      .notNull()
      .references(() => itemTypes.id),
    batchId: uuid("batch_id")
      .notNull()
      .references(() => batches.id),
    state: unitState("state").notNull().default("IN_STOCK"),
    currentLocationId: uuid("current_location_id")
      .notNull()
      .references(() => locations.id),
    currentTransferId: uuid("current_transfer_id").references(() => transfers.id),
    createdAt,
    updatedAt,
  },
  (t) => [
    index("units_state_idx").on(t.state),
    index("units_location_idx").on(t.currentLocationId),
    index("units_batch_idx").on(t.batchId),
  ],
);

/**
 * One physical pack or roll with its own barcode (PK...). Packs stay QUANTITY stock: the batch ledger is the only
 * authority on quantity, and nothing that reads it looks at this table. Not `units`, which means "a bottle" across
 * the app. Mirrors 20261015000400_pack_labels.sql (the check on pieces_remaining lives in the migration only).
 */
export const packs = consumables.table(
  "packs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    code: text("code").notNull().unique(),
    batchId: uuid("batch_id")
      .notNull()
      .references(() => batches.id),
    itemTypeId: uuid("item_type_id")
      .notNull()
      .references(() => itemTypes.id),
    locationId: uuid("location_id")
      .notNull()
      .references(() => locations.id),
    piecesPerPack: integer("pieces_per_pack").notNull(),
    piecesRemaining: integer("pieces_remaining").notNull(),
    createdAt,
    updatedAt,
  },
  (t) => [index("packs_batch_idx").on(t.batchId), index("packs_location_idx").on(t.locationId)],
);

export const events = consumables.table(
  "events",
  {
    // Client-generated UUID: makes offline sync idempotent.
    id: uuid("id").primaryKey(),
    unitId: uuid("unit_id").references(() => units.id),
    batchId: uuid("batch_id").references(() => batches.id),
    quantity: integer("quantity").notNull().default(1),
    // Loose pieces this event adds or removes (bulk batches only). Whole packs stay in `quantity`; a pure piece
    // movement has quantity 0. Mirrors 20261012000200_loose_pieces.sql.
    pieces: integer("pieces").notNull().default(0),
    type: text("type", { enum: EVENT_TYPES }).notNull(),
    fromState: unitState("from_state"),
    toState: unitState("to_state"),
    locationId: uuid("location_id")
      .notNull()
      .references(() => locations.id),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    transferId: uuid("transfer_id").references(() => transfers.id),
    referenceType: text("reference_type"),
    referenceRef: text("reference_ref"),
    reasonCode: text("reason_code"),
    note: text("note"),
    payload: jsonb("payload").notNull().default({}),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
    deviceId: text("device_id"),
  },
  (t) => [
    index("events_unit_idx").on(t.unitId, t.recordedAt),
    index("events_batch_idx").on(t.batchId, t.recordedAt),
    index("events_location_idx").on(t.locationId, t.recordedAt),
    index("events_user_idx").on(t.userId, t.recordedAt),
  ],
);

export const voidReasons = consumables.table("void_reasons", {
  id: uuid("id").primaryKey().defaultRandom(),
  code: text("code").notNull().unique(),
  label: text("label").notNull(),
  active: boolean("active").notNull().default(true),
  createdAt,
  updatedAt,
});

// --- Phase 2 ---------------------------------------------------------------
// The partial unique indexes on transfer_items (one row per unit or batch per transfer, and one
// serialized unit on at most one open transfer) live in the SQL migration only.
export const transferItems = consumables.table(
  "transfer_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    transferId: uuid("transfer_id")
      .notNull()
      .references(() => transfers.id),
    unitId: uuid("unit_id").references(() => units.id),
    batchId: uuid("batch_id").references(() => batches.id),
    quantityDispatched: integer("quantity_dispatched").notNull().default(1),
    // True when every quantity on this row (dispatched, received, missing, found, written off) is in loose pieces
    // rather than the item's own unit.
    inPieces: boolean("in_pieces").notNull().default(false),
    // The scanned pack these pieces come from, when a pack label was scanned. Mirrors 20261015000500_transfer_item_pack.sql.
    packId: uuid("pack_id").references(() => packs.id),
    quantityReceived: integer("quantity_received"),
    receivedAt: timestamp("received_at", { withTimezone: true }),
    receivedBy: uuid("received_by").references(() => users.id),
    quantityMissing: integer("quantity_missing").notNull().default(0),
    quantityFound: integer("quantity_found").notNull().default(0),
    quantityWrittenOff: integer("quantity_written_off").notNull().default(0),
    resolution: text("resolution", { enum: ITEM_RESOLUTIONS }),
    resolvedBy: uuid("resolved_by").references(() => users.id),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolutionNote: text("resolution_note"),
    open: boolean("open").notNull().default(true),
    createdAt,
    updatedAt,
  },
  (t) => [index("transfer_items_transfer_idx").on(t.transferId)],
);

// Which scanned packs make up a whole-pack transfer line. Mirrors 20261015000600_transfer_item_packs.sql (the partial
// unique index that keeps a pack on one open transfer lives in the migration only).
export const transferItemPacks = consumables.table(
  "transfer_item_packs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    transferItemId: uuid("transfer_item_id")
      .notNull()
      .references(() => transferItems.id, { onDelete: "cascade" }),
    packId: uuid("pack_id")
      .notNull()
      .references(() => packs.id),
    open: boolean("open").notNull().default(true),
    receivedAt: timestamp("received_at", { withTimezone: true }),
    createdAt,
  },
  (t) => [index("transfer_item_packs_item_idx").on(t.transferItemId)],
);

// One row per batch per transfer: the batch's lettered part (A, B, C ...) in dispatch order. Assigned
// when the transfer is confirmed. The unique constraints (batch, letter) and (batch, transfer) live in
// the SQL migration only.
export const transferBatchParts = consumables.table(
  "transfer_batch_parts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    batchId: uuid("batch_id")
      .notNull()
      .references(() => batches.id),
    transferId: uuid("transfer_id")
      .notNull()
      .references(() => transfers.id),
    partLetter: text("part_letter").notNull(),
    createdAt,
  },
  (t) => [index("transfer_batch_parts_transfer_idx").on(t.transferId)],
);

// --- Phase 3 ---------------------------------------------------------------
// The partial unique index on links (one active link per unit and reference) lives in SQL only.
export const testCatalog = consumables.table("test_catalog", {
  id: uuid("id").primaryKey().defaultRandom(),
  code: text("code").notNull().unique(),
  name: text("name").notNull(),
  requiredContainerType: text("required_container_type"),
  /** Other containers that also satisfy the test (corrections C4). Empty means only the required one. */
  alternateContainerTypes: text("alternate_container_types").array().notNull().default(sql`'{}'::text[]`),
  /** True once the lab has confirmed this test's container and its alternates. Display only: it blocks nothing. */
  containersConfirmed: boolean("containers_confirmed").notNull().default(false),
  /** True once the lab has confirmed this test's standard items and quantities. Display only: it blocks nothing. */
  consumptionConfirmed: boolean("consumption_confirmed").notNull().default(false),
  active: boolean("active").notNull().default(true),
  createdAt,
  updatedAt,
});

/**
 * What one run of a test normally uses (QUANTITY items only). It pre-fills the items on the Issue screen; the
 * person can change it there, and nothing leaves stock until they confirm. The unique (test, item) pair lives in SQL.
 */
export const testStandardItems = consumables.table(
  "test_standard_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    testId: uuid("test_id")
      .notNull()
      .references(() => testCatalog.id, { onDelete: "cascade" }),
    itemTypeId: uuid("item_type_id")
      .notNull()
      .references(() => itemTypes.id),
    quantity: integer("quantity").notNull(),
    createdAt,
    updatedAt,
  },
  (t) => [index("test_standard_items_item_idx").on(t.itemTypeId)],
);

export const issuePolicies = consumables.table("issue_policies", {
  id: uuid("id").primaryKey().defaultRandom(),
  referenceType: text("reference_type", { enum: REFERENCE_TYPES }).notNull(),
  patientType: text("patient_type", { enum: POLICY_PATIENT_TYPES }).notNull(),
  rule: text("rule", { enum: ISSUE_RULES }).notNull(),
  createdAt,
  updatedAt,
});

export const links = consumables.table(
  "links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    unitId: uuid("unit_id").references(() => units.id),
    batchId: uuid("batch_id")
      .notNull()
      .references(() => batches.id),
    quantity: integer("quantity").notNull().default(1),
    /** True when `quantity` is loose pieces of a pack item rather than the item's own unit (a per-test issue in pieces). */
    inPieces: boolean("in_pieces").notNull().default(false),
    referenceType: text("reference_type", { enum: REFERENCE_TYPES }).notNull(),
    referenceRef: text("reference_ref").notNull(),
    referenceSource: text("reference_source", { enum: REFERENCE_SOURCES }).notNull().default("manual"),
    testCode: text("test_code"),
    patientHospitalNo: encryptedText("patient_hospital_no", ENC_CONTEXT.linksMrn),
    // Searchable fingerprint of the MRN (HMAC, see field-crypto.ts). Set wherever patientHospitalNo is set.
    patientHospitalNoIdx: text("patient_hospital_no_idx"),
    patientType: text("patient_type", { enum: PATIENT_TYPES }),
    paymentCheck: text("payment_check", { enum: PAYMENT_CHECKS }).notNull(),
    issueEventId: uuid("issue_event_id")
      .notNull()
      .references(() => events.id),
    issuedBy: uuid("issued_by")
      .notNull()
      .references(() => users.id),
    locationId: uuid("location_id")
      .notNull()
      .references(() => locations.id),
    collectorType: text("collector_type", { enum: COLLECTOR_TYPES }),
    collectorName: text("collector_name"),
    overrideBy: uuid("override_by").references(() => users.id),
    overrideReason: text("override_reason"),
    clearedAt: timestamp("cleared_at", { withTimezone: true }),
    createdAt,
    updatedAt,
  },
  (t) => [
    index("links_unit_idx").on(t.unitId),
    index("links_reference_idx").on(t.referenceType, t.referenceRef),
    index("links_batch_idx").on(t.batchId),
  ],
);

// --- Phase 6 ---------------------------------------------------------------
export const syncLog = consumables.table("sync_log", {
  id: uuid("id").primaryKey().defaultRandom(),
  kind: text("kind", { enum: IMPORT_KINDS }).notNull(),
  source: text("source", { enum: ["FILE", "API"] }).notNull().default("FILE"),
  fileName: text("file_name"),
  detail: jsonb("detail").notNull().default({}),
  rowsTotal: integer("rows_total").notNull().default(0),
  rowsInserted: integer("rows_inserted").notNull().default(0),
  rowsUpdated: integer("rows_updated").notNull().default(0),
  rowsRejected: integer("rows_rejected").notNull().default(0),
  errors: jsonb("errors").notNull().default([]),
  importedBy: uuid("imported_by").references(() => users.id),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
});

export const investigationImports = consumables.table(
  "investigation_imports",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    investigationRef: text("investigation_ref").notNull().unique(),
    patientHospitalNo: encryptedText("patient_hospital_no", ENC_CONTEXT.importsMrn).notNull(),
    // Searchable fingerprint of the MRN (HMAC, see field-crypto.ts). Set wherever patientHospitalNo is set.
    patientHospitalNoIdx: text("patient_hospital_no_idx"),
    queue: text("queue", { enum: INVESTIGATION_QUEUES }).notNull().default("LAB"),
    testCode: text("test_code"),
    testName: text("test_name").notNull(),
    patientType: text("patient_type", { enum: PATIENT_TYPES }),
    paymentStatus: text("payment_status", { enum: IMPORT_PAYMENT_STATUSES }),
    destination: text("destination"),
    status: text("status"),
    amount: numeric("amount", { precision: 14, scale: 2 }),
    raisedAt: timestamp("raised_at", { withTimezone: true }),
    // Written by the Chrome extension from the portal page; see the 20261007001100 migration.
    invoiceNumber: text("invoice_number"),
    portalSyncedAt: timestamp("portal_synced_at", { withTimezone: true }),
    portalSyncedBy: uuid("portal_synced_by").references(() => users.id),
    // What the portal shows about progress (times and staff names only, never result values); see the
    // 20261008000100 migration.
    portalId: text("portal_id"),
    portalStartedAt: timestamp("portal_started_at", { withTimezone: true }),
    portalStartedBy: text("portal_started_by"),
    portalPreparedAt: timestamp("portal_prepared_at", { withTimezone: true }),
    portalPreparedBy: text("portal_prepared_by"),
    portalVerifiedAt: timestamp("portal_verified_at", { withTimezone: true }),
    portalVerifiedBy: text("portal_verified_by"),
    portalCompletedAt: timestamp("portal_completed_at", { withTimezone: true }),
    raw: jsonb("raw").notNull().default({}),
    syncLogId: uuid("sync_log_id").references(() => syncLog.id),
    importedAt: timestamp("imported_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt,
    updatedAt,
  },
  (t) => [
    index("investigation_imports_patient_idx").on(t.patientHospitalNoIdx),
    index("investigation_imports_status_idx").on(t.status),
  ],
);

// The unique (kind, natural_key) constraint and the expression index on the normalised batch number
// live in the SQL migration only.
export const pharmacyImports = consumables.table(
  "pharmacy_imports",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kind: text("kind", { enum: PHARMACY_IMPORT_KINDS }).notNull(),
    naturalKey: text("natural_key").notNull(),
    pharmacyRef: text("pharmacy_ref"),
    locationId: uuid("location_id").references(() => locations.id),
    locationLabel: text("location_label"),
    destinationLabel: text("destination_label"),
    genericName: text("generic_name"),
    strength: text("strength"),
    brand: text("brand"),
    itemLabel: text("item_label"),
    itemKey: text("item_key"),
    batchNo: text("batch_no"),
    expiryDate: date("expiry_date"),
    quantity: integer("quantity").notNull(),
    unitCost: numeric("unit_cost", { precision: 14, scale: 2 }),
    unit: text("unit"),
    category: text("category"),
    supplier: text("supplier"),
    transferType: text("transfer_type"),
    status: text("status"),
    requestedBy: text("requested_by"),
    requestedAt: timestamp("requested_at", { withTimezone: true }),
    lines: integer("lines"),
    raw: jsonb("raw").notNull().default({}),
    syncLogId: uuid("sync_log_id").references(() => syncLog.id),
    importedAt: timestamp("imported_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt,
    updatedAt,
  },
  (t) => [index("pharmacy_imports_location_idx").on(t.locationId, t.kind)],
);

// --- Phase 7 ---------------------------------------------------------------

// Mirrors 20261007000900_stock_requests_v2.sql. transfers.request_id references this table (foreign
// key in SQL only, to avoid a circular definition).
export const stockRequests = consumables.table(
  "stock_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    code: text("code").notNull().unique(),
    requestingLocationId: uuid("requesting_location_id")
      .notNull()
      .references(() => locations.id),
    storeLocationId: uuid("store_location_id")
      .notNull()
      .references(() => locations.id),
    status: text("status", { enum: REQUEST_STATUSES }).notNull().default("DRAFT"),
    note: text("note"),
    requestedBy: uuid("requested_by")
      .notNull()
      .references(() => users.id),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    reviewedBy: uuid("reviewed_by").references(() => users.id),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    reviewNote: text("review_note"),
    createdAt,
    updatedAt,
  },
  (t) => [
    index("stock_requests_status_idx").on(t.status, t.createdAt),
    index("stock_requests_requesting_idx").on(t.requestingLocationId, t.createdAt),
    index("stock_requests_store_idx").on(t.storeLocationId, t.status),
  ],
);

// One line per item type per request (unique constraint in SQL).
export const stockRequestLines = consumables.table(
  "stock_request_lines",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    requestId: uuid("request_id")
      .notNull()
      .references(() => stockRequests.id),
    itemTypeId: uuid("item_type_id")
      .notNull()
      .references(() => itemTypes.id),
    // True when the quantities below (requested, approved, dispatched, received) are in loose pieces.
    inPieces: boolean("in_pieces").notNull().default(false),
    quantityRequested: integer("quantity_requested").notNull(),
    quantityApproved: integer("quantity_approved"),
    quantityDispatched: integer("quantity_dispatched").notNull().default(0),
    quantityReceived: integer("quantity_received").notNull().default(0),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    closedBy: uuid("closed_by").references(() => users.id),
    closeReason: text("close_reason"),
    createdAt,
    updatedAt,
  },
  (t) => [index("stock_request_lines_request_idx").on(t.requestId)],
);

// --- Phase 7 (reconcile) -----------------------------------------------------
export const pharmacyReconcileRuns = consumables.table("pharmacy_reconcile_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  triggeredBy: text("triggered_by", { enum: ["JOB", "USER"] }).notNull(),
  provider: text("provider", { enum: ["manual", "csv", "emr"] }).notNull(),
  runBy: uuid("run_by").references(() => users.id),
  summary: jsonb("summary").notNull().default({}),
  problemsTotal: integer("problems_total").notNull().default(0),
  inventoryImportedAt: timestamp("inventory_imported_at", { withTimezone: true }),
  transfersImportedAt: timestamp("transfers_imported_at", { withTimezone: true }),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
});

// --- C7: par levels and stock counts ---------------------------------------------
// Mirrors 20261011000400_stock_counts.sql.

/** Target and minimum stock for one item type at one location (unique per pair in SQL). */
export const parLevels = consumables.table(
  "par_levels",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    locationId: uuid("location_id")
      .notNull()
      .references(() => locations.id),
    itemTypeId: uuid("item_type_id")
      .notNull()
      .references(() => itemTypes.id),
    targetQuantity: integer("target_quantity").notNull(),
    minimumQuantity: integer("minimum_quantity").notNull().default(0),
    createdAt,
    updatedAt,
  },
  (t) => [index("par_levels_item_idx").on(t.itemTypeId)],
);

/** One count at one location. OPEN until posted or cancelled; one open count per location (partial unique index in SQL). */
export const stockCounts = consumables.table(
  "stock_counts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    locationId: uuid("location_id")
      .notNull()
      .references(() => locations.id),
    status: text("status", { enum: STOCK_COUNT_STATUSES }).notNull().default("OPEN"),
    countedBy: uuid("counted_by")
      .notNull()
      .references(() => users.id),
    countedAt: timestamp("counted_at", { withTimezone: true }).notNull().defaultNow(),
    note: text("note"),
    postedBy: uuid("posted_by").references(() => users.id),
    postedAt: timestamp("posted_at", { withTimezone: true }),
    createdAt,
    updatedAt,
  },
  (t) => [index("stock_counts_location_idx").on(t.locationId, t.countedAt)],
);

/** One batch counted in a count (unique per count and batch in SQL). */
export const stockCountLines = consumables.table(
  "stock_count_lines",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    countId: uuid("count_id")
      .notNull()
      .references(() => stockCounts.id),
    batchId: uuid("batch_id")
      .notNull()
      .references(() => batches.id),
    // Sealed packs. Null when the packs of this batch were not counted (only the loose pieces were).
    countedQuantity: integer("counted_quantity"),
    expectedQuantity: integer("expected_quantity").notNull(),
    reasonCode: text("reason_code"),
    note: text("note"),
    adjustmentEventId: uuid("adjustment_event_id").references(() => events.id),
    // Loose pieces, counted separately from the sealed packs. Null when the pieces were not counted.
    // Mirrors 20261013000100_stock_count_pieces.sql.
    countedPieces: integer("counted_pieces"),
    expectedPieces: integer("expected_pieces").notNull().default(0),
    piecesReasonCode: text("pieces_reason_code"),
    piecesNote: text("pieces_note"),
    piecesAdjustmentEventId: uuid("pieces_adjustment_event_id").references(() => events.id),
    createdAt,
    updatedAt,
  },
  (t) => [index("stock_count_lines_count_idx").on(t.countId), index("stock_count_lines_batch_idx").on(t.batchId)],
);
