import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Tx } from "../../server/audit/events";
import { db, sql as pg } from "../../server/db/client";
import { batches, deliveries, events, itemTypes, locations, units, users } from "../../server/db/schema";
import { NotFoundError, ValidationError } from "../../server/domain/errors";
import type { PharmacyGrnLine } from "../../server/integrations/pharmacy";
import { generateDeliveryCode } from "../../lib/serial";
import { createDelivery, getDeliveryByCode } from "../../server/services/delivery.service";
import { getGrnReceipt, listGrnSummaries, receiveGrnLine } from "../../server/services/grn.service";
import { loadLabels } from "../../server/services/labels.service";
import { stockIn } from "../../server/services/stock-in.service";

// The Pharmacy provider reads through its own connection, which cannot see rows made inside a
// rolled-back transaction, so these tests give the GRN service a fixed set of lines instead.
// Everything else (batches, units, events, the unique index) runs against the dev database and
// ALWAYS rolls back. Skipped when DATABASE_URL is not set (for example in CI).
const pharmacy = vi.hoisted(() => ({ lines: [] as PharmacyGrnLine[] }));

vi.mock("../../server/integrations/pharmacy", () => ({
  pharmacyProvider: () => ({
    source: "csv" as const,
    listGrns: async (grnRef?: string) =>
      pharmacy.lines.filter((l) => !grnRef || l.grnRef.toUpperCase() === grnRef.toUpperCase()),
    getBatch: async () => null,
    getTransfer: async () => null,
    getBalances: async () => [],
  }),
}));

const hasDb = Boolean(process.env.DATABASE_URL);

class Rollback extends Error {}

async function inRollback(fn: (tx: Tx) => Promise<void>) {
  try {
    await db().transaction(async (tx) => {
      await fn(tx);
      throw new Rollback();
    });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }
}

async function rejectionText(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (e) {
    const parts: string[] = [];
    let cur: unknown = e;
    while (cur instanceof Error) {
      parts.push(cur.message);
      cur = cur.cause;
    }
    return parts.join(" | ");
  }
  throw new Error("expected the promise to reject");
}

async function fixtures(tx: Tx) {
  const tag = randomUUID().slice(0, 8);
  const userId = randomUUID();
  await tx.execute(sql`insert into auth.users (id, email) values (${userId}, ${`t-${tag}@test.local`})`);

  const [store] = await tx
    .insert(locations)
    .values({ code: `STORE-${tag}`, name: "Test Store", type: "STORE" })
    .returning();
  const [lab] = await tx
    .insert(locations)
    .values({ code: `LAB-${tag}`, name: "Test Lab", type: "LAB" })
    .returning();
  await tx.insert(users).values({
    id: userId,
    staffId: `T-${tag}`,
    name: "Test Keeper",
    role: "STORE_KEEPER",
    homeLocationId: store.id,
  });

  const catalogId = `Testamol ${tag}`;
  const [bottle] = await tx
    .insert(itemTypes)
    .values({
      code: `BOTTLE-${tag}`,
      name: "Test bottle",
      category: "SAMPLE_CONTAINER",
      trackingMode: "SERIAL",
      containerType: "EDTA",
      pharmacyCatalogId: catalogId,
    })
    .returning();
  const [gloves] = await tx
    .insert(itemTypes)
    .values({
      code: `GLOVES-${tag}`,
      name: "Test gloves",
      category: "GENERAL",
      trackingMode: "QUANTITY",
      unitOfMeasure: "box",
    })
    .returning();

  const line = (over: Partial<PharmacyGrnLine> = {}): PharmacyGrnLine => ({
    grnRef: `GRN-${tag}`,
    itemLabel: catalogId,
    itemKey: catalogId.toLowerCase().replace(/[^a-z0-9]/g, ""),
    batchNo: `Bat-${tag}`,
    expiryDate: "2099-12-31",
    quantity: 6,
    unitCost: null,
    unit: "bottle",
    category: null,
    supplier: "Pharmacy Supplier Ltd",
    importedAt: new Date(),
    ...over,
  });

  return { tag, userId, store, lab, bottle, gloves, catalogId, line };
}

afterAll(async () => {
  if (hasDb) await pg().end();
});

beforeEach(() => {
  pharmacy.lines = [];
});

