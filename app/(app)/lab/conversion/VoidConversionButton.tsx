"use client";

import { useCallback, useState } from "react";
import { ActionForm } from "@/components/forms/ActionForm";
import { FormDialogProvider } from "@/components/forms/FormDialog";
import { Field } from "@/components/ui/Field";
import { Modal } from "@/components/ui/Modal";
import { inputClass } from "@/components/ui/styles";
import { voidConversionAction } from "./actions";

interface Props {
  conversionId: string;
  code: string;
  workLocationId: string;
  /** For the sentence in the pop-up: what would go back and what would come off, for example "200 mL" and "2,000 mL". */
  tookText: string;
  madeText: string;
}

/**
 * A small "Void" button for a row of Recently converted. It opens a pop-up that asks for a reason and says what will
 * happen. The server refuses when any of the stock made has already been used, and the refusal shows in the pop-up.
 */
export function VoidConversionButton({ conversionId, code, workLocationId, tookText, madeText }: Props) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-lg border border-line bg-surface px-2 py-1 text-xs text-ink hover:bg-brand-soft"
      >
        Void
      </button>
      {open ? (
        <Modal title={`Void ${code}`} onClose={close}>
          <FormDialogProvider onSucceeded={close}>
            <ActionForm
              action={voidConversionAction}
              submitLabel="Void conversion"
              danger
              confirm={`Void ${code}? ${tookText} goes back on the shelf and ${madeText} comes off it.`}
            >
              <p className="text-sm text-zinc-500">
                Use this when a conversion was recorded by mistake. {tookText} goes back on the shelf and {madeText} comes
                off it. It can only be voided while none of what was made has been used. If a label was printed for it, throw the
                label away.
              </p>
              <input type="hidden" name="conversionId" value={conversionId} />
              <input type="hidden" name="locationId" value={workLocationId} />
              <Field label="Reason" required>
                <input name="reason" required minLength={3} maxLength={200} className={inputClass} autoComplete="off" />
              </Field>
            </ActionForm>
          </FormDialogProvider>
        </Modal>
      ) : null}
    </>
  );
}
