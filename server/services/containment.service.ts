import "server-only";
import { asc, eq, sql } from "drizzle-orm";
import { db } from "../db/client";
import type { DbOrTx } from "../audit/events";
import { batches, cartons, deliveries, events, itemTypes, locations, packs, units } from "../db/schema";
import { parseCartonCode, parsePackCode } from "../../lib/serial";

// Reads one level of a delivery at a time, so the screens can walk down it: delivery -> batch -> carton -> pack ->
// bottle. Every row links to the page of the level below. Identity and containment only: how much stock a location
// holds still comes from the batch ledger.

/** How many child rows one page lists. A carton or pack never holds more than this in practice. */
export const CHILD_LIMIT = 500;

export interface UnitRow {
  serial: string;
  state: string;
  locationName: string;
  /** True once the bottle has left on a transfer (it was dispatched). It is struck out and not printed again. */
  transferred: boolean;
}

/** SQL: this bottle has been dispatched on a transfer at some point. Shared with label printing. */
export const unitWasTransferred = sql<boolean>`exists (select 1 from ${events} where ${events.unitId} = ${units.id} and ${events.type} = 'DISPATCHED')`;

export interface PackRow {
  code: string;
  piecesPerPack: number;
  piecesRemaining: number;
  /** Bottles that belong to this pack, and how many of them are still in stock. Both 0 for counted packs. */
  bottles: number;
  bottlesInStock: number;
  /** When this pack's label was last printed; null if it never has been. */
  labelPrintedAt: Date | null;
  labelPrintCount: number;
}

export interface CartonRow {
  code: string;
  packsCount: number;
  piecesCount: number;
  /** Packs and bottles that belong to this carton. */
  packs: number;
  bottles: number;
  bottlesInStock: number;
}

const inStock = sql`'IN_STOCK'`;

/** Cartons of one batch, each with how many packs and bottles are in it and how many bottles are still in stock. */
export async function listCartonsOfBatch(batchId: string, conn: DbOrTx = db()): Promise<CartonRow[]> {
  return conn
    .select({
      code: cartons.code,
      packsCount: cartons.packsCount,
      piecesCount: cartons.piecesCount,
      packs: sql<number>`(select count(*)::int from ${packs} where ${packs.cartonId} = ${cartons.id})`,
      bottles: sql<number>`(select count(*)::int from ${units} where ${units.cartonId} = ${cartons.id})`,
      bottlesInStock: sql<number>`(select count(*)::int from ${units} where ${units.cartonId} = ${cartons.id} and ${units.state} = ${inStock})`,
    })
    .from(cartons)
    .where(eq(cartons.batchId, batchId))
    .orderBy(asc(cartons.code))
    .limit(CHILD_LIMIT);
}

/** Packs of one batch that sit in no carton (received by the pack), for a batch with no cartons. */
export async function listLoosePacksOfBatch(batchId: string, conn: DbOrTx = db()): Promise<PackRow[]> {
  return conn
    .select(packColumns())
    .from(packs)
    .where(sql`${packs.batchId} = ${batchId} and ${packs.cartonId} is null`)
    .orderBy(asc(packs.code))
    .limit(CHILD_LIMIT);
}

function packColumns() {
  return {
    code: packs.code,
    piecesPerPack: packs.piecesPerPack,
    piecesRemaining: packs.piecesRemaining,
    labelPrintedAt: packs.labelPrintedAt,
    labelPrintCount: packs.labelPrintCount,
    bottles: sql<number>`(select count(*)::int from ${units} where ${units.packId} = ${packs.id})`,
    bottlesInStock: sql<number>`(select count(*)::int from ${units} where ${units.packId} = ${packs.id} and ${units.state} = ${inStock})`,
  };
}

export interface CartonView {
  code: string;
  itemName: string;
  unit: string;
  trackingMode: "SERIAL" | "QUANTITY";
  batchCode: string;
  deliveryCode: string | null;
  locationName: string;
  packsCount: number;
  piecesCount: number;
  lotNo: string | null;
  expiryDate: string | null;
  packs: PackRow[];
  /** Bottles in this carton that have no pack (a carton of single bottles). */
  looseBottles: UnitRow[];
  totalPacks: number;
  totalLooseBottles: number;
}

