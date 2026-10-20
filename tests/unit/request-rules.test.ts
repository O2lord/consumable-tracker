import { describe, expect, it } from "vitest";
import { RequestStatusError, ValidationError } from "../../server/domain/errors";
import {
  assertApprovalValid,
  assertAvailableForRequest,
  assertCanCloseLine,
  assertRequestStatus,
  assertWithinRequestBalance,
  deriveRequestStatus,
  openBalance,
  type LineFacts,
} from "../../server/domain/request-rules";

const CODE = "RQ-TEST";
const CLOSED_AT = new Date("2026-10-07T10:00:00Z");

const line = (over: Partial<LineFacts> = {}): LineFacts => ({
  quantityApproved: 10,
  quantityDispatched: 0,
  quantityReceived: 0,
  closedAt: null,
  ...over,
});

describe("pieces on a request", () => {
  it("refuses packs on a line that was requested in pieces, and pieces on a line requested in packs", () => {
    const pieces = line({ inPieces: true, quantityApproved: 10 });
    expect(() =>
      assertWithinRequestBalance({ requestCode: CODE, itemName: "Swab", line: pieces, adding: 2, addingInPieces: false }),
    ).toThrow(/requested in pieces/);
    expect(() =>
      assertWithinRequestBalance({ requestCode: CODE, itemName: "Swab", line: line(), adding: 2, addingInPieces: true }),
    ).toThrow(/requested in packs/);
  });

  it("allows pieces up to the open balance and names the unit when it is exceeded", () => {
    const pieces = line({ inPieces: true, quantityApproved: 20, quantityDispatched: 5 });
    expect(() =>
      assertWithinRequestBalance({ requestCode: CODE, itemName: "Swab", line: pieces, adding: 15, addingInPieces: true }),
    ).not.toThrow();
    expect(() =>
      assertWithinRequestBalance({ requestCode: CODE, itemName: "Swab", line: pieces, adding: 16, addingInPieces: true }),
    ).toThrow(/only 15 pieces of Swab left to send, but this transfer has 16 pieces/);
  });

  it("names the unit in the stock check message only for pieces", () => {
    expect(() => assertAvailableForRequest({ itemName: "Swab", requested: 30, available: 20, unitWord: "pieces" })).toThrow(
      /20 pieces available, but 30 pieces was requested/,
    );
    expect(() => assertAvailableForRequest({ itemName: "Swab", requested: 30, available: 20 })).toThrow(
      /20 available, but 30 was requested/,
    );
  });
});

describe("assertRequestStatus", () => {
  it("passes when the status is allowed", () => {
    expect(() => assertRequestStatus("DRAFT", ["DRAFT", "SUBMITTED"], "cancel")).not.toThrow();
  });

  it("says what was attempted and what the request is", () => {
    expect(() => assertRequestStatus("PARTIALLY_FULFILLED", ["SUBMITTED"], "approve")).toThrow(RequestStatusError);
    expect(() => assertRequestStatus("PARTIALLY_FULFILLED", ["SUBMITTED"], "approve")).toThrow(
      "Cannot approve: this request is partially fulfilled",
    );
  });
});

describe("openBalance", () => {
  it("is approved minus dispatched", () => {
    expect(openBalance(line({ quantityApproved: 10, quantityDispatched: 4 }))).toBe(6);
  });

  it("is zero for a line that was never approved, declined, or fully dispatched", () => {
    expect(openBalance(line({ quantityApproved: null }))).toBe(0);
    expect(openBalance(line({ quantityApproved: 0 }))).toBe(0);
    expect(openBalance(line({ quantityApproved: 10, quantityDispatched: 10 }))).toBe(0);
  });

  it("is zero once the line is closed, whatever was left", () => {
    expect(openBalance(line({ quantityApproved: 10, quantityDispatched: 3, closedAt: CLOSED_AT }))).toBe(0);
  });

  it("never goes negative", () => {
    expect(openBalance(line({ quantityApproved: 5, quantityDispatched: 8 }))).toBe(0);
  });
});

describe("assertWithinRequestBalance (dispatch cap)", () => {
  const check = (l: ReturnType<typeof line> | undefined, adding: number) =>
    assertWithinRequestBalance({ requestCode: CODE, itemName: "Gloves", line: l, adding });

  it("allows up to the open balance, including exactly the balance", () => {
    expect(() => check(line({ quantityApproved: 10, quantityDispatched: 4 }), 6)).not.toThrow();
    expect(() => check(line({ quantityApproved: 10 }), 1)).not.toThrow();
  });

  it("blocks more than the open balance and says how much is left", () => {
    expect(() => check(line({ quantityApproved: 10, quantityDispatched: 4 }), 7)).toThrow(
      "Request RQ-TEST has only 6 of Gloves left to send, but this transfer has 7",
    );
  });

  it("measures against dispatched, not received, so a balance in transit cannot go out twice", () => {
    // 10 approved, 10 dispatched on a transfer still in transit, 0 received yet.
    const inTransit = line({ quantityApproved: 10, quantityDispatched: 10, quantityReceived: 0 });
    expect(() => check(inTransit, 10)).toThrow(ValidationError);
    expect(() => check(inTransit, 1)).toThrow("only 0 of Gloves");
  });

  it("blocks an item that is not on the request, was declined, or was never approved", () => {
    expect(() => check(undefined, 1)).toThrow("was not approved on request RQ-TEST");
    expect(() => check(line({ quantityApproved: 0 }), 1)).toThrow("was not approved");
    expect(() => check(line({ quantityApproved: null }), 1)).toThrow("was not approved");
  });

  it("blocks a line the store closed", () => {
    expect(() => check(line({ quantityApproved: 10, quantityDispatched: 2, closedAt: CLOSED_AT }), 1)).toThrow(
      "was closed on request RQ-TEST",
    );
  });
});

