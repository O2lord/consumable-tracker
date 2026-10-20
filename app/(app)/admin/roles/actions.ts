"use server";

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/server/auth/session";
import { createRole, deleteRole, updateRole } from "@/server/services/roles.service";
import { toFormError } from "@/server/actions/form-result";
import { formDataToObject, issuesToMessage } from "@/lib/form";
import { roleDeleteSchema, roleInputSchema, roleUpdateSchema } from "@/types/admin";
import type { FormState } from "@/components/forms/form-state";

const PATH = "/admin/roles";

/** The form's fields, with every ticked permission (a repeated field, so formDataToObject would keep only one). */
function roleFields(formData: FormData): Record<string, unknown> {
  return { ...formDataToObject(formData), permissions: formData.getAll("permissions") };
}

export async function createRoleAction(_prev: FormState, formData: FormData): Promise<FormState> {
  await requirePermission("manage_roles");
  const parsed = roleInputSchema.safeParse(roleFields(formData));
  if (!parsed.success) return { error: issuesToMessage(parsed.error) };
  try {
    await createRole(parsed.data);
  } catch (err) {
    return toFormError(err);
  }
  revalidatePath(PATH);
  revalidatePath("/admin/users");
  return { message: `Role ${parsed.data.name} created. You can now give it to people under Users.` };
}

export async function updateRoleAction(_prev: FormState, formData: FormData): Promise<FormState> {
  await requirePermission("manage_roles");
  const parsed = roleUpdateSchema.safeParse(roleFields(formData));
  if (!parsed.success) return { error: issuesToMessage(parsed.error) };
  try {
    await updateRole(parsed.data);
  } catch (err) {
    return toFormError(err);
  }
  revalidatePath(PATH);
  revalidatePath("/admin/users");
  return { message: "Saved. People with this role see the change the next time they load a page." };
}

export async function deleteRoleAction(_prev: FormState, formData: FormData): Promise<FormState> {
  await requirePermission("manage_roles");
  const parsed = roleDeleteSchema.safeParse(formDataToObject(formData));
  if (!parsed.success) return { error: issuesToMessage(parsed.error) };
  try {
    await deleteRole(parsed.data.code);
  } catch (err) {
    return toFormError(err);
  }
  revalidatePath(PATH);
  revalidatePath("/admin/users");
  return { message: "Role deleted." };
}
