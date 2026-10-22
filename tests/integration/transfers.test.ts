import { randomUUID } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import type { Tx } from "../../server/audit/events";
import { db, sql as pg } from "../../server/db/client";
import { quantityOnHand } from "../../server/db/queries/quantity";
import { events, itemTypes, locations, transferItems, transfers, units, users } from "../../server/db/schema";
import { stockIn } from "../../server/services/stock-in.service";
import {
  addUnitToTransfer,
  cancelTransfer,
  confirmTransfer,
  createTransfer,
  getTransferDetail,
  setBatchQuantity,
} from "../../server/services/transfer.service";
import { closeReceipt, countQuantity, openReceipt, receiveUnit } from "../../server/services/receive.service";
import { listOpenDiscrepancies, resolveDiscrepancy } from "../../server/services/discrepancy.service";
import type { Actor } from "../../server/domain/types";
import { PermissionDeniedError, ValidationError, WrongTransferError } from "../../server/domain/errors";

// Like stock-in.test.ts: these talk to the dev database but ALWAYS roll back.
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

async function fixtures(tx: Tx) {
  const tag = randomUUID().slice(0, 8);
  const [store] = await tx.insert(locations).values({ code: `STORE-${tag}`, name: "Test Store", type: "STORE" }).returning();
  const [lab] = await tx.insert(locations).values({ code: `LAB-${tag}`, name: "Test Lab", type: "LAB" }).returning();
  const [ward] = await tx.insert(locations).values({ code: `WARD-${tag}`, name: "Test Ward", type: "WARD" }).returning();
  const keeper = await makeUser(tx, tag, "STORE_KEEPER", store.id);
  const distributor = await makeUser(tx, tag, "DISTRIBUTOR", lab.id);
  const wardStaff = await makeUser(tx, `${tag}w`, "DISTRIBUTOR", ward.id);
  const supervisor = await makeUser(tx, tag, "SUPERVISOR", null);
  const [bottle] = await tx
    .insert(itemTypes)
    .values({ code: `BOTTLE-${tag}`, name: "Test bottle", category: "SAMPLE_CONTAINER", trackingMode: "SERIAL", containerType: "EDTA" })
    .returning();
  const [gloves] = await tx
    .insert(itemTypes)
    .values({ code: `GLOVES-${tag}`, name: "Test gloves", category: "GENERAL", trackingMode: "QUANTITY", unitOfMeasure: "box" })
    .returning();
  return { store, lab, ward, keeper, distributor, wardStaff, supervisor, bottle, gloves };
}

type Fixtures = Awaited<ReturnType<typeof fixtures>>;

async function newDraft(tx: Tx, f: Fixtures, extra: Partial<Parameters<typeof createTransfer>[0]> = {}) {
  return createTransfer({ fromLocationId: f.store.id, toLocationId: f.lab.id, ...extra }, f.keeper.userId, tx);
}

async function eventsFor(tx: Tx, transferId: string) {
  return tx.select().from(events).where(eq(events.transferId, transferId));
}

const count = (rows: { type: string }[], type: string) => rows.filter((r) => r.type === type).length;

afterAll(async () => {
  if (hasDb) await pg().end();
});

