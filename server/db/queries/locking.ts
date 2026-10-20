import "server-only";
import { eq } from "drizzle-orm";
import { batches, itemTypes, units } from "../schema";
import type { Tx } from "../../audit/events";

// Row locks for issue, return and void.
//
// The lock is taken on the base table alone and the joined facts are read afterwards. Postgres
// rejects `FOR UPDATE OF "consumables"."units"` (the name after OF cannot be schema-qualified,
// which is how Drizzle writes tables in the `consumables` schema).

/** Locks one unit by serial and returns it with its batch and item type, or null if unknown. */
export async function lockUnitBySerial(tx: Tx, serial: string) {
  await tx.select({ id: units.id }).from(units).where(eq(units.serial, serial)).for("update");
  const [row] = await tx
    .select({
      id: units.id,
      serial: units.serial,
      state: units.state,
      locationId: units.currentLocationId,
      batchId: units.batchId,
      itemTypeId: units.itemTypeId,
      itemName: itemTypes.name,
      containerType: itemTypes.containerType,
      expiryDate: batches.expiryDate,
    })
    .from(units)
    .innerJoin(batches, eq(batches.id, units.batchId))
    .innerJoin(itemTypes, eq(itemTypes.id, units.itemTypeId))
    .where(eq(units.serial, serial));
  return row ?? null;
}

/** Locks one batch by code and returns it with its item type, or null if unknown. */
export async function lockBatchByCode(tx: Tx, code: string) {
  await tx.select({ id: batches.id }).from(batches).where(eq(batches.code, code)).for("update");
  const [row] = await tx
    .select({
      id: batches.id,
      code: batches.code,
      expiryDate: batches.expiryDate,
      itemTypeId: itemTypes.id,
      itemName: itemTypes.name,
      trackingMode: itemTypes.trackingMode,
    })
    .from(batches)
    .innerJoin(itemTypes, eq(itemTypes.id, batches.itemTypeId))
    .where(eq(batches.code, code));
  return row ?? null;
}
