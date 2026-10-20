import "server-only";
import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, gte, inArray, isNull, or, sql } from "drizzle-orm";
import { appendEvents, type DbOrTx, type NewEvent, type Tx } from "../audit/events";
import { db } from "../db/client";
import { isUniqueViolation } from "../db/errors";
import { lockUnitBySerial } from "../db/queries/locking";
import { quantityLoose, quantityOnHand } from "../db/queries/quantity";
import {
  batches,
  events,
  investigationImports,
  issuePolicies,
  itemTypes,
  links,
  locations,
  packs,
  testCatalog,
  testStandardItems,
  units,
  users,
} from "../db/schema";
import {
  ContainerMismatchError,
  InvalidSerialError,
  NotFoundError,
  PatientMismatchError,
  PaymentRequiredError,
  ValidationError,
} from "../domain/errors";
import {
  assertCanIssueUnit,
  assertCanOverride,
  assertReferenceAllowedAtLocation,
  assertSamePatient,
  containerMismatch,
  evaluatePayment,
  pickPolicyRule,
  resolveWorkLocation,
  type KnownPayment,
} from "../domain/issue-rules";
import { transition } from "../domain/state-machine";
import { mrnBlindIndexOrNull } from "../security/field-crypto";
import type { Actor, IssueRule, PatientType, PaymentCheck, ReferenceType } from "../domain/types";
import { referenceProvider } from "../integrations/reference";
import { acceptedContainers } from "../../lib/containers";
import { isPackUnit, planPieceDispatch } from "../../lib/pack-size";
import {
  isValidMrn,
  needsPatient,
  normalizeMrn,
  normalizeReference,
} from "../../lib/reference-formats";
import { parsePackCode, parseSerial } from "../../lib/serial";
import { pageInfo, type Paged } from "../../lib/pagination";
import {
  consumptionIssueSchema,
  issueUnitSchema,
  type ConsumptionIssueInput,
  type IssueUnitInput,
  type ReferenceInput,
} from "../../types/issue";

// Issue (architecture 7.4): hand a SERIAL bottle to a patient's investigation (or another reference) together
// with the per-patient items its test uses. Shared bench supplies are not issued here: the lab records them under
// Used for test (lab-usage.service.ts). Callers check the `issue` permission.
//
// One scan of a bottle links it to EVERY reference in the group and writes exactly one ISSUED
// event, in the same transaction as the state change. A supervisor can override a container
// mismatch or an unpaid reference; the override and its reason are stored on the links.

const today = () => new Date().toISOString().slice(0, 10);

/**
 * A patient collecting their own sample needs no name, and none is kept. For anyone else the name is required.
 * Free text can hold anything staff type, so it is never stored for a patient and never goes in the ledger.
 */
function resolveCollectorName(type: string, name: string | undefined): string | null {
  if (type === "PATIENT") return null;
  const trimmed = name?.trim() ?? "";
  if (!trimmed) throw new ValidationError("Enter the name of who collected it");
  return trimmed;
}

/** The name and service role of the place stock is issued from, for the department-only rule. */
async function workLocationFacts(conn: DbOrTx, locationId: string) {
  const [row] = await conn
    .select({ name: locations.name, serviceRole: locations.serviceRole })
    .from(locations)
    .where(eq(locations.id, locationId));
  if (!row) throw new NotFoundError("Location");
  return row;
}

interface CheckedReference {
  type: ReferenceType;
  ref: string;
  testCode: string | null;
  payment: KnownPayment;
}

/** Validates the patient number and every reference, and asks the provider about each one. */
async function checkReferences(
  refs: readonly ReferenceInput[],
  mrnInput: string | undefined,
  patientTypeInput: PatientType | undefined,
  sourceOverride?: "extension",
) {
  const provider = referenceProvider();
  const mrn = mrnInput ? normalizeMrn(mrnInput) : null;
  if (mrn && !isValidMrn(mrn)) {
    throw new ValidationError(`"${mrnInput}" is not a valid hospital number (expected UATH/PT/ followed by digits)`);
  }

  let patientType = patientTypeInput;
  const seen = new Set<string>();
  const out: CheckedReference[] = [];
  for (const r of refs) {
    const ref = normalizeReference(r.ref);
    if (needsPatient(r.type) && !mrn) throw new ValidationError("Enter the patient's hospital number");
    const key = `${r.type}:${ref}`;
    if (seen.has(key)) throw new ValidationError(`${ref} is listed twice`);
    seen.add(key);

    const found = await provider.lookup(r.type, ref); // throws a ValidationError on a malformed number
    if (found.exists === false) throw new ValidationError(`${ref} was not found`);
    if (found.patientHospitalNo && mrn && normalizeMrn(found.patientHospitalNo) !== mrn) {
      throw new PatientMismatchError(`${ref} belongs to a different patient than ${mrn}`);
    }
    patientType = patientType ?? found.patientType;
    out.push({ type: r.type, ref, testCode: r.testCode ?? null, payment: r.reportedPayment ?? found.paymentStatus });
  }
  return { mrn, patientType, refs: out, source: sourceOverride ?? provider.source };
}

