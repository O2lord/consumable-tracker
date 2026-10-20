import { describe, expect, it } from "vitest";
import {
  describeHolding,
  describeRequestQuantity,
  holdingAfterDrafts,
  isPackUnit,
  pieceEquivalent,
  planPieceDispatch,
  toRequestQuantity,
  totalPieces,
} from "../../lib/pack-size";

describe("planPieceDispatch", () => {
  it("opens one pack when the store has 10 sealed packs of 100 and 20 pieces are asked for", () => {
    const plan = planPieceDispatch({ sealed: 10, loose: 0, packSize: 100, pieces: 20 });
    expect(plan).toEqual({ opened: 1, sealedAfter: 9, looseAfter: 80 });
  });

  it("uses the open pack first and opens nothing while it covers the request", () => {
    const plan = planPieceDispatch({ sealed: 9, loose: 80, packSize: 100, pieces: 30 });
    expect(plan).toEqual({ opened: 0, sealedAfter: 9, looseAfter: 50 });
  });

  it("opens another pack only when the loose pieces run out, and keeps what is left of it", () => {
    const plan = planPieceDispatch({ sealed: 9, loose: 50, packSize: 100, pieces: 70 });
    expect(plan).toEqual({ opened: 1, sealedAfter: 8, looseAfter: 80 });
  });

  it("can open several packs for a large request", () => {
    const plan = planPieceDispatch({ sealed: 5, loose: 10, packSize: 100, pieces: 250 });
    expect(plan).toEqual({ opened: 3, sealedAfter: 2, looseAfter: 60 });
  });

  it("opens a pack and leaves nothing loose when the pieces asked for equal exactly one pack", () => {
    const plan = planPieceDispatch({ sealed: 2, loose: 0, packSize: 100, pieces: 100 });
    expect(plan).toEqual({ opened: 1, sealedAfter: 1, looseAfter: 0 });
  });

  it("never loses a piece: pieces out + pieces left = pieces held", () => {
    for (const [sealed, loose, pieces] of [
      [10, 0, 20],
      [9, 80, 30],
      [9, 50, 70],
      [5, 10, 250],
      [3, 99, 1],
    ] as const) {
      const plan = planPieceDispatch({ sealed, loose, packSize: 100, pieces });
      if ("error" in plan) throw new Error(plan.error);
      expect(pieces + totalPieces(plan.sealedAfter, plan.looseAfter, 100)).toBe(totalPieces(sealed, loose, 100));
    }
  });

  it("refuses more than the location holds, counting loose and sealed together", () => {
    const plan = planPieceDispatch({ sealed: 1, loose: 20, packSize: 100, pieces: 121 });
    expect(plan).toEqual({ error: "Only 120 pieces are available (1 pack + 20 pieces)" });
  });

  it("refuses zero, fractions and items with no pack size", () => {
    expect("error" in planPieceDispatch({ sealed: 10, loose: 0, packSize: 100, pieces: 0 })).toBe(true);
    expect("error" in planPieceDispatch({ sealed: 10, loose: 0, packSize: 100, pieces: 2.5 })).toBe(true);
    expect("error" in planPieceDispatch({ sealed: 10, loose: 0, packSize: 1, pieces: 5 })).toBe(true);
  });
});

describe("describeHolding", () => {
  it("shows sealed packs and loose pieces together", () => {
    expect(describeHolding(9, 80)).toBe("9 packs + 80 pieces");
    expect(describeHolding(1, 1)).toBe("1 pack + 1 piece");
  });

  it("shows only what is there", () => {
    expect(describeHolding(0, 20)).toBe("20 pieces");
    expect(describeHolding(10, 0)).toBe("10 packs");
    expect(describeHolding(0, 0)).toBe("0 packs");
  });
});

describe("isPackUnit", () => {
  it("recognises pack in any case, singular or plural", () => {
    expect(isPackUnit("Pack")).toBe(true);
    expect(isPackUnit("packs")).toBe(true);
    expect(isPackUnit("  PACK ")).toBe(true);
  });

  it("is false for other units and for nothing", () => {
    expect(isPackUnit("Pieces")).toBe(false);
    expect(isPackUnit("Roll")).toBe(false);
    expect(isPackUnit("each")).toBe(false);
    expect(isPackUnit("")).toBe(false);
    expect(isPackUnit(null)).toBe(false);
    expect(isPackUnit(undefined)).toBe(false);
  });
});

