import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import type { Tx } from "../../server/audit/events";
import { db, sql as pg } from "../../server/db/client";
import { itemTypes, locations, units, users } from "../../server/db/schema";
import { stockIn } from "../../server/services/stock-in.service";
import {
  addUnitToTransfer,
  cancelTransfer,
  confirmTransfer,
  createTransfer,
  getBatchParts,
  getTransferDetail,
  lookupBatchForDispatch,
  setBatchQuantity,
} from "../../server/services/transfer.service";
import { loadLabels } from "../../server/services/labels.service";
import type { Actor } from "../../server/domain/types";
import { ValidationError } from "../../server/domain/errors";

// Batch parts (A, B, C) and the box-first dispatch scan. Like transfers.test.ts these talk to the
// dev database but ALWAYS roll back, and are skipped when DATABASE_URL is not set.
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

async function fixtures(tx: Tx) {
  const tag = randomUUID().slice(0, 8);
  const [store] = await tx.insert(locations).values({ code: `STORE-${tag}`, name: "Test Store", type: "STORE" }).returning();
  const [fastTrack] = await tx.insert(locations).values({ code: `FT-${tag}`, name: "Fast Track Lab", type: "LAB" }).returning();
  const [epu] = await tx.insert(locations).values({ code: `EPU-${tag}`, name: "EPU Lab", type: "LAB" }).returning();
  const [ae] = await tx.insert(locations).values({ code: `AE-${tag}`, name: "A&E Lab", type: "LAB" }).returning();
  const keeper = await makeUser(tx, tag, "STORE_KEEPER", store.id);
  const [bottle] = await tx
    .insert(itemTypes)
    .values({ code: `BOTTLE-${tag}`, name: "Test bottle", category: "SAMPLE_CONTAINER", trackingMode: "SERIAL", containerType: "EDTA" })
    .returning();
  const [gloves] = await tx
    .insert(itemTypes)
    .values({ code: `GLOVES-${tag}`, name: "Test gloves", category: "GENERAL", trackingMode: "QUANTITY", unitOfMeasure: "box" })
    .returning();
  return { store, fastTrack, epu, ae, keeper, bottle, gloves };
}

type Fixtures = Awaited<ReturnType<typeof fixtures>>;

const draftTo = (tx: Tx, f: Fixtures, toLocationId: string) =>
  createTransfer({ fromLocationId: f.store.id, toLocationId }, f.keeper.userId, tx);

afterAll(async () => {
  if (hasDb) await pg().end();
});

