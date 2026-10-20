import "server-only";
import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, gte, inArray, lt, sql } from "drizzle-orm";
import { appendEvents, type DbOrTx, type Tx } from "../audit/events";
import { canWorkAtAnyLocation } from "../auth/permissions";
import { db } from "../db/client";
import { isUniqueViolation } from "../db/errors";
import { batches, itemTypes, locations, stockCountLines, stockCounts, users } from "../db/schema";
import { NotFoundError, PermissionDeniedError, ValidationError } from "../domain/errors";
import { resolveWorkLocation } from "../domain/issue-rules";
import { assertVarianceExplained, countVariance, optionalVariance } from "../domain/stock-count-rules";
import type { Actor, StockCountStatus } from "../domain/types";
import {
  postCountSchema,
  submitCountSchema,
  type PostCountInput,
  type SubmitCountInput,
} from "../../types/stock-counts";
import { isPackUnit } from "../../lib/pack-size";
import { pageInfo, type Paged } from "../../lib/pagination";

// Periodic stock counts for bulk items (corrections C7). The attendant counts first, blind; the expected
// figure (the ledger balance) is captured when the count is submitted and shown only then. Posting writes
// one ADJUSTED event per line whose counted and expected quantities differ, with a reason, so the ledger
// and the shelf agree again. Callers check the count_stock permission; the location checks are here.

function parseOrThrow<T>(
  result: { success: true; data: T } | { success: false; error: { issues: { message: string }[] } },
): T {
  if (!result.success) throw new ValidationError(result.error.issues.map((i) => i.message).join("; "));
  return result.data;
}

function assertWorksAt(actor: Pick<Actor, "role" | "homeLocationId">, locationId: string): void {
  if (canWorkAtAnyLocation(actor.role)) return;
  if (actor.homeLocationId !== locationId) throw new PermissionDeniedError("This count belongs to a different location than yours");
}

/** Locks the batches (in id order, so two counts cannot deadlock) and returns their current ledger balance at a location. */
async function lockAndBalance(tx: Tx, locationId: string, batchIds: readonly string[]): Promise<Map<string, number>> {
  const ids = [...new Set(batchIds)].sort();
  const balances = new Map<string, number>();
  if (ids.length === 0) return balances;
  await tx.select({ id: batches.id }).from(batches).where(inArray(batches.id, ids)).orderBy(asc(batches.id)).for("update");
  const idList = sql.join(
    ids.map((id) => sql`${id}::uuid`),
    sql`, `,
  );
  const rows = await tx.execute<{ batch_id: string; on_hand: number }>(sql`
    select batch_id, on_hand from consumables.v_quantity_balance
    where location_id = ${locationId} and batch_id in (${idList})
  `);
  for (const r of rows) balances.set(r.batch_id, r.on_hand);
  return balances;
}

/** The loose pieces of each batch at a location (v_loose_pieces). Call it after lockAndBalance, which holds the batch locks. */
async function loosePiecesAt(tx: Tx, locationId: string, batchIds: readonly string[]): Promise<Map<string, number>> {
  const ids = [...new Set(batchIds)].sort();
  const loose = new Map<string, number>();
  if (ids.length === 0) return loose;
  const idList = sql.join(
    ids.map((id) => sql`${id}::uuid`),
    sql`, `,
  );
  const rows = await tx.execute<{ batch_id: string; loose: number }>(sql`
    select batch_id, loose from consumables.v_loose_pieces
    where location_id = ${locationId} and batch_id in (${idList})
  `);
  for (const r of rows) loose.set(r.batch_id, r.loose);
  return loose;
}

// --- the count sheet ---------------------------------------------------------------------

export interface CountableBatch {
  batchId: string;
  batchCode: string;
  itemName: string;
  unit: string;
  lotNo: string | null;
  expiryDate: string | null;
  /** True when loose pieces can be counted for this batch: a pack item with a pack size, or one that already holds pieces. */
  acceptsPieces: boolean;
}

/**
 * The batches an attendant counts at a location: bulk batches the ledger says are on the shelf, as sealed packs
 * (v_quantity_balance) or as loose pieces (v_loose_pieces). The list deliberately carries no quantities, so the
 * count stays blind. Soonest expiry first within an item. Sealed packs and loose pieces are counted in separate
 * boxes, so an opened pack's loose pieces are entered as pieces and never mixed into the pack figure.
 */
