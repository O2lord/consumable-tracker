import "server-only";
import { asc, eq, sql } from "drizzle-orm";
import type { DbOrTx } from "../audit/events";
import { db } from "../db/client";
import { env } from "../env";
import { ENC_CONTEXT, batches, itemTypes, links, locations, units } from "../db/schema";
import { decryptField } from "../security/field-crypto";
import { getUnitWithHistory } from "./unit.service";

// Reports (architecture section 13). Everything here is read-only and derived from the ledger and
// the views in the reports migration. Callers check `view_reports` (supervisor and auditor).

/** The views return links.patient_hospital_no as stored (scrambled); raw SQL skips the column decryption. */
function linkMrn(value: string | null): string | null {
  return value ? decryptField(value, ENC_CONTEXT.linksMrn) : null;
}

export interface ReconciliationRow {
  locationId: string;
  locationName: string;
  itemTypeId: string;
  itemName: string;
  trackingMode: "SERIAL" | "QUANTITY";
  opening: number;
  stocked: number;
  received: number;
  found: number;
  dispatched: number;
  issued: number;
  /** Stock the lab recorded as used at the bench (Used for test) in the period. */
  used: number;
  returnedUsed: number;
  restocked: number;
  voidedOrWasted: number;
  missing: number;
  closing: number;
  onHandNow: number;
  /** SERIAL items only: units actually IN_STOCK now. */
  actualInStock: number | null;
  /** SERIAL items only: actual minus ledger. Anything other than 0 needs investigating. */
  unaccounted: number | null;
  /** The item's stock unit and pack size, for showing piece equivalents beside pack quantities. Display only. */
  unit: string;
  packSize: number;
  packSizeConfirmed: boolean;
}

interface ReconciliationDbRow extends Record<string, unknown> {
  location_id: string;
  location_name: string;
  item_type_id: string;
  item_name: string;
  tracking_mode: "SERIAL" | "QUANTITY";
  opening: number;
  stocked: number;
  received: number;
  found: number;
  dispatched: number;
  issued: number;
  used: number;
  returned_used: number;
  restocked: number;
  voided_or_wasted: number;
  missing: number;
  closing: number;
  on_hand_now: number;
  actual_in_stock: number | null;
  unaccounted: number | null;
}

/** A calendar date (YYYY-MM-DD) read as the start of that day in UTC. */
export function startOfDay(date: string): Date {
  return new Date(`${date}T00:00:00.000Z`);
}

/** The end of a calendar date, as the start of the next day, so the whole day is included. */
export function endOfDay(date: string): Date {
  const d = startOfDay(date);
  d.setUTCDate(d.getUTCDate() + 1);
  return d;
}

export function isIsoDate(value: string | undefined): value is string {
  return Boolean(value) && /^\d{4}-\d{2}-\d{2}$/.test(value as string) && !Number.isNaN(startOfDay(value as string).getTime());
}

/** Per location and item type for [from, to). Both bounds are instants. */
export async function getReconciliation(
  args: { from: Date; to: Date; locationId?: string },
  conn: DbOrTx = db(),
): Promise<ReconciliationRow[]> {
  const rows = await conn.execute<ReconciliationDbRow>(
    sql`select * from consumables.location_reconciliation(${args.from.toISOString()}::timestamptz, ${args.to.toISOString()}::timestamptz)`,
  );
  // The SQL function knows nothing about units or pack sizes, so they are read here, once per item type.
  const itemInfo = new Map(
    (
      await conn
        .select({
          id: itemTypes.id,
          unit: itemTypes.unitOfMeasure,
          packSize: itemTypes.packSize,
          packSizeConfirmed: itemTypes.packSizeConfirmed,
        })
        .from(itemTypes)
    ).map((i) => [i.id, i]),
  );
  return Array.from(rows)
    .filter((r) => !args.locationId || r.location_id === args.locationId)
    .map((r) => ({
      locationId: r.location_id,
      locationName: r.location_name,
      itemTypeId: r.item_type_id,
      itemName: r.item_name,
      trackingMode: r.tracking_mode,
      opening: r.opening,
      stocked: r.stocked,
      received: r.received,
      found: r.found,
      dispatched: r.dispatched,
      issued: r.issued,
      used: r.used,
      returnedUsed: r.returned_used,
      restocked: r.restocked,
      voidedOrWasted: r.voided_or_wasted,
      missing: r.missing,
      closing: r.closing,
      onHandNow: r.on_hand_now,
      actualInStock: r.actual_in_stock,
      unaccounted: r.unaccounted,
      unit: itemInfo.get(r.item_type_id)?.unit ?? "",
      packSize: itemInfo.get(r.item_type_id)?.packSize ?? 1,
      packSizeConfirmed: itemInfo.get(r.item_type_id)?.packSizeConfirmed ?? false,
    }));
}

