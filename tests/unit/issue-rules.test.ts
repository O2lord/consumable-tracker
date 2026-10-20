import { describe, expect, it } from "vitest";
import {
  AlreadyIssuedError,
  ExpiredStockError,
  InvalidTransitionError,
  PatientMismatchError,
  PermissionDeniedError,
  ValidationError,
  WrongLocationError,
} from "@/server/domain/errors";
import {
  assertCanIssueQuantity,
  assertCanIssueUnit,
  assertCanOverride,
  assertCanReturnQuantity,
  assertCanVoidUnit,
  assertSamePatient,
  containerMismatch,
  decideReturn,
  evaluatePayment,
  pickPolicyRule,
  resolveWorkLocation,
} from "@/server/domain/issue-rules";
import {
  isValidMrn,
  isValidReference,
  needsPatient,
  normalizeMrn,
  normalizeReference,
  referenceFormatProblem,
} from "@/lib/reference-formats";

const LAB = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const TODAY = "2026-10-07";

const unit = (over: Partial<Parameters<typeof assertCanIssueUnit>[0]> = {}) => ({
  serial: "CT12345678A",
  state: "IN_STOCK" as const,
  locationId: LAB,
  expiryDate: null,
  ...over,
});

describe("resolveWorkLocation", () => {
  it("uses a distributor's own location", () => {
    expect(resolveWorkLocation({ role: "DISTRIBUTOR", homeLocationId: LAB })).toBe(LAB);
    expect(resolveWorkLocation({ role: "DISTRIBUTOR", homeLocationId: LAB }, LAB)).toBe(LAB);
  });

  it("refuses another location, and an account with no home location", () => {
    expect(() => resolveWorkLocation({ role: "DISTRIBUTOR", homeLocationId: LAB }, OTHER)).toThrow(PermissionDeniedError);
    expect(() => resolveWorkLocation({ role: "DISTRIBUTOR", homeLocationId: null })).toThrow(PermissionDeniedError);
  });

  it("lets a supervisor pick any location, but needs one", () => {
    expect(resolveWorkLocation({ role: "SUPERVISOR", homeLocationId: LAB }, OTHER)).toBe(OTHER);
    expect(resolveWorkLocation({ role: "SUPERVISOR", homeLocationId: LAB })).toBe(LAB);
    expect(() => resolveWorkLocation({ role: "SUPERVISOR", homeLocationId: null })).toThrow(ValidationError);
  });
});

describe("assertCanOverride", () => {
  it("is for supervisors only", () => {
    expect(() => assertCanOverride({ role: "DISTRIBUTOR" }, "patient waiting")).toThrow(PermissionDeniedError);
    expect(() => assertCanOverride({ role: "STORE_KEEPER" }, "patient waiting")).toThrow(PermissionDeniedError);
  });

  it("needs a reason, and returns it trimmed", () => {
    expect(() => assertCanOverride({ role: "SUPERVISOR" }, undefined)).toThrow(ValidationError);
    expect(() => assertCanOverride({ role: "SUPERVISOR" }, "  ")).toThrow(ValidationError);
    expect(assertCanOverride({ role: "SUPERVISOR" }, "  only EDTA left  ")).toBe("only EDTA left");
  });
});

describe("assertCanIssueUnit", () => {
  it("allows an in-stock, unexpired unit at the location", () => {
    expect(() => assertCanIssueUnit(unit(), LAB, TODAY)).not.toThrow();
    expect(() => assertCanIssueUnit(unit({ expiryDate: TODAY }), LAB, TODAY)).not.toThrow();
  });

  it("says plainly when it has already been issued", () => {
    expect(() => assertCanIssueUnit(unit({ state: "ISSUED" }), LAB, TODAY)).toThrow(AlreadyIssuedError);
  });

  it("refuses units in any other state", () => {
    for (const state of ["IN_TRANSIT", "MISSING_IN_TRANSIT", "RETURNED", "VOIDED", "WRITTEN_OFF"] as const) {
      expect(() => assertCanIssueUnit(unit({ state }), LAB, TODAY)).toThrow(InvalidTransitionError);
    }
  });

  it("refuses a unit at another location and an expired unit", () => {
    expect(() => assertCanIssueUnit(unit({ locationId: OTHER }), LAB, TODAY)).toThrow(WrongLocationError);
    expect(() => assertCanIssueUnit(unit({ expiryDate: "2026-10-06" }), LAB, TODAY)).toThrow(ExpiredStockError);
  });
});

