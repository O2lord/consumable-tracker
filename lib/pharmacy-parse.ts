// Reads the three Pharmacy exports (architecture sections 9 and 16): stock on hand, a GRN, and the
// transfers list. Pure: no I/O, rows in, records out.
//
// The tracker defines the standard columns below; the Pharmacy exports to fit them. The headers the
// staff portal uses today (Generic, Strength, Brand, Batch, Expiry, Qty, Cost / Medication, Unit,
// Qty, Rate / Type, Location, Destination, Qty Requested, Lines) are accepted as aliases so a portal
// export loads as it is. The header row is found by name, because exports start with preamble rows.

import type { PharmacyImportKind } from "../server/domain/types";
import { cellText, ImportFormatError, parseAmount, type RowError } from "./import-parse";

export { ImportFormatError };
export type { RowError };

export interface ParsedPharmacyRow {
  /** 1-based row number in the file, for error messages. */
  row: number;
  kind: PharmacyImportKind;
  /**
   * What makes a row "the same row" in a later export. For INVENTORY the service puts the resolved
   * location in front of it, because the file may not say where the stock is.
   */
  naturalKey: string;
  /** GRN number, or the Pharmacy transfer id when the file has one. */
  pharmacyRef: string | null;
  /** INVENTORY: the location column when the file has one. TRANSFER: where the stock came from. */
  locationText: string | null;
  /** TRANSFER: where the stock went to. */
  destinationText: string | null;
  genericName: string | null;
  strength: string | null;
  brand: string | null;
  itemLabel: string | null;
  /** Generic and brand, normalised: the same medicine in an inventory export and a GRN export. */
  itemKey: string | null;
  batchNo: string | null;
  /** YYYY-MM-DD. */
  expiryDate: string | null;
  quantity: number;
  /** Two decimals, as text (the column is numeric). */
  unitCost: string | null;
  unit: string | null;
  category: string | null;
  supplier: string | null;
  transferType: string | null;
  status: string | null;
  requestedBy: string | null;
  requestedAt: Date | null;
  lines: number | null;
  /** Every cell of the row, keyed by the file's own header text. */
  raw: Record<string, string>;
}

export interface PharmacyParseResult {
  kind: PharmacyImportKind;
  records: ParsedPharmacyRow[];
  errors: RowError[];
  /** 1-based row the headers were found on. */
  headerRow: number;
  /** Rows with no cell filled in. */
  blankRows: number;
}

// --- small value parsers ------------------------------------------------------------------------

const norm = (s: string | null | undefined) => (s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

/** An empty cell and a lone dash both mean "not given". */
function given(text: string): string | null {
  const t = text.trim();
  return t === "" || t === "-" || t === "–" ? null : t;
}

/** "100", "1,100" and "2000.00" are counts; "10.5" and "ten" are not. */
export function parseCount(text: string): number | null | "invalid" {
  const v = given(text);
  if (v === null) return null;
  const cleaned = v.replace(/[,\s]/g, "");
  if (!/^\d+(\.0+)?$/.test(cleaned)) return "invalid";
  const n = Number(cleaned);
  return Number.isSafeInteger(n) && n <= 2_000_000_000 ? n : "invalid";
}

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

/** The hospital is in Nigeria: times with no zone are West Africa Time, UTC+1 all year (no daylight saving). */
const LOCAL_OFFSET_MINUTES = 60;

const ISO_PARTS = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?)?\s*(Z|[+-]\d{2}:?\d{2})?$/i;
const DMY_PARTS = /^(\d{1,2})[\s-]+([A-Za-z]{3,9})[\s,-]+(\d{4})(?:[\s,]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/;

interface DateParts {
  y: number;
  m: number;
  d: number;
  hh: number;
  mm: number;
  ss: number;
  offsetMinutes: number;
}

function dateParts(text: string): DateParts | null {
  let y: number, m: number, d: number, hh = 0, mm = 0, ss = 0;
  let offsetMinutes = LOCAL_OFFSET_MINUTES;

  const iso = ISO_PARTS.exec(text);
  const dmy = iso ? null : DMY_PARTS.exec(text);
  if (iso) {
    y = Number(iso[1]);
    m = Number(iso[2]) - 1;
    d = Number(iso[3]);
    hh = Number(iso[4] ?? 0);
    mm = Number(iso[5] ?? 0);
    ss = Number(iso[6] ?? 0);
    const zone = iso[7];
    if (zone) {
      if (zone.toUpperCase() === "Z") offsetMinutes = 0;
      else {
        const digits = zone.replace(":", "");
        offsetMinutes = (digits[0] === "-" ? -1 : 1) * (Number(digits.slice(1, 3)) * 60 + Number(digits.slice(3, 5)));
      }
    }
  } else if (dmy) {
    const month = MONTHS[dmy[2].slice(0, 3).toLowerCase()];
    if (month === undefined) return null;
    y = Number(dmy[3]);
    m = month;
    d = Number(dmy[1]);
    hh = Number(dmy[4] ?? 0);
    mm = Number(dmy[5] ?? 0);
    ss = Number(dmy[6] ?? 0);
  } else {
    return null;
  }

  // A real calendar date and a real time of day: 31 Feb or 25:00 are rejected, not rolled over.
  const probe = new Date(Date.UTC(y, m, d, hh, mm, ss));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== m || probe.getUTCDate() !== d) return null;
  if (hh > 23 || mm > 59 || ss > 59) return null;
  return { y, m, d, hh, mm, ss, offsetMinutes };
}

