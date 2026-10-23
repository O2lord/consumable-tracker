// Formats of the numbers staff type or scan when issuing (architecture section 9).
// Pure: no I/O. Only the investigation number and the MRN are confirmed from the staff portal;
// the others are deliberately permissive until their real formats are known (build.md open items).

import type { ReferenceType } from "../server/domain/types";

const INVESTIGATION = /^IXS\d{1,12}$/;
const MRN = /^UATH\/PT\/\d{1,12}$/;
/** Admission, visit, procedure, surgery and department references: formats to be confirmed. */
const LOOSE = /^[A-Z0-9][A-Z0-9/._ -]{0,39}$/;

/** Upper-cases and trims, and collapses inner runs of spaces, so "ixs 181" cannot sneak in as two things. */
export function normalizeReference(input: string): string {
  return input.trim().toUpperCase().replace(/\s+/g, " ");
}

export function normalizeMrn(input: string): string {
  return input.trim().toUpperCase().replace(/\s+/g, "");
}

/** A bare number gets the hospital prefix ("1278932" becomes "UATH/PT/1278932"); anything else is left as typed. */
export function withMrnPrefix(input: string): string {
  const value = input.trim();
  return /^\d+$/.test(value) ? `UATH/PT/${value}` : value;
}

export function isValidMrn(mrn: string): boolean {
  return MRN.test(normalizeMrn(mrn));
}

/** True when the number looks right for its type. It says nothing about whether it exists. */
export function isValidReference(type: ReferenceType, ref: string): boolean {
  const value = normalizeReference(ref);
  if (type === "INVESTIGATION") return INVESTIGATION.test(value);
  return LOOSE.test(value);
}

/** A readable reason when the number is malformed, or null when it is fine. */
export function referenceFormatProblem(type: ReferenceType, ref: string): string | null {
  if (isValidReference(type, ref)) return null;
  if (type === "INVESTIGATION") return `"${ref}" is not an investigation number (expected IXS followed by digits, e.g. IXS181)`;
  return `"${ref}" is not a valid ${type.toLowerCase()} reference`;
}

/** Reference types that belong to a patient, so the MRN is required with them. */
export function needsPatient(type: ReferenceType): boolean {
  return type !== "DEPARTMENT";
}