describe.skipIf(!hasDb)("one box sent in parts A, B and C", () => {
  it(
    "gives 6 / 2 / 2 bottles to three places the letters A, B, C in dispatch order",
    async () => {
      await inRollback(async (tx) => {
        const f = await fixtures(tx);
        const { batch, serials } = await stockIn({ itemTypeId: f.bottle.id, locationId: f.store.id, quantity: 10 }, f.keeper.userId, tx);

        // Scan the box, then 6 bottles: the count goes up with each scan.
        const first = await draftTo(tx, f, f.fastTrack.id);
        let last;
        for (const s of serials.slice(0, 6)) last = await addUnitToTransfer(first.id, s, tx, batch.code);
        expect(last?.batchCount).toBe(6);
        const sentA = await confirmTransfer(first.id, f.keeper.userId, { carriedByName: "Test Porter" }, tx);
        expect(sentA.total).toBe(6);
        expect(sentA.parts).toEqual([{ batchCode: batch.code, letter: "A" }]);

        const second = await draftTo(tx, f, f.epu.id);
        for (const s of serials.slice(6, 8)) await addUnitToTransfer(second.id, s, tx, batch.code);
        const sentB = await confirmTransfer(second.id, f.keeper.userId, { carriedByName: "Test Porter" }, tx);
        expect(sentB.parts).toEqual([{ batchCode: batch.code, letter: "B" }]);

        const third = await draftTo(tx, f, f.ae.id);
        for (const s of serials.slice(8)) await addUnitToTransfer(third.id, s, tx, batch.code);
        const sentC = await confirmTransfer(third.id, f.keeper.userId, { carriedByName: "Test Porter" }, tx);
        expect(sentC.parts).toEqual([{ batchCode: batch.code, letter: "C" }]);

        const parts = await getBatchParts(batch.code, tx);
        expect(parts.map((p) => [p.letter, p.toName, p.quantity])).toEqual([
          ["A", "Fast Track Lab", 6],
          ["B", "EPU Lab", 2],
          ["C", "A&E Lab", 2],
        ]);

        const detail = await getTransferDetail(second.code, tx);
        expect(detail?.parts).toEqual([{ batchCode: batch.code, letter: "B", itemName: "Test bottle" }]);
        expect(detail?.totals.serialCount).toBe(2);

        const inTransit = await tx.select({ s: units.state }).from(units).where(eq(units.batchId, batch.id));
        expect(inTransit).toHaveLength(10);
        expect(inTransit.every((u) => u.s === "IN_TRANSIT")).toBe(true);
      });
    },
    120_000,
  );

  it("does not use up a letter when a draft is cancelled", async () => {
    await inRollback(async (tx) => {
      const f = await fixtures(tx);
      const { batch, serials } = await stockIn({ itemTypeId: f.bottle.id, locationId: f.store.id, quantity: 4 }, f.keeper.userId, tx);

      const abandoned = await draftTo(tx, f, f.fastTrack.id);
      await addUnitToTransfer(abandoned.id, serials[0], tx, batch.code);
      await cancelTransfer(abandoned.id, tx);

      const real = await draftTo(tx, f, f.epu.id);
      await addUnitToTransfer(real.id, serials[0], tx, batch.code);
      const sent = await confirmTransfer(real.id, f.keeper.userId, { carriedByName: "Test Porter" }, tx);
      expect(sent.parts).toEqual([{ batchCode: batch.code, letter: "A" }]);
    });
  });

  it("gives bulk batches parts too", async () => {
    await inRollback(async (tx) => {
      const f = await fixtures(tx);
      const { batch } = await stockIn({ itemTypeId: f.gloves.id, locationId: f.store.id, quantity: 20 }, f.keeper.userId, tx);

      const one = await draftTo(tx, f, f.fastTrack.id);
      await setBatchQuantity(one.id, batch.code, 5, tx);
      expect((await confirmTransfer(one.id, f.keeper.userId, { carriedByName: "Test Porter" }, tx)).parts).toEqual([{ batchCode: batch.code, letter: "A" }]);

      const two = await draftTo(tx, f, f.epu.id);
      await setBatchQuantity(two.id, batch.code, 3, tx);
      expect((await confirmTransfer(two.id, f.keeper.userId, { carriedByName: "Test Porter" }, tx)).parts).toEqual([{ batchCode: batch.code, letter: "B" }]);

      const parts = await getBatchParts(batch.code, tx);
      expect(parts.map((p) => [p.letter, p.quantity])).toEqual([
        ["A", 5],
        ["B", 3],
      ]);
    });
  });

  it("gives each batch on one transfer its own part letter", async () => {
    await inRollback(async (tx) => {
      const f = await fixtures(tx);
      const one = await stockIn({ itemTypeId: f.bottle.id, locationId: f.store.id, quantity: 3 }, f.keeper.userId, tx);
      const two = await stockIn({ itemTypeId: f.bottle.id, locationId: f.store.id, quantity: 3 }, f.keeper.userId, tx);

      // Batch one goes out once already, so on the next transfer it becomes part B while batch two is A.
      const early = await draftTo(tx, f, f.fastTrack.id);
      await addUnitToTransfer(early.id, one.serials[0], tx);
      await confirmTransfer(early.id, f.keeper.userId, { carriedByName: "Test Porter" }, tx);

      const mixed = await draftTo(tx, f, f.epu.id);
      await addUnitToTransfer(mixed.id, one.serials[1], tx);
      await addUnitToTransfer(mixed.id, two.serials[0], tx);
      const sent = await confirmTransfer(mixed.id, f.keeper.userId, { carriedByName: "Test Porter" }, tx);
      const byBatch = Object.fromEntries(sent.parts.map((p) => [p.batchCode, p.letter]));
      expect(byBatch).toEqual({ [one.batch.code]: "B", [two.batch.code]: "A" });
    });
  });
});