/** A calendar day (an expiry date) as YYYY-MM-DD. Accepts 2031-07-24 and 24 Jul 2031. */
export function parseDay(value: unknown): string | null | "invalid" {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? "invalid" : value.toISOString().slice(0, 10);
  const v = given(cellText(value));
  if (v === null) return null;
  const p = dateParts(v);
  if (!p) return "invalid";
  return `${String(p.y).padStart(4, "0")}-${String(p.m + 1).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`;
}

/**
 * A moment in time. Accepts ISO (with or without a zone) and the portal's "26 Sep 2026 13:55".
 * With no zone it is read as West Africa Time. A day-first numeric date (31/10/2026) is rejected
 * rather than guessed.
 */
export function parseStamp(value: unknown): Date | null | "invalid" {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? "invalid" : value;
  const v = given(cellText(value));
  if (v === null) return null;
  const p = dateParts(v);
  if (!p) return "invalid";
  return new Date(Date.UTC(p.y, p.m, p.d, p.hh, p.mm, p.ss) - p.offsetMinutes * 60_000);
}

// --- header and row plumbing --------------------------------------------------------------------

type Aliases<C extends string> = Record<C, readonly string[]>;

function findColumns<C extends string>(row: readonly unknown[], aliases: Aliases<C>): Map<C, number> {
  const found = new Map<C, number>();
  const names = Object.keys(aliases) as C[];
  row.forEach((cell, index) => {
    const key = norm(cellText(cell));
    if (!key) return;
    for (const column of names) {
      if (!found.has(column) && (aliases[column].includes(key) || norm(column) === key)) {
        found.set(column, index);
        break;
      }
    }
  });
  return found;
}

interface RowContext<C extends string> {
  row: number;
  problems: string[];
  has: (column: C) => boolean;
  /** The cell as text, "" when the column is missing or empty. */
  text: (column: C) => string;
  /** The cell as the spreadsheet gave it (dates stay dates). */
  value: (column: C) => unknown;
}

type Built = Omit<ParsedPharmacyRow, "raw" | "row" | "kind">;

interface TableSpec<C extends string> {
  kind: PharmacyImportKind;
  what: string;
  aliases: Aliases<C>;
  required: readonly C[];
  /** Portal header names, for the error message. */
  hint: string;
  /** Throws an ImportFormatError for a problem that is the file's as a whole, once the header is known. */
  check?: (has: (column: C) => boolean) => void;
  build: (ctx: RowContext<C>) => Built | null;
}