/**
 * The containers each listed test accepts (required type plus alternates), one entry per test that has a
 * requirement. A test code that is not in the catalog is an error.
 */
async function requiredContainers(tx: Tx, testCodes: readonly string[]): Promise<string[][]> {
  if (testCodes.length === 0) return [];
  const rows = await tx
    .select({
      code: testCatalog.code,
      container: testCatalog.requiredContainerType,
      alternates: testCatalog.alternateContainerTypes,
    })
    .from(testCatalog)
    .where(and(inArray(testCatalog.code, [...testCodes]), eq(testCatalog.active, true)));
  const known = new Set(rows.map((r) => r.code));
  const unknown = testCodes.filter((c) => !known.has(c));
  if (unknown.length) throw new ValidationError(`Test ${unknown.join(", ")} is not in the test catalog`);
  return rows.map((r) => acceptedContainers(r.container, r.alternates)).filter((set) => set.length > 0);
}

function evaluate(
  policies: { referenceType: ReferenceType; patientType: "OUTPATIENT" | "INPATIENT" | "WALK_IN" | "ANY"; rule: IssueRule }[],
  refs: readonly CheckedReference[],
  patientType: PatientType | undefined,
) {
  return refs.map((r) => {
    const rule = pickPolicyRule(policies, r.type, patientType);
    return { ...r, rule, ...evaluatePayment(rule, r.payment) };
  });
}

/** If something blocks the issue, only a supervisor with a reason can push it through. */
function resolveOverride(
  actor: Actor,
  overrideInput: { reason: string } | undefined,
  mismatch: string | null,
  unpaid: readonly { ref: string }[],
): { by: string; reason: string } | null {
  if (!mismatch && unpaid.length === 0) return null;
  if (!overrideInput) {
    if (mismatch) throw new ContainerMismatchError(mismatch);
    throw new PaymentRequiredError(
      `${unpaid[0].ref} is not paid. Payment must be confirmed before issuing; a supervisor can override with a reason`,
    );
  }
  return { by: actor.userId, reason: assertCanOverride(actor, overrideInput.reason) };
}

export interface IssueUnitResult {
  serial: string;
  itemName: string;
  references: { type: ReferenceType; ref: string; paymentCheck: PaymentCheck }[];
  unverified: number;
  overridden: boolean;
}

/** Issue one bottle to a group of references. */
export async function issueUnit(rawInput: IssueUnitInput, actor: Actor, conn: DbOrTx = db()): Promise<IssueUnitResult> {
  const parsed = issueUnitSchema.safeParse(rawInput);
  if (!parsed.success) throw new ValidationError(parsed.error.issues.map((i) => i.message).join("; "));
  const input = parsed.data;

  const serial = parseSerial(input.serial);
  if (!serial) throw new InvalidSerialError(input.serial);
  const collectorName = resolveCollectorName(input.collectorType, input.collectorName);
  const workLocationId = resolveWorkLocation(actor, input.locationId);
  assertReferenceAllowedAtLocation(
    await workLocationFacts(conn, workLocationId),
    input.references.map((r) => r.type),
  );
  const checked = await checkReferences(input.references, input.patientHospitalNo, input.patientType, input.source);

  return conn.transaction(async (tx) => {
    const unit = await lockUnitBySerial(tx, serial);
    if (!unit) throw new ValidationError(`${serial} is not in the system`);
    assertCanIssueUnit(unit, workLocationId, today());

    const testCodes = [...new Set(checked.refs.map((r) => r.testCode).filter((c): c is string => Boolean(c)))];
    const required = await requiredContainers(tx, testCodes);
    const mismatch = containerMismatch(serial, unit.containerType, required);

    const policies = await tx.select().from(issuePolicies);
    const evaluated = evaluate(policies, checked.refs, checked.patientType);
    const unpaid = evaluated.filter((e) => e.blocked);
    const override = resolveOverride(actor, input.override, mismatch, unpaid);

    const activeLinks = await tx
      .select({ mrn: links.patientHospitalNo })
      .from(links)
      .where(and(eq(links.unitId, unit.id), isNull(links.clearedAt)));
    assertSamePatient(
      activeLinks.map((l) => l.mrn),
      checked.mrn,
      serial,
    );

    const step = transition(unit.state, "ISSUE");
    const now = new Date();
    await tx.update(units).set({ state: step.to, currentTransferId: null }).where(eq(units.id, unit.id));

    const eventId = randomUUID();
    const first = evaluated[0];
    await appendEvents(tx, [
      {
        id: eventId,
        unitId: unit.id,
        batchId: unit.batchId,
        quantity: 1,
        type: step.event,
        fromState: unit.state,
        toState: step.to,
        locationId: workLocationId,
        userId: actor.userId,
        referenceType: first.type,
        referenceRef: first.ref,
        occurredAt: now,
        payload: {
          references: evaluated.map((e) => ({
            type: e.type,
            ref: e.ref,
            testCode: e.testCode,
            paymentCheck: e.check,
          })),
          // No MRN, collector name or override reason here: the ledger can never be edited, so personal and
          // free-text details live only in `links`, where they can be corrected or erased.
          patientType: checked.patientType ?? null,
          collector: { type: input.collectorType },
          override: override ? { by: override.by } : null,
        },
      },
    ]);

    try {
      await tx.insert(links).values(
        evaluated.map((e) => ({
          unitId: unit.id,
          batchId: unit.batchId,
          quantity: 1,
          referenceType: e.type,
          referenceRef: e.ref,
          referenceSource: checked.source,
          testCode: e.testCode,
          patientHospitalNo: checked.mrn,
          patientHospitalNoIdx: mrnBlindIndexOrNull(checked.mrn),
          patientType: checked.patientType ?? null,
          paymentCheck: e.check,
          issueEventId: eventId,
          issuedBy: actor.userId,
          locationId: workLocationId,
          collectorType: input.collectorType,
          collectorName,
          overrideBy: override?.by ?? null,
          overrideReason: override?.reason ?? null,
        })),
      );
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ValidationError(`${serial} is already linked to one of these references`);
      }
      throw err;
    }

    return {
      serial,
      itemName: unit.itemName,
      references: evaluated.map((e) => ({ type: e.type, ref: e.ref, paymentCheck: e.check })),
      unverified: evaluated.filter((e) => e.check === "UNVERIFIED").length,
      overridden: override !== null,
    };
  });
}

