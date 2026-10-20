import { env } from "../../env";
import { csvReferenceProvider } from "./csv.provider";
import { manualReferenceProvider } from "./manual.provider";
import type { ReferenceProvider } from "./provider";

export type { ReferenceLookup, ReferenceProvider, ReferenceSummary } from "./provider";

/**
 * The provider in use, chosen by REFERENCE_PROVIDER (default `csv`): investigations are looked up in
 * the imported files and anything not found is treated as unknown, so with no import loaded it behaves
 * exactly like `manual`. Phase 8 adds the EMR provider here; this is the one switch.
 */
export function referenceProvider(): ReferenceProvider {
  return env().REFERENCE_PROVIDER === "manual" ? manualReferenceProvider : csvReferenceProvider;
}
