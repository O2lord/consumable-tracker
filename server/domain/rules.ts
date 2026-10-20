import { canWorkAtAnyLocation } from "../auth/permissions";
import {
  ExpiredStockError,
  PermissionDeniedError,
  TransferStatusError,
  ValidationError,
  WrongLocationError,
  WrongTransferError,
} from "./errors";
import { planPieceDispatch, type PieceDispatchPlan } from "../../lib/pack-size";
import { transition } from "./state-machine";
import type { Actor, TransferStatus, UnitState } from "./types";

// Business rules for dispatch, receive and discrepancies (architecture section 8).
// Pure: no I/O. Services load the facts, call these, then write.

/** Expiry is a calendar date (UTC). Stock expiring today is still usable today. */
export function isExpired(expiryDate: string | null | undefined, today: string): boolean {
  return Boolean(expiryDate) && (expiryDate as string) < today;
}

export interface UnitFacts {
  serial: string;
  state: UnitState;
  locationId: string;
  /** units.current_transfer_id */
  transferId: string | null;
  expiryDate: string | null;
}

/** A unit can only be dispatched from where it is, only from IN_STOCK, and only if not expired. */
export function assertCanDispatchUnit(unit: UnitFacts, fromLocationId: string, today: string): void {
  if (unit.state === "IN_TRANSIT") {
    throw new ValidationError(`${unit.serial} is already in transit on another transfer`);
  }
  transition(unit.state, "DISPATCH"); // throws InvalidTransitionError for any other state
  if (unit.locationId !== fromLocationId) {
    throw new WrongLocationError(`${unit.serial} is not at the dispatching location`);
  }
  if (isExpired(unit.expiryDate, today)) {
    throw new ExpiredStockError(`${unit.serial} has expired and cannot be dispatched`);
  }
}

/**
 * An item type with allowed_service_roles can only go to a location whose service_role is in that list
 * (corrections C2). A null list on the item, or a null role on the destination, means "no restriction",
 * so rows from before the service roles existed keep working. A STORE destination is always allowed:
 * stores pass stock on (for example reagents go main store -> Main lab reception -> a bench), and the
 * restriction is enforced at the next hop. The message names the item, the destination and the roles
 * it can go to, for example "Anti-A can't be sent to MMW. It can go to: BENCH, BLOOD_BANK".
 */
export function assertServiceRoleAllowed(
  item: { name: string; allowedServiceRoles: readonly string[] | null },
  destination: { name: string; serviceRole: string | null },
): void {
  const allowed = item.allowedServiceRoles;
  if (!allowed || allowed.length === 0 || destination.serviceRole === null) return;
  if (destination.serviceRole === "STORE" || allowed.includes(destination.serviceRole)) return;
  throw new ValidationError(
    `${item.name} can't be sent to ${destination.name}. It can go to: ${allowed.join(", ")}`,
  );
}

/** Quantity must be a whole number, within what the location holds (after other drafts). */
export function assertCanDispatchQuantity(args: {
  quantity: number;
  available: number;
  expiryDate: string | null;
  today: string;
}): void {
  const { quantity, available, expiryDate, today } = args;
  if (!Number.isInteger(quantity) || quantity <= 0) {
    throw new ValidationError("Enter a whole number greater than zero");
  }
  if (isExpired(expiryDate, today)) throw new ExpiredStockError("This batch has expired and cannot be dispatched");
  if (quantity > available) {
    throw new ValidationError(`Only ${Math.max(available, 0)} of this batch is available at the dispatching location`);
  }
}

/**
 * Loose pieces taken from a bulk batch: a whole number, not expired, and no more than the location holds once
 * other drafts have taken their share (`sealed` packs and `loose` pieces, both after those drafts). Returns the
 * plan: how many sealed packs get opened, and what is left sealed and loose afterwards.
 */
export function assertCanDispatchPieces(args: {
  pieces: number;
  sealed: number;
  loose: number;
  packSize: number;
  expiryDate: string | null;
  today: string;
}): PieceDispatchPlan {
  const { pieces, sealed, loose, packSize, expiryDate, today } = args;
  if (isExpired(expiryDate, today)) throw new ExpiredStockError("This batch has expired and cannot be dispatched");
  const plan = planPieceDispatch({ sealed, loose, packSize, pieces });
  if ("error" in plan) throw new ValidationError(plan.error);
  return plan;
}

/** A unit can only be received on the transfer it was dispatched on. */
export function assertUnitOnTransfer(unitTransferId: string | null, transferId: string, serial: string): void {
  if (unitTransferId !== transferId) {
    throw new WrongTransferError(`${serial} is not on this transfer. Check the slip and the destination`);
  }
}

/** Receiving happens at the destination, by someone who works there (supervisors and admins may cover any). */
export function assertCanReceiveAt(actor: Pick<Actor, "role" | "homeLocationId">, toLocationId: string): void {
  if (canWorkAtAnyLocation(actor.role)) return;
  if (actor.homeLocationId !== toLocationId) {
    throw new PermissionDeniedError("This transfer is for a different location than yours");
  }
}

