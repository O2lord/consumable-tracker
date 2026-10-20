import "server-only";
import { asc, desc, eq, isNull, sql } from "drizzle-orm";
import type { DbOrTx } from "../audit/events";
import { db } from "../db/client";
import { batches, deliveries, itemTypes, locations, users } from "../db/schema";
import { generateDeliveryCode, parseDeliveryCode } from "../../lib/serial";
import { NotFoundError, ValidationError } from "../domain/errors";
import { PAGE_SIZE, pageInfo, type Paged } from "../../lib/pagination";

// A delivery is everything that arrived from one supplier together. It owns the code you quote for the whole
// delivery; each item line stays a batch (own lot, expiry, quantity, label) that points back at it.
// The caller checks `stock_in`.

/** Creates the delivery record. Call it inside the same transaction that stocks in the lines. */
export async function createDelivery(
  input: { supplier?: string | null; locationId: string; userId: string; reference?: string | null },
  conn: DbOrTx,
) {
  const [location] = await conn.select().from(locations).where(eq(locations.id, input.locationId));
  if (!location || !location.active) throw new NotFoundError("Location");
  if (location.type !== "STORE") throw new ValidationError("Stock can only be received into a store location");

  const [row] = await conn
    .insert(deliveries)
    .values({
      code: generateDeliveryCode(),
      supplier: input.supplier ?? null,
      locationId: input.locationId,
      reference: input.reference ?? null,
      receivedBy: input.userId,
    })
    .returning();
  return row;
}

export interface DeliveryLine {
  batchCode: string;
  itemName: string;
  trackingMode: "SERIAL" | "QUANTITY";
  unit: string;
  quantity: number;
  lotNo: string | null;
  expiryDate: string | null;
}

export interface DeliverySummary {
  code: string;
  supplier: string | null;
  reference: string | null;
  receivedAt: Date;
  locationName: string;
  itemCount: number;
  /** Item names, alphabetical, one per line, for the hover text on the delivery list. */
  itemNames: string;
}

/** One page of deliveries, newest first, with how many item lines each one has. */
export async function listDeliveriesPage(page: number, conn: DbOrTx = db()): Promise<Paged<DeliverySummary>> {
  const [{ total }] = await conn.select({ total: sql<number>`count(*)::int` }).from(deliveries);
  const info = pageInfo(page, total);
  const rows = await listRecentDeliveries(info.pageSize, conn, info.offset);
  return { ...info, rows };
}

/** The most recent deliveries, newest first, with how many item lines each one has. */
export async function listRecentDeliveries(
  limit = PAGE_SIZE,
  conn: DbOrTx = db(),
  offset = 0,
): Promise<DeliverySummary[]> {
  const rows = await conn
    .select({
      code: deliveries.code,
      supplier: deliveries.supplier,
      reference: deliveries.reference,
      receivedAt: deliveries.receivedAt,
      locationName: locations.name,
      itemCount: sql<number>`count(${batches.id})::int`,
      itemNames: sql<string | null>`string_agg(${itemTypes.name}, chr(10) order by ${itemTypes.name})`,
    })
    .from(deliveries)
    .innerJoin(locations, eq(locations.id, deliveries.locationId))
    .leftJoin(batches, eq(batches.deliveryId, deliveries.id))
    .leftJoin(itemTypes, eq(itemTypes.id, batches.itemTypeId))
    .groupBy(deliveries.id, locations.name)
    .orderBy(desc(deliveries.receivedAt), desc(deliveries.id))
    .limit(limit)
    .offset(offset);
  return rows.map((r) => ({ ...r, itemNames: r.itemNames ?? "" }));
}

/** One page of batches received before deliveries existed. */
export async function listBatchesWithoutDeliveryPage(page: number, conn: DbOrTx = db()) {
  const [{ total }] = await conn
    .select({ total: sql<number>`count(*)::int` })
    .from(batches)
    .where(isNull(batches.deliveryId));
  const info = pageInfo(page, total);
  const rows = await listRecentBatchesWithoutDelivery(info.pageSize, conn, info.offset);
  return { ...info, rows };
}

/** Batches received before deliveries existed. They have no DV code, so they keep a link straight to their labels. */
export async function listRecentBatchesWithoutDelivery(limit = PAGE_SIZE, conn: DbOrTx = db(), offset = 0) {
  return conn
    .select({
      code: batches.code,
      quantity: batches.quantity,
      createdAt: batches.createdAt,
      itemName: itemTypes.name,
      trackingMode: itemTypes.trackingMode,
      unit: itemTypes.unitOfMeasure,
    })
    .from(batches)
    .innerJoin(itemTypes, eq(itemTypes.id, batches.itemTypeId))
    .where(isNull(batches.deliveryId))
    .orderBy(desc(batches.createdAt), desc(batches.id))
    .limit(limit)
    .offset(offset);
}

export interface DeliveryView {
  id: string;
  code: string;
  supplier: string | null;
  reference: string | null;
  receivedAt: Date;
  locationName: string;
  receivedByName: string;
  lines: DeliveryLine[];
}

/** One delivery with its item lines, or null when the code is malformed or unknown. */
export async function getDeliveryByCode(codeInput: string, conn: DbOrTx = db()): Promise<DeliveryView | null> {
  const code = parseDeliveryCode(codeInput);
  if (!code) return null;

  const [d] = await conn
    .select({
      id: deliveries.id,
      code: deliveries.code,
      supplier: deliveries.supplier,
      reference: deliveries.reference,
      receivedAt: deliveries.receivedAt,
      locationName: locations.name,
      receivedByName: users.name,
    })
    .from(deliveries)
    .innerJoin(locations, eq(locations.id, deliveries.locationId))
    .innerJoin(users, eq(users.id, deliveries.receivedBy))
    .where(eq(deliveries.code, code));
  if (!d) return null;

  const lines = await conn
    .select({
      batchCode: batches.code,
      itemName: itemTypes.name,
      trackingMode: itemTypes.trackingMode,
      unit: itemTypes.unitOfMeasure,
      quantity: batches.quantity,
      lotNo: batches.lotNo,
      expiryDate: batches.expiryDate,
    })
    .from(batches)
    .innerJoin(itemTypes, eq(itemTypes.id, batches.itemTypeId))
    .where(eq(batches.deliveryId, d.id))
    .orderBy(asc(itemTypes.name), asc(batches.code));

  return { ...d, lines };
}
