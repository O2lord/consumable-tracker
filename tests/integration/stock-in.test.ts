import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { appendEvent, type Tx } from "../../server/audit/events";
import { db, sql as pg } from "../../server/db/client";
import { events, itemTypes, locations, units, users } from "../../server/db/schema";
import { stockIn } from "../../server/services/stock-in.service";
import { isValidSerial } from "../../lib/serial";
import { ValidationError } from "../../server/domain/errors";

// These tests talk to the dev database but ALWAYS roll back, so nothing they create is kept.
// They are skipped when DATABASE_URL is not set (for example in CI).
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

/** Drizzle wraps Postgres errors; collect the whole cause chain so we can match the real message. */
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
  const [bottle] = await tx
    .insert(itemTypes)
    .values({
      code: `BOTTLE-${tag}`,
      name: "Test bottle",
      category: "SAMPLE_CONTAINER",
      trackingMode: "SERIAL",
      containerType: "EDTA",
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

  return { userId, store, lab, bottle, gloves };
}

afterAll(async () => {
  if (hasDb) await pg().end();
});

describe.skipIf(!hasDb)("events ledger (append-only)", () => {
  it("accepts an insert but rejects UPDATE, DELETE and TRUNCATE", async () => {
    await inRollback(async (tx) => {
      const f = await fixtures(tx);

      // Use the STOCKED event written by a real stock-in as the row to tamper with.
      const { batch } = await stockIn(
        { itemTypeId: f.gloves.id, locationId: f.store.id, quantity: 5 },
        f.userId,
        tx,
      );
      const [ev] = await tx.select().from(events).where(eq(events.batchId, batch.id));
      expect(ev).toBeDefined();

      const update = await rejectionText(
        tx.transaction((t) => t.update(events).set({ note: "tampered" }).where(eq(events.id, ev.id))),
      );
      expect(update).toMatch(/append-only/);

      const del = await rejectionText(
        tx.transaction((t) => t.delete(events).where(eq(events.id, ev.id))),
      );
      expect(del).toMatch(/append-only/);

      const trunc = await rejectionText(
        tx.transaction((t) => t.execute(sql`truncate consumables.events`)),
      );
      // Once another table (links.issue_event_id) references events, Postgres refuses TRUNCATE
      // on the foreign key check before the statement trigger can fire, so either message is a
      // valid rejection. The append-only trigger still guards the case where no FK exists.
      expect(trunc).toMatch(/append-only|cannot truncate a table referenced in a foreign key/);

      // And the row is untouched.
      const [after] = await tx.select().from(events).where(eq(events.id, ev.id));
      expect(after.note).toBeNull();
    });
  });

  it("treats a replayed event id as a no-op (idempotent sync)", async () => {
    await inRollback(async (tx) => {
      const f = await fixtures(tx);
      const { batch } = await stockIn(
        { itemTypeId: f.gloves.id, locationId: f.store.id, quantity: 5 },
        f.userId,
        tx,
      );
      const id = randomUUID();
      const row = {
        id,
        batchId: batch.id,
        type: "ADJUSTED" as const,
        quantity: -1,
        locationId: f.store.id,
        userId: f.userId,
        occurredAt: new Date(),
      };
      expect(await appendEvent(tx, row)).toBe(true);
      expect(await appendEvent(tx, row)).toBe(false);
      const rows = await tx.select().from(events).where(eq(events.id, id));
      expect(rows).toHaveLength(1);
    });
  });
});

describe.skipIf(!hasDb)("stockIn service", () => {
  it("SERIAL items: one unit and exactly one STOCKED event per serial", async () => {
    await inRollback(async (tx) => {
      const f = await fixtures(tx);
      const { batch, serials } = await stockIn(
        {
          itemTypeId: f.bottle.id,
          locationId: f.store.id,
          quantity: 25,
          lotNo: "LOT-1",
          expiryDate: "2099-12-31",
          supplier: "Acme",
        },
        f.userId,
        tx,
      );

      expect(batch.quantity).toBe(25);
      expect(batch.source).toBe("MANUAL");
      expect(batch.receivedBy).toBe(f.userId);
      expect(serials).toHaveLength(25);
      expect(new Set(serials).size).toBe(25);
      expect(serials.every(isValidSerial)).toBe(true);

      const rows = await tx.select().from(units).where(eq(units.batchId, batch.id));
      expect(rows).toHaveLength(25);
      for (const u of rows) {
        expect(u.state).toBe("IN_STOCK");
        expect(u.currentLocationId).toBe(f.store.id);
      }

      const evs = await tx.select().from(events).where(eq(events.batchId, batch.id));
      expect(evs).toHaveLength(25);
      expect(new Set(evs.map((e) => e.unitId)).size).toBe(25);
      for (const e of evs) {
        expect(e.type).toBe("STOCKED");
        expect(e.toState).toBe("IN_STOCK");
        expect(e.fromState).toBeNull();
        expect(e.quantity).toBe(1);
        expect(e.userId).toBe(f.userId);
        expect(e.locationId).toBe(f.store.id);
      }
    });
  });

  it("QUANTITY items: one STOCKED event carrying the quantity and no units", async () => {
    await inRollback(async (tx) => {
      const f = await fixtures(tx);
      const { batch, serials } = await stockIn(
        { itemTypeId: f.gloves.id, locationId: f.store.id, quantity: 40 },
        f.userId,
        tx,
      );
      expect(serials).toEqual([]);
      expect(await tx.select().from(units).where(eq(units.batchId, batch.id))).toHaveLength(0);
      const evs = await tx.select().from(events).where(eq(events.batchId, batch.id));
      expect(evs).toHaveLength(1);
      expect(evs[0]).toMatchObject({ type: "STOCKED", quantity: 40, unitId: null });
    });
  });

  it("rejects a non-store location, an expired batch and a zero quantity", async () => {
    await inRollback(async (tx) => {
      const f = await fixtures(tx);
      const base = { itemTypeId: f.bottle.id, locationId: f.store.id, quantity: 3 };

      await expect(
        stockIn({ ...base, locationId: f.lab.id }, f.userId, tx),
      ).rejects.toBeInstanceOf(ValidationError);
      await expect(
        stockIn({ ...base, expiryDate: "2000-01-01" }, f.userId, tx),
      ).rejects.toBeInstanceOf(ValidationError);
      await expect(stockIn({ ...base, quantity: 0 }, f.userId, tx)).rejects.toBeInstanceOf(
        ValidationError,
      );
    });
  });

  it("writes nothing when a later step fails (single transaction)", async () => {
    await inRollback(async (tx) => {
      const f = await fixtures(tx);
      // A user id that does not exist violates batches.received_by, after validation passed.
      const ghost = randomUUID();
      await expect(
        tx.transaction((t) =>
          stockIn({ itemTypeId: f.bottle.id, locationId: f.store.id, quantity: 4 }, ghost, t),
        ),
      ).rejects.toBeInstanceOf(Error);
      const orphanUnits = await tx
        .select()
        .from(units)
        .where(eq(units.itemTypeId, f.bottle.id));
      expect(orphanUnits).toHaveLength(0);
    });
  });
});
