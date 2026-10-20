import { describe, expect, it } from "vitest";
import {
  dayLabel,
  fillDays,
  lastDays,
  levelTone,
  parseRange,
  percentOf,
  stockLevelPercent,
} from "@/lib/dashboard";

describe("parseRange", () => {
  it("accepts the supported ranges", () => {
    expect(parseRange("7")).toBe(7);
    expect(parseRange("14")).toBe(14);
    expect(parseRange("30")).toBe(30);
  });
  it("falls back to 7 for anything else", () => {
    expect(parseRange(undefined)).toBe(7);
    expect(parseRange("90")).toBe(7);
    expect(parseRange("abc")).toBe(7);
    expect(parseRange(["30", "7"])).toBe(30);
  });
});

describe("percentOf", () => {
  it("rounds to a whole percent", () => {
    expect(percentOf(1, 3)).toBe(33);
    expect(percentOf(7, 12)).toBe(58);
  });
  it("returns null when there is nothing to measure", () => {
    expect(percentOf(0, 0)).toBeNull();
    expect(percentOf(3, -1)).toBeNull();
  });
  it("stays within 0 to 100", () => {
    expect(percentOf(9, 3)).toBe(100);
    expect(percentOf(-2, 3)).toBe(0);
  });
});

describe("stock level", () => {
  it("puts the reorder level at 50%", () => {
    expect(stockLevelPercent(20, 20)).toBe(50);
    expect(stockLevelPercent(10, 20)).toBe(25);
    expect(stockLevelPercent(40, 20)).toBe(100);
    expect(stockLevelPercent(500, 20)).toBe(100);
    expect(stockLevelPercent(0, 20)).toBe(0);
  });
  it("has no level without a reorder level", () => {
    expect(stockLevelPercent(10, 0)).toBeNull();
  });
  it("flags items below the reorder level as bad", () => {
    expect(levelTone(49)).toBe("bad");
    expect(levelTone(50)).toBe("warn");
    expect(levelTone(74)).toBe("warn");
    expect(levelTone(75)).toBe("ok");
  });
});

describe("days", () => {
  it("lists the last N days oldest first, ending today", () => {
    expect(lastDays(3, new Date("2026-10-07T15:00:00Z"))).toEqual(["2026-10-05", "2026-10-06", "2026-10-07"]);
  });
  it("crosses month boundaries", () => {
    expect(lastDays(3, new Date("2026-11-01T00:00:00Z"))).toEqual(["2026-10-30", "2026-10-31", "2026-11-01"]);
  });
  it("fills missing days with zeros", () => {
    const days = ["2026-10-05", "2026-10-06"];
    expect(fillDays(days, [{ day: "2026-10-06", issued: 4, returned: 2 }])).toEqual([
      { day: "2026-10-05", issued: 0, returned: 0 },
      { day: "2026-10-06", issued: 4, returned: 2 },
    ]);
  });
  it("labels weekdays for a week and dates for longer ranges", () => {
    expect(dayLabel("2026-10-07", 7)).toBe("Wed");
    expect(dayLabel("2026-10-07", 30)).toBe("7/10");
  });
});