describe.skipIf(!hasDb)("dispatch 50, receive 48 (the Phase 2 done-check)", () => {
  it(
    "names exactly the 2 unscanned serials, writes one event per state change, and a supervisor resolves them",
    async () => {
      await inRollback(async (tx) => {
        const f = await fixtures(tx);
        const { serials } = await stockIn({ itemTypeId: f.bottle.id, locationId: f.store.id, quantity: 50 }, f.keeper.userId, tx);
        expect(serials).toHaveLength(50);

        const draft = await newDraft(tx, f);
        for (const s of serials) await addUnitToTransfer(draft.id, s, tx);
        const { transfer: sent, total } = await confirmTransfer(draft.id, f.keeper.userId, { carriedByName: "Test Porter" }, tx);
        expect(total).toBe(50);
        expect(sent.status).toBe("DISPATCHED");

        const inTransit = await tx.select({ s: units.state }).from(units).where(inArray(units.serial, serials));
        expect(inTransit.every((u) => u.s === "IN_TRANSIT")).toBe(true);

        await openReceipt(draft.code, f.distributor, tx);
        const missing = [serials[7], serials[31]];
        for (const s of serials.filter((x) => !missing.includes(x))) {
          await receiveUnit(draft.id, s, f.distributor, tx);
        }

        const { transfer: closed, outcome } = await closeReceipt(draft.id, f.distributor, tx);
        expect(closed.status).toBe("RECEIVED_WITH_DISCREPANCY");
        expect([...outcome.missingSerials].sort()).toEqual([...missing].sort());

        const open = await listOpenDiscrepancies(tx);
        const mine = open.filter((d) => d.transferCode === draft.code);
        expect(mine.map((d) => d.serial).sort()).toEqual([...missing].sort());

        // One event per state change: 50 dispatched, 48 received, 2 missing.
        let evs = await eventsFor(tx, draft.id);
        expect(count(evs, "DISPATCHED")).toBe(50);
        expect(count(evs, "RECEIVED")).toBe(48);
        expect(count(evs, "MISSING_IN_TRANSIT")).toBe(2);
        expect(evs).toHaveLength(100);

        // The supervisor resolves one as found and one as written off.
        const [a, b] = mine;
        // Found needs a scan, and the scan has to be the missing bottle.
        await expect(
          resolveDiscrepancy({ transferItemId: a.transferItemId, resolution: "FOUND", quantity: 1, note: "found on the shelf" }, f.supervisor.userId, tx),
        ).rejects.toThrow(/Scan the bottle to confirm/);
        await expect(
          resolveDiscrepancy(
            { transferItemId: a.transferItemId, resolution: "FOUND", quantity: 1, scannedCode: b.serial as string, note: "found on the shelf" },
            f.supervisor.userId,
            tx,
          ),
        ).rejects.toThrow(/Scan the bottle that went missing/);
        await resolveDiscrepancy(
          { transferItemId: a.transferItemId, resolution: "FOUND", quantity: 1, scannedCode: a.serial as string, note: "found on the shelf" },
          f.supervisor.userId,
          tx,
        );
        const last = await resolveDiscrepancy({ transferItemId: b.transferItemId, resolution: "WRITTEN_OFF", quantity: 1, note: "broken in transit" }, f.supervisor.userId, tx);
        expect(last.remainingOnTransfer).toBe(0);

        const [final] = await tx.select().from(transfers).where(eq(transfers.id, draft.id));
        expect(final.status).toBe("DISCREPANCY_RESOLVED");
        const [foundUnit] = await tx.select().from(units).where(eq(units.serial, a.serial as string));
        expect(foundUnit).toMatchObject({ state: "IN_STOCK", currentLocationId: f.lab.id, currentTransferId: null });
        const [lostUnit] = await tx.select().from(units).where(eq(units.serial, b.serial as string));
        expect(lostUnit.state).toBe("WRITTEN_OFF");

        evs = await eventsFor(tx, draft.id);
        expect(count(evs, "FOUND")).toBe(1);
        expect(count(evs, "WRITTEN_OFF")).toBe(1);
        expect((await listOpenDiscrepancies(tx)).filter((d) => d.transferCode === draft.code)).toHaveLength(0);
      });
    },
    // About 100 sequential scans, each several queries, against the hosted database: 300s was not enough.
    900_000,
  );
});

