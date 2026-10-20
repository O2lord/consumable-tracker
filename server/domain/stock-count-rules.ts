import { ValidationError } from "./errors";
import { COUNT_SHORT_REASONS, COUNT_SURPLUS_REASONS, type CountVarianceReason } from "./types";

// Business rules for par levels and stock counts (corrections C7). Pure: no I/O.

export const COUNT_REASON_LABEL: Record<CountVarianceReason, string> = {
  USED_NOT_RECORDED: "Used but not recorded",
  DAMAGED_OR_EXPIRED: "Damaged or expired",
  LOST_OR_MISSING: "Lost or cannot be found",
  RECEIPT_COUNTED_SHORT: "A receipt was counted short",
  RETURNED_NOT_RECORDED: "Returned or restocked, not recorded",
  OTHER: "Other (explain in the note)",
};

/** counted minus expected: negative is a shortfall, positive is a surplus. */
export function countVariance(counted: number, expected: number): number {
  return counted - expected;
}

/** Like countVariance, but a figure that was not counted (null) has no variance. */
export function optionalVariance(counted: number | null | undefined, expected: number): number {
  return counted == null ? 0 : countVariance(counted, expected);
}

/** The reasons that make sense for a variance, by direction. Empty when there is none. */
export function reasonsFor(variance: number): readonly CountVarianceReason[] {
  if (variance < 0) return COUNT_SHORT_REASONS;
  if (variance > 0) return COUNT_SURPLUS_REASONS;
  return [];
}

/**
 * A line with a variance needs a reason of the matching direction, and "Other" needs a note. A line with
 * no variance needs nothing. Returns the reason to store (null when there is no variance).
 */
export function assertVarianceExplained(
  line: { itemName: string; batchCode: string; variance: number },
  reasonCode: string | null | undefined,
  note: string | null | undefined,
): CountVarianceReason | null {
  if (line.variance === 0) return null;
  const label = `${line.itemName} (${line.batchCode})`;
  const allowed = reasonsFor(line.variance);
  if (!reasonCode || !(allowed as readonly string[]).includes(reasonCode)) {
    const direction = line.variance < 0 ? "short" : "over";
    throw new ValidationError(`${label} is ${Math.abs(line.variance)} ${direction}. Choose a reason`);
  }
  if (reasonCode === "OTHER" && !(note && note.trim().length >= 3)) {
    throw new ValidationError(`${label}: explain the difference in the note`);
  }
  return reasonCode as CountVarianceReason;
}

/** Items at or below their minimum (a minimum of 0 means none is set), for the "low" flag. */
export function isBelowMinimum(onHand: number, minimum: number): boolean {
  return minimum > 0 && onHand <= minimum;
}

/** What to ask for to get back to target, never negative. */
export function shortfallToTarget(target: number, onHand: number, onTheWay: number): number {
  return Math.max(target - onHand - onTheWay, 0);
}