describe("assertAvailableForRequest (submit-time check)", () => {
  it("allows asking for up to what is available", () => {
    expect(() => assertAvailableForRequest({ itemName: "Gloves", requested: 5, available: 5 })).not.toThrow();
  });

  it("blocks asking for more and names both numbers", () => {
    expect(() => assertAvailableForRequest({ itemName: "Gloves", requested: 8, available: 5 })).toThrow(
      "Gloves: the store has 5 available, but 8 was requested",
    );
  });

  it("reports a negative availability as zero", () => {
    expect(() => assertAvailableForRequest({ itemName: "Gloves", requested: 1, available: -3 })).toThrow(
      "the store has 0 available",
    );
  });
});

describe("assertApprovalValid", () => {
  const a = (quantityRequested: number, quantityApproved: number, itemName = "Gloves") => ({
    lineId: itemName,
    itemName,
    quantityRequested,
    quantityApproved,
  });

  it("accepts approving all, less than requested, or declining some lines", () => {
    expect(() => assertApprovalValid([a(10, 10)])).not.toThrow();
    expect(() => assertApprovalValid([a(10, 4)])).not.toThrow();
    expect(() => assertApprovalValid([a(10, 0, "Gloves"), a(5, 5, "Masks")])).not.toThrow();
  });

  it("blocks approving more than was requested", () => {
    expect(() => assertApprovalValid([a(10, 11)])).toThrow("cannot approve more than the 10 that was requested");
  });

  it("blocks negative or fractional quantities", () => {
    expect(() => assertApprovalValid([a(10, -1)])).toThrow("whole number");
    expect(() => assertApprovalValid([a(10, 2.5)])).toThrow("whole number");
  });

  it("blocks approving nothing at all and points to rejecting instead", () => {
    expect(() => assertApprovalValid([a(10, 0, "Gloves"), a(5, 0, "Masks")])).toThrow(
      "Approve at least one item, or reject the request",
    );
  });
});

describe("assertCanCloseLine", () => {
  it("returns the trimmed reason for a line with something left", () => {
    expect(assertCanCloseLine(line({ quantityDispatched: 4 }), "  Out of stock  ")).toBe("Out of stock");
  });

  it("needs a real reason", () => {
    expect(() => assertCanCloseLine(line(), undefined)).toThrow("A reason is required");
    expect(() => assertCanCloseLine(line(), "  ")).toThrow("A reason is required");
    expect(() => assertCanCloseLine(line(), "no")).toThrow("A reason is required");
  });

  it("refuses a line that is already closed or has nothing left to send", () => {
    expect(() => assertCanCloseLine(line({ closedAt: CLOSED_AT }), "Out of stock")).toThrow("already closed");
    expect(() => assertCanCloseLine(line({ quantityDispatched: 10 }), "Out of stock")).toThrow("Nothing is left");
  });
});

describe("deriveRequestStatus", () => {
  const derive = (lines: LineFacts[], hasTransferInFlight = false) =>
    deriveRequestStatus(lines, { hasTransferInFlight });

  it("is APPROVED while nothing has been dispatched", () => {
    expect(derive([line(), line()])).toBe("APPROVED");
  });

  it("is PARTIALLY_FULFILLED once something is dispatched and something is still open", () => {
    expect(derive([line({ quantityDispatched: 4 })])).toBe("PARTIALLY_FULFILLED");
    expect(derive([line({ quantityDispatched: 10 }), line()])).toBe("PARTIALLY_FULFILLED");
  });

  it("is FULFILLED when every approved line is fully dispatched and nothing is in transit", () => {
    expect(derive([line({ quantityDispatched: 10 }), line({ quantityDispatched: 10 })])).toBe("FULFILLED");
  });

  it("stays PARTIALLY_FULFILLED while a transfer is still in flight, even if everything is dispatched", () => {
    expect(derive([line({ quantityDispatched: 10 })], true)).toBe("PARTIALLY_FULFILLED");
  });

  it("is CLOSED when every line is settled but at least one was closed short", () => {
    expect(
      derive([line({ quantityDispatched: 10 }), line({ quantityDispatched: 3, closedAt: CLOSED_AT })]),
    ).toBe("CLOSED");
  });

  it("stays open when one line was closed short but another still has a balance", () => {
    expect(
      derive([line({ quantityDispatched: 3, closedAt: CLOSED_AT }), line({ quantityDispatched: 2 })]),
    ).toBe("PARTIALLY_FULFILLED");
  });

  it("ignores lines the store declined", () => {
    expect(derive([line({ quantityApproved: 0 }), line({ quantityDispatched: 10 })])).toBe("FULFILLED");
  });

  it("is CLOSED when no line was approved at all", () => {
    expect(derive([line({ quantityApproved: 0 }), line({ quantityApproved: null })])).toBe("CLOSED");
  });
});
