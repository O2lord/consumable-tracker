import "server-only";
import { sql } from "drizzle-orm";
import type { DbOrTx } from "../audit/events";
import { db } from "../db/client";
import { daysBetween, fillDays, lastDays, percentOf, stockLevelPercent, type CustomRange, type DayFlow } from "@/lib/dashboard";
import { MAX_LOCATIONS, itemKept, usesBottles, usesBulk, type ItemFilter, type ItemScope, type QuantityUnit, type WidgetKey } from "@/lib/dashboard-prefs";

// Read-only numbers for the dashboard charts and progress bars. Everything is derived from the
// ledger tables and views the reports already use, so the dashboard and the reports always agree.
// Callers decide who may see it: the analytics are across every location, so they need view_reports.

export interface BottlesByState {
  inStore: number;
  issued: number;
  returned: number;
  voided: number;
  inTransit: number;
  /** Bulk items used (issued to a patient or used for a test), in pieces for pack items. */
  used: number;
  total: number;
}

export interface LocationItemRow {
  locationName: string;
  itemName: string;
  inStore: number;
  issued: number;
  returned: number;
}

export interface StockHealthItem {
  itemName: string;
  onHand: number;
  reorderLevel: number;
  /** The item's stock unit and pack size, for showing piece equivalents in the tooltip. Display only. */
  unit: string;
  packSize: number;
  packSizeConfirmed: boolean;
  /** 0 to 100, with the reorder level at 50. See stockLevelPercent(). */
  level: number;
}

export interface StockHealthSummary {
  items: StockHealthItem[];
  belowReorder: number;
  /** Share of items at or above their reorder level, or null when no item has one. */
  healthyPercent: number | null;
  /** Serialized bottles on the shelf (IN_STOCK), bulk items on the shelf, or both, as the widget's scope says. */
  inStore: number;
}

export interface LocationHealth extends StockHealthSummary {
  locationId: string;
  locationName: string;
}

export interface DashboardInsights {
  range: number;
  flow: DayFlow[];
  states: BottlesByState;
  byLocation: LocationItemRow[];
  /** The locations the per-location chart shows (at most MAX_LOCATIONS), including ones with nothing in them. */
  locationNames: string[];
  /** The same locations by id, so the settings can tick them when the person has not picked any yet. */
  locationIds: string[];
  /** Across every location together, plus the same figures for each location on its own. */
  health: StockHealthSummary & { byLocation: LocationHealth[] };
  /** Of the transfers dispatched in the range, the share that has been received (with or without a discrepancy). */
  transferReceivedPercent: number | null;
  /** Of the discrepancies seen (resolved in the range plus still open), the share resolved. */
  discrepancyResolvedPercent: number | null;
  /** Outstanding bottles as a share of everything currently issued. */
  outstandingOfIssuedPercent: number | null;
  /** Of every payment that could not be verified at issue, the share since cleared. */
  unverifiedClearedPercent: number | null;
}

/** The first instant of the first day in the range, and the instant just after its last day, in UTC. */
function rangeBounds(dayList: readonly string[]): { from: string; until: string } {
  const first = Date.parse(`${dayList[0]}T00:00:00.000Z`);
  const last = Date.parse(`${dayList[dayList.length - 1]}T00:00:00.000Z`);
  return { from: new Date(first).toISOString(), until: new Date(last + 86_400_000).toISOString() };
}

/** Which items each dashboard widget counts. Bottles only when left out, which is how the dashboard first worked. */
export interface InsightScopes {
  states: ItemScope;
  locations: ItemScope;
  health: ItemScope;
}

