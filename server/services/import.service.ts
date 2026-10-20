import "server-only";
import { desc, eq, sql } from "drizzle-orm";
import type { DbOrTx } from "../audit/events";
import { db } from "../db/client";
import { ENC_CONTEXT, investigationImports, locations, pharmacyImports, syncLog } from "../db/schema";
import { ValidationError } from "../domain/errors";
import { PHARMACY_SYNC_KIND, type Actor, type InvestigationQueue, type PharmacyImportKind } from "../domain/types";
import { ImportFormatError, parseInvestigationRows, type RowError } from "../../lib/import-parse";
import { grnRefFromFileName, parsePharmacyRows } from "../../lib/pharmacy-parse";
import { readRows, UnsupportedFileError } from "../../lib/spreadsheet";
import { decryptField, mrnBlindIndex } from "../security/field-crypto";
import { pageInfo, type Paged } from "../../lib/pagination";

// Imports and the cross-checks that depend on them (architecture 9, build.md Phase 6). Callers check
// `manage_imports` for uploading and `view_reports` for the orphan report.
//
// An import is an upsert by investigation number: a later export updates status, destination and
// amount, and only fills in patient type, payment status, test code and raised-at where the new file
// has a value (an export that lacks those columns never wipes what an earlier one knew). Nothing is
// deleted. A file with any valid row is applied and the rejected rows are reported; a file with none
// is refused outright.

const MAX_BYTES = 1024 * 1024; // matches the default size limit for a Next.js server action
const MAX_ROWS = 20_000;
const ERRORS_KEPT = 50;
const CHUNK = 500;

export interface ImportSummary {
  syncLogId: string;
  fileName: string;
  queue: InvestigationQueue;
  headerRow: number;
  rowsTotal: number;
  inserted: number;
  updated: number;
  rejected: number;
  /** The first rejected rows (the log keeps no more than this either). */
  errors: RowError[];
}

/** Size and row limits, then the file as rows. Shared by every import. */
async function loadRows(fileName: string, data: ArrayBuffer): Promise<unknown[][]> {
  if (data.byteLength === 0) throw new ValidationError("The file is empty");
  if (data.byteLength > MAX_BYTES) throw new ValidationError("The file is larger than 1 MB");

  let rows: unknown[][];
  try {
    rows = await readRows(fileName, data);
  } catch (err) {
    if (err instanceof UnsupportedFileError) throw new ValidationError(err.message);
    throw new ValidationError("The file could not be read. Is it a valid .xlsx or .csv?");
  }
  if (rows.length > MAX_ROWS) throw new ValidationError(`The file has more than ${MAX_ROWS} rows`);
  return rows;
}

export async function importInvestigations(
  args: { fileName: string; data: ArrayBuffer; queue: InvestigationQueue },
  actor: Actor,
  conn: DbOrTx = db(),
): Promise<ImportSummary> {
  const rows = await loadRows(args.fileName, args.data);

  let parsed;
  try {
    parsed = parseInvestigationRows(rows);
  } catch (err) {
    if (err instanceof ImportFormatError) throw new ValidationError(err.message);
    throw err;
  }
  if (parsed.records.length === 0) {
    const why = parsed.errors.slice(0, 3).map((e) => `row ${e.row}: ${e.message}`).join(" | ");
    throw new ValidationError(`No valid rows to import.${why ? ` ${why}` : ""}`);
  }

  const startedAt = new Date();
  return conn.transaction(async (tx) => {
    const [log] = await tx
      .insert(syncLog)
      .values({ kind: "INVESTIGATIONS", fileName: args.fileName, importedBy: actor.userId, startedAt })
      .returning({ id: syncLog.id });

    let inserted = 0;
    let updated = 0;
    for (let i = 0; i < parsed.records.length; i += CHUNK) {
      const chunk = parsed.records.slice(i, i + CHUNK).map((r) => ({
        investigationRef: r.investigationRef,
        patientHospitalNo: r.patientHospitalNo,
        patientHospitalNoIdx: mrnBlindIndex(r.patientHospitalNo),
        queue: r.queue ?? args.queue,
        testCode: r.testCode,
        testName: r.testName,
        patientType: r.patientType,
        paymentStatus: r.paymentStatus,
        destination: r.destination,
        status: r.status,
        amount: r.amount,
        raisedAt: r.raisedAt,
        // NOT the uploaded row: an export can carry columns this app never asked for (a patient's name, say),
        // and the row holds the MRN in the clear. Nothing reads this column back, so only the source is kept.
        raw: { source: "import", row: r.row },
        syncLogId: log.id,
        importedAt: startedAt,
      }));
      const result = await tx
        .insert(investigationImports)
        .values(chunk)
        .onConflictDoUpdate({
          target: investigationImports.investigationRef,
          set: {
            patientHospitalNo: sql`excluded.patient_hospital_no`,
            patientHospitalNoIdx: sql`excluded.patient_hospital_no_idx`,
            queue: sql`excluded.queue`,
            testName: sql`excluded.test_name`,
            destination: sql`excluded.destination`,
            status: sql`excluded.status`,
            amount: sql`excluded.amount`,
            raw: sql`excluded.raw`,
            syncLogId: sql`excluded.sync_log_id`,
            importedAt: sql`excluded.imported_at`,
            testCode: sql`coalesce(excluded.test_code, ${investigationImports.testCode})`,
            patientType: sql`coalesce(excluded.patient_type, ${investigationImports.patientType})`,
            paymentStatus: sql`coalesce(excluded.payment_status, ${investigationImports.paymentStatus})`,
            raisedAt: sql`coalesce(excluded.raised_at, ${investigationImports.raisedAt})`,
          },
        })
        .returning({ wasInserted: sql<boolean>`(xmax = 0)` });
      for (const r of result) {
        if (r.wasInserted) inserted++;
        else updated++;
      }
    }

    const errors = parsed.errors.slice(0, ERRORS_KEPT);
    await tx
      .update(syncLog)
      .set({
        rowsTotal: parsed.records.length + parsed.errors.length,
        rowsInserted: inserted,
        rowsUpdated: updated,
        rowsRejected: parsed.errors.length,
        errors,
        detail: { queue: args.queue, headerRow: parsed.headerRow, blankRows: parsed.blankRows },
        finishedAt: new Date(),
      })
      .where(eq(syncLog.id, log.id));

    return {
      syncLogId: log.id,
      fileName: args.fileName,
      queue: args.queue,
      headerRow: parsed.headerRow,
      rowsTotal: parsed.records.length + parsed.errors.length,
      inserted,
      updated,
      rejected: parsed.errors.length,
      errors,
    };
  });
}