// --- issue for a test (standard consumption) ---------------------------------------

export interface IssueForTestResult {
  testCode: string;
  tests: number;
  department: string;
  /** True when the confirmed lines differ from the test's standard items (an item added, removed or changed). */
  edited: boolean;
  lines: {
    itemName: string;
    /** In loose pieces when `inPieces`, otherwise in the item's own unit. */
    quantity: number;
    inPieces: boolean;
    batchCodes: string[];
  }[];
}

/**
 * Takes `quantity` of one bulk item from the batches held at a location, earliest expiry first, skipping
 * expired batches. Every batch it draws from is locked. A shortfall is an error: nothing is issued part-way.
 */
export async function allocateFromBatches(tx: Tx, itemTypeId: string, itemName: string, locationId: string, quantity: number) {
  const candidates = await tx
    .select({ id: batches.id, code: batches.code })
    .from(batches)
    .where(and(eq(batches.itemTypeId, itemTypeId), or(isNull(batches.expiryDate), gte(batches.expiryDate, today()))))
    .orderBy(asc(batches.expiryDate), asc(batches.createdAt), asc(batches.id));

  let remaining = quantity;
  const taken: { batchId: string; code: string; quantity: number }[] = [];
  for (const candidate of candidates) {
    if (remaining === 0) break;
    await tx.select({ id: batches.id }).from(batches).where(eq(batches.id, candidate.id)).for("update");
    const onHand = await quantityOnHand(tx, candidate.id, locationId);
    if (onHand <= 0) continue;
    const take = Math.min(onHand, remaining);
    taken.push({ batchId: candidate.id, code: candidate.code, quantity: take });
    remaining -= take;
  }
  if (remaining > 0) {
    throw new ValidationError(
      `Only ${quantity - remaining} of ${itemName} in stock here (expired batches are left out), but ${quantity} are needed`,
    );
  }
  return taken;
}

/**
 * Takes `pieces` of a pack item from the batches held at a location, earliest expiry first, skipping expired batches.
 * Inside a batch the loose pieces of an opened pack go first; only when they run out is a sealed pack opened (the
 * same rule a transfer of pieces follows, see planPieceDispatch). `opened` is how many sealed packs that takes.
 * A shortfall is an error: nothing is issued part-way.
 */
export async function allocatePiecesFromBatches(
  tx: Tx,
  itemTypeId: string,
  itemName: string,
  locationId: string,
  pieces: number,
  packSize: number,
) {
  const candidates = await tx
    .select({ id: batches.id, code: batches.code })
    .from(batches)
    .where(and(eq(batches.itemTypeId, itemTypeId), or(isNull(batches.expiryDate), gte(batches.expiryDate, today()))))
    .orderBy(asc(batches.expiryDate), asc(batches.createdAt), asc(batches.id));

  let remaining = pieces;
  const taken: { batchId: string; code: string; quantity: number; opened: number }[] = [];
  for (const candidate of candidates) {
    if (remaining === 0) break;
    await tx.select({ id: batches.id }).from(batches).where(eq(batches.id, candidate.id)).for("update");
    const sealed = Math.max(await quantityOnHand(tx, candidate.id, locationId), 0);
    const loose = Math.max(await quantityLoose(tx, candidate.id, locationId), 0);
    const available = sealed * packSize + loose;
    if (available <= 0) continue;
    const take = Math.min(available, remaining);
    const plan = planPieceDispatch({ sealed, loose, packSize, pieces: take });
    if ("error" in plan) throw new ValidationError(plan.error);
    taken.push({ batchId: candidate.id, code: candidate.code, quantity: take, opened: plan.opened });
    remaining -= take;
  }
  if (remaining > 0) {
    throw new ValidationError(
      `Only ${pieces - remaining} pieces of ${itemName} in stock here (expired batches are left out), but ${pieces} are needed`,
    );
  }
  return taken;
}