export async function listCountableBatches(locationId: string, conn: DbOrTx = db()): Promise<CountableBatch[]> {
  const rows = await conn.execute<{
    batch_id: string;
    batch_code: string;
    item_name: string;
    unit: string;
    pack_size: number;
    lot_no: string | null;
    expiry_date: string | null;
    has_loose: boolean;
  }>(sql`
    with held as (
      select batch_id from consumables.v_quantity_balance where location_id = ${locationId} and on_hand <> 0
      union
      select batch_id from consumables.v_loose_pieces where location_id = ${locationId} and loose <> 0
    )
    select b.id as batch_id, b.code as batch_code, it.name as item_name, it.unit_of_measure as unit,
           it.pack_size, b.lot_no, to_char(b.expiry_date, 'YYYY-MM-DD') as expiry_date,
           coalesce(lp.loose, 0) <> 0 as has_loose
    from held h
    join consumables.batches b on b.id = h.batch_id
    join consumables.item_types it on it.id = b.item_type_id
    left join consumables.v_loose_pieces lp on lp.batch_id = b.id and lp.location_id = ${locationId}
    where it.tracking_mode = 'QUANTITY'
    order by it.name asc, b.expiry_date asc nulls last, b.code asc
  `);
  return Array.from(rows).map((r) => ({
    batchId: r.batch_id,
    batchCode: r.batch_code,
    itemName: r.item_name,
    unit: r.unit,
    lotNo: r.lot_no,
    expiryDate: r.expiry_date,
    acceptsPieces: r.has_loose || (isPackUnit(r.unit) && r.pack_size > 1),
  }));
}

/** The location's open count, if one is waiting to be posted. */
export async function getOpenCount(locationId: string, conn: DbOrTx = db()) {
  const [row] = await conn
    .select({ id: stockCounts.id, countedAt: stockCounts.countedAt })
    .from(stockCounts)
    .where(and(eq(stockCounts.locationId, locationId), eq(stockCounts.status, "OPEN")));
  return row ?? null;
}

// --- submit, post, cancel ----------------------------------------------------------------

/**
 * Records what was counted. Expected quantities are read from the ledger now and stored on each line. Only
 * one count can be open at a location; batches that were not counted are simply left out.
 */
export async function submitCount(rawInput: SubmitCountInput, actor: Actor, conn: DbOrTx = db()) {
  const input = parseOrThrow(submitCountSchema.safeParse(rawInput));
  const locationId = resolveWorkLocation(actor, input.locationId);

  return conn.transaction(async (tx) => {
    const [location] = await tx.select({ id: locations.id, active: locations.active }).from(locations).where(eq(locations.id, locationId));
    if (!location || !location.active) throw new NotFoundError("Location");

    const open = await getOpenCount(locationId, tx);
    if (open) {
      throw new ValidationError("This location already has a count waiting to be posted. Post it or cancel it first");
    }

    const balances = await lockAndBalance(tx, locationId, input.lines.map((l) => l.batchId));
    const loose = await loosePiecesAt(tx, locationId, input.lines.map((l) => l.batchId));
    const facts = await tx
      .select({
        id: batches.id,
        trackingMode: itemTypes.trackingMode,
        itemName: itemTypes.name,
        code: batches.code,
        unit: itemTypes.unitOfMeasure,
        packSize: itemTypes.packSize,
      })
      .from(batches)
      .innerJoin(itemTypes, eq(itemTypes.id, batches.itemTypeId))
      .where(inArray(batches.id, input.lines.map((l) => l.batchId)));
    const byId = new Map(facts.map((f) => [f.id, f]));

    for (const line of input.lines) {
      const f = byId.get(line.batchId);
      if (!f) throw new ValidationError("One of the batches no longer exists. Reload the count sheet and try again");
      if (f.trackingMode !== "QUANTITY") throw new ValidationError(`${f.itemName} is serialized: it is tracked by scanning, not counted`);
      if ((balances.get(line.batchId) ?? 0) === 0 && (loose.get(line.batchId) ?? 0) === 0) {
        throw new ValidationError(`${f.itemName} (${f.code}) is not on the books at this location. Reload the count sheet and try again`);
      }
      if (line.countedPieces != null && !(isPackUnit(f.unit) && f.packSize > 1) && (loose.get(line.batchId) ?? 0) === 0) {
        throw new ValidationError(`${f.itemName} (${f.code}) has no loose pieces to count: it is counted in ${f.unit}`);
      }
    }

    let count: typeof stockCounts.$inferSelect;
    try {
      [count] = await tx
        .insert(stockCounts)
        .values({ locationId, countedBy: actor.userId, note: input.note ?? null })
        .returning();
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ValidationError("This location already has a count waiting to be posted. Post it or cancel it first");
      }
      throw err;
    }

    await tx.insert(stockCountLines).values(
      input.lines.map((l) => ({
        countId: count.id,
        batchId: l.batchId,
        countedQuantity: l.counted ?? null,
        expectedQuantity: balances.get(l.batchId) ?? 0,
        countedPieces: l.countedPieces ?? null,
        expectedPieces: loose.get(l.batchId) ?? 0,
      })),
    );
    return count;
  });
}

