import "server-only";
import { and, count, desc, eq, inArray, isNull, lte, sql } from "drizzle-orm";
import type { DbOrTx } from "../audit/events";
import { db } from "../db/client";
import { batches, events, itemTypes, links, units } from "../db/schema";
import { pageInfo, type Paged } from "../../lib/pagination";

// What a location holds right now (distribution/stock). Serialized items are counted from the units
// table; bulk items come from the ledger views, so on hand and "out with patients" always agree
// with the events.

export async function getLocationStock(locationId: string, conn: DbOrTx = db()) {
  const serialRows = await conn
    .select({
      itemCode: itemTypes.code,
      itemName: itemTypes.name,
      state: units.state,
      total: count(),
    })
    .from(units)
    .innerJoin(itemTypes, eq(itemTypes.id, units.itemTypeId))
    .where(and(eq(units.currentLocationId, locationId), inArray(units.state, ["IN_STOCK", "ISSUED"])))
    .groupBy(itemTypes.code, itemTypes.name, units.state)
    .orderBy(itemTypes.name);

  const byItem = new Map<string, { itemCode: string; itemName: string; inStock: number; issued: number }>();
  for (const r of serialRows) {
    const row = byItem.get(r.itemCode) ?? { itemCode: r.itemCode, itemName: r.itemName, inStock: 0, issued: 0 };
    if (r.state === "IN_STOCK") row.inStock += Number(r.total);
    else row.issued += Number(r.total);
    byItem.set(r.itemCode, row);
  }

  const quantityRows = await conn.execute<{
    batch_code: string;
    item_name: string;
    on_hand: number;
    loose: number;
    issued_out: number;
    issued_pieces: number;
    used_out: number;
    used_pieces: number;
    unit: string;
    pack_size: number;
    pack_size_confirmed: boolean;
    cold_storage: boolean;
  }>(sql`
    select b.batch_code, b.item_name, b.on_hand, coalesce(lp.loose, 0)::int as loose,
           coalesce(o.outstanding, 0)::int as issued_out,
           coalesce(ip.issued_pieces, 0)::int as issued_pieces,
           coalesce(us.used_out, 0)::int as used_out,
           coalesce(us.used_pieces, 0)::int as used_pieces,
           it.unit_of_measure as unit, it.pack_size, it.pack_size_confirmed, it.cold_storage
    from consumables.v_quantity_balance b
    join consumables.item_types it on it.id = b.item_type_id
    left join consumables.v_quantity_issued_outstanding o
      on o.batch_id = b.batch_id and o.location_id = b.location_id
    left join consumables.v_loose_pieces lp
      on lp.batch_id = b.batch_id and lp.location_id = b.location_id
    left join (
      -- Pieces issued for tests: ISSUED events with quantity 0 and a piece count. Packs issued are in v_quantity_issued_outstanding.
      select batch_id, location_id, sum(pieces)::int as issued_pieces
      from consumables.events
      where type = 'ISSUED' and unit_id is null and quantity = 0 and pieces > 0
      group by batch_id, location_id
    ) ip on ip.batch_id = b.batch_id and ip.location_id = b.location_id
    left join (
      -- Used for test (bench usage): whole units in quantity, loose pieces in pieces with quantity 0.
      select batch_id, location_id,
             coalesce(sum(quantity), 0)::int as used_out,
             coalesce(sum(pieces) filter (where quantity = 0 and pieces > 0), 0)::int as used_pieces
      from consumables.events
      where type = 'USED' and unit_id is null
      group by batch_id, location_id
    ) us on us.batch_id = b.batch_id and us.location_id = b.location_id
    where b.location_id = ${locationId}
      and (b.on_hand <> 0 or coalesce(o.outstanding, 0) <> 0 or coalesce(lp.loose, 0) <> 0 or coalesce(ip.issued_pieces, 0) <> 0
           or coalesce(us.used_out, 0) <> 0 or coalesce(us.used_pieces, 0) <> 0)
    order by b.item_name, b.batch_code
  `);

  return {
    serial: [...byItem.values()],
    quantity: quantityRows.map((r) => ({
      batchCode: r.batch_code,
      itemName: r.item_name,
      // Sealed packs (onHand) and the loose pieces of opened packs, shown together as "9 packs + 80 pieces".
      onHand: r.on_hand,
      loose: r.loose,
      issuedOut: r.issued_out,
      // Pieces issued for tests (the Pieces tab). Packs issued are issuedOut.
      issuedPieces: r.issued_pieces,
      // Used for test at the bench: whole units, and loose pieces.
      usedOut: r.used_out,
      usedPieces: r.used_pieces,
      // For showing piece equivalents beside pack quantities. Display only.
      unit: r.unit,
      packSize: r.pack_size,
      packSizeConfirmed: r.pack_size_confirmed,
      coldStorage: r.cold_storage,
    })),
  };
}

