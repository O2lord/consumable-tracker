import { describe, expect, it } from "vitest";
import { extractHospitalNo, firstCatalogCode, issueAllPlan, parseRequest, remainingBottles } from "@/lib/request-paste";
import { withMrnPrefix } from "@/lib/reference-formats";

const CATALOG = [
  { code: "RFT", requiredContainerType: "PLAIN" },
  { code: "LFT", requiredContainerType: "PLAIN" },
  { code: "LIPID", requiredContainerType: "PLAIN" },
  { code: "HBA1C", requiredContainerType: "EDTA" },
  { code: "RVS", requiredContainerType: "PLAIN" },
  { code: "HBSAG", requiredContainerType: "PLAIN" },
];

describe("withMrnPrefix", () => {
  it("adds the prefix to a bare number only", () => {
    expect(withMrnPrefix("1278932")).toBe("UATH/PT/1278932");
    expect(withMrnPrefix(" 1278932 ")).toBe("UATH/PT/1278932");
    expect(withMrnPrefix("UATH/PT/55")).toBe("UATH/PT/55");
    expect(withMrnPrefix("")).toBe("");
  });
});

describe("extractHospitalNo", () => {
  it("skips the bed number and takes the hospital number", () => {
    expect(extractHospitalNo("Jacob Mary 1278932\nBed 28 , MEU")).toBe("UATH/PT/1278932");
  });
  it("reads a slash-separated line", () => {
    expect(extractHospitalNo("Abubakar Sidi/1341304/Surgical casualty/E6")).toBe("UATH/PT/1341304");
  });
  it("keeps a number that already has the prefix", () => {
    expect(extractHospitalNo("uath/pt/998877 FBC")).toBe("UATH/PT/998877");
  });
  it("returns nothing when there is no number", () => {
    expect(extractHospitalNo("Good afternoon. Bed 4")).toBe("");
  });
});

describe("parseRequest", () => {
  it("groups the first example's tests into bottles", () => {
    const r = parseRequest("Jacob Mary 1278932\nBed 28 , MEU\nFBC +ESR\nEucr\nFLP\nUrinalysis\nHBA1C\nD-dimer", CATALOG);
    expect(r.patientHospitalNo).toBe("UATH/PT/1278932");
    expect(r.bottles.map((b) => [b.container, b.tests.map((t) => t.label)])).toEqual([
      ["EDTA", ["FBC", "HBA1c"]],
      ["ESR", ["ESR"]],
      ["PLAIN", ["EUCr", "Lipid profile"]],
      ["URINE", ["Urinalysis"]],
      ["CITRATE", ["D-dimer"]],
    ]);
  });

  it("expands viral serologies once and finds the catalog codes", () => {
    const r = parseRequest(
      "Abubakar Sidi/1341304/Surgical casualty/E6\nSample collection for the above patient\n - FBC\n- EUCr\n- Viral serologies(HIV, HBV, HCV)\n-  LFT",
      CATALOG,
    );
    const plain = r.bottles.find((b) => b.container === "PLAIN");
    expect(plain?.tests.map((t) => t.label)).toEqual(["EUCr", "HIV", "HBsAg", "HCV", "LFT"]);
    expect(plain?.tests.find((t) => t.label === "HIV")?.catalogCode).toBe("RVS");
    expect(plain?.tests.find((t) => t.label === "HCV")?.catalogCode).toBeUndefined();
  });

  it("collects investigation numbers when the text has them", () => {
    expect(parseRequest("1278932 ixs 181 IXS182 LFT", CATALOG).investigations).toEqual(["IXS181", "IXS182"]);
  });
});

describe("issuing several bottles", () => {
  const request = parseRequest("1278932 IXS296\nFBC\nHBA1C\nEucr\nUrinalysis", CATALOG);

  it("finds the catalog code a bottle is issued under", () => {
    expect(request.bottles.map((b) => [b.container, firstCatalogCode(b, CATALOG)])).toEqual([
      ["EDTA", "HBA1C"],
      ["PLAIN", "RFT"],
      ["URINE", undefined],
    ]);
    expect(firstCatalogCode(undefined, CATALOG)).toBeUndefined();
  });

  it("leaves out the bottles already issued", () => {
    expect(remainingBottles(request.bottles, ["EDTA"]).map((b) => b.container)).toEqual(["PLAIN", "URINE"]);
    expect(remainingBottles(request.bottles, ["EDTA", "PLAIN", "URINE"])).toEqual([]);
  });

  it("puts the selected bottle first and keeps the request's order for the rest", () => {
    expect(issueAllPlan(request.bottles, [], "PLAIN", CATALOG)).toEqual([
      { container: "PLAIN", testCode: "RFT" },
      { container: "EDTA", testCode: "HBA1C" },
      { container: "URINE", testCode: undefined },
    ]);
    expect(issueAllPlan(request.bottles, ["EDTA"], "EDTA", CATALOG).map((p) => p.container)).toEqual(["PLAIN", "URINE"]);
  });
});