export interface PostCountResult {
  countId: string;
  linesPosted: number;
  adjustments: number;
}

/**
 * Posts an open count. Every line with a variance needs a reason; each becomes one ADJUSTED event whose
 * quantity is the signed variance. If stock moved since the count was submitted, the expected figures are
 * refreshed and nothing is posted: the person reviews the new variances and posts again.
 */
export async function postCount(
  countId: string,
  rawInput: PostCountInput,
  actor: Actor,
  conn: DbOrTx = db(),
): Promise<PostCountResult> {
  const input = parseOrThrow(postCountSchema.safeParse(rawInput));

  const outcome = await conn.transaction(async (tx) => {
    const [count] = await tx.select().from(stockCounts).where(eq(stockCounts.id, countId)).for("update");
    if (!count) throw new NotFoundError("Count");
    assertWorksAt(actor, count.locationId);
    if (count.status !== "OPEN") throw new ValidationError(`This count is already ${count.status.toLowerCase()}`);

    const lines = await tx
      .select({
        id: stockCountLines.id,
        batchId: stockCountLines.batchId,
        counted: stockCountLines.countedQuantity,
        expected: stockCountLines.expectedQuantity,
        countedPieces: stockCountLines.countedPieces,
        expectedPieces: stockCountLines.expectedPieces,
        itemName: itemTypes.name,
        batchCode: batches.code,
      })
      .from(stockCountLines)
      .innerJoin(batches, eq(batches.id, stockCountLines.batchId))
      .innerJoin(itemTypes, eq(itemTypes.id, batches.itemTypeId))
      .where(eq(stockCountLines.countId, count.id))
      .orderBy(asc(itemTypes.name), asc(batches.code));

    const known = new Set(lines.map((l) => l.id));
    for (const given of input.lines) {
      if (!known.has(given.lineId)) throw new ValidationError("A line on the form is not part of this count. Reload the page");
    }

    // Has stock moved since the count was submitted? Sealed packs and loose pieces are each checked.
    const balances = await lockAndBalance(tx, count.locationId, lines.map((l) => l.batchId));
    const loose = await loosePiecesAt(tx, count.locationId, lines.map((l) => l.batchId));
    const moved = lines.filter(
      (l) => (balances.get(l.batchId) ?? 0) !== l.expected || (loose.get(l.batchId) ?? 0) !== l.expectedPieces,
    );
    if (moved.length > 0) {
      for (const l of moved) {
        await tx
          .update(stockCountLines)
          .set({ expectedQuantity: balances.get(l.batchId) ?? 0, expectedPieces: loose.get(l.batchId) ?? 0 })
          .where(eq(stockCountLines.id, l.id));
      }
      return { drifted: moved.map((l) => `${l.itemName} (${l.batchCode})`) };
    }

    const reasonByLine = new Map(input.lines.map((l) => [l.lineId, l]));
    const now = new Date();
    const eventRows: Parameters<typeof appendEvents>[1] = [];
    const lineUpdates: {
      id: string;
      reasonCode?: string;
      note?: string | null;
      eventId?: string;
      piecesReasonCode?: string;
      piecesNote?: string | null;
      piecesEventId?: string;
    }[] = [];

    for (const l of lines) {
      const given = reasonByLine.get(l.id);
      const update: (typeof lineUpdates)[number] = { id: l.id };

      // Sealed packs: one ADJUSTED event whose quantity is the signed variance.
      const variance = optionalVariance(l.counted, l.expected);
      const reasonCode = assertVarianceExplained(
        { itemName: l.itemName, batchCode: l.batchCode, variance },
        given?.reasonCode,
        given?.note,
      );
      if (reasonCode !== null) {
        const eventId = randomUUID();
        eventRows.push({
          id: eventId,
          unitId: null,
          batchId: l.batchId,
          quantity: variance,
          type: "ADJUSTED",
          locationId: count.locationId,
          userId: actor.userId,
          reasonCode,
          note: given?.note?.trim() || null,
          occurredAt: now,
          payload: { source: "STOCK_COUNT", countId: count.id, counted: l.counted, expected: l.expected },
        });
        update.reasonCode = reasonCode;
        update.note = given?.note?.trim() || null;
        update.eventId = eventId;
      }

      // Loose pieces: an ADJUSTED event with quantity 0 and the size of the variance as pieces. events.pieces is never
      // negative, so the direction goes in the payload, where v_loose_pieces reads it.
      const pieceVariance = optionalVariance(l.countedPieces, l.expectedPieces);
      const piecesReasonCode = assertVarianceExplained(
        { itemName: `${l.itemName} loose pieces`, batchCode: l.batchCode, variance: pieceVariance },
        given?.piecesReasonCode,
        given?.piecesNote,
      );
      if (piecesReasonCode !== null) {
        const piecesEventId = randomUUID();
        eventRows.push({
          id: piecesEventId,
          unitId: null,
          batchId: l.batchId,
          quantity: 0,
          pieces: Math.abs(pieceVariance),
          type: "ADJUSTED",
          locationId: count.locationId,
          userId: actor.userId,
          reasonCode: piecesReasonCode,
          note: given?.piecesNote?.trim() || null,
          occurredAt: now,
          payload: {
            source: "STOCK_COUNT",
            countId: count.id,
            unit: "PIECES",
            piecesDirection: pieceVariance < 0 ? "REMOVE" : "ADD",
            counted: l.countedPieces,
            expected: l.expectedPieces,
          },
        });
        update.piecesReasonCode = piecesReasonCode;
        update.piecesNote = given?.piecesNote?.trim() || null;
        update.piecesEventId = piecesEventId;
      }

      if (update.eventId || update.piecesEventId) lineUpdates.push(update);
    }

    await appendEvents(tx, eventRows);
    for (const u of lineUpdates) {
      await tx
        .update(stockCountLines)
        .set({
          ...(u.eventId ? { reasonCode: u.reasonCode, note: u.note, adjustmentEventId: u.eventId } : {}),
          ...(u.piecesEventId
            ? { piecesReasonCode: u.piecesReasonCode, piecesNote: u.piecesNote, piecesAdjustmentEventId: u.piecesEventId }
            : {}),
        })
        .where(eq(stockCountLines.id, u.id));
    }
    await tx
      .update(stockCounts)
      .set({ status: "POSTED", postedBy: actor.userId, postedAt: now })
      .where(eq(stockCounts.id, count.id));

    return { result: { countId: count.id, linesPosted: lines.length, adjustments: eventRows.length } };
  });

  if (outcome.drifted) {
    throw new ValidationError(
      `Stock moved while this count was open (${outcome.drifted.join(", ")}). The expected figures were refreshed: check the variances and post again`,
    );
  }
  return outcome.result;
}

