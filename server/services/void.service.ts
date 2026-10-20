import "server-only";
import { randomUUID } from "node:crypto";
import { and, asc, eq, isNull } from "drizzle-orm";
import { appendEvents, type DbOrTx } from "../audit/events";
import { db } from "../db/client";
import { lockBatchByCode, lockUnitBySerial } from "../db/queries/locking";
import { quantityOnHand } from "../db/queries/quantity";
import { requireVoidReason } from "../db/queries/reasons";
import { links, units } from "../db/schema";
import { InvalidSerialError, NotFoundError, ValidationError } from "../domain/errors";
import { assertCanIssueQuantity, assertCanVoidUnit, resolveWorkLocation } from "../domain/issue-rules";
import { transition } from "../domain/state-machine";
import type { Actor } from "../domain/types";
import { isValidBatchCode, normalizeCode, parseSerial } from "../../lib/serial";
import {
  voidQuantitySchema,
  voidUnitSchema,
  type VoidQuantityInput,
  type VoidUnitInput,
} from "../../types/issue";

// Void (architecture 7.6): for stock voided outside a return, such as expired or damaged items found
// on the shelf, or a bottle whose investigation was cancelled. Bottles that come back from a patient
// go through the return flow instead. SERIAL items become VOIDED; quantities are WASTED.
// Callers check the `void` permission.

export interface VoidUnitResult {
  serial: string;
  reasonCode: string;
  wasIssued: boolean;
}

export async function voidUnit(rawInput: VoidUnitInput, actor: Actor, conn: DbOrTx = db()): Promise<VoidUnitResult> {
  const parsed = voidUnitSchema.safeParse(rawInput);
  if (!parsed.success) throw new ValidationError(parsed.error.issues.map((i) => i.message).join("; "));
  const input = parsed.data;

  const serial = parseSerial(input.serial);
  if (!serial) throw new InvalidSerialError(input.serial);
  const workLocationId = resolveWorkLocation(actor, input.locationId);

  return conn.transaction(async (tx) => {
    const unit = await lockUnitBySerial(tx, serial);
    if (!unit) throw new ValidationError(`${serial} is not in the system`);
    assertCanVoidUnit(unit, workLocationId);
    const reasonCode = await requireVoidReason(tx, input.reasonCode);

    const active = await tx
      .select()
      .from(links)
      .where(and(eq(links.unitId, unit.id), isNull(links.clearedAt)))
      .orderBy(asc(links.createdAt));

    const step = transition(unit.state, "VOID");
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
        payload: { references: active.map((l) => ({ type: l.referenceType, ref: l.referenceRef })) },
      },
    ]);
    // A voided bottle was never used for what it was issued for: close its links, keep the history.
    if (active.length > 0) {
      await tx.update(links).set({ clearedAt: now }).where(and(eq(links.unitId, unit.id), isNull(links.clearedAt)));
    }

    return { serial, reasonCode, wasIssued: unit.state === "ISSUED" };
  });
}

export interface VoidQuantityResult {
  batchCode: string;
  itemName: string;
  quantity: number;
  reasonCode: string;
}

/** Writes off a quantity found wasted or expired on the shelf. It leaves the location's balance now. */
export async function voidQuantity(
  rawInput: VoidQuantityInput,
  actor: Actor,
  conn: DbOrTx = db(),
): Promise<VoidQuantityResult> {
  const parsed = voidQuantitySchema.safeParse(rawInput);
  if (!parsed.success) throw new ValidationError(parsed.error.issues.map((i) => i.message).join("; "));
  const input = parsed.data;

  const batchCode = normalizeCode(input.batch);
  if (!isValidBatchCode(batchCode)) throw new ValidationError("That is not a valid batch code. Scan the box label");
  const workLocationId = resolveWorkLocation(actor, input.locationId);

  return conn.transaction(async (tx) => {
    const batch = await lockBatchByCode(tx, batchCode);
    if (!batch) throw new NotFoundError("Batch");
    if (batch.trackingMode !== "QUANTITY") {
      throw new ValidationError("This batch is serialized: scan each bottle to void it");
    }

    const onHand = await quantityOnHand(tx, batch.id, workLocationId);
    // Expired stock is exactly what gets voided, so only the amount is checked here.
    assertCanIssueQuantity({ quantity: input.quantity, available: onHand, expiryDate: null, today: "" });
    const reasonCode = await requireVoidReason(tx, input.reasonCode);

    await appendEvents(tx, [
      {
        id: randomUUID(),
        unitId: null,
        batchId: batch.id,
        quantity: input.quantity,
        type: "WASTED",
        locationId: workLocationId,
        userId: actor.userId,
        reasonCode,
        note: input.note ?? null,
        occurredAt: new Date(),
        payload: { source: "VOID" },
      },
    ]);

    return { batchCode: batch.code, itemName: batch.itemName, quantity: input.quantity, reasonCode };
  });
}
