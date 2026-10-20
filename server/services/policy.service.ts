import "server-only";
import { asc, eq, inArray } from "drizzle-orm";
import type { DbOrTx } from "../audit/events";
import { db } from "../db/client";
import { isUniqueViolation } from "../db/errors";
import { issuePolicies, itemTypes, testCatalog, testStandardItems } from "../db/schema";
import { NotFoundError, ValidationError } from "../domain/errors";
import { cleanAlternates } from "../../lib/containers";
import type { PolicyInput, TestInput, TestStandardItemsInput, TestUpdate } from "../../types/issue";

// Admin-maintained rules for issuing: the test catalog (which container each test needs) and the
// issue policies (whether payment is checked). The caller checks manage_test_catalog or
// manage_policies; these functions only enforce data rules.

// --- test catalog --------------------------------------------------------------

/**
 * The container fields as they are stored. Alternates only make sense next to a required container (a test
 * with none accepts any container already), and a repeat of the required type is dropped.
 */
function containerFields(input: Pick<TestInput, "requiredContainerType" | "alternateContainerTypes">) {
  const required = input.requiredContainerType ?? null;
  if (!required && input.alternateContainerTypes.length > 0) {
    throw new ValidationError(
      "Set a required container type first. A test with no required container already accepts any container",
    );
  }
  return {
    requiredContainerType: required,
    alternateContainerTypes: cleanAlternates(required, input.alternateContainerTypes),
  };
}

export async function listTests(conn: DbOrTx = db()) {
  return conn.select().from(testCatalog).orderBy(asc(testCatalog.code));
}

export async function createTest(input: TestInput, conn: DbOrTx = db()) {
  try {
    const [row] = await conn
      .insert(testCatalog)
      .values({
        code: input.code,
        name: input.name,
        containersConfirmed: input.containersConfirmed,
        ...containerFields(input),
      })
      .returning();
    return row;
  } catch (err) {
    if (isUniqueViolation(err)) throw new ValidationError(`Test ${input.code} already exists`);
    throw err;
  }
}

export async function updateTest(input: TestUpdate, conn: DbOrTx = db()) {
  const result = await conn
    .update(testCatalog)
    .set({ name: input.name, containersConfirmed: input.containersConfirmed, ...containerFields(input) })
    .where(eq(testCatalog.id, input.id))
    .returning({ id: testCatalog.id });
  if (result.length === 0) throw new NotFoundError("Test");
}

export async function setTestActive(id: string, active: boolean, conn: DbOrTx = db()) {
  const result = await conn.update(testCatalog).set({ active }).where(eq(testCatalog.id, id)).returning({ id: testCatalog.id });
  if (result.length === 0) throw new NotFoundError("Test");
}

// --- standard consumption per test ----------------------------------------------

export interface StandardItem {
  itemTypeId: string;
  code: string;
  name: string;
  unitOfMeasure: string;
  /** Pieces in one pack, so a pack item's quantity here can be labelled in pieces (see perTestUnit). */
  packSize: number;
  /** What one run of the test uses, in the item's stock unit. */
  quantity: number;
}

/** Every test's standard items, keyed by test id. A test with none listed has no entry. */
export async function listStandardItemsByTest(conn: DbOrTx = db()): Promise<Map<string, StandardItem[]>> {
  const rows = await conn
    .select({
      testId: testStandardItems.testId,
      itemTypeId: itemTypes.id,
      code: itemTypes.code,
      name: itemTypes.name,
      unitOfMeasure: itemTypes.unitOfMeasure,
      packSize: itemTypes.packSize,
      quantity: testStandardItems.quantity,
    })
    .from(testStandardItems)
    .innerJoin(itemTypes, eq(itemTypes.id, testStandardItems.itemTypeId))
    // A bench supply is never offered per test, whatever an older list still says.
    .where(eq(itemTypes.benchSupply, false))
    .orderBy(asc(itemTypes.name));
  const byTest = new Map<string, StandardItem[]>();
  for (const { testId, ...item } of rows) {
    const list = byTest.get(testId) ?? [];
    list.push(item);
    byTest.set(testId, list);
  }
  return byTest;
}

