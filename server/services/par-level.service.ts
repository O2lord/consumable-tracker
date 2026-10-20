import "server-only";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { DbOrTx } from "../audit/events";
import { db } from "../db/client";
import { itemTypes, locations, parLevels } from "../db/schema";
import { NotFoundError, ValidationError } from "../domain/errors";
import { isBelowMinimum, shortfallToTarget } from "../domain/stock-count-rules";
import { isPackUnit } from "../../lib/pack-size";
import { saveParLevelsSchema, type SaveParLevelsInput } from "../../types/stock-counts";
import { getAvailableByItemType, getAvailablePiecesByItemType } from "./stock.service";

// Target and minimum stock per location (corrections C7). A par level never moves stock: it is what a
// location should hold, used for the "low" flags and for suggesting a stock request.
// Callers check the manage_par_levels permission.

export interface ParLevelRow {
  itemTypeId: string;
  itemCode: string;
  itemName: string;
  trackingMode: "SERIAL" | "QUANTITY";
  unit: string;
  target: number | null;
  minimum: number;
}

/** Every active item type with this location's target and minimum (null target = none set), by name. */
export async function listParLevelsForLocation(locationId: string, conn: DbOrTx = db()): Promise<ParLevelRow[]> {
  const rows = await conn
    .select({
      itemTypeId: itemTypes.id,
      itemCode: itemTypes.code,
      itemName: itemTypes.name,
      trackingMode: itemTypes.trackingMode,
      unit: itemTypes.unitOfMeasure,
      target: parLevels.targetQuantity,
      minimum: parLevels.minimumQuantity,
    })
    .from(itemTypes)
    .leftJoin(parLevels, and(eq(parLevels.itemTypeId, itemTypes.id), eq(parLevels.locationId, locationId)))
    .where(eq(itemTypes.active, true))
    .orderBy(asc(itemTypes.name));
  return rows.map((r) => ({ ...r, minimum: r.minimum ?? 0 }));
}

/** Par levels at one location for the given items, keyed by item type id. Items with none are absent. */
export async function getParLevels(
  locationId: string,
  itemTypeIds: readonly string[],
  conn: DbOrTx = db(),
): Promise<Map<string, { target: number; minimum: number }>> {
  if (itemTypeIds.length === 0) return new Map();
  const rows = await conn
    .select({ itemTypeId: parLevels.itemTypeId, target: parLevels.targetQuantity, minimum: parLevels.minimumQuantity })
    .from(parLevels)
    .where(and(eq(parLevels.locationId, locationId), inArray(parLevels.itemTypeId, [...itemTypeIds])));
  return new Map(rows.map((r) => [r.itemTypeId, { target: r.target, minimum: r.minimum }]));
}

/**
 * Saves the whole form for one location in one transaction: a row with a target is created or updated,
 * a row with no target removes any par level it had. Returns how many levels were set and removed.
 */
export async function saveParLevels(rawInput: SaveParLevelsInput, conn: DbOrTx = db()) {
  const parsed = saveParLevelsSchema.safeParse(rawInput);
  if (!parsed.success) throw new ValidationError(parsed.error.issues.map((i) => i.message).join("; "));
  const input = parsed.data;

  return conn.transaction(async (tx) => {
    const [location] = await tx.select({ id: locations.id, active: locations.active }).from(locations).where(eq(locations.id, input.locationId));
    if (!location || !location.active) throw new NotFoundError("Location");

    const known = await tx
      .select({ id: itemTypes.id })
      .from(itemTypes)
      .where(inArray(itemTypes.id, input.rows.map((r) => r.itemTypeId)));
    if (known.length !== input.rows.length) throw new ValidationError("One of the items no longer exists. Reload the page and try again");

    let set = 0;
    let removed = 0;
    for (const row of input.rows) {
      if (row.target === null) {
        const gone = await tx
          .delete(parLevels)
          .where(and(eq(parLevels.locationId, input.locationId), eq(parLevels.itemTypeId, row.itemTypeId)))
          .returning({ id: parLevels.id });
        removed += gone.length;
        continue;
      }
      await tx
        .insert(parLevels)
        .values({
          locationId: input.locationId,
          itemTypeId: row.itemTypeId,
          targetQuantity: row.target,
          minimumQuantity: row.minimum,
        })
        .onConflictDoUpdate({
          target: [parLevels.locationId, parLevels.itemTypeId],
          set: { targetQuantity: row.target, minimumQuantity: row.minimum, updatedAt: sql`now()` },
        });
      set += 1;
    }
    return { set, removed };
  });
}

export interface RequestSuggestion {
  itemTypeId: string;
  itemName: string;
  unit: string;
  /** Pack size, for showing piece equivalents beside pack quantities. Display only. */
  packSize: number;
  packSizeConfirmed: boolean;
  target: number;
  minimum: number;
  /** What the location can use now: on the shelf, not expired, not promised to an open draft. Whole packs only; see `loosePieces`. */
  onHand: number;
  /** Loose pieces of opened packs on top of `onHand` whole packs (always 0 for an item without a pack size). */
  loosePieces: number;
  /** Already asked for or travelling: submitted requests, open balances, and dispatched but not yet received. */
  onTheWay: number;
  /** What to ask for to get back to target. Always above 0. */
  quantity: number;
  belowMinimum: boolean;
}

