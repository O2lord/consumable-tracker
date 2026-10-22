import { describe, expect, it } from "vitest";
import {
  ExpiredStockError,
  InvalidTransitionError,
  PermissionDeniedError,
  TransferStatusError,
  ValidationError,
  WrongLocationError,
  WrongTransferError,
} from "../../server/domain/errors";
import {
  assertCanDispatchQuantity,
  assertCanDispatchUnit,
  assertCanReceiveAt,
  assertCanResolve,
  assertCountPlausible,
  assertServiceRoleAllowed,
  assertStatus,
  assertUnitOnTransfer,
  isExpired,
  isScanLine,
  itemResolution,
  receiptOutcome,
  statusAfterClose,
  type UnitFacts,
} from "../../server/domain/rules";

const STORE = "store-1";
const TODAY = "2026-10-07";

const unit = (over: Partial<UnitFacts> = {}): UnitFacts => ({
  serial: "CT00000000X",
  state: "IN_STOCK",
  locationId: STORE,
  transferId: null,
  expiryDate: "2027-01-01",
  ...over,
});

describe("isExpired", () => {
  it("treats the expiry day itself as still usable", () => {
    expect(isExpired("2026-10-07", TODAY)).toBe(false);
    expect(isExpired("2026-10-06", TODAY)).toBe(true);
  });
  it("never expires when there is no date", () => {
    expect(isExpired(null, TODAY)).toBe(false);
    expect(isExpired(undefined, TODAY)).toBe(false);
  });
});

describe("dispatching a unit", () => {
  it("accepts an in-stock, unexpired unit at the sending store", () => {
    expect(() => assertCanDispatchUnit(unit(), STORE, TODAY)).not.toThrow();
  });
  it("rejects a unit that is already in transit with a clear message", () => {
    expect(() => assertCanDispatchUnit(unit({ state: "IN_TRANSIT" }), STORE, TODAY)).toThrow(/already in transit/);
  });
  it.each(["ISSUED", "VOIDED", "WRITTEN_OFF", "MISSING_IN_TRANSIT"] as const)("rejects a %s unit", (state) => {
    expect(() => assertCanDispatchUnit(unit({ state }), STORE, TODAY)).toThrow(InvalidTransitionError);
  });
  it("rejects a unit at another location", () => {
    expect(() => assertCanDispatchUnit(unit({ locationId: "ward-9" }), STORE, TODAY)).toThrow(WrongLocationError);
  });
  it("rejects an expired unit", () => {
    expect(() => assertCanDispatchUnit(unit({ expiryDate: "2026-01-01" }), STORE, TODAY)).toThrow(ExpiredStockError);
  });
});

describe("dispatching a quantity", () => {
  const ok = { quantity: 10, available: 10, expiryDate: null, today: TODAY };
  it("accepts up to what is available", () => {
    expect(() => assertCanDispatchQuantity(ok)).not.toThrow();
  });
  it("rejects more than is available, saying how many are", () => {
    expect(() => assertCanDispatchQuantity({ ...ok, quantity: 11 })).toThrow(/Only 10 of this batch/);
  });
  it("never reports a negative availability", () => {
    expect(() => assertCanDispatchQuantity({ ...ok, available: -3 })).toThrow(/Only 0 of this batch/);
  });
  it.each([0, -1, 1.5, Number.NaN])("rejects %s", (quantity) => {
    expect(() => assertCanDispatchQuantity({ ...ok, quantity })).toThrow(ValidationError);
  });
  it("rejects an expired batch", () => {
    expect(() => assertCanDispatchQuantity({ ...ok, expiryDate: "2020-01-01" })).toThrow(ExpiredStockError);
  });
});

