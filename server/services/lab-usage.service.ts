import "server-only";
import { randomUUID } from "node:crypto";
import { desc, eq, inArray, isNotNull, or, sql } from "drizzle-orm";
import { appendEvents, type DbOrTx, type NewEvent } from "../audit/events";
import { db } from "../db/client";
import { batches, events, itemTypes, locations, users } from "../db/schema";
import { NotFoundError, ValidationError } from "../domain/errors";
import { resolveWorkLocation } from "../domain/issue-rules";
import type { Actor } from "../domain/types";
import { isPackUnit } from "../../lib/pack-size";
import { usageReasonLabel } from "../../lib/usage-reasons";
import { labUsageSchema, type LabUsageInput } from "../../types/issue";
import { parsePackCode } from "../../lib/serial";
import {
  allocateFromBatches,
  allocatePiecesFromBatches,
  allocateTestsFromContainers,
  type ContainerQueue,
  type ContainerTaken,
} from "./issue.service";
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
// Reagents counted in tests (item type "tests per container" set) work the same way with one piece per test: the lab
// enters the tests done, and a container opened at the bench carries its remaining tests forward to the next entry.
// The part of a container that was not patient tests (quality control, calibration, waste) is entered with a reason.
// When the lab says a container is finished, nothing may be left unexplained in it.
//
// Each container of such a reagent has its own PK label. When an entry opens a new container the lab scans that
// label, so two containers received together are told apart and each one's tests remaining is kept. Stock received
// before container labels existed has none to scan and is taken by earliest expiry, as before.
//
// Bench supplies and reagents counted in tests only. Items tied to a patient go through Issue, and breakage or
// spoilage of anything goes through Void.

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
    /** In loose pieces when `inPieces`, otherwise in the item's own unit. For a reagent counted in tests: the tests done. */
    quantity: number;
    inPieces: boolean;
    batchCodes: string[];
    /** True for a reagent counted in tests. */
    tests: boolean;
    /** Tests not done on patients, with the reason (labelled) and the amount. Empty for other items. */
    accounted: { reason: string; quantity: number }[];
    /** Tests still left in the open container after this entry. Null for items not counted in tests. */
    remaining: number | null;
    /** The labels (PK...) of the containers this entry opened. Empty for other items and for unlabelled stock. */
    openedContainers: string[];
  }[];
}

/**
 * Tests still left in opened containers of one item at one location (loose pieces of batches that have not expired).
 * Opened containers are only ever opened by recording usage or by sending pieces, so this is the "open container".
 */