/** Which statuses allow which step. Throws a clear message otherwise. */
export function assertStatus(current: TransferStatus, allowed: readonly TransferStatus[], doing: string): void {
  if (allowed.includes(current)) return;
  const readable = current.toLowerCase().replace(/_/g, " ");
  throw new TransferStatusError(`Cannot ${doing}: this transfer is ${readable}`);
}

/**
 * A transfer linked to a Pharmacy transfer cannot be confirmed with a different total
 * without a recorded explanation. Returns the explanation to store, or null when none is needed.
 */
export function pharmacyMismatchNote(
  total: number,
  pharmacyQuantity: number | null,
  explanation: string | undefined,
): string | null {
  if (pharmacyQuantity === null || total === pharmacyQuantity) return null;
  const text = explanation?.trim();
  if (!text || text.length < 3) {
    throw new ValidationError(
      `You scanned ${total} but the linked Pharmacy transfer says ${pharmacyQuantity}. Explain the difference to continue`,
    );
  }
  return text;
}

/**
 * Blind count rule: the counter has not been shown the expected figure. A count above what was
 * dispatched cannot be right, so it is bounced back for a recount (revealing only "too high").
 */
export function assertCountPlausible(counted: number, dispatched: number): void {
  if (!Number.isInteger(counted) || counted < 0) throw new ValidationError("Enter a whole number, zero or more");
  if (counted > dispatched) {
    throw new ValidationError("That count is higher than what was sent. Count again; ask a supervisor if it stays the same");
  }
}

/**
 * A whole-pack transfer line whose packs were all scanned one by one when it was sent. It is received the same way, by
 * scanning each pack in, so what was scanned is what arrived and there is no count to type. A line sent as loose pieces,
 * or with some packs typed rather than scanned (or none), is still counted by hand.
 */
export function isScanLine(line: { inPieces: boolean; linkedPacks: number; dispatched: number }): boolean {
  return !line.inPieces && line.linkedPacks > 0 && line.linkedPacks >= line.dispatched;
}

export interface ReceiptItem {
  kind: "SERIAL" | "QUANTITY";
  /** Serial for SERIAL items, batch code for QUANTITY items. */
  ref: string;
  dispatched: number;
  /** null = not scanned (SERIAL) or not counted (QUANTITY). */
  received: number | null;
}

export interface ReceiptOutcome {
  missingSerials: string[];
  /** Quantity items that arrived short. */
  shortfalls: { ref: string; missing: number }[];
  /** Quantity items nobody has counted yet: the receipt cannot close until they are. */
  uncounted: string[];
  hasDiscrepancy: boolean;
}

/** Works out what closing a receipt would produce. Unscanned serials are missing; counts are final. */
export function receiptOutcome(items: readonly ReceiptItem[]): ReceiptOutcome {
  const missingSerials: string[] = [];
  const shortfalls: { ref: string; missing: number }[] = [];
  const uncounted: string[] = [];
  for (const item of items) {
    if (item.kind === "SERIAL") {
      if (item.received === null) missingSerials.push(item.ref);
    } else if (item.received === null) {
      uncounted.push(item.ref);
    } else if (item.received < item.dispatched) {
      shortfalls.push({ ref: item.ref, missing: item.dispatched - item.received });
    }
  }
  return {
    missingSerials,
    shortfalls,
    uncounted,
    hasDiscrepancy: missingSerials.length > 0 || shortfalls.length > 0,
  };
}

/** Status a transfer takes when its receipt closes. */
export function statusAfterClose(outcome: Pick<ReceiptOutcome, "hasDiscrepancy">): TransferStatus {
  return outcome.hasDiscrepancy ? "RECEIVED_WITH_DISCREPANCY" : "RECEIVED";
}

/** A supervisor must give a reason, and cannot resolve more than is still outstanding. */
export function assertCanResolve(args: { quantity: number; outstanding: number; note: string | undefined }): string {
  const { quantity, outstanding, note } = args;
  const text = note?.trim();
  if (!text || text.length < 3) throw new ValidationError("A reason is required to resolve a discrepancy");
  if (!Number.isInteger(quantity) || quantity <= 0) throw new ValidationError("Enter a whole number greater than zero");
  if (quantity > outstanding) {
    throw new ValidationError(`Only ${outstanding} is still unresolved for this item`);
  }
  return text;
}

/** FOUND, WRITTEN_OFF, or SPLIT once the whole missing amount has been dealt with. */
export function itemResolution(found: number, writtenOff: number, missing: number): "FOUND" | "WRITTEN_OFF" | "SPLIT" | null {
  if (found + writtenOff < missing) return null;
  if (writtenOff === 0) return "FOUND";
  if (found === 0) return "WRITTEN_OFF";
  return "SPLIT";
}
