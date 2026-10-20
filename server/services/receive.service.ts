import "server-only";
import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { appendEvents, type DbOrTx, type NewEvent, type Tx } from "../audit/events";
import { db } from "../db/client";
import { batches, itemTypes, packs, transferItemPacks, transferItems, transfers, units } from "../db/schema";
import { InvalidSerialError, NotFoundError, ValidationError, WrongTransferError } from "../domain/errors";
import {
  assertCanReceiveAt,
  assertCountPlausible,
  assertStatus,
  assertUnitOnTransfer,
  isScanLine,
  receiptOutcome,
  statusAfterClose,
  type ReceiptItem,
} from "../domain/rules";
import { transition } from "../domain/state-machine";
import type { Actor } from "../domain/types";
import { isValidBatchCode, normalizeCode, parsePackCode, parseSerial, parseTransferCode } from "../../lib/serial";
import { toLineQuantity, type CountUnit } from "../../lib/pack-size";
import { closePackLinks } from "./pack.service";
import { syncRequestFromTransfers } from "./request-sync.service";

// Receive (architecture 7.3): open a receipt from the slip, scan every SERIAL unit, count every
// QUANTITY batch blind, then close. Closing turns whatever was not scanned or counted into a
// discrepancy: MISSING_IN_TRANSIT units and quantity shortfalls.
// Callers check the `receive` permission; the location rule is enforced here.