const todayUtc = () => new Date().toISOString().slice(0, 10);

/**
 * How much of each item type a location could send right now, for the stock request check.
 * Same rules as dispatch, so a lab is never allowed to ask for stock the store cannot send:
 *   - bottles: IN_STOCK at the location, batch not expired, and not already on an open transfer
 *   - bulk: ledger balance minus what open drafts have promised, batch not expired
 * Expiry follows isExpired(): stock that expires today still counts today. Every id asked for is in
 * the result, with 0 when nothing is available.
 */
export async function getAvailableByItemType(
  locationId: string,
  itemTypeIds: readonly string[],
  conn: DbOrTx = db(),
  asOf: string = todayUtc(),
): Promise<Map<string, number>> {
  const ids = [...new Set(itemTypeIds)];
  const available = new Map<string, number>(ids.map((id) => [id, 0]));
  if (ids.length === 0) return available;
  const idList = sql.join(
    ids.map((id) => sql`${id}::uuid`),
    sql`, `,
  );

  const serialRows = await conn.execute<{ item_type_id: string; total: number }>(sql`
    select u.item_type_id, count(*)::int as total
    from consumables.units u
    join consumables.batches b on b.id = u.batch_id
    where u.current_location_id = ${locationId}
      and u.state = 'IN_STOCK'
      and u.item_type_id in (${idList})
      and (b.expiry_date is null or b.expiry_date >= ${asOf}::date)
      and not exists (
        select 1 from consumables.transfer_items ti where ti.unit_id = u.id and ti.open
      )
    group by u.item_type_id
  `);
  for (const r of serialRows) available.set(r.item_type_id, (available.get(r.item_type_id) ?? 0) + r.total);

  const quantityRows = await conn.execute<{ item_type_id: string; total: number }>(sql`
    select bal.item_type_id,
           coalesce(sum(greatest(bal.on_hand - coalesce(res.reserved, 0), 0)), 0)::int as total
    from consumables.v_quantity_balance bal
    join consumables.batches b on b.id = bal.batch_id
    left join (
      select ti.batch_id, sum(case when ti.in_pieces then 0 else ti.quantity_dispatched end)::int as reserved
      from consumables.transfer_items ti
      join consumables.transfers t on t.id = ti.transfer_id
      where t.status = 'DRAFT'
        and t.from_location_id = ${locationId}
        and ti.batch_id is not null
      group by ti.batch_id
    ) res on res.batch_id = bal.batch_id
    where bal.location_id = ${locationId}
      and bal.item_type_id in (${idList})
      and (b.expiry_date is null or b.expiry_date >= ${asOf}::date)
    group by bal.item_type_id
  `);
  for (const r of quantityRows) available.set(r.item_type_id, (available.get(r.item_type_id) ?? 0) + r.total);

  return available;
}

/**
 * Like getAvailableByItemType, but counted in loose pieces, for requests that ask for pieces. A location's pieces are
 * its sealed packs times the pack size, plus the loose pieces of opened packs, minus what open drafts have promised
 * (drafts in packs and drafts in pieces both count). Bulk items only: a serialized bottle has no loose pieces.
 * Every id asked for is in the result, with 0 when nothing is available.
 */