describe.skipIf(!hasDb)("receiving a Pharmacy GRN line", () => {
  it("makes a PHARMACY_GRN batch from Pharmacy's own figures, with serials and STOCKED events", async () => {
    await inRollback(async (tx) => {
      const f = await fixtures(tx);
      const l = f.line();
      pharmacy.lines = [l];

      const { batch, serials } = await receiveGrnLine(
        { grnRef: l.grnRef, batchNo: l.batchNo, itemKey: l.itemKey, itemTypeId: f.bottle.id, locationId: f.store.id },
        f.userId,
        tx,
      );

      expect(batch).toMatchObject({
        source: "PHARMACY_GRN",
        pharmacyGrnId: l.grnRef,
        pharmacyBatchId: l.batchNo,
        lotNo: l.batchNo,
        quantity: 6,
        expiryDate: "2099-12-31",
        supplier: "Pharmacy Supplier Ltd",
        receivedBy: f.userId,
      });
      expect(serials).toHaveLength(6);
      expect(await tx.select().from(units).where(eq(units.batchId, batch.id))).toHaveLength(6);

      const evs = await tx.select().from(events).where(eq(events.batchId, batch.id));
      expect(evs).toHaveLength(6);
      expect(evs.every((e) => e.type === "STOCKED" && e.toState === "IN_STOCK")).toBe(true);
      expect(evs[0].payload).toMatchObject({ pharmacyGrnId: l.grnRef });
    });
  });

  it("receives a QUANTITY item as one batch with one event", async () => {
    await inRollback(async (tx) => {
      const f = await fixtures(tx);
      const l = f.line({ quantity: 40 });
      pharmacy.lines = [l];

      const { batch, serials } = await receiveGrnLine(
        { grnRef: l.grnRef, batchNo: l.batchNo, itemKey: l.itemKey, itemTypeId: f.gloves.id, locationId: f.store.id },
        f.userId,
        tx,
      );
      expect(serials).toEqual([]);
      const evs = await tx.select().from(events).where(eq(events.batchId, batch.id));
      expect(evs).toHaveLength(1);
      expect(evs[0]).toMatchObject({ type: "STOCKED", quantity: 40 });
    });
  });

  it("refuses to receive the same line twice, however the batch number is written", async () => {
    await inRollback(async (tx) => {
      const f = await fixtures(tx);
      const l = f.line();
      pharmacy.lines = [l];
      const input = {
        grnRef: l.grnRef,
        batchNo: l.batchNo,
        itemKey: l.itemKey,
        itemTypeId: f.bottle.id,
        locationId: f.store.id,
      };

      const { batch } = await receiveGrnLine(input, f.userId, tx);

      await expect(receiveGrnLine(input, f.userId, tx)).rejects.toThrow(
        new RegExp(`already received as batch ${batch.code}`),
      );
      // "Bat-xx", "BAT XX" and "batxx" are one batch, and a GRN number in another case is the same GRN.
      await expect(
        receiveGrnLine(
          { ...input, grnRef: l.grnRef.toLowerCase(), batchNo: l.batchNo.toUpperCase().replace("-", " ") },
          f.userId,
          tx,
        ),
      ).rejects.toBeInstanceOf(ValidationError);

      expect(await tx.select().from(batches).where(eq(batches.pharmacyGrnId, l.grnRef))).toHaveLength(1);
      expect(await tx.select().from(units).where(eq(units.itemTypeId, f.bottle.id))).toHaveLength(6);
    });
  });

  it("rejects a line Pharmacy does not have", async () => {
    await inRollback(async (tx) => {
      const f = await fixtures(tx);
      const l = f.line();
      pharmacy.lines = [l];
      const base = { grnRef: l.grnRef, batchNo: l.batchNo, itemKey: l.itemKey, itemTypeId: f.bottle.id, locationId: f.store.id };

      await expect(receiveGrnLine({ ...base, batchNo: "NOPE-1" }, f.userId, tx)).rejects.toBeInstanceOf(NotFoundError);
      await expect(receiveGrnLine({ ...base, itemKey: "someotheritem" }, f.userId, tx)).rejects.toBeInstanceOf(
        NotFoundError,
      );
      await expect(receiveGrnLine({ ...base, grnRef: "GRN-UNKNOWN" }, f.userId, tx)).rejects.toBeInstanceOf(
        NotFoundError,
      );
    });
  });

  it("rejects an expired batch and a non-store location, and writes nothing", async () => {
    await inRollback(async (tx) => {
      const f = await fixtures(tx);
      const expired = f.line({ batchNo: `Old-${f.tag}`, expiryDate: "2000-01-01" });
      const fresh = f.line();
      pharmacy.lines = [expired, fresh];

      await expect(
        receiveGrnLine(
          { grnRef: expired.grnRef, batchNo: expired.batchNo, itemKey: expired.itemKey, itemTypeId: f.bottle.id, locationId: f.store.id },
          f.userId,
          tx,
        ),
      ).rejects.toBeInstanceOf(ValidationError);
      await expect(
        receiveGrnLine(
          { grnRef: fresh.grnRef, batchNo: fresh.batchNo, itemKey: fresh.itemKey, itemTypeId: f.bottle.id, locationId: f.lab.id },
          f.userId,
          tx,
        ),
      ).rejects.toBeInstanceOf(ValidationError);

      expect(await tx.select().from(batches).where(eq(batches.pharmacyGrnId, fresh.grnRef))).toHaveLength(0);
      expect(await tx.select().from(units).where(eq(units.itemTypeId, f.bottle.id))).toHaveLength(0);
    });
  });
});

