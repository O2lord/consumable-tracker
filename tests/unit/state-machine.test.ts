import { describe, expect, it } from "vitest";
import { InvalidTransitionError } from "../../server/domain/errors";
import {
  allowedActions,
  canTransition,
  isTerminal,
  transition,
} from "../../server/domain/state-machine";
import { UNIT_ACTIONS, UNIT_STATES } from "../../server/domain/types";

describe("state machine: legal moves (architecture section 4)", () => {
  it.each([
    ["IN_STOCK", "DISPATCH", "IN_TRANSIT", "DISPATCHED"],
    ["IN_TRANSIT", "RECEIVE", "IN_STOCK", "RECEIVED"],
    ["IN_TRANSIT", "MARK_MISSING", "MISSING_IN_TRANSIT", "MISSING_IN_TRANSIT"],
    ["MISSING_IN_TRANSIT", "RESOLVE_FOUND", "IN_STOCK", "FOUND"],
    ["MISSING_IN_TRANSIT", "WRITE_OFF", "WRITTEN_OFF", "WRITTEN_OFF"],
    ["IN_STOCK", "ISSUE", "ISSUED", "ISSUED"],
    ["ISSUED", "RETURN_USED", "RETURNED", "RETURNED"],
    ["ISSUED", "RETURN_UNUSED", "IN_STOCK", "RETURNED_UNUSED"],
    ["IN_STOCK", "VOID", "VOIDED", "VOIDED"],
    ["ISSUED", "VOID", "VOIDED", "VOIDED"],
    ["MISSING_IN_TRANSIT", "VOID", "VOIDED", "VOIDED"],
  ] as const)("%s + %s -> %s (event %s)", (from, action, to, event) => {
    expect(transition(from, action)).toEqual({ to, event });
  });
});

describe("state machine: illegal moves", () => {
  it("rejects dispatching something that is not in stock", () => {
    expect(() => transition("ISSUED", "DISPATCH")).toThrow(InvalidTransitionError);
    expect(() => transition("IN_TRANSIT", "DISPATCH")).toThrow(InvalidTransitionError);
  });

  it("rejects issuing something that is in transit or already issued", () => {
    expect(() => transition("IN_TRANSIT", "ISSUE")).toThrow(InvalidTransitionError);
    expect(() => transition("ISSUED", "ISSUE")).toThrow(InvalidTransitionError);
  });

  it("rejects returning something that was never issued", () => {
    expect(() => transition("IN_STOCK", "RETURN_USED")).toThrow(InvalidTransitionError);
    expect(() => transition("IN_STOCK", "RETURN_UNUSED")).toThrow(InvalidTransitionError);
  });

  it("carries the offending state and action on the error", () => {
    try {
      transition("RETURNED", "ISSUE");
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(InvalidTransitionError);
      expect((e as InvalidTransitionError).from).toBe("RETURNED");
      expect((e as InvalidTransitionError).action).toBe("ISSUE");
      expect((e as InvalidTransitionError).code).toBe("INVALID_TRANSITION");
    }
  });
});

describe("state machine: terminal states", () => {
  it.each(["RETURNED", "VOIDED", "WRITTEN_OFF"] as const)("%s allows no action", (state) => {
    expect(isTerminal(state)).toBe(true);
    expect(allowedActions(state)).toEqual([]);
    for (const action of UNIT_ACTIONS) {
      expect(canTransition(state, action)).toBe(false);
    }
  });

  it("non-terminal states each allow at least one action", () => {
    for (const state of UNIT_STATES.filter((s) => !isTerminal(s))) {
      expect(allowedActions(state).length).toBeGreaterThan(0);
    }
  });
});
