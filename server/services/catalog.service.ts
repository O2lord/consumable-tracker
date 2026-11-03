import "server-only";
import { and, asc, count, eq, gt, inArray, isNotNull, like, ne } from "drizzle-orm";
import { db } from "../db/client";
import { isUniqueViolation } from "../db/errors";
import { batches, events, itemTypes, locations, testStandardItems, units, voidReasons } from "../db/schema";
import { NotFoundError, ValidationError } from "../domain/errors";
import { PROTECTED_VOID_REASONS } from "../domain/types";
import type {
  ItemTypeInput,
  ItemTypeUpdate,
  LocationInput,
  LocationUpdate,
  VoidReasonInput,
} from "../../types/admin";
import type { DbOrTx } from "../audit/events";
import { suggestLabelCode } from "../../lib/item-label-code";

// Admin-maintained reference data: locations, item types and void reasons.
// The caller checks the manage_* permission; these functions only enforce data rules.

/** Unit states in which a unit still physically exists somewhere and needs accounting for. */
const LIVE_UNIT_STATES = ["IN_STOCK", "IN_TRANSIT", "MISSING_IN_TRANSIT", "ISSUED"] as const;

// --- locations ---------------------------------------------------------------

export async function listLocations(conn: DbOrTx = db()) {
  return conn.select().from(locations).orderBy(asc(locations.code));
}

export async function listActiveLocations(conn: DbOrTx = db()) {
  return conn.select().from(locations).where(eq(locations.active, true)).orderBy(asc(locations.name));
}

function checkExternalMapping(input: { externalSystem?: string; externalId?: string }) {
  if (Boolean(input.externalSystem) !== Boolean(input.externalId)) {
    throw new ValidationError("Set both the EMR system and the EMR id, or leave both blank");
  }
}

export async function createLocation(input: LocationInput, conn: DbOrTx = db()) {
  checkExternalMapping(input);
  try {
    const [row] = await conn
      .insert(locations)
      .values({
        code: input.code,
        name: input.name,
        type: input.type,
        externalSystem: input.externalSystem ?? null,
        externalId: input.externalId ?? null,
        allowUnusedReuse: input.allowUnusedReuse,
        serviceRole: input.serviceRole ?? null,
      })
      .returning();
    return row;
  } catch (err) {
    if (isUniqueViolation(err)) throw new ValidationError(`Location code ${input.code} is already in use`);
    throw err;
  }
}

async function liveUnitsAt(conn: DbOrTx, locationId: string): Promise<number> {
  const [row] = await conn
    .select({ n: count() })
    .from(units)
    .where(and(eq(units.currentLocationId, locationId), inArray(units.state, [...LIVE_UNIT_STATES])));
  return row?.n ?? 0;
}

export async function updateLocation(input: LocationUpdate, conn: DbOrTx = db()) {
  checkExternalMapping(input);
  const [current] = await conn.select().from(locations).where(eq(locations.id, input.id));
  if (!current) throw new NotFoundError("Location");

  if (current.type !== input.type && (await liveUnitsAt(conn, current.id)) > 0) {
    throw new ValidationError("This location holds stock, so its type cannot be changed");
  }

  const [row] = await conn
    .update(locations)
    .set({
      name: input.name,
      type: input.type,
      externalSystem: input.externalSystem ?? null,
      externalId: input.externalId ?? null,
      allowUnusedReuse: input.allowUnusedReuse,
      serviceRole: input.serviceRole ?? null,
    })
    .where(eq(locations.id, input.id))
    .returning();
  return row;
}

export async function setLocationActive(id: string, active: boolean, conn: DbOrTx = db()) {
  const [current] = await conn.select().from(locations).where(eq(locations.id, id));
  if (!current) throw new NotFoundError("Location");
  if (!active && (await liveUnitsAt(conn, id)) > 0) {
    throw new ValidationError("This location still holds stock. Move or account for it before deactivating");
  }
  await conn.update(locations).set({ active }).where(eq(locations.id, id));
}

// --- item types --------------------------------------------------------------

export async function listItemTypes(conn: DbOrTx = db()) {
  return conn.select().from(itemTypes).orderBy(asc(itemTypes.code));
}

export async function listActiveItemTypes(conn: DbOrTx = db()) {
  return conn.select().from(itemTypes).where(eq(itemTypes.active, true)).orderBy(asc(itemTypes.name));
}

