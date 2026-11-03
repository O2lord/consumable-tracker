import "server-only";
import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, ne, sql } from "drizzle-orm";
import { appendEvents, type DbOrTx, type NewEvent, type Tx } from "../audit/events";
import { db } from "../db/client";
import {
  quantityLoose,
  quantityOnHand,
  quantityReservedByDrafts,
  quantityReservedPiecesByDrafts,
} from "../db/queries/quantity";
import { isUniqueViolation } from "../db/errors";
import {
  batches,
  cartons,
  itemTypes,
  locations,
  packs,
  stockRequests,
  transferBatchParts,
  transferCartonParts,
  transferItemPacks,
  transferItems,
  transferPackParts,
  transfers,
  units,
  users,
} from "../db/schema";
import { DomainError, InvalidSerialError, NotFoundError, ValidationError } from "../domain/errors";
import {
  assertCanDispatchPieces,
  assertCanDispatchQuantity,
  assertCanDispatchUnit,
  assertServiceRoleAllowed,
  assertStatus,
} from "../domain/rules";
import { transition } from "../domain/state-machine";
import type { TransferStatus } from "../domain/types";
import {
  generateTransferCode,
  isValidBatchCode,
  normalizeCode,
  parseCartonCode,
  parsePackCode,
  parseSerial,
  parseTransferCode,
} from "../../lib/serial";
import { partLetter } from "../../lib/part-letter";
import { pageInfo, type Paged } from "../../lib/pagination";
import { holdingAfterDrafts, planPieceDispatch } from "../../lib/pack-size";
import { assertTransferWithinRequest, syncRequestFromTransfers } from "./request-sync.service";
import { closePackLinks } from "./pack.service";
import {
  confirmTransferSchema,
  createTransferSchema,
  type ConfirmTransferInput,
  type CreateTransferInput,
} from "../../types/transfers";

// Dispatch (architecture 7.2): create a transfer, add SERIAL units by scan and QUANTITY batches by
// count, then confirm. Nothing moves until confirm: drafts only record intent, and confirm
// re-checks every item inside the transaction that moves it.
// Callers check the `dispatch` permission.

const CHUNK = 1000;
const today = () => new Date().toISOString().slice(0, 10);

