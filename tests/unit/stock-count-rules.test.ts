import { describe, expect, it } from "vitest";
import { ValidationError } from "../../server/domain/errors";
import {
  assertVarianceExplained,
  countVariance,
  isBelowMinimum,
  optionalVariance,
  reasonsFor,
  shortfallToTarget,
} from "../../server/domain/stock-count-rules";
import { postCountSchema, saveParLevelsSchema, submitCountSchema } from "../../types/stock-counts";

const ID_A = "11111111-1111-4111-8111-111111111111";
const ID_B = "22222222-2222-4222-8222-222222222222";
const LOCATION = "33333333-3333-4333-8333-333333333333";

const line = (variance: number) => ({ itemName: "Latex gloves", batchCode: "B-001", variance });

describe("countVariance", () => {
  it("is counted minus expected", () => {
    expect(countVariance(8, 10)).toBe(-2);
    expect(countVariance(12, 10)).toBe(2);
    expect(countVariance(10, 10)).toBe(0);
  });
});

describe("optionalVariance", () => {
  it("is counted minus expected when counted", () => {
    expect(optionalVariance(13, 15)).toBe(-2);
    expect(optionalVariance(0, 15)).toBe(-15);
  });

  it("is zero when the figure was not counted", () => {
    expect(optionalVariance(null, 15)).toBe(0);
    expect(optionalVariance(undefined, 15)).toBe(0);
  });
});

describe("submitCountSchema with loose pieces", () => {
  it("accepts packs only, pieces only, or both", () => {
    for (const l of [
      { batchId: ID_A, counted: 3 },
      { batchId: ID_A, countedPieces: 15 },
      { batchId: ID_A, counted: 3, countedPieces: 15 },
      { batchId: ID_A, counted: null, countedPieces: 0 },
    ]) {
      expect(submitCountSchema.safeParse({ lines: [l] }).success).toBe(true);
    }
  });

  it("rejects a line with neither figure", () => {
    expect(submitCountSchema.safeParse({ lines: [{ batchId: ID_A }] }).success).toBe(false);
    expect(submitCountSchema.safeParse({ lines: [{ batchId: ID_A, counted: null, countedPieces: null }] }).success).toBe(false);
  });

  it("rejects negative or fractional pieces", () => {
    expect(submitCountSchema.safeParse({ lines: [{ batchId: ID_A, countedPieces: -1 }] }).success).toBe(false);
    expect(submitCountSchema.safeParse({ lines: [{ batchId: ID_A, countedPieces: 2.5 }] }).success).toBe(false);
  });
});

describe("postCountSchema with loose pieces", () => {
  it("accepts a separate reason for the pieces", () => {
    const r = postCountSchema.safeParse({
      lines: [{ lineId: ID_A, reasonCode: null, note: null, piecesReasonCode: "LOST_OR_MISSING", piecesNote: null }],
    });
    expect(r.success).toBe(true);
  });
});

describe("reasonsFor", () => {
  it("offers shortfall reasons for a negative variance", () => {
    expect(reasonsFor(-1)).toContain("USED_NOT_RECORDED");
    expect(reasonsFor(-1)).not.toContain("RECEIPT_COUNTED_SHORT");
  });

  it("offers surplus reasons for a positive variance", () => {
    expect(reasonsFor(3)).toContain("RETURNED_NOT_RECORDED");
    expect(reasonsFor(3)).not.toContain("USED_NOT_RECORDED");
  });

  it("offers nothing when the count matches", () => {
    expect(reasonsFor(0)).toEqual([]);
  });
});

describe("assertVarianceExplained", () => {
  it("needs no reason when the count matches", () => {
    expect(assertVarianceExplained(line(0), null, null)).toBeNull();
  });

  it("refuses a variance with no reason and says how far off it is", () => {
    expect(() => assertVarianceExplained(line(-4), null, null)).toThrow(ValidationError);
    expect(() => assertVarianceExplained(line(-4), null, null)).toThrow(/4 short/);
    expect(() => assertVarianceExplained(line(5), "", null)).toThrow(/5 over/);
  });

  it("refuses a reason from the wrong direction", () => {
    expect(() => assertVarianceExplained(line(-1), "RETURNED_NOT_RECORDED", null)).toThrow(ValidationError);
    expect(() => assertVarianceExplained(line(1), "USED_NOT_RECORDED", null)).toThrow(ValidationError);
  });

  it("refuses a reason that is not on the list", () => {
    expect(() => assertVarianceExplained(line(-1), "BECAUSE", null)).toThrow(ValidationError);
  });

  it("returns the reason when it fits the direction", () => {
    expect(assertVarianceExplained(line(-1), "LOST_OR_MISSING", null)).toBe("LOST_OR_MISSING");
    expect(assertVarianceExplained(line(2), "RECEIPT_COUNTED_SHORT", null)).toBe("RECEIPT_COUNTED_SHORT");
  });

  it("needs a note of a few characters for Other, in either direction", () => {
    expect(() => assertVarianceExplained(line(-1), "OTHER", null)).toThrow(/explain/);
    expect(() => assertVarianceExplained(line(1), "OTHER", "  ")).toThrow(/explain/);
    expect(() => assertVarianceExplained(line(1), "OTHER", "ab")).toThrow(/explain/);
    expect(assertVarianceExplained(line(-1), "OTHER", "Box left open in theatre")).toBe("OTHER");
  });

  it("names the item and batch in the message", () => {
    expect(() => assertVarianceExplained(line(-1), null, null)).toThrow(/Latex gloves \(B-001\)/);
  });
});