describe("receiving", () => {
  it("only accepts a unit that is on this transfer", () => {
    expect(() => assertUnitOnTransfer("t-1", "t-1", "CT1")).not.toThrow();
    expect(() => assertUnitOnTransfer("t-2", "t-1", "CT1")).toThrow(WrongTransferError);
    expect(() => assertUnitOnTransfer(null, "t-1", "CT1")).toThrow(WrongTransferError);
  });
  it("lets staff receive only at their own location, and supervisors anywhere", () => {
    expect(() => assertCanReceiveAt({ role: "DISTRIBUTOR", homeLocationId: "lab" }, "lab")).not.toThrow();
    expect(() => assertCanReceiveAt({ role: "DISTRIBUTOR", homeLocationId: "ward" }, "lab")).toThrow(PermissionDeniedError);
    expect(() => assertCanReceiveAt({ role: "DISTRIBUTOR", homeLocationId: null }, "lab")).toThrow(PermissionDeniedError);
    expect(() => assertCanReceiveAt({ role: "SUPERVISOR", homeLocationId: null }, "lab")).not.toThrow();
  });
});

describe("transfer status", () => {
  it("allows listed statuses and explains the others in plain words", () => {
    expect(() => assertStatus("DRAFT", ["DRAFT"], "confirm")).not.toThrow();
    expect(() => assertStatus("RECEIVED_WITH_DISCREPANCY", ["DRAFT"], "confirm")).toThrow(
      /Cannot confirm: this transfer is received with discrepancy/,
    );
    expect(() => assertStatus("CANCELLED", ["DRAFT"], "confirm")).toThrow(TransferStatusError);
  });
});

describe("blind count plausibility", () => {
  it("accepts anything from zero up to what was sent", () => {
    expect(() => assertCountPlausible(0, 10)).not.toThrow();
    expect(() => assertCountPlausible(10, 10)).not.toThrow();
  });
  it("bounces a count above what was sent without saying by how much", () => {
    let message = "";
    try {
      assertCountPlausible(12, 10);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/higher than what was sent/);
    expect(message).not.toMatch(/10/);
  });
  it.each([-1, 1.5, Number.NaN])("rejects %s", (n) => {
    expect(() => assertCountPlausible(n, 10)).toThrow(ValidationError);
  });
});

describe("isScanLine", () => {
  it("is a whole-pack line whose every pack was scanned when it was sent", () => {
    expect(isScanLine({ inPieces: false, linkedPacks: 5, dispatched: 5 })).toBe(true);
  });
  it("is not a line that was sent as loose pieces", () => {
    expect(isScanLine({ inPieces: true, linkedPacks: 0, dispatched: 40 })).toBe(false);
    expect(isScanLine({ inPieces: true, linkedPacks: 1, dispatched: 1 })).toBe(false);
  });
  it("is not a line with some packs typed instead of scanned, or none scanned", () => {
    expect(isScanLine({ inPieces: false, linkedPacks: 3, dispatched: 5 })).toBe(false);
    expect(isScanLine({ inPieces: false, linkedPacks: 0, dispatched: 5 })).toBe(false);
  });
});

describe("receiptOutcome", () => {
  it("names the exact missing serials and the shortfalls", () => {
    const outcome = receiptOutcome([
      { kind: "SERIAL", ref: "CTA", dispatched: 1, received: 1 },
      { kind: "SERIAL", ref: "CTB", dispatched: 1, received: null },
      { kind: "SERIAL", ref: "CTC", dispatched: 1, received: null },
      { kind: "QUANTITY", ref: "BT1", dispatched: 100, received: 94 },
      { kind: "QUANTITY", ref: "BT2", dispatched: 20, received: 20 },
    ]);
    expect(outcome.missingSerials).toEqual(["CTB", "CTC"]);
    expect(outcome.shortfalls).toEqual([{ ref: "BT1", missing: 6 }]);
    expect(outcome.uncounted).toEqual([]);
    expect(outcome.hasDiscrepancy).toBe(true);
    expect(statusAfterClose(outcome)).toBe("RECEIVED_WITH_DISCREPANCY");
  });
  it("is clean when everything is accounted for", () => {
    const outcome = receiptOutcome([
      { kind: "SERIAL", ref: "CTA", dispatched: 1, received: 1 },
      { kind: "QUANTITY", ref: "BT1", dispatched: 5, received: 5 },
    ]);
    expect(outcome.hasDiscrepancy).toBe(false);
    expect(statusAfterClose(outcome)).toBe("RECEIVED");
  });
  it("lists uncounted batches, and a zero count is a count", () => {
    const outcome = receiptOutcome([
      { kind: "QUANTITY", ref: "BT1", dispatched: 5, received: null },
      { kind: "QUANTITY", ref: "BT2", dispatched: 5, received: 0 },
    ]);
    expect(outcome.uncounted).toEqual(["BT1"]);
    expect(outcome.shortfalls).toEqual([{ ref: "BT2", missing: 5 }]);
  });
});

