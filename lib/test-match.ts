// Matching an imported test to the test catalog. Pure: no I/O.
//
// Exports do not carry reliable test codes: some names have one in brackets ("Liver Function Test
// (LFT)"), many do not ("Lipid Profile"). So a test is matched by its code when the export gives
// one, then by a bracketed code in its name, then by its name with case and punctuation ignored.

export interface CatalogEntry {
  code: string;
  name: string;
  requiredContainer: string | null;
  /** Other containers that also satisfy the test (see lib/containers.ts). Absent means none. */
  alternateContainers?: readonly string[];
}

const nameKey = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** "Liver Function Test (LFT)" carries its own code in brackets; take the last bracketed token. */
export function bracketCode(testName: string): string | null {
  const m = testName.match(/\(([A-Za-z0-9/&-]{1,12})\)\s*$/);
  return m ? m[1].toUpperCase() : null;
}

export function matchTest(
  imported: { testCode: string | null; testName: string },
  catalog: readonly CatalogEntry[],
): CatalogEntry | null {
  const byCode = new Map(catalog.map((c) => [c.code.toUpperCase(), c]));
  const byName = new Map(catalog.map((c) => [nameKey(c.name), c]));
  if (imported.testCode) {
    const hit = byCode.get(imported.testCode.toUpperCase());
    if (hit) return hit;
  }
  const bracket = bracketCode(imported.testName);
  if (bracket) {
    const hit = byCode.get(bracket);
    if (hit) return hit;
  }
  return byName.get(nameKey(imported.testName)) ?? null;
}
