import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import type { Tx } from "../../server/audit/events";
import { db, sql as pg } from "../../server/db/client";
import { events, itemTypes, locations, units, users } from "../../server/db/schema";
import { stockIn } from "../../server/services/stock-in.service";
import { addUnitToTransfer, confirmTransfer, createTransfer } from "../../server/services/transfer.service";
import { closeReceipt, openReceipt } from "../../server/services/receive.service";
import { processSyncEvents } from "../../server/services/sync.service";
import type { Actor } from "../../server/domain/types";
import type { SyncEvent } from "../../types/sync";

// Like the other integration tests: these talk to the dev database but ALWAYS roll back.
// Skipped when DATABASE_URL is not set (for example in CI).
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

async function makeUser(tx: Tx, tag: string, role: Actor["role"], homeLocationId: string | null): Promise<Actor> {
  const userId = randomUUID();
  await tx.execute(sql`insert into auth.users (id, email) values (${userId}, ${`${role}-${tag}@test.local`})`);
  await tx.insert(users).values({ id: userId, staffId: `${role.slice(0, 3)}-${tag}`, name: `Test ${role}`, role, homeLocationId });
  return { userId, role, homeLocationId };
}

/** A store, a lab, and 5 bottles dispatched to the lab with the receipt open. */
async function openedReceipt(tx: Tx) {
  const tag = randomUUID().slice(0, 8);
  const [store] = await tx.insert(locations).values({ code: `STORE-${tag}`, name: "Test Store", type: "STORE" }).returning();
  const [lab] = await tx.insert(locations).values({ code: `LAB-${tag}`, name: "Test Lab", type: "LAB" }).returning();
  const keeper = await makeUser(tx, tag, "STORE_KEEPER", store.id);
  const distributor = await makeUser(tx, tag, "DISTRIBUTOR", lab.id);
  const [bottle] = await tx
    .insert(itemTypes)
    .values({ code: `BOTTLE-${tag}`, name: "Test bottle", category: "SAMPLE_CONTAINER", trackingMode: "SERIAL", containerType: "EDTA" })
    .returning();

  const { serials } = await stockIn({ itemTypeId: bottle.id, locationId: store.id, quantity: 5 }, keeper.userId, tx);
  const draft = await createTransfer({ fromLocationId: store.id, toLocationId: lab.id }, keeper.userId, tx);
  for (const s of serials) await addUnitToTransfer(draft.id, s, tx);
  await confirmTransfer(draft.id, keeper.userId, { carriedByName: "Test Porter" }, tx);
  await openReceipt(draft.code, distributor, tx);
  return { store, lab, keeper, distributor, serials, transfer: draft };
}

const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000).toISOString();

function scan(f: { distributor: Actor; transfer: { id: string } }, serial: string, over: Partial<SyncEvent> = {}): SyncEvent {
  return {
    id: randomUUID(),
    kind: "RECEIVE_UNIT",
    transferId: f.transfer.id,
    serial,
    userId: f.distributor.userId,
    occurredAt: minutesAgo(10),
    deviceId: "TABLET-1",
    ...over,
  };
}

const eventsFor = (tx: Tx, transferId: string) => tx.select().from(events).where(eq(events.transferId, transferId));
const received = <T extends { type: string }>(rows: T[]): T[] => rows.filter((r) => r.type === "RECEIVED");

afterAll(async () => {
  if (hasDb) await pg().end();
});

