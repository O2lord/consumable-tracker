import "server-only";
import { randomUUID } from "node:crypto";
import { desc, eq, inArray, sql } from "drizzle-orm";
import { appendEvents, type DbOrTx, type NewEvent } from "../audit/events";
import { db } from "../db/client";
import { batches, events, itemTypes, locations, users } from "../db/schema";
import { NotFoundError, ValidationError } from "../domain/errors";
import { resolveWorkLocation } from "../domain/issue-rules";
import type { Actor } from "../domain/types";
import { isPackUnit } from "../../lib/pack-size";
import { labUsageSchema, type LabUsageInput } from "../../types/issue";
import { allocateFromBatches, allocatePiecesFromBatches } from "./issue.service";
import { pageInfo, type Paged } from "../../lib/pagination";

// Used for test: what the lab used at the bench, entered by the lab (usually at the end of the day) with no patient.
// "1 pack cotton wool, 10 AHG". Callers check the `record_usage` permission.
//
// Each line takes stock off the shelf the same way an issue does (earliest expiry first, expired batches skipped, a
// sealed pack opened when pieces are entered), but it is written as a USED event, not ISSUED. USED is not in
// v_quantity_issued_outstanding, so used stock never shows as "out" and can never be returned: nobody owes the
// lab anything for it. Stock counts compare the shelf to received minus issued and used, so honest daily entries
// keep the variance near zero and a gap shows up on the count variance report.
//
// Bench supplies only. Items tied to a patient go through Issue, and breakage or spoilage of anything goes through Void.

/** How many days back an entry may be dated, so a missed day can be filled in but a typo cannot rewrite last year. */
export const MAX_BACKDATE_DAYS = 31;

const todayUtc = () => new Date().toISOString().slice(0, 10);

