import "server-only";
import { randomUUID } from "node:crypto";
import { and, desc, eq, gte, inArray, lt, sql } from "drizzle-orm";
import { appendEvents, type DbOrTx, type Tx } from "../audit/events";
import { db } from "../db/client";
import { batches, events, itemTypes, locations, transferItems, transfers, units, users } from "../db/schema";
import { NotFoundError, ValidationError } from "../domain/errors";
import { assertCanResolve, assertStatus, itemResolution } from "../domain/rules";
import { transition } from "../domain/state-machine";
import { isValidBatchCode, normalizeCode, parseSerial } from "../../lib/serial";
import { pageInfo, type Paged } from "../../lib/pagination";
import { resolveDiscrepancySchema, type ResolveDiscrepancyInput } from "../../types/transfers";
import { syncRequestFromTransfers } from "./request-sync.service";

// Discrepancies (architecture 7.3 step 4): after a receipt closes with missing units or short
// quantities, a supervisor resolves each one as found or
// written off, with a reason. A found unit goes back in stock where it was found (the destination
// unless the supervisor picks another location). Callers check the `resolve_discrepancy` permission.

export interface OpenDiscrepancy {
  transferItemId: string;
  transferId: string;
  transferCode: string;
  fromLocationName: string;
  toLocationName: string;
  closedAt: Date | null;
  /** Set for SERIAL items. */
  serial: string | null;
  batchCode: string;
  itemName: string;
  dispatched: number;
  received: number;
  outstanding: number;
  /** True when dispatched, received and outstanding are loose pieces rather than the item's own unit. */
  inPieces: boolean;
}

interface ViewRow extends Record<string, unknown> {
  transfer_item_id: string;
  transfer_id: string;
  transfer_code: string;
  from_location_name: string;
  to_location_name: string;
  receipt_closed_at: Date | null;
  serial: string | null;
  batch_code: string;
  item_name: string;
  quantity_dispatched: number;
  quantity_received: number;
  quantity_outstanding: number;
}

/** Everything still unresolved, oldest first, with the exact serial or batch. */
export async function listOpenDiscrepancies(conn: DbOrTx = db()): Promise<OpenDiscrepancy[]> {
  const rows = await conn.execute<ViewRow>(
    sql`select * from consumables.v_open_discrepancies order by receipt_closed_at, transfer_code, serial nulls last, batch_code`,
  );
  // The view does not carry the unit, so look up which of these lines are counted in loose pieces.
  const ids = Array.from(rows).map((r) => r.transfer_item_id);
  const pieceIds = new Set<string>();
  if (ids.length > 0) {
    const found = await conn
      .select({ id: transferItems.id })
      .from(transferItems)
      .where(and(inArray(transferItems.id, ids), eq(transferItems.inPieces, true)));
    for (const f of found) pieceIds.add(f.id);
  }
  return Array.from(rows).map((r) => ({
    inPieces: pieceIds.has(r.transfer_item_id),
    transferItemId: r.transfer_item_id,
    transferId: r.transfer_id,
    transferCode: r.transfer_code,
    fromLocationName: r.from_location_name,
    toLocationName: r.to_location_name,
    closedAt: r.receipt_closed_at,
    serial: r.serial,
    batchCode: r.batch_code,
    itemName: r.item_name,
    dispatched: r.quantity_dispatched,
    received: r.quantity_received,
    outstanding: r.quantity_outstanding,
  }));
}

export async function countOpenDiscrepancies(conn: DbOrTx = db()): Promise<number> {
  const rows = await conn.execute<{ n: number }>(
    sql`select count(*)::int as n from consumables.v_open_discrepancies`,
  );
  return rows[0]?.n ?? 0;
}

/** One finished resolution: a missing item marked found or written off. A split bulk item gives one row per part. */
export interface ResolvedDiscrepancy {
  eventId: string;
  outcome: "FOUND" | "WRITTEN_OFF";
  transferCode: string | null;
  itemName: string | null;
  /** Set for a bottle. */
  serial: string | null;
  /** Set for a bulk batch. */
  batchCode: string | null;
  /** Loose pieces when `inPieces`, otherwise whole units. */
  quantity: number;
  inPieces: boolean;
  /** Where it was found, or the destination it never reached for a write-off. */
  locationName: string;
  reason: string | null;
  resolvedBy: string;
  resolvedAt: Date;
  /** Who carried the transfer (typed at dispatch), or null for transfers dispatched before it was recorded. */
  carriedBy: string | null;
}

export interface ResolvedFilter {
  outcome?: "FOUND" | "WRITTEN_OFF";
  from?: Date;
  to?: Date;
}