export async function getAvailablePiecesByItemType(
  locationId: string,
  itemTypeIds: readonly string[],
  conn: DbOrTx = db(),
  asOf: string = todayUtc(),
): Promise<Map<string, number>> {
  const ids = [...new Set(itemTypeIds)];
  const available = new Map<string, number>(ids.map((id) => [id, 0]));
  if (ids.length === 0) return available;
  const idList = sql.join(
    ids.map((id) => sql`${id}::uuid`),
    sql`, `,
  );

  const rows = await conn.execute<{ item_type_id: string; total: number }>(sql`
    select bal.item_type_id,
           coalesce(sum(greatest(
             (bal.on_hand - coalesce(res.reserved_packs, 0)) * it.pack_size
               + coalesce(lp.loose, 0) - coalesce(res.reserved_pieces, 0),
             0
           )), 0)::int as total
    from consumables.v_quantity_balance bal
    join consumables.batches b on b.id = bal.batch_id
    join consumables.item_types it on it.id = bal.item_type_id
    left join consumables.v_loose_pieces lp
      on lp.batch_id = bal.batch_id and lp.location_id = bal.location_id
    left join (
      select ti.batch_id,
             sum(case when ti.in_pieces then 0 else ti.quantity_dispatched end)::int as reserved_packs,
             sum(case when ti.in_pieces then ti.quantity_dispatched else 0 end)::int as reserved_pieces
      from consumables.transfer_items ti
      join consumables.transfers t on t.id = ti.transfer_id
      where t.status = 'DRAFT'
        and t.from_location_id = ${locationId}
        and ti.batch_id is not null
      group by ti.batch_id
    ) res on res.batch_id = bal.batch_id
    where bal.location_id = ${locationId}
      and bal.item_type_id in (${idList})
      and (b.expiry_date is null or b.expiry_date >= ${asOf}::date)
    group by bal.item_type_id
  `);
  for (const r of rows) available.set(r.item_type_id, r.total);
  return available;
}

/** Bottles currently issued from a location, oldest first, so nothing is forgotten. */
export async function listIssuedAtLocation(locationId: string, limit = 100, conn: DbOrTx = db()) {
  return conn
    .select({
      serial: units.serial,
      itemName: itemTypes.name,
      referenceType: links.referenceType,
      referenceRef: links.referenceRef,
      patientHospitalNo: links.patientHospitalNo,
      issuedAt: links.createdAt,
    })
    .from(units)
    .innerJoin(itemTypes, eq(itemTypes.id, units.itemTypeId))
    .leftJoin(links, and(eq(links.unitId, units.id), isNull(links.clearedAt)))
    .where(and(eq(units.currentLocationId, locationId), eq(units.state, "ISSUED")))
    .orderBy(desc(units.updatedAt))
    .limit(limit);
}

/**
 * Bottles voided at a location, newest first: voided on the shelf (expired, damaged), because the
 * investigation was cancelled, or at a return as unusable. Read from the ledger. With no location it
 * covers every location (a supervisor with no home place).
 */
export async function listVoidedAtLocation(locationId: string | null, limit = 50, conn: DbOrTx = db(), offset = 0) {
  return conn
    .select({
      eventId: events.id,
      serial: units.serial,
      itemName: itemTypes.name,
      reasonCode: events.reasonCode,
      fromState: events.fromState,
      voidedAt: events.occurredAt,
    })
    .from(events)
    .innerJoin(units, eq(units.id, events.unitId))
    .innerJoin(itemTypes, eq(itemTypes.id, units.itemTypeId))
    .where(and(eq(events.type, "VOIDED"), ...(locationId ? [eq(events.locationId, locationId)] : [])))
    .orderBy(desc(events.occurredAt), desc(events.id))
    .limit(limit)
    .offset(offset);
}

/** One page (20 rows) of voided bottles, newest first, plus the total. */
export async function listVoidedAtLocationPage(locationId: string | null, page: number, conn: DbOrTx = db()) {
  const [{ total }] = await conn
    .select({ total: count() })
    .from(events)
    .innerJoin(units, eq(units.id, events.unitId))
    .innerJoin(itemTypes, eq(itemTypes.id, units.itemTypeId))
    .where(and(eq(events.type, "VOIDED"), ...(locationId ? [eq(events.locationId, locationId)] : [])));
  const info = pageInfo(page, Number(total));
  const rows = await listVoidedAtLocation(locationId, info.pageSize, conn, info.offset);
  return { ...info, rows };
}