const CHUNK = 1000;
function chunks<T>(items: readonly T[], size = CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** How many scanned packs make up a transfer line, and how many of those have been scanned in at the destination. */
const linkedPacksOf = () =>
  sql<number>`(select count(*) from ${transferItemPacks} where ${transferItemPacks.transferItemId} = ${transferItems.id})::int`;
const receivedPacksOf = () =>
  sql<number>`(select count(*) from ${transferItemPacks} where ${transferItemPacks.transferItemId} = ${transferItems.id} and ${transferItemPacks.receivedAt} is not null)::int`;

async function lockTransfer(tx: Tx, transferId: string) {
  const [row] = await tx.select().from(transfers).where(eq(transfers.id, transferId)).for("update");
  if (!row) throw new NotFoundError("Transfer");
  return row;
}

/**
 * What the receive screen shows. It deliberately omits quantities that were dispatched, so batch
 * counts are blind. Serialized units are shown as "x of y" and how many of each item are still unscanned, never
 * their codes: a list of codes could be copied into the scan box and marked received without the bottle being there.
 */
export async function getReceiptProgress(transferId: string, conn: DbOrTx = db()) {
  const [t] = await conn.select().from(transfers).where(eq(transfers.id, transferId));
  if (!t) throw new NotFoundError("Transfer");

  const [counts] = await conn
    .select({
      expected: sql<number>`count(*) filter (where ${transferItems.unitId} is not null)::int`,
      scanned: sql<number>`count(*) filter (where ${transferItems.unitId} is not null and ${transferItems.receivedAt} is not null)::int`,
    })
    .from(transferItems)
    .where(eq(transferItems.transferId, t.id));

  // Whole packs that were scanned one by one at dispatch. Only how many have been scanned in is shown, never how many
  // were sent, so the batch count stays blind.
  const [packCounts] = await conn
    .select({
      linked: sql<number>`count(*)::int`,
      received: sql<number>`count(*) filter (where ${transferItemPacks.receivedAt} is not null)::int`,
    })
    .from(transferItemPacks)
    .innerJoin(transferItems, eq(transferItems.id, transferItemPacks.transferItemId))
    .where(eq(transferItems.transferId, t.id));

  const unscannedByItem = await conn
    .select({ itemName: itemTypes.name, count: sql<number>`count(*)::int` })
    .from(transferItems)
    .innerJoin(units, eq(units.id, transferItems.unitId))
    .innerJoin(itemTypes, eq(itemTypes.id, units.itemTypeId))
    .where(and(eq(transferItems.transferId, t.id), isNull(transferItems.receivedAt)))
    .groupBy(itemTypes.name)
    .orderBy(asc(itemTypes.name));

  const quantityLines = await conn
    .select({
      itemId: transferItems.id,
      batchCode: batches.code,
      itemName: itemTypes.name,
      // Shows a "Keep cold" tag, so the receiver puts it in the fridge. Display only.
      coldStorage: itemTypes.coldStorage,
      // True when this line is counted in loose pieces (the count is then a number of pieces, not packs).
      inPieces: transferItems.inPieces,
      // Lets the receiver say whether they counted packs or pieces. Never the dispatched quantity.
      unit: itemTypes.unitOfMeasure,
      packSize: itemTypes.packSize,
      counted: transferItems.quantityReceived,
      // Used only to tell whether the line is received by scanning its packs. The dispatched number is not passed on.
      dispatched: transferItems.quantityDispatched,
      linkedPacks: linkedPacksOf(),
      packsScanned: receivedPacksOf(),
    })
    .from(transferItems)
    .innerJoin(batches, eq(batches.id, transferItems.batchId))
    .innerJoin(itemTypes, eq(itemTypes.id, batches.itemTypeId))
    .where(eq(transferItems.transferId, t.id))
    .orderBy(asc(batches.code));

  return {
    transferId: t.id,
    code: t.code,
    status: t.status,
    toLocationId: t.toLocationId,
    carriedByName: t.carriedByName,
    serialExpected: counts?.expected ?? 0,
    serialScanned: counts?.scanned ?? 0,
    unscannedByItem,
    quantityLines: quantityLines.map(({ dispatched, linkedPacks, ...line }) => ({
      ...line,
      // True when every pack of this line was scanned at dispatch, so it is received by scanning them in.
      byScan: isScanLine({ inPieces: line.inPieces, linkedPacks, dispatched }),
    })),
    packsOnSlip: (packCounts?.linked ?? 0) > 0,
    packsReceived: packCounts?.received ?? 0,
  };
}
export type ReceiptProgress = Awaited<ReturnType<typeof getReceiptProgress>>;

/** Cheap lookup by slip code, for pages that only need the id, status, destination and who carried it. */
export async function findTransferByCode(codeInput: string, conn: DbOrTx = db()) {
  const code = parseTransferCode(codeInput);
  if (!code) return null;
  const [row] = await conn
    .select({
      id: transfers.id,
      code: transfers.code,
      status: transfers.status,
      toLocationId: transfers.toLocationId,
      carriedByName: transfers.carriedByName,
    })
    .from(transfers)
    .where(eq(transfers.code, code));
  return row ?? null;
}

/** Scan the slip: opens the receipt (first time) or resumes it. */
export async function openReceipt(slipInput: string, actor: Actor, conn: DbOrTx = db()): Promise<ReceiptProgress> {
  const code = parseTransferCode(slipInput);
  if (!code) throw new ValidationError("That is not a transfer slip code. Scan the barcode on the slip");

  const transferId = await conn.transaction(async (tx) => {
    const [found] = await tx.select({ id: transfers.id }).from(transfers).where(eq(transfers.code, code));
    if (!found) throw new NotFoundError("Transfer");
    const transfer = await lockTransfer(tx, found.id);
    assertCanReceiveAt(actor, transfer.toLocationId);
    assertStatus(transfer.status, ["DISPATCHED", "RECEIVING"], "receive");

    if (transfer.status === "DISPATCHED") {
      await tx
        .update(transfers)
        .set({ status: "RECEIVING", receiptStartedBy: actor.userId, receiptStartedAt: new Date() })
        .where(eq(transfers.id, transfer.id));
    }
    return transfer.id;
  });
  return getReceiptProgress(transferId, conn);
}

export type ReceiveUnitResult =
  | { status: "received"; serial: string; itemName: string; scanned: number; expected: number }
  | { status: "duplicate"; serial: string; itemName: string; scanned: number; expected: number };

/** Set when the scan came from the offline queue (sync.service.ts). */
export interface ReceiveUnitOptions {
  /** The id the device gave the scan; becomes the event id, so a replay is a no-op. */
  eventId?: string;
  /** When the scan happened on the device (events.occurred_at). Defaults to now. */
  occurredAt?: Date;
  deviceId?: string;
  /** Extra detail stored in the event payload (for example a clock-skew flag). */
  payload?: Record<string, unknown>;
}

/** One bottle scanned at the destination. A repeat scan is ignored with a clear message. */
export async function receiveUnit(
  transferId: string,
  serialInput: string,
  actor: Actor,
  conn: DbOrTx = db(),
  options: ReceiveUnitOptions = {},
): Promise<ReceiveUnitResult> {
  const serial = parseSerial(serialInput);
  if (!serial) throw new InvalidSerialError(serialInput);

  return conn.transaction(async (tx) => {
    const transfer = await lockTransfer(tx, transferId);
    assertCanReceiveAt(actor, transfer.toLocationId);
    assertStatus(transfer.status, ["RECEIVING"], "receive items");

    // Lock the unit row on its own: FOR UPDATE OF cannot take a schema-qualified table name.
    await tx.select({ id: units.id }).from(units).where(eq(units.serial, serial)).for("update");
    const [unit] = await tx
      .select({
        id: units.id,
        state: units.state,
        transferId: units.currentTransferId,
        batchId: units.batchId,
        itemName: itemTypes.name,
      })
      .from(units)
      .innerJoin(itemTypes, eq(itemTypes.id, units.itemTypeId))
      .where(eq(units.serial, serial));
    if (!unit) throw new ValidationError(`${serial} is not in the system`);

    const [item] = await tx
      .select({ id: transferItems.id, receivedAt: transferItems.receivedAt })
      .from(transferItems)
      .where(and(eq(transferItems.transferId, transfer.id), eq(transferItems.unitId, unit.id)));
    if (!item) {
      throw new WrongTransferError(`${serial} is not on this transfer. Check the slip and the destination`);
    }

    const progress = async (extra = 0) => {
      const [c] = await tx
        .select({
          expected: sql<number>`count(*) filter (where ${transferItems.unitId} is not null)::int`,
          scanned: sql<number>`count(*) filter (where ${transferItems.unitId} is not null and ${transferItems.receivedAt} is not null)::int`,
        })
        .from(transferItems)
        .where(eq(transferItems.transferId, transfer.id));
      return { scanned: (c?.scanned ?? 0) + extra, expected: c?.expected ?? 0 };
    };

    if (item.receivedAt) {
      return { status: "duplicate" as const, serial, itemName: unit.itemName, ...(await progress()) };
    }

    assertUnitOnTransfer(unit.transferId, transfer.id, serial);
    const step = transition(unit.state, "RECEIVE"); // IN_TRANSIT -> IN_STOCK, else a clear error

    const now = new Date();
    await tx
      .update(units)
      .set({ state: step.to, currentLocationId: transfer.toLocationId, currentTransferId: null })
      .where(eq(units.id, unit.id));
    await tx
      .update(transferItems)
      .set({ receivedAt: now, receivedBy: actor.userId })
      .where(eq(transferItems.id, item.id));
    await appendEvents(tx, [
      {
        id: options.eventId ?? randomUUID(),
        unitId: unit.id,
        batchId: unit.batchId,
        quantity: 1,
        type: step.event,
        fromState: unit.state,
        toState: step.to,
        locationId: transfer.toLocationId,
        userId: actor.userId,
        transferId: transfer.id,
        occurredAt: options.occurredAt ?? now,
        deviceId: options.deviceId ?? null,
        payload: {
          transferCode: transfer.code,
          fromLocationId: transfer.fromLocationId,
          ...(options.payload ?? {}),
        },
      },
    ]);

    return { status: "received" as const, serial, itemName: unit.itemName, ...(await progress()) };
  });
}

export type ReceivePackResult = { status: "received" | "duplicate"; packCode: string; itemName: string; received: number };

/**
 * One whole pack or roll scanned at the destination. Only packs that were scanned one by one when the transfer was
 * sent can be scanned in. Scanning moves the pack's location to this store. The batch ledger is not touched here: it
 * moves when the receipt closes, from the packs scanned in (a line sent pack by pack) or from the blind count (any
 * other line).
 */
export async function receivePack(
  transferId: string,
  packInput: string,
  actor: Actor,
  conn: DbOrTx = db(),
): Promise<ReceivePackResult> {
  const packCode = parsePackCode(packInput);
  if (!packCode) throw new ValidationError("That is not a pack label. Scan the PK label on the pack or roll");

  return conn.transaction(async (tx) => {
    const transfer = await lockTransfer(tx, transferId);
    assertCanReceiveAt(actor, transfer.toLocationId);
    assertStatus(transfer.status, ["RECEIVING"], "receive items");

    const [found] = await tx.select({ batchId: packs.batchId }).from(packs).where(eq(packs.code, packCode));
    if (!found) throw new ValidationError(`${packCode} is not in the system`);
    // Same lock order as dispatch: transfer, then batch, then pack.
    await tx.select({ id: batches.id }).from(batches).where(eq(batches.id, found.batchId)).for("update");
    const [pack] = await tx.select().from(packs).where(eq(packs.code, packCode)).for("update");
    if (!pack) throw new ValidationError(`${packCode} is not in the system`);

    const [link] = await tx
      .select({ id: transferItemPacks.id, receivedAt: transferItemPacks.receivedAt })
      .from(transferItemPacks)
      .innerJoin(transferItems, eq(transferItems.id, transferItemPacks.transferItemId))
      .where(and(eq(transferItemPacks.packId, pack.id), eq(transferItems.transferId, transfer.id)));
    if (!link) {
      throw new WrongTransferError(
        `${packCode} was not scanned when this transfer was sent. Check the slip and the destination`,
      );
    }

    const [type] = await tx.select({ name: itemTypes.name }).from(itemTypes).where(eq(itemTypes.id, pack.itemTypeId));
    const itemName = type?.name ?? "Item";
    const receivedCount = async (extra = 0) => {
      const [c] = await tx
        .select({ n: sql<number>`count(*) filter (where ${transferItemPacks.receivedAt} is not null)::int` })
        .from(transferItemPacks)
        .innerJoin(transferItems, eq(transferItems.id, transferItemPacks.transferItemId))
        .where(eq(transferItems.transferId, transfer.id));
      return (c?.n ?? 0) + extra;
    };

    if (link.receivedAt) return { status: "duplicate" as const, packCode, itemName, received: await receivedCount() };

    await tx.update(transferItemPacks).set({ receivedAt: new Date() }).where(eq(transferItemPacks.id, link.id));
    await tx.update(packs).set({ locationId: transfer.toLocationId }).where(eq(packs.id, pack.id));
    return { status: "received" as const, packCode, itemName, received: await receivedCount() };
  });
}

/**
 * Blind count of a QUANTITY batch. It can be corrected until the receipt closes. `countedIn` says whether the
 * receiver counted packs or pieces; it is converted to the unit the line was sent in before it is saved.
 */
export async function countQuantity(
  transferId: string,
  batchInput: string,
  counted: number,
  actor: Actor,
  conn: DbOrTx = db(),
  options: { countedIn?: CountUnit } = {},
) {
  const code = normalizeCode(batchInput);
  if (!isValidBatchCode(code)) throw new ValidationError("That is not a valid batch code. Scan the box label");

  return conn.transaction(async (tx) => {
    const transfer = await lockTransfer(tx, transferId);
    assertCanReceiveAt(actor, transfer.toLocationId);
    assertStatus(transfer.status, ["RECEIVING"], "count items");

    const [row] = await tx
      .select({
        itemId: transferItems.id,
        dispatched: transferItems.quantityDispatched,
        inPieces: transferItems.inPieces,
        unit: itemTypes.unitOfMeasure,
        packSize: itemTypes.packSize,
        batchCode: batches.code,
        itemName: itemTypes.name,
        linkedPacks: linkedPacksOf(),
      })
      .from(transferItems)
      .innerJoin(batches, eq(batches.id, transferItems.batchId))
      .innerJoin(itemTypes, eq(itemTypes.id, batches.itemTypeId))
      .where(and(eq(transferItems.transferId, transfer.id), eq(batches.code, code)));
    if (!row) throw new WrongTransferError("That batch is not on this transfer. Check the slip");
    if (isScanLine({ inPieces: row.inPieces, linkedPacks: row.linkedPacks, dispatched: row.dispatched })) {
      throw new ValidationError(
        `${row.batchCode} was sent pack by pack. Scan the label on each pack as it arrives instead of entering a count`,
      );
    }

    let lineCount = counted;
    if (options.countedIn) {
      const converted = toLineQuantity({
        counted,
        countedIn: options.countedIn,
        unit: row.unit,
        inPieces: row.inPieces,
        packSize: row.packSize,
      });
      if ("error" in converted) throw new ValidationError(converted.error);
      lineCount = converted.quantity;
    }

    assertCountPlausible(lineCount, row.dispatched);
    await tx.update(transferItems).set({ quantityReceived: lineCount }).where(eq(transferItems.id, row.itemId));
    return { batchCode: row.batchCode, itemName: row.itemName, counted: lineCount };
  });
}

/**
 * Closes the receipt. Scanned units are already received. Every unscanned unit becomes
 * MISSING_IN_TRANSIT and every short quantity is recorded, each with its own event, and the
 * transfer becomes RECEIVED or RECEIVED_WITH_DISCREPANCY. All of it is one transaction. When the
 * transfer is linked to a stock request, the request's received quantities and status follow it here.
 */
export async function closeReceipt(transferId: string, actor: Actor, conn: DbOrTx = db()) {
  return conn.transaction(async (tx) => {
    const transfer = await lockTransfer(tx, transferId);
    assertCanReceiveAt(actor, transfer.toLocationId);
    assertStatus(transfer.status, ["RECEIVING"], "close the receipt");

    const items = await tx
      .select({
        id: transferItems.id,
        unitId: transferItems.unitId,
        batchId: transferItems.batchId,
        inPieces: transferItems.inPieces,
        dispatched: transferItems.quantityDispatched,
        received: transferItems.quantityReceived,
        receivedAt: transferItems.receivedAt,
        serial: units.serial,
        unitBatchId: units.batchId,
        batchCode: batches.code,
        linkedPacks: linkedPacksOf(),
        receivedPacks: receivedPacksOf(),
      })
      .from(transferItems)
      .leftJoin(units, eq(units.id, transferItems.unitId))
      .leftJoin(batches, eq(batches.id, transferItems.batchId))
      .where(eq(transferItems.transferId, transfer.id));

    // A line sent pack by pack is received by scanning its packs in: what was scanned is what arrived, and any pack
    // not scanned counts as short, like an unscanned bottle. Every other line uses the count that was typed.
    const receivedOf = (i: (typeof items)[number]) =>
      isScanLine({ inPieces: i.inPieces, linkedPacks: i.linkedPacks, dispatched: i.dispatched }) ? i.receivedPacks : i.received;

    const receiptItems: ReceiptItem[] = items.map((i) =>
      i.unitId
        ? { kind: "SERIAL", ref: i.serial as string, dispatched: 1, received: i.receivedAt ? 1 : null }
        : { kind: "QUANTITY", ref: i.batchCode as string, dispatched: i.dispatched, received: receivedOf(i) },
    );
    const outcome = receiptOutcome(receiptItems);
    if (outcome.uncounted.length > 0) {
      throw new ValidationError(
        `Count these batches before closing (enter 0 if none arrived): ${outcome.uncounted.join(", ")}`,
      );
    }

    const now = new Date();
    const events: NewEvent[] = [];
    const eventBase = { locationId: transfer.toLocationId, userId: actor.userId, transferId: transfer.id, occurredAt: now };

    // SERIAL: unscanned units go missing.
    const missingUnits = items.filter((i) => i.unitId && !i.receivedAt);
    if (missingUnits.length > 0) {
      const step = transition("IN_TRANSIT", "MARK_MISSING");
      for (const part of chunks(missingUnits.map((i) => i.unitId as string))) {
        const rows = await tx
          .select({ id: units.id, state: units.state })
          .from(units)
          .where(inArray(units.id, part))
          .orderBy(asc(units.id))
          .for("update");
        for (const r of rows) transition(r.state, "MARK_MISSING"); // must still be IN_TRANSIT
        await tx.update(units).set({ state: step.to }).where(inArray(units.id, part));
      }
      for (const i of missingUnits) {
        events.push({
          ...eventBase,
          id: randomUUID(),
          unitId: i.unitId,
          batchId: i.unitBatchId,
          quantity: 1,
          type: step.event,
          fromState: "IN_TRANSIT",
          toState: step.to,
          payload: { transferCode: transfer.code, fromLocationId: transfer.fromLocationId },
        });
      }
      for (const part of chunks(missingUnits.map((i) => i.id))) {
        await tx.update(transferItems).set({ quantityMissing: 1 }).where(inArray(transferItems.id, part));
      }
    }

    // QUANTITY: record what arrived and any shortfall.
    for (const i of items.filter((x) => x.batchId)) {
      const received = receivedOf(i) ?? 0;
      const missing = i.dispatched - received;
      // A line counted in loose pieces moves pieces, not whole packs: its events carry quantity 0 and the number of
      // pieces, so the pack balance never moves and the receiving location holds loose pieces.
      const amount = (n: number) => (i.inPieces ? { quantity: 0, pieces: n } : { quantity: n });
      if (received > 0) {
        events.push({ ...eventBase, id: randomUUID(), batchId: i.batchId, ...amount(received), type: "RECEIVED" });
      }
      if (missing > 0) {
        events.push({
          ...eventBase,
          id: randomUUID(),
          batchId: i.batchId,
          ...amount(missing),
          type: "MISSING_IN_TRANSIT",
          payload: { transferCode: transfer.code, fromLocationId: transfer.fromLocationId },
        });
      }
      await tx
        .update(transferItems)
        .set({ quantityReceived: received, receivedAt: now, receivedBy: actor.userId, quantityMissing: Math.max(missing, 0) })
        .where(eq(transferItems.id, i.id));
    }

    if (events.length > 0) await appendEvents(tx, events);

    // Nothing on this transfer is "open" any more, so its units can travel again once back in stock.
    await tx.update(transferItems).set({ open: false }).where(eq(transferItems.transferId, transfer.id));
    // Likewise its scanned packs: the ones scanned in already sit at this store, the rest stay where they were.
    await closePackLinks(tx, transfer.id);

    const [updated] = await tx
      .update(transfers)
      .set({ status: statusAfterClose(outcome), receiptClosedBy: actor.userId, receiptClosedAt: now })
      .where(eq(transfers.id, transfer.id))
      .returning();

    if (transfer.requestId) await syncRequestFromTransfers(tx, transfer.requestId);

    return { transfer: updated, outcome };
  });
}