/**
 * Takes `pieces` from one named pack's batch (the pack that was scanned), instead of choosing batches by expiry.
 * The batch's own balance here must cover the pieces, the batch must not be expired, and the pack must still hold
 * that many pieces. The pack row is locked after its batch (the order a transfer uses), and its pieces remaining are
 * lowered by the caller once the ledger events are written. Pack rows do not follow transfers, so the pack's
 * recorded location is not compared with the working location; the batch balance here is what guards the stock.
 */
export async function allocatePiecesFromPack(
  tx: Tx,
  packInput: string,
  itemTypeId: string,
  itemName: string,
  locationId: string,
  pieces: number,
  packSize: number,
) {
  const packCode = parsePackCode(packInput);
  if (!packCode) throw new ValidationError(`That is not a valid pack code (${itemName})`);
  const [found] = await tx.select({ batchId: packs.batchId }).from(packs).where(eq(packs.code, packCode));
  if (!found) throw new NotFoundError("Pack");
  // Batch first, then the pack, so this cannot deadlock with a transfer confirming the same pack.
  await tx.select({ id: batches.id }).from(batches).where(eq(batches.id, found.batchId)).for("update");
  const [pack] = await tx.select().from(packs).where(eq(packs.code, packCode)).for("update");
  if (!pack) throw new NotFoundError("Pack");
  if (pack.itemTypeId !== itemTypeId) throw new ValidationError(`Pack ${pack.code} is not a pack of ${itemName}`);
  if (pack.piecesRemaining < pieces) {
    throw new ValidationError(
      `Pack ${pack.code} has ${pack.piecesRemaining} ${pack.piecesRemaining === 1 ? "piece" : "pieces"} left, but ${pieces} are needed. Enter ${pack.piecesRemaining} or fewer, or scan another pack`,
    );
  }
  const [batch] = await tx
    .select({ id: batches.id, code: batches.code, expiryDate: batches.expiryDate })
    .from(batches)
    .where(eq(batches.id, pack.batchId));
  if (!batch) throw new NotFoundError("Batch");
  if (batch.expiryDate && batch.expiryDate < today()) {
    throw new ValidationError(`Pack ${pack.code} is from batch ${batch.code}, which has expired`);
  }
  const sealed = Math.max(await quantityOnHand(tx, batch.id, locationId), 0);
  const loose = Math.max(await quantityLoose(tx, batch.id, locationId), 0);
  if (sealed * packSize + loose < pieces) {
    throw new ValidationError(
      `Only ${sealed * packSize + loose} pieces of ${itemName} from batch ${batch.code} in stock here, but ${pieces} are needed`,
    );
  }
  const plan = planPieceDispatch({ sealed, loose, packSize, pieces });
  if ("error" in plan) throw new ValidationError(plan.error);
  return { pack, taken: [{ batchId: batch.id, code: batch.code, quantity: pieces, opened: plan.opened }] };
}

/**
 * Issue the bulk items for a number of runs of one test to a department (corrections C9, "expected consumption").
 * The screen pre-fills the test's standard items and the person confirms, edits, adds or removes lines; the
 * lines they confirm are what leave stock, drawn earliest-expiry-first from the batches held here. Serialized
 * items are not accepted: a bottle or tube is scanned and issued on its own. Whether the confirmed lines
 * differ from the standard is worked out here and kept on each ISSUED event, so over-use can be told apart
 * from normal use later.
 */
