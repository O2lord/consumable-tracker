// Reads a lab request pasted from WhatsApp, for example:
//
//   Abubakar Sidi/1341304/Surgical casualty/E6
//   Sample collection for the above patient
//    - FBC
//    - EUCr
//    - Viral serologies(HIV, HBV, HCV)
//
// and works out the patient's hospital number, any investigation numbers, and the bottles the tests need.
// Pure: no I/O. The patient's name and ward are never read out, so they cannot end up stored.
//
// BEST GUESS, NOT CONFIRMED: the shorthand below (FBC, EUCr, FLP...) and the container each one goes in are
// the usual ones, not a list the lab has signed off. A test that is in the Test catalog uses the container set
// there instead, so correcting it on the Test catalog screen corrects it here.

import { withMrnPrefix } from "./reference-formats";

export interface RequestedTest {
  /** How the request names it, in the form shown on screen. */
  label: string;
  /** The Test catalog code, when the catalog has this test. */
  catalogCode?: string;
  /** The container (EDTA, PLAIN, FLUORIDE...) the sample goes in. */
  container: string;
}

/** One bottle to issue and the tests that share it. */
export interface Bottle {
  container: string;
  tests: RequestedTest[];
}

export interface ParsedRequest {
  /** UATH/PT/ followed by digits, or empty when the text has no hospital number. */
  patientHospitalNo: string;
  /** IXS numbers found in the text (usually none: the portal gives them out, not the ward). */
  investigations: string[];
  bottles: Bottle[];
}

/** The Test catalog fields this needs. */
export interface CatalogTest {
  code: string;
  requiredContainerType: string | null;
}

interface Known {
  label: string;
  code?: string;
  container: string;
}

const HIV: Known = { label: "HIV", code: "RVS", container: "PLAIN" };
const HBSAG: Known = { label: "HBsAg", code: "HBSAG", container: "PLAIN" };
const HCV: Known = { label: "HCV", container: "PLAIN" };

const KNOWN: { pattern: RegExp; tests: Known[] }[] = [
  { pattern: /\b(fbc|cbc|full blood count)\b/i, tests: [{ label: "FBC", container: "EDTA" }] },
  { pattern: /\besr\b/i, tests: [{ label: "ESR", container: "ESR" }] },
  {
    pattern: /\b(eucr|e\.?u\.?c\.?r|u\s*&\s*e|electrolytes?)\b/i,
    tests: [{ label: "EUCr", code: "RFT", container: "PLAIN" }],
  },
  { pattern: /\b(flp|lipid profile|lipid)\b/i, tests: [{ label: "Lipid profile", code: "LIPID", container: "PLAIN" }] },
  { pattern: /\b(lft|liver function(?: tests?)?)\b/i, tests: [{ label: "LFT", code: "LFT", container: "PLAIN" }] },
  { pattern: /\b(urinalysis|urine r\/?e)\b/i, tests: [{ label: "Urinalysis", container: "URINE" }] },
  { pattern: /\burine m\/?c\/?s\b|\bumcs\b/i, tests: [{ label: "Urine MCS", code: "UMCS", container: "URINE" }] },
  { pattern: /\bhba1c\b/i, tests: [{ label: "HBA1c", code: "HBA1C", container: "EDTA" }] },
  { pattern: /\bd[\s-]?dimer\b/i, tests: [{ label: "D-dimer", container: "CITRATE" }] },
  { pattern: /\b(pt\s*\/?\s*inr|inr|prothrombin)\b/i, tests: [{ label: "PT/INR", container: "CITRATE" }] },
  { pattern: /\b(fbs|fasting (blood )?sugar)\b/i, tests: [{ label: "FBS", code: "FBS", container: "FLUORIDE" }] },
  { pattern: /\b(rbs|random (blood )?sugar)\b/i, tests: [{ label: "RBS", container: "FLUORIDE" }] },
  { pattern: /\b(gxm|genotype|blood group)\b/i, tests: [{ label: "Group and genotype", code: "GXM", container: "EDTA" }] },
  { pattern: /\bmalaria\b/i, tests: [{ label: "Malaria parasite", container: "EDTA" }] },
  { pattern: /\bwidal\b/i, tests: [{ label: "Widal", code: "WIDAL", container: "PLAIN" }] },
  { pattern: /\bvdrl\b/i, tests: [{ label: "VDRL", code: "VDRL", container: "PLAIN" }] },
  { pattern: /\b(blood culture|bcs)\b/i, tests: [{ label: "Blood culture", code: "BCS", container: "PLAIN" }] },
  { pattern: /\bviral\s+serolog(y|ies)\b/i, tests: [HIV, HBSAG, HCV] },
  { pattern: /\b(hiv|rvs)\b/i, tests: [HIV] },
  { pattern: /\b(hbv|hbsag)\b/i, tests: [HBSAG] },
  { pattern: /\bhcv\b/i, tests: [HCV] },
];

