import "server-only";
import { desc, sql } from "drizzle-orm";
import type { DbOrTx } from "../audit/events";
import { db } from "../db/client";
import { pharmacyReconcileRuns } from "../db/schema";
import { pharmacyProvider } from "../integrations/pharmacy";
import { pageInfo, type Paged } from "../../lib/pagination";

// Compares the tracker with the imported Pharmacy exports (architecture sections 9 and 16.2, build.md
// Phase 6). It only reads: the two comparisons are the views v_pharmacy_mismatch (stock per location and
// batch) and v_pharmacy_transfer_check (transfer totals). Callers check `view_reports`.
//
// Everything here compares against a snapshot. A difference can simply mean the Pharmacy export is older
// than the tracker's latest movement, so every result carries the import time it was checked against.

export interface PharmacyImportStats {
  inventory: { rows: number; locations: number; lastImportedAt: Date | null };
  grn: { rows: number; grns: number; lastImportedAt: Date | null };
  transfers: { rows: number; lastImportedAt: Date | null };
}

export async function getPharmacyImportStats(conn: DbOrTx = db()): Promise<PharmacyImportStats> {
  const rows = await conn.execute<{
    kind: "INVENTORY" | "GRN_LINE" | "TRANSFER";
    total: number;
    locations: number;
    refs: number;
    last_imported_at: Date | null;
  }>(sql`
    select kind,
           count(*)::int as total,
           count(distinct location_id)::int as locations,
           count(distinct pharmacy_ref)::int as refs,
           max(imported_at) as last_imported_at
    from consumables.pharmacy_imports
    group by kind
  `);
  const by = new Map(Array.from(rows).map((r) => [r.kind, r]));
  const last = (k: "INVENTORY" | "GRN_LINE" | "TRANSFER") => {
    const v = by.get(k)?.last_imported_at;
    return v ? new Date(v) : null;
  };
  return {
    inventory: { rows: by.get("INVENTORY")?.total ?? 0, locations: by.get("INVENTORY")?.locations ?? 0, lastImportedAt: last("INVENTORY") },
    grn: { rows: by.get("GRN_LINE")?.total ?? 0, grns: by.get("GRN_LINE")?.refs ?? 0, lastImportedAt: last("GRN_LINE") },
    transfers: { rows: by.get("TRANSFER")?.total ?? 0, lastImportedAt: last("TRANSFER") },
  };
}

// --- stock: tracker quantity versus Pharmacy inventory ---------------------------------------------

export type StockProblem = "QUANTITY_DIFFERS" | "NOT_IN_TRACKER" | "NOT_IN_PHARMACY";

export interface StockMismatch {
  problem: StockProblem;
  locationId: string;
  locationName: string;
  batchNo: string | null;
  pharmacyItem: string | null;
  trackerItem: string | null;
  pharmacyQuantity: number | null;
  trackerQuantity: number | null;
  /** Tracker minus Pharmacy. */
  difference: number;
  pharmacyImportedAt: Date | null;
}

/** Stock the tracker and the last inventory export disagree on, per location and batch, biggest gap first. */
export async function listStockMismatches(
  opts: { locationId?: string; limit?: number } = {},
  conn: DbOrTx = db(),
): Promise<StockMismatch[]> {
  const limit = opts.limit ?? 500;
  const where = opts.locationId ? sql`where location_id = ${opts.locationId}::uuid` : sql``;
  const rows = await conn.execute<{
    problem: StockProblem;
    location_id: string;
    location_name: string;
    batch_no: string | null;
    pharmacy_item: string | null;
    tracker_item: string | null;
    pharmacy_quantity: number | null;
    tracker_quantity: number | null;
    difference: number;
    pharmacy_imported_at: Date | null;
  }>(sql`
    select * from consumables.v_pharmacy_mismatch
    ${where}
    order by location_name, abs(difference) desc, batch_no
    limit ${limit}
  `);
  return Array.from(rows).map((r) => ({
    problem: r.problem,
    locationId: r.location_id,
    locationName: r.location_name,
    batchNo: r.batch_no,
    pharmacyItem: r.pharmacy_item,
    trackerItem: r.tracker_item,
    pharmacyQuantity: r.pharmacy_quantity,
    trackerQuantity: r.tracker_quantity,
    difference: r.difference,
    pharmacyImportedAt: r.pharmacy_imported_at ? new Date(r.pharmacy_imported_at) : null,
  }));
}