function chunks<T>(items: readonly T[], size = CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

async function lockTransfer(tx: Tx, transferId: string) {
  const [row] = await tx.select().from(transfers).where(eq(transfers.id, transferId)).for("update");
  if (!row) throw new NotFoundError("Transfer");
  return row;
}

/** Pack size of each batch's item type (1 when it has none). Read-only, so no locking. */
async function batchPackSizes(conn: DbOrTx, batchIds: readonly string[]): Promise<Map<string, number>> {
  const ids = [...new Set(batchIds)];
  if (ids.length === 0) return new Map();
  const rows = await conn
    .select({ id: batches.id, packSize: itemTypes.packSize })
    .from(batches)
    .innerJoin(itemTypes, eq(itemTypes.id, batches.itemTypeId))
    .where(inArray(batches.id, ids));
  return new Map(rows.map((r) => [r.id, r.packSize]));
}

/**
 * What a bulk batch holds at a location, as sealed packs and loose pieces, and what is still free once the OTHER
 * open drafts have taken their share (`free`). The dispatch checks use `free`; the pack-opening arithmetic at
 * confirm uses the real holding.
 */
async function freeHolding(conn: DbOrTx, batchId: string, locationId: string, exceptTransferId: string, packSize: number) {
  const sealed = await quantityOnHand(conn, batchId, locationId);
  const loose = await quantityLoose(conn, batchId, locationId);
  const reservedPacks = await quantityReservedByDrafts(conn, batchId, locationId, exceptTransferId);
  const reservedPieces = await quantityReservedPiecesByDrafts(conn, batchId, locationId, exceptTransferId);
  return { sealed, loose, free: holdingAfterDrafts({ sealed, loose, packSize, reservedPacks, reservedPieces }) };
}

// --- create / cancel ---------------------------------------------------------

export async function createTransfer(rawInput: CreateTransferInput, userId: string, conn: DbOrTx = db()) {
  const parsed = createTransferSchema.safeParse(rawInput);
  if (!parsed.success) throw new ValidationError(parsed.error.issues.map((i) => i.message).join("; "));
  const input = parsed.data;

  return conn.transaction(async (tx) => {
    const [from] = await tx.select().from(locations).where(eq(locations.id, input.fromLocationId));
    if (!from || !from.active) throw new NotFoundError("Sending location");
    // Phase 2 dispatches from stores only; forwarding from a lab or ward is a later extension.
    if (from.type !== "STORE") throw new ValidationError("Stock can only be dispatched from a store location");

    const [to] = await tx.select().from(locations).where(eq(locations.id, input.toLocationId));
    if (!to || !to.active) throw new NotFoundError("Destination");

    try {
      const [row] = await tx
        .insert(transfers)
        .values({
          code: generateTransferCode(),
          fromLocationId: from.id,
          toLocationId: to.id,
          status: "DRAFT",
          note: input.note ?? null,
          createdBy: userId,
        })
        .returning();
      return row;
    } catch (err) {
      if (isUniqueViolation(err)) throw new ValidationError("Could not create the transfer. Try again");
      throw err;
    }
  });
}

/**
 * Abandons a draft. Its items are released so they can go on another transfer. A draft linked to a
 * request leaves the request approved with its balance still open, so the store can start another
 * transfer for it (createTransferForRequest).
 */
export async function cancelTransfer(transferId: string, conn: DbOrTx = db()) {
  return conn.transaction(async (tx) => {
    const transfer = await lockTransfer(tx, transferId);
    assertStatus(transfer.status, ["DRAFT"], "cancel");
    await tx.update(transferItems).set({ open: false }).where(eq(transferItems.transferId, transfer.id));
    await closePackLinks(tx, transfer.id);
    const [row] = await tx
      .update(transfers)
      .set({ status: "CANCELLED" })
      .where(eq(transfers.id, transfer.id))
      .returning();
    if (transfer.requestId) await syncRequestFromTransfers(tx, transfer.requestId);
    return row;
  });
}

// --- building the draft --------------------------------------------------------

export interface DraftCounts {
  serialCount: number;
  /** Whole units of bulk items (packs for a pack item). Lines counted in loose pieces are in `pieceTotal`. */
  quantityTotal: number;
  /** Loose pieces on the draft. */
  pieceTotal: number;
}

async function draftCounts(conn: DbOrTx, transferId: string): Promise<DraftCounts> {
  const [row] = await conn
    .select({
      serialCount: sql<number>`count(*) filter (where ${transferItems.unitId} is not null)::int`,
      quantityTotal: sql<number>`coalesce(sum(${transferItems.quantityDispatched}) filter (where ${transferItems.batchId} is not null and not ${transferItems.inPieces}), 0)::int`,
      pieceTotal: sql<number>`coalesce(sum(${transferItems.quantityDispatched}) filter (where ${transferItems.batchId} is not null and ${transferItems.inPieces}), 0)::int`,
    })
    .from(transferItems)
    .where(eq(transferItems.transferId, transferId));
  return { serialCount: row?.serialCount ?? 0, quantityTotal: row?.quantityTotal ?? 0, pieceTotal: row?.pieceTotal ?? 0 };
}

/** How many bottles of one batch are on a draft right now (the "6 of 10" in the scan screen). */
async function batchDraftCount(conn: DbOrTx, transferId: string, batchCode: string): Promise<number> {
  const [row] = await conn
    .select({ n: sql<number>`count(*)::int` })
    .from(transferItems)
    .innerJoin(units, eq(units.id, transferItems.unitId))
    .innerJoin(batches, eq(batches.id, units.batchId))
    .where(and(eq(transferItems.transferId, transferId), eq(batches.code, batchCode)));
  return row?.n ?? 0;
}

export type AddUnitResult =
  | { status: "added"; itemId: string; serial: string; itemName: string; batchCode: string; batchCount: number; counts: DraftCounts }
  | { status: "duplicate"; itemId: string; serial: string; itemName: string; batchCode: string; batchCount: number; counts: DraftCounts };

/**
 * Scan one bottle onto a draft. Scanning the same bottle twice is harmless ("duplicate").
 *
 * `expectedBatchCode` is the box the store keeper scanned first. When given, a bottle from any other
 * batch is rejected, which catches a bottle that ended up in the wrong box.
 */
export async function addUnitToTransfer(
  transferId: string,
  serialInput: string,
  conn: DbOrTx = db(),
  expectedBatchCode?: string,
  expectedPackCode?: string,
): Promise<AddUnitResult> {
  const serial = parseSerial(serialInput);
  if (!serial) throw new InvalidSerialError(serialInput);
  const expectedBatch = expectedBatchCode ? normalizeCode(expectedBatchCode) : null;
  // Set when the store keeper chose "send bottles from this pack": a bottle from anywhere else is rejected.
  const expectedPack = expectedPackCode ? normalizeCode(expectedPackCode) : null;

  return conn.transaction(async (tx) => {
    const transfer = await lockTransfer(tx, transferId);
    assertStatus(transfer.status, ["DRAFT"], "add items");

    // Lock the unit row on its own: Postgres rejects FOR UPDATE OF with a schema-qualified name,
    // which is what Drizzle emits for tables in the `consumables` schema.
    await tx.select({ id: units.id }).from(units).where(eq(units.serial, serial)).for("update");
    const [unit] = await tx
      .select({
        id: units.id,
        serial: units.serial,
        state: units.state,
        locationId: units.currentLocationId,
        transferId: units.currentTransferId,
        itemName: itemTypes.name,
        expiryDate: batches.expiryDate,
        batchCode: batches.code,
        packCode: packs.code,
      })
      .from(units)
      .innerJoin(batches, eq(batches.id, units.batchId))
      .innerJoin(itemTypes, eq(itemTypes.id, units.itemTypeId))
      .leftJoin(packs, eq(packs.id, units.packId))
      .where(eq(units.serial, serial));
    if (!unit) throw new ValidationError(`${serial} is not in the system`);
    if (expectedBatch && unit.batchCode !== expectedBatch) {
      throw new ValidationError(
        `${serial} is from batch ${unit.batchCode}, not the box you scanned (${expectedBatch}). Put it back, or scan its own box code first`,
      );
    }
    if (expectedPack && unit.packCode !== expectedPack) {
      throw new ValidationError(
        `${serial} is not from pack ${expectedPack}${unit.packCode ? ` (it is from pack ${unit.packCode})` : ""}. Put it back, or scan its own pack label first`,
      );
    }

    const [existing] = await tx
      .select({ id: transferItems.id, transferId: transferItems.transferId, open: transferItems.open })
      .from(transferItems)
      .where(and(eq(transferItems.unitId, unit.id), eq(transferItems.open, true)));
    if (existing) {
      if (existing.transferId === transfer.id) {
        return {
          status: "duplicate" as const,
          itemId: existing.id,
          serial,
          itemName: unit.itemName,
          batchCode: unit.batchCode,
          batchCount: await batchDraftCount(tx, transfer.id, unit.batchCode),
          counts: await draftCounts(tx, transfer.id),
        };
      }
      const [other] = await tx.select({ code: transfers.code }).from(transfers).where(eq(transfers.id, existing.transferId));
      throw new ValidationError(`${serial} is already on open transfer ${other?.code ?? "(unknown)"}`);
    }

    assertCanDispatchUnit(
      { serial, state: unit.state, locationId: unit.locationId, transferId: unit.transferId, expiryDate: unit.expiryDate },
      transfer.fromLocationId,
      today(),
    );

    const [item] = await tx
      .insert(transferItems)
      .values({ transferId: transfer.id, unitId: unit.id, quantityDispatched: 1 })
      .returning({ id: transferItems.id });

    return {
      status: "added" as const,
      itemId: item.id,
      serial,
      itemName: unit.itemName,
      batchCode: unit.batchCode,
      batchCount: await batchDraftCount(tx, transfer.id, unit.batchCode),
      counts: await draftCounts(tx, transfer.id),
    };
  });
}

export interface SetQuantityResult {
  itemId: string;
  batchCode: string;
  itemName: string;
  quantity: number;
  /** True when `quantity` is loose pieces rather than the item's own unit. */
  inPieces: boolean;
  /** The scanned pack the pieces come from (PK...), or null when no pack was named. */
  packCode: string | null;
  counts: DraftCounts;
}

/**
 * Pieces other open drafts have already promised from one pack. A draft line only records intent, so the pack's
 * pieces_remaining does not drop until the transfer is confirmed; this keeps two drafts from taking the same pieces.
 */
async function piecesPromisedFromPack(conn: DbOrTx, packId: string, exceptTransferId: string): Promise<number> {
  const [row] = await conn
    .select({ n: sql<number>`coalesce(sum(${transferItems.quantityDispatched}), 0)::int` })
    .from(transferItems)
    .innerJoin(transfers, eq(transfers.id, transferItems.transferId))
    .where(
      and(eq(transferItems.packId, packId), eq(transfers.status, "DRAFT"), ne(transferItems.transferId, exceptTransferId)),
    );
  return row?.n ?? 0;
}

/**
 * Set (or change) how much of a QUANTITY batch goes on a draft. With `inPieces` the number is loose pieces taken
 * from the batch: loose pieces already there go first and a sealed pack is opened only when they run out (the
 * ledger records that at confirm). Pieces need an item with a pack size above 1.
 */
export async function setBatchQuantity(
  transferId: string,
  batchInput: string,
  quantity: number,
  conn: DbOrTx = db(),
  options: { inPieces?: boolean; packCode?: string | null } = {},
): Promise<SetQuantityResult> {
  const inPieces = options.inPieces === true;
  // A pack is only named for pieces. Whole packs are counted by the ledger and do not say which pack they were.
  const scannedPackCode = inPieces && options.packCode ? parsePackCode(options.packCode) : null;
  if (inPieces && options.packCode && !scannedPackCode) throw new ValidationError("That is not a valid pack code");
  const code = normalizeCode(batchInput);
  if (!isValidBatchCode(code)) throw new ValidationError("That is not a valid batch code. Scan the box label");

  return conn.transaction(async (tx) => {
    const transfer = await lockTransfer(tx, transferId);
    assertStatus(transfer.status, ["DRAFT"], "add items");

    await tx.select({ id: batches.id }).from(batches).where(eq(batches.code, code)).for("update");
    const [batch] = await tx
      .select({
        id: batches.id,
        code: batches.code,
        expiryDate: batches.expiryDate,
        itemName: itemTypes.name,
        trackingMode: itemTypes.trackingMode,
        packSize: itemTypes.packSize,
      })
      .from(batches)
      .innerJoin(itemTypes, eq(itemTypes.id, batches.itemTypeId))
      .where(eq(batches.code, code));
    if (!batch) throw new NotFoundError("Batch");
    if (batch.trackingMode !== "QUANTITY") {
      throw new ValidationError("This batch is serialized: scan each bottle instead of entering a quantity");
    }

    const holding = await freeHolding(tx, batch.id, transfer.fromLocationId, transfer.id, batch.packSize);
    if (inPieces) {
      assertCanDispatchPieces({
        pieces: quantity,
        sealed: holding.free.sealed,
        loose: holding.free.loose,
        packSize: batch.packSize,
        expiryDate: batch.expiryDate,
        today: today(),
      });
    } else {
      assertCanDispatchQuantity({
        quantity,
        available: holding.free.sealed,
        expiryDate: batch.expiryDate,
        today: today(),
      });
    }

    // The scanned pack: it must be this batch's, be in the sending store, and still hold enough pieces after what
    // other open drafts have promised from it.
    let pack: { id: string; code: string } | null = null;
    if (scannedPackCode) {
      const [row] = await tx.select().from(packs).where(eq(packs.code, scannedPackCode)).for("update");
      if (!row) throw new NotFoundError("Pack");
      if (row.batchId !== batch.id) throw new ValidationError(`Pack ${row.code} belongs to a different batch`);
      if (row.locationId !== transfer.fromLocationId) throw new ValidationError(`Pack ${row.code} is not in the sending store`);
      const [onTransfer] = await tx
        .select({ id: transferItemPacks.id })
        .from(transferItemPacks)
        .where(and(eq(transferItemPacks.packId, row.id), eq(transferItemPacks.open, true)));
      if (onTransfer) throw new ValidationError(`Pack ${row.code} is already on a transfer that has not been received yet`);
      const promised = await piecesPromisedFromPack(tx, row.id, transfer.id);
      const left = row.piecesRemaining - promised;
      if (quantity > left) {
        throw new ValidationError(
          `Pack ${row.code} has ${left} ${left === 1 ? "piece" : "pieces"} left to send. Enter ${left} or fewer, or scan another pack`,
        );
      }
      pack = { id: row.id, code: row.code };
    }

    const [existing] = await tx
      .select({ id: transferItems.id })
      .from(transferItems)
      .where(and(eq(transferItems.transferId, transfer.id), eq(transferItems.batchId, batch.id)));

    let itemId: string;
    if (existing) {
      // Scanned whole packs on this line: the number cannot drop below them (remove a pack by undoing its scan), and
      // switching the line to pieces drops them, because pieces are not counted pack by pack.
      const [linked] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(transferItemPacks)
        .where(eq(transferItemPacks.transferItemId, existing.id));
      const linkedCount = linked?.n ?? 0;
      if (inPieces && linkedCount > 0) {
        await tx.delete(transferItemPacks).where(eq(transferItemPacks.transferItemId, existing.id));
      } else if (!inPieces && quantity < linkedCount) {
        throw new ValidationError(
          `${linkedCount} packs of this batch are already scanned on this draft. Enter ${linkedCount} or more, or remove a scanned pack first`,
        );
      }
      await tx
        .update(transferItems)
        .set({ quantityDispatched: quantity, inPieces, packId: pack?.id ?? null })
        .where(eq(transferItems.id, existing.id));
      itemId = existing.id;
    } else {
      const [item] = await tx
        .insert(transferItems)
        .values({ transferId: transfer.id, batchId: batch.id, quantityDispatched: quantity, inPieces, packId: pack?.id ?? null })
        .returning({ id: transferItems.id });
      itemId = item.id;
    }

    return {
      itemId,
      batchCode: batch.code,
      itemName: batch.itemName,
      quantity,
      inPieces,
      packCode: pack?.code ?? null,
      counts: await draftCounts(tx, transfer.id),
    };
  });
}

export interface AddPackResult {
  itemId: string;
  batchCode: string;
  itemName: string;
  packCode: string;
  /** Packs of this batch on the draft line now. */
  quantity: number;
  /** How many of those were scanned one by one. The rest were typed and are not tied to a pack label. */
  scanned: number;
  counts: DraftCounts;
}

/**
 * Scanning a pack label to send the WHOLE pack. The pack goes on its batch's whole-pack line (the line's number of
 * packs goes up by one) and is remembered by code, so that receiving can move this pack's location. The pack has to
 * be sealed: a pack that was opened for pieces goes out as pieces, not as a whole pack. The batch ledger still moves
 * the stock exactly as before, and the same free-stock checks as a typed quantity apply.
 */
export async function addPackToDraft(transferId: string, packInput: string, conn: DbOrTx = db()): Promise<AddPackResult> {
  const packCode = parsePackCode(packInput);
  if (!packCode) throw new ValidationError("That is not a valid pack code");

  return conn.transaction(async (tx) => {
    const transfer = await lockTransfer(tx, transferId);
    assertStatus(transfer.status, ["DRAFT"], "add items");

    const [found] = await tx.select({ batchId: packs.batchId }).from(packs).where(eq(packs.code, packCode));
    if (!found) throw new NotFoundError("Pack");
    // Same lock order as everywhere else: batch first, then pack.
    await tx.select({ id: batches.id }).from(batches).where(eq(batches.id, found.batchId)).for("update");
    const [pack] = await tx.select().from(packs).where(eq(packs.code, packCode)).for("update");
    if (!pack) throw new NotFoundError("Pack");

    if (pack.locationId !== transfer.fromLocationId) throw new ValidationError(`Pack ${pack.code} is not in the sending store`);
    if (pack.piecesRemaining < pack.piecesPerPack) {
      throw new ValidationError(
        `Pack ${pack.code} has been opened (${pack.piecesRemaining} of ${pack.piecesPerPack} pieces left). Send pieces of it instead of the whole pack`,
      );
    }

    const [open] = await tx
      .select({ transferId: transferItems.transferId })
      .from(transferItemPacks)
      .innerJoin(transferItems, eq(transferItems.id, transferItemPacks.transferItemId))
      .where(and(eq(transferItemPacks.packId, pack.id), eq(transferItemPacks.open, true)));
    if (open) {
      throw new ValidationError(
        open.transferId === transfer.id
          ? `Pack ${pack.code} is already on this transfer`
          : `Pack ${pack.code} is already on another transfer that has not been received yet`,
      );
    }

    const [batch] = await tx
      .select({
        id: batches.id,
        code: batches.code,
        expiryDate: batches.expiryDate,
        itemName: itemTypes.name,
        trackingMode: itemTypes.trackingMode,
        packSize: itemTypes.packSize,
      })
      .from(batches)
      .innerJoin(itemTypes, eq(itemTypes.id, batches.itemTypeId))
      .where(eq(batches.id, pack.batchId));
    if (!batch) throw new NotFoundError("Batch");
    if (batch.trackingMode !== "QUANTITY") throw new ValidationError("This pack's item is serialized: scan each bottle instead");

    const [existing] = await tx
      .select({ id: transferItems.id, quantity: transferItems.quantityDispatched, inPieces: transferItems.inPieces })
      .from(transferItems)
      .where(and(eq(transferItems.transferId, transfer.id), eq(transferItems.batchId, batch.id)));
    if (existing?.inPieces) {
      throw new ValidationError("This batch is on the draft in pieces. Remove that line first to send whole packs");
    }

    const quantity = (existing?.quantity ?? 0) + 1;
    const holding = await freeHolding(tx, batch.id, transfer.fromLocationId, transfer.id, batch.packSize);
    assertCanDispatchQuantity({
      quantity,
      available: holding.free.sealed,
      expiryDate: batch.expiryDate,
      today: today(),
    });

    let itemId: string;
    if (existing) {
      await tx.update(transferItems).set({ quantityDispatched: quantity }).where(eq(transferItems.id, existing.id));
      itemId = existing.id;
    } else {
      const [item] = await tx
        .insert(transferItems)
        .values({ transferId: transfer.id, batchId: batch.id, quantityDispatched: quantity, inPieces: false })
        .returning({ id: transferItems.id });
      itemId = item.id;
    }
    try {
      await tx.insert(transferItemPacks).values({ transferItemId: itemId, packId: pack.id });
    } catch (err) {
      if (isUniqueViolation(err)) throw new ValidationError(`Pack ${pack.code} is already on a transfer`);
      throw err;
    }

    const [scanned] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(transferItemPacks)
      .where(eq(transferItemPacks.transferItemId, itemId));

    return {
      itemId,
      batchCode: batch.code,
      itemName: batch.itemName,
      packCode: pack.code,
      quantity,
      scanned: scanned?.n ?? 0,
      counts: await draftCounts(tx, transfer.id),
    };
  });
}

/** Takes one scanned pack back off a draft (the "undo last scan" for a whole pack). The line drops by one pack. */
export async function removePackFromDraft(transferId: string, packInput: string, conn: DbOrTx = db()): Promise<DraftCounts> {
  const packCode = parsePackCode(packInput);
  if (!packCode) throw new ValidationError("That is not a valid pack code");
  return conn.transaction(async (tx) => {
    const transfer = await lockTransfer(tx, transferId);
    assertStatus(transfer.status, ["DRAFT"], "remove items");
    const [link] = await tx
      .select({ id: transferItemPacks.id, itemId: transferItems.id, quantity: transferItems.quantityDispatched })
      .from(transferItemPacks)
      .innerJoin(packs, eq(packs.id, transferItemPacks.packId))
      .innerJoin(transferItems, eq(transferItems.id, transferItemPacks.transferItemId))
      .where(and(eq(packs.code, packCode), eq(transferItems.transferId, transfer.id)));
    if (!link) throw new NotFoundError("Pack on this transfer");
    await tx.delete(transferItemPacks).where(eq(transferItemPacks.id, link.id));
    if (link.quantity <= 1) await tx.delete(transferItems).where(eq(transferItems.id, link.itemId));
    else await tx.update(transferItems).set({ quantityDispatched: link.quantity - 1 }).where(eq(transferItems.id, link.itemId));
    return draftCounts(tx, transfer.id);
  });
}

// --- whole cartons, and whole packs of bottles -------------------------------------------------
//
// Bottles and packs are already linked to the carton they arrived in (units.carton_id, units.pack_id, packs.carton_id).
// Sending a whole carton or a whole pack of bottles puts each of its bottles (or each of its packs) on the draft as the
// same rows a one-by-one scan would, so dispatch, undo and receiving do not need to know a carton was involved.

type TransferRow = typeof transfers.$inferSelect;

/** What one carton, or one pack of bottles, holds as seen from a draft's sending store. */
interface GroupStats {
  total: number;
  /** Still in stock at the sending store (on this draft or not). */
  here: number;
  /** Here, and not on a different open transfer. */
  free: number;
  /** Already on THIS draft. */
  onDraft: number;
  /** Different packs the bottles sit in (bottles only). */
  packLabels: number;
}

async function bottleGroupStats(
  conn: DbOrTx,
  transfer: TransferRow,
  by: { cartonId: string } | { packId: string },
): Promise<GroupStats> {
  const member = "cartonId" in by ? sql`u.carton_id = ${by.cartonId}::uuid` : sql`u.pack_id = ${by.packId}::uuid`;
  const rows = await conn.execute<{ total: number; here: number; free: number; on_draft: number; pack_labels: number }>(sql`
    select count(*)::int as total,
           (count(*) filter (where u.state = 'IN_STOCK' and u.current_location_id = ${transfer.fromLocationId}::uuid))::int as here,
           (count(*) filter (
              where u.state = 'IN_STOCK' and u.current_location_id = ${transfer.fromLocationId}::uuid
                and not exists (
                  select 1 from consumables.transfer_items ti
                  where ti.unit_id = u.id and ti.open and ti.transfer_id <> ${transfer.id}::uuid
                )
           ))::int as free,
           (count(*) filter (
              where exists (
                select 1 from consumables.transfer_items ti
                where ti.unit_id = u.id and ti.open and ti.transfer_id = ${transfer.id}::uuid
              )
           ))::int as on_draft,
           count(distinct u.pack_id)::int as pack_labels
    from consumables.units u
    where ${member}
  `);
  const r = rows[0];
  return { total: r?.total ?? 0, here: r?.here ?? 0, free: r?.free ?? 0, onDraft: r?.on_draft ?? 0, packLabels: r?.pack_labels ?? 0 };
}

/** The same numbers for the sealed packs of a carton (bulk items). A pack that was opened for pieces no longer counts. */
async function sealedPackStats(conn: DbOrTx, transfer: TransferRow, cartonId: string): Promise<GroupStats> {
  const rows = await conn.execute<{ total: number; here: number; free: number; on_draft: number }>(sql`
    select count(*)::int as total,
           (count(*) filter (
              where p.location_id = ${transfer.fromLocationId}::uuid and p.pieces_remaining = p.pieces_per_pack
           ))::int as here,
           (count(*) filter (
              where p.location_id = ${transfer.fromLocationId}::uuid and p.pieces_remaining = p.pieces_per_pack
                and not exists (
                  select 1 from consumables.transfer_item_packs tip
                  join consumables.transfer_items ti on ti.id = tip.transfer_item_id
                  where tip.pack_id = p.id and tip.open and ti.transfer_id <> ${transfer.id}::uuid
                )
           ))::int as free,
           (count(*) filter (
              where exists (
                select 1 from consumables.transfer_item_packs tip
                join consumables.transfer_items ti on ti.id = tip.transfer_item_id
                where tip.pack_id = p.id and tip.open and ti.transfer_id = ${transfer.id}::uuid
              )
           ))::int as on_draft
    from consumables.packs p
    where p.carton_id = ${cartonId}::uuid
  `);
  const r = rows[0];
  return { total: r?.total ?? 0, here: r?.here ?? 0, free: r?.free ?? 0, onDraft: r?.on_draft ?? 0, packLabels: r?.total ?? 0 };
}

async function buildCartonInfo(
  conn: DbOrTx,
  transfer: TransferRow,
  carton: typeof cartons.$inferSelect,
  trackingMode: "SERIAL" | "QUANTITY",
): Promise<DispatchCartonInfo> {
  const [partRow] = await conn
    .select({ n: sql<number>`count(*)::int` })
    .from(transferCartonParts)
    .where(eq(transferCartonParts.cartonId, carton.id));
  const partsSent = partRow?.n ?? 0;
  if (trackingMode === "SERIAL") {
    const s = await bottleGroupStats(conn, transfer, { cartonId: carton.id });
    // A pack of bottles counts as on the draft once every bottle in it is.
    const rows = await conn.execute<{ n: number }>(sql`
      select count(*)::int as n from (
        select u.pack_id from consumables.units u
        where u.carton_id = ${carton.id}::uuid and u.pack_id is not null
        group by u.pack_id
        having bool_and(exists (
          select 1 from consumables.transfer_items ti
          where ti.unit_id = u.id and ti.open and ti.transfer_id = ${transfer.id}::uuid
        ))
      ) x
    `);
    return {
      code: carton.code,
      contents: "bottles",
      total: s.total,
      avail: s.free,
      onDraft: s.onDraft,
      packLabels: s.packLabels,
      packsTotal: s.packLabels,
      packsOnDraft: rows[0]?.n ?? 0,
      intact: s.total > 0 && s.free === s.total,
      partsSent,
    };
  }
  const s = await sealedPackStats(conn, transfer, carton.id);
  return {
    code: carton.code,
    contents: "packs",
    total: s.total,
    avail: s.free,
    onDraft: s.onDraft,
    packLabels: s.total,
    packsTotal: s.total,
    packsOnDraft: s.onDraft,
    intact: s.total > 0 && s.free === s.total,
    partsSent,
  };
}

/** How many of a batch's cartons are completely on this draft (every bottle, or every pack, in them). */
async function countCartonsOnDraft(
  conn: DbOrTx,
  transfer: TransferRow,
  batchId: string,
  trackingMode: "SERIAL" | "QUANTITY",
): Promise<number> {
  const rows =
    trackingMode === "SERIAL"
      ? await conn.execute<{ n: number }>(sql`
          select count(*)::int as n from (
            select u.carton_id from consumables.units u
            where u.batch_id = ${batchId}::uuid and u.carton_id is not null
            group by u.carton_id
            having bool_and(exists (
              select 1 from consumables.transfer_items ti
              where ti.unit_id = u.id and ti.open and ti.transfer_id = ${transfer.id}::uuid
            ))
          ) x
        `)
      : await conn.execute<{ n: number }>(sql`
          select count(*)::int as n from (
            select p.carton_id from consumables.packs p
            where p.batch_id = ${batchId}::uuid and p.carton_id is not null
            group by p.carton_id
            having bool_and(exists (
              select 1 from consumables.transfer_item_packs tip
              join consumables.transfer_items ti on ti.id = tip.transfer_item_id
              where tip.pack_id = p.id and tip.open and ti.transfer_id = ${transfer.id}::uuid
            ))
          ) x
        `);
  return rows[0]?.n ?? 0;
}

export interface AddGroupResult {
  code: string;
  batchCode: string;
  itemName: string;
  contents: "bottles" | "packs";
  /** Bottles or packs this call newly put on the draft (ones already there are skipped). */
  added: number;
  /** Everything the carton or pack holds. */
  total: number;
  counts: DraftCounts;
}

/**
 * Puts every bottle of one carton or one pack on the draft. All or nothing: the group has to be complete (every
 * bottle still in stock here and not on another transfer), otherwise it was opened and must go a pack or a bottle at a
 * time. Bottles already on this draft are left as they are.
 */
async function addBottlesOfGroup(
  tx: Tx,
  transfer: TransferRow,
  by: { cartonId: string } | { packId: string },
  label: string,
): Promise<{ added: number; total: number }> {
  const member = "cartonId" in by ? eq(units.cartonId, by.cartonId) : eq(units.packId, by.packId);
  // Lock the bottle rows on their own, as addUnitToTransfer does.
  await tx.select({ id: units.id }).from(units).where(member).for("update");

  const stats = await bottleGroupStats(tx, transfer, by);
  if (stats.total === 0) throw new ValidationError(`${label} has no bottles recorded in it`);
  if (stats.free !== stats.total) {
    throw new ValidationError(
      `${label} has been opened, or some of its bottles are gone or on another transfer (${stats.free} of ${stats.total} are free here). Send what is left by scanning its packs or bottles`,
    );
  }
  if (stats.onDraft === stats.total) throw new ValidationError(`${label} is already on this transfer`);

  const rows = await tx
    .select({
      id: units.id,
      serial: units.serial,
      state: units.state,
      locationId: units.currentLocationId,
      transferId: units.currentTransferId,
      expiryDate: batches.expiryDate,
    })
    .from(units)
    .innerJoin(batches, eq(batches.id, units.batchId))
    .where(member);

  const onThis = new Set<string>();
  for (const part of chunks(rows.map((r) => r.id))) {
    const found = await tx
      .select({ unitId: transferItems.unitId })
      .from(transferItems)
      .where(and(inArray(transferItems.unitId, part), eq(transferItems.transferId, transfer.id), eq(transferItems.open, true)));
    for (const f of found) if (f.unitId) onThis.add(f.unitId);
  }
  const fresh = rows.filter((r) => !onThis.has(r.id));

  for (const r of fresh) {
    try {
      assertCanDispatchUnit(
        { serial: r.serial, state: r.state, locationId: r.locationId, transferId: r.transferId, expiryDate: r.expiryDate },
        transfer.fromLocationId,
        today(),
      );
    } catch (err) {
      if (err instanceof DomainError) throw new ValidationError(`${label} cannot go as a whole: ${err.message}`);
      throw err;
    }
  }
  for (const part of chunks(fresh)) {
    await tx.insert(transferItems).values(part.map((r) => ({ transferId: transfer.id, unitId: r.id, quantityDispatched: 1 })));
  }
  return { added: fresh.length, total: stats.total };
}

/**
 * Send a WHOLE carton. For bottles every bottle in it goes on the draft; for bulk items every pack in it goes on as a
 * whole pack (each one is remembered by code, like a scanned pack). The carton has to be complete: one that has been
 * opened, or lost bottles or packs, goes pack by pack instead.
 */
export async function addCartonToDraft(transferId: string, cartonInput: string, conn: DbOrTx = db()): Promise<AddGroupResult> {
  const cartonCode = parseCartonCode(cartonInput);
  if (!cartonCode) throw new ValidationError("That is not a valid carton code");

  return conn.transaction(async (tx) => {
    const transfer = await lockTransfer(tx, transferId);
    assertStatus(transfer.status, ["DRAFT"], "add items");

    const [carton] = await tx
      .select({
        id: cartons.id,
        code: cartons.code,
        batchId: cartons.batchId,
        batchCode: batches.code,
        itemName: itemTypes.name,
        trackingMode: itemTypes.trackingMode,
      })
      .from(cartons)
      .innerJoin(batches, eq(batches.id, cartons.batchId))
      .innerJoin(itemTypes, eq(itemTypes.id, cartons.itemTypeId))
      .where(eq(cartons.code, cartonCode));
    if (!carton) throw new NotFoundError("Carton");
    // Same lock order as everywhere else: batch first.
    await tx.select({ id: batches.id }).from(batches).where(eq(batches.id, carton.batchId)).for("update");

    const label = `Carton ${carton.code}`;
    if (carton.trackingMode === "SERIAL") {
      const r = await addBottlesOfGroup(tx, transfer, { cartonId: carton.id }, label);
      return {
        code: carton.code,
        batchCode: carton.batchCode,
        itemName: carton.itemName,
        contents: "bottles" as const,
        added: r.added,
        total: r.total,
        counts: await draftCounts(tx, transfer.id),
      };
    }

    const stats = await sealedPackStats(tx, transfer, carton.id);
    if (stats.total === 0) throw new ValidationError(`${label} has no pack labels, so it cannot go as a whole carton`);
    if (stats.free !== stats.total) {
      throw new ValidationError(
        `${label} has been opened, or some of its packs are gone or on another transfer (${stats.free} of ${stats.total} are free here). Send its packs one by one instead`,
      );
    }
    if (stats.onDraft === stats.total) throw new ValidationError(`${label} is already on this transfer`);

    const all = await tx.select({ code: packs.code }).from(packs).where(eq(packs.cartonId, carton.id)).orderBy(asc(packs.code));
    const already = await tx
      .select({ code: packs.code })
      .from(transferItemPacks)
      .innerJoin(packs, eq(packs.id, transferItemPacks.packId))
      .innerJoin(transferItems, eq(transferItems.id, transferItemPacks.transferItemId))
      .where(and(eq(packs.cartonId, carton.id), eq(transferItems.transferId, transfer.id), eq(transferItemPacks.open, true)));
    const skip = new Set(already.map((a) => a.code));
    let added = 0;
    for (const p of all) {
      if (skip.has(p.code)) continue;
      // Each pack goes through the same checks as a single pack scan. A failure rolls the whole carton back.
      await addPackToDraft(transfer.id, p.code, tx);
      added += 1;
    }
    return {
      code: carton.code,
      batchCode: carton.batchCode,
      itemName: carton.itemName,
      contents: "packs" as const,
      added,
      total: stats.total,
      counts: await draftCounts(tx, transfer.id),
    };
  });
}

export type WholePackResult =
  | { kind: "packs"; result: AddPackResult; cartonCode: string | null }
  | { kind: "bottles"; result: AddGroupResult; cartonCode: string | null };

/**
 * Send ONE WHOLE PACK. A pack of a bulk item goes on as one whole pack (addPackToDraft); a pack of bottles puts every
 * bottle in it on the draft. `cartonCode` is the carton the pack came from, so the screen can stay on that carton.
 */
export async function addWholePackToDraft(transferId: string, packInput: string, conn: DbOrTx = db()): Promise<WholePackResult> {
  const packCode = parsePackCode(packInput);
  if (!packCode) throw new ValidationError("That is not a valid pack code");

  return conn.transaction(async (tx) => {
    const [row] = await tx
      .select({
        id: packs.id,
        batchId: packs.batchId,
        mode: itemTypes.trackingMode,
        batchCode: batches.code,
        itemName: itemTypes.name,
        cartonCode: cartons.code,
      })
      .from(packs)
      .innerJoin(itemTypes, eq(itemTypes.id, packs.itemTypeId))
      .innerJoin(batches, eq(batches.id, packs.batchId))
      .leftJoin(cartons, eq(cartons.id, packs.cartonId))
      .where(eq(packs.code, packCode));
    if (!row) throw new NotFoundError("Pack");
    const cartonCode = row.cartonCode ?? null;

    if (row.mode === "QUANTITY") {
      return { kind: "packs" as const, result: await addPackToDraft(transferId, packCode, tx), cartonCode };
    }

    const transfer = await lockTransfer(tx, transferId);
    assertStatus(transfer.status, ["DRAFT"], "add items");
    await tx.select({ id: batches.id }).from(batches).where(eq(batches.id, row.batchId)).for("update");
    const r = await addBottlesOfGroup(tx, transfer, { packId: row.id }, `Pack ${packCode}`);
    return {
      kind: "bottles" as const,
      result: {
        code: packCode,
        batchCode: row.batchCode,
        itemName: row.itemName,
        contents: "bottles" as const,
        added: r.added,
        total: r.total,
        counts: await draftCounts(tx, transfer.id),
      },
      cartonCode,
    };
  });
}

/** Undo for "send whole pack", whichever kind of pack it was. */
export async function removeWholePackFromDraft(transferId: string, packInput: string, conn: DbOrTx = db()): Promise<DraftCounts> {
  const packCode = parsePackCode(packInput);
  if (!packCode) throw new ValidationError("That is not a valid pack code");
  return conn.transaction(async (tx) => {
    const [row] = await tx
      .select({ id: packs.id, mode: itemTypes.trackingMode })
      .from(packs)
      .innerJoin(itemTypes, eq(itemTypes.id, packs.itemTypeId))
      .where(eq(packs.code, packCode));
    if (!row) throw new NotFoundError("Pack");
    if (row.mode === "QUANTITY") return removePackFromDraft(transferId, packCode, tx);

    const transfer = await lockTransfer(tx, transferId);
    assertStatus(transfer.status, ["DRAFT"], "remove items");
    const removed = await tx
      .delete(transferItems)
      .where(
        and(
          eq(transferItems.transferId, transfer.id),
          sql`${transferItems.unitId} in (select id from consumables.units where pack_id = ${row.id}::uuid)`,
        ),
      )
      .returning({ id: transferItems.id });
    if (removed.length === 0) throw new NotFoundError("Pack on this transfer");
    return draftCounts(tx, transfer.id);
  });
}

/** Undo for "send whole carton": takes its bottles, or its packs, back off the draft. */
export async function removeCartonFromDraft(transferId: string, cartonInput: string, conn: DbOrTx = db()): Promise<DraftCounts> {
  const cartonCode = parseCartonCode(cartonInput);
  if (!cartonCode) throw new ValidationError("That is not a valid carton code");
  return conn.transaction(async (tx) => {
    const [carton] = await tx
      .select({ id: cartons.id, mode: itemTypes.trackingMode })
      .from(cartons)
      .innerJoin(itemTypes, eq(itemTypes.id, cartons.itemTypeId))
      .where(eq(cartons.code, cartonCode));
    if (!carton) throw new NotFoundError("Carton");

    const transfer = await lockTransfer(tx, transferId);
    assertStatus(transfer.status, ["DRAFT"], "remove items");

    if (carton.mode === "SERIAL") {
      const removed = await tx
        .delete(transferItems)
        .where(
          and(
            eq(transferItems.transferId, transfer.id),
            sql`${transferItems.unitId} in (select id from consumables.units where carton_id = ${carton.id}::uuid)`,
          ),
        )
        .returning({ id: transferItems.id });
      if (removed.length === 0) throw new NotFoundError("Carton on this transfer");
      return draftCounts(tx, transfer.id);
    }

    const linked = await tx
      .select({ code: packs.code })
      .from(transferItemPacks)
      .innerJoin(packs, eq(packs.id, transferItemPacks.packId))
      .innerJoin(transferItems, eq(transferItems.id, transferItemPacks.transferItemId))
      .where(and(eq(packs.cartonId, carton.id), eq(transferItems.transferId, transfer.id)));
    if (linked.length === 0) throw new NotFoundError("Carton on this transfer");
    for (const p of linked) await removePackFromDraft(transfer.id, p.code, tx);
    return draftCounts(tx, transfer.id);
  });
}

/** One scanned carton on the dispatch screen. Counts are bottles, or packs for a bulk item. */
export interface DispatchCartonInfo {
  code: string;
  /** What the carton is made of, for the screen's wording. */
  contents: "bottles" | "packs";
  /** Everything the carton held. */
  total: number;
  /** Still here and free to go on this draft (not on another open transfer). */
  avail: number;
  /** Already on THIS draft. */
  onDraft: number;
  /** Packs with their own label in the carton. 0 means it can only be sent whole or bottle by bottle. */
  packLabels: number;
  /** Packs in the carton, and how many of them are completely on THIS draft. The carton is counted in packs. */
  packsTotal: number;
  packsOnDraft: number;
  /** True when nothing has left the carton, so it can go as a whole carton. */
  intact: boolean;
  /** How many dispatches have already taken part of this carton (its lettered parts so far). */
  partsSent: number;
}

export interface DispatchBatchInfo {
  batchCode: string;
  itemName: string;
  trackingMode: "SERIAL" | "QUANTITY";
  /**
   * How many of this batch could go on this draft from the sending store, counting the ones already
   * on it. For bottles: in stock here and not on another open transfer. For bulk: balance minus what
   * other drafts have promised.
   */
  available: number;
  /** Already on THIS draft, in whole units (packs for a pack item). 0 when this draft has the batch in pieces. */
  onDraft: number;
  /** Loose pieces of this batch already on THIS draft. */
  onDraftPieces: number;
  /** The item's unit of measure ("Pack", "Pieces"...). */
  unit: string;
  /** Pieces in one pack. 1 means pieces cannot be sent from this item. */
  packSize: number;
  /** Loose pieces of this batch held here and not promised to another draft (bulk only). */
  looseAvailable: number;
  /** Everything that could go as pieces: free sealed packs times pack size, plus free loose pieces (bulk only). */
  piecesAvailable: number;
  /** Parts of this batch that have already been dispatched (2 means the next one becomes part C). */
  partsSent: number;
  /** This batch's expiry date (YYYY-MM-DD), or null when it has none. */
  expiryDate: string | null;
  /**
   * Corrections C8: a batch of the same item that expires sooner and still has stock to send from here, or
   * null when this is the one to send first. Only a suggestion: nothing is blocked.
   */
  earlierBatch: EarlierBatch | null;
  /** The pack whose label was scanned (PK...), or null when the box label or a batch code was scanned. */
  pack: DispatchPackInfo | null;
  /**
   * True when this batch has pack or roll labels. Its whole packs are then sent by scanning each one, not by typing
   * a number. Stock received before pack labels existed has none, so it is still typed.
   */
  hasPackLabels: boolean;
  /** Cartons (CN...) this batch was received in. 0 for stock received without cartons. */
  cartonCount: number;
  /** Cartons of this batch that are completely on THIS draft. The batch is counted in cartons. */
  cartonsOnDraft: number;
  /** The carton whose label was scanned (CN...), or null when a box, pack or bottle was scanned. */
  carton: DispatchCartonInfo | null;
}

/** One scanned pack on the dispatch screen. `piecesLeft` already excludes what other open drafts have promised. */
export interface DispatchPackInfo {
  code: string;
  piecesPerPack: number;
  piecesRemaining: number;
  piecesLeft: number;
  /** True when the pack is sealed (nothing taken out), so it can go as a whole pack. */
  intact: boolean;
  /** True when the pack is already on a transfer that has not been received (this draft or another). */
  onTransfer: boolean;
  /** Bottles of this pack already on THIS draft (bottle packs only; 0 for bulk packs). */
  onDraft: number;
  /** How many dispatches have already taken part of this pack (its lettered parts so far). */
  partsSent: number;
}
export interface EarlierBatch {
  batchCode: string;
  expiryDate: string;
  /** How much of it could go on this draft from the sending location. */
  available: number;
}

/**
 * The batch of one item type, at the sending location, with the earliest expiry date that is earlier than the
 * scanned batch's (a batch with no expiry date counts as expiring last) and that still has stock. Expired
 * batches are ignored: they are blocked from dispatch anyway. Availability follows the same rules as the
 * scan itself: bottles in stock here and not on another open transfer; bulk balance minus other drafts.
 */
async function findEarlierBatch(
  conn: DbOrTx,
  args: {
    transferId: string;
    fromLocationId: string;
    itemTypeId: string;
    trackingMode: "SERIAL" | "QUANTITY";
    batchId: string;
    expiryDate: string | null;
    day: string;
  },
): Promise<EarlierBatch | null> {
  const { transferId, fromLocationId, itemTypeId, batchId, expiryDate, day } = args;
  if (args.trackingMode === "SERIAL") {
    const rows = await conn.execute<{ batch_code: string; expiry_date: string; available: number }>(sql`
      select b.code as batch_code,
             to_char(b.expiry_date, 'YYYY-MM-DD') as expiry_date,
             count(*)::int as available
      from consumables.units u
      join consumables.batches b on b.id = u.batch_id
      where u.current_location_id = ${fromLocationId}::uuid
        and u.state = 'IN_STOCK'
        and u.item_type_id = ${itemTypeId}::uuid
        and b.id <> ${batchId}::uuid
        and b.expiry_date is not null
        and b.expiry_date >= ${day}::date
        and (${expiryDate}::date is null or b.expiry_date < ${expiryDate}::date)
        and not exists (
          select 1 from consumables.transfer_items ti
          where ti.unit_id = u.id and ti.open and ti.transfer_id <> ${transferId}::uuid
        )
      group by b.id, b.code, b.expiry_date
      order by b.expiry_date asc, b.code asc
      limit 1
    `);
    const row = rows[0];
    return row ? { batchCode: row.batch_code, expiryDate: row.expiry_date, available: row.available } : null;
  }

  const rows = await conn.execute<{ batch_code: string; expiry_date: string; available: number }>(sql`
    select bal.batch_code,
           to_char(b.expiry_date, 'YYYY-MM-DD') as expiry_date,
           greatest(bal.on_hand - coalesce(res.reserved, 0), 0)::int as available
    from consumables.v_quantity_balance bal
    join consumables.batches b on b.id = bal.batch_id
    left join (
      select ti.batch_id, sum(case when ti.in_pieces then 0 else ti.quantity_dispatched end)::int as reserved
      from consumables.transfer_items ti
      join consumables.transfers t on t.id = ti.transfer_id
      where t.status = 'DRAFT'
        and t.from_location_id = ${fromLocationId}::uuid
        and t.id <> ${transferId}::uuid
        and ti.batch_id is not null
      group by ti.batch_id
    ) res on res.batch_id = bal.batch_id
    where bal.location_id = ${fromLocationId}::uuid
      and bal.item_type_id = ${itemTypeId}::uuid
      and b.id <> ${batchId}::uuid
      and b.expiry_date is not null
      and b.expiry_date >= ${day}::date
      and (${expiryDate}::date is null or b.expiry_date < ${expiryDate}::date)
      and bal.on_hand - coalesce(res.reserved, 0) > 0
    order by b.expiry_date asc, bal.batch_code asc
    limit 1
  `);
  const row = rows[0];
  return row ? { batchCode: row.batch_code, expiryDate: row.expiry_date, available: row.available } : null;
}

/**
 * What the dispatch screen shows after the store keeper scans a box's batch code, or the label on one pack or roll
 * (PK...), which stands for the batch it belongs to.
 */
export async function lookupBatchForDispatch(
  transferId: string,
  batchInput: string,
  conn: DbOrTx = db(),
): Promise<DispatchBatchInfo> {
  // A carton label stands for the batch it belongs to, like a pack label does.
  const cartonCode = parseCartonCode(batchInput);
  let scannedCarton: typeof cartons.$inferSelect | null = null;
  if (cartonCode) {
    const [row] = await conn
      .select({ carton: cartons, batchCode: batches.code })
      .from(cartons)
      .innerJoin(batches, eq(batches.id, cartons.batchId))
      .where(eq(cartons.code, cartonCode));
    if (!row) throw new NotFoundError("Carton");
    scannedCarton = row.carton;
    batchInput = row.batchCode;
  }
  const packCode = parsePackCode(batchInput);
  let scannedPack: typeof packs.$inferSelect | null = null;
  if (packCode) {
    const [row] = await conn
      .select({ pack: packs, batchCode: batches.code })
      .from(packs)
      .innerJoin(batches, eq(batches.id, packs.batchId))
      .where(eq(packs.code, packCode));
    if (!row) throw new NotFoundError("Pack");
    scannedPack = row.pack;
    batchInput = row.batchCode;
  }
  const code = normalizeCode(batchInput);
  if (!isValidBatchCode(code)) throw new ValidationError("That is not a valid batch code. Scan the box label");

  const [transfer] = await conn.select().from(transfers).where(eq(transfers.id, transferId));
  if (!transfer) throw new NotFoundError("Transfer");
  assertStatus(transfer.status, ["DRAFT"], "add items");

  const [batch] = await conn
    .select({
      id: batches.id,
      code: batches.code,
      expiryDate: batches.expiryDate,
      itemTypeId: batches.itemTypeId,
      itemName: itemTypes.name,
      trackingMode: itemTypes.trackingMode,
      unit: itemTypes.unitOfMeasure,
      packSize: itemTypes.packSize,
    })
    .from(batches)
    .innerJoin(itemTypes, eq(itemTypes.id, batches.itemTypeId))
    .where(eq(batches.code, code));
  if (!batch) throw new NotFoundError("Batch");

  const [parts] = await conn
    .select({ n: sql<number>`count(*)::int` })
    .from(transferBatchParts)
    .where(eq(transferBatchParts.batchId, batch.id));

  let available: number;
  let onDraft: number;
  let onDraftPieces = 0;
  let looseAvailable = 0;
  let piecesAvailable = 0;
  let hasPackLabels = false;
  if (batch.trackingMode === "SERIAL") {
    const [row] = await conn
      .select({ n: sql<number>`count(*)::int` })
      .from(units)
      .where(
        and(
          eq(units.batchId, batch.id),
          eq(units.state, "IN_STOCK"),
          eq(units.currentLocationId, transfer.fromLocationId),
          // Not promised to a different open transfer. Raw column names on purpose: inside the
          // subquery a bare "id" would resolve to the inner table.
          sql`not exists (select 1 from consumables.transfer_items ti where ti.unit_id = consumables.units.id and ti.open and ti.transfer_id <> ${transfer.id})`,
        ),
      );
    available = row?.n ?? 0;
    onDraft = await batchDraftCount(conn, transfer.id, batch.code);
  } else {
    const holding = await freeHolding(conn, batch.id, transfer.fromLocationId, transfer.id, batch.packSize);
    available = holding.free.sealed;
    looseAvailable = holding.free.loose;
    piecesAvailable = holding.free.sealed * batch.packSize + holding.free.loose;
    const [line] = await conn
      .select({ q: transferItems.quantityDispatched, inPieces: transferItems.inPieces })
      .from(transferItems)
      .where(and(eq(transferItems.transferId, transfer.id), eq(transferItems.batchId, batch.id)));
    onDraft = line && !line.inPieces ? line.q : 0;
    onDraftPieces = line?.inPieces ? line.q : 0;
  }

  // Pack labels and cartons exist for bottles as well as for bulk stock.
  const [labelled] = await conn.select({ n: sql<number>`count(*)::int` }).from(packs).where(eq(packs.batchId, batch.id));
  hasPackLabels = (labelled?.n ?? 0) > 0;
  const [cartonRow] = await conn.select({ n: sql<number>`count(*)::int` }).from(cartons).where(eq(cartons.batchId, batch.id));
  const cartonCount = cartonRow?.n ?? 0;
  const cartonsOnDraft = cartonCount > 0 ? await countCartonsOnDraft(conn, transfer, batch.id, batch.trackingMode) : 0;

  const earlierBatch = await findEarlierBatch(conn, {
    transferId: transfer.id,
    fromLocationId: transfer.fromLocationId,
    itemTypeId: batch.itemTypeId,
    trackingMode: batch.trackingMode,
    batchId: batch.id,
    expiryDate: batch.expiryDate,
    day: today(),
  });

  const [packPartRow] = scannedPack
    ? await conn
        .select({ n: sql<number>`count(*)::int` })
        .from(transferPackParts)
        .where(eq(transferPackParts.packId, scannedPack.id))
    : [];
  const packPartsSent = packPartRow?.n ?? 0;
  let pack: DispatchPackInfo | null = null;
  if (scannedPack && batch.trackingMode === "SERIAL") {
    // Bottles move on their own rows, so a pack of bottles is read from the bottles in it, not from the pack's location.
    const s = await bottleGroupStats(conn, transfer, { packId: scannedPack.id });
    pack = {
      code: scannedPack.code,
      piecesPerPack: s.total,
      piecesRemaining: s.here,
      piecesLeft: s.free,
      intact: s.total > 0 && s.here === s.total,
      onTransfer: s.free < s.here || (s.total > 0 && s.onDraft === s.total),
      onDraft: s.onDraft,
      partsSent: packPartsSent,
    };
  } else if (scannedPack && scannedPack.locationId === transfer.fromLocationId) {
    // A pack that is not at the sending location selects its batch like a box label does, and no pack is named on
    // the draft line. Pack rows follow whole-pack transfers that were scanned pack by pack; older ones did not.
    const promised = await piecesPromisedFromPack(conn, scannedPack.id, transfer.id);
    const [openLink] = await conn
      .select({ id: transferItemPacks.id })
      .from(transferItemPacks)
      .where(and(eq(transferItemPacks.packId, scannedPack.id), eq(transferItemPacks.open, true)));
    pack = {
      code: scannedPack.code,
      piecesPerPack: scannedPack.piecesPerPack,
      piecesRemaining: scannedPack.piecesRemaining,
      piecesLeft: Math.max(0, scannedPack.piecesRemaining - promised),
      intact: scannedPack.piecesRemaining === scannedPack.piecesPerPack,
      onTransfer: Boolean(openLink),
      onDraft: 0,
      partsSent: packPartsSent,
    };
  }

  const carton = scannedCarton ? await buildCartonInfo(conn, transfer, scannedCarton, batch.trackingMode) : null;

  return {
    batchCode: batch.code,
    itemName: batch.itemName,
    trackingMode: batch.trackingMode,
    available,
    onDraft,
    onDraftPieces,
    unit: batch.unit,
    packSize: batch.packSize,
    looseAvailable,
    piecesAvailable,
    partsSent: parts?.n ?? 0,
    expiryDate: batch.expiryDate,
    earlierBatch,
    pack,
    hasPackLabels,
    cartonCount,
    cartonsOnDraft,
    carton,
  };
}

/** Takes one line off a draft (also the "undo last scan" of the dispatch screen). */
export async function removeTransferItem(transferId: string, itemId: string, conn: DbOrTx = db()): Promise<DraftCounts> {
  return conn.transaction(async (tx) => {
    const transfer = await lockTransfer(tx, transferId);
    assertStatus(transfer.status, ["DRAFT"], "remove items");
    const removed = await tx
      .delete(transferItems)
      .where(and(eq(transferItems.id, itemId), eq(transferItems.transferId, transfer.id)))
      .returning({ id: transferItems.id });
    if (removed.length === 0) throw new NotFoundError("Item on this transfer");
    return draftCounts(tx, transfer.id);
  });
}

/**
 * Takes every bottle line, or every bulk line, off a draft in one go ("Remove all" on the transfer page).
 * Pack links on bulk lines go with them (the foreign key cascades). Returns how many lines were removed.
 */
export async function removeAllTransferItems(
  transferId: string,
  scope: "bottles" | "bulk",
  conn: DbOrTx = db(),
): Promise<number> {
  return conn.transaction(async (tx) => {
    const transfer = await lockTransfer(tx, transferId);
    assertStatus(transfer.status, ["DRAFT"], "remove items");
    const kind = scope === "bottles" ? sql`${transferItems.unitId} is not null` : sql`${transferItems.batchId} is not null`;
    const removed = await tx
      .delete(transferItems)
      .where(and(eq(transferItems.transferId, transfer.id), kind))
      .returning({ id: transferItems.id });
    return removed.length;
  });
}

// --- confirm (dispatch) ---------------------------------------------------------

/**
 * Refuses the dispatch when the destination's service role is not one an item type on the transfer may be
 * sent to (corrections C2). Checked at confirm because that is when stock actually moves.
 */
async function assertDestinationAcceptsItems(
  tx: Tx,
  toLocationId: string,
  unitItems: readonly { unitId: string | null }[],
  quantityItems: readonly { batchId: string | null }[],
): Promise<void> {
  const [destination] = await tx
    .select({ name: locations.name, serviceRole: locations.serviceRole })
    .from(locations)
    .where(eq(locations.id, toLocationId));
  if (!destination) throw new NotFoundError("Destination");
  if (destination.serviceRole === null) return; // no restriction on where this location sits

  const itemTypeIds = new Set<string>();
  for (const part of chunks(unitItems.map((i) => i.unitId as string))) {
    const rows = await tx.select({ id: units.itemTypeId }).from(units).where(inArray(units.id, part));
    for (const row of rows) itemTypeIds.add(row.id);
  }
  for (const part of chunks(quantityItems.map((i) => i.batchId as string))) {
    const rows = await tx.select({ id: batches.itemTypeId }).from(batches).where(inArray(batches.id, part));
    for (const row of rows) itemTypeIds.add(row.id);
  }
  if (itemTypeIds.size === 0) return;

  const types = await tx
    .select({ name: itemTypes.name, allowedServiceRoles: itemTypes.allowedServiceRoles })
    .from(itemTypes)
    .where(inArray(itemTypes.id, [...itemTypeIds]))
    .orderBy(asc(itemTypes.name));
  for (const type of types) assertServiceRoleAllowed(type, destination);
}

/**
 * Confirms a draft: every SERIAL unit goes IN_TRANSIT and every item writes a DISPATCHED event, all
 * in one transaction. Items are re-validated here because a draft can sit for a while.
 */
export async function confirmTransfer(
  transferId: string,
  userId: string,
  rawInput: ConfirmTransferInput,
  conn: DbOrTx = db(),
) {
  const parsed = confirmTransferSchema.safeParse(rawInput);
  if (!parsed.success) throw new ValidationError(parsed.error.issues.map((i) => i.message).join("; "));
  const input = parsed.data;

  return conn.transaction(async (tx) => {
    const transfer = await lockTransfer(tx, transferId);
    assertStatus(transfer.status, ["DRAFT"], "confirm");

    const items = await tx.select().from(transferItems).where(eq(transferItems.transferId, transfer.id));
    if (items.length === 0) throw new ValidationError("Add at least one item before confirming");

    // A transfer linked to a request may not send more than the request approved. Checked first, with
    // the request locked, so a second transfer confirming at the same time waits and then sees this one.
    await assertTransferWithinRequest(tx, transfer);

    const unitItems = items.filter((i) => i.unitId !== null);
    const quantityItems = items.filter((i) => i.batchId !== null);
    const packItems = quantityItems.filter((i) => !i.inPieces);
    const pieceItems = quantityItems.filter((i) => i.inPieces);
    await assertDestinationAcceptsItems(tx, transfer.toLocationId, unitItems, quantityItems);
    const now = new Date();
    const day = today();

    // SERIAL: lock and re-check every unit.
    const unitRows: {
      id: string;
      serial: string;
      state: (typeof units.$inferSelect)["state"];
      locationId: string;
      transferId: string | null;
      batchId: string;
      expiryDate: string | null;
    }[] = [];
    for (const part of chunks(unitItems.map((i) => i.unitId as string))) {
      // Lock in id order first (no deadlocks), then read with the join.
      await tx.select({ id: units.id }).from(units).where(inArray(units.id, part)).orderBy(asc(units.id)).for("update");
      const rows = await tx
        .select({
          id: units.id,
          serial: units.serial,
          state: units.state,
          locationId: units.currentLocationId,
          transferId: units.currentTransferId,
          batchId: units.batchId,
          expiryDate: batches.expiryDate,
        })
        .from(units)
        .innerJoin(batches, eq(batches.id, units.batchId))
        .where(inArray(units.id, part))
        .orderBy(asc(units.id));
      unitRows.push(...rows);
    }
    for (const unit of unitRows) assertCanDispatchUnit(unit, transfer.fromLocationId, day);

    // Lock every batch on the transfer in a fixed order (no deadlocks): bulk batches for the balance
    // re-check, and bottle batches too, so two dispatches from one box cannot both take the same part
    // letter. Locks go units first, then batches, the same order everywhere.
    const batchIds = [
      ...new Set([...quantityItems.map((i) => i.batchId as string), ...unitRows.map((u) => u.batchId)]),
    ].sort();
    const batchRows = batchIds.length
      ? await tx
          .select({ id: batches.id, code: batches.code, expiryDate: batches.expiryDate })
          .from(batches)
          .where(inArray(batches.id, batchIds))
          .orderBy(asc(batches.id))
          .for("update")
      : [];
    const batchById = new Map(batchRows.map((b) => [b.id, b]));
    // QUANTITY: re-check the balance. Whole packs are checked against the sealed packs left after other drafts;
    // loose pieces against sealed packs plus loose pieces left after other drafts. For each pieces line, `openPlans`
    // keeps how many sealed packs have to be opened, worked out from what the location really holds.
    const packSizes = await batchPackSizes(tx, quantityItems.map((i) => i.batchId as string));
    const openPlans = new Map<string, { opened: number; packSize: number }>();
    for (const item of quantityItems) {
      const batch = batchById.get(item.batchId as string);
      if (!batch) throw new NotFoundError("Batch");
      const packSize = packSizes.get(batch.id) ?? 1;
      const holding = await freeHolding(tx, batch.id, transfer.fromLocationId, transfer.id, packSize);
      if (item.inPieces) {
        assertCanDispatchPieces({
          pieces: item.quantityDispatched,
          sealed: holding.free.sealed,
          loose: holding.free.loose,
          packSize,
          expiryDate: batch.expiryDate,
          today: day,
        });
        const plan = planPieceDispatch({
          sealed: holding.sealed,
          loose: holding.loose,
          packSize,
          pieces: item.quantityDispatched,
        });
        if ("error" in plan) throw new ValidationError(plan.error);
        openPlans.set(item.id, { opened: plan.opened, packSize });
      } else {
        assertCanDispatchQuantity({
          quantity: item.quantityDispatched,
          available: holding.free.sealed,
          expiryDate: batch.expiryDate,
          today: day,
        });
      }
    }

    const total = unitItems.length + packItems.reduce((n, i) => n + i.quantityDispatched, 0);
    const pieceTotal = pieceItems.reduce((n, i) => n + i.quantityDispatched, 0);

    // Pieces taken from a scanned pack lower that pack's pieces_remaining. Locked in pack order (no deadlocks) and
    // re-checked here, because the draft only recorded intent. The ledger still carries the movement itself.
    const packCodeByItem = new Map<string, string>();
    const packLines = pieceItems
      .filter((i) => i.packId !== null)
      .sort((a, b) => (a.packId as string).localeCompare(b.packId as string));
    for (const line of packLines) {
      const [pack] = await tx.select().from(packs).where(eq(packs.id, line.packId as string)).for("update");
      if (!pack) throw new NotFoundError("Pack");
      if (pack.locationId !== transfer.fromLocationId) {
        throw new ValidationError(`Pack ${pack.code} is not in the sending store. Remove that line and add it again`);
      }
      if (pack.piecesRemaining < line.quantityDispatched) {
        throw new ValidationError(
          `Pack ${pack.code} now has only ${pack.piecesRemaining} ${pack.piecesRemaining === 1 ? "piece" : "pieces"} left. Change the quantity and confirm again`,
        );
      }
      await tx
        .update(packs)
        .set({ piecesRemaining: pack.piecesRemaining - line.quantityDispatched })
        .where(eq(packs.id, pack.id));
      packCodeByItem.set(line.id, pack.code);
    }

    // Whole packs that were scanned one by one: locked in pack order, and re-checked because the draft only recorded
    // intent. They stay at the sending store until the receiving store scans them in. A line may hold fewer scanned
    // packs than its quantity (the rest were typed); those are not tied to a label.
    const wholePackCodesByItem = new Map<string, string[]>();
    const wholePackItemIds = packItems.map((i) => i.id);
    const wholePackLinks: { itemId: string; packId: string; code: string }[] = [];
    for (const part of chunks(wholePackItemIds)) {
      const links = await tx
        .select({ itemId: transferItemPacks.transferItemId, packId: transferItemPacks.packId })
        .from(transferItemPacks)
        .where(inArray(transferItemPacks.transferItemId, part));
      if (links.length === 0) continue;
      const packRows = await tx
        .select()
        .from(packs)
        .where(inArray(packs.id, links.map((l) => l.packId)))
        .orderBy(asc(packs.id))
        .for("update");
      const byId = new Map(packRows.map((p) => [p.id, p]));
      for (const link of links) {
        const pack = byId.get(link.packId);
        if (!pack) throw new NotFoundError("Pack");
        if (pack.locationId !== transfer.fromLocationId) {
          throw new ValidationError(`Pack ${pack.code} is not in the sending store. Undo its scan and scan it again`);
        }
        if (pack.piecesRemaining < pack.piecesPerPack) {
          throw new ValidationError(
            `Pack ${pack.code} was opened after it was scanned (${pack.piecesRemaining} of ${pack.piecesPerPack} pieces left). Undo its scan and send pieces instead`,
          );
        }
        wholePackLinks.push({ ...link, code: pack.code });
      }
    }
    for (const link of wholePackLinks) {
      const list = wholePackCodesByItem.get(link.itemId) ?? [];
      list.push(link.code);
      wholePackCodesByItem.set(link.itemId, list);
    }
    // Move the units.
    const step = transition("IN_STOCK", "DISPATCH");
    for (const part of chunks(unitRows.map((u) => u.id))) {
      await tx
        .update(units)
        .set({ state: step.to, currentTransferId: transfer.id })
        .where(inArray(units.id, part));
    }

    // One DISPATCHED event per unit and per quantity line.
    const base = {
      locationId: transfer.fromLocationId,
      userId,
      transferId: transfer.id,
      type: step.event,
      occurredAt: now,
      payload: { transferCode: transfer.code, toLocationId: transfer.toLocationId },
    };
    const rows: NewEvent[] = [
      ...unitRows.map((u) => ({
        ...base,
        id: randomUUID(),
        unitId: u.id,
        batchId: u.batchId,
        quantity: 1,
        fromState: "IN_STOCK" as const,
        toState: step.to,
      })),
      ...quantityItems.flatMap((i): NewEvent[] => {
        const batchId = i.batchId as string;
        if (!i.inPieces) {
          const packCodes = wholePackCodesByItem.get(i.id);
          return [
            {
              ...base,
              id: randomUUID(),
              batchId,
              quantity: i.quantityDispatched,
              ...(packCodes?.length ? { payload: { ...base.payload, packCodes: [...packCodes].sort() } } : {}),
            },
          ];
        }
        // Pieces: open the sealed packs that are needed (they leave the sealed balance and join the loose
        // pieces), then send the pieces. The dispatch itself moves no whole packs, so its quantity is 0.
        const plan = openPlans.get(i.id);
        const out: NewEvent[] = [];
        if (plan && plan.opened > 0) {
          out.push({
            ...base,
            id: randomUUID(),
            batchId,
            quantity: plan.opened,
            pieces: plan.opened * plan.packSize,
            type: "OPENED",
            payload: { ...base.payload, reason: "OPENED_FOR_PIECES" },
          });
        }
        const packCode = packCodeByItem.get(i.id);
        out.push({
          ...base,
          id: randomUUID(),
          batchId,
          quantity: 0,
          pieces: i.quantityDispatched,
          ...(packCode ? { payload: { ...base.payload, packCode } } : {}),
        });
        return out;
      }),
    ];
    await appendEvents(tx, rows);

    // Part letters: each batch on this transfer becomes its next lettered part (A, B, C ...). The batch
    // rows are locked above, so counting the existing parts is safe.
    const parts: DispatchedPart[] = [];
    for (const batch of batchRows) {
      const [existingParts] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(transferBatchParts)
        .where(eq(transferBatchParts.batchId, batch.id));
      const letter = partLetter((existingParts?.n ?? 0) + 1);
      await tx.insert(transferBatchParts).values({ batchId: batch.id, transferId: transfer.id, partLetter: letter });
      parts.push({ batchCode: batch.code, letter });
    }

    // Cartons and packs that this transfer only partly takes get their own lettered part the same way (a carton split
    // by packs, a pack split by bottles). One that goes whole has no part: the level above it carries the letter.
    const split = await splitContainers(tx, transfer.id);
    const containerParts: DispatchedContainerPart[] = [];
    if (split.cartonIds.length > 0) {
      // Lock in id order first (no deadlocks), so two dispatches cannot hand out the same letter.
      const cartonRows = await tx
        .select({ id: cartons.id, code: cartons.code })
        .from(cartons)
        .where(inArray(cartons.id, split.cartonIds))
        .orderBy(asc(cartons.id))
        .for("update");
      for (const carton of cartonRows) {
        const [existing] = await tx
          .select({ n: sql<number>`count(*)::int` })
          .from(transferCartonParts)
          .where(eq(transferCartonParts.cartonId, carton.id));
        const letter = partLetter((existing?.n ?? 0) + 1);
        await tx.insert(transferCartonParts).values({ cartonId: carton.id, transferId: transfer.id, partLetter: letter });
        containerParts.push({ level: "carton", code: carton.code, letter });
      }
    }
    if (split.packIds.length > 0) {
      const packRows = await tx
        .select({ id: packs.id, code: packs.code })
        .from(packs)
        .where(inArray(packs.id, split.packIds))
        .orderBy(asc(packs.id))
        .for("update");
      for (const pack of packRows) {
        const [existing] = await tx
          .select({ n: sql<number>`count(*)::int` })
          .from(transferPackParts)
          .where(eq(transferPackParts.packId, pack.id));
        const letter = partLetter((existing?.n ?? 0) + 1);
        await tx.insert(transferPackParts).values({ packId: pack.id, transferId: transfer.id, partLetter: letter });
        containerParts.push({ level: "pack", code: pack.code, letter });
      }
    }

    const [updated] = await tx
      .update(transfers)
      .set({
        status: "DISPATCHED",
        dispatchedBy: userId,
        dispatchedAt: now,
        carriedByName: input.carriedByName,
      })
      .where(eq(transfers.id, transfer.id))
      .returning();
    if (transfer.requestId) await syncRequestFromTransfers(tx, transfer.requestId);
    return { transfer: updated, total, pieceTotal, parts, containerParts };
  });
}

/** A batch's lettered part on a transfer, for example { batchCode: "BT7K2M9QXR4", letter: "B" }. */
export interface DispatchedPart {
  batchCode: string;
  letter: string;
}

/** A carton's or pack's lettered part on a transfer, for example { level: "pack", code: "PK15NT6SJMT", letter: "A" }. */
export interface DispatchedContainerPart {
  level: "carton" | "pack";
  code: string;
  letter: string;
}

/**
 * The names most recently typed as carrier, newest first, for suggestions in the dispatch confirm step
 * (saves typing). Names that differ only by letter case count once.
 */
export async function listRecentCarriers(limit = 8, conn: DbOrTx = db()): Promise<string[]> {
  const rows = await conn
    .select({ name: transfers.carriedByName, at: transfers.dispatchedAt })
    .from(transfers)
    .where(sql`${transfers.carriedByName} is not null`)
    .orderBy(desc(transfers.dispatchedAt))
    .limit(limit * 6);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const row of rows) {
    const name = row.name?.trim();
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    out.push(name);
    if (out.length >= limit) break;
  }
  return out;
}