describe("assertCanIssueQuantity", () => {
  const ok = { quantity: 5, available: 10, expiryDate: null, today: TODAY };

  it("accepts a quantity within what is held", () => {
    expect(() => assertCanIssueQuantity(ok)).not.toThrow();
    expect(() => assertCanIssueQuantity({ ...ok, quantity: 10 })).not.toThrow();
  });

  it("refuses zero, fractions, too much, and expired batches", () => {
    expect(() => assertCanIssueQuantity({ ...ok, quantity: 0 })).toThrow(ValidationError);
    expect(() => assertCanIssueQuantity({ ...ok, quantity: 1.5 })).toThrow(ValidationError);
    expect(() => assertCanIssueQuantity({ ...ok, quantity: 11 })).toThrow(/Only 10/);
    expect(() => assertCanIssueQuantity({ ...ok, expiryDate: "2026-01-01" })).toThrow(ExpiredStockError);
  });
});

describe("containerMismatch", () => {
  it("passes when nothing is required or the container matches", () => {
    expect(containerMismatch("CT1", null, [])).toBeNull();
    expect(containerMismatch("CT1", "EDTA", [])).toBeNull();
    expect(containerMismatch("CT1", "EDTA", [["EDTA"]])).toBeNull();
    expect(containerMismatch("CT1", "EDTA", [["EDTA"], ["EDTA"]])).toBeNull();
  });

  it("explains a wrong tube, a bottle with no container type, and tests that need different tubes", () => {
    expect(containerMismatch("CT1", "PLAIN", [["EDTA"]])).toMatch(/PLAIN.*needs EDTA/);
    expect(containerMismatch("CT1", null, [["EDTA"]])).toMatch(/no container type/);
    expect(containerMismatch("CT1", "EDTA", [["EDTA"], ["FLUORIDE"]])).toMatch(/separate groups/);
  });

  it("accepts a test's alternate containers without an override", () => {
    expect(containerMismatch("CT1", "PLAIN", [["PLAIN", "GEL"]])).toBeNull();
    expect(containerMismatch("CT1", "GEL", [["PLAIN", "GEL"]])).toBeNull();
    expect(containerMismatch("CT1", "EDTA", [["PLAIN", "GEL"]])).toMatch(/EDTA.*needs PLAIN or GEL/);
  });

  it("lets two tests share a bottle when one container satisfies both, and still refuses a bottle outside both", () => {
    // LFT takes plain or gel; U&E takes gel or plain: either tube serves both.
    expect(containerMismatch("CT1", "GEL", [["PLAIN", "GEL"], ["GEL", "PLAIN"]])).toBeNull();
    // A plain-only test narrows the bottle to PLAIN.
    expect(containerMismatch("CT1", "PLAIN", [["PLAIN", "GEL"], ["PLAIN"]])).toBeNull();
    expect(containerMismatch("CT1", "GEL", [["PLAIN", "GEL"], ["PLAIN"]])).toMatch(/GEL.*needs PLAIN/);
    // No tube in common: separate groups.
    expect(containerMismatch("CT1", "PLAIN", [["PLAIN", "GEL"], ["EDTA"]])).toMatch(/separate groups/);
  });
});

describe("pickPolicyRule", () => {
  const policies = [
    { referenceType: "INVESTIGATION", patientType: "OUTPATIENT", rule: "MUST_BE_PAID" },
    { referenceType: "INVESTIGATION", patientType: "INPATIENT", rule: "CHARGE_TO_ADMISSION" },
    { referenceType: "DEPARTMENT", patientType: "ANY", rule: "NONE" },
    { referenceType: "ADMISSION", patientType: "ANY", rule: "CHARGE_TO_ADMISSION" },
  ] as const;

  it("prefers the exact match, then the ANY fallback, then NONE", () => {
    expect(pickPolicyRule(policies, "INVESTIGATION", "OUTPATIENT")).toBe("MUST_BE_PAID");
    expect(pickPolicyRule(policies, "INVESTIGATION", "INPATIENT")).toBe("CHARGE_TO_ADMISSION");
    expect(pickPolicyRule(policies, "ADMISSION", "OUTPATIENT")).toBe("CHARGE_TO_ADMISSION");
    expect(pickPolicyRule(policies, "SURGERY", undefined)).toBe("NONE");
    expect(pickPolicyRule(policies, "INVESTIGATION", undefined)).toBe("NONE");
  });
});

describe("evaluatePayment", () => {
  it("needs no check under NONE or CHARGE_TO_ADMISSION", () => {
    expect(evaluatePayment("NONE", "unknown")).toEqual({ check: "NOT_REQUIRED", blocked: false });
    expect(evaluatePayment("CHARGE_TO_ADMISSION", "UNPAID")).toEqual({ check: "NOT_REQUIRED", blocked: false });
  });

  it("verifies a paid reference under MUST_BE_PAID", () => {
    expect(evaluatePayment("MUST_BE_PAID", "PAID")).toEqual({ check: "VERIFIED", blocked: false });
  });

  it("blocks a reference known to be unpaid", () => {
    expect(evaluatePayment("MUST_BE_PAID", "UNPAID").blocked).toBe(true);
  });

  it("records an unverifiable payment as UNVERIFIED instead of passing it silently", () => {
    expect(evaluatePayment("MUST_BE_PAID", "unknown")).toEqual({ check: "UNVERIFIED", blocked: false });
  });
});

