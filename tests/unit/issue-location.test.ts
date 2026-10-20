import { describe, expect, it } from "vitest";
import { ValidationError } from "../../server/domain/errors";
import { assertReferenceAllowedAtLocation } from "../../server/domain/issue-rules";
import { departmentOnly, referenceAllowedAt } from "../../lib/issue-location";

describe("departmentOnly", () => {
  it("is true for a bench section and the blood bank", () => {
    expect(departmentOnly("BENCH")).toBe(true);
    expect(departmentOnly("BLOOD_BANK")).toBe(true);
  });

  it("is false for a collection point, a store, or no role", () => {
    expect(departmentOnly("COLLECTION_POINT")).toBe(false);
    expect(departmentOnly("STORE")).toBe(false);
    expect(departmentOnly(null)).toBe(false);
    expect(departmentOnly(undefined)).toBe(false);
  });
});

describe("referenceAllowedAt", () => {
  it("allows only a department at a bench or the blood bank", () => {
    expect(referenceAllowedAt("BENCH", "DEPARTMENT")).toBe(true);
    expect(referenceAllowedAt("BENCH", "INVESTIGATION")).toBe(false);
    expect(referenceAllowedAt("BLOOD_BANK", "ADMISSION")).toBe(false);
    expect(referenceAllowedAt("BLOOD_BANK", "DEPARTMENT")).toBe(true);
  });

  it("allows every reference at a collection point and where no role is set", () => {
    for (const type of ["INVESTIGATION", "ADMISSION", "VISIT", "PROCEDURE", "SURGERY", "DEPARTMENT"]) {
      expect(referenceAllowedAt("COLLECTION_POINT", type)).toBe(true);
      expect(referenceAllowedAt(null, type)).toBe(true);
    }
  });
});

describe("assertReferenceAllowedAtLocation", () => {
  const bench = { name: "Haematology", serviceRole: "BENCH" };
  const bank = { name: "Blood bank", serviceRole: "BLOOD_BANK" };
  const ward = { name: "MMW", serviceRole: "COLLECTION_POINT" };

  it("refuses a patient-linked issue at a bench and says to use a department", () => {
    expect(() => assertReferenceAllowedAtLocation(bench, ["INVESTIGATION"])).toThrow(ValidationError);
    expect(() => assertReferenceAllowedAtLocation(bench, ["INVESTIGATION"])).toThrow(/Haematology is a bench section/);
    expect(() => assertReferenceAllowedAtLocation(bench, ["INVESTIGATION"])).toThrow(/Department/);
  });

  it("names the blood bank as such", () => {
    expect(() => assertReferenceAllowedAtLocation(bank, ["ADMISSION"])).toThrow(/Blood bank is the blood bank/);
  });

  it("refuses the whole group when any reference is patient-linked", () => {
    expect(() => assertReferenceAllowedAtLocation(bench, ["DEPARTMENT", "INVESTIGATION"])).toThrow(ValidationError);
  });

  it("allows a department issue at a bench or the blood bank", () => {
    expect(() => assertReferenceAllowedAtLocation(bench, ["DEPARTMENT"])).not.toThrow();
    expect(() => assertReferenceAllowedAtLocation(bank, ["DEPARTMENT", "DEPARTMENT"])).not.toThrow();
  });

  it("allows any reference at a collection point, a store, or a location with no role", () => {
    expect(() => assertReferenceAllowedAtLocation(ward, ["INVESTIGATION", "DEPARTMENT"])).not.toThrow();
    expect(() => assertReferenceAllowedAtLocation({ name: "Main store", serviceRole: "STORE" }, ["SURGERY"])).not.toThrow();
    expect(() => assertReferenceAllowedAtLocation({ name: "Old store", serviceRole: null }, ["INVESTIGATION"])).not.toThrow();
  });
});
