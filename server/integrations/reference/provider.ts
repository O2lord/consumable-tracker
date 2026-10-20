import type { PatientType, ReferenceType } from "../../domain/types";
import type { KnownPayment } from "../../domain/issue-rules";

// The seam between the tracker and wherever investigations, admissions and so on live
// (architecture section 9). Services only talk to this interface, so the manual provider used
// now can be swapped for the CSV provider (Phase 6) and the EMR provider (Phase 8) without
// touching the issue rules.

export interface ReferenceLookup {
  /** `unknown` when the provider cannot say (the manual provider never can). */
  exists: boolean | "unknown";
  patientHospitalNo?: string;
  patientType?: PatientType;
  paymentStatus: KnownPayment;
  destination?: string;
  items?: { code: string; name: string; requiredContainer?: string }[];
}

export interface ReferenceSummary {
  type: ReferenceType;
  ref: string;
  patientHospitalNo: string;
  patientType?: PatientType;
  paymentStatus: KnownPayment;
  testCode?: string;
  testName?: string;
  requiredContainer?: string;
}

export interface ReferenceProvider {
  /** Where `links.reference_source` is set from. */
  readonly source: "manual" | "slip_scan" | "csv" | "emr";
  lookup(type: ReferenceType, ref: string): Promise<ReferenceLookup>;
  /** Pending investigations for a patient: powers the MRN-first issue screen (Phase 6). */
  listPendingForPatient(mrn: string): Promise<ReferenceSummary[]>;
}
