"use server";

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/server/auth/session";
import { createLocation, setLocationActive, updateLocation } from "@/server/services/catalog.service";
import { toFormError } from "@/server/actions/form-result";
import { formDataToObject, issuesToMessage } from "@/lib/form";
import { locationInputSchema, locationUpdateSchema, setActiveSchema } from "@/types/admin";
import type { FormState } from "@/components/forms/form-state";

const PATH = "/admin/locations";

export async function createLocationAction(_prev: FormState, formData: FormData): Promise<FormState> {
  await requirePermission("manage_locations");
  const parsed = locationInputSchema.safeParse(formDataToObject(formData, ["allowUnusedReuse"]));
  if (!parsed.success) return { error: issuesToMessage(parsed.error) };
  try {
    await createLocation(parsed.data);
  } catch (err) {
    return toFormError(err);
  }
  revalidatePath(PATH);
  return { message: `Location ${parsed.data.code} created.` };
}

export async function updateLocationAction(_prev: FormState, formData: FormData): Promise<FormState> {
  await requirePermission("manage_locations");
  const parsed = locationUpdateSchema.safeParse(formDataToObject(formData, ["allowUnusedReuse"]));
  if (!parsed.success) return { error: issuesToMessage(parsed.error) };
  try {
    await updateLocation(parsed.data);
  } catch (err) {
    return toFormError(err);
  }
  revalidatePath(PATH);
  return { message: "Saved." };
}

export async function setLocationActiveAction(_prev: FormState, formData: FormData): Promise<FormState> {
  await requirePermission("manage_locations");
  const parsed = setActiveSchema.safeParse(formDataToObject(formData));
  if (!parsed.success) return { error: issuesToMessage(parsed.error) };
  try {
    await setLocationActive(parsed.data.id, parsed.data.active);
  } catch (err) {
    return toFormError(err);
  }
  revalidatePath(PATH);
  return { message: "Saved." };
}
