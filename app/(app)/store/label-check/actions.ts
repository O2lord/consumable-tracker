"use server";

import { requirePermission } from "@/server/auth/session";
import { lookupCode, type CodeLookup } from "@/server/services/lookup.service";
import { destinationFor, type Destination } from "./destination";

export interface LabelCheckResponse {
  result: CodeLookup;
  /** The page that shows this thing where it is now, or null if there is none the person may open. */
  destination: Destination | null;
}

/** Called by the label-check screen for each scan. Read-only. */
export async function lookupLabelAction(code: string): Promise<LabelCheckResponse> {
  const session = await requirePermission("check_labels");
  const result = await lookupCode(String(code).slice(0, 100));
  return { result, destination: destinationFor(result, session) };
}
