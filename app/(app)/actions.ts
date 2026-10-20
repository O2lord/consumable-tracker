"use server";

import { redirect } from "next/navigation";
import { signOut } from "@/server/auth/session";

export async function logoutAction(): Promise<void> {
  await signOut();
  redirect("/login");
}
