// Shape of what a form server action returns. Kept free of "use client"/"use server"
// so both sides can import it.
export interface FormState {
  /** Shown in red under the form. */
  error?: string;
  /** Shown in green after a successful save. */
  message?: string;
}
