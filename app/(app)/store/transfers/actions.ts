"use server";

import { redirect } from "next/navigation";
import { requirePermission } from "@/server/auth/session";
import { createTransfer } from "@/server/services/transfer.service";
import { toFormError } from "@/server/actions/form-result";
import { formDataToObject, issuesToMessage } from "@/lib/form";
import { createTransferSchema } from "@/types/transfers";
import type { FormState } from "@/components/forms/form-state";

export async function createTransferAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const session = await requirePermission("dispatch");

  const raw = formDataToObject(formData);
  const parsed = createTransferSchema.safeParse({
    ...raw,
    pharmacyQuantity: raw.pharmacyQuantity === undefined ? undefined : Number(raw.pharmacyQuantity),
  });
  if (!parsed.success) return { error: issuesToMessage(parsed.error) };

  let code: string;
  try {
    code = (await createTransfer(parsed.data, session.userId)).code;
  } catch (err) {
    return toFormError(err);
  }
  // redirect() works by throwing, so it must stay outside the try block.
  redirect(`/store/transfers/${code}`);
}
