import { describe, expect, it } from "vitest";
import {
  ALPHABET,
  generateBatchCode,
  generateCode,
  generateDeliveryCode,
  generateSerial,
  isValidBatchCode,
  isValidDeliveryCode,
  isValidSerial,
  normalizeCode,
  parseDeliveryCode,
  parseSerial,
} from "../../lib/serial";

describe("generateSerial", () => {
  it("produces an 11-character code with the CT prefix, using only the safe alphabet", () => {
    const serial = generateSerial();
    expect(serial).toHaveLength(11);
    expect(serial.startsWith("CT")).toBe(true);
    for (const ch of serial) expect(ALPHABET).toContain(ch);
  });

  it("is valid by its own check digit, many times over", () => {
    for (let i = 0; i < 2000; i++) expect(isValidSerial(generateSerial())).toBe(true);
  });

  it("does not collide across a large sample", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 20_000; i++) seen.add(generateSerial());
    expect(seen.size).toBe(20_000);
  });

  it("is deterministic for a given random source", () => {
    const fixed = () => Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(generateSerial(fixed)).toBe(generateSerial(fixed));
    expect(generateSerial(fixed).slice(0, 10)).toBe("CT12345678");
  });
});

describe("check digit", () => {
  it("rejects every single-character substitution in the body and check position", () => {
    const serial = generateSerial();
    for (let pos = 2; pos < serial.length; pos++) {
      for (const ch of ALPHABET) {
        if (ch === serial[pos]) continue;
        const bad = serial.slice(0, pos) + ch + serial.slice(pos + 1);
        expect(isValidSerial(bad), `${serial} -> ${bad}`).toBe(false);
      }
    }
  });

  it("rejects a wrong length, wrong prefix or foreign characters", () => {
    const serial = generateSerial();
    expect(isValidSerial(serial.slice(0, -1))).toBe(false);
    expect(isValidSerial(serial + "0")).toBe(false);
    expect(isValidSerial("XX" + serial.slice(2))).toBe(false);
    expect(isValidSerial("")).toBe(false);
    expect(isValidSerial("CT!@#$%^&*(")).toBe(false);
  });

  it("does not accept a batch code as a serial, or the reverse", () => {
    expect(isValidSerial(generateBatchCode())).toBe(false);
    expect(isValidBatchCode(generateSerial())).toBe(false);
    expect(isValidBatchCode(generateBatchCode())).toBe(true);
  });
});

describe("normalizeCode / parseSerial", () => {
  it("accepts lowercase, spaces and hyphens, returning the canonical form", () => {
    const serial = generateSerial();
    const messy = ` ${serial.slice(0, 4).toLowerCase()}-${serial.slice(4, 8)} ${serial.slice(8)} `;
    expect(parseSerial(messy)).toBe(serial);
  });

  it("maps look-alike characters the way Crockford base32 does", () => {
    expect(normalizeCode("o1il")).toBe("0111");
  });

  it("returns null for an invalid serial", () => {
    expect(parseSerial("CT00000000A")).toBe(null);
    expect(parseSerial("garbage")).toBe(null);
  });

  it("generateCode works with any alphabet-only prefix", () => {
    expect(generateCode("AB").startsWith("AB")).toBe(true);
  });
});

describe("delivery codes", () => {
  it("has the DV prefix and survives the normaliser (no L in the prefix)", () => {
    const code = generateDeliveryCode();
    expect(code).toHaveLength(11);
    expect(code.startsWith("DV")).toBe(true);
    expect(normalizeCode(code)).toBe(code);
    for (let i = 0; i < 500; i++) expect(isValidDeliveryCode(generateDeliveryCode())).toBe(true);
  });

  it("parses messy input to the canonical code and rejects other kinds of code", () => {
    const code = generateDeliveryCode();
    expect(parseDeliveryCode(` ${code.slice(0, 5).toLowerCase()}-${code.slice(5)} `)).toBe(code);
    expect(parseDeliveryCode(generateBatchCode())).toBe(null);
    expect(parseDeliveryCode(generateSerial())).toBe(null);
    expect(isValidSerial(code)).toBe(false);
    expect(isValidBatchCode(code)).toBe(false);
  });
});
