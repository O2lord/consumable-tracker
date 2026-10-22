import "server-only";
import { desc, eq, sql } from "drizzle-orm";
import type { DbOrTx } from "../audit/events";
import { db } from "../db/client";
import { ENC_CONTEXT, investigationImports, syncLog } from "../db/schema";
import { ValidationError } from "../domain/errors";
import type { Actor, InvestigationQueue } from "../domain/types";
import { ImportFormatError, parseInvestigationRows, type RowError } from "../../lib/import-parse";
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
  switch (kind) {
    case "INVESTIGATIONS":
      return `Investigations${typeof detail.queue === "string" ? ` (${detail.queue})` : ""}`;
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
