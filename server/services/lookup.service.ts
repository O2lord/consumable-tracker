import "server-only";
import { eq } from "drizzle-orm";
import { db } from "../db/client";
import { batches, itemTypes, locations, packs, transfers, units } from "../db/schema";
import {
  isValidBatchCode,
  normalizeCode,
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
      kind: "pack";
      code: string;
      itemName: string;
      locationName: string;
      batchCode: string;
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
        expiryDate: batches.expiryDate,
        transferCode: transfers.code,
        transferToLocationId: transfers.toLocationId,
      })
      .from(units)
      .innerJoin(itemTypes, eq(units.itemTypeId, itemTypes.id))
      .innerJoin(locations, eq(units.currentLocationId, locations.id))
      .innerJoin(batches, eq(units.batchId, batches.id))
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

  const packCode = parsePackCode(input);
  if (packCode) {
    const [row] = await db()
      .select({
        itemName: itemTypes.name,
        locationName: locations.name,
        batchCode: batches.code,
        piecesPerPack: packs.piecesPerPack,
        piecesRemaining: packs.piecesRemaining,
        expiryDate: batches.expiryDate,
      })
      .from(packs)
      .innerJoin(itemTypes, eq(packs.itemTypeId, itemTypes.id))
      .innerJoin(locations, eq(packs.locationId, locations.id))
      .innerJoin(batches, eq(packs.batchId, batches.id))
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