function parseTable<C extends string>(rows: readonly (readonly unknown[])[], spec: TableSpec<C>): PharmacyParseResult {
  let headerIndex = -1;
  let columns = new Map<C, number>();
  for (let i = 0; i < Math.min(rows.length, 25); i++) {
    const found = findColumns(rows[i] ?? [], spec.aliases);
    if (spec.required.every((c) => found.has(c))) {
      headerIndex = i;
      columns = found;
      break;
    }
  }
  if (headerIndex < 0) {
    throw new ImportFormatError(
      `Could not find the header row of the ${spec.what} file. It needs these columns: ${spec.required.join(", ")} (portal names such as ${spec.hint} also work).`,
    );
  }
  const has = (column: C) => columns.has(column);
  spec.check?.(has);

  const headerCells = (rows[headerIndex] ?? []).map((c, i) => cellText(c) || `column_${i + 1}`);
  const records: ParsedPharmacyRow[] = [];
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
    const value = (column: C): unknown => {
      const at = columns.get(column);
      return at === undefined ? undefined : row[at];
    };
    const built = spec.build({ row: rowNumber, problems, has, value, text: (c) => cellText(value(c)) });
    if (problems.length > 0 || !built) {
      errors.push({ row: rowNumber, message: problems.join("; ") || "the row could not be read" });
      continue;
    }
    const raw: Record<string, string> = {};
    headerCells.forEach((h, idx) => {
      raw[h] = cellText(row[idx]);
    });
    records.push({ ...built, kind: spec.kind, row: rowNumber, raw });
  }

  // The same line twice in one file: the later row wins, and the earlier one is reported.
  const keyOf = (r: ParsedPharmacyRow) => `${norm(r.locationText)}#${r.naturalKey}`;
  const lastRowFor = new Map<string, number>();
  for (const r of records) lastRowFor.set(keyOf(r), r.row);
  const kept = records.filter((r) => {
    if (lastRowFor.get(keyOf(r)) === r.row) return true;
    errors.push({ row: r.row, message: `this line appears again later in the file (row ${lastRowFor.get(keyOf(r))}); the later row was used` });
    return false;
  });

  errors.sort((a, b) => a.row - b.row);
  return { kind: spec.kind, records: kept, errors, headerRow: headerIndex + 1, blankRows };
}

/** "Amoxicillin", "500 mg", "Amoxil" -> "Amoxicillin 500 mg (Amoxil)". */
function itemLabel(generic: string, strength: string | null, brand: string | null): string {
  return [generic, strength].filter(Boolean).join(" ") + (brand ? ` (${brand})` : "");
}

function emptyBuilt(): Built {
  return {
    naturalKey: "",
    pharmacyRef: null,
    locationText: null,
    destinationText: null,
    genericName: null,
    strength: null,
    brand: null,
    itemLabel: null,
    itemKey: null,
    batchNo: null,
    expiryDate: null,
    quantity: 0,
    unitCost: null,
    unit: null,
    category: null,
    supplier: null,
    transferType: null,
    status: null,
    requestedBy: null,
    requestedAt: null,
    lines: null,
  };
}

function quantityOf<C extends string>(ctx: RowContext<C>, column: C): number {
  const raw = ctx.text(column);
  const q = parseCount(raw);
  if (q === null) ctx.problems.push("the quantity is empty");
  else if (q === "invalid") ctx.problems.push(`quantity "${raw}" is not a whole number`);
  return typeof q === "number" ? q : 0;
}

function expiryOf<C extends string>(ctx: RowContext<C>, column: C): string | null {
  const day = parseDay(ctx.value(column));
  if (day === "invalid") {
    ctx.problems.push(`expiry "${ctx.text(column)}" is not a date (use 2031-07-24 or 24 Jul 2031)`);
    return null;
  }
  return day;
}

function costOf<C extends string>(ctx: RowContext<C>, column: C): string | null {
  const cost = parseAmount(ctx.text(column));
  if (cost === "invalid") {
    ctx.problems.push(`amount "${ctx.text(column)}" is not a number`);
    return null;
  }
  return cost;
}

// --- INVENTORY: stock on hand -------------------------------------------------------------------

type InventoryColumn = "location" | "generic" | "strength" | "brand" | "batch" | "expiry" | "quantity" | "cost";

const INVENTORY_ALIASES: Aliases<InventoryColumn> = {
  location: ["location", "store", "pharmacy", "locationname"],
  generic: ["generic", "genericname", "medication", "drug", "item"],
  strength: ["strength", "dose"],
  brand: ["brand", "brandname"],
  batch: ["batch", "batchno", "batchnumber", "lot", "lotno"],
  expiry: ["expiry", "expirydate", "expires"],
  quantity: ["quantity", "qty", "onhand", "stock", "balance"],
  cost: ["cost", "unitcost", "rate", "price"],
};

