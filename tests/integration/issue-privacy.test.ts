import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import type { Tx } from "../../server/audit/events";
import { db, sql as pg } from "../../server/db/client";
import { events, itemTypes, links, locations, testCatalog, units, users } from "../../server/db/schema";
import { ValidationError } from "../../server/domain/errors";
import type { Actor } from "../../server/domain/types";
import { mrnBlindIndex } from "../../server/security/field-crypto";
import { issueUnit } from "../../server/services/issue.service";
import { stockIn } from "../../server/services/stock-in.service";

// Privacy of what issuing stores. The ledger (events) can never be edited, so it must not hold the MRN, a
// collector's name or an override reason; those live only in `links`, where they can be corrected or erased.
// And the MRN in `links` must be encrypted at rest, with a searchable fingerprint beside it.
//
// Like the other integration tests: talks to the dev database but ALWAYS rolls back.
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

const MRN = "UATH/PT/7654321";
const COLLECTOR = "Ngozi Eze-Collector";
const OVERRIDE_REASON = "Theatre case, tube accepted by the consultant";

/** A store, a supervisor working there, and bottles in stock (issuing from the store keeps the setup small). */
async function fixture(tx: Tx) {
  const tag = randomUUID().slice(0, 8);
  const [store] = await tx.insert(locations).values({ code: `STORE-${tag}`, name: "Test Store", type: "STORE" }).returning();
  const userId = randomUUID();
  await tx.execute(sql`insert into auth.users (id, email) values (${userId}, ${`sup-${tag}@test.local`})`);
  await tx.insert(users).values({ id: userId, staffId: `sup-${tag}`, name: "Test Supervisor", role: "SUPERVISOR", homeLocationId: store.id });
  const actor: Actor = { userId, role: "SUPERVISOR", homeLocationId: store.id };
  const [bottle] = await tx
    .insert(itemTypes)
    .values({ code: `BOTTLE-${tag}`, name: "Test bottle", category: "SAMPLE_CONTAINER", trackingMode: "SERIAL", containerType: "HEPARIN" })
    .returning();
  const { serials } = await stockIn({ itemTypeId: bottle.id, locationId: store.id, quantity: 4 }, userId, tx);
  return { tag, store, actor, serials };
}

/** A fresh, valid investigation number that is unlikely to exist in the dev database. */
const newRef = () => `IXS9${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`;

async function ledgerPayload(tx: Tx, serial: string): Promise<string> {
  const [unit] = await tx.select({ id: units.id }).from(units).where(eq(units.serial, serial));
  const rows = await tx.select().from(events).where(eq(events.unitId, unit.id));
  const issued = rows.filter((r) => r.type === "ISSUED");
  expect(issued).toHaveLength(1);
  return JSON.stringify(issued[0].payload);
}

async function linkRows(tx: Tx, serial: string) {
  const [unit] = await tx.select({ id: units.id }).from(units).where(eq(units.serial, serial));
  return tx.select().from(links).where(eq(links.unitId, unit.id));
}

/** What is actually in the database columns, before the app decrypts anything. */
async function rawStored(tx: Tx, serial: string) {
  const [unit] = await tx.select({ id: units.id }).from(units).where(eq(units.serial, serial));
  const rows = await tx.execute<{ patient_hospital_no: string; patient_hospital_no_idx: string | null }>(
    sql`select patient_hospital_no, patient_hospital_no_idx from consumables.links where unit_id = ${unit.id}`,
  );
  return Array.from(rows);
}

afterAll(async () => {
  if (hasDb) await pg().end();
});

