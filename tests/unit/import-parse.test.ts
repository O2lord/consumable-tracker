import { describe, expect, it } from "vitest";
import {
  ImportFormatError,
  parseAmount,
  parseInvestigationRows,
  parsePatientType,
  parsePaymentStatus,
  parseWhen,
} from "@/lib/import-parse";

// Shaped like the staff portal exports: preamble rows first, the header on row 5, an unnamed
// column between Item and Destination, and amounts as text.
const PORTAL_HEADER = ["MRN", "Investigation #", "Item", "", "Destination", "Amount (NGN)", "Status"];

const portalRows = (...data: unknown[][]): unknown[][] => [
  ["Lab queue"],
  ["Period", "2026-10-07"],
  [],
  ["Total", 3],
  PORTAL_HEADER,
  ...data,
];

describe("parseInvestigationRows: portal export", () => {
  it("finds the header by name even when it is not on row 1", () => {
    const result = parseInvestigationRows(
      portalRows(["UATH/PT/100001", "IXS101", "Liver Function Test (LFT)", "Fast Track", "Main Lab", "₦90", "Pending"]),
    );
    expect(result.headerRow).toBe(5);
    expect(result.errors).toEqual([]);
    expect(result.records).toHaveLength(1);
    expect(result.records[0]).toMatchObject({
      investigationRef: "IXS101",
      patientHospitalNo: "UATH/PT/100001",
      testName: "Liver Function Test (LFT)",
      destination: "Main Lab",
      status: "pending",
      amount: "90.00",
      row: 6,
    });
  });

  it("leaves patient type, payment status, test code and raised-at empty when the file lacks them", () => {
    const [r] = parseInvestigationRows(
      portalRows(["UATH/PT/100001", "IXS102", "Lipid Profile", "-", "Side-Lab", "100,000.00", "completed"]),
    ).records;
    expect(r.patientType).toBeNull();
    expect(r.paymentStatus).toBeNull();
    expect(r.testCode).toBeNull();
    expect(r.raisedAt).toBeNull();
    expect(r.queue).toBeNull();
    expect(r.amount).toBe("100000.00");
  });

  it("keeps every cell of the original row, under the file's own header text", () => {
    const [r] = parseInvestigationRows(
      portalRows(["UATH/PT/100001", "IXS103", "Pap Smear", "Amenity", "Main Lab", "0", "in_progress"]),
    ).records;
    expect(r.raw["MRN"]).toBe("UATH/PT/100001");
    expect(r.raw["Amount (NGN)"]).toBe("0");
    expect(r.raw["column_4"]).toBe("Amenity");
  });

  it("treats a zero amount as zero, not as a payment signal or a missing value", () => {
    const [r] = parseInvestigationRows(
      portalRows(["UATH/PT/100001", "IXS104", "Pap Smear", "-", "Main Lab", "₦0.00", "pending"]),
    ).records;
    expect(r.amount).toBe("0.00");
    expect(r.paymentStatus).toBeNull();
  });

  it("normalises the number and hospital number", () => {
    const [r] = parseInvestigationRows(
      portalRows([" uath/pt/100001 ", "ixs105", "Pap Smear", "-", "Main Lab", "", "pending"]),
    ).records;
    expect(r.investigationRef).toBe("IXS105");
    expect(r.patientHospitalNo).toBe("UATH/PT/100001");
    expect(r.amount).toBeNull();
  });

  it("skips blank rows and counts them", () => {
    const result = parseInvestigationRows(
      portalRows(["UATH/PT/100001", "IXS106", "Pap Smear", "-", "Main Lab", "", "pending"], [], ["", "", ""]),
    );
    expect(result.records).toHaveLength(1);
    expect(result.blankRows).toBe(2);
  });
});