// --- reads -------------------------------------------------------------------------

export interface TransferListRow {
  id: string;
  code: string;
  status: TransferStatus;
  fromName: string;
  toName: string;
  createdAt: Date;
  dispatchedAt: Date | null;
  /** When the receipt was closed; null while the transfer is still waiting or being received. */
  receivedAt: Date | null;
  serialCount: number;
  /** Whole units of bulk items (packs for a pack item), without lines counted in loose pieces. */
  quantityTotal: number;
  /** Loose pieces on the transfer. */
  pieceTotal: number;
}

export async function listTransfers(
  options: { statuses?: readonly TransferStatus[]; toLocationId?: string; limit?: number; offset?: number } = {},
  conn: DbOrTx = db(),
): Promise<TransferListRow[]> {
  const conditions = [];
  if (options.statuses?.length) conditions.push(inArray(transfers.status, [...options.statuses]));
  if (options.toLocationId) conditions.push(eq(transfers.toLocationId, options.toLocationId));

  const rows = await conn
    .select()
    .from(transfers)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(transfers.createdAt), desc(transfers.id))
    .limit(options.limit ?? 50)
    .offset(options.offset ?? 0);
  if (rows.length === 0) return [];

  const names = await locationNames(conn, rows.flatMap((r) => [r.fromLocationId, r.toLocationId]));
  const counts = await conn
    .select({
      transferId: transferItems.transferId,
      serialCount: sql<number>`count(*) filter (where ${transferItems.unitId} is not null)::int`,
      quantityTotal: sql<number>`coalesce(sum(${transferItems.quantityDispatched}) filter (where ${transferItems.batchId} is not null and not ${transferItems.inPieces}), 0)::int`,
      pieceTotal: sql<number>`coalesce(sum(${transferItems.quantityDispatched}) filter (where ${transferItems.batchId} is not null and ${transferItems.inPieces}), 0)::int`,
    })
    .from(transferItems)
    .where(inArray(transferItems.transferId, rows.map((r) => r.id)))
    .groupBy(transferItems.transferId);
  const countById = new Map(counts.map((c) => [c.transferId, c]));

  return rows.map((r) => ({
    id: r.id,
    code: r.code,
    status: r.status,
    fromName: names.get(r.fromLocationId) ?? "?",
    toName: names.get(r.toLocationId) ?? "?",
    createdAt: r.createdAt,
    dispatchedAt: r.dispatchedAt,
    receivedAt: r.receiptClosedAt,
    serialCount: countById.get(r.id)?.serialCount ?? 0,
    quantityTotal: countById.get(r.id)?.quantityTotal ?? 0,
    pieceTotal: countById.get(r.id)?.pieceTotal ?? 0,
  }));
}

