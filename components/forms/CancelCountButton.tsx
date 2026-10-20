"use client";

import { startTransition, useState } from "react";
import { createPortal } from "react-dom";
import type { FormState } from "./form-state";
import { Modal } from "../ui/Modal";
import { dangerButtonClass, ghostButtonClass } from "../ui/styles";

/**
 * A red "Cancel this count" button that can sit in the same row as the Post button. It is a plain button rather than
 * a form of its own, because the Post button lives inside a form and forms cannot be nested. It asks first, then runs
 * the cancel action (which redirects back to the counts page on success).
 */
export function CancelCountButton({
  countId,
  action,
}: {
  countId: string;
  action: (prev: FormState, formData: FormData) => Promise<FormState>;
}) {
  const [asking, setAsking] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function run() {
    setAsking(false);
    setError(null);
    setPending(true);
    const data = new FormData();
    data.set("countId", countId);
    startTransition(async () => {
      try {
        const result = await action({}, data);
        if (result?.error) setError(result.error);
      } finally {
        setPending(false);
      }
    });
  }

  return (
    <>
      <button type="button" disabled={pending} onClick={() => setAsking(true)} className={dangerButtonClass}>
        {pending ? "Cancelling..." : "Cancel this count"}
      </button>
      {error ? (
        <p role="alert" className="text-sm text-red-600">
          {error}
        </p>
      ) : null}
      {asking
        ? createPortal(
            <Modal title="Please confirm" narrow closeButton={false} onClose={() => setAsking(false)}>
              <p className="text-sm leading-relaxed">Cancel this count? No stock changes. You can count again afterwards.</p>
              <div className="mt-5 flex justify-end gap-2">
                <button type="button" onClick={() => setAsking(false)} className={`${ghostButtonClass} py-2`}>
                  Keep it
                </button>
                <button type="button" className={dangerButtonClass} onClick={run}>
                  Cancel this count
                </button>
              </div>
            </Modal>,
            document.body,
          )
        : null}
    </>
  );
}
