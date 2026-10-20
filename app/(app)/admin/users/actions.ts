"use server";

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/server/auth/session";
import { createUser, resetUserPassword, setUserActive, updateUser } from "@/server/services/users.service";
import { toFormError } from "@/server/actions/form-result";
import { formDataToObject, issuesToMessage } from "@/lib/form";
import { passwordResetSchema, setActiveSchema, userCreateSchema, userUpdateSchema } from "@/types/admin";
import type { FormState } from "@/components/forms/form-state";

const PATH = "/admin/users";

export async function createUserAction(_prev: FormState, formData: FormData): Promise<FormState> {
  await requirePermission("manage_users");
  const parsed = userCreateSchema.safeParse(formDataToObject(formData));
  if (!parsed.success) return { error: issuesToMessage(parsed.error) };
  try {
    await createUser(parsed.data);
  } catch (err) {
    return toFormError(err);
  }
  revalidatePath(PATH);
  return { message: `Account ${parsed.data.staffId} created. Give them the password in person.` };
}

export async function updateUserAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const session = await requirePermission("manage_users");
  const parsed = userUpdateSchema.safeParse(formDataToObject(formData));
  if (!parsed.success) return { error: issuesToMessage(parsed.error) };
  try {
    await updateUser(parsed.data, session.userId);
  } catch (err) {
    return toFormError(err);
  }
  revalidatePath(PATH);
  return { message: "Saved." };
}

export async function setUserActiveAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const session = await requirePermission("manage_users");
  const parsed = setActiveSchema.safeParse(formDataToObject(formData));
  if (!parsed.success) return { error: issuesToMessage(parsed.error) };
  try {
    await setUserActive(parsed.data.id, parsed.data.active, session.userId);
  } catch (err) {
    return toFormError(err);
  }
  revalidatePath(PATH);
  return { message: "Saved." };
}

export async function resetPasswordAction(_prev: FormState, formData: FormData): Promise<FormState> {
  await requirePermission("manage_users");
  const parsed = passwordResetSchema.safeParse(formDataToObject(formData));
  if (!parsed.success) return { error: issuesToMessage(parsed.error) };
  try {
    await resetUserPassword(parsed.data.id, parsed.data.password);
  } catch (err) {
    return toFormError(err);
  }
  return { message: "Password changed." };
}