export interface OutstandingBottle {
  unitId: string;
  serial: string;
  itemName: string;
  locationName: string;
  issuedAt: Date;
  hoursOut: number;
  issuedFor: string | null;
  patientHospitalNo: string | null;
}

/** Serialized units still ISSUED for longer than the threshold (OUTSTANDING_HOURS), longest first. */
export async function listOutstandingIssued(
  args: { hours?: number; locationId?: string } = {},
  conn: DbOrTx = db(),
): Promise<OutstandingBottle[]> {
  const hours = args.hours ?? env().OUTSTANDING_HOURS;
  const rows = await conn.execute<{
    unit_id: string;
    serial: string;
    item_name: string;
    location_id: string;
    location_name: string;
    issued_at: Date;
    hours_out: string | number;
    issued_for: string | null;
    patient_hospital_no: string | null;
  }>(sql`select * from consumables.v_outstanding_issued order by issued_at asc`);
  return Array.from(rows)
    .filter((r) => Number(r.hours_out) >= hours && (!args.locationId || r.location_id === args.locationId))
    .map((r) => ({
      unitId: r.unit_id,
      serial: r.serial,
      itemName: r.item_name,
      locationName: r.location_name,
      issuedAt: new Date(r.issued_at),
      hoursOut: Number(r.hours_out),
      issuedFor: r.issued_for,
      patientHospitalNo: linkMrn(r.patient_hospital_no),
    }));
}

export interface OpenRequestBalance {
  requestId: string;
  requestCode: string;
  status: string;
  requestingName: string;
  storeName: string;
  itemName: string;
  approved: number;
  dispatched: number;
  received: number;
  /** Approved minus dispatched: still to be sent by the store. */
  openBalance: number;
  /** Dispatched minus received: on its way, not yet counted at the lab. */
  inTransit: number;
  approvedAt: Date | null;
  /** Whole days since the request was approved. */
  daysOpen: number;
}

/**
 * Lines of approved stock requests that still have something to send, oldest first. Closed lines and
 * lines the store declined are left out, matching openBalance() in request-rules.
 */
export async function listOpenRequestBalances(
  args: { locationId?: string } = {},
  conn: DbOrTx = db(),
): Promise<OpenRequestBalance[]> {
  const rows = await conn.execute<{
    request_id: string;
    request_code: string;
    status: string;
    requesting_name: string;
    store_name: string;
    item_name: string;
    approved: number;
    dispatched: number;
    received: number;
    approved_at: Date | null;
    days_open: string | number;
    requesting_location_id: string;
    store_location_id: string;
  }>(sql`
    select r.id as request_id,
           r.code as request_code,
           r.status,
           rl.name as requesting_name,
           sl.name as store_name,
           it.name as item_name,
           l.quantity_approved as approved,
           l.quantity_dispatched as dispatched,
           l.quantity_received as received,
           r.reviewed_at as approved_at,
           floor(extract(epoch from (now() - coalesce(r.reviewed_at, r.created_at))) / 86400) as days_open,
           r.requesting_location_id,
           r.store_location_id
    from consumables.stock_requests r
    join consumables.stock_request_lines l on l.request_id = r.id
    join consumables.item_types it on it.id = l.item_type_id
    join consumables.locations rl on rl.id = r.requesting_location_id
    join consumables.locations sl on sl.id = r.store_location_id
    where r.status in ('APPROVED', 'PARTIALLY_FULFILLED')
      and l.closed_at is null
      and l.quantity_approved is not null
      and l.quantity_approved > l.quantity_dispatched
    order by coalesce(r.reviewed_at, r.created_at) asc, r.code asc, it.name asc
  `);
  return Array.from(rows)
    .filter((r) => !args.locationId || r.requesting_location_id === args.locationId || r.store_location_id === args.locationId)
    .map((r) => ({
      requestId: r.request_id,
      requestCode: r.request_code,
      status: r.status,
      requestingName: r.requesting_name,
      storeName: r.store_name,
      itemName: r.item_name,
      approved: Number(r.approved),
      dispatched: Number(r.dispatched),
      received: Number(r.received),
      openBalance: Number(r.approved) - Number(r.dispatched),
      inTransit: Math.max(Number(r.dispatched) - Number(r.received), 0),
      approvedAt: r.approved_at ? new Date(r.approved_at) : null,
      daysOpen: Number(r.days_open),
    }));
}