const resolvedWhere = (opts: ResolvedFilter) => {
  const types: ("FOUND" | "WRITTEN_OFF")[] = opts.outcome ? [opts.outcome] : ["FOUND", "WRITTEN_OFF"];
  return and(
    inArray(events.type, types),
    opts.from ? gte(events.occurredAt, opts.from) : undefined,
    opts.to ? lt(events.occurredAt, opts.to) : undefined,
  );
};

/** Totals over everything a filter matches (not just one page): how many, and units / loose pieces per outcome. */
export interface ResolvedSummary {
  total: number;
  found: { units: number; pieces: number };
  writtenOff: { units: number; pieces: number };
}

export async function summarizeResolvedDiscrepancies(opts: ResolvedFilter = {}, conn: DbOrTx = db()): Promise<ResolvedSummary> {
  const rows = await conn
    .select({
      type: events.type,
      n: sql<number>`count(*)::int`,
      units: sql<number>`coalesce(sum(case when ${events.pieces} = 0 then ${events.quantity} else 0 end), 0)::int`,
      pieces: sql<number>`coalesce(sum(${events.pieces}), 0)::int`,
    })
    .from(events)
    .innerJoin(transfers, eq(events.transferId, transfers.id))
    .innerJoin(locations, eq(events.locationId, locations.id))
    .innerJoin(users, eq(events.userId, users.id))
    .where(resolvedWhere(opts))
    .groupBy(events.type);
  const out: ResolvedSummary = { total: 0, found: { units: 0, pieces: 0 }, writtenOff: { units: 0, pieces: 0 } };
  for (const r of rows) {
    out.total += r.n;
    const side = r.type === "FOUND" ? out.found : out.writtenOff;
    side.units += r.units;
    side.pieces += r.pieces;
  }
  return out;
}

/** One page of the resolved history, with the true total and the summary over the whole filter. */
export async function listResolvedDiscrepanciesPage(
  opts: ResolvedFilter,
  page: number,
  conn: DbOrTx = db(),
): Promise<Paged<ResolvedDiscrepancy> & { summary: ResolvedSummary }> {
  const summary = await summarizeResolvedDiscrepancies(opts, conn);
  const info = pageInfo(page, summary.total);
  const rows = summary.total === 0 ? [] : await listResolvedDiscrepancies(opts, conn, info.pageSize, info.offset);
  return { ...info, rows, summary };
}

/**
 * Resolved discrepancies, newest first, from the FOUND and WRITTEN_OFF events. `from` is
 * included and `to` is not (pass the start of the day after the last day wanted). Callers check
 * `view_discrepancies`, and `view_discrepancy_people` before showing who resolved each one.
 */
export async function listResolvedDiscrepancies(
  opts: ResolvedFilter = {},
  conn: DbOrTx = db(),
  limit = 500,
  offset = 0,
): Promise<ResolvedDiscrepancy[]> {
  const rows = await conn
    .select({
      eventId: events.id,
      type: events.type,
      transferCode: transfers.code,
      itemName: itemTypes.name,
      serial: units.serial,
      batchCode: batches.code,
      quantity: events.quantity,
      pieces: events.pieces,
      locationName: locations.name,
      reason: events.note,
      resolvedBy: users.name,
      resolvedAt: events.occurredAt,
      carriedBy: transfers.carriedByName,
    })
    .from(events)
    .innerJoin(transfers, eq(events.transferId, transfers.id))
    .innerJoin(locations, eq(events.locationId, locations.id))
    .innerJoin(users, eq(events.userId, users.id))
    .leftJoin(units, eq(events.unitId, units.id))
    .leftJoin(batches, eq(events.batchId, batches.id))
    .leftJoin(itemTypes, eq(batches.itemTypeId, itemTypes.id))
    .where(resolvedWhere(opts))
    .orderBy(desc(events.occurredAt), desc(events.id))
    .limit(limit)
    .offset(offset);
  return rows.map((r) => ({
    eventId: r.eventId,
    outcome: r.type === "FOUND" ? "FOUND" : "WRITTEN_OFF",
    transferCode: r.transferCode,
    itemName: r.itemName,
    serial: r.serial,
    // A bottle's event also carries its batch; only bulk rows show the batch code.
    batchCode: r.serial ? null : r.batchCode,
    // A resolution of loose pieces is recorded as quantity 0 and the number of pieces.
    quantity: r.pieces > 0 ? r.pieces : r.quantity,
    inPieces: r.pieces > 0,
    locationName: r.locationName,
    reason: r.reason,
    resolvedBy: r.resolvedBy,
    resolvedAt: r.resolvedAt,
    carriedBy: r.carriedBy,
  }));
}

