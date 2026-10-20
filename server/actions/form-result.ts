import "server-only";
import { DomainError } from "../domain/errors";
import type { FormState } from "../../components/forms/form-state";

/** Turns anything a service throws into a message for the form. Unknown errors are logged, not shown. */
export function toFormError(err: unknown): FormState {
  if (err instanceof DomainError) return { error: err.message };
  console.error(err);
  return { error: "Something went wrong. Nothing was saved. Try again, and tell an admin if it keeps happening." };
}