/** The hospital number in the text: UATH/PT/ plus digits, or else the first standalone run of 5 to 12 digits. */
export function extractHospitalNo(text: string): string {
  const prefixed = text.match(/UATH\s*\/\s*PT\s*\/\s*(\d{1,12})/i);
  if (prefixed) return `UATH/PT/${prefixed[1]}`;
  // A bed number or ward code is shorter than this; letters beside the digits (IXS181, E6) rule a run out.
  const bare = text.match(/(?<![A-Za-z\d])\d{5,12}(?!\d)/);
  return bare ? withMrnPrefix(bare[0]) : "";
}

function extractInvestigations(text: string): string[] {
  const found = (text.match(/\bIXS\s?\d{1,12}\b/gi) ?? []).map((s) => s.replace(/\s+/g, "").toUpperCase());
  return [...new Set(found)];
}

/** The tests named in the text, in the order they appear, each once. */
function extractTests(text: string, catalog: CatalogTest[]): RequestedTest[] {
  const hits = new Map<string, { test: RequestedTest; index: number }>();
  for (const entry of KNOWN) {
    const match = entry.pattern.exec(text);
    if (!match) continue;
    for (const known of entry.tests) {
      const existing = hits.get(known.label);
      if (existing && existing.index <= match.index) continue;
      const fromCatalog = known.code ? catalog.find((c) => c.code === known.code) : undefined;
      hits.set(known.label, {
        index: match.index,
        test: {
          label: known.label,
          catalogCode: fromCatalog?.code,
          container: (fromCatalog?.requiredContainerType ?? known.container).toUpperCase(),
        },
      });
    }
  }
  return [...hits.values()].sort((a, b) => a.index - b.index).map((h) => h.test);
}

/** One bottle per container, in the order each container first appears. */
export function groupBottles(tests: RequestedTest[]): Bottle[] {
  const bottles: Bottle[] = [];
  for (const test of tests) {
    const bottle = bottles.find((b) => b.container === test.container);
    if (bottle) bottle.tests.push(test);
    else bottles.push({ container: test.container, tests: [test] });
  }
  return bottles;
}

/** The first test of a bottle that is in the Test catalog: the code the bottle is issued under (it fills the items list). */
export function firstCatalogCode(bottle: Bottle | undefined, catalog: readonly CatalogTest[]): string | undefined {
  return bottle?.tests.find((t) => t.catalogCode && catalog.some((c) => c.code === t.catalogCode))?.catalogCode;
}

/** One bottle in an "issue all" run: its container and the catalog test it is issued under (when it has one). */
export interface BottlePlanEntry {
  container: string;
  testCode?: string;
}

/** The bottles of a request that are not issued yet (`done` holds the containers already issued). */
export function remainingBottles(bottles: readonly Bottle[], done: readonly string[]): Bottle[] {
  return bottles.filter((b) => !done.includes(b.container));
}

/**
 * Every bottle still to issue, the selected one first (its items are the ones confirmed on screen), then the rest in
 * the order they appear in the request.
 */
export function issueAllPlan(
  bottles: readonly Bottle[],
  done: readonly string[],
  activeContainer: string | undefined,
  catalog: readonly CatalogTest[],
): BottlePlanEntry[] {
  const left = remainingBottles(bottles, done);
  const ordered = [...left.filter((b) => b.container === activeContainer), ...left.filter((b) => b.container !== activeContainer)];
  return ordered.map((b) => ({ container: b.container, testCode: firstCatalogCode(b, catalog) }));
}

export function parseRequest(text: string, catalog: CatalogTest[]): ParsedRequest {
  return {
    patientHospitalNo: extractHospitalNo(text),
    investigations: extractInvestigations(text),
    bottles: groupBottles(extractTests(text, catalog)),
  };
}