describe("assertSamePatient", () => {
  const mrn = "UATH/PT/1001";

  it("allows a unit with no active links, or links to the same patient", () => {
    expect(() => assertSamePatient([], mrn, "CT1")).not.toThrow();
    expect(() => assertSamePatient([mrn, mrn], mrn, "CT1")).not.toThrow();
  });

  it("blocks linking one unit to different patients", () => {
    expect(() => assertSamePatient(["UATH/PT/2002"], mrn, "CT1")).toThrow(PatientMismatchError);
    expect(() => assertSamePatient([mrn, "UATH/PT/2002"], mrn, "CT1")).toThrow(PatientMismatchError);
    expect(() => assertSamePatient([mrn], null, "CT1")).toThrow(PatientMismatchError);
  });
});

describe("decideReturn", () => {
  it("closes a used bottle without clearing its links", () => {
    expect(decideReturn("USED", true, undefined)).toEqual({ action: "RETURN_USED", clearLinks: false, reasonCode: null });
  });

  it("puts an unused bottle back in stock and clears its links where reuse is allowed", () => {
    expect(decideReturn("UNUSED", true, undefined)).toEqual({ action: "RETURN_UNUSED", clearLinks: true, reasonCode: null });
  });

  it("voids an unused bottle with reason UNUSED where reuse is not allowed", () => {
    expect(decideReturn("UNUSED", false, undefined)).toEqual({ action: "VOID", clearLinks: true, reasonCode: "UNUSED" });
  });

  it("voids an unusable bottle, and insists on a reason", () => {
    expect(decideReturn("UNUSABLE", true, "BROKEN")).toEqual({ action: "VOID", clearLinks: false, reasonCode: "BROKEN" });
    expect(() => decideReturn("UNUSABLE", true, undefined)).toThrow(ValidationError);
  });
});

describe("assertCanReturnQuantity", () => {
  it("cannot exceed what is still out", () => {
    expect(() => assertCanReturnQuantity(3, 5)).not.toThrow();
    expect(() => assertCanReturnQuantity(5, 5)).not.toThrow();
    expect(() => assertCanReturnQuantity(6, 5)).toThrow(/Only 5/);
    expect(() => assertCanReturnQuantity(0, 5)).toThrow(ValidationError);
  });
});

describe("assertCanVoidUnit", () => {
  const base = { serial: "CT1", state: "IN_STOCK" as const, locationId: LAB };

  it("allows in-stock and issued units at the location", () => {
    expect(() => assertCanVoidUnit(base, LAB)).not.toThrow();
    expect(() => assertCanVoidUnit({ ...base, state: "ISSUED" }, LAB)).not.toThrow();
  });

  it("refuses other states and other locations", () => {
    expect(() => assertCanVoidUnit({ ...base, state: "IN_TRANSIT" }, LAB)).toThrow(ValidationError);
    expect(() => assertCanVoidUnit({ ...base, state: "VOIDED" }, LAB)).toThrow(ValidationError);
    expect(() => assertCanVoidUnit(base, OTHER)).toThrow(WrongLocationError);
  });
});

describe("reference formats", () => {
  it("accepts investigation numbers of the form IXS plus digits, in any case", () => {
    expect(isValidReference("INVESTIGATION", "IXS181")).toBe(true);
    expect(isValidReference("INVESTIGATION", " ixs181 ")).toBe(true);
    expect(isValidReference("INVESTIGATION", "IXS")).toBe(false);
    expect(isValidReference("INVESTIGATION", "IX181")).toBe(false);
    expect(isValidReference("INVESTIGATION", "IXS18A")).toBe(false);
  });

  it("accepts MRNs of the form UATH/PT/ plus digits", () => {
    expect(isValidMrn("UATH/PT/123456")).toBe(true);
    expect(isValidMrn("uath/pt/123456")).toBe(true);
    expect(isValidMrn("UATH/PT/")).toBe(false);
    expect(isValidMrn("PT/123456")).toBe(false);
    expect(normalizeMrn(" uath/pt/ 123 ")).toBe("UATH/PT/123");
  });

  it("is permissive for the references whose formats are not confirmed yet", () => {
    expect(isValidReference("ADMISSION", "ADM-2026/001")).toBe(true);
    expect(isValidReference("DEPARTMENT", "Theatre 2")).toBe(true);
    expect(isValidReference("SURGERY", "")).toBe(false);
  });

  it("explains a malformed number", () => {
    expect(referenceFormatProblem("INVESTIGATION", "181")).toMatch(/IXS/);
    expect(referenceFormatProblem("INVESTIGATION", "IXS181")).toBeNull();
  });

  it("normalises references and knows which ones belong to a patient", () => {
    expect(normalizeReference("  ixs  181 ")).toBe("IXS 181");
    expect(needsPatient("INVESTIGATION")).toBe(true);
    expect(needsPatient("DEPARTMENT")).toBe(false);
  });
});
