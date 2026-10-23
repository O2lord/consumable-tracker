// Shape of what a form server action returns. Kept free of "use client"/"use server"
// so both sides can import it.
export interface FormState {
  /** Shown in red under the form. */
  error?: string;
  /** Shown in green after a successful save. */
  message?: string;
  /** The bottle an issue was saved for, so the page can open its label. */
  serial?: string;
  /** Every bottle an "issue all" run saved, in order. With an `error` too, the run stopped part-way. */
  serials?: string[];
  /** The containers of those bottles (EDTA, PLAIN...), so the pop-up knows which are done. */
  containers?: string[];
}
