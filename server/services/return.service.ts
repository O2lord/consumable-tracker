import "server-only";
import { randomUUID } from "node:crypto";
import { and, asc, eq, isNull } from "drizzle-orm";
import { appendEvents, type DbOrTx } from "../audit/events";
import { db } from "../db/client";
import { lockBatchByCode, lockUnitBySerial } from "../db/queries/locking";
import { quantityIssuedOutstanding } from "../db/queries/quantity";
import { requireVoidReason } from "../db/queries/reasons";
import { links, locations, units } from "../db/schema";
import { InvalidSerialError, NotFoundError, ValidationError, WrongLocationError } from "../domain/errors";
import { assertCanReturnQuantity, decideReturn, resolveWorkLocation } from "../domain/issue-rules";
import { transition } from "../domain/state-machine";
import type { Actor, QuantityReturnOutcome, ReturnOutcome } from "../domain/types";
import { isValidBatchCode, normalizeCode, parseSerial } from "../../lib/serial";
import {
  returnQuantitySchema,
  returnUnitSchema,
  type ReturnQuantityInput,
  type ReturnUnitInput,
} from "../../types/issue";

// Return (architecture 7.5). A SERIAL bottle comes back one of three ways:
//   USED      ISSUED -> RETURNED (closes the loop for its references)
//   UNUSED    ISSUED -> IN_STOCK at the same location, its links cleared; or, where the location does
//             not allow reuse, voided with reason UNUSED
//   UNUSABLE  ISSUED -> VOIDED with a reason
// Each is one event in the same transaction as the state change. Earlier events are never touched.
// Callers check the `return` permission.

export interface ReturnUnitResult {
  serial: string;
  outcome: ReturnOutcome;
  /** What actually happened, which differs from `outcome` when reuse is switched off. */
  became: "RETURNED" | "IN_STOCK" | "VOIDED";
  reasonCode: string | null;
}

export async function returnUnit(rawInput: ReturnUnitInput, actor: Actor, conn: DbOrTx = db()): Promise<ReturnUnitResult> {
  const parsed = returnUnitSchema.safeParse(rawInput);
  if (!parsed.success) throw new ValidationError(parsed.error.issues.map((i) => i.message).join("; "));
  const input = parsed.data;

  const serial = parseSerial(input.serial);
  if (!serial) throw new InvalidSerialError(input.serial);
  const workLocationId = resolveWorkLocation(actor, input.locationId);

  return conn.transaction(async (tx) => {
    const unit = await lockUnitBySerial(tx, serial);
    if (!unit) throw new ValidationError(`${serial} is not in the system`);
    if (unit.state !== "ISSUED") {
      throw new ValidationError(`${serial} is ${unit.state.toLowerCase().replace(/_/g, " ")}, not issued, so it cannot be returned`);
    }
    if (unit.locationId !== workLocationId) {
      throw new WrongLocationError(`${serial} was issued from a different location`);
    }

    const [location] = await tx
      .select({ allowUnusedReuse: locations.allowUnusedReuse })
      .from(locations)
      .where(eq(locations.id, unit.locationId));
    const decision = decideReturn(input.outcome, location?.allowUnusedReuse ?? true, input.reasonCode);
    const reasonCode = decision.reasonCode ? await requireVoidReason(tx, decision.reasonCode) : null;

    const active = await tx
      .select()
      .from(links)
      .where(and(eq(links.unitId, unit.id), isNull(links.clearedAt)))
      .orderBy(asc(links.createdAt));

    const step = transition(unit.state, decision.action);
    const now = new Date();
    await tx.update(units).set({ state: step.to }).where(eq(units.id, unit.id));
    await appendEvents(tx, [
      {
        id: randomUUID(),
        unitId: unit.id,
        batchId: unit.batchId,
        quantity: 1,
        type: step.event,
        fromState: unit.state,
        toState: step.to,
        locationId: workLocationId,
        userId: actor.userId,
        referenceType: active[0]?.referenceType ?? null,
        referenceRef: active[0]?.referenceRef ?? null,
        reasonCode,
        note: input.note ?? null,
        occurredAt: now,
        payload: {
          outcome: input.outcome,
          reuseAllowed: location?.allowUnusedReuse ?? true,
          references: active.map((l) => ({ type: l.referenceType, ref: l.referenceRef })),
        },
      },
    ]);
    if (decision.clearLinks) {
      await tx.update(links).set({ clearedAt: now }).where(and(eq(links.unitId, unit.id), isNull(links.clearedAt)));
    }

    return {
      serial,
      outcome: input.outcome,
      became: step.to === "RETURNED" ? "RETURNED" : step.to === "IN_STOCK" ? "IN_STOCK" : "VOIDED",
      reasonCode,
    };
  });
}

export interface ReturnQuantityResult {
  batchCode: string;
  itemName: string;
  quantity: number;
  outcome: QuantityReturnOutcome;
}

/**
 * Bulk items: unused goes back on the shelf (RETURNED_UNUSED), wasted needs a reason (WASTED).
 * A used quantity needs no return: it was counted out at issue. Cannot exceed what is still out.
 */
export async function returnQuantity(
  rawInput: ReturnQuantityInput,
  actor: Actor,
  conn: DbOrTx = db(),
): Promise<ReturnQuantityResult> {
  const parsed = returnQuantitySchema.safeParse(rawInput);
  if (!parsed.success) throw new ValidationError(parsed.error.issues.map((i) => i.message).join("; "));
  const input = parsed.data;

  const batchCode = normalizeCode(input.batch);
  if (!isValidBatchCode(batchCode)) throw new ValidationError("That is not a valid batch code. Scan the box label");
  const workLocationId = resolveWorkLocation(actor, input.locationId);

  return conn.transaction(async (tx) => {
    const batch = await lockBatchByCode(tx, batchCode);
    if (!batch) throw new NotFoundError("Batch");
    if (batch.trackingMode !== "QUANTITY") {
      throw new ValidationError("This batch is serialized: scan each bottle to return it");
    }

    const outstanding = await quantityIssuedOutstanding(tx, batch.id, workLocationId);
    assertCanReturnQuantity(input.quantity, outstanding);
    const reasonCode = input.outcome === "WASTED" ? await requireVoidReason(tx, input.reasonCode) : null;

    await appendEvents(tx, [
      {
        id: randomUUID(),
        unitId: null,
        batchId: batch.id,
        quantity: input.quantity,
        type: input.outcome === "WASTED" ? "WASTED" : "RETURNED_UNUSED",
        locationId: workLocationId,
        userId: actor.userId,
        reasonCode,
        note: input.note ?? null,
        occurredAt: new Date(),
        // 'RETURN' tells v_quantity_balance the quantity already left the shelf at issue.
        payload: { source: "RETURN", outcome: input.outcome },
      },
    ]);

    return { batchCode: batch.code, itemName: batch.itemName, quantity: input.quantity, outcome: input.outcome };
  });
}
