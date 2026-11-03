import "server-only";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { appendEvents, type DbOrTx, type NewEvent } from "../audit/events";
import { db } from "../db/client";
import { batches, itemTypes, locations, units } from "../db/schema";
import { NotFoundError, ValidationError } from "../domain/errors";
import { generateBatchCode, generateSerial } from "../../lib/serial";
import { planReceipt } from "../../lib/pack-size";
import { ensureLabelCode } from "./catalog.service";
import { createCartonsForBatch, type CartonRef } from "./carton.service";
import { createPacksForBatch, type PackRef } from "./pack.service";
import { MAX_SERIAL_BATCH, stockInInputSchema, type StockInInput } from "../../types/stock-in";

const UNIT_CHUNK = 1000;

export interface StockInResult {
  batch: typeof batches.$inferSelect;
  /** Serials minted for this batch (empty for QUANTITY items). Used to print labels. */
  serials: string[];
}

/** Where a batch came from. Every batch is entered by hand, optionally as a line of a delivery. */
export interface BatchOrigin {
  source: "MANUAL";
  /** The delivery this batch is a line of (deliveries.id). Left out for a one-off receipt. */
  deliveryId?: string | null;
}

/**
 * Receives a batch into a store (manual entry, source = MANUAL).
 * `input.quantity` is counted in `input.entry` (cartons, packs or pieces); without an entry it is in the item's own unit.
 * SERIAL item types get one unit and one STOCKED event per serial.
 * QUANTITY item types get the batch and a single STOCKED event carrying the quantity.
 * A line counted in cartons also gets one carton row per carton; packs (and the bottles in them) point at their pack
 * and carton. Those rows are identity only: the ledger events above are the stock.
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

    // What this line becomes: the stock quantity the ledger records, and how many cartons, packs and bottles get labels.
    const plan = planReceipt({
      unit: itemType.unitOfMeasure,
      packSize: itemType.packSize,
      packsPerCarton: itemType.packsPerCarton,
      testsPerUnit: itemType.testsPerUnit,
      entry: input.entry,
      quantity: input.quantity,
      serial: itemType.trackingMode === "SERIAL",
    });
    if ("error" in plan) throw new ValidationError(plan.error);

    if (itemType.trackingMode === "SERIAL" && plan.quantity > MAX_SERIAL_BATCH) {
      throw new ValidationError(
        `That comes to ${plan.quantity.toLocaleString("en-GB")} labels, and at most ${MAX_SERIAL_BATCH.toLocaleString("en-GB")} can be made at a time. Receive it in two or more lines`,
      );
    }

    // Packs and rolls each get their own barcode, so the same limit as bottles applies to how many are made at once.
    if (plan.packs > MAX_SERIAL_BATCH) {
      throw new ValidationError(
        `That comes to ${plan.packs.toLocaleString("en-GB")} pack labels, and at most ${MAX_SERIAL_BATCH.toLocaleString("en-GB")} can be made at a time. Receive it in two or more lines`,
      );
    }

    const [batch] = await tx
      .insert(batches)
      .values({
        code: generateBatchCode(),
        itemTypeId: itemType.id,
        lotNo: input.lotNo,
        expiryDate: input.expiryDate,
        supplier: input.supplier,
        quantity: plan.quantity,
        source: origin.source,
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
      payload: { batchCode: batch.code },
    };

    // Cartons first, so the packs and bottles under them can point at them. A carton holds `plan.packsPerCarton` packs
    // (or the items themselves when there is no pack level) and `plan.packsPerCarton * plan.piecesPerPack` pieces.
    let cartonRefs: CartonRef[] = [];
    if (plan.cartons > 0) {
      cartonRefs = await createCartonsForBatch(tx, {
        batchId: batch.id,
        itemTypeId: itemType.id,
        deliveryId: origin.deliveryId ?? null,
        locationId: location.id,
        count: plan.cartons,
        packsCount: plan.packsPerCarton,
        piecesCount: plan.packsPerCarton * plan.piecesPerPack,
      });
    }
    // Position of a pack within the batch -> its carton. Packs fill cartons in order, `packsPerCarton` at a time.
    const cartonOfPack = (index: number): string | null =>
      cartonRefs.length > 0 ? (cartonRefs[Math.floor(index / plan.packsPerCarton)]?.id ?? null) : null;

    if (itemType.trackingMode === "QUANTITY") {
      await appendEvents(tx, [
        { ...base, id: randomUUID(), batchId: batch.id, quantity: plan.quantity },
      ]);
      // The ledger above is the stock; the pack rows only give each physical pack a label to scan.
      if (plan.packs > 0) {
        await createPacksForBatch(tx, {
          batchId: batch.id,
          itemTypeId: itemType.id,
          locationId: location.id,
          count: plan.packs,
          // A reagent container starts with all its tests; any other pack with its pack size.
          piecesPerPack: itemType.testsPerUnit ?? itemType.packSize,
          cartonIdOf: cartonOfPack,
        });
      }
      return { batch, serials: [] };
    }

    // Bottles that arrived in packs get pack rows (and so a PK label) too. Bottle j is in pack floor(j / piecesPerPack).
    let packRefs: PackRef[] = [];
    if (plan.packs > 0) {
      packRefs = await createPacksForBatch(tx, {
        batchId: batch.id,
        itemTypeId: itemType.id,
        locationId: location.id,
        count: plan.packs,
        piecesPerPack: plan.piecesPerPack,
        cartonIdOf: cartonOfPack,
      });
    }
    const bottlesPerCarton = plan.cartons > 0 ? plan.quantity / plan.cartons : 0;

    // Every bottle's serial starts with its item's label code (PT for a plain tube), so the label says what it is.
    const labelCode = await ensureLabelCode(tx, itemType);
    const serialSet = new Set<string>();
    while (serialSet.size < plan.quantity) serialSet.add(generateSerial(undefined, labelCode));
    const serials = [...serialSet];

    for (let i = 0; i < serials.length; i += UNIT_CHUNK) {
      const slice = serials.slice(i, i + UNIT_CHUNK);
      const created = await tx
        .insert(units)
        .values(
          slice.map((serial, j) => {
            const position = i + j;
            return {
              serial,
              itemTypeId: itemType.id,
              batchId: batch.id,
              state: "IN_STOCK" as const,
              currentLocationId: location.id,
              packId: packRefs.length > 0 ? (packRefs[Math.floor(position / plan.piecesPerPack)]?.id ?? null) : null,
              cartonId: cartonRefs.length > 0 ? (cartonRefs[Math.floor(position / bottlesPerCarton)]?.id ?? null) : null,
            };
          }),
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