/** Label codes other items already use (all of them, or all but `exceptId`), with the item that has each one. */
async function labelCodesInUse(conn: DbOrTx, exceptId?: string): Promise<Map<string, string>> {
  const rows = await conn
    .select({ id: itemTypes.id, labelCode: itemTypes.labelCode, name: itemTypes.name })
    .from(itemTypes)
    .where(isNotNull(itemTypes.labelCode));
  const used = new Map<string, string>();
  for (const r of rows) if (r.labelCode && r.id !== exceptId) used.set(r.labelCode, r.name);
  return used;
}

async function assertLabelCodeFree(conn: DbOrTx, labelCode: string, exceptId?: string) {
  const owner = (await labelCodesInUse(conn, exceptId)).get(labelCode);
  if (owner) throw new ValidationError(`Label code ${labelCode} already belongs to ${owner}. Choose another`);
}

/** A free label code for an item, suggested from its name. */
async function pickLabelCode(conn: DbOrTx, name: string, exceptId?: string): Promise<string> {
  const taken = new Set((await labelCodesInUse(conn, exceptId)).keys());
  const suggested = suggestLabelCode(name, taken);
  if (!suggested) throw new ValidationError("Every label code is taken");
  return suggested;
}

/**
 * The label code that starts this item's bottle serials. A serial item without one is given a suggested code now, so
 * stock can always be received; an admin can set it first, or change it later until bottles carry it.
 */
export async function ensureLabelCode(
  conn: DbOrTx,
  itemType: { id: string; name: string; labelCode: string | null },
): Promise<string> {
  if (itemType.labelCode) return itemType.labelCode;
  const labelCode = await pickLabelCode(conn, itemType.name, itemType.id);
  await conn.update(itemTypes).set({ labelCode }).where(eq(itemTypes.id, itemType.id));
  return labelCode;
}

/** How many bottles of this item already carry its label code on their labels. */
async function bottlesWithLabelCode(conn: DbOrTx, itemTypeId: string, labelCode: string): Promise<number> {
  const [row] = await conn
    .select({ n: count() })
    .from(units)
    .where(and(eq(units.itemTypeId, itemTypeId), like(units.serial, `${labelCode}%`)));
  return row?.n ?? 0;
}

/**
 * What an item type's test setting turns into. A reagent counted in tests (tests per container set) is a quantity item,
 * its pack size is kept equal to the tests per container (a container opened at the bench adds that many loose
 * pieces, one per test), and it is recorded under Used for test, so it counts as a bench supply.
 */
function testCounting(input: { testsPerUnit?: number; trackingMode: string; packSize: number; benchSupply: boolean }) {
  const testsPerUnit = input.testsPerUnit ?? null;
  if (testsPerUnit !== null && input.trackingMode !== "QUANTITY") {
    throw new ValidationError("Tests per container is for quantity items. Serialized bottles are scanned one by one");
  }
  return {
    testsPerUnit,
    packSize: testsPerUnit ?? input.packSize,
    benchSupply: input.benchSupply || testsPerUnit !== null,
  };
}

export async function createItemType(input: ItemTypeInput, conn: DbOrTx = db()) {
  const counting = testCounting(input);
  // Only serial items have bottle labels. One that is not told its code is given a suggestion from its name.
  let labelCode: string | null = null;
  if (input.trackingMode === "SERIAL") {
    if (input.labelCode) {
      await assertLabelCodeFree(conn, input.labelCode);
      labelCode = input.labelCode;
    } else {
      labelCode = await pickLabelCode(conn, input.name);
    }
  }
  try {
    const [row] = await conn
      .insert(itemTypes)
      .values({
        code: input.code,
        labelCode,
        name: input.name,
        category: input.category,
        trackingMode: input.trackingMode,
        containerType: input.containerType ?? null,
        unitOfMeasure: input.unitOfMeasure,
        reorderLevel: input.reorderLevel,
        allowedServiceRoles: input.allowedServiceRoles.length > 0 ? input.allowedServiceRoles : null,
        packSize: counting.packSize,
        packSizeConfirmed: input.packSizeConfirmed,
        packsPerCarton: input.packsPerCarton ?? null,
        testsPerUnit: counting.testsPerUnit,
        coldStorage: input.coldStorage,
        benchSupply: counting.benchSupply,
      })
      .returning();
    return row;
  } catch (err) {
    if (isUniqueViolation(err)) throw new ValidationError(`Item type code ${input.code} is already in use`);
    throw err;
  }
}

