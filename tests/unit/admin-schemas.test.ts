import { describe, expect, it } from "vitest";
import {
  itemTypeInputSchema,
  locationInputSchema,
  passwordResetSchema,
  roleDeleteSchema,
  roleInputSchema,
  roleUpdateSchema,
  setActiveSchema,
  userCreateSchema,
  voidReasonInputSchema,
} from "@/types/admin";
import { testInputSchema, testUpdateSchema } from "@/types/issue";

const uuid = "123e4567-e89b-42d3-a456-426614174000";

describe("admin schemas", () => {
  it("upper-cases codes", () => {
    const r = locationInputSchema.parse({ code: "main-store", name: "Main Store", type: "STORE", allowUnusedReuse: true });
    expect(r.code).toBe("MAIN-STORE");
  });

  it("rejects codes with spaces or too short", () => {
    expect(locationInputSchema.safeParse({ code: "A", name: "x", type: "STORE", allowUnusedReuse: true }).success).toBe(false);
    expect(locationInputSchema.safeParse({ code: "MAIN STORE", name: "x", type: "STORE", allowUnusedReuse: true }).success).toBe(false);
  });

  it("applies item type defaults", () => {
    const r = itemTypeInputSchema.parse({ code: "edta-5", name: "EDTA 5ml", category: "sample_container", trackingMode: "SERIAL" });
    expect(r.unitOfMeasure).toBe("each");
    expect(r.reorderLevel).toBe(0);
    expect(r.category).toBe("SAMPLE_CONTAINER");
  });

  it("coerces the reorder level typed in a form", () => {
    const r = itemTypeInputSchema.parse({ code: "GLV", name: "Gloves", category: "GENERAL", trackingMode: "QUANTITY", reorderLevel: "250" });
    expect(r.reorderLevel).toBe(250);
    expect(itemTypeInputSchema.safeParse({ code: "GLV", name: "G", category: "GENERAL", trackingMode: "QUANTITY", reorderLevel: "-1" }).success).toBe(false);
  });

  it("leaves cold storage off unless it is ticked (C9, display only)", () => {
    const base = { code: "ANTI-A", name: "Anti-A", category: "REAGENT", trackingMode: "QUANTITY" } as const;
    expect(itemTypeInputSchema.parse(base).coldStorage).toBe(false);
    expect(itemTypeInputSchema.parse({ ...base, coldStorage: true }).coldStorage).toBe(true);
  });

  it("leaves bench supply off unless it is ticked (a shared supply, never listed per test or patient)", () => {
    const base = { code: "COTTON", name: "Cotton wool 500g", category: "PHLEBOTOMY", trackingMode: "QUANTITY" } as const;
    expect(itemTypeInputSchema.parse(base).benchSupply).toBe(false);
    expect(itemTypeInputSchema.parse({ ...base, benchSupply: true }).benchSupply).toBe(true);
  });

  it("starts a test's container mapping as unconfirmed, and carries the tick when the lab confirms it (C4)", () => {
    const base = { code: "lft", name: "Liver Function Test", requiredContainerType: "plain", alternateContainerTypes: "gel" };
    const created = testInputSchema.parse(base);
    expect(created.containersConfirmed).toBe(false);
    expect(created.requiredContainerType).toBe("PLAIN");
    expect(created.alternateContainerTypes).toEqual(["GEL"]);
    expect(testInputSchema.parse({ ...base, containersConfirmed: true }).containersConfirmed).toBe(true);
    expect(testUpdateSchema.parse({ id: uuid, name: "LFT", alternateContainerTypes: "", containersConfirmed: true }).containersConfirmed).toBe(true);
  });

  it("normalises staff IDs and enforces password length", () => {
    const ok = userCreateSchema.parse({ staffId: " uath/stf/001 ", name: "A", role: "STORE_KEEPER", password: "12345678" });
    expect(ok.staffId).toBe("UATH/STF/001");
    expect(userCreateSchema.safeParse({ staffId: "X1", name: "A", role: "ADMIN", password: "short" }).success).toBe(false);
    expect(userCreateSchema.safeParse({ staffId: "X1", name: "A", role: "not a role!", password: "12345678" }).success).toBe(false);
  });

  it("validates void reason codes", () => {
    expect(voidReasonInputSchema.parse({ code: "leaking", label: "Leaking" }).code).toBe("LEAKING");
    expect(voidReasonInputSchema.safeParse({ code: "1bad", label: "x" }).success).toBe(false);
  });

  it("reads the activate/deactivate hidden field", () => {
    expect(setActiveSchema.parse({ id: uuid, active: "false" }).active).toBe(false);
    expect(setActiveSchema.parse({ id: uuid, active: "true" }).active).toBe(true);
    expect(setActiveSchema.safeParse({ id: uuid, active: "maybe" }).success).toBe(false);
  });

  it("requires a valid id and password for a reset", () => {
    expect(passwordResetSchema.safeParse({ id: "nope", password: "12345678" }).success).toBe(false);
  });

  it("validates a role: a name, and only permissions that exist", () => {
    const ok = roleInputSchema.parse({ name: "  Lab lead  ", permissions: ["issue", "void"] });
    expect(ok.name).toBe("Lab lead");
    expect(ok.description).toBe("");
    expect(roleInputSchema.parse({ name: "Empty" }).permissions).toEqual([]);
    expect(roleInputSchema.safeParse({ name: "   " }).success).toBe(false);
    expect(roleInputSchema.safeParse({ name: "x".repeat(61) }).success).toBe(false);
    expect(roleInputSchema.safeParse({ name: "Odd", permissions: ["fly_a_kite"] }).success).toBe(false);
  });

  it("identifies a role being edited or deleted by its code", () => {
    expect(roleUpdateSchema.parse({ code: "lab_lead", name: "Lab lead" }).code).toBe("LAB_LEAD");
    expect(roleUpdateSchema.safeParse({ code: "not a code!", name: "x" }).success).toBe(false);
    expect(roleDeleteSchema.safeParse({ code: "" }).success).toBe(false);
  });
});
