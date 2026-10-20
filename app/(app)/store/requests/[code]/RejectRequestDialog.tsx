"use client";

import { useState } from "react";
import { createPortal } from "react-dom";
import { ActionForm } from "@/components/forms/ActionForm";
import { FormDialogProvider } from "@/components/forms/FormDialog";
import { Field } from "@/components/ui/Field";
import { Modal } from "@/components/ui/Modal";
import { dangerButtonClass, inputClass } from "@/components/ui/styles";
import { rejectRequestAction } from "../actions";

/**
 * The red "Reject request" button that sits beside Approve. It asks for the reason in a pop-up, and the
 * request is only rejected once a reason is entered and the pop-up's own Reject button is pressed.
 *
 * This is placed inside the approve form, so the pop-up is rendered in document.body (a form cannot sit inside
 * another form) and its submit event is stopped here so it never reaches the approve form's handler.
 */
export function RejectRequestDialog({ requestId, code }: { requestId: string; code: string }) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className={dangerButtonClass}>
        Reject request
      </button>
      {open
        ? createPortal(
            <div onSubmit={(event) => event.stopPropagation()}>
              <Modal title="Reject this request" narrow onClose={() => setOpen(false)}>
                <FormDialogProvider onSucceeded={() => setOpen(false)}>
                  <ActionForm
                    action={rejectRequestAction}
                    submitLabel="Reject request"
                    resetOnSuccess={false}
                    danger
                    className="flex flex-col gap-3"
                  >
                    <input type="hidden" name="requestId" value={requestId} />
                    <input type="hidden" name="code" value={code} />
                    <Field label="Reason for rejecting">
                      <textarea
                        name="reviewNote"
                        rows={3}
                        minLength={3}
                        maxLength={500}
                        required
                        data-autofocus
                        className={inputClass}
                      />
                    </Field>
                  </ActionForm>
                </FormDialogProvider>
              </Modal>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
