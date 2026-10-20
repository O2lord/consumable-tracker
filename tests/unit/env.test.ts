import { describe, expect, it } from "vitest";
import { parseEnv } from "../../server/env-schema";

describe("parseEnv", () => {
  it("accepts a minimal environment and applies defaults", () => {
    const env = parseEnv({ DATABASE_URL: "postgresql://localhost/test" });
    expect(env.DATABASE_URL).toBe("postgresql://localhost/test");
    expect(env.OUTSTANDING_HOURS).toBe(24);
  });

  it("coerces OUTSTANDING_HOURS from a string", () => {
    const env = parseEnv({ DATABASE_URL: "x", OUTSTANDING_HOURS: "48" });
    expect(env.OUTSTANDING_HOURS).toBe(48);
  });

  it("rejects a missing DATABASE_URL", () => {
    expect(() => parseEnv({})).toThrow(/DATABASE_URL/);
  });

  it("rejects a non-positive OUTSTANDING_HOURS", () => {
    expect(() => parseEnv({ DATABASE_URL: "x", OUTSTANDING_HOURS: "0" })).toThrow();
  });
});