export function parseInventoryRows(rows: readonly (readonly unknown[])[]): PharmacyParseResult {
  return parseTable<InventoryColumn>(rows, {
    kind: "INVENTORY",
    what: "inventory",
    aliases: INVENTORY_ALIASES,
    required: ["generic", "batch", "quantity"],
    hint: "Generic, Batch and Qty",
    build: (ctx) => {
      const generic = given(ctx.text("generic"));
      if (!generic) ctx.problems.push("the generic name is empty");
      const batch = given(ctx.text("batch"));
      if (!batch) ctx.problems.push("the batch number is empty");
      const strength = given(ctx.text("strength"));
      const brand = given(ctx.text("brand"));
      const quantity = quantityOf(ctx, "quantity");
      const expiryDate = expiryOf(ctx, "expiry");
      const unitCost = costOf(ctx, "cost");
      if (!generic || !batch) return null;
      return {
        ...emptyBuilt(),
        naturalKey: `${norm(generic)}|${norm(strength)}|${norm(brand)}|${norm(batch)}`,
        locationText: given(ctx.text("location")),
        genericName: generic,
        strength,
        brand,
        itemLabel: itemLabel(generic, strength, brand),
        itemKey: norm(generic + (brand ?? "")),
        batchNo: batch,
        expiryDate,
        quantity,
        unitCost,
      };
    },
  });
}

// --- GRN: goods received note lines -------------------------------------------------------------

type GrnColumn = "grn_ref" | "medication" | "unit" | "quantity" | "rate" | "batch" | "expiry" | "category" | "supplier";

const GRN_ALIASES: Aliases<GrnColumn> = {
  grn_ref: ["grnref", "grn", "grnno", "grnnumber"],
  medication: ["medication", "item", "drug", "generic", "product"],
  unit: ["unit", "unitsize", "pack"],
  quantity: ["quantity", "qty"],
  rate: ["rate", "cost", "unitcost", "price"],
  batch: ["batch", "batchno", "batchnumber", "lot", "lotno"],
  expiry: ["expiry", "expirydate", "expires"],
  category: ["category"],
  supplier: ["supplier", "vendor"],
};

/** "GRNS00002" out of "grn-GRNS00002.xlsx": the portal puts the GRN number in the file name only. */
export function grnRefFromFileName(fileName: string): string | null {
  const m = /\b(GRNS?\d+)\b/i.exec(fileName.replace(/[_.]/g, " "));
  return m ? m[1].toUpperCase() : null;
}

/** "Amoxicillin (Amoxil)" -> generic and brand. A name with no brackets is all generic. */
export function splitMedication(text: string): { generic: string; brand: string | null } {
  const m = /^(.*?)\s*\(([^()]*)\)\s*$/.exec(text.trim());
  if (!m || !m[1].trim()) return { generic: text.trim(), brand: null };
  return { generic: m[1].trim(), brand: given(m[2]) };
}

export function parseGrnRows(rows: readonly (readonly unknown[])[], opts: { grnRef?: string | null } = {}): PharmacyParseResult {
  const fallbackRef = given(opts.grnRef ?? "")?.toUpperCase().replace(/\s+/g, "") ?? null;
  return parseTable<GrnColumn>(rows, {
    kind: "GRN_LINE",
    what: "GRN",
    aliases: GRN_ALIASES,
    required: ["medication", "batch", "quantity"],
    hint: "Medication, Batch and Qty",
    check: (has) => {
      if (!has("grn_ref") && !fallbackRef) {
        throw new ImportFormatError(
          "The GRN number is not in the file. Add a grn_ref column, name the file like grn-GRNS00002.xlsx, or type the number in the form.",
        );
      }
    },
    build: (ctx) => {
      const medication = given(ctx.text("medication"));
      if (!medication) ctx.problems.push("the medication is empty");
      const batch = given(ctx.text("batch"));
      if (!batch) ctx.problems.push("the batch number is empty");
      const ref = (ctx.has("grn_ref") ? given(ctx.text("grn_ref")) : null)?.toUpperCase().replace(/\s+/g, "") ?? fallbackRef;
      if (!ref) ctx.problems.push("the GRN number is empty");
      const quantity = quantityOf(ctx, "quantity");
      const expiryDate = expiryOf(ctx, "expiry");
      const unitCost = costOf(ctx, "rate");
      if (!medication || !batch || !ref) return null;
      const { generic, brand } = splitMedication(medication);
      return {
        ...emptyBuilt(),
        naturalKey: `${norm(ref)}|${norm(generic)}|${norm(brand)}|${norm(batch)}`,
        pharmacyRef: ref,
        genericName: generic,
        brand,
        itemLabel: itemLabel(generic, null, brand),
        itemKey: norm(generic + (brand ?? "")),
        batchNo: batch,
        expiryDate,
        quantity,
        unitCost,
        unit: given(ctx.text("unit")),
        category: given(ctx.text("category")),
        supplier: given(ctx.text("supplier")),
      };
    },
  });
}