describe("isBelowMinimum", () => {
  it("is false when no minimum is set", () => {
    expect(isBelowMinimum(0, 0)).toBe(false);
  });

  it("is true at or below the minimum", () => {
    expect(isBelowMinimum(5, 5)).toBe(true);
    expect(isBelowMinimum(4, 5)).toBe(true);
  });

  it("is false above the minimum", () => {
    expect(isBelowMinimum(6, 5)).toBe(false);
  });
});

describe("shortfallToTarget", () => {
  it("is target minus what is held minus what is on the way", () => {
    expect(shortfallToTarget(100, 30, 20)).toBe(50);
  });

  it("never goes negative", () => {
    expect(shortfallToTarget(100, 90, 40)).toBe(0);
    expect(shortfallToTarget(100, 120, 0)).toBe(0);
  });

  it("asks for the whole target when there is nothing held or coming", () => {
    expect(shortfallToTarget(40, 0, 0)).toBe(40);
  });
});

describe("saveParLevelsSchema", () => {
  const row = (over: Record<string, unknown> = {}) => ({ itemTypeId: ID_A, target: 100, minimum: 20, ...over });

  it("accepts a target with a minimum below it", () => {
    expect(saveParLevelsSchema.safeParse({ locationId: LOCATION, rows: [row()] }).success).toBe(true);
  });

  it("accepts a minimum equal to the target", () => {
    expect(saveParLevelsSchema.safeParse({ locationId: LOCATION, rows: [row({ minimum: 100 })] }).success).toBe(true);
  });

  it("rejects a minimum above the target", () => {
    const r = saveParLevelsSchema.safeParse({ locationId: LOCATION, rows: [row({ minimum: 101 })] });
    expect(r.success).toBe(false);
  });

  it("accepts a null target, which removes the par level", () => {
    expect(saveParLevelsSchema.safeParse({ locationId: LOCATION, rows: [row({ target: null, minimum: 0 })] }).success).toBe(true);
  });

  it("rejects a zero target and fractional numbers", () => {
    expect(saveParLevelsSchema.safeParse({ locationId: LOCATION, rows: [row({ target: 0 })] }).success).toBe(false);
    expect(saveParLevelsSchema.safeParse({ locationId: LOCATION, rows: [row({ target: 2.5 })] }).success).toBe(false);
  });

  it("rejects the same item twice", () => {
    expect(saveParLevelsSchema.safeParse({ locationId: LOCATION, rows: [row(), row()] }).success).toBe(false);
  });
});

describe("submitCountSchema", () => {
  it("accepts counts including zero", () => {
    const r = submitCountSchema.safeParse({ lines: [{ batchId: ID_A, counted: 0 }, { batchId: ID_B, counted: 12 }] });
    expect(r.success).toBe(true);
  });

  it("needs at least one line", () => {
    expect(submitCountSchema.safeParse({ lines: [] }).success).toBe(false);
  });

  it("rejects negative and fractional counts", () => {
    expect(submitCountSchema.safeParse({ lines: [{ batchId: ID_A, counted: -1 }] }).success).toBe(false);
    expect(submitCountSchema.safeParse({ lines: [{ batchId: ID_A, counted: 1.5 }] }).success).toBe(false);
  });

  it("rejects the same batch twice", () => {
    const r = submitCountSchema.safeParse({ lines: [{ batchId: ID_A, counted: 1 }, { batchId: ID_A, counted: 2 }] });
    expect(r.success).toBe(false);
  });
});

describe("postCountSchema", () => {
  it("accepts a reason and note per line, or neither", () => {
    const r = postCountSchema.safeParse({
      lines: [
        { lineId: ID_A, reasonCode: "LOST_OR_MISSING", note: null },
        { lineId: ID_B },
      ],
    });
    expect(r.success).toBe(true);
  });
});