/** One page (20 rows) of transfers, newest first, plus the total that match so the pager and tab counts are right. */
export async function listTransfersPage(
  options: { statuses?: readonly TransferStatus[]; toLocationId?: string },
  page: number,
  conn: DbOrTx = db(),
): Promise<Paged<TransferListRow>> {
  const conditions = [];
  if (options.statuses?.length) conditions.push(inArray(transfers.status, [...options.statuses]));
  if (options.toLocationId) conditions.push(eq(transfers.toLocationId, options.toLocationId));
  const [{ total }] = await conn
    .select({ total: sql<number>`count(*)::int` })
    .from(transfers)
    .where(conditions.length ? and(...conditions) : undefined);
  const info = pageInfo(page, total);
  const rows = await listTransfers({ ...options, limit: info.pageSize, offset: info.offset }, conn);
  return { ...info, rows };
}

async function locationNames(conn: DbOrTx, ids: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();
  const rows = await conn.select({ id: locations.id, name: locations.name }).from(locations).where(inArray(locations.id, unique));
  return new Map(rows.map((r) => [r.id, r.name]));
}

async function userNames(conn: DbOrTx, ids: (string | null)[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((id): id is string => Boolean(id)))];
  if (unique.length === 0) return new Map();
  const rows = await conn.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, unique));
  return new Map(rows.map((r) => [r.id, r.name]));
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Everything a transfer page, slip or API response needs. `ref` is a transfer code or its id. */
export async function getTransferDetail(ref: string, conn: DbOrTx = db()) {
  const code = parseTransferCode(ref);
  const where = code ? eq(transfers.code, code) : UUID.test(ref) ? eq(transfers.id, ref) : null;
  if (!where) return null;
  const [t] = await conn.select().from(transfers).where(where);
  if (!t) return null;

  const [locs, people] = await Promise.all([
    locationNames(conn, [t.fromLocationId, t.toLocationId]),
    userNames(conn, [t.createdBy, t.dispatchedBy, t.receiptStartedBy, t.receiptClosedBy]),
  ]);

  // The stock request this transfer was made for, if any, so the page can link back to it.
  let requestCode: string | null = null;
  if (t.requestId) {
    const [req] = await conn.select({ code: stockRequests.code }).from(stockRequests).where(eq(stockRequests.id, t.requestId));
    requestCode = req?.code ?? null;
  }

  const serialItems = await conn
    .select({
      itemId: transferItems.id,
      serial: units.serial,
      itemName: itemTypes.name,
      unitState: units.state,
      received: sql<boolean>`${transferItems.receivedAt} is not null`,
      receivedAt: transferItems.receivedAt,
      missing: transferItems.quantityMissing,
      found: transferItems.quantityFound,
      writtenOff: transferItems.quantityWrittenOff,
      resolution: transferItems.resolution,
      resolutionNote: transferItems.resolutionNote,
    })
    .from(transferItems)
    .innerJoin(units, eq(units.id, transferItems.unitId))
    .innerJoin(itemTypes, eq(itemTypes.id, units.itemTypeId))
    .where(eq(transferItems.transferId, t.id))
    .orderBy(asc(units.serial));

  const quantityItems = await conn
    .select({
      itemId: transferItems.id,
      batchCode: batches.code,
      itemName: itemTypes.name,
      // True when dispatched, received, missing, found and written off below are loose pieces.
      inPieces: transferItems.inPieces,
      // Unit and pack size, for showing piece equivalents beside pack quantities. Display only.
      unit: itemTypes.unitOfMeasure,
      packSize: itemTypes.packSize,
      packSizeConfirmed: itemTypes.packSizeConfirmed,
      // Shows a "Keep cold" tag. Display only.
      coldStorage: itemTypes.coldStorage,
      dispatched: transferItems.quantityDispatched,
      received: transferItems.quantityReceived,
      missing: transferItems.quantityMissing,
      found: transferItems.quantityFound,
      writtenOff: transferItems.quantityWrittenOff,
      resolution: transferItems.resolution,
      resolutionNote: transferItems.resolutionNote,
    })
    .from(transferItems)
    .innerJoin(batches, eq(batches.id, transferItems.batchId))
    .innerJoin(itemTypes, eq(itemTypes.id, batches.itemTypeId))
    .where(eq(transferItems.transferId, t.id))
    .orderBy(asc(batches.code));

  const parts = await conn
    .select({ batchCode: batches.code, letter: transferBatchParts.partLetter, itemName: itemTypes.name })
    .from(transferBatchParts)
    .innerJoin(batches, eq(batches.id, transferBatchParts.batchId))
    .innerJoin(itemTypes, eq(itemTypes.id, batches.itemTypeId))
    .where(eq(transferBatchParts.transferId, t.id))
    .orderBy(asc(batches.code));

  // Cartons and packs this transfer split, each with its lettered part. Codes and letters only, never a quantity.
  const cartonPartRows = await conn
    .select({ code: cartons.code, letter: transferCartonParts.partLetter })
    .from(transferCartonParts)
    .innerJoin(cartons, eq(cartons.id, transferCartonParts.cartonId))
    .where(eq(transferCartonParts.transferId, t.id))
    .orderBy(asc(cartons.code));
  const packPartRows = await conn
    .select({ code: packs.code, letter: transferPackParts.partLetter })
    .from(transferPackParts)
    .innerJoin(packs, eq(packs.id, transferPackParts.packId))
    .where(eq(transferPackParts.transferId, t.id))
    .orderBy(asc(packs.code));
  const containerParts: DispatchedContainerPart[] = [
    ...cartonPartRows.map((p) => ({ level: "carton" as const, code: p.code, letter: p.letter })),
    ...packPartRows.map((p) => ({ level: "pack" as const, code: p.code, letter: p.letter })),
  ];

  const quantityTotal = quantityItems.filter((i) => !i.inPieces).reduce((n, i) => n + i.dispatched, 0);
  const pieceTotal = quantityItems.filter((i) => i.inPieces).reduce((n, i) => n + i.dispatched, 0);
  return {
    transfer: t,
    requestCode,
    fromName: locs.get(t.fromLocationId) ?? "?",
    toName: locs.get(t.toLocationId) ?? "?",
    createdByName: people.get(t.createdBy) ?? "?",
    dispatchedByName: t.dispatchedBy ? (people.get(t.dispatchedBy) ?? "?") : null,
    receiptStartedByName: t.receiptStartedBy ? (people.get(t.receiptStartedBy) ?? "?") : null,
    receiptClosedByName: t.receiptClosedBy ? (people.get(t.receiptClosedBy) ?? "?") : null,
    serialItems,
    quantityItems,
    /** Lettered parts of each batch on this transfer. Empty while the transfer is still a draft. */
    parts,
    /** Lettered parts of the cartons (split by packs) and packs (split by bottles) on this transfer. Empty on a draft. */
    containerParts,
    totals: {
      serialCount: serialItems.length,
      serialReceived: serialItems.filter((i) => i.received).length,
      quantityTotal,
      /** Loose pieces on the transfer, kept apart from `quantityTotal` (packs). */
      pieceTotal,
      all: serialItems.length + quantityTotal,
    },
  };
}