/**
 * Replaces the list of items one run of a test uses. Only QUANTITY items can be listed: a serialized bottle or
 * tube is scanned and issued on its own so the ledger knows which one it was. An empty list clears the test.
 * Saving never touches stock.
 */
export async function setTestStandardItems(input: TestStandardItemsInput, conn: DbOrTx = db()) {
  await conn.transaction(async (tx) => {
    const [test] = await tx.select({ id: testCatalog.id }).from(testCatalog).where(eq(testCatalog.id, input.testId));
    if (!test) throw new NotFoundError("Test");

    if (input.items.length > 0) {
      const found = await tx
        .select({
          id: itemTypes.id,
          name: itemTypes.name,
          trackingMode: itemTypes.trackingMode,
          benchSupply: itemTypes.benchSupply,
        })
        .from(itemTypes)
        .where(inArray(itemTypes.id, input.items.map((i) => i.itemTypeId)));
      if (found.length !== input.items.length) throw new NotFoundError("Item type");
      const serialized = found.find((f) => f.trackingMode !== "QUANTITY");
      if (serialized) {
        throw new ValidationError(
          `${serialized.name} is a serialized item, so it is scanned and issued on its own. Only bulk items can be listed here`,
        );
      }
      const bench = found.find((f) => f.benchSupply);
      if (bench) {
        throw new ValidationError(
          `${bench.name} is a bench supply, shared by many patients. Record it under Used for test, so it cannot be listed against a test`,
        );
      }
    }

    await tx.delete(testStandardItems).where(eq(testStandardItems.testId, input.testId));
    if (input.items.length > 0) {
      await tx
        .insert(testStandardItems)
        .values(input.items.map((i) => ({ testId: input.testId, itemTypeId: i.itemTypeId, quantity: i.quantity })));
    }
    await tx
      .update(testCatalog)
      .set({ consumptionConfirmed: input.consumptionConfirmed })
      .where(eq(testCatalog.id, input.testId));
  });
}

/** Adds a test together with its items, all or nothing, so a bad item never leaves a half-made test behind. */
export async function createTestWithItems(
  input: TestInput,
  standard: Pick<TestStandardItemsInput, "items" | "consumptionConfirmed">,
  conn: DbOrTx = db(),
) {
  return conn.transaction(async (tx) => {
    const test = await createTest(input, tx);
    await setTestStandardItems({ testId: test.id, ...standard }, tx);
    return test;
  });
}

/** Saves a test's details and its items together, all or nothing. */
export async function updateTestWithItems(
  input: TestUpdate,
  standard: Pick<TestStandardItemsInput, "items" | "consumptionConfirmed">,
  conn: DbOrTx = db(),
) {
  await conn.transaction(async (tx) => {
    await updateTest(input, tx);
    await setTestStandardItems({ testId: input.id, ...standard }, tx);
  });
}

// --- issue policies ------------------------------------------------------------

export async function listIssuePolicies(conn: DbOrTx = db()) {
  return conn.select().from(issuePolicies).orderBy(asc(issuePolicies.referenceType), asc(issuePolicies.patientType));
}

/** One rule per (reference type, patient type): saving again changes the existing rule. */
export async function savePolicy(input: PolicyInput, conn: DbOrTx = db()) {
  await conn
    .insert(issuePolicies)
    .values(input)
    .onConflictDoUpdate({ target: [issuePolicies.referenceType, issuePolicies.patientType], set: { rule: input.rule } });
}

export async function deletePolicy(id: string, conn: DbOrTx = db()) {
  const result = await conn.delete(issuePolicies).where(eq(issuePolicies.id, id)).returning({ id: issuePolicies.id });
  if (result.length === 0) throw new NotFoundError("Policy");
}