export interface UnverifiedIssue {
  linkId: string;
  referenceType: string;
  referenceRef: string;
  testCode: string | null;
  patientHospitalNo: string | null;
  patientType: string | null;
  itemRef: string;
  itemName: string;
  quantity: number;
  locationName: string;
  issuedByName: string;
  issuedAt: Date;
  clearedAt: Date | null;
}

/** Links whose payment could not be verified at issue, newest first. */
export async function listUnverifiedIssues(limit = 500, conn: DbOrTx = db()): Promise<UnverifiedIssue[]> {
  const rows = await conn.execute<{
    link_id: string;
    reference_type: string;
    reference_ref: string;
    test_code: string | null;
    patient_hospital_no: string | null;
    patient_type: string | null;
    item_ref: string;
    item_name: string;
    quantity: number;
    location_name: string;
    issued_by_name: string;
    issued_at: Date;
    cleared_at: Date | null;
  }>(sql`select * from consumables.v_unverified_issues order by issued_at desc limit ${limit}`);
  return Array.from(rows).map((r) => ({
    linkId: r.link_id,
    referenceType: r.reference_type,
    referenceRef: r.reference_ref,
    testCode: r.test_code,
    patientHospitalNo: linkMrn(r.patient_hospital_no),
    patientType: r.patient_type,
    itemRef: r.item_ref,
    itemName: r.item_name,
    quantity: r.quantity,
    locationName: r.location_name,
    issuedByName: r.issued_by_name,
    issuedAt: new Date(r.issued_at),
    clearedAt: r.cleared_at ? new Date(r.cleared_at) : null,
  }));
}

export interface IssueOverride {
  linkId: string;
  referenceType: string;
  referenceRef: string;
  patientHospitalNo: string | null;
  itemRef: string;
  itemName: string;
  quantity: number;
  locationName: string;
  issuedByName: string;
  overrideByName: string;
  overrideReason: string;
  issuedAt: Date;
}

/** Supervisor overrides, newest first, with the reason each one gave. */
export async function listIssueOverrides(limit = 500, conn: DbOrTx = db()): Promise<IssueOverride[]> {
  const rows = await conn.execute<{
    link_id: string;
    reference_type: string;
    reference_ref: string;
    patient_hospital_no: string | null;
    item_ref: string;
    item_name: string;
    quantity: number;
    location_name: string;
    issued_by_name: string;
    override_by_name: string;
    override_reason: string;
    issued_at: Date;
  }>(sql`select * from consumables.v_issue_overrides order by issued_at desc limit ${limit}`);
  return Array.from(rows).map((r) => ({
    linkId: r.link_id,
    referenceType: r.reference_type,
    referenceRef: r.reference_ref,
    patientHospitalNo: linkMrn(r.patient_hospital_no),
    itemRef: r.item_ref,
    itemName: r.item_name,
    quantity: r.quantity,
    locationName: r.location_name,
    issuedByName: r.issued_by_name,
    overrideByName: r.override_by_name,
    overrideReason: r.override_reason,
    issuedAt: new Date(r.issued_at),
  }));
}

