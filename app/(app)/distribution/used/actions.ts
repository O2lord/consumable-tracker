"use server";

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/server/auth/session";
import { recordLabUsage } from "@/server/services/lab-usage.service";
import { toFormError } from "@/server/actions/form-result";
import { formDataToObject } from "@/lib/form";
import type { FormState } from "@/components/forms/form-state";

const PATH = "/distribution/used";

/**
 * Record what the lab used at the bench. The lines are the items and quantities the person entered: the form sends
 * them as paired itemTypeId / lineQuantity fields, in the same order. There is no patient.
 */
export async function recordUsageAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const session = await requirePermission("record_usage");
  const raw = formDataToObject(formData);
  const ids = formData.getAll("itemTypeId").map(String);
  const quantities = formData.getAll("lineQuantity").map(String);
  const items = ids
    .map((itemTypeId, i) => ({ itemTypeId, quantity: quantities[i] }))
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
    const used = result.lines.map((l) => `${l.quantity}${l.inPieces ? " pieces of" : " x"} ${l.itemName}`).join(", ");
    return {
      message: `Recorded as used on ${result.usedOn}${result.section ? ` for ${result.section}` : ""}: ${used}.`,
    };
  } catch (err) {
    return toFormError(err);
  }
}