describe.skipIf(!hasDb)("issuing keeps personal details out of the ledger", () => {
  it("keeps the MRN and a non-patient collector's name out of the event, and the name in links", async () => {
    await inRollback(async (tx) => {
      const f = await fixture(tx);
      await issueUnit(
        {
          serial: f.serials[0],
          references: [{ type: "INVESTIGATION", ref: newRef(), reportedPayment: "PAID" }],
          patientHospitalNo: MRN,
          patientType: "OUTPATIENT",
          collectorType: "NURSE",
          collectorName: COLLECTOR,
          locationId: f.store.id,
        },
        f.actor,
        tx,
      );

      const payload = await ledgerPayload(tx, f.serials[0]);
      expect(payload).not.toContain(MRN);
      expect(payload).not.toContain("7654321");
      expect(payload).not.toContain("Ngozi");
      expect(payload).toContain("NURSE"); // the type is kept, only the name is not

      const [link] = await linkRows(tx, f.serials[0]);
      expect(link.collectorName).toBe(COLLECTOR);
      expect(link.patientHospitalNo).toBe(MRN); // the app sees the plain value
    });
  });

  it("stores the MRN encrypted, with a fingerprint that matches", async () => {
    await inRollback(async (tx) => {
      const f = await fixture(tx);
      await issueUnit(
        {
          serial: f.serials[0],
          references: [{ type: "INVESTIGATION", ref: newRef(), reportedPayment: "PAID" }],
          patientHospitalNo: MRN,
          patientType: "OUTPATIENT",
          collectorType: "PATIENT",
          locationId: f.store.id,
        },
        f.actor,
        tx,
      );

      const [raw] = await rawStored(tx, f.serials[0]);
      expect(raw.patient_hospital_no.startsWith("enc:v1:")).toBe(true);
      expect(raw.patient_hospital_no).not.toContain("7654321");
      expect(raw.patient_hospital_no_idx).toBe(mrnBlindIndex(MRN));
    });
  });

  it("keeps no name for a patient collector, even when one is sent", async () => {
    await inRollback(async (tx) => {
      const f = await fixture(tx);
      await issueUnit(
        {
          serial: f.serials[0],
          references: [{ type: "INVESTIGATION", ref: newRef(), reportedPayment: "PAID" }],
          patientHospitalNo: MRN,
          patientType: "OUTPATIENT",
          collectorType: "PATIENT",
          collectorName: "Typed By Mistake",
          locationId: f.store.id,
        },
        f.actor,
        tx,
      );

      const [link] = await linkRows(tx, f.serials[0]);
      expect(link.collectorType).toBe("PATIENT");
      expect(link.collectorName).toBeNull();
      expect(await ledgerPayload(tx, f.serials[0])).not.toContain("Typed By Mistake");
    });
  });

  it("requires a name when someone other than the patient collects", async () => {
    await inRollback(async (tx) => {
      const f = await fixture(tx);
      await expect(
        issueUnit(
          {
            serial: f.serials[0],
            references: [{ type: "INVESTIGATION", ref: newRef(), reportedPayment: "PAID" }],
            patientHospitalNo: MRN,
            patientType: "OUTPATIENT",
            collectorType: "PORTER",
            locationId: f.store.id,
          },
          f.actor,
          tx,
        ),
      ).rejects.toBeInstanceOf(ValidationError);
    });
  });

  it("keeps an override reason in links only, with just who approved it in the event", async () => {
    await inRollback(async (tx) => {
      const f = await fixture(tx);
      // The test needs an EDTA tube but the bottle is HEPARIN: a mismatch only a supervisor can override.
      const code = `T${f.tag.toUpperCase()}`;
      await tx.insert(testCatalog).values({ code, name: "Test needing EDTA", requiredContainerType: "EDTA" });

      await issueUnit(
        {
          serial: f.serials[0],
          references: [{ type: "INVESTIGATION", ref: newRef(), testCode: code, reportedPayment: "PAID" }],
          patientHospitalNo: MRN,
          patientType: "OUTPATIENT",
          collectorType: "NURSE",
          collectorName: COLLECTOR,
          override: { reason: OVERRIDE_REASON },
          locationId: f.store.id,
        },
        f.actor,
        tx,
      );

      const payload = await ledgerPayload(tx, f.serials[0]);
      expect(payload).not.toContain("consultant");
      expect(payload).not.toContain("Theatre");
      expect(payload).toContain(f.actor.userId); // who approved it stays

      const [link] = await linkRows(tx, f.serials[0]);
      expect(link.overrideReason).toBe(OVERRIDE_REASON);
      expect(link.overrideBy).toBe(f.actor.userId);
    });
  });
});
