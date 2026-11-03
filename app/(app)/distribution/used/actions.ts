"use server";

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/server/auth/session";
import { recordLabUsage, type LabUsageResult } from "@/server/services/lab-usage.service";
import { toFormError } from "@/server/actions/form-result";
import { formDataToObject } from "@/lib/form";
import type { FormState } from "@/components/forms/form-state";

const PATH = "/distribution/used";

/** What the form sends for a reagent counted in tests: the parts that were not patient tests, and whether it is finished. */
function parseExtra(value: string | undefined): { accounted: unknown[]; finished: boolean; containerCodes: string[] } {
  if (!value) return { accounted: [], finished: false, containerCodes: [] };
  try {
    const parsed = JSON.parse(value) as { accounted?: unknown; finished?: unknown; containerCodes?: unknown };
    return {
      accounted: Array.isArray(parsed.accounted) ? parsed.accounted : [],
      finished: parsed.finished === true,
      // The labels scanned for the containers this entry opened. Anything that is not text is dropped.
      containerCodes: Array.isArray(parsed.containerCodes)
        ? parsed.containerCodes.filter((c): c is string => typeof c === "string" && c.trim() !== "")
        : [],
    };
  } catch {
    return { accounted: [], finished: false, containerCodes: [] };
  }
}

function describeLine(l: LabUsageResult["lines"][number]): string {
  if (!l.tests) return `${l.quantity}${l.inPieces ? " pieces of" : " x"} ${l.itemName}`;
  const parts = [`${l.quantity} ${l.quantity === 1 ? "test" : "tests"}`];
  for (const a of l.accounted) parts.push(`${a.quantity} for ${a.reason.toLowerCase()}`);
  const left =
    l.remaining && l.remaining > 0
      ? ` (${l.remaining.toLocaleString("en-GB")} ${l.remaining === 1 ? "test" : "tests"} left in the open container)`
      : "";
  const opened = l.openedContainers.length > 0 ? ` [opened ${l.openedContainers.join(", ")}]` : "";
  return `${l.itemName}: ${parts.join(", ")}${left}${opened}`;
}

/**
 * Record what the lab used at the bench. The lines are the items and quantities the person entered: the form sends
 * them as paired itemTypeId / lineQuantity / lineExtra fields, in the same order. There is no patient.
 */
export async function recordUsageAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const session = await requirePermission("record_usage");
  const raw = formDataToObject(formData);
  const ids = formData.getAll("itemTypeId").map(String);
  const quantities = formData.getAll("lineQuantity").map(String);
  const extras = formData.getAll("lineExtra").map(String);
  const items = ids
    .map((itemTypeId, i) => ({ itemTypeId, quantity: quantities[i], ...parseExtra(extras[i]) }))
    .filter((line) => line.itemTypeId.trim() !== "");
  try {
    const result = await recordLabUsage(
      {
        items: items as never,
        usedOn: raw.usedOn as string | undefined,
        section: raw.section as string | undefined,
        locationId: raw.locationId as string | undefined,
      },
      session,
    );
    revalidatePath(PATH);
    const used = result.lines.map(describeLine).join("; ");
    return {
      message: `Recorded as used on ${result.usedOn}${result.section ? ` for ${result.section}` : ""}: ${used}.`,
    };
  } catch (err) {
    return toFormError(err);
  }
}
