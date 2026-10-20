import "server-only";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { appendEvents, type DbOrTx, type NewEvent } from "../audit/events";
import { db } from "../db/client";
import { batches, itemTypes, locations, units } from "../db/schema";
import { NotFoundError, ValidationError } from "../domain/errors";
import { generateBatchCode, generateSerial } from "../../lib/serial";
import { hasPackLabels } from "../../lib/pack-size";
import { createPacksForBatch } from "./pack.service";
import { MAX_SERIAL_BATCH, stockInInputSchema, type StockInInput } from "../../types/stock-in";

const UNIT_CHUNK = 1000;

export interface StockInResult {
  batch: typeof batches.$inferSelect;
  /** Serials minted for this batch (empty for QUANTITY items). Used to print labels. */
  serials: string[];
}

/** Where a batch came from. Manual entry unless it is received from an imported Pharmacy GRN line. */
export interface BatchOrigin {
  source: "MANUAL" | "PHARMACY_GRN";
  pharmacyGrnId?: string | null;
  pharmacyBatchId?: string | null;
  /** The delivery this batch is a line of (deliveries.id). Left out for a one-off receipt. */
  deliveryId?: string | null;
}

/**
 * Receives a batch into a store (manual entry, source = MANUAL, unless `origin` says it came from a GRN).
 * SERIAL item types get one unit and one STOCKED event per serial.
 * QUANTITY item types get the batch and a single STOCKED event carrying the quantity.
 * Everything happens in one transaction. The caller is responsible for checking that
 * `userId` may stock in (STORE_KEEPER, SUPERVISOR or ADMIN).
 */
export async function stockIn(
  rawInput: StockInInput,
  userId: string,
  conn: DbOrTx = db(),
  origin: BatchOrigin = { source: "MANUAL" },
): Promise<StockInResult> {
  const parsed = stockInInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.issues.map((i) => i.message).join("; "));
  }
  const input = parsed.data;

  // Expiry is compared as a calendar date (UTC); stock expiring today is still usable today.
  const today = new Date().toISOString().slice(0, 10);
  if (input.expiryDate && input.expiryDate < today) {
    throw new ValidationError("This batch has already expired and cannot be stocked in");
  }

  return conn.transaction(async (tx) => {
    const [itemType] = await tx.select().from(itemTypes).where(eq(itemTypes.id, input.itemTypeId));
    if (!itemType || !itemType.active) throw new NotFoundError("Item type");

    const [location] = await tx.select().from(locations).where(eq(locations.id, input.locationId));
    if (!location || !location.active) throw new NotFoundError("Location");
    if (location.type !== "STORE") {
      throw new ValidationError("Stock can only be received into a store location");
    }

    if (itemType.trackingMode === "SERIAL" && input.quantity > MAX_SERIAL_BATCH) {
      throw new ValidationError(`Serialized batches are limited to ${MAX_SERIAL_BATCH} units at a time`);
    }

    // Packs and rolls each get their own barcode, so the same limit as bottles applies to how many are made at once.
    const labelPacks = itemType.trackingMode === "QUANTITY" && hasPackLabels(itemType.unitOfMeasure);
    if (labelPacks && input.quantity > MAX_SERIAL_BATCH) {
      throw new ValidationError(`Packs and rolls are labelled one by one, so receive at most ${MAX_SERIAL_BATCH} at a time`);
    }

    const [batch] = await tx
      .insert(batches)
      .values({
        code: generateBatchCode(),
        itemTypeId: itemType.id,
        lotNo: input.lotNo,
        expiryDate: input.expiryDate,
        supplier: input.supplier,
        quantity: input.quantity,
        source: origin.source,
        pharmacyGrnId: origin.pharmacyGrnId ?? null,
        pharmacyBatchId: origin.pharmacyBatchId ?? null,
        deliveryId: origin.deliveryId ?? null,
        receivedBy: userId,
      })
      .returning();

    const occurredAt = new Date();
    const base = {
      locationId: location.id,
      userId,
      type: "STOCKED" as const,
      toState: "IN_STOCK" as const,
      occurredAt,
      deviceId: input.deviceId,
      payload: { batchCode: batch.code, ...(origin.pharmacyGrnId ? { pharmacyGrnId: origin.pharmacyGrnId } : {}) },
    };

    if (itemType.trackingMode === "QUANTITY") {
      await appendEvents(tx, [
        { ...base, id: randomUUID(), batchId: batch.id, quantity: input.quantity },
      ]);
      // The ledger above is the stock; the pack rows only give each physical pack a label to scan.
      if (labelPacks) {
        await createPacksForBatch(tx, {
          batchId: batch.id,
          itemTypeId: itemType.id,
          locationId: location.id,
          count: input.quantity,
          piecesPerPack: itemType.packSize,
        });
      }
      return { batch, serials: [] };
    }

    const serialSet = new Set<string>();
    while (serialSet.size < input.quantity) serialSet.add(generateSerial());
    const serials = [...serialSet];

    for (let i = 0; i < serials.length; i += UNIT_CHUNK) {
      const slice = serials.slice(i, i + UNIT_CHUNK);
      const created = await tx
        .insert(units)
        .values(
          slice.map((serial) => ({
            serial,
            itemTypeId: itemType.id,
            batchId: batch.id,
            state: "IN_STOCK" as const,
            currentLocationId: location.id,
          })),
        )
        .returning({ id: units.id });

      const rows: NewEvent[] = created.map((unit) => ({
        ...base,
        id: randomUUID(),
        unitId: unit.id,
        batchId: batch.id,
        quantity: 1,
      }));
      await appendEvents(tx, rows);
    }

    return { batch, serials };
  });
}