/** Throws a count away without changing any stock. The attendant can then count again. */
export async function cancelCount(countId: string, actor: Actor, conn: DbOrTx = db()) {
  return conn.transaction(async (tx) => {
    const [count] = await tx.select().from(stockCounts).where(eq(stockCounts.id, countId)).for("update");
    if (!count) throw new NotFoundError("Count");
    assertWorksAt(actor, count.locationId);
    if (count.status !== "OPEN") throw new ValidationError(`This count is already ${count.status.toLowerCase()}`);
    const [row] = await tx.update(stockCounts).set({ status: "CANCELLED" }).where(eq(stockCounts.id, count.id)).returning();
    return row;
  });
}

// --- reading -----------------------------------------------------------------------------

export interface CountLineView {
  lineId: string;
  itemName: string;
  unit: string;
  /** For piece equivalents beside pack quantities. Display only. */
  packSize: number;
  packSizeConfirmed: boolean;
  batchCode: string;
  expiryDate: string | null;
  /** Sealed packs counted; null when only the loose pieces were counted. */
  counted: number | null;
  expected: number;
  /** 0 when the packs were not counted. */
  variance: number;
  reasonCode: string | null;
  note: string | null;
  /** Loose pieces counted; null when only the sealed packs were counted. */
  countedPieces: number | null;
  expectedPieces: number;
  /** 0 when the pieces were not counted. */
  pieceVariance: number;
  piecesReasonCode: string | null;
  piecesNote: string | null;
}

