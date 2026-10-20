import { describe, expect, it } from "vitest";
import { labelToZpl, labelsToZpl, zplText } from "@/lib/zpl";
import { generateBatchCode, generateSerial, parseSerial } from "@/lib/serial";
import { parsePrinterHost } from "@/lib/printer";
import { formDataToObject, issuesToMessage } from "@/lib/form";
import type { Label } from "@/lib/label-types";

const serialLabel = (): Label => ({
  kind: "serial",
  serial: generateSerial(),
  itemName: "EDTA 5ML TUBE",
  containerType: "EDTA",
  batchCode: generateBatchCode(),
  expiryDate: "2027-03-31",
  lotNo: "A123",
});

describe("zpl", () => {
  it("encodes the serial as Code 128 and prints it as text", () => {
    const label = serialLabel();
    const zpl = labelToZpl(label);
    if (label.kind !== "serial") throw new Error("unreachable");
    expect(zpl.startsWith("^XA")).toBe(true);
    expect(zpl.trimEnd().endsWith("^XZ")).toBe(true);
    expect(zpl).toContain(`^BCN,70,N,N,N^FD${label.serial}^FS`);
    expect(zpl).toContain(`^FD${label.serial}^FS`);
    expect(zpl).toContain("EXP 2027-03-31");
  });

  it("strips ZPL command characters from free text", () => {
    expect(zplText("A^B~C\\D\nE")).toBe("A B C D E");
    const zpl = labelToZpl({ ...serialLabel(), itemName: "Evil^XZ name" } as Label);
    // Only the real start and end commands may remain.
    expect(zpl.match(/\^XZ/g)).toHaveLength(1);
  });

  it("makes one job per label", () => {
    const zpl = labelsToZpl([serialLabel(), serialLabel(), serialLabel()]);
    expect(zpl.match(/\^XA/g)).toHaveLength(3);
  });

  it("round-trips: a generated serial passes validation", () => {
    for (let i = 0; i < 50; i++) expect(parseSerial(generateSerial())).not.toBeNull();
  });
});

describe("printer host", () => {
  it("defaults to port 9100", () => {
    expect(parsePrinterHost("192.168.1.50")).toEqual({ host: "192.168.1.50", port: 9100 });
  });
  it("accepts an explicit port", () => {
    expect(parsePrinterHost(" zebra.local:6101 ")).toEqual({ host: "zebra.local", port: 6101 });
  });
  it("rejects a bad port", () => {
    expect(() => parsePrinterHost("host:99999")).toThrow();
  });
});

describe("form helpers", () => {
  it("turns blanks into undefined and ticked boxes into true", () => {
    const fd = new FormData();
    fd.set("name", "Main store");
    fd.set("externalId", "   ");
    fd.set("allowUnusedReuse", "on");
    const obj = formDataToObject(fd, ["allowUnusedReuse", "other"]);
    expect(obj.name).toBe("Main store");
    expect(obj.externalId).toBeUndefined();
    expect(obj.allowUnusedReuse).toBe(true);
    expect(obj.other).toBe(false);
  });

  it("keeps passwords exactly as typed", () => {
    const fd = new FormData();
    fd.set("password", "  spaced pass  ");
    expect(formDataToObject(fd).password).toBe("  spaced pass  ");
  });

  it("joins issues into one line", () => {
    expect(
      issuesToMessage({
        issues: [
          { path: ["name"], message: "Required" },
          { path: [], message: "Bad form" },
        ],
      }),
    ).toBe("name: Required; Bad form");
  });
});
