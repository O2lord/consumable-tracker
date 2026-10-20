"use client";

import { useActionState } from "react";
import { buttonClass, inputClass } from "@/components/ui/styles";
import { loginAction, type LoginState } from "./actions";

const initialState: LoginState = {};

export function LoginForm() {
  const [state, formAction, pending] = useActionState(loginAction, initialState);

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <label className="flex flex-col gap-1 text-sm font-medium">
        Staff ID
        <input
          name="staffId"
          type="text"
          autoComplete="username"
          autoCapitalize="characters"
          autoFocus
          required
          className={inputClass}
        />
      </label>
      <label className="flex flex-col gap-1 text-sm font-medium">
        Password
        <input
          name="password"
          type="password"
          autoComplete="current-password"
          required
          className={inputClass}
        />
      </label>
      {state.error ? (
        <p role="alert" className="text-sm text-bad">
          {state.error}
        </p>
      ) : null}
      <button
        type="submit"
        disabled={pending}
        className={buttonClass}
      >
        {pending ? "Signing in..." : "Sign in"}
      </button>
    </form>
  );
}
