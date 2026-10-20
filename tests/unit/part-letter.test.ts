import { describe, expect, it } from "vitest";
import { partLetter, partName } from "@/lib/part-letter";

describe("partLetter", () => {
  it("runs A to Z for the first 26 parts", () => {
    expect(partLetter(1)).toBe("A");
    expect(partLetter(2)).toBe("B");
    expect(partLetter(3)).toBe("C");
    expect(partLetter(26)).toBe("Z");
  });

  it("continues AA, AB ... like spreadsheet columns", () => {
    expect(partLetter(27)).toBe("AA");
    expect(partLetter(28)).toBe("AB");
    expect(partLetter(52)).toBe("AZ");
    expect(partLetter(53)).toBe("BA");
    expect(partLetter(702)).toBe("ZZ");
    expect(partLetter(703)).toBe("AAA");
  });

  it("gives every number a different letter", () => {
    const seen = new Set<string>();
    for (let n = 1; n <= 800; n++) seen.add(partLetter(n));
    expect(seen.size).toBe(800);
  });

  it("rejects numbers that are not whole and positive", () => {
    expect(() => partLetter(0)).toThrow(RangeError);
    expect(() => partLetter(-1)).toThrow(RangeError);
    expect(() => partLetter(1.5)).toThrow(RangeError);
  });

  it("writes a part the way screens and slips show it", () => {
    expect(partName("BT7K2M9QXR4", "B")).toBe("BT7K2M9QXR4 part B");
  });
});