describe.skipIf(!hasDb)("offline sync (the Phase 5 done-check)", () => {
  it("applies a receipt scanned offline, keeping device time and server time apart", async () => {
    await inRollback(async (tx) => {
      const f = await openedReceipt(tx);
      const batch = f.serials.slice(0, 4).map((s) => scan(f, s));

      const results = await processSyncEvents(batch, f.distributor, tx);
      expect(results.map((r) => r.status)).toEqual(["OK", "OK", "OK", "OK"]);
      expect(results[3].message).toMatch(/4 of 5/);

      const rows = received(await eventsFor(tx, f.transfer.id));
      expect(rows).toHaveLength(4);
      for (const e of batch) {
        const row = rows.find((r) => r.id === e.id);
        expect(row).toBeDefined();
        // occurred_at is when the device scanned; recorded_at is when the server took it: about 10 minutes apart.
        expect(Math.abs((row?.occurredAt.getTime() ?? 0) - Date.parse(e.occurredAt))).toBeLessThan(1000);
        expect((row?.recordedAt.getTime() ?? 0) - (row?.occurredAt.getTime() ?? 0)).toBeGreaterThan(500_000);
        expect(row?.deviceId).toBe("TABLET-1");
        expect(row?.userId).toBe(f.distributor.userId);
        expect(row?.payload).toMatchObject({ synced: true });
      }

      const states = await tx.select({ s: units.state }).from(units).where(eq(units.currentLocationId, f.lab.id));
      expect(states).toHaveLength(4);
      expect(states.every((u) => u.s === "IN_STOCK")).toBe(true);
    });
  });

  it("treats duplicate delivery as a no-op", async () => {
    await inRollback(async (tx) => {
      const f = await openedReceipt(tx);
      const batch = f.serials.slice(0, 3).map((s) => scan(f, s));

      await processSyncEvents(batch, f.distributor, tx);
      const again = await processSyncEvents(batch, f.distributor, tx);

      expect(again.map((r) => r.status)).toEqual(["DUPLICATE", "DUPLICATE", "DUPLICATE"]);
      expect(received(await eventsFor(tx, f.transfer.id))).toHaveLength(3);
    });
  });

  it("stays a no-op when the retry arrives after the receipt has closed", async () => {
    await inRollback(async (tx) => {
      const f = await openedReceipt(tx);
      const batch = f.serials.map((s) => scan(f, s));
      await processSyncEvents(batch, f.distributor, tx);
      await closeReceipt(f.transfer.id, f.distributor, tx);

      // The reply was lost, so the device sends the same batch again after the receipt is closed.
      const again = await processSyncEvents(batch, f.distributor, tx);
      expect(again.every((r) => r.status === "DUPLICATE")).toBe(true);
      expect(received(await eventsFor(tx, f.transfer.id))).toHaveLength(5);
    });
  });

  it("counts one bottle scanned twice under different event ids only once", async () => {
    await inRollback(async (tx) => {
      const f = await openedReceipt(tx);
      const first = scan(f, f.serials[0]);
      const second = scan(f, f.serials[0], { occurredAt: minutesAgo(5) });

      const results = await processSyncEvents([first, second], f.distributor, tx);
      expect(results.map((r) => r.status)).toEqual(["OK", "DUPLICATE"]);
      expect(received(await eventsFor(tx, f.transfer.id))).toHaveLength(1);
    });
  });

  it("rejects a stale scan with the reason, and changes nothing", async () => {
    await inRollback(async (tx) => {
      const f = await openedReceipt(tx);
      await processSyncEvents(f.serials.slice(0, 4).map((s) => scan(f, s)), f.distributor, tx);
      // Someone closes the receipt on another device while this one was offline: the fifth is missing.
      await closeReceipt(f.transfer.id, f.distributor, tx);

      const stale = scan(f, f.serials[4]);
      const [result] = await processSyncEvents([stale], f.distributor, tx);

      expect(result.id).toBe(stale.id);
      expect(result.status).toBe("REJECTED");
      expect(result.message).toMatch(/transfer is/i);

      const [unit] = await tx.select().from(units).where(eq(units.serial, f.serials[4]));
      expect(unit.state).toBe("MISSING_IN_TRANSIT");
      expect((await eventsFor(tx, f.transfer.id)).some((e) => e.id === stale.id)).toBe(false);
    });
  });

  it("rejects a bottle from another transfer and an unknown serial, but still applies the rest of the batch", async () => {
    await inRollback(async (tx) => {
      const f = await openedReceipt(tx);
      const other = await openedReceipt(tx);

      const results = await processSyncEvents(
        [scan(f, other.serials[0]), scan(f, "CT0000000ZZ"), scan(f, f.serials[0])],
        f.distributor,
        tx,
      );
      const byStatus = results.map((r) => r.status).sort();
      expect(byStatus).toEqual(["OK", "REJECTED", "REJECTED"]);
      expect(received(await eventsFor(tx, f.transfer.id))).toHaveLength(1);
    });
  });

  it("holds a scan made by another user instead of applying it under the wrong name", async () => {
    await inRollback(async (tx) => {
      const f = await openedReceipt(tx);
      const someoneElse = await makeUser(tx, randomUUID().slice(0, 8), "DISTRIBUTOR", f.lab.id);

      const [result] = await processSyncEvents([scan(f, f.serials[0], { userId: someoneElse.userId })], f.distributor, tx);
      expect(result.status).toBe("HOLD");
      expect(received(await eventsFor(tx, f.transfer.id))).toHaveLength(0);
    });
  });

  it("will not accept a device time in the future: it is pulled back and flagged", async () => {
    await inRollback(async (tx) => {
      const f = await openedReceipt(tx);
      const future = scan(f, f.serials[0], { occurredAt: new Date(Date.now() + 3_600_000).toISOString() });

      const [result] = await processSyncEvents([future], f.distributor, tx);
      expect(result.status).toBe("OK");

      const [row] = received(await eventsFor(tx, f.transfer.id));
      expect(row.occurredAt.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
      expect(row.payload).toMatchObject({ clockSkew: true, deviceTime: future.occurredAt });
    });
  });
});