export async function issueForTest(
  rawInput: ConsumptionIssueInput,
  actor: Actor,
  conn: DbOrTx = db(),
): Promise<IssueForTestResult> {
  const parsed = consumptionIssueSchema.safeParse(rawInput);
  if (!parsed.success) throw new ValidationError(parsed.error.issues.map((i) => i.message).join("; "));
  const input = parsed.data;

  const workLocationId = resolveWorkLocation(actor, input.locationId);
  const workFacts = await workLocationFacts(conn, workLocationId);
  // With a patient (the extension) the items are tied to that investigation, like the bottle they go with. Without one
  // (the Issue page) they are recorded against the department, as before.
  const forPatient = input.forPatient;
  assertReferenceAllowedAtLocation(workFacts, [forPatient ? "INVESTIGATION" : "DEPARTMENT"]);
  // No department is asked for: the items are recorded against the place they were used at.
  const department = input.department?.trim() || workFacts.name;
  const checked = forPatient
    ? await checkReferences(
        [
          {
            type: "INVESTIGATION",
            ref: forPatient.investigationRef,
            testCode: input.testCode,
            reportedPayment: forPatient.reportedPayment,
          },
        ],
        forPatient.hospitalNo,
        forPatient.patientType,
        forPatient.source,
      )
    : await checkReferences([{ type: "DEPARTMENT", ref: department }], undefined, undefined);

  return conn.transaction(async (tx) => {
    const [test] = await tx
      .select({ id: testCatalog.id, code: testCatalog.code })
      .from(testCatalog)
      .where(and(eq(testCatalog.code, input.testCode), eq(testCatalog.active, true)));
    if (!test) throw new ValidationError(`Test ${input.testCode} is not in the test catalog`);

    const itemRows = await tx
      .select({
        id: itemTypes.id,
        name: itemTypes.name,
        trackingMode: itemTypes.trackingMode,
        unitOfMeasure: itemTypes.unitOfMeasure,
        packSize: itemTypes.packSize,
        benchSupply: itemTypes.benchSupply,
      })
      .from(itemTypes)
      .where(inArray(itemTypes.id, input.items.map((i) => i.itemTypeId)));
    if (itemRows.length !== input.items.length) throw new NotFoundError("Item type");
    const serialized = itemRows.find((r) => r.trackingMode !== "QUANTITY");
    if (serialized) {
      throw new ValidationError(
        `${serialized.name} is a serialized item. Scan and issue it on its own instead of listing it here`,
      );
    }
    // A bench supply serves many patients, so it is never issued per test or tied to one patient.
    const bench = itemRows.find((r) => r.benchSupply);
    if (bench) {
      throw new ValidationError(
        `${bench.name} is a bench supply, shared by many patients. Record it under Used for test, so it cannot be issued for a test`,
      );
    }
    const nameOf = new Map(itemRows.map((r) => [r.id, r.name]));
    // A pack item (unit "Pack", pack size above 1) is issued in loose pieces: nobody uses a whole pack for one test.
    // Its quantity on this screen, and in the test's standard list, is therefore a number of pieces.
    const pieceItems = new Map<string, number>(
      itemRows.filter((r) => isPackUnit(r.unitOfMeasure) && r.packSize > 1).map((r) => [r.id, r.packSize]),
    );

    // Was the confirmed list changed from the standard? Compared on the server, never taken from the screen.
    const standard = await tx
      .select({ itemTypeId: testStandardItems.itemTypeId, quantity: testStandardItems.quantity })
      .from(testStandardItems)
      .where(eq(testStandardItems.testId, test.id));
    const expected = new Map(standard.map((s) => [s.itemTypeId, s.quantity * input.testCount]));
    const edited =
      expected.size !== input.items.length || input.items.some((i) => expected.get(i.itemTypeId) !== i.quantity);

    const policies = await tx.select().from(issuePolicies);
    const [evaluated] = evaluate(policies, checked.refs, checked.patientType);
    // A department never needs payment, but if a policy says otherwise it is honoured here too (no override).
    // Items for a patient follow the bottle they were issued with: its payment check and any override already
    // happened (in the same transaction), so they are not blocked a second time.
    if (!forPatient) resolveOverride(actor, undefined, null, evaluated.blocked ? [evaluated] : []);

    const now = new Date();
    const lines: IssueForTestResult["lines"] = [];
    // A fixed order, so two people issuing at the same time lock the batches in the same order.
    const ordered = [...input.items].sort((a, b) => a.itemTypeId.localeCompare(b.itemTypeId));
    for (const line of ordered) {
      const itemName = nameOf.get(line.itemTypeId) ?? "item";
      const packSize = pieceItems.get(line.itemTypeId);
      const inPieces = packSize !== undefined;
      const packInput = line.packCode?.trim() || null;
      if (packInput && !inPieces) {
        throw new ValidationError(`${itemName} is not counted in packs, so a pack label cannot be used for it`);
      }
      let scannedPack: typeof packs.$inferSelect | null = null;
      let taken: { batchId: string; code: string; quantity: number; opened: number }[];
      if (packInput && packSize !== undefined) {
        const fromPack = await allocatePiecesFromPack(tx, packInput, line.itemTypeId, itemName, workLocationId, line.quantity, packSize);
        scannedPack = fromPack.pack;
        taken = fromPack.taken;
      } else if (packSize !== undefined) {
        taken = await allocatePiecesFromBatches(tx, line.itemTypeId, itemName, workLocationId, line.quantity, packSize);
      } else {
        taken = (await allocateFromBatches(tx, line.itemTypeId, itemName, workLocationId, line.quantity)).map((t) => ({
          ...t,
          opened: 0,
        }));
      }
      if (scannedPack) {
        await tx
          .update(packs)
          .set({ piecesRemaining: scannedPack.piecesRemaining - line.quantity })
          .where(eq(packs.id, scannedPack.id));
      }
      for (const part of taken) {
        const eventId = randomUUID();
        const issueEvents: NewEvent[] = [];
        if (part.opened > 0) {
          // Opening a pack takes it off the sealed balance and adds its pieces to the loose ones.
          issueEvents.push({
            id: randomUUID(),
            unitId: null,
            batchId: part.batchId,
            quantity: part.opened,
            pieces: part.opened * (packSize ?? 1),
            type: "OPENED",
            locationId: workLocationId,
            userId: actor.userId,
            occurredAt: now,
            payload: { reason: "OPENED_FOR_PIECES", consumption: { testCode: test.code } },
          });
        }
        issueEvents.push({
            id: eventId,
            unitId: null,
            batchId: part.batchId,
            // Pieces move no whole packs: the quantity is 0 and `pieces` carries the amount.
            quantity: inPieces ? 0 : part.quantity,
            ...(inPieces ? { pieces: part.quantity } : {}),
            type: "ISSUED",
            locationId: workLocationId,
            userId: actor.userId,
            referenceType: evaluated.type,
            referenceRef: evaluated.ref,
            occurredAt: now,
            payload: {
              patientType: checked.patientType ?? null,
              paymentCheck: evaluated.check,
              collector: null,
              override: null,
              consumption: { testCode: test.code, tests: input.testCount, edited },
              ...(scannedPack ? { packCode: scannedPack.code } : {}),
            },
        });
        await appendEvents(tx, issueEvents);
        await tx.insert(links).values({
          unitId: null,
          batchId: part.batchId,
          quantity: part.quantity,
          inPieces,
          referenceType: evaluated.type,
          referenceRef: evaluated.ref,
          referenceSource: checked.source,
          testCode: test.code,
          patientHospitalNo: checked.mrn,
          patientHospitalNoIdx: mrnBlindIndexOrNull(checked.mrn),
          patientType: checked.patientType ?? null,
          paymentCheck: evaluated.check,
          issueEventId: eventId,
          issuedBy: actor.userId,
          locationId: workLocationId,
          collectorType: null,
          collectorName: null,
          overrideBy: null,
          overrideReason: null,
        });
      }
      lines.push({ itemName, quantity: line.quantity, inPieces, batchCodes: taken.map((t) => t.code) });
    }

    return { testCode: test.code, tests: input.testCount, department: forPatient ? department : evaluated.ref, edited, lines };
  });
}