describe.skipIf(!hasDb)("GRN batch uniqueness in the database", () => {
  it("the unique index stops a second batch for the same GRN line and item type, even past the service check", async () => {
    await inRollback(async (tx) => {
      const f = await fixtures(tx);
      const origin = { source: "PHARMACY_GRN" as const, pharmacyGrnId: `GRN-${f.tag}`, pharmacyBatchId: `Bat-${f.tag}` };
      const input = { itemTypeId: f.gloves.id, locationId: f.store.id, quantity: 3, lotNo: origin.pharmacyBatchId };

      await stockIn(input, f.userId, tx, origin);
      const text = await rejectionText(
        tx.transaction((t) =>
          stockIn(input, f.userId, t, { ...origin, pharmacyGrnId: origin.pharmacyGrnId.toLowerCase(), pharmacyBatchId: `BAT ${f.tag}` }),
        ),
      );
      expect(text).toMatch(/batches_pharmacy_line_uq|duplicate key/);
    });
  });

  it("manual batches are not affected by the index", async () => {
    await inRollback(async (tx) => {
      const f = await fixtures(tx);
      const input = { itemTypeId: f.gloves.id, locationId: f.store.id, quantity: 3, lotNo: "SAME-LOT" };
      await stockIn(input, f.userId, tx);
      await stockIn(input, f.userId, tx);
      expect(await tx.select().from(batches).where(eq(batches.itemTypeId, f.gloves.id))).toHaveLength(2);
    });
  });
});

describe.skipIf(!hasDb)("GRN screens' data", () => {
  it("suggests the item type by its Pharmacy catalog id and marks a received line", async () => {
    await inRollback(async (tx) => {
      const f = await fixtures(tx);
      const l = f.line();
      const other = f.line({ batchNo: `Other-${f.tag}`, itemLabel: "Unmapped medicine", itemKey: "unmappedmedicine", quantity: 2 });
      pharmacy.lines = [l, other];

      const before = await getGrnReceipt(l.grnRef, tx);
      expect(before).toHaveLength(2);
      const mapped = before!.find((x) => x.batchNo === l.batchNo)!;
      const unmapped = before!.find((x) => x.batchNo === other.batchNo)!;
      expect(mapped.suggestedItemTypeId).toBe(f.bottle.id);
      expect(mapped.receivedBatchCode).toBeNull();
      expect(unmapped.suggestedItemTypeId).toBeNull();

      const { batch } = await receiveGrnLine(
        { grnRef: l.grnRef, batchNo: l.batchNo, itemKey: l.itemKey, itemTypeId: f.bottle.id, locationId: f.store.id },
        f.userId,
        tx,
      );

      const after = await getGrnReceipt(l.grnRef, tx);
      expect(after!.find((x) => x.batchNo === l.batchNo)!.receivedBatchCode).toBe(batch.code);
      expect(after!.find((x) => x.batchNo === other.batchNo)!.receivedBatchCode).toBeNull();

      const summary = (await listGrnSummaries(tx)).find((s) => s.grnRef === l.grnRef)!;
      expect(summary).toMatchObject({ lines: 2, receivedLines: 1, totalQuantity: 8 });

      expect(await getGrnReceipt("GRN-UNKNOWN", tx)).toBeNull();
    });
  });
});

