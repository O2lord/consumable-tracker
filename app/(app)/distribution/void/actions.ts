"use server";

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/server/auth/session";
import { voidQuantity, voidUnit } from "@/server/services/void.service";
import { toFormError } from "@/server/actions/form-result";
import { formDataToObject } from "@/lib/form";
import type { FormState } from "@/components/forms/form-state";

const PATH = "/distribution/void";

/** Void a bottle outside the return flow: expired or damaged on the shelf, or its investigation was cancelled. */
export async function voidUnitAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const session = await requirePermission("void");
  const raw = formDataToObject(formData);
  try {
    const r = await voidUnit(
      {
        serial: String(raw.serial ?? ""),
        reasonCode: String(raw.reasonCode ?? ""),
        note: raw.note as string | undefined,
        locationId: raw.locationId as string | undefined,
      },
      session,
    );
    revalidatePath(PATH);
    return { message: `${r.serial} voided (${r.reasonCode}).${r.wasIssued ? " Its issue was closed." : ""}` };
  } catch (err) {
    return toFormError(err);
  }
}

/** Write off a quantity found wasted or expired on the shelf. */
export async function voidQuantityAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const session = await requirePermission("void");
  const raw = formDataToObject(formData);
  try {
    const r = await voidQuantity(
      {
        batch: String(raw.batch ?? ""),
        quantity: Number(raw.quantity) as never,
        reasonCode: String(raw.reasonCode ?? ""),
        note: raw.note as string | undefined,
        locationId: raw.locationId as string | undefined,
      },
      session,
    );
    revalidatePath(PATH);
    return { message: `${r.quantity} x ${r.itemName} (${r.batchCode}) written off (${r.reasonCode}).` };
  } catch (err) {
    return toFormError(err);
  }
}