export type TransferDetail = NonNullable<Awaited<ReturnType<typeof getTransferDetail>>>;

/**
 * What a transfer holds, said in the biggest whole unit that is on it. A container counts as whole when everything in
 * it is on the transfer (every bottle for bottle stock, every pack for bulk stock). Each level counts only what the
 * level above did not already cover, so a whole delivery is one delivery and not its batches, cartons and packs too:
 * delivery > batch (box) > carton > pack > bottle. `bulkPacks` is how many whole bulk packs are on the transfer, so the
 * caller can tell them apart from bulk quantity that has no pack labels.
 */
export interface TransferContents {
  deliveries: number;
  batches: number;
  cartons: number;
  packs: number;
  /** Bottles that are not part of a whole pack, carton, batch or delivery. */
  bottles: number;
  bulkPacks: number;
}

/**
 * The shared first half of the container queries: which bottles and bulk packs are on the transfer, and which packs,
 * cartons, batches and deliveries are WHOLE on it (everything in them is on it). Followed by a select by the caller.
 * Whole bottle packs, cartons and batches are judged on every bottle that was ever in them, so one that already lost
 * bottles on an earlier transfer is never whole.
 */
function wholeContainersCte(transferId: string) {
  return sql`
    with sent_units as (
      select u.id, u.pack_id, u.carton_id, u.batch_id
      from consumables.transfer_items ti
      join consumables.units u on u.id = ti.unit_id
      where ti.transfer_id = ${transferId}::uuid
    ),
    sent_packs as (
      select p.id, p.carton_id, p.batch_id
      from consumables.transfer_item_packs tip
      join consumables.transfer_items ti on ti.id = tip.transfer_item_id
      join consumables.packs p on p.id = tip.pack_id
      where ti.transfer_id = ${transferId}::uuid and not ti.in_pieces
    ),
    whole_packs as (
      select u.pack_id as id
      from consumables.units u
      where u.pack_id in (select pack_id from sent_units where pack_id is not null)
      group by u.pack_id
      having count(*) = (select count(*) from sent_units s where s.pack_id = u.pack_id)
      union
      select id from sent_packs
    ),
    pack_rows as (
      select p.id, p.carton_id, p.batch_id from consumables.packs p where p.id in (select id from whole_packs)
    ),
    whole_cartons as (
      select u.carton_id as id
      from consumables.units u
      where u.carton_id in (select carton_id from sent_units where carton_id is not null)
      group by u.carton_id
      having count(*) = (select count(*) from sent_units s where s.carton_id = u.carton_id)
      union
      select p.carton_id as id
      from consumables.packs p
      where p.carton_id in (select carton_id from sent_packs where carton_id is not null)
      group by p.carton_id
      having count(*) = (select count(*) from sent_packs s where s.carton_id = p.carton_id)
    ),
    carton_rows as (
      select c.id, c.batch_id from consumables.cartons c where c.id in (select id from whole_cartons)
    ),
    whole_batches as (
      select u.batch_id as id
      from consumables.units u
      where u.batch_id in (select batch_id from sent_units)
      group by u.batch_id
      having count(*) = (select count(*) from sent_units s where s.batch_id = u.batch_id)
      union
      select p.batch_id as id
      from consumables.packs p
      where p.batch_id in (select batch_id from sent_packs)
      group by p.batch_id
      having count(*) = (select count(*) from sent_packs s where s.batch_id = p.batch_id)
    ),
    batch_rows as (
      select b.id, b.delivery_id from consumables.batches b where b.id in (select id from whole_batches)
    ),
    whole_deliveries as (
      select b.delivery_id as id
      from consumables.batches b
      where b.delivery_id in (select delivery_id from batch_rows where delivery_id is not null)
      group by b.delivery_id
      having bool_and(b.id in (select id from whole_batches))
    )
  `;
}