/** One carton with the packs in it, or null when the code is malformed or unknown. */
export async function getCartonView(codeInput: string, conn: DbOrTx = db()): Promise<CartonView | null> {
  const code = parseCartonCode(codeInput);
  if (!code) return null;
  const [c] = await conn
    .select({
      id: cartons.id,
      code: cartons.code,
      packsCount: cartons.packsCount,
      piecesCount: cartons.piecesCount,
      itemName: itemTypes.name,
      unit: itemTypes.unitOfMeasure,
      trackingMode: itemTypes.trackingMode,
      batchCode: batches.code,
      lotNo: batches.lotNo,
      expiryDate: batches.expiryDate,
      deliveryCode: deliveries.code,
      locationName: locations.name,
    })
    .from(cartons)
    .innerJoin(itemTypes, eq(cartons.itemTypeId, itemTypes.id))
    .innerJoin(batches, eq(cartons.batchId, batches.id))
    .innerJoin(locations, eq(cartons.locationId, locations.id))
    .leftJoin(deliveries, eq(cartons.deliveryId, deliveries.id))
    .where(eq(cartons.code, code));
  if (!c) return null;

  const packRows = await conn.select(packColumns()).from(packs).where(eq(packs.cartonId, c.id)).orderBy(asc(packs.code)).limit(CHILD_LIMIT);
  const [packTotal] = await conn
    .select({ n: sql<number>`count(*)::int` })
    .from(packs)
    .where(eq(packs.cartonId, c.id));

  const looseWhere = sql`${units.cartonId} = ${c.id} and ${units.packId} is null`;
  const looseRows = await conn
    .select({ serial: units.serial, state: units.state, locationName: locations.name, transferred: unitWasTransferred })
    .from(units)
    .innerJoin(locations, eq(units.currentLocationId, locations.id))
    .where(looseWhere)
    .orderBy(asc(units.serial))
    .limit(CHILD_LIMIT);
  const [looseTotal] = await conn.select({ n: sql<number>`count(*)::int` }).from(units).where(looseWhere);

  return {
    ...c,
    packs: packRows,
    looseBottles: looseRows,
    totalPacks: packTotal?.n ?? 0,
    totalLooseBottles: looseTotal?.n ?? 0,
  };
}

export interface PackView {
  code: string;
  itemName: string;
  unit: string;
  trackingMode: "SERIAL" | "QUANTITY";
  batchCode: string;
  deliveryCode: string | null;
  cartonCode: string | null;
  locationName: string;
  piecesPerPack: number;
  piecesRemaining: number;
  lotNo: string | null;
  expiryDate: string | null;
  bottles: UnitRow[];
  totalBottles: number;
  bottlesInStock: number;
  labelPrintedAt: Date | null;
  labelPrintCount: number;
}

/** One pack with the bottles in it, or null when the code is malformed or unknown. */
export async function getPackView(codeInput: string, conn: DbOrTx = db()): Promise<PackView | null> {
  const code = parsePackCode(codeInput);
  if (!code) return null;
  const [p] = await conn
    .select({
      id: packs.id,
      code: packs.code,
      piecesPerPack: packs.piecesPerPack,
      piecesRemaining: packs.piecesRemaining,
      labelPrintedAt: packs.labelPrintedAt,
      labelPrintCount: packs.labelPrintCount,
      itemName: itemTypes.name,
      unit: itemTypes.unitOfMeasure,
      trackingMode: itemTypes.trackingMode,
      batchCode: batches.code,
      lotNo: batches.lotNo,
      expiryDate: batches.expiryDate,
      deliveryCode: deliveries.code,
      cartonCode: cartons.code,
      locationName: locations.name,
    })
    .from(packs)
    .innerJoin(itemTypes, eq(packs.itemTypeId, itemTypes.id))
    .innerJoin(batches, eq(packs.batchId, batches.id))
    .innerJoin(locations, eq(packs.locationId, locations.id))
    .leftJoin(deliveries, eq(batches.deliveryId, deliveries.id))
    .leftJoin(cartons, eq(packs.cartonId, cartons.id))
    .where(eq(packs.code, code));
  if (!p) return null;

  const bottleRows = await conn
    .select({ serial: units.serial, state: units.state, locationName: locations.name, transferred: unitWasTransferred })
    .from(units)
    .innerJoin(locations, eq(units.currentLocationId, locations.id))
    .where(eq(units.packId, p.id))
    .orderBy(asc(units.serial))
    .limit(CHILD_LIMIT);
  const [counts] = await conn
    .select({
      total: sql<number>`count(*)::int`,
      inStock: sql<number>`count(*) filter (where ${units.state} = ${inStock})::int`,
    })
    .from(units)
    .where(eq(units.packId, p.id));

  return { ...p, bottles: bottleRows, totalBottles: counts?.total ?? 0, bottlesInStock: counts?.inStock ?? 0 };
}