export interface LedgerMismatch {
  unitId: string;
  serial: string;
  itemName: string;
  unitState: string;
  ledgerState: string | null;
  lastEventType: string | null;
  lastEventAt: Date | null;
  locationName: string;
}

/** Units whose state is not backed by their latest ledger event. Empty on clean data. */
export async function listLedgerMismatches(conn: DbOrTx = db()): Promise<LedgerMismatch[]> {
  const rows = await conn.execute<{
    unit_id: string;
    serial: string;
    item_name: string;
    unit_state: string;
    ledger_state: string | null;
    last_event_type: string | null;
    last_event_at: Date | null;
    location_name: string;
  }>(sql`select * from consumables.v_unit_ledger_mismatch order by serial`);
  return Array.from(rows).map((r) => ({
    unitId: r.unit_id,
    serial: r.serial,
    itemName: r.item_name,
    unitState: r.unit_state,
    ledgerState: r.ledger_state,
    lastEventType: r.last_event_type,
    lastEventAt: r.last_event_at ? new Date(r.last_event_at) : null,
    locationName: r.location_name,
  }));
}

/** Counts for the dashboard. */
export async function getReportCounts(conn: DbOrTx = db()) {
  const [outstanding, unverified, overrides, mismatches] = await Promise.all([
    listOutstandingIssued({}, conn).then((r) => r.length),
    conn.execute<{ n: number }>(sql`select count(*)::int as n from consumables.v_unverified_issues where cleared_at is null`),
    conn.execute<{ n: number }>(sql`select count(*)::int as n from consumables.v_issue_overrides`),
    conn.execute<{ n: number }>(sql`select count(*)::int as n from consumables.v_unit_ledger_mismatch`),
  ]);
  return {
    outstanding,
    unverified: unverified[0]?.n ?? 0,
    overrides: overrides[0]?.n ?? 0,
    mismatches: mismatches[0]?.n ?? 0,
  };
}