/** The day an entry is for. Today when left out; never in the future and never older than MAX_BACKDATE_DAYS. */
function resolveUsedOn(input: string | undefined): string {
  const today = todayUtc();
  if (!input) return today;
  const parsed = new Date(`${input}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== input) {
    throw new ValidationError("Enter a valid date");
  }
  if (input > today) throw new ValidationError("The date cannot be in the future");
  const oldest = new Date(`${today}T00:00:00.000Z`);
  oldest.setUTCDate(oldest.getUTCDate() - MAX_BACKDATE_DAYS);
  if (parsed < oldest) {
    throw new ValidationError(`The date cannot be more than ${MAX_BACKDATE_DAYS} days ago`);
  }
  return input;
}

export interface LabUsageResult {
  usedOn: string;
  section: string | null;
  lines: {
    itemName: string;
    /** In loose pieces when `inPieces`, otherwise in the item's own unit. */
    quantity: number;
    inPieces: boolean;
    batchCodes: string[];
  }[];
}

/** Record what the lab used. Every line is taken from the shelf in one transaction: if one is short, none are. */
export async function recordLabUsage(rawInput: LabUsageInput, actor: Actor, conn: DbOrTx = db()): Promise<LabUsageResult> {
  const parsed = labUsageSchema.safeParse(rawInput);
  if (!parsed.success) throw new ValidationError(parsed.error.issues.map((i) => i.message).join("; "));
  const input = parsed.data;

  const workLocationId = resolveWorkLocation(actor, input.locationId);
  const usedOn = resolveUsedOn(input.usedOn);
  const section = input.section?.trim() || null;

  return conn.transaction(async (tx) => {
    const itemRows = await tx
      .select({
        id: itemTypes.id,
        name: itemTypes.name,
        trackingMode: itemTypes.trackingMode,
        unitOfMeasure: itemTypes.unitOfMeasure,
        packSize: itemTypes.packSize,
        benchSupply: itemTypes.benchSupply,
      })
      .from(itemTypes)
      .where(
        inArray(
          itemTypes.id,
          input.items.map((i) => i.itemTypeId),
        ),
      );
    if (itemRows.length !== input.items.length) throw new NotFoundError("Item type");

    const serialized = itemRows.find((r) => r.trackingMode !== "QUANTITY");
    if (serialized) {
      throw new ValidationError(
        `${serialized.name} is a serialized item. Scan and issue it with Issue instead of recording it here`,
      );
    }
    const perPatient = itemRows.find((r) => !r.benchSupply);
    if (perPatient) {
      throw new ValidationError(
        `${perPatient.name} is used per patient, so it is issued with the patient on Issue. Breakage or spoilage goes through Void`,
      );
    }

    const nameOf = new Map(itemRows.map((r) => [r.id, r.name]));
    // A pack item (unit "Pack", pack size above 1) is entered in loose pieces: nobody uses a whole pack at once.
    const pieceItems = new Map<string, number>(
      itemRows.filter((r) => isPackUnit(r.unitOfMeasure) && r.packSize > 1).map((r) => [r.id, r.packSize]),
    );

    const now = new Date();
    const lines: LabUsageResult["lines"] = [];
    // A fixed order, so two people recording at the same time lock the batches in the same order.
    const ordered = [...input.items].sort((a, b) => a.itemTypeId.localeCompare(b.itemTypeId));
    for (const line of ordered) {
      const itemName = nameOf.get(line.itemTypeId) ?? "item";
      const packSize = pieceItems.get(line.itemTypeId);
      const inPieces = packSize !== undefined;
      const taken =
        packSize !== undefined
          ? await allocatePiecesFromBatches(tx, line.itemTypeId, itemName, workLocationId, line.quantity, packSize)
          : (await allocateFromBatches(tx, line.itemTypeId, itemName, workLocationId, line.quantity)).map((t) => ({
              ...t,
              opened: 0,
            }));

      const rows: NewEvent[] = [];
      for (const part of taken) {
        if (part.opened > 0) {
          // Opening a pack takes it off the sealed balance and adds its pieces to the loose ones.
          rows.push({
            id: randomUUID(),
            unitId: null,
            batchId: part.batchId,
            quantity: part.opened,
            pieces: part.opened * (packSize ?? 1),
            type: "OPENED",
            locationId: workLocationId,
            userId: actor.userId,
            occurredAt: now,
            payload: { reason: "OPENED_FOR_PIECES", source: "LAB_USAGE" },
          });
        }
        rows.push({
          id: randomUUID(),
          unitId: null,
          batchId: part.batchId,
          // Pieces move no whole packs: the quantity is 0 and `pieces` carries the amount.
          quantity: inPieces ? 0 : part.quantity,
          ...(inPieces ? { pieces: part.quantity } : {}),
          type: "USED",
          locationId: workLocationId,
          userId: actor.userId,
          occurredAt: now,
          // No patient and no free text: the ledger can never be edited. `usedOn` is the day it was used, which can
          // be earlier than the day it was entered; the shelf changed when it was entered (recorded_at).
          payload: { source: "LAB_USAGE", usedOn, section },
        });
      }
      await appendEvents(tx, rows);
      lines.push({ itemName, quantity: line.quantity, inPieces, batchCodes: taken.map((t) => t.code) });
    }

    return { usedOn, section, lines };
  });
}

/**
 * What is on the shelf now, for each bench supply at each location: `{ [itemTypeId]: { [locationId]: available } }`.
 * It counts what the entry can actually take: expired batches are left out, and a pack item (entered in loose
 * pieces) is counted in pieces, sealed packs times pack size plus the loose pieces of opened packs. Items with no
 * stock at a location have no entry, so read a missing one as zero.
 */
export async function listBenchAvailability(conn: DbOrTx = db()): Promise<Record<string, Record<string, number>>> {
  const [items, rows] = await Promise.all([
    conn
      .select({ id: itemTypes.id, unitOfMeasure: itemTypes.unitOfMeasure, packSize: itemTypes.packSize })
      .from(itemTypes)
      .where(eq(itemTypes.benchSupply, true)),
    conn.execute<{ item_type_id: string; location_id: string; sealed: string | number; loose: string | number }>(sql`
      select b.item_type_id, q.location_id, sum(q.on_hand) as sealed, coalesce(sum(l.loose), 0) as loose
      from consumables.v_quantity_balance q
      join consumables.batches b on b.id = q.batch_id
      join consumables.item_types i on i.id = b.item_type_id
      left join consumables.v_loose_pieces l on l.batch_id = q.batch_id and l.location_id = q.location_id
      where i.bench_supply and (b.expiry_date is null or b.expiry_date >= ${todayUtc()}::date)
      group by b.item_type_id, q.location_id
    `),
  ]);
  const packSizeOf = new Map(
    items.map((i) => [i.id, isPackUnit(i.unitOfMeasure) && i.packSize > 1 ? i.packSize : 1] as const),
  );

  const result: Record<string, Record<string, number>> = {};
  for (const r of rows) {
    const packSize = packSizeOf.get(r.item_type_id) ?? 1;
    const available = Math.max(Number(r.sealed), 0) * packSize + (packSize > 1 ? Math.max(Number(r.loose), 0) : 0);
    if (available <= 0) continue;
    (result[r.item_type_id] ??= {})[r.location_id] = available;
  }
  return result;
}

/** One line on the Used for test screen: one entry for one item from one batch. */
export interface RecentUsage {
  id: string;
  itemName: string;
  batchCode: string;
  /** In loose pieces when `inPieces`, otherwise in the item's own unit. */
  quantity: number;
  inPieces: boolean;
  usedOn: string | null;
  section: string | null;
  locationName: string;
  enteredByName: string;
  enteredAt: Date;
}

/** One page (20 entries) of the Used for test list, newest first, plus the total. */
export async function listLabUsagePage(locationId: string | undefined, page: number, conn: DbOrTx = db()): Promise<Paged<RecentUsage>> {
  const [{ total }] = await conn
    .select({ total: sql<number>`count(*)::int` })
    .from(events)
    .innerJoin(batches, eq(batches.id, events.batchId))
    .innerJoin(itemTypes, eq(itemTypes.id, batches.itemTypeId))
    .innerJoin(locations, eq(locations.id, events.locationId))
    .innerJoin(users, eq(users.id, events.userId))
    .where(locationId ? sql`${events.type} = 'USED' and ${events.locationId} = ${locationId}` : sql`${events.type} = 'USED'`);
  const info = pageInfo(page, total);
  const rows = await listRecentLabUsage(locationId, info.pageSize, conn, info.offset);
  return { ...info, rows };
}

/**
 * The latest entries, newest first. Pass a location to see only that one; leave it out to see every location
 * (supervisors and admins, who can work anywhere).
 */
export async function listRecentLabUsage(
  locationId?: string,
  limit = 20,
  conn: DbOrTx = db(),
  offset = 0,
): Promise<RecentUsage[]> {
  const rows = await conn
    .select({
      id: events.id,
      itemName: itemTypes.name,
      batchCode: batches.code,
      quantity: events.quantity,
      pieces: events.pieces,
      usedOn: sql<string | null>`${events.payload} ->> 'usedOn'`,
      section: sql<string | null>`${events.payload} ->> 'section'`,
      locationName: locations.name,
      enteredByName: users.name,
      enteredAt: events.recordedAt,
    })
    .from(events)
    .innerJoin(batches, eq(batches.id, events.batchId))
    .innerJoin(itemTypes, eq(itemTypes.id, batches.itemTypeId))
    .innerJoin(locations, eq(locations.id, events.locationId))
    .innerJoin(users, eq(users.id, events.userId))
    .where(locationId ? sql`${events.type} = 'USED' and ${events.locationId} = ${locationId}` : sql`${events.type} = 'USED'`)
    .orderBy(desc(events.recordedAt), desc(events.id))
    .limit(limit)
    .offset(offset);

  return rows.map((r) => ({
    id: r.id,
    itemName: r.itemName,
    batchCode: r.batchCode,
    // A piece entry has quantity 0 and carries its amount in `pieces`.
    quantity: r.quantity === 0 ? r.pieces : r.quantity,
    inPieces: r.quantity === 0 && r.pieces > 0,
    usedOn: r.usedOn,
    section: r.section,
    locationName: r.locationName,
    enteredByName: r.enteredByName,
    enteredAt: r.enteredAt,
  }));
}