async function openContainerTests(conn: DbOrTx, itemTypeId: string, locationId: string): Promise<number> {
  const rows = await conn.execute<{ loose: string | number | null }>(sql`
    select coalesce(sum(l.loose), 0) as loose
    from consumables.v_loose_pieces l
    join consumables.batches b on b.id = l.batch_id
    where b.item_type_id = ${itemTypeId}
      and l.location_id = ${locationId}
      and (b.expiry_date is null or b.expiry_date >= ${todayUtc()}::date)
  `);
  return Math.max(Number(rows[0]?.loose ?? 0), 0);
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
        testsPerUnit: itemTypes.testsPerUnit,
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
    const perPatient = itemRows.find((r) => !r.benchSupply && r.testsPerUnit === null);
    if (perPatient) {
      throw new ValidationError(
        `${perPatient.name} is used per patient, so it is issued with the patient on Issue. Breakage or spoilage goes through Void`,
      );
    }

    const nameOf = new Map(itemRows.map((r) => [r.id, r.name]));
    // A reagent counted in tests is entered in tests, one loose piece each, with a container as the pack.
    const testItems = new Map<string, number>(
      itemRows.filter((r) => r.testsPerUnit !== null).map((r) => [r.id, r.testsPerUnit as number]),
    );
    // A pack item (unit "Pack", pack size above 1) is entered in loose pieces: nobody uses a whole pack at once.
    const pieceItems = new Map<string, number>([
      ...itemRows
        .filter((r) => r.testsPerUnit === null && isPackUnit(r.unitOfMeasure) && r.packSize > 1)
        .map((r) => [r.id, r.packSize] as const),
      ...testItems,
    ]);

    const now = new Date();
    const lines: LabUsageResult["lines"] = [];
    // A fixed order, so two people recording at the same time lock the batches in the same order.
    const ordered = [...input.items].sort((a, b) => a.itemTypeId.localeCompare(b.itemTypeId));
    for (const line of ordered) {
      const itemName = nameOf.get(line.itemTypeId) ?? "item";
      const packSize = pieceItems.get(line.itemTypeId);
      const inPieces = packSize !== undefined;
      const counted = testItems.has(line.itemTypeId);

      if (!counted) {
        if (line.quantity < 1) throw new ValidationError(`Enter a quantity of at least 1 for ${itemName}`);
        if (line.accounted.length > 0 || line.finished) {
          throw new ValidationError(`${itemName} is not counted in tests, so it has no reasons to account for`);
        }
      }

      // What this line takes off the shelf, in order: the tests done, then each part that was not a patient test.
      const parts: { pieces: number; kind: "TESTS" | "ACCOUNTED" | null; reason: string | null; note: string | null }[] =
        counted
          ? [
              { pieces: line.quantity, kind: "TESTS" as const, reason: null, note: null },
              ...line.accounted.map((a) => ({
                pieces: a.quantity,
                kind: "ACCOUNTED" as const,
                reason: a.reason as string,
                note: a.note?.trim() || null,
              })),
            ].filter((p) => p.pieces > 0)
          : [{ pieces: line.quantity, kind: null, reason: null, note: null }];
      if (parts.length === 0) {
        throw new ValidationError(`Enter the tests done for ${itemName}, or account for what was used`);
      }

      // The container labels scanned for this line, in the order they were opened. Only a reagent counted in tests has any.
      const scanned = line.containerCodes ?? [];
      if (scanned.length > 0 && !counted) {
        throw new ValidationError(`${itemName} is not counted in tests, so it has no container labels to scan`);
      }
      const queue: ContainerQueue = { codes: [], next: 0 };
      for (const input of scanned) {
        const code = parsePackCode(input);
        if (!code) throw new ValidationError(`${input} is not a container label. Scan the PK label on the container`);
        if (queue.codes.includes(code)) throw new ValidationError(`${code} was scanned twice for ${itemName}`);
        queue.codes.push(code);
      }

      const batchCodes: string[] = [];
      const openedContainers: string[] = [];
      for (const piece of parts) {
        const taken: ContainerTaken[] = counted
          ? await allocateTestsFromContainers(tx, {
              itemTypeId: line.itemTypeId,
              itemName,
              locationId: workLocationId,
              pieces: piece.pieces,
              packSize: packSize as number,
              queue,
            })
          : packSize !== undefined
            ? await allocatePiecesFromBatches(tx, line.itemTypeId, itemName, workLocationId, piece.pieces, packSize)
            : (await allocateFromBatches(tx, line.itemTypeId, itemName, workLocationId, piece.pieces)).map((t) => ({
                ...t,
                opened: 0,
              }));

        const rows: NewEvent[] = [];
        for (const part of taken) {
          if (part.opened > 0) {
            // Opening a pack (or a reagent container) takes it off the sealed balance and adds its pieces to the loose ones.
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
              payload: {
                reason: "OPENED_FOR_PIECES",
                source: "LAB_USAGE",
                ...(part.packCode ? { packCode: part.packCode } : {}),
              },
            });
            if (part.packCode) openedContainers.push(part.packCode);
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
            // No patient. `usedOn` is the day it was used, which can be earlier than the day it was entered; the
            // shelf changed when it was entered (recorded_at). A reagent counted in tests also says whether this is
            // tests done (TESTS) or a part that was not a patient test (ACCOUNTED, with its reason and optional note).
            payload: {
              source: "LAB_USAGE",
              usedOn,
              section,
              ...(piece.kind ? { kind: piece.kind } : {}),
              ...(piece.reason ? { reason: piece.reason } : {}),
              ...(piece.note ? { note: piece.note } : {}),
              ...(part.packCode ? { packCode: part.packCode } : {}),
            },
          });
          batchCodes.push(part.code);
        }
        // Appended before the next part is taken, so that part sees this one's balance.
        await appendEvents(tx, rows);
      }

      // A scanned container that nothing needed was a mistake (wrong label, or more scanned than were opened).
      if (queue.next < queue.codes.length) {
        const unused = queue.codes.slice(queue.next);
        throw new ValidationError(
          `${unused.join(", ")} ${unused.length === 1 ? "was" : "were"} scanned for ${itemName}, but ${unused.length === 1 ? "it was" : "they were"} not needed: the tests entered fit in the container already open. Remove ${unused.length === 1 ? "it" : "them"}, or enter more tests`,
        );
      }

      let remaining: number | null = null;
      if (counted) {
        remaining = await openContainerTests(tx, line.itemTypeId, workLocationId);
        // "Container finished": nothing may be left in it unexplained.
        if (line.finished && remaining > 0) {
          throw new ValidationError(
            `${remaining.toLocaleString("en-GB")} ${remaining === 1 ? "test is" : "tests are"} still left in the container of ${itemName}. Account for ${remaining === 1 ? "it" : "them"} under a reason (quality control, waste...) to finish the container, or untick Container finished to carry ${remaining === 1 ? "it" : "them"} forward`,
          );
        }
      }

      lines.push({
        itemName,
        quantity: counted ? line.quantity : parts.reduce((sum, p) => sum + p.pieces, 0),
        inPieces,
        batchCodes: [...new Set(batchCodes)],
        tests: counted,
        accounted: line.accounted.map((a) => ({ reason: usageReasonLabel(a.reason), quantity: a.quantity })),
        remaining,
        openedContainers,
      });
    }

    return { usedOn, section, lines };
  });
}

/**
 * What is on the shelf now, for each bench supply and each reagent counted in tests at each location:
 * `{ [itemTypeId]: { [locationId]: available } }`. It counts what the entry can actually take: expired batches are
 * left out, and a pack item or reagent (entered in loose pieces or tests) is counted in pieces, sealed packs times
 * pack size plus the loose pieces of opened packs. Items with no stock at a location have no entry, so read a
 * missing one as zero.
 */