describe("pieceEquivalent", () => {
  it("multiplies packs by the pack size", () => {
    expect(pieceEquivalent(40, "Pack", 100)).toBe(4000);
    expect(pieceEquivalent(0, "Pack", 100)).toBe(0);
  });

  it("changes only the equivalent when the pack size changes, never the quantity", () => {
    const packs = 40;
    expect(pieceEquivalent(packs, "Pack", 100)).toBe(4000);
    expect(pieceEquivalent(packs, "Pack", 50)).toBe(2000);
    expect(packs).toBe(40);
  });

  it("shows nothing for items that are not counted in packs", () => {
    expect(pieceEquivalent(40, "Pieces", 100)).toBeNull();
    expect(pieceEquivalent(5, "Roll", 1)).toBeNull();
  });

  it("shows nothing when a pack is a single piece or the size is not a whole number", () => {
    expect(pieceEquivalent(40, "Pack", 1)).toBeNull();
    expect(pieceEquivalent(40, "Pack", 0)).toBeNull();
    expect(pieceEquivalent(40, "Pack", 2.5)).toBeNull();
  });

  it("keeps the sign of a negative balance", () => {
    expect(pieceEquivalent(-3, "Pack", 100)).toBe(-300);
  });
});

describe("toRequestQuantity", () => {
  it("keeps 10 pieces of a pack of 100 as 10 pieces instead of refusing it", () => {
    expect(toRequestQuantity(10, "alt", "Pack", 100)).toEqual({ quantity: 10, inPieces: true });
  });

  it("saves pieces that make whole packs as packs, so the common case looks as before", () => {
    expect(toRequestQuantity(200, "alt", "Pack", 100)).toEqual({ quantity: 2, inPieces: false });
  });

  it("leaves a quantity typed in the item's own unit alone", () => {
    expect(toRequestQuantity(3, "stock", "Pack", 100)).toEqual({ quantity: 3, inPieces: false });
  });

  it("turns packs of a pieces item into pieces", () => {
    expect(toRequestQuantity(2, "alt", "Pieces", 100)).toEqual({ quantity: 200, inPieces: false });
  });

  it("refuses the other unit when the item has no pack size", () => {
    expect("error" in toRequestQuantity(10, "alt", "Pack", 1)).toBe(true);
  });
});

describe("describeRequestQuantity", () => {
  it("words pieces, packs and other units", () => {
    expect(describeRequestQuantity(10, "Pack", true)).toBe("10 pieces");
    expect(describeRequestQuantity(1, "Pack", true)).toBe("1 piece");
    expect(describeRequestQuantity(2, "Pack", false)).toBe("2 packs");
    expect(describeRequestQuantity(1, "Pack", false)).toBe("1 pack");
    expect(describeRequestQuantity(3, "Roll", false)).toBe("3 Roll");
  });
});

describe("holdingAfterDrafts", () => {
  it("changes nothing when no other draft has taken anything", () => {
    expect(holdingAfterDrafts({ sealed: 9, loose: 80, packSize: 100, reservedPacks: 0, reservedPieces: 0 })).toEqual({
      sealed: 9,
      loose: 80,
    });
  });

  it("takes whole packs off the sealed packs", () => {
    expect(holdingAfterDrafts({ sealed: 9, loose: 80, packSize: 100, reservedPacks: 2, reservedPieces: 0 })).toEqual({
      sealed: 7,
      loose: 80,
    });
  });

  it("takes another draft's pieces from the loose pieces first", () => {
    expect(holdingAfterDrafts({ sealed: 9, loose: 80, packSize: 100, reservedPacks: 0, reservedPieces: 30 })).toEqual({
      sealed: 9,
      loose: 50,
    });
  });

  it("opens a pack for another draft's pieces once the loose ones run out", () => {
    expect(holdingAfterDrafts({ sealed: 9, loose: 10, packSize: 100, reservedPacks: 0, reservedPieces: 30 })).toEqual({
      sealed: 8,
      loose: 80,
    });
  });

  it("never goes below zero when drafts have promised more than is held", () => {
    expect(holdingAfterDrafts({ sealed: 1, loose: 0, packSize: 100, reservedPacks: 0, reservedPieces: 500 })).toEqual({
      sealed: 0,
      loose: 0,
    });
    expect(holdingAfterDrafts({ sealed: 1, loose: 0, packSize: 100, reservedPacks: 3, reservedPieces: 0 })).toEqual({
      sealed: 0,
      loose: 0,
    });
  });
});
