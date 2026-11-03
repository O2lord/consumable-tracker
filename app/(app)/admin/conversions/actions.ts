"use server";

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/server/auth/session";
import { createRecipe, setRecipeActive, updateRecipe } from "@/server/services/conversion.service";
import { toFormError } from "@/server/actions/form-result";
import { formDataToObject, issuesToMessage } from "@/lib/form";
import { setActiveSchema } from "@/types/admin";
import { recipeInputSchema, recipeUpdateSchema } from "@/types/conversion";
import type { FormState } from "@/components/forms/form-state";

const PATH = "/admin/conversions";

export async function createRecipeAction(_prev: FormState, formData: FormData): Promise<FormState> {
  await requirePermission("manage_conversions");
  const parsed = recipeInputSchema.safeParse(formDataToObject(formData));
  if (!parsed.success) return { error: issuesToMessage(parsed.error) };
  try {
    await createRecipe(parsed.data);
  } catch (err) {
    return toFormError(err);
  }
  revalidatePath(PATH);
  revalidatePath("/lab/conversion");
  return { message: `Recipe ${parsed.data.code} created.` };
}

export async function updateRecipeAction(_prev: FormState, formData: FormData): Promise<FormState> {
  await requirePermission("manage_conversions");
  const parsed = recipeUpdateSchema.safeParse(formDataToObject(formData));
  if (!parsed.success) return { error: issuesToMessage(parsed.error) };
  try {
    await updateRecipe(parsed.data);
  } catch (err) {
    return toFormError(err);
  }
  revalidatePath(PATH);
  revalidatePath("/lab/conversion");
  return { message: "Saved." };
}

export async function setRecipeActiveAction(_prev: FormState, formData: FormData): Promise<FormState> {
  await requirePermission("manage_conversions");
  const parsed = setActiveSchema.safeParse(formDataToObject(formData));
  if (!parsed.success) return { error: issuesToMessage(parsed.error) };
  try {
    await setRecipeActive(parsed.data.id, parsed.data.active);
  } catch (err) {
    return toFormError(err);
  }
  revalidatePath(PATH);
  // The Conversion page lists active recipes, so it must refresh too.
  revalidatePath("/lab/conversion");
  return { message: "Saved." };
}