// --- transfers: tracker dispatch totals versus Pharmacy transfers ----------------------------------

export type TransferProblem =
  | "QUANTITY_DIFFERS"
  | "NO_PHARMACY_TRANSFER"
  | "NO_TRACKER_TRANSFER"
  | "UNMAPPED_LOCATION"
  | "OK";

export interface TransferCheck {
  problem: TransferProblem;
  trackerCode: string | null;
  trackerStatus: string | null;
  fromLabel: string | null;
  toLabel: string | null;
  dispatchedAt: Date | null;
  trackerQuantity: number | null;
  pharmacyRef: string | null;
  pharmacyStatus: string | null;
  pharmacyRequestedBy: string | null;
  pharmacyRequestedAt: Date | null;
  pharmacyQuantity: number | null;
  /** Tracker minus Pharmacy; null when there is nothing to compare. */
  difference: number | null;
  sortAt: Date | null;
}

/** Transfers that do not line up, newest first. Pass `includeOk` to see the ones that agree too. */
export async function listTransferChecks(
  opts: { includeOk?: boolean; limit?: number } = {},
  conn: DbOrTx = db(),
): Promise<TransferCheck[]> {
  const limit = opts.limit ?? 500;
  const where = opts.includeOk ? sql`` : sql`where problem <> 'OK'`;
  const rows = await conn.execute<{
    problem: TransferProblem;
    tracker_code: string | null;
    tracker_status: string | null;
    from_label: string | null;
    to_label: string | null;
    dispatched_at: Date | null;
    tracker_quantity: number | null;
    pharmacy_ref: string | null;
    pharmacy_status: string | null;
    pharmacy_requested_by: string | null;
    pharmacy_requested_at: Date | null;
    pharmacy_quantity: number | null;
    difference: number | null;
    sort_at: Date | null;
  }>(sql`
    select * from consumables.v_pharmacy_transfer_check
    ${where}
    order by sort_at desc nulls last
    limit ${limit}
  `);
  const date = (v: Date | null) => (v ? new Date(v) : null);
  return Array.from(rows).map((r) => ({
    problem: r.problem,
    trackerCode: r.tracker_code,
    trackerStatus: r.tracker_status,
    fromLabel: r.from_label,
    toLabel: r.to_label,
    dispatchedAt: date(r.dispatched_at),
    trackerQuantity: r.tracker_quantity,
    pharmacyRef: r.pharmacy_ref,
    pharmacyStatus: r.pharmacy_status,
    pharmacyRequestedBy: r.pharmacy_requested_by,
    pharmacyRequestedAt: date(r.pharmacy_requested_at),
    pharmacyQuantity: r.pharmacy_quantity,
    difference: r.difference,
    sortAt: date(r.sort_at),
  }));
}

// --- summary ---------------------------------------------------------------------------------------

export interface PharmacyReconcileSummary {
  stock: Record<StockProblem, number>;
  transfers: Record<Exclude<TransferProblem, "OK">, number>;
  /** Everything wrong, for a single number on the dashboard. */
  total: number;
}

export async function getPharmacyReconcileSummary(conn: DbOrTx = db()): Promise<PharmacyReconcileSummary> {
  const [stockRows, transferRows] = await Promise.all([
    conn.execute<{ problem: StockProblem; n: number }>(
      sql`select problem, count(*)::int as n from consumables.v_pharmacy_mismatch group by problem`,
    ),
    conn.execute<{ problem: TransferProblem; n: number }>(
      sql`select problem, count(*)::int as n from consumables.v_pharmacy_transfer_check where problem <> 'OK' group by problem`,
    ),
  ]);
  const stock: Record<StockProblem, number> = { QUANTITY_DIFFERS: 0, NOT_IN_TRACKER: 0, NOT_IN_PHARMACY: 0 };
  for (const r of Array.from(stockRows)) stock[r.problem] = r.n;
  const transfers: PharmacyReconcileSummary["transfers"] = {
    QUANTITY_DIFFERS: 0,
    NO_PHARMACY_TRANSFER: 0,
    NO_TRACKER_TRANSFER: 0,
    UNMAPPED_LOCATION: 0,
  };
  for (const r of Array.from(transferRows)) if (r.problem !== "OK") transfers[r.problem] = r.n;
  const total = Object.values(stock).reduce((a, b) => a + b, 0) + Object.values(transfers).reduce((a, b) => a + b, 0);
  return { stock, transfers, total };
}