export interface PharmacyImportSummary {
  syncLogId: string;
  kind: PharmacyImportKind;
  fileName: string;
  headerRow: number;
  rowsTotal: number;
  inserted: number;
  updated: number;
  rejected: number;
  /** The first rejected rows (the log keeps no more than this either). */
  errors: RowError[];
}

const normText = (s: string | null | undefined) => (s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * Loads a Pharmacy export: stock on hand (INVENTORY), one GRN (GRN_LINE) or the transfers list (TRANSFER).
 * Like the investigations import it is an upsert, so a newer export updates what is loaded and nothing is
 * deleted. An inventory export says nothing of where the stock is, so the caller names the location
 * (or the file carries a location column that matches a tracker location by name, code or external id).
 * The GRN number comes from a grn_ref column, else the form, else the file name (grn-GRNS00002.xlsx).
 */
export async function importPharmacy(
  args: {
    kind: PharmacyImportKind;
    fileName: string;
    data: ArrayBuffer;
    locationId?: string | null;
    grnRef?: string | null;
  },
  actor: Actor,
  conn: DbOrTx = db(),
): Promise<PharmacyImportSummary> {
  const rows = await loadRows(args.fileName, args.data);

  let parsed;
  try {
    parsed = parsePharmacyRows(args.kind, rows, { grnRef: args.grnRef || grnRefFromFileName(args.fileName) });
  } catch (err) {
    if (err instanceof ImportFormatError) throw new ValidationError(err.message);
    throw err;
  }

  const errors: RowError[] = [...parsed.errors];
  const locationNames = new Set<string>();
  let items = parsed.records.map((r) => ({
    r,
    locationId: null as string | null,
    locationName: null as string | null,
    key: r.naturalKey,
  }));

  if (args.kind === "INVENTORY") {
    const all = await conn
      .select({ id: locations.id, name: locations.name, code: locations.code, externalId: locations.externalId })
      .from(locations);
    const byText = new Map<string, (typeof all)[number]>();
    for (const l of all) {
      for (const text of [l.name, l.code, l.externalId]) {
        const k = normText(text);
        if (k && !byText.has(k)) byText.set(k, l);
      }
    }
    const fixed = args.locationId ? all.find((l) => l.id === args.locationId) : undefined;
    if (args.locationId && !fixed) throw new ValidationError("That location does not exist");
    if (!fixed && !parsed.records.some((r) => r.locationText)) {
      throw new ValidationError("Choose which location this inventory file is for: the file has no location column.");
    }

    const resolved: typeof items = [];
    for (const r of parsed.records) {
      let loc = fixed;
      if (r.locationText) {
        loc = byText.get(normText(r.locationText));
        if (!loc) {
          errors.push({
            row: r.row,
            message: `location "${r.locationText}" is not a tracker location (it must match a location's name, code or external id)`,
          });
          continue;
        }
      }
      if (!loc) {
        errors.push({ row: r.row, message: "no location: the file has none and none was chosen" });
        continue;
      }
      locationNames.add(loc.name);
      resolved.push({ r, locationId: loc.id, locationName: loc.name, key: `${loc.id}|${r.naturalKey}` });
    }
    items = resolved;
  }

  // Two lines can only collide after the location is known; the later one wins, as in the parser.
  const lastRowFor = new Map<string, number>();
  for (const x of items) lastRowFor.set(x.key, x.r.row);
  items = items.filter((x) => {
    if (lastRowFor.get(x.key) === x.r.row) return true;
    errors.push({
      row: x.r.row,
      message: `this line appears again later in the file (row ${lastRowFor.get(x.key)}); the later row was used`,
    });
    return false;
  });

  errors.sort((a, b) => a.row - b.row);
  if (items.length === 0) {
    const why = errors.slice(0, 3).map((e) => `row ${e.row}: ${e.message}`).join(" | ");
    throw new ValidationError(`No valid rows to import.${why ? ` ${why}` : ""}`);
  }

  const startedAt = new Date();
  const rowsTotal = items.length + errors.length;
  const keptErrors = errors.slice(0, ERRORS_KEPT);
  return conn.transaction(async (tx) => {
    const [log] = await tx
      .insert(syncLog)
      .values({ kind: PHARMACY_SYNC_KIND[args.kind], fileName: args.fileName, importedBy: actor.userId, startedAt })
      .returning({ id: syncLog.id });

    let inserted = 0;
    let updated = 0;
    for (let i = 0; i < items.length; i += CHUNK) {
      const chunk = items.slice(i, i + CHUNK).map(({ r, locationId, locationName, key }) => ({
        kind: args.kind,
        naturalKey: key,
        pharmacyRef: r.pharmacyRef,
        locationId,
        locationLabel: locationName ?? r.locationText,
        destinationLabel: r.destinationText,
        genericName: r.genericName,
        strength: r.strength,
        brand: r.brand,
        itemLabel: r.itemLabel,
        itemKey: r.itemKey,
        batchNo: r.batchNo,
        expiryDate: r.expiryDate,
        quantity: r.quantity,
        unitCost: r.unitCost,
        unit: r.unit,
        category: r.category,
        supplier: r.supplier,
        transferType: r.transferType,
        status: r.status,
        requestedBy: r.requestedBy,
        requestedAt: r.requestedAt,
        lines: r.lines,
        raw: r.raw,
        syncLogId: log.id,
        importedAt: startedAt,
      }));
      const result = await tx
        .insert(pharmacyImports)
        .values(chunk)
        .onConflictDoUpdate({
          target: [pharmacyImports.kind, pharmacyImports.naturalKey],
          set: {
            pharmacyRef: sql`excluded.pharmacy_ref`,
            locationId: sql`excluded.location_id`,
            locationLabel: sql`excluded.location_label`,
            destinationLabel: sql`excluded.destination_label`,
            genericName: sql`excluded.generic_name`,
            strength: sql`excluded.strength`,
            brand: sql`excluded.brand`,
            itemLabel: sql`excluded.item_label`,
            itemKey: sql`excluded.item_key`,
            batchNo: sql`excluded.batch_no`,
            expiryDate: sql`excluded.expiry_date`,
            quantity: sql`excluded.quantity`,
            unitCost: sql`excluded.unit_cost`,
            unit: sql`excluded.unit`,
            category: sql`excluded.category`,
            supplier: sql`excluded.supplier`,
            transferType: sql`excluded.transfer_type`,
            status: sql`excluded.status`,
            requestedBy: sql`excluded.requested_by`,
            requestedAt: sql`excluded.requested_at`,
            lines: sql`excluded.lines`,
            raw: sql`excluded.raw`,
            syncLogId: sql`excluded.sync_log_id`,
            importedAt: sql`excluded.imported_at`,
          },
        })
        .returning({ wasInserted: sql<boolean>`(xmax = 0)` });
      for (const r of result) {
        if (r.wasInserted) inserted++;
        else updated++;
      }
    }

    await tx
      .update(syncLog)
      .set({
        rowsTotal,
        rowsInserted: inserted,
        rowsUpdated: updated,
        rowsRejected: errors.length,
        errors: keptErrors,
        detail: {
          kind: args.kind,
          headerRow: parsed.headerRow,
          blankRows: parsed.blankRows,
          locationNames: [...locationNames],
          grnRef: args.kind === "GRN_LINE" ? (items[0]?.r.pharmacyRef ?? null) : null,
        },
        finishedAt: new Date(),
      })
      .where(eq(syncLog.id, log.id));

    return {
      syncLogId: log.id,
      kind: args.kind,
      fileName: args.fileName,
      headerRow: parsed.headerRow,
      rowsTotal,
      inserted,
      updated,
      rejected: errors.length,
      errors: keptErrors,
    };
  });
}

export interface ImportHistoryRow {
  id: string;
  kind: string;
  fileName: string | null;
  /** A short description of what was loaded, from the log's own detail. */
  what: string;
  rowsTotal: number;
  rowsInserted: number;
  rowsUpdated: number;
  rowsRejected: number;
  errors: RowError[];
  startedAt: Date;
}

/** Newest imports first. */
export async function listImportHistory(limit = 30, conn: DbOrTx = db()): Promise<ImportHistoryRow[]> {
  const rows = await conn.select().from(syncLog).orderBy(desc(syncLog.startedAt)).limit(limit);
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    fileName: r.fileName,
    what: describeImport(r.kind, (r.detail as Record<string, unknown> | null) ?? {}),
    rowsTotal: r.rowsTotal,
    rowsInserted: r.rowsInserted,
    rowsUpdated: r.rowsUpdated,
    rowsRejected: r.rowsRejected,
    errors: (r.errors as RowError[] | null) ?? [],
    startedAt: r.startedAt,
  }));
}

