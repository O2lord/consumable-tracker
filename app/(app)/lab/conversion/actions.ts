"use server";

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/server/auth/session";
import { previewConversion, recordConversion, voidConversion, type ConversionPreview } from "@/server/services/conversion.service";
import { toFormError } from "@/server/actions/form-result";
import { formDataToObject, issuesToMessage } from "@/lib/form";
import { formatDay } from "@/lib/dashboard";
import { conversionInputSchema, voidConversionSchema } from "@/types/conversion";
import type { FormState } from "@/components/forms/form-state";

const PATH = "/lab/conversion";

export type PreviewResult = { ok: true; preview: ConversionPreview } | { ok: false; error: string };

/**
 * What a conversion would do, for the live preview in the pop-up: the amount made, its expiry and the code it will
 * carry. Read-only, so it writes nothing. A refusal (not a whole amount, not enough stock) comes back as text to show
 * under the amount, the same text a real conversion would refuse with.
 */
export async function previewConversionAction(input: {
  recipeId: string;
  inputQuantity: string;
  locationId?: string;
}): Promise<PreviewResult> {
  const session = await requirePermission("record_conversion");
  const parsed = conversionInputSchema.safeParse({
    recipeId: input.recipeId,
    inputQuantity: input.inputQuantity,
    locationId: input.locationId || undefined,
  });
  if (!parsed.success) return { ok: false, error: issuesToMessage(parsed.error) };
  try {
    return { ok: true, preview: await previewConversion(parsed.data, session) };
  } catch (err) {
    return { ok: false, error: toFormError(err).error ?? "Could not check this just now." };
  }
}

/**
 * Records the conversion. The form sends the recipe, the amount to take and the code the preview showed; the amount
 * made and the expiry are worked out again on the server, so only the amount taken is trusted from the screen.
 */
export async function recordConversionAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const session = await requirePermission("record_conversion");
  const parsed = conversionInputSchema.safeParse(formDataToObject(formData));
  if (!parsed.success) return { error: issuesToMessage(parsed.error) };
  try {
    const r = await recordConversion(parsed.data, session);
    revalidatePath(PATH);
    const n = (v: number) => v.toLocaleString("en-GB");
    const expires = r.expiryDate ? `expires ${formatDay(r.expiryDate)}` : "does not expire";
    return {
      message: `Converted ${n(r.inputQuantity)} ${r.measureLabel} of ${r.inputItemName} into ${n(r.outputQuantity)} ${r.measureLabel} of ${r.outputItemName}. Label code ${r.code}, ${expires}.`,
    };
  } catch (err) {
    return toFormError(err);
  }
}

/**
 * Voids a conversion made by mistake: the input goes back on the shelf and the output comes off it, by new ledger
 * events. The server refuses when any of the stock made has already been used or moved.
 */
export async function voidConversionAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const session = await requirePermission("void");
  const parsed = voidConversionSchema.safeParse(formDataToObject(formData));
  if (!parsed.success) return { error: issuesToMessage(parsed.error) };
  try {
    const r = await voidConversion(parsed.data, session);
    revalidatePath(PATH);
    const n = (v: number) => v.toLocaleString("en-GB");
    return {
      message: `Voided ${r.code}. ${n(r.inputQuantity)} ${r.measureLabel} of ${r.inputItemName} is back on the shelf and ${n(r.outputQuantity)} ${r.measureLabel} of ${r.outputItemName} is gone.`,
    };
  } catch (err) {
    return toFormError(err);
  }
}