describe("resolving a discrepancy", () => {
  it("requires a reason", () => {
    expect(() => assertCanResolve({ quantity: 1, outstanding: 1, note: undefined })).toThrow(/reason is required/);
    expect(() => assertCanResolve({ quantity: 1, outstanding: 1, note: "  " })).toThrow(/reason is required/);
  });
  it("cannot resolve more than is outstanding", () => {
    expect(() => assertCanResolve({ quantity: 7, outstanding: 6, note: "recount" })).toThrow(/Only 6 is still unresolved/);
  });
  it("returns the trimmed reason", () => {
    expect(assertCanResolve({ quantity: 6, outstanding: 6, note: " found in ward " })).toBe("found in ward");
  });
  it("classifies the item once all of the missing amount is dealt with", () => {
    expect(itemResolution(0, 0, 6)).toBeNull();
    expect(itemResolution(3, 0, 6)).toBeNull();
    expect(itemResolution(6, 0, 6)).toBe("FOUND");
    expect(itemResolution(0, 6, 6)).toBe("WRITTEN_OFF");
    expect(itemResolution(4, 2, 6)).toBe("SPLIT");
  });
});

describe("service roles (corrections C2)", () => {
  const antiA = { name: "Anti-A", allowedServiceRoles: ["BENCH", "BLOOD_BANK"] };

  it("refuses a restricted item going to a role it is not allowed at, naming all three facts", () => {
    expect(() => assertServiceRoleAllowed(antiA, { name: "MMW", serviceRole: "COLLECTION_POINT" })).toThrow(
      "Anti-A can't be sent to MMW. It can go to: BENCH, BLOOD_BANK",
    );
    expect(() => assertServiceRoleAllowed(antiA, { name: "MMW", serviceRole: "COLLECTION_POINT" })).toThrow(
      ValidationError,
    );
  });
  it("allows a restricted item at a role in its list", () => {
    expect(() => assertServiceRoleAllowed(antiA, { name: "Haematology", serviceRole: "BENCH" })).not.toThrow();
    expect(() => assertServiceRoleAllowed(antiA, { name: "Blood bank", serviceRole: "BLOOD_BANK" })).not.toThrow();
  });
  it("always allows a store as the destination, so reagents can pass through Main lab reception", () => {
    expect(() => assertServiceRoleAllowed(antiA, { name: "Main lab reception", serviceRole: "STORE" })).not.toThrow();
  });
  it("still refuses a restricted item at a ward even though stores are allowed", () => {
    expect(() => assertServiceRoleAllowed(antiA, { name: "FMW", serviceRole: "COLLECTION_POINT" })).toThrow(/can't be sent to FMW/);
  });
  it("does not restrict an item with no allowed roles, anywhere", () => {
    const gloves = { name: "Latex gloves", allowedServiceRoles: null };
    expect(() => assertServiceRoleAllowed(gloves, { name: "MMW", serviceRole: "COLLECTION_POINT" })).not.toThrow();
    expect(() => assertServiceRoleAllowed(gloves, { name: "Chem Path", serviceRole: "BENCH" })).not.toThrow();
  });
  it("does not restrict a destination with no service role (rows from before roles existed)", () => {
    expect(() => assertServiceRoleAllowed(antiA, { name: "Old store", serviceRole: null })).not.toThrow();
  });
});
