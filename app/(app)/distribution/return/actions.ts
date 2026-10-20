"use server";

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/server/auth/session";
import { returnQuantity, returnUnit } from "@/server/services/return.service";
import { toFormError } from "@/server/actions/form-result";
import { formDataToObject } from "@/lib/form";
import type { FormState } from "@/components/forms/form-state";

const PATH = "/distribution/return";

const BECAME: Record<string, string> = {
  RETURNED: "marked as used and closed",
  IN_STOCK: "put back in stock, ready to issue again",
  VOIDED: "voided",
};

/** A bottle comes back: used, unused and intact, or unusable. */
export async function returnUnitAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const session = await requirePermission("return");
  const raw = formDataToObject(formData);
  try {
    const r = await returnUnit(
      {
        serial: String(raw.serial ?? ""),
        outcome: raw.outcome as never,
        reasonCode: raw.reasonCode as string | undefined,
        note: raw.note as string | undefined,
        locationId: raw.locationId as string | undefined,
      },
      session,
    );
    revalidatePath(PATH);
    const reuseOff = r.outcome === "UNUSED" && r.became === "VOIDED";
    return {
      message: `${r.serial} ${BECAME[r.became]}.${reuseOff ? " This location does not reuse unused bottles, so it was voided as unused." : ""}`,
    };
  } catch (err) {
    return toFormError(err);
  }
}

/** Bulk items come back: unused goes back on the shelf, wasted needs a reason. */
export async function returnQuantityAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const session = await requirePermission("return");
  const raw = formDataToObject(formData);
  try {
    const r = await returnQuantity(
      {
        batch: String(raw.batch ?? ""),
        quantity: Number(raw.quantity) as never,
        outcome: raw.outcome as never,
        reasonCode: raw.reasonCode as string | undefined,
        note: raw.note as string | undefined,
        locationId: raw.locationId as string | undefined,
      },
      session,
    );
    revalidatePath(PATH);
    return {
      message:
        r.outcome === "WASTED"
          ? `${r.quantity} x ${r.itemName} (${r.batchCode}) recorded as wasted.`
          : `${r.quantity} x ${r.itemName} (${r.batchCode}) put back in stock.`,
    };
  } catch (err) {
    return toFormError(err);
  }
}