export interface IssueBottleResult extends IssueUnitResult {
  /** The test whose items were issued with the bottle; null when no items were sent. */
  testCode: string | null;
  /** The per-patient items issued with the bottle (empty when none). */
  consumables: IssueForTestResult["lines"];
}

/**
 * The Issue screen: one bottle, the investigations it is for, and the per-patient items (swabs, needles, strips) its
 * test uses, confirmed once. The bottle and the items go in one transaction, so if the items are short the bottle
 * is not issued. The items are issued once per bottle scan, for the first investigation listed, however many
 * investigations share the bottle. This is the same pairing the Chrome extension makes (issueFromPortal), with the
 * patient and test typed in instead of read from the portal. Without items it is a plain bottle issue.
 */
export async function issueBottle(
  rawInput: IssueUnitInput & { items?: ConsumptionIssueInput["items"] },
  actor: Actor,
  conn: DbOrTx = db(),
): Promise<IssueBottleResult> {
  const { items, ...unitInput } = rawInput;
  if (!items || items.length === 0) {
    const result = await issueUnit(unitInput, actor, conn);
    return { ...result, testCode: null, consumables: [] };
  }

  const parsed = issueUnitSchema.safeParse(unitInput);
  if (!parsed.success) throw new ValidationError(parsed.error.issues.map((i) => i.message).join("; "));
  const unit = parsed.data;
  const first = unit.references[0];
  if (first.type !== "INVESTIGATION") {
    throw new ValidationError("Items used are linked to an investigation. Remove the items, or issue for an investigation");
  }
  if (!first.testCode) {
    throw new ValidationError("Add the test code after the investigation number so its items can be issued");
  }
  if (!unit.patientHospitalNo) throw new ValidationError("Enter the patient's hospital number");

  return conn.transaction(async (tx) => {
    const result = await issueUnit(unit, actor, tx);
    const used = await issueForTest(
      {
        testCode: first.testCode as string,
        testCount: 1,
        items,
        locationId: unit.locationId,
        forPatient: {
          investigationRef: first.ref,
          hospitalNo: unit.patientHospitalNo as string,
          patientType: unit.patientType,
          reportedPayment: first.reportedPayment,
          source: unit.source,
        },
      },
      actor,
      tx,
    );
    return { ...result, testCode: used.testCode, consumables: used.lines };
  });
}

// --- reading ---------------------------------------------------------------------

/** One line on the issue screen: one bottle (however many investigations it is linked to) or one bulk issue. */
export interface RecentIssue {
  /** Serial for a bottle, link id for a bulk issue. Unique per line. */
  key: string;
  serial: string | null;
  itemName: string;
  quantity: number;
  /** True when `quantity` is loose pieces of a pack item rather than the item's own unit. */
  inPieces: boolean;
  locationName: string;
  /** Everything this line was issued for. Active ones only, unless every one has been cleared. */
  references: { type: ReferenceType; ref: string }[];
  patientHospitalNo: string | null;
  /** The weakest payment check across the references: UNVERIFIED beats VERIFIED beats NOT_REQUIRED. */
  paymentCheck: PaymentCheck;
  overridden: boolean;
  issuedAt: Date;
  /** True when every link has been cleared (the bottle came back). */
  cleared: boolean;
}

const PAYMENT_RANK: Record<PaymentCheck, number> = { NOT_REQUIRED: 0, VERIFIED: 1, UNVERIFIED: 2 };

