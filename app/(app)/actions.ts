"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireSession, signOut } from "@/server/auth/session";
import { setWorkLocation } from "@/server/services/work-location.service";
import { toFormError } from "@/server/actions/form-result";

export async function logoutAction(): Promise<void> {
  await signOut();
  redirect("/login");
}

const locationIdSchema = z.uuid();

/**
 * Sets where a supervisor or admin is working, from the switcher in the app bar. Everything under (app) shows
 * the new place at once, so the whole layout is revalidated, not one page.
 */
export async function setWorkLocationAction(locationId: string): Promise<{ error?: string }> {
  const session = await requireSession();
  const parsed = locationIdSchema.safeParse(locationId);
  if (!parsed.success) return { error: "Choose a location from the list" };
  try {
    await setWorkLocation(session, parsed.data);
  } catch (err) {
    return { error: toFormError(err).error };
  }
  revalidatePath("/", "layout");
  return {};
}
