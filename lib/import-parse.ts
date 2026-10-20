// Reads an investigations export (architecture sections 5 and 9). Pure: no I/O, rows in, records out.
//
// The tracker defines the standard columns below; the EMR exports to fit them. The headers the
// staff portal uses today (MRN, Investigation #, Item, Amount (NGN), ...) are accepted as aliases
// so a portal export loads as it is. The header row is found by name, because exports start with
// preamble rows (Period, totals) and the header is not always on row 1.

import {
  IMPORT_PAYMENT_STATUSES,
  INVESTIGATION_QUEUES,
  PATIENT_TYPES,
  type ImportPaymentStatus,
  type InvestigationQueue,
  type PatientType,
} from "../server/domain/types";
import { isValidMrn, isValidReference, normalizeMrn, normalizeReference } from "./reference-formats";

export const INVESTIGATION_COLUMNS = [
  "investigation_ref",
  "patient_hospital_no",
  "test_name",
  "test_code",
  "patient_type",
  "payment_status",
  "destination",
  "status",
  "amount",
  "raised_at",
  "queue",
] as const;
export type InvestigationColumn = (typeof INVESTIGATION_COLUMNS)[number];

/** Required in every export. The rest are optional and stay empty when missing. */
export const REQUIRED_COLUMNS: readonly InvestigationColumn[] = ["investigation_ref", "patient_hospital_no", "test_name"];

// Header text, lower-cased with everything but letters and digits removed ("Investigation #" -> "investigation").
const ALIASES: Record<InvestigationColumn, readonly string[]> = {
  investigation_ref: ["investigationref", "investigation", "investigationno", "investigationnumber", "investigationid", "requestno"],
  patient_hospital_no: ["patienthospitalno", "mrn", "hospitalno", "hospitalnumber", "patientno", "patientmrn"],
  test_name: ["testname", "test", "item", "service", "investigationname"],
  test_code: ["testcode", "itemcode"],
  patient_type: ["patienttype", "visittype"],
  payment_status: ["paymentstatus", "billingstatus"],
  destination: ["destination", "labdestination"],
  status: ["status", "investigationstatus"],
  amount: ["amount", "amountngn", "price"],
  raised_at: ["raisedat", "requestedat", "createdat"],
  queue: ["queue"],
};

export class ImportFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImportFormatError";
  }
}

export interface ParsedInvestigation {
  investigationRef: string;
  patientHospitalNo: string;
  testName: string;
  testCode: string | null;
  patientType: PatientType | null;
  paymentStatus: ImportPaymentStatus | null;
  destination: string | null;
  status: string | null;
  /** Two decimals, as text (the column is numeric). */
  amount: string | null;
  raisedAt: Date | null;
  /** Set only when the file has a queue column. */
  queue: InvestigationQueue | null;
  /** Every cell of the row, keyed by the file's own header text. */
  raw: Record<string, string>;
  /** 1-based row number in the file, for error messages. */
  row: number;
}

export interface RowError {
  row: number;
  message: string;
}

export interface InvestigationParseResult {
  records: ParsedInvestigation[];
  errors: RowError[];
  /** 1-based row the headers were found on. */
  headerRow: number;
  /** Rows with no cell filled in. */
  blankRows: number;
}

export function cellText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? "" : value.toISOString();
  return String(value).trim();
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** An empty cell and a lone dash both mean "not given". */
function given(text: string): string | null {
  const t = text.trim();
  return t === "" || t === "-" || t === "–" ? null : t;
}

function findColumns(row: readonly unknown[]): Map<InvestigationColumn, number> {
  const found = new Map<InvestigationColumn, number>();
  row.forEach((cell, index) => {
    const key = norm(cellText(cell));
    if (!key) return;
    for (const column of INVESTIGATION_COLUMNS) {
      if (!found.has(column) && ALIASES[column].includes(key)) {
        found.set(column, index);
        break;
      }
    }
    // The canonical name itself is always accepted, whatever the punctuation.
    for (const column of INVESTIGATION_COLUMNS) {
      if (!found.has(column) && norm(column) === key) {
        found.set(column, index);
        break;
      }
    }
  });
  return found;
}

export function parsePatientType(text: string): PatientType | null | "invalid" {
  const v = given(text);
  if (v === null) return null;
  const key = v.toUpperCase().replace(/[^A-Z]/g, "");
  if (key === "OUTPATIENT" || key === "OP" || key === "OPD") return "OUTPATIENT";
  if (key === "INPATIENT" || key === "IP") return "INPATIENT";
  if (key === "WALKIN") return "WALK_IN";
  return (PATIENT_TYPES as readonly string[]).includes(key) ? (key as PatientType) : "invalid";
}

export function parsePaymentStatus(text: string): ImportPaymentStatus | null | "invalid" {
  const v = given(text);
  if (v === null) return null;
  const key = v.toUpperCase().replace(/[^A-Z]/g, "");
  if (key === "PAID") return "PAID";
  if (key === "UNPAID" || key === "NOTPAID") return "UNPAID";
  if (key === "CHARGEDTOADMISSION" || key === "CHARGED") return "CHARGED_TO_ADMISSION";
  return (IMPORT_PAYMENT_STATUSES as readonly string[]).includes(v.toUpperCase()) ? (v.toUpperCase() as ImportPaymentStatus) : "invalid";
}

