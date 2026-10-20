"use server";

import { redirect } from "next/navigation";
import { signIn } from "@/server/auth/session";

export interface LoginState {
  error?: string;
}

export async function loginAction(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const staffId = String(formData.get("staffId") ?? "");
  const password = String(formData.get("password") ?? "");

  const result = await signIn(staffId, password);
  if (!result.ok) return { error: result.message };

  redirect("/dashboard");
}