export async function describeTransferContents(transferId: string, conn: DbOrTx = db()): Promise<TransferContents> {
  const rows = await conn.execute<{
    deliveries: number;
    batches: number;
    cartons: number;
    packs: number;
    bottles: number;
    bulk_packs: number;
  }>(sql`
    ${wholeContainersCte(transferId)}
    select
      (select count(*) from whole_deliveries)::int as deliveries,
      (select count(*) from batch_rows br
        where br.delivery_id is null or br.delivery_id not in (select id from whole_deliveries))::int as batches,
      (select count(*) from carton_rows cr
        where cr.batch_id not in (select id from whole_batches))::int as cartons,
      (select count(*) from pack_rows pr
        where (pr.carton_id is null or pr.carton_id not in (select id from whole_cartons))
          and pr.batch_id not in (select id from whole_batches))::int as packs,
      (select count(*) from sent_units su
        where (su.pack_id is null or su.pack_id not in (select id from whole_packs))
          and (su.carton_id is null or su.carton_id not in (select id from whole_cartons))
          and su.batch_id not in (select id from whole_batches))::int as bottles,
      (select count(*) from sent_packs)::int as bulk_packs
  `);
  const r = rows[0];
  return {
    deliveries: r?.deliveries ?? 0,
    batches: r?.batches ?? 0,
    cartons: r?.cartons ?? 0,
    packs: r?.packs ?? 0,
    bottles: r?.bottles ?? 0,
    bulkPacks: r?.bulk_packs ?? 0,
  };
}

