import "server-only";
import { and, asc, eq, gte, inArray, isNull, or, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/client";
import {
  batches,
  investigationImports,
  itemTypes,
  links,
  locations,
  testCatalog,
  testStandardItems,
  units,
  voidReasons,
} from "../db/schema";
import { AlreadyIssuedError, DomainError, PatientMismatchError, ValidationError } from "../domain/errors";
import { resolveWorkLocation } from "../domain/issue-rules";
import { can, canWorkAtAnyLocation } from "../auth/permissions";
import type { Session } from "../auth/session";
import { COLLECTOR_TYPES, PATIENT_TYPES, RETURN_OUTCOMES, type Actor } from "../domain/types";
import { departmentOnly } from "../../lib/issue-location";
import { acceptedContainers, sharedContainers } from "../../lib/containers";
import { isPackUnit, perTestUnit } from "../../lib/pack-size";
import { matchTest } from "../../lib/test-match";
import { isValidMrn, normalizeMrn, normalizeReference, referenceFormatProblem } from "../../lib/reference-formats";
import { parseSerial } from "../../lib/serial";
import { mrnBlindIndex } from "../security/field-crypto";
import { issueForTest, issueUnit, type IssueForTestResult, type IssueUnitResult } from "./issue.service";
import { getBottleReport } from "./report.service";

// Backs the Chrome extension (a side panel on the staff portal). The extension reads the open
// investigation off the portal page and sends only what the tracker needs: the investigation number,
// the test name, the hospital number, where it was raised (the patient type) and the payment badge.
// The rules are the same ones the Issue page uses: this file only translates and calls issueUnit.

const text = (max: number) => z.string().trim().max(max);

export const portalIssueSchema = z
  .object({
  /** The scanned bottle. Left out when `fromStock` is set: the tracker then picks one from stock. */
  serial: z.string().trim().optional(),
  /** Issue a bottle taken from stock at the work location (earliest expiry first) instead of a scanned one. */
  fromStock: z.boolean().default(false),
  investigationRef: z.string().trim().min(1, "No investigation number was read from the page").max(60),
  testName: z.string().trim().min(1, "No test name was read from the page").max(200),
  mrn: z.string().trim().min(1, "No hospital number was read from the page").max(40),
  patientType: z.enum(PATIENT_TYPES),
  /** The Payment badge on the portal page. `unknown` when the extension could not read it. */
  payment: z.enum(["PAID", "UNPAID", "CHARGED_TO_ADMISSION", "unknown"]),
  collectorType: z.enum(COLLECTOR_TYPES).default("PATIENT"),
  collectorName: text(120).optional(),
  locationId: z.uuid().optional(),
  override: z.object({ reason: z.string().trim().min(3, "A reason is required for an override").max(500) }).optional(),
  /**
   * Other investigations of the same patient (same invoice) that this bottle also serves. Each is checked
   * like the main one: the test must be in the catalog, and the Issue rules check the container and payment.
   */
  additional: z
    .array(
      z.object({
        investigationRef: z.string().trim().min(1).max(60),
        testName: z.string().trim().min(1).max(200),
        patientType: z.enum(PATIENT_TYPES).optional(),
        payment: z.enum(["PAID", "UNPAID", "CHARGED_TO_ADMISSION", "unknown"]),
      }),
    )
    .max(10)
    .default([]),
  /**
   * The bulk items (swabs, cotton wool...) used for this test, as confirmed in the panel. Issued in the same
   * transaction as the bottle, so a stock shortage cannot leave a bottle issued with no consumables recorded.
   * Omitted or empty means the bottle only.
   */
  consumables: z
    .array(
      z.object({
        itemTypeId: z.uuid(),
        quantity: z.number().int().min(1).max(10000),
        /** The scanned PK label of the pack the pieces come from (pack items only). Optional. */
        packCode: z.string().trim().max(40).optional(),
      }),
    )
    .max(30)
    .default([]),
  })
  .refine((v) => v.fromStock || Boolean(v.serial), { message: "Scan the bottle", path: ["serial"] });
export type PortalIssueInput = z.infer<typeof portalIssueSchema>;

export const portalReturnSchema = z.object({
  serial: z.string().trim().min(1, "Scan the bottle"),
  outcome: z.enum(RETURN_OUTCOMES),
  reasonCode: text(40).optional(),
  note: text(500).optional(),
  locationId: z.uuid().optional(),
});
export type PortalReturnInput = z.infer<typeof portalReturnSchema>;

/** Which catalog test a portal item name is, and the containers it accepts. Null when it is not in the catalog. */
export async function matchPortalTest(testName: string) {
  const rows = await db()
    .select({
      code: testCatalog.code,
      name: testCatalog.name,
      requiredContainer: testCatalog.requiredContainerType,
      alternateContainers: testCatalog.alternateContainerTypes,
    })
    .from(testCatalog)
    .where(eq(testCatalog.active, true));
  return matchTest({ testCode: null, testName }, rows);
}

export interface PanelStandardItem {
  itemTypeId: string;
  name: string;
  unitOfMeasure: string;
  /** What one run of the test uses. */
  quantity: number;
  /** Issued in loose pieces, so a pack label can be scanned to say which pack they came from. */
  packItem: boolean;
}

/**
 * The bulk items one run of a test normally uses, for the panel to pre-fill. `confirmed` is false while the lab
 * has not confirmed the list yet (display only: it blocks nothing). Serialized items are never listed here.
 */
export async function standardItemsForTest(testCode: string): Promise<{ items: PanelStandardItem[]; confirmed: boolean }> {
  const [test] = await db()
    .select({ id: testCatalog.id, confirmed: testCatalog.consumptionConfirmed })
    .from(testCatalog)
    .where(and(eq(testCatalog.code, testCode), eq(testCatalog.active, true)));
  if (!test) return { items: [], confirmed: false };
  const rows = await db()
    .select({
      itemTypeId: itemTypes.id,
      name: itemTypes.name,
      unitOfMeasure: itemTypes.unitOfMeasure,
      packSize: itemTypes.packSize,
      quantity: testStandardItems.quantity,
    })
    .from(testStandardItems)
    .innerJoin(itemTypes, eq(itemTypes.id, testStandardItems.itemTypeId))
    .where(
      and(
        eq(testStandardItems.testId, test.id),
        eq(itemTypes.trackingMode, "QUANTITY"),
        // Shared bench supplies are recorded by the lab under Used for test, not issued per patient.
        eq(itemTypes.benchSupply, false),
      ),
    )
    .orderBy(asc(itemTypes.name));
  // A pack item is issued for a test in loose pieces, so its quantity is labelled in pieces.
  const items = rows.map(({ packSize, ...r }) => ({
    ...r,
    unitOfMeasure: perTestUnit(r.unitOfMeasure, packSize),
    packItem: isPackUnit(r.unitOfMeasure) && packSize > 1,
  }));
  return { items, confirmed: test.confirmed };
}

/** Issue a bottle to the investigation open on the portal. */
export async function issueFromPortal(
  rawInput: unknown,
  actor: Actor,
): Promise<IssueUnitResult & { testCode: string; consumables: IssueForTestResult["lines"] }> {
  const parsed = portalIssueSchema.safeParse(rawInput);
  if (!parsed.success) throw new ValidationError(parsed.error.issues.map((i) => i.message).join("; "));
  const input = parsed.data;

  const test = await matchPortalTest(input.testName);
  if (!test) {
    throw new ValidationError(
      `"${input.testName}" is not in the test catalog, so the right bottle cannot be checked. Ask an admin to add it`,
    );
  }

  // The portal is the source of truth for the investigation: record it (or confirm it is the same patient)
  // before issuing, so the link always has a matching investigation row and the orphan report stays quiet.
  await recordPortalInvestigation(
    { investigationRef: input.investigationRef, mrn: input.mrn, testName: input.testName, patientType: input.patientType },
    actor,
  );

  // Other tests on the same bottle (same patient, same invoice): each must be in the catalog and is recorded
  // from the portal like the main one. The Issue rules then check the container and payment per investigation.
  const references: {
    type: "INVESTIGATION";
    ref: string;
    testCode: string;
    reportedPayment: PortalIssueInput["payment"];
  }[] = [{ type: "INVESTIGATION", ref: input.investigationRef, testCode: test.code, reportedPayment: input.payment }];
  const accepted: string[][] = [acceptedContainers(test.requiredContainer, test.alternateContainers)];
  for (const extra of input.additional) {
    const extraTest = await matchPortalTest(extra.testName);
    if (!extraTest) {
      throw new ValidationError(
        `"${extra.testName}" is not in the test catalog, so ${extra.investigationRef} cannot share this bottle. Ask an admin to add it`,
      );
    }
    await recordPortalInvestigation(
      {
        investigationRef: extra.investigationRef,
        mrn: input.mrn,
        testName: extra.testName,
        patientType: extra.patientType ?? input.patientType,
      },
      actor,
    );
    references.push({
      type: "INVESTIGATION",
      ref: extra.investigationRef,
      testCode: extraTest.code,
      reportedPayment: extra.payment,
    });
    accepted.push(acceptedContainers(extraTest.requiredContainer, extraTest.alternateContainers));
  }

  // Scanned: the one bottle. From stock: the in-date bottles at this location that fit every test, earliest expiry
  // first. issueUnit then runs all the usual checks on the one it is given.
  const candidates = input.fromStock
    ? await stockBottleCandidates(resolveWorkLocation(actor, input.locationId), accepted)
    : [input.serial as string];

  // The patient is the one on the page; no name is ever sent. For a patient collector no name is kept at all
  // (issueUnit drops it); for anyone else the name typed in the panel is required.
  const collectorName = input.collectorName?.trim() || undefined;

  // The bottle and the consumables go in one transaction: if the swabs are short, the bottle is not issued.
  const { result, consumables } = await db().transaction(async (tx) => {
    let result: IssueUnitResult | null = null;
    for (const serial of candidates) {
      try {
        result = await issueUnit(
          {
            serial,
            references,
            patientHospitalNo: input.mrn,
            patientType: input.patientType,
            collectorType: input.collectorType,
            collectorName,
            locationId: input.locationId,
            override: input.override,
            source: "extension",
          },
          actor,
          tx,
        );
        break;
      } catch (err) {
        // Someone else took this bottle between the lookup and now: try the next one from stock.
        if (input.fromStock && err instanceof AlreadyIssuedError) continue;
        throw err;
      }
    }
    if (!result) throw new ValidationError("The bottles in stock were just issued by someone else. Try again");
    let consumables: IssueForTestResult["lines"] = [];
    if (input.consumables.length > 0) {
      // The items are tied to the same investigation and patient as the bottle, so every line issued here carries
      // the patient. The department is still the place they were used at.
      const used = await issueForTest(
        {
          testCode: test.code,
          testCount: 1,
          items: input.consumables,
          locationId: input.locationId,
          forPatient: {
            investigationRef: input.investigationRef,
            hospitalNo: input.mrn,
            patientType: input.patientType,
            reportedPayment: input.payment,
            source: "extension",
          },
        },
        actor,
        tx,
      );
      consumables = used.lines;
    }
    return { result, consumables };
  });
  return { ...result, testCode: test.code, consumables };
}

/**
 * Up to five bottles in stock at a location that every listed test accepts, earliest expiry first (no expiry last),
 * skipping expired ones. Only a lookup: issueUnit locks and re-checks whichever one is issued. Throws a clear message
 * when the tests need different containers or nothing suitable is in stock.
 */
async function stockBottleCandidates(locationId: string, accepted: readonly (readonly string[])[]): Promise<string[]> {
  const shared = sharedContainers(accepted);
  if (shared !== null && shared.length === 0) {
    const sets = [...new Set(accepted.filter((s) => s.length > 0).map((s) => s.join(" or ")))];
    throw new ValidationError(`These tests need different containers (${sets.join(", ")}). Issue them in separate groups`);
  }
  const day = new Date().toISOString().slice(0, 10);
  const rows = await db()
    .select({ serial: units.serial })
    .from(units)
    .innerJoin(batches, eq(batches.id, units.batchId))
    .innerJoin(itemTypes, eq(itemTypes.id, units.itemTypeId))
    .where(
      and(
        eq(units.state, "IN_STOCK"),
        eq(units.currentLocationId, locationId),
        or(isNull(batches.expiryDate), gte(batches.expiryDate, day)),
        shared === null ? undefined : inArray(itemTypes.containerType, shared),
      ),
    )
    .orderBy(sql`${batches.expiryDate} asc nulls last`, asc(units.createdAt), asc(units.serial))
    .limit(5);
  if (rows.length === 0) {
    const need = shared === null ? "" : `${shared.join(" or ")} `;
    throw new ValidationError(`No ${need}bottle is in stock at your location (expired bottles are left out). Scan a bottle instead`);
  }
  return rows.map((r) => r.serial);
}

// --- keeping the imported investigation current from the portal page ---------------------------------

export const portalSyncSchema = z.object({
  investigationRef: z.string().trim().min(1, "No investigation number was read from the page").max(60),
  mrn: z.string().trim().min(1, "No hospital number was read from the page").max(40),
  /** The test name (Item) on the portal page. Needed to record an investigation the tracker has not seen yet. */
  testName: text(200).optional(),
  /** How the investigation was raised (the portal's Context). */
  patientType: z.enum(PATIENT_TYPES).optional(),
  /** The Status on the portal page, as shown ("Pending", "In progress", "Completed"). */
  status: text(60).optional(),
  /** The Invoice Number on the portal page; empty or "-" when it has none. */
  invoice: text(60).optional(),
  /** Where the portal says the test goes (Destination), e.g. "FAST TRACK". */
  destination: text(120).optional(),
  /** The portal's own id for the investigation (its address is /lab-tests/<id>). */
  portalId: text(64).optional(),
  /** How far the work has got, as the portal shows it: times and the names of the staff. Never result values. */
  startedAt: text(40).optional(),
  preparedAt: text(40).optional(),
  verifiedAt: text(40).optional(),
  completedAt: text(40).optional(),
  startedBy: text(120).optional(),
  preparedBy: text(120).optional(),
  verifiedBy: text(120).optional(),
});
export type PortalSyncInput = z.infer<typeof portalSyncSchema>;

export type PortalSyncOutcome = "CREATED" | "SAVED" | "UNCHANGED" | "NOTHING_TO_SAVE";
export interface PortalSyncResult {
  outcome: PortalSyncOutcome;
  status: string | null;
  invoiceNumber: string | null;
}

/** "In progress" -> "in_progress": the form the portal's own exports use. Null when blank. */
function cleanStatus(value: string | undefined): string | null {
  const v = (value ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  return v === "" || v === "_" ? null : v;
}

/** The invoice number as shown; null when the portal shows none (blank or "-"). */
function cleanInvoice(value: string | undefined): string | null {
  const v = (value ?? "").trim();
  return v === "" || v === "-" ? null : v;
}

/** A time from the portal as a Date, or null when blank or not a believable date. */
function cleanTime(value: string | undefined): Date | null {
  const v = (value ?? "").trim();
  if (!v) return null;
  const d = new Date(v);
  const year = d.getUTCFullYear();
  return Number.isNaN(d.getTime()) || year < 2000 || year > 2100 ? null : d;
}

function cleanName(value: string | undefined): string | null {
  const v = (value ?? "").trim();
  return v === "" || v === "-" ? null : v;
}

/** How far the portal says the work has got, cleaned. */
interface PortalProgress {
  portalId: string | null;
  startedAt: Date | null;
  startedBy: string | null;
  preparedAt: Date | null;
  preparedBy: string | null;
  verifiedAt: Date | null;
  verifiedBy: string | null;
  completedAt: Date | null;
}

function cleanProgress(input: PortalSyncInput): PortalProgress {
  return {
    portalId: input.portalId?.trim() || null,
    startedAt: cleanTime(input.startedAt),
    startedBy: cleanName(input.startedBy),
    preparedAt: cleanTime(input.preparedAt),
    preparedBy: cleanName(input.preparedBy),
    verifiedAt: cleanTime(input.verifiedAt),
    verifiedBy: cleanName(input.verifiedBy),
    completedAt: cleanTime(input.completedAt),
  };
}

/** The progress values as the table's columns. */
function progressColumns(p: PortalProgress) {
  return {
    portalId: p.portalId,
    portalStartedAt: p.startedAt,
    portalStartedBy: p.startedBy,
    portalPreparedAt: p.preparedAt,
    portalPreparedBy: p.preparedBy,
    portalVerifiedAt: p.verifiedAt,
    portalVerifiedBy: p.verifiedBy,
    portalCompletedAt: p.completedAt,
  };
}
type ProgressColumns = ReturnType<typeof progressColumns>;

const sameTime = (a: Date | null, b: Date | null) => (a ? a.getTime() : null) === (b ? b.getTime() : null);

/** What the row should hold after this sync: a value from the portal wins, a blank never wipes one. */
function mergeProgress(existing: ProgressColumns, incoming: PortalProgress): { next: ProgressColumns; changed: boolean } {
  const next = progressColumns({
    portalId: incoming.portalId ?? existing.portalId,
    startedAt: incoming.startedAt ?? existing.portalStartedAt,
    startedBy: incoming.startedBy ?? existing.portalStartedBy,
    preparedAt: incoming.preparedAt ?? existing.portalPreparedAt,
    preparedBy: incoming.preparedBy ?? existing.portalPreparedBy,
    verifiedAt: incoming.verifiedAt ?? existing.portalVerifiedAt,
    verifiedBy: incoming.verifiedBy ?? existing.portalVerifiedBy,
    completedAt: incoming.completedAt ?? existing.portalCompletedAt,
  });
  const changed =
    next.portalId !== existing.portalId ||
    next.portalStartedBy !== existing.portalStartedBy ||
    next.portalPreparedBy !== existing.portalPreparedBy ||
    next.portalVerifiedBy !== existing.portalVerifiedBy ||
    !sameTime(next.portalStartedAt, existing.portalStartedAt) ||
    !sameTime(next.portalPreparedAt, existing.portalPreparedAt) ||
    !sameTime(next.portalVerifiedAt, existing.portalVerifiedAt) ||
    !sameTime(next.portalCompletedAt, existing.portalCompletedAt);
  return { next, changed };
}

/**
 * Records the investigation open on the portal in the tracker: creates its row the first time it is seen,
 * and afterwards keeps its status and invoice number current. The portal is the source, so no export file
 * is needed.
 *
 * Deliberately narrow: it refuses a row recorded for a different patient; it never writes payment onto the
 * investigation record (the EMR owns payment); and a blank on the portal never wipes a value the tracker
 * already has. Payment is read once, at issue time, from the portal's own API response and is used only as
 * input to the issue policy (a gate where a policy requires payment): the result of that check is recorded
 * on the link, not on the investigation. Rows it creates are marked
 * `raw.source = "portal"` and go in the LAB queue, since the extension only reads lab test pages.
 */
export async function recordPortalInvestigation(input: PortalSyncInput, actor: Actor): Promise<PortalSyncResult> {
  const ref = normalizeReference(input.investigationRef);
  const refProblem = referenceFormatProblem("INVESTIGATION", ref);
  if (refProblem) throw new ValidationError(refProblem);
  const mrn = normalizeMrn(input.mrn);
  if (!isValidMrn(mrn)) {
    throw new ValidationError(`"${input.mrn}" is not a valid hospital number (expected UATH/PT/ followed by digits)`);
  }

  const status = cleanStatus(input.status);
  const invoice = cleanInvoice(input.invoice);
  const destination = cleanName(input.destination);
  const testName = input.testName?.trim() || null;
  const extras = cleanProgress(input);

  const conn = db();
  const findExisting = async () => {
    const [row] = await conn
      .select({
        id: investigationImports.id,
        mrn: investigationImports.patientHospitalNo,
        patientType: investigationImports.patientType,
        status: investigationImports.status,
        invoiceNumber: investigationImports.invoiceNumber,
        destination: investigationImports.destination,
        portalId: investigationImports.portalId,
        portalStartedAt: investigationImports.portalStartedAt,
        portalStartedBy: investigationImports.portalStartedBy,
        portalPreparedAt: investigationImports.portalPreparedAt,
        portalPreparedBy: investigationImports.portalPreparedBy,
        portalVerifiedAt: investigationImports.portalVerifiedAt,
        portalVerifiedBy: investigationImports.portalVerifiedBy,
        portalCompletedAt: investigationImports.portalCompletedAt,
      })
      .from(investigationImports)
      .where(eq(investigationImports.investigationRef, ref));
    return row;
  };

  let existing = await findExisting();
  if (!existing) {
    // Never seen before: record it from the page. Without the test name there is nothing sensible to store.
    if (!testName) return { outcome: "NOTHING_TO_SAVE", status, invoiceNumber: invoice };
    const created = await conn
      .insert(investigationImports)
      .values({
        investigationRef: ref,
        patientHospitalNo: mrn,
        patientHospitalNoIdx: mrnBlindIndex(mrn),
        queue: "LAB",
        testName,
        patientType: input.patientType ?? null,
        status,
        invoiceNumber: invoice,
        destination,
        ...progressColumns(extras),
        portalSyncedAt: new Date(),
        portalSyncedBy: actor.userId,
        raw: { source: "portal" },
      })
      .onConflictDoNothing({ target: investigationImports.investigationRef })
      .returning({ id: investigationImports.id });
    if (created.length === 1) return { outcome: "CREATED", status, invoiceNumber: invoice };
    // Another request created it a moment ago: carry on as for an existing row.
    existing = await findExisting();
    if (!existing) return { outcome: "NOTHING_TO_SAVE", status, invoiceNumber: invoice };
  }

  if (normalizeMrn(existing.mrn) !== mrn) {
    throw new PatientMismatchError(`${ref} is recorded for a different patient than ${mrn}, so nothing was saved`);
  }

  const nextStatus = status ?? existing.status;
  const nextInvoice = invoice ?? existing.invoiceNumber;
  const nextDestination = destination ?? existing.destination;
  const nextPatientType = existing.patientType ?? input.patientType ?? null;
  const progress = mergeProgress(existing, extras);
  if (
    nextStatus === existing.status &&
    nextInvoice === existing.invoiceNumber &&
    nextDestination === existing.destination &&
    nextPatientType === existing.patientType &&
    !progress.changed
  ) {
    return { outcome: "UNCHANGED", status: nextStatus, invoiceNumber: nextInvoice };
  }

  await conn
    .update(investigationImports)
    .set({
      status: nextStatus,
      invoiceNumber: nextInvoice,
      destination: nextDestination,
      patientType: nextPatientType,
      ...progress.next,
      portalSyncedAt: new Date(),
      portalSyncedBy: actor.userId,
    })
    .where(eq(investigationImports.id, existing.id));
  return { outcome: "SAVED", status: nextStatus, invoiceNumber: nextInvoice };
}

/** The route's entry point: validates the body, then records the investigation. */
export async function syncPortalInvestigation(rawInput: unknown, actor: Actor): Promise<PortalSyncResult> {
  const parsed = portalSyncSchema.safeParse(rawInput);
  if (!parsed.success) throw new ValidationError(parsed.error.issues.map((i) => i.message).join("; "));
  return recordPortalInvestigation(parsed.data, actor);
}

export interface PortalBatchResult {
  results: { investigationRef: string; outcome: PortalSyncOutcome | "REFUSED"; message?: string }[];
}

/**
 * Records several investigations at once: what the portal has loaded (the lab queue, 20 to a page), so every
 * investigation in view is current without opening each one. One refused row (wrong patient, bad number)
 * never stops the others; it is reported against its own number.
 */
export async function syncPortalBatch(rawInput: unknown, actor: Actor): Promise<PortalBatchResult> {
  const parsed = z.object({ items: z.array(z.unknown()).min(1).max(50) }).safeParse(rawInput);
  if (!parsed.success) throw new ValidationError("Send between 1 and 50 investigations");

  const results: PortalBatchResult["results"] = [];
  for (const raw of parsed.data.items) {
    const label = typeof raw === "object" && raw && "investigationRef" in raw ? String(raw.investigationRef) : "?";
    const item = portalSyncSchema.safeParse(raw);
    if (!item.success) {
      results.push({
        investigationRef: label,
        outcome: "REFUSED",
        message: item.error.issues.map((i) => i.message).join("; "),
      });
      continue;
    }
    try {
      const done = await recordPortalInvestigation(item.data, actor);
      results.push({ investigationRef: label, outcome: done.outcome });
    } catch (err) {
      if (!(err instanceof DomainError)) throw err;
      results.push({ investigationRef: label, outcome: "REFUSED", message: err.message });
    }
  }
  return { results };
}

/**
 * The investigation numbers that have a bottle linked right now (not yet cleared). The panel syncs only
 * these and the investigation that is open, so the rest of what the portal loaded never leaves the browser.
 * Returns references only: no patient numbers, no names.
 */
export async function activeLinkedInvestigationRefs(): Promise<string[]> {
  const rows = await db()
    .selectDistinct({ ref: links.referenceRef })
    .from(links)
    .where(and(eq(links.referenceType, "INVESTIGATION"), isNull(links.clearedAt)));
  return rows.map((r) => r.ref);
}

export interface PanelUnit {
  serial: string;
  state: string;
  itemName: string;
  containerType: string | null;
  expiryDate: string | null;
  locationId: string;
  locationName: string;
  /** What the bottle is currently linked to (empty unless it is issued). */
  references: { type: string; ref: string; testCode: string | null; mrn: string | null }[];
}

/** One bottle for the side panel: its state, container and what it is linked to right now. Null if unknown. */
export async function unitForPanel(serialInput: string): Promise<PanelUnit | null> {
  const serial = parseSerial(serialInput);
  if (!serial) return null;
  const conn = db();
  const [unit] = await conn
    .select({
      id: units.id,
      serial: units.serial,
      state: units.state,
      itemName: itemTypes.name,
      containerType: itemTypes.containerType,
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

  const active = await conn
    .select({
      type: links.referenceType,
      ref: links.referenceRef,
      testCode: links.testCode,
      mrn: links.patientHospitalNo,
    })
    .from(links)
    .where(and(eq(links.unitId, unit.id), isNull(links.clearedAt)))
    .orderBy(asc(links.createdAt));

  return {
    serial: unit.serial,
    state: unit.state,
    itemName: unit.itemName,
    containerType: unit.containerType,
    expiryDate: unit.expiryDate,
    locationId: unit.locationId,
    locationName: unit.locationName,
    references: active,
  };
}

/** Reasons offered when a returned bottle is unusable. */
export async function activeVoidReasons() {
  return db()
    .select({ code: voidReasons.code, label: voidReasons.label })
    .from(voidReasons)
    .where(eq(voidReasons.active, true))
    .orderBy(asc(voidReasons.label));
}

/** The signed-in person's home location (name and what it does for stock), for the panel header and issue gate. */
async function homeLocation(locationId: string | null): Promise<{ name: string; serviceRole: string | null } | null> {
  if (!locationId) return null;
  const [row] = await db()
    .select({ name: locations.name, serviceRole: locations.serviceRole })
    .from(locations)
    .where(eq(locations.id, locationId));
  return row ?? null;
}

/** The signed-in person's home location, for the panel header. */
export async function locationName(locationId: string | null): Promise<string | null> {
  return (await homeLocation(locationId))?.name ?? null;
}

/** What the panel needs to know about whoever is signed in. */
export async function describeSession(session: Session) {
  const home = await homeLocation(session.homeLocationId);
  return {
    name: session.name,
    staffId: session.staffId,
    role: session.role,
    homeLocationId: session.homeLocationId,
    locationName: home?.name ?? null,
    // A bench section or the blood bank issues for its department only, so the panel (which issues to
    // investigations) cannot be used from there; the Issue page can.
    departmentOnly: departmentOnly(home?.serviceRole),
    can: {
      issue: can(session.role, "issue"),
      return: can(session.role, "return"),
      override: can(session.role, "approve_override"),
      anyLocation: canWorkAtAnyLocation(session.role),
    },
  };
}

// --- scanning a bottle to see everything about it -------------------------------------------------------

export interface PanelBottleTest {
  referenceType: string;
  ref: string;
  testCode: string | null;
  /** From the investigation record; null for a reference that is not an investigation, or one the portal never showed. */
  testName: string | null;
  mrn: string | null;
  patientType: string | null;
  /** The portal's status ("pending", "in_progress", "completed"), as last seen. */
  status: string | null;
  destination: string | null;
  invoiceNumber: string | null;
  paymentCheck: string | null;
  collectorType: string | null;
  collectorName: string | null;
  overridden: boolean;
  issuedAt: Date;
  clearedAt: Date | null;
  /** The portal's id for the investigation, so the panel can open /lab-tests/<id>. Results are only ever read there. */
  portalId: string | null;
  startedAt: Date | null;
  startedBy: string | null;
  preparedAt: Date | null;
  preparedBy: string | null;
  verifiedAt: Date | null;
  verifiedBy: string | null;
  completedAt: Date | null;
}

export interface PanelJourneyStep {
  type: string;
  fromState: string | null;
  toState: string | null;
  at: Date;
  locationName: string;
  userName: string;
  transferCode: string | null;
  reasonCode: string | null;
  note: string | null;
}

export interface PanelBottle {
  unit: {
    serial: string;
    state: string;
    itemName: string;
    containerType: string | null;
    lotNo: string | null;
    expiryDate: string | null;
    locationName: string;
  };
  tests: PanelBottleTest[];
  journey: PanelJourneyStep[];
}

/**
 * Everything the tracker knows about one bottle, for the panel's Look up screen: where it has been (every
 * event, oldest first), and each test it was used for with that investigation's status and release times.
 * Result values are not here and never are: the panel links to the portal's own Results tab for those.
 */
export async function bottleForPanel(serialInput: string): Promise<PanelBottle | null> {
  const conn = db();
  const report = await getBottleReport(serialInput, conn);
  if (!report) return null;

  const [type] = await conn
    .select({ containerType: itemTypes.containerType })
    .from(units)
    .innerJoin(itemTypes, eq(itemTypes.id, units.itemTypeId))
    .where(eq(units.id, report.unit.id));

  const refs = [
    ...new Set(report.issuedFor.filter((l) => l.referenceType === "INVESTIGATION").map((l) => l.referenceRef.toUpperCase())),
  ];
  const imported =
    refs.length === 0
      ? []
      : await conn
          .select({
            ref: investigationImports.investigationRef,
            testName: investigationImports.testName,
            patientType: investigationImports.patientType,
            status: investigationImports.status,
            destination: investigationImports.destination,
            invoiceNumber: investigationImports.invoiceNumber,
            portalId: investigationImports.portalId,
            startedAt: investigationImports.portalStartedAt,
            startedBy: investigationImports.portalStartedBy,
            preparedAt: investigationImports.portalPreparedAt,
            preparedBy: investigationImports.portalPreparedBy,
            verifiedAt: investigationImports.portalVerifiedAt,
            verifiedBy: investigationImports.portalVerifiedBy,
            completedAt: investigationImports.portalCompletedAt,
          })
          .from(investigationImports)
          .where(inArray(investigationImports.investigationRef, refs));
  const byRef = new Map(imported.map((r) => [r.ref, r]));

  const tests: PanelBottleTest[] = report.issuedFor.map((l) => {
    const i = l.referenceType === "INVESTIGATION" ? byRef.get(l.referenceRef.toUpperCase()) : undefined;
    return {
      referenceType: l.referenceType,
      ref: l.referenceRef,
      testCode: l.testCode,
      testName: i?.testName ?? null,
      mrn: l.patientHospitalNo,
      patientType: i?.patientType ?? null,
      status: i?.status ?? null,
      destination: i?.destination ?? null,
      invoiceNumber: i?.invoiceNumber ?? null,
      paymentCheck: l.paymentCheck,
      collectorType: l.collectorType,
      collectorName: l.collectorName,
      overridden: Boolean(l.overrideReason),
      issuedAt: l.issuedAt,
      clearedAt: l.clearedAt,
      portalId: i?.portalId ?? null,
      startedAt: i?.startedAt ?? null,
      startedBy: i?.startedBy ?? null,
      preparedAt: i?.preparedAt ?? null,
      preparedBy: i?.preparedBy ?? null,
      verifiedAt: i?.verifiedAt ?? null,
      verifiedBy: i?.verifiedBy ?? null,
      completedAt: i?.completedAt ?? null,
    };
  });

  return {
    unit: {
      serial: report.unit.serial,
      state: report.unit.state,
      itemName: report.unit.itemName,
      containerType: type?.containerType ?? null,
      lotNo: report.unit.lotNo ?? null,
      expiryDate: report.unit.expiryDate ?? null,
      locationName: report.unit.locationName,
    },
    tests,
    journey: report.history.map((h) => ({
      type: h.type,
      fromState: h.fromState,
      toState: h.toState,
      at: h.occurredAt,
      locationName: h.locationName,
      userName: h.userName,
      transferCode: h.transferCode,
      reasonCode: h.reasonCode,
      note: h.note,
    })),
  };
}

export interface CollectedBottle {
  serial: string;
  state: string;
  locationName: string;
  issuedAt: Date;
  /** When the link was closed, if it was. A bottle returned as used keeps its link open, so use `state` to tell if it is still out. */
  clearedAt: Date | null;
}

/**
 * Bottles already issued for one investigation, oldest first, so the panel can say "sample bottle already
 * collected" before another one is scanned. Empty when none was issued.
 */
export async function bottlesForInvestigation(refInput: string): Promise<CollectedBottle[]> {
  const ref = normalizeReference(refInput);
  if (!ref) return [];
  return db()
    .select({
      serial: units.serial,
      state: units.state,
      locationName: locations.name,
      issuedAt: links.createdAt,
      clearedAt: links.clearedAt,
    })
    .from(links)
    .innerJoin(units, eq(units.id, links.unitId))
    .innerJoin(locations, eq(locations.id, units.currentLocationId))
    .where(and(eq(links.referenceType, "INVESTIGATION"), eq(links.referenceRef, ref)))
    .orderBy(asc(links.createdAt));
}