export async function updateItemType(input: ItemTypeUpdate, conn: DbOrTx = db()) {
  const counting = testCounting(input);
  const [current] = await conn.select().from(itemTypes).where(eq(itemTypes.id, input.id));
  if (!current) throw new NotFoundError("Item type");

  if (current.trackingMode !== input.trackingMode) {
    const [row] = await conn.select({ n: count() }).from(batches).where(eq(batches.itemTypeId, current.id));
    if ((row?.n ?? 0) > 0) {
      throw new ValidationError("Stock of this type already exists, so its tracking mode cannot be changed");
    }
  }

  // Loose pieces are worked out with the pack size (an opened pack adds one pack's worth of pieces), so once any
  // piece has moved for this item the pack size is fixed: changing it would silently change old balances.
  if (current.packSize !== counting.packSize) {
    const [moved] = await conn
      .select({ n: count() })
      .from(events)
      .innerJoin(batches, eq(batches.id, events.batchId))
      .where(and(eq(batches.itemTypeId, current.id), gt(events.pieces, 0)));
    if ((moved?.n ?? 0) > 0) {
      throw new ValidationError(
        "Pieces of this item have already been opened or sent, so its pack size can no longer be changed",
      );
    }
  }

  // The label code starts every new bottle's serial, so once bottles carry it, it stays. Bottles made before the item
  // had a code (CT...) do not count: they keep their labels, and new ones get the new code.
  let labelCode: string | null = null;
  if (input.trackingMode === "SERIAL") {
    labelCode = input.labelCode ?? current.labelCode;
    if (labelCode && labelCode !== current.labelCode) {
      await assertLabelCodeFree(conn, labelCode, current.id);
      if (current.labelCode && (await bottlesWithLabelCode(conn, current.id, current.labelCode)) > 0) {
        throw new ValidationError(
          `Bottles labelled ${current.labelCode} already exist, so this item's label code can no longer be changed`,
        );
      }
    }
  }

  const [row] = await conn
    .update(itemTypes)
    .set({
      name: input.name,
      labelCode,
      category: input.category,
      trackingMode: input.trackingMode,
      containerType: input.containerType ?? null,
      unitOfMeasure: input.unitOfMeasure,
      reorderLevel: input.reorderLevel,
      allowedServiceRoles: input.allowedServiceRoles.length > 0 ? input.allowedServiceRoles : null,
      // Pack size is display information until pieces move; after that it is locked (checked above).
      packSize: counting.packSize,
      packSizeConfirmed: input.packSizeConfirmed,
      // Only affects deliveries received from now on, so it is never locked.
      packsPerCarton: input.packsPerCarton ?? null,
      testsPerUnit: counting.testsPerUnit,
      coldStorage: input.coldStorage,
      benchSupply: counting.benchSupply,
    })
    .where(eq(itemTypes.id, input.id))
    .returning();
  // A bench supply is never listed against a test, so making an item one takes it off any list it was on.
  // Stock is untouched.
  if (counting.benchSupply && !current.benchSupply) {
    await conn.delete(testStandardItems).where(eq(testStandardItems.itemTypeId, input.id));
  }
  return row;
}

/** Deactivating hides the type from new stock-in; existing stock and history are untouched. */
export async function setItemTypeActive(id: string, active: boolean, conn: DbOrTx = db()) {
  const result = await conn.update(itemTypes).set({ active }).where(eq(itemTypes.id, id)).returning({ id: itemTypes.id });
  if (result.length === 0) throw new NotFoundError("Item type");
}

// --- void reasons ------------------------------------------------------------

export async function listVoidReasons(conn: DbOrTx = db()) {
  return conn.select().from(voidReasons).orderBy(asc(voidReasons.code));
}

export async function createVoidReason(input: VoidReasonInput, conn: DbOrTx = db()) {
  try {
    const [row] = await conn.insert(voidReasons).values({ code: input.code, label: input.label }).returning();
    return row;
  } catch (err) {
    if (isUniqueViolation(err)) throw new ValidationError(`Void reason ${input.code} already exists`);
    throw err;
  }
}

export async function updateVoidReason(id: string, label: string, conn: DbOrTx = db()) {
  const result = await conn.update(voidReasons).set({ label }).where(eq(voidReasons.id, id)).returning({ id: voidReasons.id });
  if (result.length === 0) throw new NotFoundError("Void reason");
}

export async function setVoidReasonActive(id: string, active: boolean, conn: DbOrTx = db()) {
  const [current] = await conn.select().from(voidReasons).where(eq(voidReasons.id, id));
  if (!current) throw new NotFoundError("Void reason");
  if (!active && (PROTECTED_VOID_REASONS as readonly string[]).includes(current.code)) {
    throw new ValidationError(`${current.code} is used by the return and expiry rules and cannot be deactivated`);
  }
  await conn.update(voidReasons).set({ active }).where(and(eq(voidReasons.id, id), ne(voidReasons.active, active)));
}
