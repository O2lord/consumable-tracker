import "server-only";
import { eq, sql } from "drizzle-orm";
import { db } from "../db/client";
import { batches, cartons, itemTypes, locations, packs, transfers, units } from "../db/schema";
import {
  isValidBatchCode,
  normalizeCode,
  parseCartonCode,
  parseDeliveryCode,
  parsePackCode,
  parseSerial,
  parseTransferCode,
} from "../../lib/serial";
import { getTransferDetail } from "./transfer.service";
import { getDeliveryByCode } from "./delivery.service";

// Answers "what is this code?" for the label-check screen: validates the check character,
// then looks the code up. Read-only; it writes no events.

export type CodeLookup =
  | { kind: "invalid"; input: string }
  | { kind: "unknown"; code: string }
  | {
      kind: "unit";
      serial: string;
      state: string;
      itemName: string;
      itemCode: string;
      locationId: string;
      locationName: string;
      locationType: string;
      batchCode: string;
      /** The pack the bottle was received in; null when it was received loose. */
      packCode: string | null;
      expiryDate: string | null;
      /** The open transfer the bottle is on, when it is in transit or missing. */
      transferCode: string | null;
      transferToLocationId: string | null;
    }
  | {
      kind: "transfer";
      code: string;
      status: string;
      fromName: string;
      toName: string;
      toLocationId: string;
      itemCount: number;
    }
  | {
      kind: "delivery";
      code: string;
      supplier: string | null;
      locationName: string;
      itemCount: number;
    }
  | {
      kind: "carton";
      code: string;
      itemName: string;
      locationName: string;
      batchCode: string;
      packsCount: number;
      piecesCount: number;
      expiryDate: string | null;
    }
  | {
      kind: "pack";
      code: string;
      itemName: string;
      locationName: string;
      batchCode: string;
      /** The carton the pack came in; null when it was received loose. */
      cartonCode: string | null;
      piecesPerPack: number;
      piecesRemaining: number;
      expiryDate: string | null;
    }
  | {
      kind: "batch";
      code: string;
      itemName: string;
      trackingMode: string;
      quantity: number;
      /** How many cartons and packs the batch came in, so the check can say that instead of the piece total. */
      cartonCount: number;
      packCount: number;
      lotNo: string | null;
      expiryDate: string | null;
    };

export async function lookupCode(input: string): Promise<CodeLookup> {
  const serial = parseSerial(input);
  if (serial) {
    const [row] = await db()
      .select({
        state: units.state,
        itemName: itemTypes.name,
        itemCode: itemTypes.code,
        locationId: locations.id,
        locationName: locations.name,
        locationType: locations.type,
        batchCode: batches.code,
        packCode: packs.code,
        expiryDate: batches.expiryDate,
        transferCode: transfers.code,
        transferToLocationId: transfers.toLocationId,
      })
      .from(units)
      .innerJoin(itemTypes, eq(units.itemTypeId, itemTypes.id))
      .innerJoin(locations, eq(units.currentLocationId, locations.id))
      .innerJoin(batches, eq(units.batchId, batches.id))
      .leftJoin(packs, eq(units.packId, packs.id))
      .leftJoin(transfers, eq(units.currentTransferId, transfers.id))
      .where(eq(units.serial, serial));
    return row ? { kind: "unit", serial, ...row } : { kind: "unknown", code: serial };
  }

  const code = normalizeCode(input);
  if (isValidBatchCode(code)) {
    const [row] = await db()
      .select({
        itemName: itemTypes.name,
        trackingMode: itemTypes.trackingMode,
        quantity: batches.quantity,
        cartonCount: sql<number>`(select count(*)::int from ${cartons} where ${cartons.batchId} = ${batches.id})`,
        packCount: sql<number>`(select count(*)::int from ${packs} where ${packs.batchId} = ${batches.id})`,
        lotNo: batches.lotNo,
        expiryDate: batches.expiryDate,
      })
      .from(batches)
      .innerJoin(itemTypes, eq(batches.itemTypeId, itemTypes.id))
      .where(eq(batches.code, code));
    return row ? { kind: "batch", code, ...row } : { kind: "unknown", code };
  }

  const deliveryCode = parseDeliveryCode(input);
  if (deliveryCode) {
    const delivery = await getDeliveryByCode(deliveryCode);
    return delivery
      ? {
          kind: "delivery",
          code: delivery.code,
          supplier: delivery.supplier,
          locationName: delivery.locationName,
          itemCount: delivery.lines.length,
        }
      : { kind: "unknown", code: deliveryCode };
  }

  const cartonCode = parseCartonCode(input);
  if (cartonCode) {
    const [row] = await db()
      .select({
        itemName: itemTypes.name,
        locationName: locations.name,
        batchCode: batches.code,
        packsCount: cartons.packsCount,
        piecesCount: cartons.piecesCount,
        expiryDate: batches.expiryDate,
      })
      .from(cartons)
      .innerJoin(itemTypes, eq(cartons.itemTypeId, itemTypes.id))
      .innerJoin(locations, eq(cartons.locationId, locations.id))
      .innerJoin(batches, eq(cartons.batchId, batches.id))
      .where(eq(cartons.code, cartonCode));
    return row ? { kind: "carton", code: cartonCode, ...row } : { kind: "unknown", code: cartonCode };
  }

  const packCode = parsePackCode(input);
  if (packCode) {
    const [row] = await db()
      .select({
        itemName: itemTypes.name,
        locationName: locations.name,
        batchCode: batches.code,
        cartonCode: cartons.code,
        piecesPerPack: packs.piecesPerPack,
        piecesRemaining: packs.piecesRemaining,
        expiryDate: batches.expiryDate,
      })
      .from(packs)
      .innerJoin(itemTypes, eq(packs.itemTypeId, itemTypes.id))
      .innerJoin(locations, eq(packs.locationId, locations.id))
      .innerJoin(batches, eq(packs.batchId, batches.id))
      .leftJoin(cartons, eq(packs.cartonId, cartons.id))
      .where(eq(packs.code, packCode));
    return row ? { kind: "pack", code: packCode, ...row } : { kind: "unknown", code: packCode };
  }

  const transferCode = parseTransferCode(input);
  if (transferCode) {
    const detail = await getTransferDetail(transferCode);
    return detail
      ? {
          kind: "transfer",
          code: transferCode,
          status: detail.transfer.status,
          fromName: detail.fromName,
          toName: detail.toName,
          toLocationId: detail.transfer.toLocationId,
          itemCount: detail.totals.all,
        }
      : { kind: "unknown", code: transferCode };
  }

  return { kind: "invalid", input };
}