export async function getDashboardInsights(
  args: {
    days: number;
    /** A custom range (first and last day, inclusive). It takes the place of `days` when given. */
    custom?: CustomRange;
    outstanding: number;
    scopes?: Partial<InsightScopes>;
    /** Whether bulk quantities are shown as packs or pieces, per widget. Pieces when left out. */
    units?: Partial<Record<WidgetKey, QuantityUnit>>;
    /** Which item types each widget shows. Every item when left out. */
    items?: Partial<Record<WidgetKey, ItemFilter>>;
    /** Which locations each widget shows (the per-location and stock health widgets). Every location when left out. */
    places?: Partial<Record<WidgetKey, ItemFilter>>;
  },
  conn: DbOrTx = db(),
  now: Date = new Date(),
): Promise<DashboardInsights> {
  // The days the charts and shares cover: the custom range when one is given, otherwise the last `days` days.
  const dayList = args.custom ? daysBetween(args.custom.from, args.custom.to) : lastDays(args.days, now);
  const { from, until } = rangeBounds(dayList);
  const scopes: InsightScopes = { states: "bottles", locations: "bottles", health: "bottles", ...args.scopes };

  const [flowRows, stateRows, locationRows, healthRows, transferRows, discrepancyRows, unverifiedRows, placeRows] =
    await Promise.all([
      conn.execute<{ day: string; issued: number; returned: number }>(sql`
        select to_char(e.occurred_at at time zone 'UTC', 'YYYY-MM-DD') as day,
               coalesce(sum(e.quantity) filter (where e.type = 'ISSUED'), 0)::int as issued,
               coalesce(sum(e.quantity) filter (where e.type in ('RETURNED', 'RETURNED_UNUSED')), 0)::int as returned
        from consumables.events e
        where e.occurred_at >= ${from}::timestamptz
          and e.occurred_at < ${until}::timestamptz
          and e.type in ('ISSUED', 'RETURNED', 'RETURNED_UNUSED')
        group by 1
      `),
      conn.execute<{ state: string; item_type_id: string; n: number }>(sql`
        select state, item_type_id, count(*)::int as n from consumables.units group by state, item_type_id
      `),
      conn.execute<{ location_id: string; location_name: string; item_type_id: string; item_name: string; state: string; n: number }>(sql`
        select l.id as location_id, l.name as location_name, it.id as item_type_id, it.name as item_name, u.state, count(*)::int as n
        from consumables.units u
        join consumables.locations l on l.id = u.current_location_id
        join consumables.item_types it on it.id = u.item_type_id
        where u.state in ('IN_STOCK', 'ISSUED', 'RETURNED')
        group by l.id, l.name, it.id, it.name, u.state
        order by l.name, it.name
      `),
      conn.execute<{
        location_id: string;
        location_name: string;
        item_type_id: string;
        item_name: string;
        reorder_level: number;
        on_hand: number;
        unit: string;
        pack_size: number;
        pack_size_confirmed: boolean;
        tracking_mode: string;
      }>(sql`
        with serial as (
          select current_location_id as location_id, item_type_id, count(*)::int as on_hand
          from consumables.units where state = 'IN_STOCK' group by 1, 2
        ),
        bulk as (
          select location_id, item_type_id, greatest(sum(on_hand), 0)::int as on_hand
          from consumables.v_quantity_balance group by 1, 2
        )
        select l.id as location_id,
               l.name as location_name,
               it.id as item_type_id,
               it.name as item_name,
               it.reorder_level,
               (coalesce(s.on_hand, 0) + coalesce(b.on_hand, 0))::int as on_hand,
               it.unit_of_measure as unit,
               it.pack_size,
               it.pack_size_confirmed,
               it.tracking_mode
        from consumables.locations l
        cross join consumables.item_types it
        left join serial s on s.location_id = l.id and s.item_type_id = it.id
        left join bulk b on b.location_id = l.id and b.item_type_id = it.id
        where l.active and it.active and it.reorder_level > 0
        order by l.name, it.name
      `),
      conn.execute<{ total: number; received: number }>(sql`
        select count(*)::int as total,
               (count(*) filter (where status in ('RECEIVED', 'RECEIVED_WITH_DISCREPANCY', 'DISCREPANCY_RESOLVED')))::int as received
        from consumables.transfers
        where dispatched_at >= ${from}::timestamptz and dispatched_at < ${until}::timestamptz
      `),
      conn.execute<{ resolved: number; open: number }>(sql`
        select
          (select count(*)::int from consumables.transfer_items
            where resolution is not null and resolved_at >= ${from}::timestamptz and resolved_at < ${until}::timestamptz) as resolved,
          (select count(*)::int from consumables.v_open_discrepancies) as open
      `),
      conn.execute<{ total: number; cleared: number }>(sql`
        select count(*)::int as total,
               (count(*) filter (where cleared_at is not null))::int as cleared
        from consumables.v_unverified_issues
      `),
      conn.execute<{ id: string; name: string }>(sql`
        select id, name from consumables.locations where active order by name
      `),
    ]);

  // Bulk items per batch and location: what is on the shelf now, and what has been used (issued to a patient or
  // department, or recorded as used for a test). A pack item counts in pieces so packs and loose pieces add up.
  // It reads several ledger views, so it runs on its own after the cheap queries above (not alongside them), and
  // only when a widget is set to count bulk items.
  const needsBulk = usesBulk(scopes.states) || usesBulk(scopes.locations) || usesBulk(scopes.health);
  const bulkRaw = needsBulk
    ? await conn.execute<{ location_id: string; location_name: string; item_type_id: string; item_name: string; shelf: number; used: number; f: number }>(sql`
        select l.id as location_id, l.name as location_name, it.id as item_type_id, it.name as item_name, pf.f::int as f,
               (greatest(g.on_hand, 0) * pf.f + g.loose)::int as shelf,
               ((g.outstanding + g.used_out) * pf.f + g.issued_pieces + g.used_pieces)::int as used
        from (
          -- One pass over the ledger for every figure. These are the same sums the stock views use
          -- (v_quantity_balance, v_loose_pieces, v_quantity_issued_outstanding), without joining three views that
          -- each scan the whole event table.
          select e.batch_id, e.location_id,
                 coalesce(sum(case
                   when e.type in ('STOCKED', 'RECEIVED', 'FOUND', 'ADJUSTED', 'RETURNED_UNUSED') then e.quantity
                   when e.type in ('DISPATCHED', 'ISSUED', 'USED', 'OPENED') then -e.quantity
                   when e.type = 'WASTED' and coalesce(e.payload ->> 'source', '') <> 'RETURN' then -e.quantity
                   else 0
                 end), 0)::int as on_hand,
                 coalesce(sum(case when e.pieces > 0 then
                   case
                     when e.type in ('OPENED', 'RECEIVED', 'FOUND') then e.pieces
                     when e.type in ('DISPATCHED', 'ISSUED', 'USED') then -e.pieces
                     when e.type = 'ADJUSTED' and coalesce(e.payload ->> 'piecesDirection', '') = 'REMOVE' then -e.pieces
                     when e.type = 'ADJUSTED' then e.pieces
                     else 0
                   end
                 else 0 end), 0)::int as loose,
                 coalesce(sum(case
                   when e.type = 'ISSUED' then e.quantity
                   when e.type = 'RETURNED_UNUSED' then -e.quantity
                   when e.type = 'WASTED' and e.payload ->> 'source' = 'RETURN' then -e.quantity
                   else 0
                 end), 0)::int as outstanding,
                 coalesce(sum(e.pieces) filter (where e.type = 'ISSUED' and e.quantity = 0 and e.pieces > 0), 0)::int as issued_pieces,
                 coalesce(sum(e.quantity) filter (where e.type = 'USED'), 0)::int as used_out,
                 coalesce(sum(e.pieces) filter (where e.type = 'USED' and e.quantity = 0 and e.pieces > 0), 0)::int as used_pieces
          from consumables.events e
          where e.unit_id is null and e.batch_id is not null
          group by e.batch_id, e.location_id
        ) g
        join consumables.batches b on b.id = g.batch_id
        join consumables.item_types it on it.id = b.item_type_id
        join consumables.locations l on l.id = g.location_id
        cross join lateral (
          select case when lower(trim(it.unit_of_measure)) in ('pack', 'packs') and it.pack_size > 1
                      then it.pack_size else 1 end as f
        ) pf
      `)
    : [];

  // Which item types a widget shows (every one unless the person picked some).
  const keeps = (widget: WidgetKey, itemTypeId: string) => itemKept(args.items?.[widget] ?? null, itemTypeId);
  // Which locations a widget shows (every one unless the person picked some).
  const keepsPlace = (widget: WidgetKey, locationId: string) => itemKept(args.places?.[widget] ?? null, locationId);
  const stateCount = (widget: WidgetKey | null, ...names: string[]) =>
    stateRows
      .filter((r) => names.includes(r.state) && (widget === null || keeps(widget, r.item_type_id)))
      .reduce((sum, r) => sum + r.n, 0);
  // Bottles by state for the state widget (only the items picked there).
  const bottleStates = {
    inStore: stateCount("states", "IN_STOCK"),
    issued: stateCount("states", "ISSUED"),
    returned: stateCount("states", "RETURNED"),
    voided: stateCount("states", "VOIDED", "WRITTEN_OFF"),
    inTransit: stateCount("states", "IN_TRANSIT", "MISSING_IN_TRANSIT"),
    total: stateRows.filter((r) => keeps("states", r.item_type_id)).reduce((sum, r) => sum + r.n, 0),
  };
  // Every bottle currently issued, whatever the widgets show: the base of the outstanding share.
  const allBottlesIssued = stateCount(null, "ISSUED");
  const bulkList = Array.from(bulkRaw);
  // A bulk quantity is held in pieces. A widget set to packs divides a pack item's pieces by its pack size (the
  // factor `f`, 1 for anything that is not a pack item, which therefore stays as it is).
  const r1 = (n: number) => Math.round(n * 10) / 10;
  const convert = (n: number, f: number, widget: WidgetKey) => ((args.units?.[widget] ?? "pieces") === "packs" && f > 1 ? n / f : n);
  const bulkTotal = (field: "shelf" | "used", widget: WidgetKey) =>
    r1(
      bulkList
        .filter((r) => keeps(widget, r.item_type_id) && keepsPlace(widget, r.location_id))
        .reduce((n, r) => n + convert(Math.max(r[field], 0), r.f, widget), 0),
    );
  const bulkShelfTotal = bulkTotal("shelf", "states");
  const bulkUsedTotal = bulkTotal("used", "states");

  // What the state widget shows: bottles, bulk items, or both. Bulk items have no per-item states, so they are
  // on the shelf or used (issued to a patient or used for a test).
  const stateBottles = usesBottles(scopes.states);
  const stateBulk = usesBulk(scopes.states);
  const states: BottlesByState = {
    inStore: (stateBottles ? bottleStates.inStore : 0) + (stateBulk ? bulkShelfTotal : 0),
    issued: stateBottles ? bottleStates.issued : 0,
    returned: stateBottles ? bottleStates.returned : 0,
    voided: stateBottles ? bottleStates.voided : 0,
    inTransit: stateBottles ? bottleStates.inTransit : 0,
    used: stateBulk ? bulkUsedTotal : 0,
    total: r1((stateBottles ? bottleStates.total : 0) + (stateBulk ? bulkShelfTotal + bulkUsedTotal : 0)),
  };

  // One row per location and item, with the three counts the chart stacks. Bulk rows use "issued" for what was used.
  const grouped = new Map<string, LocationItemRow>();
  if (usesBottles(scopes.locations)) {
    for (const r of locationRows) {
      if (!keeps("locations", r.item_type_id)) continue;
      const key = `${r.location_name}\u0000${r.item_name}`;
      const row = grouped.get(key) ?? { locationName: r.location_name, itemName: r.item_name, inStore: 0, issued: 0, returned: 0 };
      if (r.state === "IN_STOCK") row.inStore += r.n;
      else if (r.state === "ISSUED") row.issued += r.n;
      else row.returned += r.n;
      grouped.set(key, row);
    }
  }
  if (usesBulk(scopes.locations)) {
    for (const r of bulkList) {
      if (!keeps("locations", r.item_type_id)) continue;
      if (r.shelf <= 0 && r.used <= 0) continue;
      const key = `${r.location_name}\u0000${r.item_name}`;
      const row = grouped.get(key) ?? { locationName: r.location_name, itemName: r.item_name, inStore: 0, issued: 0, returned: 0 };
      row.inStore += convert(Math.max(r.shelf, 0), r.f, "locations");
      row.issued += convert(Math.max(r.used, 0), r.f, "locations");
      grouped.set(key, row);
    }
  }

  // The per-location chart shows at most MAX_LOCATIONS locations: the ones the person picked, or by default the ones
  // holding the most. A picked location with nothing in it still shows, as 0.
  const totalByName = new Map<string, number>();
  for (const r of grouped.values()) {
    totalByName.set(r.locationName, (totalByName.get(r.locationName) ?? 0) + r.inStore + r.issued + r.returned);
  }
  const activePlaces = Array.from(placeRows);
  const pickedPlaces = args.places?.locations ? activePlaces.filter((l) => keepsPlace("locations", l.id)) : null;
  const shownPlaces = (
    pickedPlaces ??
    [...activePlaces].sort((a, b) => (totalByName.get(b.name) ?? 0) - (totalByName.get(a.name) ?? 0) || a.name.localeCompare(b.name))
  ).slice(0, MAX_LOCATIONS);
  const shownNames = new Set(shownPlaces.map((l) => l.name));

  // Health is the share of items at or above their reorder level. The reorder level belongs to the item,
  // so for one location it is applied to what that location holds. The pooled view adds every location up.
  type HealthRow = {
    location_id: string;
    location_name: string;
    item_type_id: string;
    item_name: string;
    reorder_level: number;
    on_hand: number;
    unit: string;
    pack_size: number;
    pack_size_confirmed: boolean;
    tracking_mode: string;
  };
  // Bulk items are the ones counted by quantity; everything else is a serialized bottle.
  const healthList: HealthRow[] = Array.from(healthRows).filter(
    (r) =>
      keeps("health", r.item_type_id) &&
      keepsPlace("health", r.location_id) &&
      (r.tracking_mode === "QUANTITY" ? usesBulk(scopes.health) : usesBottles(scopes.health)),
  );

  const toItem = (r: Pick<HealthRow, "item_name" | "reorder_level" | "unit" | "pack_size" | "pack_size_confirmed"> & { on_hand: number }): StockHealthItem => ({
    itemName: r.item_name,
    onHand: r.on_hand,
    reorderLevel: r.reorder_level,
    unit: r.unit,
    packSize: r.pack_size,
    packSizeConfirmed: r.pack_size_confirmed,
    level: stockLevelPercent(r.on_hand, r.reorder_level) ?? 0,
  });
  const summarize = (list: StockHealthItem[], inStore: number): StockHealthSummary => {
    const belowReorder = list.filter((i) => i.onHand < i.reorderLevel).length;
    return { items: list, belowReorder, healthyPercent: percentOf(list.length - belowReorder, list.length), inStore };
  };

  const rowsByLocation = new Map<string, { name: string; rows: HealthRow[] }>();
  const pooledByItem = new Map<string, HealthRow>();
  for (const r of healthList) {
    const entry = rowsByLocation.get(r.location_id) ?? { name: r.location_name, rows: [] };
    entry.rows.push(r);
    rowsByLocation.set(r.location_id, entry);
    const sum = pooledByItem.get(r.item_name);
    if (sum) sum.on_hand += r.on_hand;
    else pooledByItem.set(r.item_name, { ...r });
  }

  // What is in store at a location for the health card: bottles, bulk items, or both, as the card's scope says.
  const inStoreAt = (locationName: string) =>
    (usesBottles(scopes.health)
      ? locationRows
          .filter((r) => r.location_name === locationName && r.state === "IN_STOCK" && keeps("health", r.item_type_id))
          .reduce((n, r) => n + r.n, 0)
      : 0) +
    (usesBulk(scopes.health)
      ? r1(
          bulkList
            .filter((r) => r.location_name === locationName && keeps("health", r.item_type_id))
            .reduce((n, r) => n + convert(Math.max(r.shelf, 0), r.f, "health"), 0),
        )
      : 0);
  const healthBottlesInStore = locationRows
    .filter((r) => r.state === "IN_STOCK" && keeps("health", r.item_type_id) && keepsPlace("health", r.location_id))
    .reduce((n, r) => n + r.n, 0);
  const inStoreEverywhere =
    (usesBottles(scopes.health) ? healthBottlesInStore : 0) + (usesBulk(scopes.health) ? bulkTotal("shelf", "health") : 0);

  const pooledHealth = summarize(Array.from(pooledByItem.values(), toItem), inStoreEverywhere);
  const healthByLocation: LocationHealth[] = Array.from(rowsByLocation, ([locationId, { name, rows }]) => ({
    locationId,
    locationName: name,
    ...summarize(rows.map(toItem), inStoreAt(name)),
  }));

  const transfer = transferRows[0];
  const discrepancy = discrepancyRows[0];
  const unverified = unverifiedRows[0];

  return {
    range: dayList.length,
    flow: fillDays(
      dayList,
      Array.from(flowRows).map((r) => ({ day: r.day, issued: r.issued, returned: r.returned })),
    ),
    states,
    byLocation: [...grouped.values()]
      .filter((r) => shownNames.has(r.locationName))
      .map((r) => ({ ...r, inStore: r1(r.inStore), issued: r1(r.issued), returned: r1(r.returned) })),
    // The locations the chart shows, so none goes missing and the settings can tick the same ones.
    locationNames: shownPlaces.map((l) => l.name).sort((a, b) => a.localeCompare(b)),
    locationIds: shownPlaces.map((l) => l.id),
    health: { ...pooledHealth, byLocation: healthByLocation },
    transferReceivedPercent: percentOf(transfer?.received ?? 0, transfer?.total ?? 0),
    discrepancyResolvedPercent: percentOf(discrepancy?.resolved ?? 0, (discrepancy?.resolved ?? 0) + (discrepancy?.open ?? 0)),
    outstandingOfIssuedPercent: percentOf(args.outstanding, allBottlesIssued),
    unverifiedClearedPercent: percentOf(unverified?.cleared ?? 0, unverified?.total ?? 0),
  };
}
