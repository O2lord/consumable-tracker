import { InvalidTransitionError } from "./errors";
import type { EventType, UnitAction, UnitState } from "./types";

// The state machine for SERIAL units (architecture section 4). Pure: it only answers
// "is this move legal, and what event does it produce". Services do the writing.

interface Rule {
  from: readonly UnitState[];
  to: UnitState;
  event: EventType;
}

const RULES: Record<UnitAction, Rule> = {
  DISPATCH: { from: ["IN_STOCK"], to: "IN_TRANSIT", event: "DISPATCHED" },
  RECEIVE: { from: ["IN_TRANSIT"], to: "IN_STOCK", event: "RECEIVED" },
  MARK_MISSING: { from: ["IN_TRANSIT"], to: "MISSING_IN_TRANSIT", event: "MISSING_IN_TRANSIT" },
  RESOLVE_FOUND: { from: ["MISSING_IN_TRANSIT"], to: "IN_STOCK", event: "FOUND" },
  WRITE_OFF: { from: ["MISSING_IN_TRANSIT"], to: "WRITTEN_OFF", event: "WRITTEN_OFF" },
  ISSUE: { from: ["IN_STOCK"], to: "ISSUED", event: "ISSUED" },
  RETURN_USED: { from: ["ISSUED"], to: "RETURNED", event: "RETURNED" },
  RETURN_UNUSED: { from: ["ISSUED"], to: "IN_STOCK", event: "RETURNED_UNUSED" },
  VOID: { from: ["IN_STOCK", "ISSUED", "MISSING_IN_TRANSIT"], to: "VOIDED", event: "VOIDED" },
};

export const TERMINAL_STATES: readonly UnitState[] = ["RETURNED", "VOIDED", "WRITTEN_OFF"];

export function isTerminal(state: UnitState): boolean {
  return TERMINAL_STATES.includes(state);
}

export function canTransition(from: UnitState, action: UnitAction): boolean {
  return RULES[action].from.includes(from);
}

/** Returns the resulting state and the ledger event type, or throws InvalidTransitionError. */
export function transition(
  from: UnitState,
  action: UnitAction,
): { to: UnitState; event: EventType } {
  const rule = RULES[action];
  if (!rule.from.includes(from)) {
    throw new InvalidTransitionError(from, action);
  }
  return { to: rule.to, event: rule.event };
}

export function allowedActions(from: UnitState): UnitAction[] {
  return (Object.keys(RULES) as UnitAction[]).filter((action) => canTransition(from, action));
}
