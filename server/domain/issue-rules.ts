import { sharedContainers } from "../../lib/containers";
import { departmentOnlyMessage, referenceAllowedAt } from "../../lib/issue-location";
import { can, canWorkAtAnyLocation } from "../auth/permissions";
import {
  AlreadyIssuedError,
  ExpiredStockError,
  PatientMismatchError,
  PermissionDeniedError,
  ValidationError,
  WrongLocationError,
} from "./errors";
import { isExpired } from "./rules";
import { transition } from "./state-machine";
import type {
  Actor,
  IssueRule,
  PatientType,
  PaymentCheck,
  PolicyPatientType,
  ReferenceType,
  ReturnOutcome,
  UnitAction,
  UnitState,
} from "./types";

// Business rules for issue, return and void (architecture section 8). Pure: no I/O.
// Services load the facts, call these, then write.

/**
 * Where the person is working. Supervisors and admins work at the location they chose in the app bar (their home
 * location until they choose one); everyone else uses their own.
 *
 * `requestedLocationId` is the location a form or screen was showing when it was sent. For someone who may work
 * anywhere it must still be the working location, so a second tab or an open pop-up that was rendered before a
 * switch cannot act at the old place. Callers that know only the home location (no `workLocationId`) may still
 * name any location.
 */
export function resolveWorkLocation(
  actor: Pick<Actor, "role" | "homeLocationId" | "workLocationId">,
  requestedLocationId?: string,
): string {
  if (canWorkAtAnyLocation(actor.role)) {
    const current = actor.workLocationId ?? actor.homeLocationId;
    if (requestedLocationId && actor.workLocationId && requestedLocationId !== actor.workLocationId) {
      throw new WrongLocationError(
        "You switched where you are working while this page was open. Reload the page and try again",
      );
    }
    const id = requestedLocationId ?? current;
    if (!id) throw new ValidationError("Choose the location you are working at, at the top of the page");
    return id;
  }
  if (!actor.homeLocationId) {
    throw new PermissionDeniedError("Your account has no home location. Ask an admin to set one");
  }
  if (requestedLocationId && requestedLocationId !== actor.homeLocationId) {
    throw new PermissionDeniedError("You can only work at your own location");
  }
  return actor.homeLocationId;
}

/**
 * A bench section or the blood bank issues only for its department, not per patient (corrections C2). A
 * collection point, a store, or a location with no service role may issue against any reference. Not
 * something a supervisor override can push past: the location's role is part of how the lab is set up.
 */
export function assertReferenceAllowedAtLocation(
  location: { name: string; serviceRole: string | null },
  referenceTypes: readonly string[],
): void {
  if (referenceTypes.every((type) => referenceAllowedAt(location.serviceRole, type))) return;
  throw new ValidationError(departmentOnlyMessage(location.name, location.serviceRole));
}

/** Overrides are for supervisors, and always carry a reason that ends up in the reports. */
export function assertCanOverride(actor: Pick<Actor, "role">, reason: string | undefined): string {
  if (!can(actor.role, "approve_override")) {
    throw new PermissionDeniedError("Only a supervisor can override this. Ask a supervisor to sign in and do it");
  }
  const text = reason?.trim();
  if (!text || text.length < 3) throw new ValidationError("A reason is required for an override");
  return text;
}

export interface IssueUnitFacts {
  serial: string;
  state: UnitState;
  locationId: string;
  expiryDate: string | null;
}

/** A unit can only be issued where it is, from IN_STOCK, and only if it has not expired. */
export function assertCanIssueUnit(unit: IssueUnitFacts, workLocationId: string, today: string): void {
  if (unit.state === "ISSUED") throw new AlreadyIssuedError(`${unit.serial} has already been issued`);
  transition(unit.state, "ISSUE"); // IN_STOCK only; any other state gives a clear error
  if (unit.locationId !== workLocationId) {
    throw new WrongLocationError(`${unit.serial} is not at your location`);
  }
  if (isExpired(unit.expiryDate, today)) {
    throw new ExpiredStockError(`${unit.serial} has expired and cannot be issued`);
  }
}

/** Quantity must be a whole number within what the location holds. */
export function assertCanIssueQuantity(args: {
  quantity: number;
  available: number;
  expiryDate: string | null;
  today: string;
}): void {
  const { quantity, available, expiryDate, today } = args;
  if (!Number.isInteger(quantity) || quantity <= 0) throw new ValidationError("Enter a whole number greater than zero");
  if (isExpired(expiryDate, today)) throw new ExpiredStockError("This batch has expired and cannot be issued");
  if (quantity > available) {
    throw new ValidationError(`Only ${Math.max(available, 0)} of this batch is at your location`);
  }
}

/**
 * Container type must satisfy every test on the bottle. `accepted` has one entry per test: the containers
 * that test accepts (its required type and any alternates, see lib/containers.ts). Returns a message when
 * the bottle does not fit, or null. No requirement means nothing to check; a bottle with no container type
 * fails any requirement.
 */
