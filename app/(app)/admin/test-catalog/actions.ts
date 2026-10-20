"use server";

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/server/auth/session";
import {
  createTestWithItems,
  setTestActive,
  setTestStandardItems,
  updateTest,
  updateTestWithItems,
} from "@/server/services/policy.service";
import { toFormError } from "@/server/actions/form-result";
import { formDataToObject, issuesToMessage } from "@/lib/form";
import { setActiveSchema } from "@/types/admin";
import { testInputSchema, testStandardItemsSchema, testUpdateSchema } from "@/types/issue";
import type { FormState } from "@/components/forms/form-state";

const PATH = "/admin/test-catalog";
const CHECKBOXES = ["containersConfirmed"] as const;

/** The paired itemTypeId / quantity fields the items editor submits, checked as a list of lines. */
function parseStandardItems(formData: FormData, consumptionConfirmed: unknown) {
  const ids = formData.getAll("itemTypeId").map(String);
  const quantities = formData.getAll("quantity").map(String);
  const items = ids.map((itemTypeId, i) => ({ itemTypeId, quantity: quantities[i] })).filter((line) => line.itemTypeId.trim() !== "");
  return testStandardItemsSchema.omit({ testId: true }).safeParse({ items, consumptionConfirmed });
}

export async function createTestAction(_prev: FormState, formData: FormData): Promise<FormState> {
  await requirePermission("manage_test_catalog");
  const raw = formDataToObject(formData, [...CHECKBOXES, "consumptionConfirmed"]);
  const parsed = testInputSchema.safeParse(raw);
  if (!parsed.success) return { error: issuesToMessage(parsed.error) };
  const standard = parseStandardItems(formData, raw.consumptionConfirmed);
  if (!standard.success) return { error: issuesToMessage(standard.error) };
  try {
    await createTestWithItems(parsed.data, standard.data);
  } catch (err) {
    return toFormError(err);
  }
  revalidatePath(PATH);
  return { message: `Test ${parsed.data.code} added.` };
}

export async function updateTestAction(_prev: FormState, formData: FormData): Promise<FormState> {
  await requirePermission("manage_test_catalog");
  const parsed = testUpdateSchema.safeParse(formDataToObject(formData, CHECKBOXES));
  if (!parsed.success) return { error: issuesToMessage(parsed.error) };
  try {
    await updateTest(parsed.data);
  } catch (err) {
    return toFormError(err);
  }
  revalidatePath(PATH);
  return { message: "Saved." };
}

/** Save the items one run of a test uses. The form sends paired itemTypeId / quantity fields, in the same order. */
export async function setStandardItemsAction(_prev: FormState, formData: FormData): Promise<FormState> {
  await requirePermission("manage_test_catalog");
  const raw = formDataToObject(formData, ["consumptionConfirmed"]);
  const ids = formData.getAll("itemTypeId").map(String);
  const quantities = formData.getAll("quantity").map(String);
  const items = ids.map((itemTypeId, i) => ({ itemTypeId, quantity: quantities[i] })).filter((line) => line.itemTypeId.trim() !== "");
  const parsed = testStandardItemsSchema.safeParse({
    testId: raw.testId,
    items,
    consumptionConfirmed: raw.consumptionConfirmed,
  });
  if (!parsed.success) return { error: issuesToMessage(parsed.error) };
  try {
    await setTestStandardItems(parsed.data);
  } catch (err) {
    return toFormError(err);
  }
  revalidatePath(PATH);
  revalidatePath("/distribution/issue");
  return { message: "Saved." };
}

/**
 * Save everything about one test from a single form: its name and containers, and the items one run uses.
 * Both parts are validated before anything is written, so a typo in one never leaves the other half-saved.
 */
export async function saveTestAction(_prev: FormState, formData: FormData): Promise<FormState> {
  await requirePermission("manage_test_catalog");
  const raw = formDataToObject(formData, ["containersConfirmed", "consumptionConfirmed"]);
  const details = testUpdateSchema.safeParse(raw);
  if (!details.success) return { error: issuesToMessage(details.error) };

  const standard = parseStandardItems(formData, raw.consumptionConfirmed);
  if (!standard.success) return { error: issuesToMessage(standard.error) };

  try {
    await updateTestWithItems(details.data, standard.data);
  } catch (err) {
    return toFormError(err);
  }
  revalidatePath(PATH);
  revalidatePath("/distribution/issue");
  return { message: "Saved." };
}

export async function setTestActiveAction(_prev: FormState, formData: FormData): Promise<FormState> {
  await requirePermission("manage_test_catalog");
  const parsed = setActiveSchema.safeParse(formDataToObject(formData));
  if (!parsed.success) return { error: issuesToMessage(parsed.error) };
  try {
    await setTestActive(parsed.data.id, parsed.data.active);
  } catch (err) {
    return toFormError(err);
  }
  revalidatePath(PATH);
  return { message: "Saved." };
}