describe.skipIf(!hasDb)("scanning a box before its bottles", () => {
  it("rejects a bottle from a different box than the one scanned", async () => {
    await inRollback(async (tx) => {
      const f = await fixtures(tx);
      const one = await stockIn({ itemTypeId: f.bottle.id, locationId: f.store.id, quantity: 2 }, f.keeper.userId, tx);
      const two = await stockIn({ itemTypeId: f.bottle.id, locationId: f.store.id, quantity: 2 }, f.keeper.userId, tx);
      const draft = await draftTo(tx, f, f.fastTrack.id);

      await expect(
        addUnitToTransfer(draft.id, two.serials[0], tx, one.batch.code),
      ).rejects.toThrow(ValidationError);
      // The rejected bottle was not added.
      expect((await getTransferDetail(draft.code, tx))?.totals.serialCount).toBe(0);

      // The right box works, and scanning with no box active still works as before.
      const ok = await addUnitToTransfer(draft.id, one.serials[0], tx, one.batch.code);
      expect(ok.status).toBe("added");
      const loose = await addUnitToTransfer(draft.id, two.serials[0], tx);
      expect(loose.status).toBe("added");
    });
  });

  it("scanning the same bottle twice does not raise the count", async () => {
    await inRollback(async (tx) => {
      const f = await fixtures(tx);
      const { batch, serials } = await stockIn({ itemTypeId: f.bottle.id, locationId: f.store.id, quantity: 3 }, f.keeper.userId, tx);
      const draft = await draftTo(tx, f, f.fastTrack.id);
      await addUnitToTransfer(draft.id, serials[0], tx, batch.code);
      const again = await addUnitToTransfer(draft.id, serials[0], tx, batch.code);
      expect(again.status).toBe("duplicate");
      expect(again.batchCount).toBe(1);
    });
  });

  it("reports what is free, what is on this draft and which part is next", async () => {
    await inRollback(async (tx) => {
      const f = await fixtures(tx);
      const { batch, serials } = await stockIn({ itemTypeId: f.bottle.id, locationId: f.store.id, quantity: 10 }, f.keeper.userId, tx);

      const sentFirst = await draftTo(tx, f, f.fastTrack.id);
      for (const s of serials.slice(0, 4)) await addUnitToTransfer(sentFirst.id, s, tx);
      await confirmTransfer(sentFirst.id, f.keeper.userId, { carriedByName: "Test Porter" }, tx);

      // Another draft holds 2 more, so they are not free for this one.
      const other = await draftTo(tx, f, f.ae.id);
      for (const s of serials.slice(4, 6)) await addUnitToTransfer(other.id, s, tx);

      const mine = await draftTo(tx, f, f.epu.id);
      await addUnitToTransfer(mine.id, serials[6], tx);

      const info = await lookupBatchForDispatch(mine.id, batch.code, tx);
      expect(info).toMatchObject({
        batchCode: batch.code,
        itemName: "Test bottle",
        trackingMode: "SERIAL",
        available: 4, // 10 - 4 dispatched - 2 on the other draft
        onDraft: 1,
        partsSent: 1,
      });
    });
  });

  it("rejects something that is not a batch code", async () => {
    await inRollback(async (tx) => {
      const f = await fixtures(tx);
      const draft = await draftTo(tx, f, f.fastTrack.id);
      await expect(lookupBatchForDispatch(draft.id, "BTNOTACODE00", tx)).rejects.toThrow(ValidationError);
    });
  });
});

describe.skipIf(!hasDb)("the box label prints with the bottle labels", () => {
  it("puts one box label first, then a label per bottle", async () => {
    await inRollback(async (tx) => {
      const f = await fixtures(tx);
      const { batch, serials } = await stockIn({ itemTypeId: f.bottle.id, locationId: f.store.id, quantity: 10 }, f.keeper.userId, tx);

      const set = await loadLabels({ batch: batch.code }, tx);
      expect(set.labels).toHaveLength(11);
      expect(set.labels[0]).toMatchObject({ kind: "batch", code: batch.code, quantity: 10 });
      expect(set.labels.slice(1).every((l) => l.kind === "serial")).toBe(true);
      expect(set.labels.slice(1).map((l) => (l.kind === "serial" ? l.serial : ""))).toEqual([...serials].sort());

      // Each part also prints on its own, so a box label that is already stuck on is not printed again with the bottles.
      const boxOnly = await loadLabels({ batch: batch.code, only: "batch" }, tx);
      expect(boxOnly.labels).toHaveLength(1);
      expect(boxOnly.labels[0]).toMatchObject({ kind: "batch", code: batch.code, quantity: 10 });
      const bottlesOnly = await loadLabels({ batch: batch.code, only: "items" }, tx);
      expect(bottlesOnly.labels).toHaveLength(10);
      expect(bottlesOnly.labels.every((l) => l.kind === "serial")).toBe(true);
    });
  });

  it("still gives a bulk batch just its box label", async () => {
    await inRollback(async (tx) => {
      const f = await fixtures(tx);
      const { batch } = await stockIn({ itemTypeId: f.gloves.id, locationId: f.store.id, quantity: 20 }, f.keeper.userId, tx);
      const set = await loadLabels({ batch: batch.code }, tx);
      expect(set.labels).toHaveLength(1);
      expect(set.labels[0]).toMatchObject({ kind: "batch", code: batch.code, quantity: 20 });
      // There are no pack labels under it to print on their own.
      await expect(loadLabels({ batch: batch.code, only: "items" }, tx)).rejects.toThrow(ValidationError);
    });
  });
});
