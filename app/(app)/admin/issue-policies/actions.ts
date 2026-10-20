"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requirePermission } from "@/server/auth/session";
import { deletePolicy, savePolicy } from "@/server/services/policy.service";
import { toFormError } from "@/server/actions/form-result";
import { formDataToObject, issuesToMessage } from "@/lib/form";
import { policyInputSchema } from "@/types/issue";
import type { FormState } from "@/components/forms/form-state";

const PATH = "/admin/issue-policies";

export async function savePolicyAction(_prev: FormState, formData: FormData): Promise<FormState> {
  await requirePermission("manage_policies");
  const parsed = policyInputSchema.safeParse(formDataToObject(formData));
  if (!parsed.success) return { error: issuesToMessage(parsed.error) };
  try {
    await savePolicy(parsed.data);
  } catch (err) {
    return toFormError(err);
  }
  revalidatePath(PATH);
  return { message: "Policy saved." };
}

export async function deletePolicyAction(_prev: FormState, formData: FormData): Promise<FormState> {
  await requirePermission("manage_policies");
  const parsed = z.object({ id: z.uuid() }).safeParse(formDataToObject(formData));
  if (!parsed.success) return { error: issuesToMessage(parsed.error) };
  try {
    await deletePolicy(parsed.data.id);
  } catch (err) {
    return toFormError(err);
  }
  revalidatePath(PATH);
  return { message: "Policy removed." };
}