describe.skipIf(!hasDb)("deliveries", () => {
  it("puts every line of one GRN into the same store in one delivery, referenced by the GRN number", async () => {
    await inRollback(async (tx) => {
      const f = await fixtures(tx);
      const a = f.line();
      const b = f.line({ batchNo: `Second-${f.tag}`, quantity: 3 });
      pharmacy.lines = [a, b];
      const receive = (l: PharmacyGrnLine) =>
        receiveGrnLine(
          { grnRef: l.grnRef, batchNo: l.batchNo, itemKey: l.itemKey, itemTypeId: f.bottle.id, locationId: f.store.id },
          f.userId,
          tx,
        );

      const first = await receive(a);
      const second = await receive(b);

      expect(first.batch.deliveryId).not.toBeNull();
      expect(second.batch.deliveryId).toBe(first.batch.deliveryId);

      const [delivery] = await tx.select().from(deliveries).where(eq(deliveries.id, first.batch.deliveryId!));
      expect(delivery).toMatchObject({
        reference: a.grnRef,
        supplier: "Pharmacy Supplier Ltd",
        locationId: f.store.id,
        receivedBy: f.userId,
      });
      const view = await getDeliveryByCode(delivery.code, tx);
      expect(view!.lines.map((l) => l.batchCode).sort()).toEqual([first.batch.code, second.batch.code].sort());
    });
  });

  it("gives a GRN received into a second store its own delivery", async () => {
    await inRollback(async (tx) => {
      const f = await fixtures(tx);
      const [otherStore] = await tx
        .insert(locations)
        .values({ code: `STORE2-${f.tag}`, name: "Second Store", type: "STORE" })
        .returning();
      const a = f.line();
      const b = f.line({ batchNo: `Second-${f.tag}`, quantity: 3 });
      pharmacy.lines = [a, b];

      const one = await receiveGrnLine(
        { grnRef: a.grnRef, batchNo: a.batchNo, itemKey: a.itemKey, itemTypeId: f.bottle.id, locationId: f.store.id },
        f.userId,
        tx,
      );
      const two = await receiveGrnLine(
        { grnRef: b.grnRef, batchNo: b.batchNo, itemKey: b.itemKey, itemTypeId: f.bottle.id, locationId: otherStore.id },
        f.userId,
        tx,
      );
      expect(two.batch.deliveryId).not.toBe(one.batch.deliveryId);
    });
  });

  it("refuses a non-store location and reads back an unknown or malformed code as nothing", async () => {
    await inRollback(async (tx) => {
      const f = await fixtures(tx);
      await expect(createDelivery({ locationId: f.lab.id, userId: f.userId }, tx)).rejects.toBeInstanceOf(
        ValidationError,
      );
      expect(await getDeliveryByCode("not-a-code", tx)).toBeNull();
      expect(await getDeliveryByCode(generateDeliveryCode(), tx)).toBeNull();
    });
  });

  it("gives a delivery label first, then one batch label per item line", async () => {
    await inRollback(async (tx) => {
      const f = await fixtures(tx);
      const delivery = await createDelivery(
        { supplier: "Acme", reference: "INV-1", locationId: f.store.id, userId: f.userId },
        tx,
      );
      await stockIn({ itemTypeId: f.bottle.id, locationId: f.store.id, quantity: 4 }, f.userId, tx, {
        source: "MANUAL",
        deliveryId: delivery.id,
      });
      await stockIn({ itemTypeId: f.gloves.id, locationId: f.store.id, quantity: 10 }, f.userId, tx, {
        source: "MANUAL",
        deliveryId: delivery.id,
      });
      // A batch outside the delivery must not leak into its labels.
      await stockIn({ itemTypeId: f.gloves.id, locationId: f.store.id, quantity: 5 }, f.userId, tx);

      const set = await loadLabels({ delivery: delivery.code.toLowerCase() }, tx);
      expect(set.name).toBe(delivery.code);
      // The delivery label, then one batch label per line. The 4 bottle labels are not in it: open the batch for those.
      expect(set.labels).toHaveLength(3);
      expect(set.labels[0]).toMatchObject({ kind: "delivery", code: delivery.code, itemCount: 2 });
      expect(set.labels.slice(1).every((l) => l.kind === "batch")).toBe(true);
      expect(set.labels.filter((l) => l.kind === "serial")).toHaveLength(0);

      // Each part prints on its own, so a delivery label that is already stuck on is not printed again with the batches.
      const own = await loadLabels({ delivery: delivery.code, only: "delivery" }, tx);
      expect(own.labels).toHaveLength(1);
      expect(own.labels[0]).toMatchObject({ kind: "delivery", code: delivery.code, itemCount: 2 });
      const batchesOnly = await loadLabels({ delivery: delivery.code, only: "batches" }, tx);
      expect(batchesOnly.labels).toHaveLength(2);
      expect(batchesOnly.labels.every((l) => l.kind === "batch")).toBe(true);

      await expect(loadLabels({ delivery: generateDeliveryCode() }, tx)).rejects.toBeInstanceOf(NotFoundError);
      await expect(loadLabels({ delivery: "nope" }, tx)).rejects.toBeInstanceOf(ValidationError);
    });
  });
});
