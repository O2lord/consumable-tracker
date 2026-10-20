import "server-only";
import { eq, sql } from "drizzle-orm";
import type { Tx } from "../audit/events";
import { stockRequestLines, stockRequests } from "../db/schema";
import { NotFoundError } from "../domain/errors";
import {
  assertRequestStatus,
  assertWithinRequestBalance,
  deriveRequestStatus,
  type LineFacts,
} from "../domain/request-rules";
import type { RequestStatus } from "../domain/types";

// The parts of stock requests that transfer.service and receive.service call into. They live apart
// from request.service so there is no import cycle: request.service calls createTransfer, and
// transfer.service calls these.
//
// Lock order everywhere: transfer, then request, then its lines. Nothing locks them the other way
// round, so two dispatches against one request queue up instead of deadlocking.

/** Statuses in which quantities on the lines still follow the linked transfers. */
const FOLLOWS_TRANSFERS: readonly RequestStatus[] = ["APPROVED", "PARTIALLY_FULFILLED", "FULFILLED", "CLOSED"];

export async function lockRequest(tx: Tx, requestId: string) {
  const [row] = await tx.select().from(stockRequests).where(eq(stockRequests.id, requestId)).for("update");
  if (!row) throw new NotFoundError("Request");
  return row;
}

/**
 * Called by confirmTransfer before anything moves. For a transfer linked to a request, every item type
 * on it must be approved, not closed, and fit inside approved minus what was already dispatched.
 * Measured against dispatched (not received), so the same balance cannot go out twice while the first
 * transfer is still in transit. Does nothing for a transfer without a request.
 */
export async function assertTransferWithinRequest(
  tx: Tx,
  transfer: { id: string; requestId: string | null },
): Promise<void> {
  if (!transfer.requestId) return;

  const request = await lockRequest(tx, transfer.requestId);
  assertRequestStatus(request.status, ["APPROVED", "PARTIALLY_FULFILLED"], "dispatch against this request");

  // Locked, so a second transfer confirming at the same time waits here and then sees the first one's
  // dispatched quantities.
  const lines = await tx
    .select({
      itemTypeId: stockRequestLines.itemTypeId,
      inPieces: stockRequestLines.inPieces,
      quantityApproved: stockRequestLines.quantityApproved,
      quantityDispatched: stockRequestLines.quantityDispatched,
      quantityReceived: stockRequestLines.quantityReceived,
      closedAt: stockRequestLines.closedAt,
    })
    .from(stockRequestLines)
    .where(eq(stockRequestLines.requestId, request.id))
    .for("update");
  const lineByItem = new Map<string, LineFacts>(lines.map((l) => [l.itemTypeId, l]));

  // One row per item and unit: a line counted in loose pieces must be filled with pieces, and a line counted in
  // packs with packs, because the two numbers cannot be added together.
  const adding = await tx.execute<{ item_type_id: string; item_name: string; in_pieces: boolean; total: number }>(sql`
    select it.id as item_type_id, it.name as item_name, ti.in_pieces, sum(ti.quantity_dispatched)::int as total
    from consumables.transfer_items ti
    left join consumables.units u on u.id = ti.unit_id
    left join consumables.batches b on b.id = ti.batch_id
    join consumables.item_types it on it.id = coalesce(u.item_type_id, b.item_type_id)
    where ti.transfer_id = ${transfer.id}
    group by it.id, it.name, ti.in_pieces
    order by it.name
  `);

  for (const row of adding) {
    const line = lineByItem.get(row.item_type_id);
    assertWithinRequestBalance({
      requestCode: request.code,
      itemName: row.item_name,
      line,
      adding: row.total,
      addingInPieces: row.in_pieces,
    });
  }
}

/**
 * Brings a request's line quantities and status in line with its transfers. Called after a transfer
 * linked to the request is confirmed, received or cancelled. It recomputes from the transfers rather
 * than adding amounts, so calling it twice, or after a retry, cannot double count.
 *
 *   dispatched  every item on the request's transfers that has left DRAFT (and is not cancelled)
 *   received    what was counted at the destination, once the transfer's receipt is closed, plus
 *               missing units later resolved as found (they are back in stock at the destination)
 *
 * A request that is not approved (draft, submitted, rejected, cancelled) is left alone. Returns the
 * request's status afterwards.
 */
export async function syncRequestFromTransfers(tx: Tx, requestId: string): Promise<RequestStatus> {
  const request = await lockRequest(tx, requestId);
  if (!FOLLOWS_TRANSFERS.includes(request.status)) return request.status;

  const totals = await tx.execute<{ item_type_id: string; dispatched: number; received: number }>(sql`
    select it.id as item_type_id,
      coalesce(sum(ti.quantity_dispatched), 0)::int as dispatched,
      coalesce(sum(
        case
          when t.status in ('RECEIVED', 'RECEIVED_WITH_DISCREPANCY', 'DISCREPANCY_RESOLVED') then
            case
              when ti.unit_id is not null then
                (case when ti.received_at is not null or coalesce(ti.quantity_found, 0) > 0 then 1 else 0 end)
              else coalesce(ti.quantity_received, 0) + coalesce(ti.quantity_found, 0)
            end
          else 0
        end
      ), 0)::int as received
    from consumables.transfers t
    join consumables.transfer_items ti on ti.transfer_id = t.id
    left join consumables.units u on u.id = ti.unit_id
    left join consumables.batches b on b.id = ti.batch_id
    join consumables.item_types it on it.id = coalesce(u.item_type_id, b.item_type_id)
    where t.request_id = ${request.id}
      and t.status not in ('DRAFT', 'CANCELLED')
    group by it.id
  `);
  const totalByItem = new Map(totals.map((r) => [r.item_type_id, r]));

  const lines = await tx
    .select()
    .from(stockRequestLines)
    .where(eq(stockRequestLines.requestId, request.id))
    .for("update");

  const facts: LineFacts[] = [];
  for (const line of lines) {
    const dispatched = totalByItem.get(line.itemTypeId)?.dispatched ?? 0;
    const received = totalByItem.get(line.itemTypeId)?.received ?? 0;
    if (dispatched !== line.quantityDispatched || received !== line.quantityReceived) {
      await tx
        .update(stockRequestLines)
        .set({ quantityDispatched: dispatched, quantityReceived: received })
        .where(eq(stockRequestLines.id, line.id));
    }
    facts.push({
      quantityApproved: line.quantityApproved,
      quantityDispatched: dispatched,
      quantityReceived: received,
      closedAt: line.closedAt,
    });
  }

  const inFlight = await tx.execute<{ n: number }>(sql`
    select count(*)::int as n
    from consumables.transfers
    where request_id = ${request.id} and status in ('DISPATCHED', 'RECEIVING')
  `);
  const next = deriveRequestStatus(facts, { hasTransferInFlight: (inFlight[0]?.n ?? 0) > 0 });
  if (next !== request.status) {
    await tx.update(stockRequests).set({ status: next }).where(eq(stockRequests.id, request.id));
  }
  return next;
}
