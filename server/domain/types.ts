// Shared domain vocabulary. Pure: no I/O, no framework imports.
// db/schema.ts builds its enums from these arrays, so the two cannot drift apart.

export const LOCATION_TYPES = ["STORE", "LAB", "WARD", "THEATRE", "OTHER"] as const;
export type LocationType = (typeof LOCATION_TYPES)[number];

export const TRACKING_MODES = ["SERIAL", "QUANTITY"] as const;
export type TrackingMode = (typeof TRACKING_MODES)[number];

export const UNIT_STATES = [
  "IN_STOCK",
  "IN_TRANSIT",
  "MISSING_IN_TRANSIT",
  "ISSUED",
  "RETURNED",
  "VOIDED",
  "WRITTEN_OFF",
] as const;
export type UnitState = (typeof UNIT_STATES)[number];

/** The roles every install starts with. Their codes never change; admins can rename them and add more. */
export const USER_ROLES = ["STORE_KEEPER", "DISTRIBUTOR", "SUPERVISOR", "AUDITOR", "ADMIN"] as const;
export type BuiltInRole = (typeof USER_ROLES)[number];
/** A role's code (consumables.roles.code): one of the built-in codes, or one made for a custom role. */
export type UserRole = string;

export const BATCH_SOURCES = ["PHARMACY_GRN", "MANUAL"] as const;
export type BatchSource = (typeof BATCH_SOURCES)[number];

/** Where a location maps into the EMR (locations.external_system). */
export const EXTERNAL_SYSTEMS = ["PHARMACY", "LAB_DESTINATION", "WARD"] as const;
export type ExternalSystem = (typeof EXTERNAL_SYSTEMS)[number];

/**
 * What a location does for stock (locations.service_role). Null means "no restriction".
 * Collection points hand items to patients; benches and the blood bank consume them in the lab.
 */
export const SERVICE_ROLES = ["STORE", "COLLECTION_POINT", "BENCH", "BLOOD_BANK"] as const;
export type ServiceRole = (typeof SERVICE_ROLES)[number];

/** Pack size bounds (item_types.pack_size). It is display information only; the ledger never converts. */
export const PACK_SIZE_MAX = 100_000;

// --- C7: par levels and stock counts ----------------------------------------------

/** Bounds for par_levels.target_quantity and minimum_quantity. */
export const PAR_QUANTITY_MAX = 1_000_000;

/** stock_counts.status (a text column with a CHECK in SQL). A count is OPEN until posted or cancelled. */
export const STOCK_COUNT_STATUSES = ["OPEN", "POSTED", "CANCELLED"] as const;
export type StockCountStatus = (typeof STOCK_COUNT_STATUSES)[number];

/** Why a count came out lower than expected. Stored as the reason on the ADJUSTED event. */
export const COUNT_SHORT_REASONS = ["USED_NOT_RECORDED", "DAMAGED_OR_EXPIRED", "LOST_OR_MISSING", "OTHER"] as const;
/** Why a count came out higher than expected. */
export const COUNT_SURPLUS_REASONS = ["RECEIPT_COUNTED_SHORT", "RETURNED_NOT_RECORDED", "OTHER"] as const;
export type CountVarianceReason = (typeof COUNT_SHORT_REASONS)[number] | (typeof COUNT_SURPLUS_REASONS)[number];

/** Suggestions for item_types.category (a free-text column, so admins may add their own). */
export const ITEM_CATEGORY_SUGGESTIONS = [
  "SAMPLE_CONTAINER",
  "SURGICAL",
  "GENERAL",
  "PHLEBOTOMY",
  "PPE",
  "LAB_SUPPLY",
  "LABELLING",
  "REAGENT",
  "BLOOD_BANK",
] as const;

/** Suggestions for item_types.container_type on sample containers. */
export const CONTAINER_TYPE_SUGGESTIONS = [
  "EDTA",
  "PLAIN",
  "GEL",
  "FLUORIDE",
  "CITRATE",
  "ESR",
  "URINE",
  "STOOL",
  "SWAB",
  "CRYOVIAL",
  "FORMALIN",
  "HEPARIN",
] as const;

/** Void reasons the application logic relies on. They can be relabelled but never deactivated. */
export const PROTECTED_VOID_REASONS = ["UNUSED", "EXPIRED"] as const;

