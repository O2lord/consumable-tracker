import "server-only";
import { and, asc, eq, inArray, isNull, or } from "drizzle-orm";
import { db } from "../../db/client";
import { investigationImports, testCatalog } from "../../db/schema";
import { ValidationError } from "../../domain/errors";
import type { KnownPayment } from "../../domain/issue-rules";
import { isValidMrn, normalizeMrn, normalizeReference, referenceFormatProblem } from "../../../lib/reference-formats";
import { matchTest } from "../../../lib/test-match";
import { mrnBlindIndex } from "../../security/field-crypto";
import type { ReferenceProvider, ReferenceSummary } from "./provider";

// The CSV provider (architecture section 9, stage "Next"): answers from the investigation imports.
//
// A number that is NOT in the imports comes back as `unknown`, not `false`. The imports are a
// snapshot, so an investigation raised since the last file is not a typo; refusing it would stop
// the lab for as long as the export is stale. The orphan report catches the real typos afterwards.
// A number that IS in the imports gives the patient, patient type, payment and destination.

function knownPayment(status: string | null): KnownPayment {
  return status === "PAID" || status === "UNPAID" || status === "CHARGED_TO_ADMISSION" ? status : "unknown";
}

export const csvReferenceProvider: ReferenceProvider = {
  source: "csv",

  async lookup(type, ref) {
    const problem = referenceFormatProblem(type, ref);
    if (problem) throw new ValidationError(problem);
    // Only investigations are imported so far; everything else behaves as with the manual provider.
    if (type !== "INVESTIGATION") return { exists: "unknown", paymentStatus: "unknown" };

    const [row] = await db()
      .select()
      .from(investigationImports)
      .where(eq(investigationImports.investigationRef, normalizeReference(ref)))
      .limit(1);
    if (!row) return { exists: "unknown", paymentStatus: "unknown" };

    return {
      exists: true,
      patientHospitalNo: row.patientHospitalNo,
      patientType: row.patientType ?? undefined,
      paymentStatus: knownPayment(row.paymentStatus),
      destination: row.destination ?? undefined,
      items: [{ code: row.testCode ?? "", name: row.testName }],
    };
  },

  /**
   * Investigations waiting for a sample: LAB queue, status pending (or not given). Each comes with
   * the test catalog entry it matches, so the issue screen can tell which container is needed.
   */
  async listPendingForPatient(mrnInput): Promise<ReferenceSummary[]> {
    const mrn = normalizeMrn(mrnInput);
    if (!isValidMrn(mrn)) return [];
    const conn = db();
    const rows = await conn
      .select()
      .from(investigationImports)
      .where(
        and(
          // The MRN column is encrypted (random per write), so it can't be compared: use the fingerprint.
          eq(investigationImports.patientHospitalNoIdx, mrnBlindIndex(mrn)),
          eq(investigationImports.queue, "LAB"),
          or(isNull(investigationImports.status), inArray(investigationImports.status, ["pending"])),
        ),
      )
      .orderBy(asc(investigationImports.investigationRef));
    if (rows.length === 0) return [];

    const catalog = await conn
      .select({ code: testCatalog.code, name: testCatalog.name, requiredContainer: testCatalog.requiredContainerType })
      .from(testCatalog)
      .where(eq(testCatalog.active, true));

    return rows.map((r) => {
      const test = matchTest({ testCode: r.testCode, testName: r.testName }, catalog);
      return {
        type: "INVESTIGATION" as const,
        ref: r.investigationRef,
        patientHospitalNo: r.patientHospitalNo,
        patientType: r.patientType ?? undefined,
        paymentStatus: knownPayment(r.paymentStatus),
        testCode: test?.code,
        testName: r.testName,
        requiredContainer: test?.requiredContainer ?? undefined,
      };
    });
  },
};