/**
 * The cartons and packs a transfer takes only PART of: the ones that get a lettered part when it is dispatched.
 * A pack is split when some of its bottles (or some loose pieces) go but not all of it. A carton is split when
 * something in it goes but it is not whole on the transfer. Whole ones carry no part of their own.
 */
async function splitContainers(conn: DbOrTx, transferId: string): Promise<{ cartonIds: string[]; packIds: string[] }> {
  const rows = await conn.execute<{ kind: string; id: string }>(sql`
    ${wholeContainersCte(transferId)},
    split_packs as (
      select u.pack_id as id
      from consumables.units u
      where u.pack_id in (select pack_id from sent_units where pack_id is not null)
      group by u.pack_id
      having count(*) > (select count(*) from sent_units s where s.pack_id = u.pack_id)
      union
      select ti.pack_id as id
      from consumables.transfer_items ti
      where ti.transfer_id = ${transferId}::uuid and ti.in_pieces and ti.pack_id is not null
    ),
    touched_cartons as (
      select carton_id as id from sent_units where carton_id is not null
      union
      select carton_id as id from sent_packs where carton_id is not null
      union
      select p.carton_id as id
      from consumables.packs p
      where p.id in (select id from split_packs) and p.carton_id is not null
    )
    select 'pack' as kind, id from split_packs
    union all
    select 'carton' as kind, id from touched_cartons where id not in (select id from whole_cartons)
  `);
  const cartonIds: string[] = [];
  const packIds: string[] = [];
  for (const r of rows) (r.kind === "pack" ? packIds : cartonIds).push(r.id);
  return { cartonIds, packIds };
}