/** One count with its lines. Callers check the person may see this location (see canSeeCount). */
export async function getCount(countId: string, conn: DbOrTx = db()) {
  const [count] = await conn
    .select({
      id: stockCounts.id,
      locationId: stockCounts.locationId,
      locationName: locations.name,
      status: stockCounts.status,
      countedAt: stockCounts.countedAt,
      countedByName: users.name,
      note: stockCounts.note,
      postedAt: stockCounts.postedAt,
    })
    .from(stockCounts)
    .innerJoin(locations, eq(locations.id, stockCounts.locationId))
    .innerJoin(users, eq(users.id, stockCounts.countedBy))
    .where(eq(stockCounts.id, countId));
  if (!count) return null;

  const rows = await conn
    .select({
      lineId: stockCountLines.id,
      itemName: itemTypes.name,
      unit: itemTypes.unitOfMeasure,
      packSize: itemTypes.packSize,
      packSizeConfirmed: itemTypes.packSizeConfirmed,
      batchCode: batches.code,
      expiryDate: sql<string | null>`to_char(${batches.expiryDate}, 'YYYY-MM-DD')`,
      counted: stockCountLines.countedQuantity,
      expected: stockCountLines.expectedQuantity,
      reasonCode: stockCountLines.reasonCode,
      note: stockCountLines.note,
      countedPieces: stockCountLines.countedPieces,
      expectedPieces: stockCountLines.expectedPieces,
      piecesReasonCode: stockCountLines.piecesReasonCode,
      piecesNote: stockCountLines.piecesNote,
    })
    .from(stockCountLines)
    .innerJoin(batches, eq(batches.id, stockCountLines.batchId))
    .innerJoin(itemTypes, eq(itemTypes.id, batches.itemTypeId))
    .where(eq(stockCountLines.countId, count.id))
    .orderBy(asc(itemTypes.name), asc(batches.code));

  const lines: CountLineView[] = rows.map((r) => ({
    ...r,
    variance: optionalVariance(r.counted, r.expected),
    pieceVariance: optionalVariance(r.countedPieces, r.expectedPieces),
  }));
  return { ...count, status: count.status as StockCountStatus, lines };
}

/** A person sees counts at their own location; supervisors and admins at any. Report readers use the report instead. */
export function canSeeCount(actor: Pick<Actor, "role" | "homeLocationId">, locationId: string): boolean {
  return canWorkAtAnyLocation(actor.role) || actor.homeLocationId === locationId;
}

/** The most recent counts at a location, newest first. */
export async function listRecentCounts(locationId: string, limit = 10, conn: DbOrTx = db(), offset = 0) {
  const rows = await conn
    .select({
      id: stockCounts.id,
      status: stockCounts.status,
      countedAt: stockCounts.countedAt,
      countedByName: users.name,
      lineCount: sql<number>`(select count(*)::int from consumables.stock_count_lines l where l.count_id = ${stockCounts.id})`,
      varianceLines: sql<number>`(select count(*)::int from consumables.stock_count_lines l where l.count_id = ${stockCounts.id} and (coalesce(l.counted_quantity, l.expected_quantity) <> l.expected_quantity or coalesce(l.counted_pieces, l.expected_pieces) <> l.expected_pieces))`,
    })
    .from(stockCounts)
    .innerJoin(users, eq(users.id, stockCounts.countedBy))
    .where(eq(stockCounts.locationId, locationId))
    .orderBy(desc(stockCounts.countedAt), desc(stockCounts.id))
    .limit(limit)
    .offset(offset);
  return rows;
}

/** One page (20 counts) at a location, newest first, plus the total. */
export async function listCountsPage(
  locationId: string,
  page: number,
  conn: DbOrTx = db(),
): Promise<Paged<Awaited<ReturnType<typeof listRecentCounts>>[number]>> {
  const [{ total }] = await conn
    .select({ total: sql<number>`count(*)::int` })
    .from(stockCounts)
    .where(eq(stockCounts.locationId, locationId));
  const info = pageInfo(page, total);
  const rows = await listRecentCounts(locationId, info.pageSize, conn, info.offset);
  return { ...info, rows };
}

// --- variance report -----------------------------------------------------------------------