// --- reconcile runs (Phase 7) ----------------------------------------------------------------------

export interface ReconcileRun {
  id: string;
  triggeredBy: "JOB" | "USER";
  provider: "manual" | "csv" | "emr";
  runBy: string | null;
  summary: PharmacyReconcileSummary;
  problemsTotal: number;
  inventoryImportedAt: Date | null;
  transfersImportedAt: Date | null;
  startedAt: Date;
  finishedAt: Date | null;
  /** Problems now minus problems at the run before; null for the first run. */
  change: number | null;
}

function toRun(r: typeof pharmacyReconcileRuns.$inferSelect, previousTotal: number | null): ReconcileRun {
  return {
    id: r.id,
    triggeredBy: r.triggeredBy,
    provider: r.provider,
    runBy: r.runBy,
    summary: r.summary as PharmacyReconcileSummary,
    problemsTotal: r.problemsTotal,
    inventoryImportedAt: r.inventoryImportedAt,
    transfersImportedAt: r.transfersImportedAt,
    startedAt: r.startedAt,
    finishedAt: r.finishedAt,
    change: previousTotal === null ? null : r.problemsTotal - previousTotal,
  };
}

/**
 * Compares the tracker with Pharmacy now and records the counts (shadow mode: nothing is blocked, the
 * mismatches are only logged). `triggeredBy` is JOB for the scheduled call and USER for the button.
 */
export async function runPharmacyReconcile(
  opts: { triggeredBy: "JOB" | "USER"; userId?: string },
  conn: DbOrTx = db(),
): Promise<ReconcileRun> {
  const startedAt = new Date();
  const [summary, stats, [previous]] = await Promise.all([
    getPharmacyReconcileSummary(conn),
    getPharmacyImportStats(conn),
    conn
      .select({ total: pharmacyReconcileRuns.problemsTotal })
      .from(pharmacyReconcileRuns)
      .orderBy(desc(pharmacyReconcileRuns.startedAt))
      .limit(1),
  ]);

  const [row] = await conn
    .insert(pharmacyReconcileRuns)
    .values({
      triggeredBy: opts.triggeredBy,
      provider: pharmacyProvider().source,
      runBy: opts.userId ?? null,
      summary,
      problemsTotal: summary.total,
      inventoryImportedAt: stats.inventory.lastImportedAt,
      transfersImportedAt: stats.transfers.lastImportedAt,
      startedAt,
      finishedAt: new Date(),
    })
    .returning();
  return toRun(row, previous ? previous.total : null);
}

/** The latest runs, newest first. `offset` skips that many of the newest. */
export async function listReconcileRuns(limit = 15, conn: DbOrTx = db(), offset = 0): Promise<ReconcileRun[]> {
  const rows = await conn
    .select()
    .from(pharmacyReconcileRuns)
    .orderBy(desc(pharmacyReconcileRuns.startedAt), desc(pharmacyReconcileRuns.id))
    .limit(limit + 1)
    .offset(offset);
  return rows.slice(0, limit).map((r, i) => toRun(r, rows[i + 1]?.problemsTotal ?? null));
}

/** One page of runs, with the true total. */
export async function listReconcileRunsPage(page: number, conn: DbOrTx = db()): Promise<Paged<ReconcileRun>> {
  const [{ total }] = await conn.select({ total: sql<number>`count(*)::int` }).from(pharmacyReconcileRuns);
  const info = pageInfo(page, total);
  const rows = total === 0 ? [] : await listReconcileRuns(info.pageSize, conn, info.offset);
  return { ...info, rows };
}