/**
 * The latest issues, newest first, for the issue screen: one line per bottle, however many
 * investigations it is linked to. Pass a location to see only that one; leave it out to see every
 * location (supervisors and admins, who can work anywhere).
 */
export async function listRecentIssues(locationId?: string, limit = 15, conn: DbOrTx = db()): Promise<RecentIssue[]> {
  // A bottle can carry several links, so read more link rows than lines wanted, then fold them.
  const rows = await queryIssueLinkRows(conn, locationId ? eq(links.locationId, locationId) : undefined, limit * 25);
  return foldIssueRows(rows).slice(0, limit);
}

/**
 * One page (20 lines) of the issue screen's list. A line is one bottle (however many investigations it is linked
 * to) or one bulk issue, so the lines are counted and cut first, then only those lines' links are read and folded.
 */
export async function listIssuesPage(locationId: string | undefined, page: number, conn: DbOrTx = db()): Promise<Paged<RecentIssue>> {
  const lineKey = sql<string>`coalesce(${units.serial}, ${links.id}::text)`;
  const where = locationId ? eq(links.locationId, locationId) : undefined;

  const lineKeys = conn
    .select({ key: lineKey.as("line_key"), latest: sql<Date>`max(${links.createdAt})`.as("latest") })
    .from(links)
    .leftJoin(units, eq(units.id, links.unitId))
    .where(where)
    .groupBy(lineKey)
    .as("issue_lines");

  const [{ total }] = await conn.select({ total: sql<number>`count(*)::int` }).from(lineKeys);
  const info = pageInfo(page, total);
  if (total === 0) return { ...info, rows: [] };

  const pageKeys = await conn
    .select({ key: lineKeys.key })
    .from(lineKeys)
    .orderBy(desc(lineKeys.latest), desc(lineKeys.key))
    .limit(info.pageSize)
    .offset(info.offset);
  const keys = pageKeys.map((k) => k.key);
  if (keys.length === 0) return { ...info, rows: [] };

  const rows = await queryIssueLinkRows(
    conn,
    and(where, or(inArray(units.serial, keys), inArray(sql`${links.id}::text`, keys))),
  );
  const order = new Map(keys.map((k, i) => [k, i]));
  const lines = foldIssueRows(rows).sort((a, b) => (order.get(a.key) ?? 0) - (order.get(b.key) ?? 0));
  return { ...info, rows: lines };
}

async function queryIssueLinkRows(conn: DbOrTx, where: ReturnType<typeof eq> | undefined, rowLimit?: number) {
  const query = conn
    .select({
      id: links.id,
      locationName: locations.name,
      serial: units.serial,
      itemName: itemTypes.name,
      quantity: links.quantity,
      inPieces: links.inPieces,
      referenceType: links.referenceType,
      referenceRef: links.referenceRef,
      patientHospitalNo: links.patientHospitalNo,
      paymentCheck: links.paymentCheck,
      overridden: links.overrideBy,
      issuedAt: links.createdAt,
      clearedAt: links.clearedAt,
    })
    .from(links)
    .leftJoin(units, eq(units.id, links.unitId))
    .innerJoin(batches, eq(batches.id, links.batchId))
    .innerJoin(itemTypes, eq(itemTypes.id, batches.itemTypeId))
    .innerJoin(locations, eq(locations.id, links.locationId))
    .where(where)
    .orderBy(desc(links.createdAt), desc(links.id));
  return rowLimit ? await query.limit(rowLimit) : await query;
}

type IssueLinkRow = Awaited<ReturnType<typeof queryIssueLinkRows>>[number];

/** Folds link rows (newest first) into one line per bottle or bulk issue. */
function foldIssueRows(rows: IssueLinkRow[]): RecentIssue[] {
  const lines = new Map<string, RecentIssue & { activeRefs: { type: ReferenceType; ref: string }[] }>();
  for (const r of rows) {
    const key = r.serial ?? r.id;
    const ref = { type: r.referenceType, ref: r.referenceRef };
    const line = lines.get(key);
    if (!line) {
      lines.set(key, {
        key,
        serial: r.serial,
        itemName: r.itemName,
        quantity: r.quantity,
        inPieces: r.inPieces,
        locationName: r.locationName,
        references: [ref],
        activeRefs: r.clearedAt ? [] : [ref],
        patientHospitalNo: r.patientHospitalNo,
        paymentCheck: r.paymentCheck,
        overridden: r.overridden !== null,
        issuedAt: r.issuedAt,
        cleared: r.clearedAt !== null,
      });
      continue;
    }
    line.references.push(ref);
    if (!r.clearedAt) {
      line.activeRefs.push(ref);
      line.cleared = false;
    }
    if (PAYMENT_RANK[r.paymentCheck] > PAYMENT_RANK[line.paymentCheck]) line.paymentCheck = r.paymentCheck;
    if (r.overridden !== null) line.overridden = true;
  }

  return [...lines.values()].map(({ activeRefs, ...line }) => ({
    ...line,
    references: activeRefs.length > 0 ? activeRefs : line.references,
  }));
}