function describeImport(kind: string, detail: Record<string, unknown>): string {
  const names = Array.isArray(detail.locationNames) ? (detail.locationNames as string[]).join(", ") : "";
  switch (kind) {
    case "INVESTIGATIONS":
      return `Investigations${typeof detail.queue === "string" ? ` (${detail.queue})` : ""}`;
    case "PHARMACY_INVENTORY":
      return `Pharmacy inventory${names ? `: ${names}` : ""}`;
    case "PHARMACY_GRN":
      return `Pharmacy GRN${typeof detail.grnRef === "string" ? ` ${detail.grnRef}` : ""}`;
    case "PHARMACY_TRANSFERS":
      return "Pharmacy transfers";
    default:
      return kind;
  }
}

/** How much the imports cover, and when they last ran. Zero imported means the orphan check proves nothing. */
export async function getInvestigationImportStats(conn: DbOrTx = db()) {
  const rows = await conn.execute<{ total: number; last_imported_at: Date | null }>(
    sql`select count(*)::int as total, max(imported_at) as last_imported_at from consumables.investigation_imports`,
  );
  const row = rows[0];
  return {
    total: row?.total ?? 0,
    lastImportedAt: row?.last_imported_at ? new Date(row.last_imported_at) : null,
  };
}

export interface OrphanIssue {
  linkId: string;
  referenceRef: string;
  testCode: string | null;
  patientHospitalNo: string | null;
  problem: "NOT_IN_IMPORT" | "MRN_MISMATCH";
  importedPatientHospitalNo: string | null;
  itemRef: string;
  itemName: string;
  locationName: string;
  issuedByName: string;
  issuedAt: Date;
  clearedAt: Date | null;
}

