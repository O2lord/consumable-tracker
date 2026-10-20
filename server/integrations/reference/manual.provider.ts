import { referenceFormatProblem } from "../../../lib/reference-formats";
import { ValidationError } from "../../domain/errors";
import type { ReferenceProvider } from "./provider";

/**
 * The provider for now: it checks the format of what was typed and nothing else. Existence and
 * payment come back as `unknown`, which the issue rules record as UNVERIFIED rather than pass.
 */
export const manualReferenceProvider: ReferenceProvider = {
  source: "manual",

  async lookup(type, ref) {
    const problem = referenceFormatProblem(type, ref);
    if (problem) throw new ValidationError(problem);
    return { exists: "unknown", paymentStatus: "unknown" };
  },

  async listPendingForPatient() {
    // Nothing to list until investigations are imported (Phase 6) or read from the EMR (Phase 8).
    return [];
  },
};