/** A bottle's issue file: the bottle, every investigation it is linked to, and what the hospital export says about each. */
export async function getIssuedBottle(serialInput: string, conn: DbOrTx = db()) {
  const serial = parseSerial(serialInput);
  if (!serial) return null;

  const [unit] = await conn
    .select({
      id: units.id,
      serial: units.serial,
      state: units.state,
      itemName: itemTypes.name,
      batchCode: batches.code,
      lotNo: batches.lotNo,
      expiryDate: batches.expiryDate,
      locationId: units.currentLocationId,
      locationName: locations.name,
    })
    .from(units)
    .innerJoin(itemTypes, eq(itemTypes.id, units.itemTypeId))
    .innerJoin(batches, eq(batches.id, units.batchId))
    .innerJoin(locations, eq(locations.id, units.currentLocationId))
    .where(eq(units.serial, serial));
  if (!unit) return null;

  const issued = await conn
    .select({
      id: links.id,
      referenceType: links.referenceType,
      referenceRef: links.referenceRef,
      testCode: links.testCode,
      testName: testCatalog.name,
      patientHospitalNo: links.patientHospitalNo,
      patientType: links.patientType,
      paymentCheck: links.paymentCheck,
      collectorType: links.collectorType,
      collectorName: links.collectorName,
      overrideReason: links.overrideReason,
      issuedByName: users.name,
      issuedLocationName: locations.name,
      issuedAt: links.createdAt,
      clearedAt: links.clearedAt,
      importedTestName: investigationImports.testName,
      importedStatus: investigationImports.status,
      importedQueue: investigationImports.queue,
      importedDestination: investigationImports.destination,
      importedPayment: investigationImports.paymentStatus,
      importedAt: investigationImports.importedAt,
      portalSyncedAt: investigationImports.portalSyncedAt,
      portalId: investigationImports.portalId,
      portalStartedAt: investigationImports.portalStartedAt,
      portalStartedBy: investigationImports.portalStartedBy,
      portalPreparedAt: investigationImports.portalPreparedAt,
      portalPreparedBy: investigationImports.portalPreparedBy,
      portalVerifiedAt: investigationImports.portalVerifiedAt,
      portalVerifiedBy: investigationImports.portalVerifiedBy,
      portalCompletedAt: investigationImports.portalCompletedAt,
    })
    .from(links)
    .innerJoin(users, eq(users.id, links.issuedBy))
    .innerJoin(locations, eq(locations.id, links.locationId))
    .leftJoin(testCatalog, eq(testCatalog.code, links.testCode))
    .leftJoin(
      investigationImports,
      and(eq(links.referenceType, "INVESTIGATION"), eq(investigationImports.investigationRef, links.referenceRef)),
    )
    .where(eq(links.unitId, unit.id))
    .orderBy(asc(links.createdAt), asc(links.referenceRef));

  // The latest time this bottle came back from being issued: where, when and which staff member
  // scanned it in. The return flow does not record a separate collector name, so the person who
  // recorded the return is who received it.
  const [lastReturn] = await conn
    .select({
      outcome: events.type,
      returnedAt: events.occurredAt,
      locationName: locations.name,
      receivedByName: users.name,
    })
    .from(events)
    .innerJoin(users, eq(users.id, events.userId))
    .innerJoin(locations, eq(locations.id, events.locationId))
    .where(
      and(
        eq(events.unitId, unit.id),
        eq(events.fromState, "ISSUED"),
        inArray(events.type, ["RETURNED", "RETURNED_UNUSED", "VOIDED"]),
      ),
    )
    .orderBy(desc(events.occurredAt))
    .limit(1);

  return { unit, issued, lastReturn: lastReturn ?? null };
}

/** What the issue label shows: the bottle, the patient and every investigation it was issued for. */
export async function getIssueLabelData(serialInput: string, conn: DbOrTx = db()) {
  const serial = parseSerial(serialInput);
  if (!serial) throw new InvalidSerialError(serialInput);

  const [unit] = await conn
    .select({ id: units.id, itemName: itemTypes.name, locationId: locations.id, locationName: locations.name })
    .from(units)
    .innerJoin(itemTypes, eq(itemTypes.id, units.itemTypeId))
    .innerJoin(locations, eq(locations.id, units.currentLocationId))
    .where(eq(units.serial, serial));
  if (!unit) throw new NotFoundError("Bottle");

  const rows = await conn
    .select()
    .from(links)
    .where(and(eq(links.unitId, unit.id), isNull(links.clearedAt)))
    .orderBy(asc(links.createdAt));
  if (rows.length === 0) throw new NotFoundError("Active issue for this bottle");

  const first = rows[0];
  return {
    serial,
    itemName: unit.itemName,
    locationId: unit.locationId,
    locationName: unit.locationName,
    patientHospitalNo: first.patientHospitalNo,
    issuedAt: first.createdAt,
    collectorType: first.collectorType,
    collectorName: first.collectorName,
    references: rows.map((r) => ({ type: r.referenceType, ref: r.referenceRef, testCode: r.testCode })),
  };
}
