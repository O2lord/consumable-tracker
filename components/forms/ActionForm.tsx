"use client";

import { startTransition, useActionState, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { FormState } from "./form-state";
import { buttonClass, compactDangerButtonClass, dangerButtonClass, ghostButtonClass } from "../ui/styles";
import { Modal } from "../ui/Modal";
import { useToast } from "../ui/Toast";
import { useFormDialog } from "./FormDialog";

interface Props {
  action: (prev: FormState, formData: FormData) => Promise<FormState>;
  children: ReactNode;
  submitLabel: string;
  /** Clear the fields after a successful save (default true). */
  resetOnSuccess?: boolean;
  className?: string;
  /** Smaller button, for use inside table rows. */
  compact?: boolean;
  /** Ask "Are you sure?" before submitting. */
  confirm?: string;
  /** Replace the submit button's classes. */
  buttonClassName?: string;
  /** A destructive action (deactivate, remove, void): the button and its confirmation button are red. */
  danger?: boolean;
  /** Grey out the submit button, for example while there is nothing to submit yet. */
  disabled?: boolean;
  /**
   * Moves the submit button (and its error or status line) out of the bottom of the form into a bar at the top,
   * button on the right and this content on the left. The bar stays in view while a long form scrolls, so the
   * person never has to scroll back to save.
   */
  topBar?: ReactNode;
  /** Replace the top bar's classes, for example to match the background of the card it sits in. */
  topBarClassName?: string;
  /** Extra buttons shown in the same row as the submit button (for example a Cancel next to Post). */
  extraActions?: ReactNode;
}

/**
 * A form wired to a server action with pending state and an error/success line.
 * It submits through onSubmit rather than the `action` prop on purpose: React resets the form
 * after an `action` submit even when it failed, which would wipe what the person typed.
 */
export function ActionForm({
  action,
  children,
  submitLabel,
  resetOnSuccess = true,
  className,
  compact = false,
  confirm,
  buttonClassName,
  danger = false,
  disabled = false,
  topBar,
  topBarClassName,
  extraActions,
}: Props) {
  const [state, formAction, pending] = useActionState(action, {} as FormState);
  const formRef = useRef<HTMLFormElement>(null);
  const dialog = useFormDialog();
  const toast = useToast();
  // The form data waiting for the person to confirm. Not null while the confirmation pop-up is open.
  const [awaiting, setAwaiting] = useState<FormData | null>(null);

  useEffect(() => {
    if (resetOnSuccess && state.message && !state.error) formRef.current?.reset();
  }, [state, resetOnSuccess]);

  // A saved form shows its confirmation as a toast, and inside a pop-up it also closes the pop-up.
  useEffect(() => {
    if (state.message && !state.error) {
      toast?.success(state.message);
      dialog?.succeeded(state.message);
    }
  }, [state, dialog, toast]);

  const submitButton = (
    <button
      type="submit"
      disabled={pending || disabled}
      className={
        buttonClassName ??
        (danger
          ? compact
            ? compactDangerButtonClass
            : dangerButtonClass
          : compact
            ? "rounded-lg border border-line bg-surface px-2 py-1 text-xs text-ink hover:bg-brand-soft disabled:opacity-60"
            : buttonClass)
      }
    >
      {pending ? "Saving..." : submitLabel}
    </button>
  );
  const feedback = (
    <>
      {state.error ? (
        <p role="alert" className="text-sm text-red-600">
          {state.error}
        </p>
      ) : null}
      {state.message && !state.error && !toast ? (
        <p role="status" className="text-sm text-green-700">
          {state.message}
        </p>
      ) : null}
    </>
  );

  return (
    <>
      <form
        ref={formRef}
        className={className ?? "flex flex-col gap-3"}
        onSubmit={(event) => {
          event.preventDefault();
          const data = new FormData(event.currentTarget);
          if (confirm) {
            setAwaiting(data); // ask first, in our own pop-up rather than the browser's
            return;
          }
          startTransition(() => formAction(data));
        }}
      >
        {topBar !== undefined ? (
          <div className={topBarClassName ?? "sticky top-0 z-20 flex flex-wrap items-center justify-between gap-3 bg-page py-2"}>
            <div className="min-w-0 text-sm text-zinc-500">{topBar}</div>
            <div className="flex flex-wrap items-center justify-end gap-3">
              {feedback}
              {extraActions}
              {submitButton}
            </div>
          </div>
        ) : null}
        {children}
        {topBar === undefined ? (
          <div className="flex flex-wrap items-center gap-3">
            {submitButton}
            {extraActions}
            {feedback}
          </div>
        ) : null}
      </form>

      {awaiting && confirm
        ? createPortal(
            <Modal title="Please confirm" narrow closeButton={false} onClose={() => setAwaiting(null)}>
              <p className="text-sm leading-relaxed">{confirm}</p>
              <div className="mt-5 flex justify-end gap-2">
                <button type="button" onClick={() => setAwaiting(null)} className={`${ghostButtonClass} py-2`}>
                  Cancel
                </button>
                <button
                  type="button"
                  className={danger ? dangerButtonClass : buttonClass}
                  onClick={() => {
                    const data = awaiting;
                    setAwaiting(null);
                    startTransition(() => formAction(data));
                  }}
                >
                  {submitLabel}
                </button>
              </div>
            </Modal>,
            document.body,
          )
        : null}
    </>
  );
}
