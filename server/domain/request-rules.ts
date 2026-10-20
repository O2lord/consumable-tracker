import { RequestStatusError, ValidationError } from "./errors";
import type { RequestStatus } from "./types";

// Business rules for stock requests (a lab asks the store; the store approves, dispatches by transfer).
// Pure: no I/O. Services load the facts, call these, then write.
//
// Quantities on a request line:
//   requested   what the lab asked for
//   approved    what the store agreed to send (set at review, may be 0 or less than requested)
//   dispatched  confirmed on linked transfers, never above approved
//   received    counted at the lab on those transfers, never above dispatched
// The open balance of a line is approved - dispatched, until the line is closed.

export interface LineFacts {
  /** True when the quantities on this line are loose pieces rather than the item's own unit. */
  inPieces?: boolean;
  quantityApproved: number | null;
  quantityDispatched: number;
  quantityReceived: number;
  closedAt: Date | null;
}

/** Throws a clear message when the request is not in a status that allows this step. */
export function assertRequestStatus(current: RequestStatus, allowed: readonly RequestStatus[], doing: string): void {
  if (allowed.includes(current)) return;
  const readable = current.toLowerCase().replace(/_/g, " ");
  throw new RequestStatusError(`Cannot ${doing}: this request is ${readable}`);
}

/** What is still to be sent on a line. Zero once the line is closed or was never approved. */
export function openBalance(line: Pick<LineFacts, "quantityApproved" | "quantityDispatched" | "closedAt">): number {
  if (line.closedAt || line.quantityApproved === null) return 0;
  return Math.max(line.quantityApproved - line.quantityDispatched, 0);
}

/**
 * Dispatch cap. Measured against what was already dispatched (not received), so the store cannot send
 * the same balance twice while the first transfer is still in transit.
 */
export function assertWithinRequestBalance(args: {
  requestCode: string;
  itemName: string;
  line: Pick<LineFacts, "quantityApproved" | "quantityDispatched" | "closedAt" | "inPieces"> | undefined;
  adding: number;
  /** True when `adding` is loose pieces. It must match how the request line is counted. */
  addingInPieces?: boolean;
}): void {
  const { requestCode, itemName, line, adding } = args;
  const addingInPieces = args.addingInPieces === true;
  if (!line || line.quantityApproved === null || line.quantityApproved === 0) {
    throw new ValidationError(`${itemName} was not approved on request ${requestCode}. Remove it from the transfer`);
  }
  if (line.closedAt) {
    throw new ValidationError(`${itemName} was closed on request ${requestCode}. Remove it from the transfer`);
  }
  if (Boolean(line.inPieces) !== addingInPieces) {
    throw new ValidationError(
      line.inPieces
        ? `${itemName} was requested in pieces on request ${requestCode}. Add it to the transfer as pieces`
        : `${itemName} was requested in packs on request ${requestCode}. Add it to the transfer as packs, not pieces`,
    );
  }
  const open = openBalance(line);
  if (adding > open) {
    const unit = line.inPieces ? " pieces" : "";
    throw new ValidationError(
      `Request ${requestCode} has only ${open}${unit} of ${itemName} left to send, but this transfer has ${adding}${unit}`,
    );
  }
}

/** Submit-time check: the lab cannot ask for more than the store can send right now. */
export function assertAvailableForRequest(args: {
  itemName: string;
  requested: number;
  available: number;
  /** "pieces" when both numbers are loose pieces; left out when they are in the item's own unit. */
  unitWord?: string;
}): void {
  const { itemName, requested, available, unitWord } = args;
  if (requested > available) {
    const unit = unitWord ? ` ${unitWord}` : "";
    throw new ValidationError(
      `${itemName}: the store has ${Math.max(available, 0)}${unit} available, but ${requested}${unit} was requested. Lower the quantity`,
    );
  }
}

export interface ApprovalLine {
  lineId: string;
  itemName: string;
  quantityRequested: number;
  quantityApproved: number;
}

/** Approved can be less than requested (or 0 to decline a line) but never more, and not everything can be 0. */
export function assertApprovalValid(lines: readonly ApprovalLine[]): void {
  for (const l of lines) {
    if (!Number.isInteger(l.quantityApproved) || l.quantityApproved < 0) {
      throw new ValidationError(`${l.itemName}: enter a whole number, zero or more`);
    }
    if (l.quantityApproved > l.quantityRequested) {
      throw new ValidationError(
        `${l.itemName}: you cannot approve more than the ${l.quantityRequested} that was requested`,
      );
    }
  }
  if (lines.every((l) => l.quantityApproved === 0)) {
    throw new ValidationError("Approve at least one item, or reject the request");
  }
}

/** Only a line with something still to send can be closed, and only with a reason. */
export function assertCanCloseLine(line: LineFacts, reason: string | undefined): string {
  if (line.closedAt) throw new ValidationError("This line is already closed");
  if (openBalance(line) === 0) throw new ValidationError("Nothing is left to send on this line");
  const text = reason?.trim();
  if (!text || text.length < 3) throw new ValidationError("A reason is required to close a line");
  return text;
}

/**
 * Status of an approved request, worked out from its lines.
 *
 *   APPROVED             nothing dispatched yet
 *   PARTIALLY_FULFILLED  something dispatched, and something is still open or on its way
 *   FULFILLED            every approved line fully dispatched, and nothing still in transit
 *   CLOSED               every line settled, but at least one was closed short
 *
 * Lines the store declined (approved 0) take no part.
 */
export function deriveRequestStatus(
  lines: readonly LineFacts[],
  options: { hasTransferInFlight: boolean },
): Extract<RequestStatus, "APPROVED" | "PARTIALLY_FULFILLED" | "FULFILLED" | "CLOSED"> {
  const active = lines.filter((l) => (l.quantityApproved ?? 0) > 0);
  if (active.length === 0) return "CLOSED";

  const fullyDispatched = (l: LineFacts) => l.quantityDispatched >= (l.quantityApproved ?? 0);
  const settled = active.every((l) => l.closedAt !== null || fullyDispatched(l));
  const anyDispatched = active.some((l) => l.quantityDispatched > 0);

  if (settled && !options.hasTransferInFlight) {
    return active.every(fullyDispatched) ? "FULFILLED" : "CLOSED";
  }
  return anyDispatched ? "PARTIALLY_FULFILLED" : "APPROVED";
}