describe("parseInvestigationRows: problems", () => {
  it("rejects a bad row with its row number and keeps the good ones", () => {
    const result = parseInvestigationRows(
      portalRows(
        ["UATH/PT/100001", "IXS107", "Pap Smear", "-", "Main Lab", "", "pending"],
        ["NOPE", "123", "", "-", "Main Lab", "abc", "pending"],
      ),
    );
    expect(result.records).toHaveLength(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].row).toBe(7);
    expect(result.errors[0].message).toContain("not an investigation number");
    expect(result.errors[0].message).toContain("not a hospital number");
    expect(result.errors[0].message).toContain("test name is empty");
    expect(result.errors[0].message).toContain("not a number");
  });

  it("uses the later row when a number appears twice, and reports the earlier one", () => {
    const result = parseInvestigationRows(
      portalRows(
        ["UATH/PT/100001", "IXS108", "Pap Smear", "-", "Main Lab", "", "pending"],
        ["UATH/PT/100001", "IXS108", "Pap Smear", "-", "Main Lab", "", "completed"],
      ),
    );
    expect(result.records).toHaveLength(1);
    expect(result.records[0].status).toBe("completed");
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].row).toBe(6);
  });

  it("throws a format error when there is no header with the required columns", () => {
    expect(() => parseInvestigationRows([["a", "b"], ["c", "d"]])).toThrow(ImportFormatError);
  });
});

describe("parseInvestigationRows: canonical columns", () => {
  it("accepts the tracker's own column names, including the optional ones", () => {
    const result = parseInvestigationRows([
      ["investigation_ref", "patient_hospital_no", "test_code", "test_name", "patient_type", "payment_status", "raised_at", "queue"],
      ["IXS200", "UATH/PT/200001", "LFT", "Liver Function Test", "outpatient", "charged to admission", "2026-10-07T14:30:00Z", "imaging"],
    ]);
    expect(result.errors).toEqual([]);
    expect(result.records[0]).toMatchObject({
      testCode: "LFT",
      patientType: "OUTPATIENT",
      paymentStatus: "CHARGED_TO_ADMISSION",
      queue: "IMAGING",
    });
    expect(result.records[0].raisedAt?.toISOString()).toBe("2026-10-07T14:30:00.000Z");
  });

  it("rejects values outside the allowed lists instead of guessing", () => {
    const result = parseInvestigationRows([
      ["investigation_ref", "patient_hospital_no", "test_name", "patient_type", "payment_status", "queue"],
      ["IXS201", "UATH/PT/200001", "X", "visitor", "maybe", "radio"],
    ]);
    expect(result.records).toHaveLength(0);
    expect(result.errors[0].message).toContain("patient type");
    expect(result.errors[0].message).toContain("payment status");
    expect(result.errors[0].message).toContain("queue");
  });
});

describe("value parsers", () => {
  it("parses amounts", () => {
    expect(parseAmount("₦90")).toBe("90.00");
    expect(parseAmount("100,000.00")).toBe("100000.00");
    expect(parseAmount("NGN 2000")).toBe("2000.00");
    expect(parseAmount("-")).toBeNull();
    expect(parseAmount("")).toBeNull();
    expect(parseAmount("ninety")).toBe("invalid");
  });

  it("parses patient types and payment statuses", () => {
    expect(parsePatientType("Walk-in")).toBe("WALK_IN");
    expect(parsePatientType("IP")).toBe("INPATIENT");
    expect(parsePatientType("-")).toBeNull();
    expect(parsePatientType("guest")).toBe("invalid");
    expect(parsePaymentStatus("Not paid")).toBe("UNPAID");
    expect(parsePaymentStatus("PAID")).toBe("PAID");
    expect(parsePaymentStatus("pending")).toBe("invalid");
  });

  it("accepts ISO dates only", () => {
    expect(parseWhen("2026-10-07")?.toString()).toBeDefined();
    expect(parseWhen("07/10/2026")).toBe("invalid");
    expect(parseWhen("")).toBeNull();
    expect(parseWhen(new Date("2026-10-07T10:00:00Z"))).toBeInstanceOf(Date);
  });
});
