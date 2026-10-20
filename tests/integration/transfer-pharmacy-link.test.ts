import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Tx } from "../../server/audit/events";
import { db, sql as pg } from "../../server/db/client";
import { itemTypes, locations, users } from "../../server/db/schema";
import { ValidationError } from "../../server/domain/errors";
import type { PharmacyTransferInfo } from "../../server/integrations/pharmacy";
import { stockIn } from "../../server/services/stock-in.service";
import { addUnitToTransfer, confirmTransfer, createTransfer } from "../../server/services/transfer.service";

// A tracker transfer linked to a Pharmacy transfer takes its quantity from Pharmacy when Pharmacy has
// the transfer on file. The provider reads over its own connection, so these tests give the service a
// fixed set of Pharmacy transfers; everything else runs against the dev database and ALWAYS rolls back.
// Skipped when DATABASE_URL is not set (for example in CI).
const pharmacy = vi.hoisted(() => ({ transfers: new Map<string, number>() }));

vi.mock("../../server/integrations/pharmacy", () => ({
  pharmacyProvider: () => ({
    source: "csv" as const,
    listGrns: async () => [],
    getBatch: async () => null,
    getBalances: async () => [],
    getTransfer: async (ref: string): Promise<PharmacyTransferInfo | null> => {
      const quantity = pharmacy.transfers.get(ref.trim().toUpperCase());
      if (quantity === undefined) return null;
      return {
        ref,
        type: null,
        fromLabel: null,
        toLabel: null,
        status: null,
        requestedBy: null,
        requestedAt: null,
        quantity,
        lines: null,
      };
    },
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

async function fixtures(tx: Tx) {
  const tag = randomUUID().slice(0, 8);
  const userId = randomUUID();
  await tx.execute(sql`insert into auth.users (id, email) values (${userId}, ${`t-${tag}@test.local`})`);
  const [store] = await tx.insert(locations).values({ code: `STORE-${tag}`, name: "Test Store", type: "STORE" }).returning();
  const [lab] = await tx.insert(locations).values({ code: `LAB-${tag}`, name: "Test Lab", type: "LAB" }).returning();
  await tx.insert(users).values({ id: userId, staffId: `T-${tag}`, name: "Test Keeper", role: "STORE_KEEPER", homeLocationId: store.id });
  const [bottle] = await tx
    .insert(itemTypes)
    .values({ code: `BOTTLE-${tag}`, name: "Test bottle", category: "SAMPLE_CONTAINER", trackingMode: "SERIAL", containerType: "EDTA" })
    .returning();
  return { tag, userId, store, lab, bottle };
}

afterAll(async () => {
  if (hasDb) await pg().end();
});

beforeEach(() => {
  pharmacy.transfers = new Map();
});

describe.skipIf(!hasDb)("linking a transfer to a Pharmacy transfer", () => {
  it("takes the quantity from Pharmacy when it has the transfer, whatever was typed", async () => {
    await inRollback(async (tx) => {
      const f = await fixtures(tx);
      pharmacy.transfers.set(`PH-${f.tag}`.toUpperCase(), 12);
      const base = { fromLocationId: f.store.id, toLocationId: f.lab.id };

      const typedWrong = await createTransfer({ ...base, pharmacyTransferId: `PH-${f.tag}`, pharmacyQuantity: 99 }, f.userId, tx);
      expect(typedWrong).toMatchObject({ pharmacyTransferId: `PH-${f.tag}`, pharmacyQuantity: 12 });

      // No quantity typed, and the id in another case: still found.
      const idOnly = await createTransfer({ ...base, pharmacyTransferId: `ph-${f.tag}` }, f.userId, tx);
      expect(idOnly.pharmacyQuantity).toBe(12);
    });
  });

  it("falls back to the typed quantity when Pharmacy does not have the transfer, and asks for one when none was typed", async () => {
    await inRollback(async (tx) => {
      const f = await fixtures(tx);
      const base = { fromLocationId: f.store.id, toLocationId: f.lab.id };

      const typed = await createTransfer({ ...base, pharmacyTransferId: `PH-${f.tag}`, pharmacyQuantity: 5 }, f.userId, tx);
      expect(typed.pharmacyQuantity).toBe(5);

      await expect(createTransfer({ ...base, pharmacyTransferId: `PH-${f.tag}` }, f.userId, tx)).rejects.toThrow(/not on file/);
      await expect(createTransfer({ ...base, pharmacyQuantity: 5 }, f.userId, tx)).rejects.toBeInstanceOf(ValidationError);
    });
  });

  it("leaves an unlinked transfer unlinked", async () => {
    await inRollback(async (tx) => {
      const f = await fixtures(tx);
      const t = await createTransfer({ fromLocationId: f.store.id, toLocationId: f.lab.id }, f.userId, tx);
      expect(t).toMatchObject({ pharmacyTransferId: null, pharmacyQuantity: null });
    });
  });

  it("dispatch must match Pharmacy's quantity, or carry an explanation", async () => {
    await inRollback(async (tx) => {
      const f = await fixtures(tx);
      pharmacy.transfers.set(`PH-${f.tag}`.toUpperCase(), 5);
      const { serials } = await stockIn({ itemTypeId: f.bottle.id, locationId: f.store.id, quantity: 2 }, f.userId, tx);

      const draft = await createTransfer({ fromLocationId: f.store.id, toLocationId: f.lab.id, pharmacyTransferId: `PH-${f.tag}` }, f.userId, tx);
      for (const s of serials) await addUnitToTransfer(draft.id, s, tx);

      await expect(confirmTransfer(draft.id, f.userId, { carriedByName: "Test Porter" }, tx)).rejects.toThrow(/Explain the difference/);
      const { transfer } = await confirmTransfer(draft.id, f.userId, { carriedByName: "Test Porter", explanation: "three still at Pharmacy" }, tx);
      expect(transfer.quantityMismatchNote).toBe("three still at Pharmacy");
    });
  });
});