// Allowed values of events.type (a CHECK constraint in SQL, so it can grow in later phases).
export const EVENT_TYPES = [
  "STOCKED",
  "DISPATCHED",
  "RECEIVED",
  "ISSUED",
  "USED",
  "RETURNED",
  "RETURNED_UNUSED",
  "VOIDED",
  "WASTED",
  "ADJUSTED",
  "MISSING_IN_TRANSIT",
  "FOUND",
  "WRITTEN_OFF",
  // A sealed pack opened so loose pieces can be sent from it (quantity = packs opened, pieces = their pieces).
  "OPENED",
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

// Lifecycle of a transfer (a text column with a CHECK in SQL, so it can grow).
export const TRANSFER_STATUSES = [
  "DRAFT",
  "DISPATCHED",
  "RECEIVING",
  "RECEIVED",
  "RECEIVED_WITH_DISCREPANCY",
  "DISCREPANCY_RESOLVED",
  "CANCELLED",
] as const;
export type TransferStatus = (typeof TRANSFER_STATUSES)[number];

// A stock request from a lab to a store (a text column with a CHECK in SQL, so it can grow).
// DRAFT -> SUBMITTED -> APPROVED | REJECTED; APPROVED -> PARTIALLY_FULFILLED -> FULFILLED | CLOSED.
// A lab can CANCEL while DRAFT or SUBMITTED.
export const REQUEST_STATUSES = [
  "DRAFT",
  "SUBMITTED",
  "APPROVED",
  "REJECTED",
  "PARTIALLY_FULFILLED",
  "FULFILLED",
  "CLOSED",
  "CANCELLED",
] as const;
export type RequestStatus = (typeof REQUEST_STATUSES)[number];

/** What a supervisor can decide for a missing item. */
export const DISCREPANCY_RESOLUTIONS = ["FOUND", "WRITTEN_OFF"] as const;
export type DiscrepancyResolution = (typeof DISCREPANCY_RESOLUTIONS)[number];

/** transfer_items.resolution: SPLIT means a quantity item was partly found and partly written off. */
export const ITEM_RESOLUTIONS = ["FOUND", "WRITTEN_OFF", "SPLIT"] as const;
export type ItemResolution = (typeof ITEM_RESOLUTIONS)[number];

/** The person doing something. A session satisfies this, so services never import session code. */
export interface Actor {
  userId: string;
  role: UserRole;
  homeLocationId: string | null;
}

/** Actions that move a SERIAL unit between states (see architecture section 4). */
export const UNIT_ACTIONS = [
  "DISPATCH",
  "RECEIVE",
  "MARK_MISSING",
  "RESOLVE_FOUND",
  "WRITE_OFF",
  "ISSUE",
  "RETURN_USED",
  "RETURN_UNUSED",
  "VOID",
] as const;
export type UnitAction = (typeof UNIT_ACTIONS)[number];

// --- Phase 3: issue, return, void ---------------------------------------------

/** What an issued item is used for (links.reference_type). */
export const REFERENCE_TYPES = ["INVESTIGATION", "ADMISSION", "VISIT", "PROCEDURE", "SURGERY", "DEPARTMENT"] as const;
export type ReferenceType = (typeof REFERENCE_TYPES)[number];

export const PATIENT_TYPES = ["OUTPATIENT", "INPATIENT", "WALK_IN"] as const;
export type PatientType = (typeof PATIENT_TYPES)[number];

/** issue_policies.patient_type also allows ANY, the fallback for a reference type. */
export const POLICY_PATIENT_TYPES = ["OUTPATIENT", "INPATIENT", "WALK_IN", "ANY"] as const;
export type PolicyPatientType = (typeof POLICY_PATIENT_TYPES)[number];

export const ISSUE_RULES = ["MUST_BE_PAID", "CHARGE_TO_ADMISSION", "NONE"] as const;
export type IssueRule = (typeof ISSUE_RULES)[number];

export const PAYMENT_CHECKS = ["VERIFIED", "UNVERIFIED", "NOT_REQUIRED"] as const;
export type PaymentCheck = (typeof PAYMENT_CHECKS)[number];

export const REFERENCE_SOURCES = ["manual", "slip_scan", "csv", "emr", "extension"] as const;
export type ReferenceSource = (typeof REFERENCE_SOURCES)[number];

export const COLLECTOR_TYPES = ["PATIENT", "NURSE", "PORTER", "OTHER"] as const;
export type CollectorType = (typeof COLLECTOR_TYPES)[number];

/** The three outcomes when a SERIAL item comes back (architecture 7.5). */
export const RETURN_OUTCOMES = ["USED", "UNUSED", "UNUSABLE"] as const;
export type ReturnOutcome = (typeof RETURN_OUTCOMES)[number];

/** For QUANTITY items: unused goes back on the shelf, wasted needs a reason. */
export const QUANTITY_RETURN_OUTCOMES = ["UNUSED", "WASTED"] as const;
export type QuantityReturnOutcome = (typeof QUANTITY_RETURN_OUTCOMES)[number];

// --- Phase 6: imports ------------------------------------------------------------

/** Which work queue an investigation came from. Investigation numbers share one sequence across all of them. */
export const INVESTIGATION_QUEUES = ["LAB", "IMAGING", "OTHER"] as const;
export type InvestigationQueue = (typeof INVESTIGATION_QUEUES)[number];

/** investigation_imports.payment_status. Null means the export did not say (never guessed). */
export const IMPORT_PAYMENT_STATUSES = ["PAID", "UNPAID", "CHARGED_TO_ADMISSION"] as const;
export type ImportPaymentStatus = (typeof IMPORT_PAYMENT_STATUSES)[number];

export const IMPORT_KINDS = ["INVESTIGATIONS", "PHARMACY_INVENTORY", "PHARMACY_GRN", "PHARMACY_TRANSFERS"] as const;
export type ImportKind = (typeof IMPORT_KINDS)[number];

/** pharmacy_imports.kind: a stock-on-hand row, one line of a GRN, or one Pharmacy transfer. */
export const PHARMACY_IMPORT_KINDS = ["INVENTORY", "GRN_LINE", "TRANSFER"] as const;
export type PharmacyImportKind = (typeof PHARMACY_IMPORT_KINDS)[number];

/** The sync_log.kind that goes with each Pharmacy export. */
export const PHARMACY_SYNC_KIND: Record<PharmacyImportKind, ImportKind> = {
  INVENTORY: "PHARMACY_INVENTORY",
  GRN_LINE: "PHARMACY_GRN",
  TRANSFER: "PHARMACY_TRANSFERS",
};