/** Who handled a transfer and when: the trail behind a discrepancy. */
export interface TransferPeople {
  startedBy: string | null;
  dispatchedBy: string | null;
  dispatchedAt: Date | null;
  /** The name typed at dispatch for whoever carried the stock. Null for transfers dispatched before it was recorded. */
  carriedBy: string | null;
  receivedBy: string | null;
  receiptStartedAt: Date | null;
  receiptClosedBy: string | null;
  receiptClosedAt: Date | null;
}

/**
 * The people involved in each given transfer, by transfer id: who started it, who dispatched it, who
 * carried it, who opened the receipt at the destination and who closed it. Callers check `view_discrepancy_people`.
 */
export async function getTransferPeople(transferIds: string[], conn: DbOrTx = db()): Promise<Map<string, TransferPeople>> {
  const ids = [...new Set(transferIds)];
  if (ids.length === 0) return new Map();
  const rows = await conn.select().from(transfers).where(inArray(transfers.id, ids));
  const userIds = [
    ...new Set(
      rows.flatMap((t) => [t.createdBy, t.dispatchedBy, t.receiptStartedBy, t.receiptClosedBy]).filter((id): id is string => Boolean(id)),
    ),
  ];
  const names = new Map<string, string>();
  if (userIds.length > 0) {
    const found = await conn.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, userIds));
    for (const u of found) names.set(u.id, u.name);
  }
  const nameOf = (id: string | null) => (id ? (names.get(id) ?? "?") : null);
  return new Map(
    rows.map((t) => [
      t.id,
      {
        startedBy: nameOf(t.createdBy),
        dispatchedBy: nameOf(t.dispatchedBy),
        dispatchedAt: t.dispatchedAt,
        carriedBy: t.carriedByName,
        receivedBy: nameOf(t.receiptStartedBy),
        receiptStartedAt: t.receiptStartedAt,
        receiptClosedBy: nameOf(t.receiptClosedBy),
        receiptClosedAt: t.receiptClosedAt,
      },
    ]),
  );
}

async function lockTransfer(tx: Tx, transferId: string) {
  const [row] = await tx.select().from(transfers).where(eq(transfers.id, transferId)).for("update");
  if (!row) throw new NotFoundError("Transfer");
  return row;
}

/**
 * Resolves some or all of one missing item. SERIAL units are resolved whole (quantity 1);
 * QUANTITY items can be split, for example 4 found and 6 written off. Each resolution writes
 * one event. When nothing on the transfer is outstanding any more, it becomes DISCREPANCY_RESOLVED.
 */