// --- TRANSFER: Pharmacy transfers (totals only) ------------------------------------------------

type TransferColumn =
  | "transfer_ref"
  | "type"
  | "from_location"
  | "to_location"
  | "status"
  | "requested_by"
  | "requested_at"
  | "quantity"
  | "lines";

const TRANSFER_ALIASES: Aliases<TransferColumn> = {
  transfer_ref: ["transferref", "transferid", "transferno", "ref", "reference"],
  type: ["type", "transfertype", "direction"],
  from_location: ["location", "fromlocation", "from", "source", "sender"],
  to_location: ["destination", "tolocation", "to", "receiver"],
  status: ["status", "transferstatus"],
  requested_by: ["requestedby", "requester", "createdby"],
  requested_at: ["requestedat", "requestdate", "date", "createdat"],
  quantity: ["qtyrequested", "quantityrequested", "quantity", "qty", "totalquantity"],
  lines: ["lines", "linecount", "items"],
};

export function parseTransferRows(rows: readonly (readonly unknown[])[]): PharmacyParseResult {
  return parseTable<TransferColumn>(rows, {
    kind: "TRANSFER",
    what: "transfers",
    aliases: TRANSFER_ALIASES,
    required: ["from_location", "to_location", "requested_at", "quantity"],
    hint: "Location, Destination, Requested At and Qty Requested",
    build: (ctx) => {
      const location = given(ctx.text("from_location"));
      if (!location) ctx.problems.push("the location is empty");
      const destination = given(ctx.text("to_location"));
      if (!destination) ctx.problems.push("the destination is empty");
      if (location && destination && norm(location) === norm(destination)) {
        ctx.problems.push("the location and destination are the same");
      }

      // "send": the location sends to the destination. "request": the location asks the destination to
      // send, so the stock moves the other way. Anything else is rejected rather than guessed.
      const typeText = given(ctx.text("type"));
      const type = typeText ? typeText.toLowerCase() : "send";
      if (type !== "send" && type !== "request") ctx.problems.push(`type "${typeText}" is not send or request`);

      const requestedAt = parseStamp(ctx.value("requested_at"));
      if (requestedAt === null) ctx.problems.push("the request time is empty");
      else if (requestedAt === "invalid") {
        ctx.problems.push(`time "${ctx.text("requested_at")}" is not in the form 2026-10-07 14:30 or 07 Oct 2026 14:30`);
      }

      const quantity = quantityOf(ctx, "quantity");
      const linesText = ctx.text("lines");
      const lines = parseCount(linesText);
      if (lines === "invalid") ctx.problems.push(`lines "${linesText}" is not a whole number`);

      if (!location || !destination || !(requestedAt instanceof Date)) return null;

      const ref = ctx.has("transfer_ref") ? given(ctx.text("transfer_ref")) : null;
      const requester = given(ctx.text("requested_by"));
      const naturalKey = ref
        ? `ref|${norm(ref)}`
        : `${type}|${norm(location)}|${norm(destination)}|${requestedAt.toISOString()}|${norm(requester)}`;
      const flip = type === "request";
      return {
        ...emptyBuilt(),
        naturalKey,
        pharmacyRef: ref,
        locationText: flip ? destination : location,
        destinationText: flip ? location : destination,
        transferType: type,
        status: given(ctx.text("status"))?.toLowerCase() ?? null,
        requestedBy: requester,
        requestedAt,
        quantity,
        lines: typeof lines === "number" ? lines : null,
      };
    },
  });
}

export function parsePharmacyRows(
  kind: PharmacyImportKind,
  rows: readonly (readonly unknown[])[],
  opts: { grnRef?: string | null } = {},
): PharmacyParseResult {
  if (kind === "INVENTORY") return parseInventoryRows(rows);
  if (kind === "GRN_LINE") return parseGrnRows(rows, opts);
  return parseTransferRows(rows);
}