describe.skipIf(!hasDb)("dispatch rules", () => {
  it("a bottle can be on only one open transfer, and cancelling releases it", async () => {
    await inRollback(async (tx) => {
      const f = await fixtures(tx);
      const { serials } = await stockIn({ itemTypeId: f.bottle.id, locationId: f.store.id, quantity: 2 }, f.keeper.userId, tx);
      const first = await newDraft(tx, f);
      const second = await newDraft(tx, f);

      expect((await addUnitToTransfer(first.id, serials[0], tx)).status).toBe("added");
      expect((await addUnitToTransfer(first.id, serials[0], tx)).status).toBe("duplicate");
      await expect(addUnitToTransfer(second.id, serials[0], tx)).rejects.toThrow(/already on open transfer/);

      await cancelTransfer(first.id, tx);
      expect((await addUnitToTransfer(second.id, serials[0], tx)).status).toBe("added");
    });
  });

  it("refuses to confirm an empty draft", async () => {
    await inRollback(async (tx) => {
      const f = await fixtures(tx);

      const empty = await newDraft(tx, f);
      await expect(confirmTransfer(empty.id, f.keeper.userId, { carriedByName: "Test Porter" }, tx)).rejects.toBeInstanceOf(ValidationError);
    });
  });

  it("dispatch writes nothing when an item fails the re-check at confirm", async () => {
    await inRollback(async (tx) => {
      const f = await fixtures(tx);
      const { serials } = await stockIn({ itemTypeId: f.bottle.id, locationId: f.store.id, quantity: 2 }, f.keeper.userId, tx);
      const draft = await newDraft(tx, f);
      for (const s of serials) await addUnitToTransfer(draft.id, s, tx);

      // Void one bottle behind the draft's back.
      await tx.update(units).set({ state: "VOIDED" }).where(eq(units.serial, serials[1]));
      await expect(tx.transaction((t) => confirmTransfer(draft.id, f.keeper.userId, { carriedByName: "Test Porter" }, t))).rejects.toBeInstanceOf(Error);

      const [still] = await tx.select().from(transfers).where(eq(transfers.id, draft.id));
      expect(still.status).toBe("DRAFT");
      const [ok] = await tx.select().from(units).where(eq(units.serial, serials[0]));
      expect(ok.state).toBe("IN_STOCK");
      expect(await eventsFor(tx, draft.id)).toHaveLength(0);
    });
  });
});

describe.skipIf(!hasDb)("receiving", () => {
  it("rejects a bottle from another transfer, a duplicate scan, and the wrong location", async () => {
    await inRollback(async (tx) => {
      const f = await fixtures(tx);
      const { serials } = await stockIn({ itemTypeId: f.bottle.id, locationId: f.store.id, quantity: 4 }, f.keeper.userId, tx);

      const toLab = await newDraft(tx, f);
      await addUnitToTransfer(toLab.id, serials[0], tx);
      await addUnitToTransfer(toLab.id, serials[1], tx);
      await confirmTransfer(toLab.id, f.keeper.userId, { carriedByName: "Test Porter" }, tx);

      const toWard = await newDraft(tx, f, { toLocationId: f.ward.id });
      await addUnitToTransfer(toWard.id, serials[2], tx);
      await confirmTransfer(toWard.id, f.keeper.userId, { carriedByName: "Test Porter" }, tx);

      // Ward staff cannot open the lab's receipt.
      await expect(openReceipt(toLab.code, f.wardStaff, tx)).rejects.toBeInstanceOf(PermissionDeniedError);

      await openReceipt(toLab.code, f.distributor, tx);
      // A bottle that is on the ward's transfer is not on this one.
      await expect(receiveUnit(toLab.id, serials[2], f.distributor, tx)).rejects.toBeInstanceOf(WrongTransferError);

      expect((await receiveUnit(toLab.id, serials[0], f.distributor, tx)).status).toBe("received");
      const again = await receiveUnit(toLab.id, serials[0], f.distributor, tx);
      expect(again).toMatchObject({ status: "duplicate", scanned: 1, expected: 2 });

      const [moved] = await tx.select().from(units).where(eq(units.serial, serials[0]));
      expect(moved).toMatchObject({ state: "IN_STOCK", currentLocationId: f.lab.id });
      // The duplicate scan did not write a second event.
      const evs = await tx.select().from(events).where(eq(events.unitId, moved.id));
      expect(count(evs, "RECEIVED")).toBe(1);
    });
  });

  it("a receipt with everything scanned closes clean, and cannot be closed twice", async () => {
    await inRollback(async (tx) => {
      const f = await fixtures(tx);
      const { serials } = await stockIn({ itemTypeId: f.bottle.id, locationId: f.store.id, quantity: 3 }, f.keeper.userId, tx);
      const draft = await newDraft(tx, f);
      for (const s of serials) await addUnitToTransfer(draft.id, s, tx);
      await confirmTransfer(draft.id, f.keeper.userId, { carriedByName: "Test Porter" }, tx);
      await openReceipt(draft.code, f.distributor, tx);
      for (const s of serials) await receiveUnit(draft.id, s, f.distributor, tx);

      const { transfer } = await closeReceipt(draft.id, f.distributor, tx);
      expect(transfer.status).toBe("RECEIVED");
      await expect(closeReceipt(draft.id, f.distributor, tx)).rejects.toThrow(/Cannot close the receipt/);
      // Nothing is left open, so the bottles are free to travel again.
      const items = await tx.select().from(transferItems).where(eq(transferItems.transferId, draft.id));
      expect(items.every((i) => !i.open)).toBe(true);
    });
  });
});