/**
 * Suggested request lines for a location: for every item with a target, target minus what is on hand minus
 * what is already on the way, for items that come out above zero. "On hand" is the ledger balance, which is
 * the last posted count plus anything received since; bottles are counted from their units. A pack item with a
 * pack size is worked out in pieces (sealed packs times pack size plus loose pieces, and piece requests on the way
 * as pieces) and the shortfall is rounded up to whole packs, so opened packs and part-pack requests are not ignored.
 * Nothing is created: the page pre-fills the request form and the person edits and saves it as usual.
 */
export async function suggestRequestFromTargets(locationId: string, conn: DbOrTx = db()): Promise<RequestSuggestion[]> {
  const pars = await conn
    .select({
      itemTypeId: itemTypes.id,
      itemName: itemTypes.name,
      unit: itemTypes.unitOfMeasure,
      trackingMode: itemTypes.trackingMode,
      packSize: itemTypes.packSize,
      packSizeConfirmed: itemTypes.packSizeConfirmed,
      target: parLevels.targetQuantity,
      minimum: parLevels.minimumQuantity,
    })
    .from(parLevels)
    .innerJoin(itemTypes, eq(itemTypes.id, parLevels.itemTypeId))
    .where(and(eq(parLevels.locationId, locationId), eq(itemTypes.active, true)))
    .orderBy(asc(itemTypes.name));
  if (pars.length === 0) return [];

  const available = await getAvailableByItemType(locationId, pars.map((p) => p.itemTypeId), conn);
  // Pack items are counted in pieces too, so an opened pack's loose pieces are not lost.
  const piecesItems = pars.filter((p) => p.trackingMode === "QUANTITY" && isPackUnit(p.unit) && p.packSize > 1);
  const availablePieces = await getAvailablePiecesByItemType(locationId, piecesItems.map((p) => p.itemTypeId), conn);

  // Requests are by item type. An approved line still owes (approved - dispatched) unless it was closed, and
  // what was dispatched but not yet received is on its way. Drafts are not counted: the person may be editing one.
  // A line counted in loose pieces is totalled apart (pieces cannot be added to packs).
  const wayRows = await conn.execute<{ item_type_id: string; in_pieces: boolean; on_the_way: number }>(sql`
    select l.item_type_id, l.in_pieces,
           sum(
             case
               when r.status = 'SUBMITTED' then l.quantity_requested
               else
                 (case when l.closed_at is null then greatest(coalesce(l.quantity_approved, 0) - l.quantity_dispatched, 0) else 0 end)
                 + greatest(l.quantity_dispatched - l.quantity_received, 0)
             end
           )::int as on_the_way
    from consumables.stock_requests r
    join consumables.stock_request_lines l on l.request_id = r.id
    where r.requesting_location_id = ${locationId}
      and r.status in ('SUBMITTED', 'APPROVED', 'PARTIALLY_FULFILLED')
    group by l.item_type_id, l.in_pieces
  `);
  const onTheWay = new Map<string, number>();
  const onTheWayPieces = new Map<string, number>();
  for (const r of wayRows) {
    const into = r.in_pieces ? onTheWayPieces : onTheWay;
    into.set(r.item_type_id, (into.get(r.item_type_id) ?? 0) + r.on_the_way);
  }

  return pars
    .map((p) => {
      const way = onTheWay.get(p.itemTypeId) ?? 0;
      const wayPieces = onTheWayPieces.get(p.itemTypeId) ?? 0;
      const pieces = availablePieces.get(p.itemTypeId);
      if (pieces !== undefined && p.packSize > 1) {
        // Everything in pieces, then back to whole packs, rounding the shortfall up.
        const targetPieces = p.target * p.packSize;
        const wayInPieces = way * p.packSize + wayPieces;
        const shortPieces = shortfallToTarget(targetPieces, pieces, wayInPieces);
        return {
          ...p,
          onHand: Math.floor(pieces / p.packSize),
          loosePieces: pieces % p.packSize,
          // "On the way" is shown in packs, rounded up so a part-pack request still shows.
          onTheWay: Math.ceil(wayInPieces / p.packSize),
          quantity: Math.ceil(shortPieces / p.packSize),
          belowMinimum: p.minimum > 0 && pieces <= p.minimum * p.packSize,
        };
      }
      const onHand = available.get(p.itemTypeId) ?? 0;
      return {
        ...p,
        onHand,
        loosePieces: 0,
        onTheWay: way,
        quantity: shortfallToTarget(p.target, onHand, way),
        belowMinimum: isBelowMinimum(onHand, p.minimum),
      };
    })
    .filter((s) => s.quantity > 0);
}
