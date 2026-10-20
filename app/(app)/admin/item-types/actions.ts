"use server";

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/server/auth/session";
import { createItemType, setItemTypeActive, updateItemType } from "@/server/services/catalog.service";
import { toFormError } from "@/server/actions/form-result";
import { formDataToObject, issuesToMessage } from "@/lib/form";
import { itemTypeInputSchema, itemTypeUpdateSchema, setActiveSchema } from "@/types/admin";
import type { FormState } from "@/components/forms/form-state";

const PATH = "/admin/item-types";
const CHECKBOXES = ["packSizeConfirmed", "coldStorage", "benchSupply"] as const;
const MULTI = ["allowedServiceRoles"] as const;

export async function createItemTypeAction(_prev: FormState, formData: FormData): Promise<FormState> {
  await requirePermission("manage_item_types");
  const parsed = itemTypeInputSchema.safeParse(formDataToObject(formData, CHECKBOXES, MULTI));
  if (!parsed.success) return { error: issuesToMessage(parsed.error) };
  try {
    await createItemType(parsed.data);
  } catch (err) {
    return toFormError(err);
  }
  revalidatePath(PATH);
  return { message: `Item type ${parsed.data.code} created.` };
}

export async function updateItemTypeAction(_prev: FormState, formData: FormData): Promise<FormState> {
  await requirePermission("manage_item_types");
  const parsed = itemTypeUpdateSchema.safeParse(formDataToObject(formData, CHECKBOXES, MULTI));
  if (!parsed.success) return { error: issuesToMessage(parsed.error) };
  try {
    await updateItemType(parsed.data);
  } catch (err) {
    return toFormError(err);
  }
  revalidatePath(PATH);
  return { message: "Saved." };
}

export async function setItemTypeActiveAction(_prev: FormState, formData: FormData): Promise<FormState> {
  await requirePermission("manage_item_types");
  const parsed = setActiveSchema.safeParse(formDataToObject(formData));
  if (!parsed.success) return { error: issuesToMessage(parsed.error) };
  try {
    await setItemTypeActive(parsed.data.id, parsed.data.active);
  } catch (err) {
    return toFormError(err);
  }
  revalidatePath(PATH);
  return { message: "Saved." };
}
