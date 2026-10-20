import "server-only";
import { and, desc, eq } from "drizzle-orm";
import { db } from "../db/client";
import type { DbOrTx } from "../audit/events";
import { batches, events, locations, transfers, units, users } from "../db/schema";
import { parseSerial, parseTransferCode } from "../../lib/serial";
import { ValidationError } from "../domain/errors";

// Read-only view of the ledger. Writing events through the API (offline sync) arrives in Phase 5.

export interface EventFilter {
  /** A bottle's serial. */
  serial?: string;
  /** A transfer slip code. */
  transfer?: string;
  limit?: number;
}

export async function listEvents(filter: EventFilter, conn: DbOrTx = db()) {
  const conditions = [];

  if (filter.serial) {
    const serial = parseSerial(filter.serial);
    if (!serial) throw new ValidationError("That is not a valid serial");
    conditions.push(eq(units.serial, serial));
  }
  if (filter.transfer) {
    const code = parseTransferCode(filter.transfer);
    if (!code) throw new ValidationError("That is not a valid transfer code");
    conditions.push(eq(transfers.code, code));
  }
  // Without a filter this would dump the whole ledger.
  if (conditions.length === 0) throw new ValidationError("Filter by serial or transfer");

  return conn
    .select({
      id: events.id,
      type: events.type,
      serial: units.serial,
      batchCode: batches.code,
      quantity: events.quantity,
      fromState: events.fromState,
      toState: events.toState,
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
    .leftJoin(units, eq(units.id, events.unitId))
    .leftJoin(batches, eq(batches.id, events.batchId))
    .leftJoin(transfers, eq(transfers.id, events.transferId))
    .where(and(...conditions))
    .orderBy(desc(events.occurredAt), desc(events.recordedAt))
    .limit(Math.min(Math.max(filter.limit ?? 200, 1), 1000));
}
