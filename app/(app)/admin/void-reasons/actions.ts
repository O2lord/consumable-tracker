"use server";

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/server/auth/session";
import { createVoidReason, setVoidReasonActive, updateVoidReason } from "@/server/services/catalog.service";
import { toFormError } from "@/server/actions/form-result";
import { formDataToObject, issuesToMessage } from "@/lib/form";
import { setActiveSchema, voidReasonInputSchema, voidReasonUpdateSchema } from "@/types/admin";
import type { FormState } from "@/components/forms/form-state";

const PATH = "/admin/void-reasons";

export async function createVoidReasonAction(_prev: FormState, formData: FormData): Promise<FormState> {
  await requirePermission("manage_void_reasons");
  const parsed = voidReasonInputSchema.safeParse(formDataToObject(formData));
  if (!parsed.success) return { error: issuesToMessage(parsed.error) };
  try {
    await createVoidReason(parsed.data);
  } catch (err) {
    return toFormError(err);
  }
  revalidatePath(PATH);
  return { message: `Void reason ${parsed.data.code} created.` };
}

export async function updateVoidReasonAction(_prev: FormState, formData: FormData): Promise<FormState> {
  await requirePermission("manage_void_reasons");
  const parsed = voidReasonUpdateSchema.safeParse(formDataToObject(formData));
  if (!parsed.success) return { error: issuesToMessage(parsed.error) };
  try {
    await updateVoidReason(parsed.data.id, parsed.data.label);
  } catch (err) {
    return toFormError(err);
  }
  revalidatePath(PATH);
  return { message: "Saved." };
}

export async function setVoidReasonActiveAction(_prev: FormState, formData: FormData): Promise<FormState> {
  await requirePermission("manage_void_reasons");
  const parsed = setActiveSchema.safeParse(formDataToObject(formData));
  if (!parsed.success) return { error: issuesToMessage(parsed.error) };
  try {
    await setVoidReasonActive(parsed.data.id, parsed.data.active);
  } catch (err) {
    return toFormError(err);
  }
  revalidatePath(PATH);
  return { message: "Saved." };
}
