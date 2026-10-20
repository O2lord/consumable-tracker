import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  decryptField,
  encryptField,
  isEncrypted,
  mrnBlindIndex,
  mrnBlindIndexOrNull,
} from "../../server/security/field-crypto";

// Two fixed test keys (never real ones). Each is the base64 of 32 bytes.
const KEY_A = Buffer.alloc(32, 1).toString("base64");
const KEY_B = Buffer.alloc(32, 2).toString("base64");
const INDEX_A = Buffer.alloc(32, 3).toString("base64");
const INDEX_B = Buffer.alloc(32, 4).toString("base64");

const MRN = "UATH/PT/1234567";
const CONTEXT = "links.patient_hospital_no";

beforeEach(() => {
  vi.stubEnv("FIELD_ENCRYPTION_KEY", KEY_A);
  vi.stubEnv("FIELD_INDEX_KEY", INDEX_A);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("encryptField / decryptField", () => {
  it("round-trips a value", () => {
    const stored = encryptField(MRN, CONTEXT);
    expect(decryptField(stored, CONTEXT)).toBe(MRN);
  });

  it("stores something that does not contain the value, and is marked as ours", () => {
    const stored = encryptField(MRN, CONTEXT);
    expect(isEncrypted(stored)).toBe(true);
    expect(stored).not.toContain(MRN);
    expect(stored).not.toContain("1234567");
  });

  it("gives a different stored value every time, so equal MRNs cannot be spotted by comparing", () => {
    const a = encryptField(MRN, CONTEXT);
    const b = encryptField(MRN, CONTEXT);
    expect(a).not.toBe(b);
    expect(decryptField(a, CONTEXT)).toBe(MRN);
    expect(decryptField(b, CONTEXT)).toBe(MRN);
  });

  it("does not decrypt in a different column (the column name is authenticated)", () => {
    const stored = encryptField(MRN, "links.patient_hospital_no");
    expect(() => decryptField(stored, "investigation_imports.patient_hospital_no")).toThrow(/could not be decrypted/);
  });

  it("refuses a value that was changed", () => {
    const stored = encryptField(MRN, CONTEXT);
    // Change a character inside the IV (never the last one, whose low bits can be unused padding).
    const at = "enc:v1:".length + 5;
    const swapped = stored[at] === "A" ? "B" : "A";
    const tampered = stored.slice(0, at) + swapped + stored.slice(at + 1);
    expect(tampered).not.toBe(stored);
    expect(() => decryptField(tampered, CONTEXT)).toThrow(/could not be decrypted/);
  });

  it("refuses a value that was cut short", () => {
    expect(() => decryptField("enc:v1:AAAA", CONTEXT)).toThrow(/damaged/);
  });

  it("refuses to decrypt with the wrong key", () => {
    const stored = encryptField(MRN, CONTEXT);
    vi.stubEnv("FIELD_ENCRYPTION_KEY", KEY_B);
    expect(() => decryptField(stored, CONTEXT)).toThrow(/could not be decrypted/);
  });

  it("never puts the value or the key in an error message", () => {
    const stored = encryptField(MRN, CONTEXT);
    vi.stubEnv("FIELD_ENCRYPTION_KEY", KEY_B);
    try {
      decryptField(stored, CONTEXT);
      expect.unreachable("should have thrown");
    } catch (err) {
      const message = (err as Error).message;
      expect(message).not.toContain(MRN);
      expect(message).not.toContain(KEY_A);
      expect(message).not.toContain(KEY_B);
    }
  });

  it("returns old, unencrypted values as they are, so data from before encryption keeps working", () => {
    expect(isEncrypted(MRN)).toBe(false);
    expect(decryptField(MRN, CONTEXT)).toBe(MRN);
  });

  it("handles non-ASCII text", () => {
    const value = "Nkechi Okonkwo-Eze";
    expect(decryptField(encryptField(value, "x.y"), "x.y")).toBe(value);
  });
});

describe("mrnBlindIndex", () => {
  it("is the same for the same MRN every time", () => {
    expect(mrnBlindIndex(MRN)).toBe(mrnBlindIndex(MRN));
  });

  it("ignores case and spacing, like normalizeMrn", () => {
    expect(mrnBlindIndex(" uath/pt/1234567 ")).toBe(mrnBlindIndex(MRN));
    expect(mrnBlindIndex("UATH / PT / 1234567")).toBe(mrnBlindIndex(MRN));
  });

  it("differs for different MRNs", () => {
    expect(mrnBlindIndex("UATH/PT/1234568")).not.toBe(mrnBlindIndex(MRN));
  });

  it("is 64 hex characters and does not contain the MRN", () => {
    const index = mrnBlindIndex(MRN);
    expect(index).toMatch(/^[0-9a-f]{64}$/);
    expect(index).not.toContain("1234567");
  });

  it("depends on the secret key, so it cannot be recomputed from the MRN alone", () => {
    const first = mrnBlindIndex(MRN);
    vi.stubEnv("FIELD_INDEX_KEY", INDEX_B);
    expect(mrnBlindIndex(MRN)).not.toBe(first);
  });

  it("does not depend on the encryption key (the two secrets are separate)", () => {
    const first = mrnBlindIndex(MRN);
    vi.stubEnv("FIELD_ENCRYPTION_KEY", KEY_B);
    expect(mrnBlindIndex(MRN)).toBe(first);
  });

  it("gives null for a missing MRN", () => {
    expect(mrnBlindIndexOrNull(null)).toBeNull();
    expect(mrnBlindIndexOrNull(undefined)).toBeNull();
    expect(mrnBlindIndexOrNull("")).toBeNull();
    expect(mrnBlindIndexOrNull(MRN)).toBe(mrnBlindIndex(MRN));
  });
});

describe("keys", () => {
  it("rejects a key that is not 32 bytes", () => {
    vi.stubEnv("FIELD_ENCRYPTION_KEY", Buffer.alloc(16, 1).toString("base64"));
    expect(() => encryptField(MRN, CONTEXT)).toThrow(/exactly 32 bytes/);
  });

  it("in production, refuses to work without the keys instead of quietly storing unprotected values", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("FIELD_ENCRYPTION_KEY", "");
    vi.stubEnv("FIELD_INDEX_KEY", "");
    expect(() => encryptField(MRN, CONTEXT)).toThrow(/FIELD_ENCRYPTION_KEY is not set/);
    expect(() => mrnBlindIndex(MRN)).toThrow(/FIELD_INDEX_KEY is not set/);
  });

  it("outside production, falls back to a development key so local work runs without secrets", () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("FIELD_ENCRYPTION_KEY", "");
    vi.stubEnv("FIELD_INDEX_KEY", "");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(decryptField(encryptField(MRN, CONTEXT), CONTEXT)).toBe(MRN);
      expect(mrnBlindIndex(MRN)).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      warn.mockRestore();
    }
  });
});