/**
 * Bottles that came back to a location, newest first: used (RETURNED), unused and restocked
 * (RETURNED_UNUSED) or voided at the return (VOIDED). Read from the ledger, so a bottle that was
 * returned unused and later issued again still shows its earlier return. Each row is one return.
 */
export async function listReturnedAtLocation(locationId: string, limit = 30, conn: DbOrTx = db()) {
  const rows = await conn
    .select({
      eventId: events.id,
      serial: units.serial,
      itemName: itemTypes.name,
      outcome: events.type,
      reasonCode: events.reasonCode,
      patientHospitalNo: links.patientHospitalNo,
      returnedAt: events.occurredAt,
    })
    .from(events)
    .innerJoin(units, eq(units.id, events.unitId))
    .innerJoin(itemTypes, eq(itemTypes.id, units.itemTypeId))
    // The link that was open when the bottle came back: the latest one created before the return.
    .leftJoin(links, and(eq(links.unitId, units.id), lte(links.createdAt, events.occurredAt)))
    .where(
      and(
        eq(events.locationId, locationId),
        eq(events.fromState, "ISSUED"),
        inArray(events.type, ["RETURNED", "RETURNED_UNUSED", "VOIDED"]),
      ),
    )
    .orderBy(desc(events.occurredAt), desc(links.createdAt))
    .limit(limit * 4);

  // One row per return event (the join can repeat it once per older link).
  return [...new Map(rows.map((r) => [r.eventId, r])).values()].slice(0, limit);
}

/** One bottle that is currently out, with the patient it went to (null when no open link names one). */
export interface OutBottle {
  serial: string;
  itemName: string;
  patientHospitalNo: string | null;
  issuedAt: Date | null;
}

/**
 * One page (20 bottles) of the bottles currently issued from a location, most recently moved first. Pages by bottle,
 * not by investigation link, so a bottle linked to several investigations is still one row.
 */
export async function listOutAtLocationPage(locationId: string, page: number, conn: DbOrTx = db()): Promise<Paged<OutBottle>> {
  const where = and(eq(units.currentLocationId, locationId), eq(units.state, "ISSUED"));
  const [{ total }] = await conn.select({ total: count() }).from(units).where(where);
  const info = pageInfo(page, Number(total));

  const bottles = await conn
    .select({ id: units.id, serial: units.serial, itemName: itemTypes.name })
    .from(units)
    .innerJoin(itemTypes, eq(itemTypes.id, units.itemTypeId))
    .where(where)
    .orderBy(desc(units.updatedAt), desc(units.id))
    .limit(info.pageSize)
    .offset(info.offset);
  if (bottles.length === 0) return { ...info, rows: [] };

  const openLinks = await conn
    .select({ unitId: links.unitId, patientHospitalNo: links.patientHospitalNo, issuedAt: links.createdAt })
    .from(links)
    .where(and(inArray(links.unitId, bottles.map((b) => b.id)), isNull(links.clearedAt)))
    .orderBy(desc(links.createdAt));
  const linkOf = new Map<string, (typeof openLinks)[number]>();
  for (const l of openLinks) if (l.unitId && !linkOf.has(l.unitId)) linkOf.set(l.unitId, l);

  return {
    ...info,
    rows: bottles.map((b) => ({
      serial: b.serial,
      itemName: b.itemName,
      patientHospitalNo: linkOf.get(b.id)?.patientHospitalNo ?? null,
      issuedAt: linkOf.get(b.id)?.issuedAt ?? null,
    })),
  };
}