/** One bottle: its state, its full event history, and everything it was issued for (cleared ones too). */
export async function getBottleReport(serialInput: string, conn: DbOrTx = db()) {
  const found = await getUnitWithHistory(serialInput, conn);
  if (!found) return null;
  const issuedFor = await conn
    .select({
      referenceType: links.referenceType,
      referenceRef: links.referenceRef,
      testCode: links.testCode,
      patientHospitalNo: links.patientHospitalNo,
      paymentCheck: links.paymentCheck,
      collectorType: links.collectorType,
      collectorName: links.collectorName,
      overrideReason: links.overrideReason,
      issuedAt: links.createdAt,
      clearedAt: links.clearedAt,
    })
    .from(links)
    .where(eq(links.unitId, found.unit.id))
    .orderBy(asc(links.createdAt));
  return { ...found, issuedFor };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One batch and every unit in it, so you can open the other bottles that came in with a bottle. */
export async function getBatchReport(codeInput: string, conn: DbOrTx = db()) {
  const [batch] = await conn
    .select({
      id: batches.id,
      code: batches.code,
      itemName: itemTypes.name,
      lotNo: batches.lotNo,
      expiryDate: batches.expiryDate,
      supplier: batches.supplier,
      quantity: batches.quantity,
    })
    .from(batches)
    .innerJoin(itemTypes, eq(itemTypes.id, batches.itemTypeId))
    .where(eq(batches.code, codeInput));
  if (!batch) return null;

  const batchUnits = await conn
    .select({
      serial: units.serial,
      state: units.state,
      locationId: units.currentLocationId,
      locationName: locations.name,
    })
    .from(units)
    .innerJoin(locations, eq(locations.id, units.currentLocationId))
    .where(eq(units.batchId, batch.id))
    .orderBy(asc(units.serial));
  return { batch, units: batchUnits };
}

const LOCATION_UNIT_LIMIT = 500;

/** One location and the bottles that are there now (capped, with the true total). */
export async function getLocationReport(idInput: string, conn: DbOrTx = db()) {
  if (!UUID_RE.test(idInput)) return null;
  const [location] = await conn
    .select({ id: locations.id, name: locations.name, code: locations.code })
    .from(locations)
    .where(eq(locations.id, idInput));
  if (!location) return null;

  const [{ n }] = await conn.execute<{ n: number }>(
    sql`select count(*)::int as n from consumables.units where current_location_id = ${location.id}`,
  );
  const here = await conn
    .select({
      serial: units.serial,
      state: units.state,
      itemName: itemTypes.name,
      batchCode: batches.code,
    })
    .from(units)
    .innerJoin(itemTypes, eq(itemTypes.id, units.itemTypeId))
    .innerJoin(batches, eq(batches.id, units.batchId))
    .where(eq(units.currentLocationId, location.id))
    .orderBy(asc(itemTypes.name), asc(units.serial))
    .limit(LOCATION_UNIT_LIMIT);
  return { location, total: n, units: here };
}

// --- expiring stock (corrections C8) ----------------------------------------------

/** The windows the report offers, in days from today. */
export const EXPIRY_WINDOWS = [30, 60, 90] as const;

export interface ExpiringStockRow {
  locationName: string;
  itemName: string;
  batchCode: string;
  /** YYYY-MM-DD. */
  expiryDate: string;
  /** Days from today; negative when the stock has already expired. */
  daysLeft: number;
  /** Bottles IN_STOCK (SERIAL) or the on-hand balance (QUANTITY) at that location. */
  quantity: number;
  /** The item's stock unit and pack size, for showing piece equivalents beside pack quantities. Display only. */
  unit: string;
  packSize: number;
  packSizeConfirmed: boolean;
}

/**
 * Stock on a shelf that expires within `days` days, or has already expired and is still on the shelf (it is
 * blocked from dispatch and issue, but someone should take it off). Soonest first. Bottles issued to a patient
 * are not shelf stock and are left out.
 */
export async function listExpiringStock(days: number, conn: DbOrTx = db()): Promise<ExpiringStockRow[]> {
  const window = Math.max(0, Math.floor(days));
  const today = new Date().toISOString().slice(0, 10);
  const rows = await conn.execute<{
    location_name: string;
    item_name: string;
    batch_code: string;
    expiry_date: string;
    days_left: number;
    quantity: number;
    unit: string;
    pack_size: number;
    pack_size_confirmed: boolean;
  }>(sql`
    select l.name as location_name,
           i.name as item_name,
           b.code as batch_code,
           to_char(b.expiry_date, 'YYYY-MM-DD') as expiry_date,
           (b.expiry_date - ${today}::date)::int as days_left,
           count(*)::int as quantity,
           i.unit_of_measure as unit,
           i.pack_size,
           i.pack_size_confirmed
    from consumables.units u
    join consumables.batches b on b.id = u.batch_id
    join consumables.item_types i on i.id = u.item_type_id
    join consumables.locations l on l.id = u.current_location_id
    where u.state = 'IN_STOCK'
      and b.expiry_date is not null
      and b.expiry_date <= ${today}::date + ${window}::int
    group by l.name, i.name, b.code, b.expiry_date, i.unit_of_measure, i.pack_size, i.pack_size_confirmed
    union all
    select l.name as location_name,
           bal.item_name,
           bal.batch_code,
           to_char(b.expiry_date, 'YYYY-MM-DD') as expiry_date,
           (b.expiry_date - ${today}::date)::int as days_left,
           bal.on_hand as quantity,
           it.unit_of_measure as unit,
           it.pack_size,
           it.pack_size_confirmed
    from consumables.v_quantity_balance bal
    join consumables.batches b on b.id = bal.batch_id
    join consumables.item_types it on it.id = bal.item_type_id
    join consumables.locations l on l.id = bal.location_id
    where bal.on_hand > 0
      and b.expiry_date is not null
      and b.expiry_date <= ${today}::date + ${window}::int
    order by expiry_date asc, location_name asc, item_name asc
  `);
  return rows.map((r) => ({
    locationName: r.location_name,
    itemName: r.item_name,
    batchCode: r.batch_code,
    expiryDate: r.expiry_date,
    daysLeft: r.days_left,
    quantity: r.quantity,
    unit: r.unit,
    packSize: r.pack_size,
    packSizeConfirmed: r.pack_size_confirmed,
  }));
}
