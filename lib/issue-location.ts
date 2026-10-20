// Which kinds of issue a location may do, from its service role (corrections C2). Pure, so the server rule
// and the Issue screen use the same answer.
//
// A collection point hands containers to patients, so it issues against investigations, admissions and so on.
// A bench section or the blood bank uses stock inside the lab for the department, not per patient, so it
// issues only against a department. A location with no role, or the store role, is not restricted.

const DEPARTMENT_ONLY_ROLES: readonly string[] = ["BENCH", "BLOOD_BANK"];

/** True when this location may only issue stock for its department. */
export function departmentOnly(serviceRole: string | null | undefined): boolean {
  return serviceRole != null && DEPARTMENT_ONLY_ROLES.includes(serviceRole);
}

/** Whether a location with this service role may issue against this kind of reference. */
export function referenceAllowedAt(serviceRole: string | null | undefined, referenceType: string): boolean {
  return !departmentOnly(serviceRole) || referenceType === "DEPARTMENT";
}

/** The message shown when a department-only location is asked to issue against a patient or procedure. */
export function departmentOnlyMessage(locationName: string, serviceRole: string | null | undefined): string {
  const kind = serviceRole === "BLOOD_BANK" ? "the blood bank" : "a bench section";
  return `${locationName} is ${kind}: it uses stock for the department, not per patient. Issue it for a Department instead`;
}