describe.skipIf(!hasDb)("bulk quantities", () => {
  it("a short blind count is recorded by batch and resolved as a split", async () => {
    await inRollback(async (tx) => {
      const f = await fixtures(tx);
      const { batch } = await stockIn({ itemTypeId: f.gloves.id, locationId: f.store.id, quantity: 100 }, f.keeper.userId, tx);
      expect(await quantityOnHand(tx, batch.id, f.store.id)).toBe(100);

      const draft = await newDraft(tx, f);
      await expect(setBatchQuantity(draft.id, batch.code, 101, tx)).rejects.toThrow(/Only 100 of this batch/);
      await setBatchQuantity(draft.id, batch.code, 40, tx);
      await setBatchQuantity(draft.id, batch.code, 40, tx); // same batch again replaces, never adds
      await confirmTransfer(draft.id, f.keeper.userId, { carriedByName: "Test Porter" }, tx);
      expect(await quantityOnHand(tx, batch.id, f.store.id)).toBe(60);

      await openReceipt(draft.code, f.distributor, tx);
      // Cannot close before counting.
      await expect(closeReceipt(draft.id, f.distributor, tx)).rejects.toThrow(/Count these batches/);
      // A count above what was sent is bounced.
      await expect(countQuantity(draft.id, batch.code, 41, f.distributor, tx)).rejects.toThrow(/higher than what was sent/);
      await countQuantity(draft.id, batch.code, 34, f.distributor, tx);

      const { transfer } = await closeReceipt(draft.id, f.distributor, tx);
      expect(transfer.status).toBe("RECEIVED_WITH_DISCREPANCY");
      expect(await quantityOnHand(tx, batch.id, f.lab.id)).toBe(34);

      const [row] = (await listOpenDiscrepancies(tx)).filter((d) => d.transferCode === draft.code);
      expect(row).toMatchObject({ batchCode: batch.code, serial: null, dispatched: 40, received: 34, outstanding: 6 });

      await expect(
        resolveDiscrepancy({ transferItemId: row.transferItemId, resolution: "FOUND", quantity: 4, note: "in the ward cupboard" }, f.supervisor.userId, tx),
      ).rejects.toThrow(/Scan the box label to confirm/);
      await resolveDiscrepancy(
        { transferItemId: row.transferItemId, resolution: "FOUND", quantity: 4, scannedCode: batch.code, note: "in the ward cupboard" },
        f.supervisor.userId,
        tx,
      );
      await expect(
        resolveDiscrepancy({ transferItemId: row.transferItemId, resolution: "WRITTEN_OFF", quantity: 3, note: "damaged" }, f.supervisor.userId, tx),
      ).rejects.toThrow(/Only 2 is still unresolved/);
      const done = await resolveDiscrepancy({ transferItemId: row.transferItemId, resolution: "WRITTEN_OFF", quantity: 2, note: "damaged" }, f.supervisor.userId, tx);
      expect(done.remainingOnTransfer).toBe(0);

      const detail = await getTransferDetail(draft.code, tx);
      expect(detail?.quantityItems[0]).toMatchObject({ received: 34, missing: 6, found: 4, writtenOff: 2, resolution: "SPLIT" });
      expect(detail?.transfer.status).toBe("DISCREPANCY_RESOLVED");
      // Found stock lands at the destination; written-off stock is nowhere.
      expect(await quantityOnHand(tx, batch.id, f.lab.id)).toBe(38);
    });
  });
});