export interface BatchPartRow {
  letter: string;
  transferCode: string;
  toName: string;
  status: TransferStatus;
  dispatchedAt: Date | null;
  /** Bottles (or bulk quantity) of this batch that went in this part. In loose pieces when `inPieces`. */
  quantity: number;
  inPieces: boolean;
}

/** Where each piece of a batch went: its parts in dispatch order (A, B, C ...). */
export async function getBatchParts(batchCodeInput: string, conn: DbOrTx = db()): Promise<BatchPartRow[]> {
  const code = normalizeCode(batchCodeInput);
  if (!isValidBatchCode(code)) return [];
  const [batch] = await conn.select({ id: batches.id }).from(batches).where(eq(batches.code, code));
  if (!batch) return [];

  const parts = await conn
    .select({
      letter: transferBatchParts.partLetter,
      transferId: transfers.id,
      transferCode: transfers.code,
      toLocationId: transfers.toLocationId,
      status: transfers.status,
      dispatchedAt: transfers.dispatchedAt,
    })
    .from(transferBatchParts)
    .innerJoin(transfers, eq(transfers.id, transferBatchParts.transferId))
    .where(eq(transferBatchParts.batchId, batch.id))
    .orderBy(sql`length(${transferBatchParts.partLetter})`, asc(transferBatchParts.partLetter));
  if (parts.length === 0) return [];

  const names = await locationNames(conn, parts.map((p) => p.toLocationId));
  const amounts = await conn
    .select({
      transferId: transferItems.transferId,
      quantity: sql<number>`coalesce(sum(${transferItems.quantityDispatched}), 0)::int`,
      inPieces: sql<boolean>`coalesce(bool_or(${transferItems.inPieces}), false)`,
    })
    .from(transferItems)
    .leftJoin(units, eq(units.id, transferItems.unitId))
    .where(
      and(
        inArray(transferItems.transferId, parts.map((p) => p.transferId)),
        sql`coalesce(${transferItems.batchId}, ${units.batchId}) = ${batch.id}`,
      ),
    )
    .groupBy(transferItems.transferId);
  const amountByTransfer = new Map(amounts.map((a) => [a.transferId, a] as const));

  return parts.map((p) => ({
    letter: p.letter,
    transferCode: p.transferCode,
    toName: names.get(p.toLocationId) ?? "?",
    status: p.status,
    dispatchedAt: p.dispatchedAt,
    quantity: amountByTransfer.get(p.transferId)?.quantity ?? 0,
    inPieces: amountByTransfer.get(p.transferId)?.inPieces ?? false,
  }));
}