/** One page (20 returns) of the bottles that came back to a location, newest first, plus the total. */
export async function listReturnedAtLocationPage(locationId: string, page: number, conn: DbOrTx = db()) {
  const where = and(
    eq(events.locationId, locationId),
    eq(events.fromState, "ISSUED"),
    inArray(events.type, ["RETURNED", "RETURNED_UNUSED", "VOIDED"]),
  );
  const [{ total }] = await conn
    .select({ total: count() })
    .from(events)
    .innerJoin(units, eq(units.id, events.unitId))
    .innerJoin(itemTypes, eq(itemTypes.id, units.itemTypeId))
    .where(where);
  const info = pageInfo(page, Number(total));

  const rows = await conn
    .select({
      eventId: events.id,
      unitId: units.id,
      serial: units.serial,
      itemName: itemTypes.name,
      outcome: events.type,
      reasonCode: events.reasonCode,
      returnedAt: events.occurredAt,
    })
    .from(events)
    .innerJoin(units, eq(units.id, events.unitId))
    .innerJoin(itemTypes, eq(itemTypes.id, units.itemTypeId))
    .where(where)
    .orderBy(desc(events.occurredAt), desc(events.id))
    .limit(info.pageSize)
    .offset(info.offset);
  if (rows.length === 0) return { ...info, rows: [] };

  // The link that was open when the bottle came back: the latest one created before the return.
  const linkRows = await conn
    .select({ unitId: links.unitId, patientHospitalNo: links.patientHospitalNo, createdAt: links.createdAt })
    .from(links)
    .where(inArray(links.unitId, [...new Set(rows.map((r) => r.unitId))]))
    .orderBy(desc(links.createdAt));

  return {
    ...info,
    rows: rows.map(({ unitId, ...r }) => ({
      ...r,
      patientHospitalNo: linkRows.find((l) => l.unitId === unitId && l.createdAt <= r.returnedAt)?.patientHospitalNo ?? null,
    })),
  };
}

/**
 * One serialized item type at one location, split three ways for the stock item page:
 *   available - IN_STOCK bottles on the shelf
 *   issued    - ISSUED and not yet returned, with the patient they went to
 *   returned  - every return (used, unused or voided), newest first
 * Returns null when the item code is unknown.
 */
export async function getSerialItemAtLocation(locationId: string, itemCode: string, conn: DbOrTx = db()) {
  const [item] = await conn.select({ id: itemTypes.id, code: itemTypes.code, name: itemTypes.name }).from(itemTypes).where(eq(itemTypes.code, itemCode));
  if (!item) return null;

  const available = await conn
    .select({ serial: units.serial, batchCode: batches.code, expiryDate: batches.expiryDate })
    .from(units)
    .innerJoin(batches, eq(batches.id, units.batchId))
    .where(and(eq(units.currentLocationId, locationId), eq(units.itemTypeId, item.id), eq(units.state, "IN_STOCK")))
    .orderBy(units.serial);

  const issuedRows = await conn
    .select({
      serial: units.serial,
      batchCode: batches.code,
      patientHospitalNo: links.patientHospitalNo,
      issuedAt: links.createdAt,
    })
    .from(units)
    .innerJoin(batches, eq(batches.id, units.batchId))
    .leftJoin(links, and(eq(links.unitId, units.id), isNull(links.clearedAt)))
    .where(and(eq(units.currentLocationId, locationId), eq(units.itemTypeId, item.id), eq(units.state, "ISSUED")))
    .orderBy(desc(units.updatedAt));
  // One line per bottle, even if it has several open links.
  const issued = [...new Map(issuedRows.map((r) => [r.serial, r])).values()];

  const returnedRows = await conn
    .select({
      eventId: events.id,
      serial: units.serial,
      batchCode: batches.code,
      outcome: events.type,
      patientHospitalNo: links.patientHospitalNo,
      returnedAt: events.occurredAt,
    })
    .from(events)
    .innerJoin(units, eq(units.id, events.unitId))
    .innerJoin(batches, eq(batches.id, units.batchId))
    .leftJoin(links, and(eq(links.unitId, units.id), lte(links.createdAt, events.occurredAt)))
    .where(
      and(
        eq(events.locationId, locationId),
        eq(units.itemTypeId, item.id),
        eq(events.fromState, "ISSUED"),
        inArray(events.type, ["RETURNED", "RETURNED_UNUSED", "VOIDED"]),
      ),
    )
    .orderBy(desc(events.occurredAt), desc(links.createdAt));
  const returned = [...new Map(returnedRows.map((r) => [r.eventId, r])).values()];

  return { item, available, issued, returned };
}