export async function listBenchAvailability(conn: DbOrTx = db()): Promise<Record<string, Record<string, number>>> {
  const [items, rows] = await Promise.all([
    conn
      .select({
        id: itemTypes.id,
        unitOfMeasure: itemTypes.unitOfMeasure,
        packSize: itemTypes.packSize,
        testsPerUnit: itemTypes.testsPerUnit,
      })
      .from(itemTypes)
      .where(or(eq(itemTypes.benchSupply, true), isNotNull(itemTypes.testsPerUnit))),
    conn.execute<{ item_type_id: string; location_id: string; sealed: string | number; loose: string | number }>(sql`
      select b.item_type_id, q.location_id, sum(q.on_hand) as sealed, coalesce(sum(l.loose), 0) as loose
      from consumables.v_quantity_balance q
      join consumables.batches b on b.id = q.batch_id
      join consumables.item_types i on i.id = b.item_type_id
      left join consumables.v_loose_pieces l on l.batch_id = q.batch_id and l.location_id = q.location_id
      where (i.bench_supply or i.tests_per_unit is not null) and (b.expiry_date is null or b.expiry_date >= ${todayUtc()}::date)
      group by b.item_type_id, q.location_id
    `),
  ]);
  const packSizeOf = new Map(
    items.map(
      (i) =>
        [i.id, i.testsPerUnit ?? (isPackUnit(i.unitOfMeasure) && i.packSize > 1 ? i.packSize : 1)] as const,
    ),
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

/**
 * Tests left in the container already opened, for each reagent counted in tests at each location:
 * `{ [itemTypeId]: { [locationId]: tests } }`. Expired batches are left out. A missing entry means none open.
 */
export async function listOpenContainerTests(conn: DbOrTx = db()): Promise<Record<string, Record<string, number>>> {
  const rows = await conn.execute<{ item_type_id: string; location_id: string; loose: string | number }>(sql`
    select b.item_type_id, l.location_id, sum(l.loose) as loose
    from consumables.v_loose_pieces l
    join consumables.batches b on b.id = l.batch_id
    join consumables.item_types i on i.id = b.item_type_id
    where i.tests_per_unit is not null and (b.expiry_date is null or b.expiry_date >= ${todayUtc()}::date)
    group by b.item_type_id, l.location_id
  `);
  const result: Record<string, Record<string, number>> = {};
  for (const r of rows) {
    const loose = Math.max(Number(r.loose), 0);
    if (loose <= 0) continue;
    (result[r.item_type_id] ??= {})[r.location_id] = loose;
  }
  return result;
}

/**
 * Sealed containers that carry their own label, for each reagent counted in tests at each location:
 * `{ [itemTypeId]: { [locationId]: sealed labelled containers } }`. Where an item has an entry, opening a new container
 * means scanning its label. A missing entry means stock with no labels (received before they existed): nothing to scan.
 * The count can be a little high when a batch is split over locations; the form only asks whether it is above zero.
 */
export async function listLabelledContainers(conn: DbOrTx = db()): Promise<Record<string, Record<string, number>>> {
  const rows = await conn.execute<{ item_type_id: string; location_id: string; sealed: string | number }>(sql`
    select p.item_type_id, q.location_id, count(*) as sealed
    from consumables.packs p
    join consumables.batches b on b.id = p.batch_id
    join consumables.item_types i on i.id = p.item_type_id
    join consumables.v_quantity_balance q on q.batch_id = p.batch_id and q.on_hand > 0
    where i.tests_per_unit is not null
      and p.pieces_remaining = p.pieces_per_pack
      and (b.expiry_date is null or b.expiry_date >= ${todayUtc()}::date)
    group by p.item_type_id, q.location_id
  `);
  const result: Record<string, Record<string, number>> = {};
  for (const r of rows) {
    const sealed = Number(r.sealed);
    if (sealed <= 0) continue;
    (result[r.item_type_id] ??= {})[r.location_id] = sealed;
  }
  return result;
}

/** One line on the Used for test screen: one entry for one item from one batch. */
export interface RecentUsage {
  id: string;
  itemName: string;
  batchCode: string;
  /** In loose pieces when `inPieces`, otherwise in the item's own unit. For a reagent counted in tests: tests. */
  quantity: number;
  inPieces: boolean;
  /** TESTS (tests done) or ACCOUNTED (a part that was not a patient test). Null for items not counted in tests. */
  kind: string | null;
  /** The reason code of an ACCOUNTED part. */
  reason: string | null;
  note: string | null;
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
      kind: sql<string | null>`${events.payload} ->> 'kind'`,
      reason: sql<string | null>`${events.payload} ->> 'reason'`,
      note: sql<string | null>`${events.payload} ->> 'note'`,
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
    kind: r.kind,
    reason: r.reason,
    note: r.note,
    usedOn: r.usedOn,
    section: r.section,
    locationName: r.locationName,
    enteredByName: r.enteredByName,
    enteredAt: r.enteredAt,
  }));
}