export function containerMismatch(
  serial: string,
  unitContainerType: string | null,
  accepted: readonly (readonly string[])[],
): string | null {
  const shared = sharedContainers(accepted);
  if (shared === null) return null;
  if (shared.length === 0) {
    const sets = [...new Set(accepted.filter((s) => s.length > 0).map((s) => s.join(" or ")))];
    return `These tests need different containers (${sets.join(", ")}). Issue them in separate groups`;
  }
  const need = shared.join(" or ");
  if (!unitContainerType) return `${serial} has no container type set, but the test needs ${need}`;
  if (!shared.includes(unitContainerType)) return `${serial} is ${unitContainerType}, but the test needs ${need}`;
  return null;
}

/** The rule for a reference type and patient type: exact match, then the ANY fallback, else NONE. */
export function pickPolicyRule(
  policies: readonly { referenceType: ReferenceType; patientType: PolicyPatientType; rule: IssueRule }[],
  referenceType: ReferenceType,
  patientType: PatientType | undefined,
): IssueRule {
  const exact = patientType
    ? policies.find((p) => p.referenceType === referenceType && p.patientType === patientType)
    : undefined;
  const fallback = policies.find((p) => p.referenceType === referenceType && p.patientType === "ANY");
  return (exact ?? fallback)?.rule ?? "NONE";
}

export type KnownPayment = "PAID" | "UNPAID" | "CHARGED_TO_ADMISSION" | "unknown";

/**
 * What the policy means for one reference. An unverifiable payment is recorded as UNVERIFIED and
 * allowed (architecture 7.4); a payment known to be missing blocks the issue.
 */
export function evaluatePayment(
  rule: IssueRule,
  payment: KnownPayment,
): { check: PaymentCheck; blocked: boolean } {
  if (rule === "NONE" || rule === "CHARGE_TO_ADMISSION") return { check: "NOT_REQUIRED", blocked: false };
  if (payment === "PAID" || payment === "CHARGED_TO_ADMISSION") return { check: "VERIFIED", blocked: false };
  if (payment === "UNPAID") return { check: "UNVERIFIED", blocked: true };
  return { check: "UNVERIFIED", blocked: false };
}

/**
 * One bottle may serve several investigations of the same patient, never different patients.
 * `existing` holds the MRNs on the unit's active links.
 */
export function assertSamePatient(existing: readonly (string | null)[], mrn: string | null, serial: string): void {
  const others = new Set(existing.filter((m): m is string => Boolean(m)));
  if (others.size === 0) return;
  if (!mrn || others.size > 1 || !others.has(mrn)) {
    throw new PatientMismatchError(`${serial} is already linked to a different patient and cannot be linked to this one`);
  }
}

export interface ReturnDecision {
  action: UnitAction;
  /** Clear the unit's links (it goes back on the shelf or is voided unused). */
  clearLinks: boolean;
  /** Reason recorded on the event when the unit is voided. */
  reasonCode: string | null;
}

/**
 * What a returned SERIAL item becomes (architecture 7.5):
 *  - USED: ISSUED -> RETURNED
 *  - UNUSED: back to IN_STOCK, or voided with reason UNUSED when the location does not allow reuse
 *  - UNUSABLE: voided, with a reason the person must choose
 */
export function decideReturn(
  outcome: ReturnOutcome,
  allowUnusedReuse: boolean,
  reasonCode: string | undefined,
): ReturnDecision {
  if (outcome === "USED") return { action: "RETURN_USED", clearLinks: false, reasonCode: null };
  if (outcome === "UNUSED") {
    return allowUnusedReuse
      ? { action: "RETURN_UNUSED", clearLinks: true, reasonCode: null }
      : { action: "VOID", clearLinks: true, reasonCode: "UNUSED" };
  }
  if (!reasonCode) throw new ValidationError("Choose a reason for the unusable bottle");
  return { action: "VOID", clearLinks: false, reasonCode };
}

/** A quantity can only come back (or be wasted) up to what is still out from this location. */
export function assertCanReturnQuantity(quantity: number, outstanding: number): void {
  if (!Number.isInteger(quantity) || quantity <= 0) throw new ValidationError("Enter a whole number greater than zero");
  if (quantity > outstanding) {
    throw new ValidationError(`Only ${Math.max(outstanding, 0)} of this batch is out from your location`);
  }
}

/** Units voided outside the return flow: shelf stock, or a bottle whose investigation was cancelled. */
export function assertCanVoidUnit(unit: { serial: string; state: UnitState; locationId: string }, workLocationId: string): void {
  if (unit.state !== "IN_STOCK" && unit.state !== "ISSUED") {
    throw new ValidationError(
      `${unit.serial} is ${unit.state.toLowerCase().replace(/_/g, " ")} and cannot be voided here`,
    );
  }
  transition(unit.state, "VOID");
  if (unit.locationId !== workLocationId) throw new WrongLocationError(`${unit.serial} is not at your location`);
}