/** "100,000.00", "₦90" and "NGN 2000" all become a plain number with two decimals. */
export function parseAmount(text: string): string | null | "invalid" {
  const v = given(text);
  if (v === null) return null;
  const cleaned = v.replace(/[₦,\s]/g, "").replace(/^NGN/i, "");
  if (!/^\d+(\.\d+)?$/.test(cleaned)) return "invalid";
  return Number(cleaned).toFixed(2);
}

const DATE_LIKE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

/** ISO dates and date-times only; anything else is rejected rather than guessed (31/10 or 10/31?). */
export function parseWhen(value: unknown): Date | null | "invalid" {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? "invalid" : value;
  const v = given(cellText(value));
  if (v === null) return null;
  if (!DATE_LIKE.test(v)) return "invalid";
  const d = new Date(v.length === 10 ? `${v}T00:00:00.000Z` : v.replace(" ", "T"));
  return Number.isNaN(d.getTime()) ? "invalid" : d;
}

export function parseInvestigationRows(rows: readonly (readonly unknown[])[]): InvestigationParseResult {
  let headerIndex = -1;
  let columns = new Map<InvestigationColumn, number>();
  for (let i = 0; i < Math.min(rows.length, 25); i++) {
    const found = findColumns(rows[i] ?? []);
    if (REQUIRED_COLUMNS.every((c) => found.has(c))) {
      headerIndex = i;
      columns = found;
      break;
    }
  }
  if (headerIndex < 0) {
    throw new ImportFormatError(
      `Could not find the header row. The file needs these columns: ${REQUIRED_COLUMNS.join(", ")} ` +
        `(portal names such as MRN, "Investigation #" and Item also work).`,
    );
  }

  const headerCells = (rows[headerIndex] ?? []).map((c, i) => cellText(c) || `column_${i + 1}`);
  const cell = (row: readonly unknown[], column: InvestigationColumn): unknown => {
    const at = columns.get(column);
    return at === undefined ? undefined : row[at];
  };

  const records: ParsedInvestigation[] = [];
  const errors: RowError[] = [];
  let blankRows = 0;

  for (let i = headerIndex + 1; i < rows.length; i++) {
    const row = rows[i] ?? [];
    const rowNumber = i + 1;
    if (row.every((c) => cellText(c) === "")) {
      blankRows++;
      continue;
    }
    const problems: string[] = [];

    const ref = normalizeReference(cellText(cell(row, "investigation_ref")));
    if (!isValidReference("INVESTIGATION", ref)) problems.push(`"${ref}" is not an investigation number (expected IXS followed by digits)`);

    const mrn = normalizeMrn(cellText(cell(row, "patient_hospital_no")));
    if (!isValidMrn(mrn)) problems.push(`"${mrn}" is not a hospital number (expected UATH/PT/ followed by digits)`);

    const testName = given(cellText(cell(row, "test_name")));
    if (!testName) problems.push("the test name is empty");

    const patientType = parsePatientType(cellText(cell(row, "patient_type")));
    if (patientType === "invalid") problems.push(`patient type "${cellText(cell(row, "patient_type"))}" is not OUTPATIENT, INPATIENT or WALK_IN`);

    const paymentStatus = parsePaymentStatus(cellText(cell(row, "payment_status")));
    if (paymentStatus === "invalid") problems.push(`payment status "${cellText(cell(row, "payment_status"))}" is not PAID, UNPAID or CHARGED_TO_ADMISSION`);

    const amount = parseAmount(cellText(cell(row, "amount")));
    if (amount === "invalid") problems.push(`amount "${cellText(cell(row, "amount"))}" is not a number`);

    const raisedAt = parseWhen(cell(row, "raised_at"));
    if (raisedAt === "invalid") problems.push(`date "${cellText(cell(row, "raised_at"))}" is not in the form 2026-10-07 or 2026-10-07 14:30`);

    let queue: InvestigationQueue | null = null;
    const queueText = given(cellText(cell(row, "queue")));
    if (queueText) {
      const q = queueText.toUpperCase();
      if ((INVESTIGATION_QUEUES as readonly string[]).includes(q)) queue = q as InvestigationQueue;
      else problems.push(`queue "${queueText}" is not LAB, IMAGING or OTHER`);
    }

    if (problems.length > 0) {
      errors.push({ row: rowNumber, message: problems.join("; ") });
      continue;
    }

    const raw: Record<string, string> = {};
    headerCells.forEach((h, idx) => {
      raw[h] = cellText(row[idx]);
    });

    records.push({
      investigationRef: ref,
      patientHospitalNo: mrn,
      testName: testName as string,
      testCode: given(cellText(cell(row, "test_code"))),
      patientType: patientType as PatientType | null,
      paymentStatus: paymentStatus as ImportPaymentStatus | null,
      destination: given(cellText(cell(row, "destination"))),
      status: given(cellText(cell(row, "status")))?.toLowerCase() ?? null,
      amount: amount as string | null,
      raisedAt: raisedAt as Date | null,
      queue,
      raw,
      row: rowNumber,
    });
  }

  // The same number twice in one file: the later row wins, and the earlier one is reported.
  const lastRowFor = new Map<string, number>();
  for (const r of records) lastRowFor.set(r.investigationRef, r.row);
  const kept = records.filter((r) => {
    if (lastRowFor.get(r.investigationRef) === r.row) return true;
    errors.push({ row: r.row, message: `${r.investigationRef} appears again later in the file; the later row was used` });
    return false;
  });

  errors.sort((a, b) => a.row - b.row);
  return { records: kept, errors, headerRow: headerIndex + 1, blankRows };
}