/** Investigation links the imports do not back, newest first. */
export async function listOrphanIssues(limit = 500, conn: DbOrTx = db(), offset = 0): Promise<OrphanIssue[]> {
  const rows = await conn.execute<{
    link_id: string;
    reference_ref: string;
    test_code: string | null;
    patient_hospital_no: string | null;
    problem: "NOT_IN_IMPORT" | "MRN_MISMATCH";
    imported_patient_hospital_no: string | null;
    item_ref: string;
    item_name: string;
    location_name: string;
    issued_by_name: string;
    issued_at: Date;
    cleared_at: Date | null;
  }>(sql`select * from consumables.v_orphan_issues order by issued_at desc, link_id desc limit ${limit} offset ${offset}`);
  return Array.from(rows).map((r) => ({
    linkId: r.link_id,
    referenceRef: r.reference_ref,
    testCode: r.test_code,
    patientHospitalNo: r.patient_hospital_no ? decryptField(r.patient_hospital_no, ENC_CONTEXT.linksMrn) : null,
    problem: r.problem,
    importedPatientHospitalNo: r.imported_patient_hospital_no
      ? decryptField(r.imported_patient_hospital_no, ENC_CONTEXT.importsMrn)
      : null,
    itemRef: r.item_ref,
    itemName: r.item_name,
    locationName: r.location_name,
    issuedByName: r.issued_by_name,
    issuedAt: new Date(r.issued_at),
    clearedAt: r.cleared_at ? new Date(r.cleared_at) : null,
  }));
}

/** One page of orphan issues, with the true total (not capped). */
export async function listOrphanIssuesPage(page: number, conn: DbOrTx = db()): Promise<Paged<OrphanIssue>> {
  const totals = await conn.execute<{ total: number }>(sql`select count(*)::int as total from consumables.v_orphan_issues`);
  const info = pageInfo(page, totals[0]?.total ?? 0);
  const rows = info.total === 0 ? [] : await listOrphanIssues(info.pageSize, conn, info.offset);
  return { ...info, rows };
}
