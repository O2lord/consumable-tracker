import "server-only";
import { eq } from "drizzle-orm";
import type { DbOrTx } from "../audit/events";
import { db } from "../db/client";
import { events } from "../db/schema";
import { DomainError } from "../domain/errors";
import type { Actor } from "../domain/types";
import { clampOccurredAt } from "../../lib/sync-time";
import type { SyncEvent, SyncResult } from "../../types/sync";
import { receiveUnit } from "./receive.service";

// Accepts scans that were queued on a device (architecture section 10). Each one is processed on its
// own, so one bad scan never blocks the rest, and every one is checked against the CURRENT state, not
// the state the device saw when it was scanned:
//   - a replayed event id is a no-op (DUPLICATE), whatever has happened since
//   - a scan made by someone else is held, never applied under the wrong name
//   - a scan that is no longer valid (the receipt closed, the bottle is on another transfer, ...) is
//     REJECTED with the reason, so it can be shown on the "needs attention" list
// events.occurred_at keeps the device time, events.recorded_at the server's, so a delayed sync shows.
// The caller checks the `receive` permission.

export async function processSyncEvents(
  batch: readonly SyncEvent[],
  actor: Actor,
  conn: DbOrTx = db(),
  now: Date = new Date(),
): Promise<SyncResult[]> {
  // Oldest first, so scans apply in the order they happened.
  const ordered = [...batch].sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt));
  const results: SyncResult[] = [];
  for (const event of ordered) results.push(await processOne(event, actor, conn, now));
  return results;
}

async function processOne(event: SyncEvent, actor: Actor, conn: DbOrTx, now: Date): Promise<SyncResult> {
  const id = event.id;

  if (event.userId !== actor.userId) {
    return { id, status: "HOLD", message: "Scanned by another user. Sign in as that person to send it" };
  }

  // A retry of something already applied (the reply may have been lost on the way back).
  const [seen] = await conn.select({ id: events.id }).from(events).where(eq(events.id, id));
  if (seen) return { id, status: "DUPLICATE", message: "Already received by the server" };

  try {
    const { at, skewed } = clampOccurredAt(new Date(event.occurredAt), now);
    switch (event.kind) {
      case "RECEIVE_UNIT": {
        const r = await receiveUnit(event.transferId, event.serial, actor, conn, {
          eventId: id,
          occurredAt: at,
          deviceId: event.deviceId,
          payload: { synced: true, ...(skewed ? { clockSkew: true, deviceTime: event.occurredAt } : {}) },
        });
        return r.status === "duplicate"
          ? { id, status: "DUPLICATE", message: `${r.serial} was already scanned (${r.scanned} of ${r.expected})` }
          : { id, status: "OK", message: `${r.serial}, ${r.itemName} (${r.scanned} of ${r.expected})` };
      }
    }
  } catch (err) {
    if (err instanceof DomainError) return { id, status: "REJECTED", message: err.message };
    console.error(err);
    return { id, status: "RETRY", message: "The server had a problem. It will try again" };
  }
}
