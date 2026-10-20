import "server-only";
import { and, eq, sql } from "drizzle-orm";
import type { DbOrTx } from "../audit/events";
import { db } from "../db/client";
import { isUniqueViolation } from "../db/errors";
import { batches, deliveries, itemTypes } from "../db/schema";
import { NotFoundError, ValidationError } from "../domain/errors";
import { pharmacyProvider, type PharmacyGrnLine } from "../integrations/pharmacy";
import { createDelivery } from "./delivery.service";
import { stockIn, type StockInResult } from "./stock-in.service";

// Receiving stock from a Pharmacy GRN (architecture sections 9 and 16.2, build.md Phases 6 and 7).
// The store keeper opens a GRN that Pharmacy has verified, and each line becomes a tracker batch
// (source = PHARMACY_GRN) with the Pharmacy batch number as its lot number, so the Pharmacy mismatch
// report can compare the two sides. Quantity, expiry and supplier come from Pharmacy, not from typing.
// The caller checks `stock_in`.
//
// Reads go through the PharmacyProvider, so this works the same when the EMR provider replaces the CSV one.

const norm = (s: string | null | undefined) => (s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

export interface GrnSummary {
  grnRef: string;
  supplier: string | null;
  lines: number;
  receivedLines: number;
  totalQuantity: number;
  importedAt: Date;
}

export interface GrnLineView extends PharmacyGrnLine {
  /** An active item type whose Pharmacy catalog id matches this line, when there is exactly one. */
  suggestedItemTypeId: string | null;
  /** The tracker batch already created from this line, if any. */
  receivedBatchCode: string | null;
}

/** "GRNS00002|bat342" -> the batch code already made from it. */
async function receivedBatches(conn: DbOrTx): Promise<Map<string, string>> {
  const rows = await conn
    .select({ grn: batches.pharmacyGrnId, batchNo: batches.pharmacyBatchId, code: batches.code })
    .from(batches)
    .where(eq(batches.source, "PHARMACY_GRN"));
  const map = new Map<string, string>();
  for (const r of rows) map.set(`${(r.grn ?? "").toUpperCase()}|${norm(r.batchNo)}`, r.code);
  return map;
}

const lineKey = (l: Pick<PharmacyGrnLine, "grnRef" | "batchNo">) => `${l.grnRef.toUpperCase()}|${norm(l.batchNo)}`;

/** GRNs known to the Pharmacy provider, newest import first, with how many lines are received already. */
export async function listGrnSummaries(conn: DbOrTx = db()): Promise<GrnSummary[]> {
  const [lines, received] = await Promise.all([pharmacyProvider().listGrns(), receivedBatches(conn)]);
  const by = new Map<string, GrnSummary>();
  for (const l of lines) {
    const s = by.get(l.grnRef) ?? {
      grnRef: l.grnRef,
      supplier: l.supplier,
      lines: 0,
      receivedLines: 0,
      totalQuantity: 0,
      importedAt: l.importedAt,
    };
    s.lines += 1;
    s.totalQuantity += l.quantity;
    if (received.has(lineKey(l))) s.receivedLines += 1;
    if (!s.supplier && l.supplier) s.supplier = l.supplier;
    if (l.importedAt > s.importedAt) s.importedAt = l.importedAt;
    by.set(l.grnRef, s);
  }
  return [...by.values()].sort((a, b) => b.importedAt.getTime() - a.importedAt.getTime());
}

/** One GRN's lines, each with the item type it probably is and whether it was received already. */
export async function getGrnReceipt(grnRef: string, conn: DbOrTx = db()): Promise<GrnLineView[] | null> {
  const lines = await pharmacyProvider().listGrns(grnRef);
  if (lines.length === 0) return null;

  const [received, types] = await Promise.all([
    receivedBatches(conn),
    conn
      .select({ id: itemTypes.id, pharmacyCatalogId: itemTypes.pharmacyCatalogId })
      .from(itemTypes)
      .where(eq(itemTypes.active, true)),
  ]);

  return lines.map((l) => {
    const matches = types.filter((t) => {
      const k = norm(t.pharmacyCatalogId);
      return k !== "" && (k === norm(l.itemLabel) || k === l.itemKey);
    });
    return {
      ...l,
      suggestedItemTypeId: matches.length === 1 ? matches[0].id : null,
      receivedBatchCode: received.get(lineKey(l)) ?? null,
    };
  });
}

/**
 * Receives one GRN line into a store. The line is looked up again here (by GRN, batch number and item),
 * so the quantity, expiry and supplier are Pharmacy's, never whatever the browser sent. A line that was
 * already received is refused, and so is an expired batch or a non-store location (stockIn checks those).
 *
 * Every line of one GRN into the same store joins one delivery (reference = the GRN number), created by the first
 * line received. Lines are received one at a time, so a lock on the GRN number keeps two people receiving different
 * lines of it together from each creating a delivery.
 */
export async function receiveGrnLine(
  input: { grnRef: string; batchNo: string; itemKey: string; itemTypeId: string; locationId: string; deviceId?: string },
  userId: string,
  conn: DbOrTx = db(),
): Promise<StockInResult> {
  const lines = await pharmacyProvider().listGrns(input.grnRef);
  const line = lines.find((l) => norm(l.batchNo) === norm(input.batchNo) && l.itemKey === input.itemKey);
  if (!line) throw new NotFoundError("GRN line");

  try {
    return await conn.transaction(async (tx) => {
      const [already] = await tx
        .select({ code: batches.code })
        .from(batches)
        .where(
          and(
            eq(batches.source, "PHARMACY_GRN"),
            sql`upper(${batches.pharmacyGrnId}) = ${line.grnRef.toUpperCase()}`,
            sql`consumables.norm_text(${batches.pharmacyBatchId}) = ${norm(line.batchNo)}`,
          ),
        )
        .limit(1);
      if (already) {
        throw new ValidationError(`This GRN line was already received as batch ${already.code}`);
      }

      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`grn-delivery:${line.grnRef.toUpperCase()}`}))`);
      const [existing] = await tx
        .select({ id: deliveries.id })
        .from(deliveries)
        .innerJoin(batches, eq(batches.deliveryId, deliveries.id))
        .where(
          and(
            eq(batches.source, "PHARMACY_GRN"),
            sql`upper(${batches.pharmacyGrnId}) = ${line.grnRef.toUpperCase()}`,
            eq(deliveries.locationId, input.locationId),
          ),
        )
        .limit(1);
      const delivery =
        existing ??
        (await createDelivery(
          { supplier: line.supplier, reference: line.grnRef, locationId: input.locationId, userId },
          tx,
        ));

      return stockIn(
        {
          itemTypeId: input.itemTypeId,
          locationId: input.locationId,
          quantity: line.quantity,
          lotNo: line.batchNo,
          expiryDate: line.expiryDate ?? undefined,
          supplier: line.supplier ?? undefined,
          deviceId: input.deviceId,
        },
        userId,
        tx,
        { source: "PHARMACY_GRN", pharmacyGrnId: line.grnRef, pharmacyBatchId: line.batchNo, deliveryId: delivery.id },
      );
    });
  } catch (err) {
    // Two people pressing the button together: the unique index lets one through.
    if (isUniqueViolation(err)) throw new ValidationError("This GRN line was just received by someone else");
    throw err;
  }
}