export interface CountVarianceRow {
  countId: string;
  postedAt: Date;
  locationName: string;
  itemName: string;
  batchCode: string;
  /** PACKS: the item's own unit (sealed packs). PIECES: loose pieces, which are never added to the pack figures. */
  kind: "PACKS" | "PIECES";
  unit: string;
  packSize: number;
  packSizeConfirmed: boolean;
  counted: number;
  expected: number;
  variance: number;
  reasonCode: string | null;
  note: string | null;
  countedByName: string;
}

export interface CountVarianceReport {
  rows: CountVarianceRow[];
  /** Counted figures: a line counted in packs and pieces is two. */
  linesCounted: number;
  linesWithVariance: number;
  unitsShort: number;
  unitsOver: number;
  piecesShort: number;
  piecesOver: number;
}

/** Posted counts in [from, to): every counted line with its variance, newest first. */
export async function listCountVariances(
  args: { from: Date; to: Date; locationId?: string },
  conn: DbOrTx = db(),
): Promise<CountVarianceReport> {
  const rows = await conn
    .select({
      countId: stockCounts.id,
      postedAt: stockCounts.postedAt,
      locationName: locations.name,
      itemName: itemTypes.name,
      batchCode: batches.code,
      unit: itemTypes.unitOfMeasure,
      packSize: itemTypes.packSize,
      packSizeConfirmed: itemTypes.packSizeConfirmed,
      counted: stockCountLines.countedQuantity,
      expected: stockCountLines.expectedQuantity,
      reasonCode: stockCountLines.reasonCode,
      note: stockCountLines.note,
      countedPieces: stockCountLines.countedPieces,
      expectedPieces: stockCountLines.expectedPieces,
      piecesReasonCode: stockCountLines.piecesReasonCode,
      piecesNote: stockCountLines.piecesNote,
      countedByName: users.name,
    })
    .from(stockCountLines)
    .innerJoin(stockCounts, eq(stockCounts.id, stockCountLines.countId))
    .innerJoin(locations, eq(locations.id, stockCounts.locationId))
    .innerJoin(batches, eq(batches.id, stockCountLines.batchId))
    .innerJoin(itemTypes, eq(itemTypes.id, batches.itemTypeId))
    .innerJoin(users, eq(users.id, stockCounts.countedBy))
    .where(
      and(
        eq(stockCounts.status, "POSTED"),
        gte(stockCounts.postedAt, args.from),
        lt(stockCounts.postedAt, args.to),
        args.locationId ? eq(stockCounts.locationId, args.locationId) : undefined,
      ),
    )
    .orderBy(desc(stockCounts.postedAt), asc(locations.name), asc(itemTypes.name), asc(batches.code))
    .limit(2000);

  // One row per counted figure: sealed packs and loose pieces are reported apart, never added together.
  const mapped: CountVarianceRow[] = [];
  for (const r of rows) {
    const base = {
      countId: r.countId,
      postedAt: r.postedAt as Date,
      locationName: r.locationName,
      itemName: r.itemName,
      batchCode: r.batchCode,
      unit: r.unit,
      packSize: r.packSize,
      packSizeConfirmed: r.packSizeConfirmed,
      countedByName: r.countedByName,
    };
    if (r.counted != null) {
      mapped.push({
        ...base,
        kind: "PACKS",
        counted: r.counted,
        expected: r.expected,
        variance: countVariance(r.counted, r.expected),
        reasonCode: r.reasonCode,
        note: r.note,
      });
    }
    if (r.countedPieces != null) {
      mapped.push({
        ...base,
        kind: "PIECES",
        counted: r.countedPieces,
        expected: r.expectedPieces,
        variance: countVariance(r.countedPieces, r.expectedPieces),
        reasonCode: r.piecesReasonCode,
        note: r.piecesNote,
      });
    }
  }
  const packRows = mapped.filter((r) => r.kind === "PACKS");
  const pieceRows = mapped.filter((r) => r.kind === "PIECES");
  const short = (rs: CountVarianceRow[]) => rs.reduce((n, r) => n + (r.variance < 0 ? -r.variance : 0), 0);
  const over = (rs: CountVarianceRow[]) => rs.reduce((n, r) => n + (r.variance > 0 ? r.variance : 0), 0);
  return {
    rows: mapped,
    linesCounted: mapped.length,
    linesWithVariance: mapped.filter((r) => r.variance !== 0).length,
    unitsShort: short(packRows),
    unitsOver: over(packRows),
    piecesShort: short(pieceRows),
    piecesOver: over(pieceRows),
  };
}
