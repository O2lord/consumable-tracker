import "server-only";
import { asc, eq } from "drizzle-orm";
import { db } from "../db/client";
import type { DbOrTx } from "../audit/events";
import { batches, events, itemTypes, locations, transfers, units, users } from "../db/schema";
import { parseSerial } from "../../lib/serial";

// Read-only: one bottle and everything that has happened to it, oldest first.

export async function getUnitWithHistory(serialInput: string, conn: DbOrTx = db()) {
  const serial = parseSerial(serialInput);
  if (!serial) return null;

  const [unit] = await conn
    .select({
      id: units.id,
      serial: units.serial,
      state: units.state,
      itemName: itemTypes.name,
      batchCode: batches.code,
      locationId: units.currentLocationId,
      lotNo: batches.lotNo,
      expiryDate: batches.expiryDate,
      locationName: locations.name,
    })
    .from(units)
    .innerJoin(itemTypes, eq(itemTypes.id, units.itemTypeId))
    .innerJoin(batches, eq(batches.id, units.batchId))
    .innerJoin(locations, eq(locations.id, units.currentLocationId))
    .where(eq(units.serial, serial));
  if (!unit) return null;

  const history = await conn
    .select({
      id: events.id,
      type: events.type,
      fromState: events.fromState,
      toState: events.toState,
      locationId: events.locationId,
      locationName: locations.name,
      userName: users.name,
      transferCode: transfers.code,
      reasonCode: events.reasonCode,
      note: events.note,
      occurredAt: events.occurredAt,
      recordedAt: events.recordedAt,
    })
    .from(events)
    .innerJoin(locations, eq(locations.id, events.locationId))
    .innerJoin(users, eq(users.id, events.userId))
    .leftJoin(transfers, eq(transfers.id, events.transferId))
    .where(eq(events.unitId, unit.id))
    .orderBy(asc(events.occurredAt), asc(events.recordedAt));

  return { unit, history };
}