export async function resolveDiscrepancy(
  rawInput: ResolveDiscrepancyInput,
  supervisorId: string,
  conn: DbOrTx = db(),
) {
  const parsed = resolveDiscrepancySchema.safeParse(rawInput);
  if (!parsed.success) throw new ValidationError(parsed.error.issues.map((i) => i.message).join("; "));
  const input = parsed.data;

  return conn.transaction(async (tx) => {
    // Lock order: transfer first, then its item (the same order the receive service uses).
    const [peek] = await tx
      .select({ transferId: transferItems.transferId })
      .from(transferItems)
      .where(eq(transferItems.id, input.transferItemId));
    if (!peek) throw new NotFoundError("Discrepancy");
    const transfer = await lockTransfer(tx, peek.transferId);
    assertStatus(transfer.status, ["RECEIVED_WITH_DISCREPANCY"], "resolve");

    const [item] = await tx
      .select()
      .from(transferItems)
      .where(eq(transferItems.id, input.transferItemId))
      .for("update");
    if (!item) throw new NotFoundError("Discrepancy");

    const isSerial = item.unitId !== null;
    const quantity = isSerial ? 1 : input.quantity;
    const outstanding = item.quantityMissing - item.quantityFound - item.quantityWrittenOff;
    const note = assertCanResolve({ quantity, outstanding, note: input.note });

    const now = new Date();
    // A bottle that turns up can be put back where it was found, which is not always where it was sent.
    let foundAt = transfer.toLocationId;
    if (input.resolution === "FOUND" && input.foundLocationId && input.foundLocationId !== transfer.toLocationId) {
      const [place] = await tx
        .select({ id: locations.id, active: locations.active })
        .from(locations)
        .where(eq(locations.id, input.foundLocationId));
      if (!place) throw new ValidationError("Choose where it was found");
      if (!place.active) throw new ValidationError("That location is not active");
      foundAt = place.id;
    }
    const base = {
      id: randomUUID(),
      locationId: input.resolution === "FOUND" ? foundAt : transfer.toLocationId,
      userId: supervisorId,
      transferId: transfer.id,
      reasonCode: input.resolution,
      note,
      occurredAt: now,
      payload: {
        transferCode: transfer.code,
        fromLocationId: transfer.fromLocationId,
        ...(input.resolution === "FOUND" ? { foundAtLocationId: foundAt } : {}),
      },
    };

    if (isSerial) {
      const [unit] = await tx
        .select({ id: units.id, serial: units.serial, state: units.state, batchId: units.batchId })
        .from(units)
        .where(eq(units.id, item.unitId as string))
        .for("update");
      if (!unit) throw new NotFoundError("Unit");

      // A bottle is only marked found once the person holding it has scanned it and it is the missing one.
      if (input.resolution === "FOUND") {
        if (!input.scannedCode) throw new ValidationError("Scan the bottle to confirm it is the one that went missing");
        const scanned = parseSerial(input.scannedCode);
        if (!scanned) throw new ValidationError("That is not a valid bottle code. Scan the label again");
        if (scanned !== normalizeCode(unit.serial)) {
          throw new ValidationError(`That is ${scanned}, not ${unit.serial}. Scan the bottle that went missing`);
        }
      }

      const action = input.resolution === "FOUND" ? "RESOLVE_FOUND" : "WRITE_OFF";
      const step = transition(unit.state, action); // must be MISSING_IN_TRANSIT
      await tx
        .update(units)
        .set(
          input.resolution === "FOUND"
            ? { state: step.to, currentLocationId: foundAt, currentTransferId: null }
            : { state: step.to },
        )
        .where(eq(units.id, unit.id));
      await appendEvents(tx, [
        {
          ...base,
          unitId: unit.id,
          batchId: unit.batchId,
          quantity: 1,
          type: step.event,
          fromState: unit.state,
          toState: step.to,
        },
      ]);
    } else {
      // A bulk batch is only marked found once its box label has been scanned and it is the short batch.
      if (input.resolution === "FOUND") {
        if (!item.batchId) throw new NotFoundError("Batch");
        const [batch] = await tx.select({ code: batches.code }).from(batches).where(eq(batches.id, item.batchId));
        if (!batch) throw new NotFoundError("Batch");
        if (!input.scannedCode) throw new ValidationError("Scan the box label to confirm which batch was found");
        const scanned = normalizeCode(input.scannedCode);
        if (!isValidBatchCode(scanned)) throw new ValidationError("That is not a valid box label. Scan it again");
        if (scanned !== normalizeCode(batch.code)) {
          throw new ValidationError(`That is box ${scanned}, not ${batch.code}. Scan the label of the batch that was short`);
        }
      }
      // A line counted in loose pieces is resolved in pieces: quantity 0 and the pieces, so only the loose-piece
      // balance moves (a found piece goes back as a loose piece where it was found).
      await appendEvents(tx, [
        {
          ...base,
          batchId: item.batchId,
          ...(item.inPieces ? { quantity: 0, pieces: quantity } : { quantity }),
          type: input.resolution === "FOUND" ? "FOUND" : "WRITTEN_OFF",
        },
      ]);
    }

    const found = item.quantityFound + (input.resolution === "FOUND" ? quantity : 0);
    const writtenOff = item.quantityWrittenOff + (input.resolution === "WRITTEN_OFF" ? quantity : 0);
    const resolution = itemResolution(found, writtenOff, item.quantityMissing);
    await tx
      .update(transferItems)
      .set({
        quantityFound: found,
        quantityWrittenOff: writtenOff,
        resolution,
        resolvedBy: resolution ? supervisorId : item.resolvedBy,
        resolvedAt: resolution ? now : item.resolvedAt,
        resolutionNote: [item.resolutionNote, note].filter(Boolean).join(" | "),
      })
      .where(eq(transferItems.id, item.id));

    const [left] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(transferItems)
      .where(
        and(
          eq(transferItems.transferId, transfer.id),
          sql`${transferItems.quantityMissing} > ${transferItems.quantityFound} + ${transferItems.quantityWrittenOff}`,
        ),
      );
    const remaining = left?.n ?? 0;
    if (remaining === 0) {
      await tx.update(transfers).set({ status: "DISCREPANCY_RESOLVED" }).where(eq(transfers.id, transfer.id));
    }
    // Units found count as received on the request. Written off units do not change the received count.
    if (transfer.requestId && input.resolution === "FOUND") {
      await syncRequestFromTransfers(tx, transfer.requestId);
    }
    return { transferCode: transfer.code, remainingOnTransfer: remaining };
  });
}
