"use client";

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { Modal } from "@/components/ui/Modal";
import { buttonClass, ghostButtonClass } from "@/components/ui/styles";

interface DialogControl {
  /** Called by ActionForm when a save succeeds: closes the pop-up and shows the message on the page. */
  succeeded: (message: string) => void;
}

const DialogContext = createContext<DialogControl | null>(null);

/** Returns the surrounding pop-up's controls, or null when the form is not inside one. */
export function useFormDialog() {
  return useContext(DialogContext);
}

/**
 * For a pop-up that is not built by FormDialog (it has its own button and content): wrap its forms in this
 * so a saved ActionForm closes it, the same as inside FormDialog.
 */
export function FormDialogProvider({ onSucceeded, children }: { onSucceeded: () => void; children: ReactNode }) {
  const control = useMemo(() => ({ succeeded: () => onSucceeded() }), [onSucceeded]);
  return <DialogContext.Provider value={control}>{children}</DialogContext.Provider>;
}

export interface DialogSpec {
  /** Text on the top-right button, for example "Add location". */
  buttonLabel: string;
  /** Title of the pop-up. Defaults to the button label. */
  title?: string;
  /** Optional line of help shown above the form inside the pop-up. */
  intro?: ReactNode;
  /** Disable the button, for example when there is nothing to choose from yet. */
  disabled?: boolean;
  /** A larger pop-up, for forms with a wide table. */
  wide?: boolean;
  /** The form to fill in. */
  content: ReactNode;
}

interface GroupProps {
  /** The page title and intro, shown on the left with the buttons on the right. */
  header: ReactNode;
  /** One button and pop-up each. The first is the main (filled) button, the rest are outlined. */
  dialogs: DialogSpec[];
}

/**
 * A page header with button(s) at the top right that open a form in a pop-up. When a form saves, the
 * pop-up closes and the confirmation appears as a toast; if the save is rejected the pop-up stays open
 * with the error and everything that was typed. The pop-up is only mounted while open, so the form is
 * empty the next time it opens.
 */
export function FormDialogGroup({ header, dialogs }: GroupProps) {
  const [openIndex, setOpenIndex] = useState<number | null>(null);

  // The saved form shows its own toast; all that is left to do here is close the pop-up.
  const succeeded = useCallback(() => setOpenIndex(null), []);
  const control = useMemo(() => ({ succeeded }), [succeeded]);

  const active = openIndex === null ? null : dialogs[openIndex];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1 basis-80">{header}</div>
        <div className="flex flex-wrap gap-2">
          {dialogs.map((d, i) => (
            <button
              key={d.buttonLabel}
              type="button"
              disabled={d.disabled}
              onClick={() => setOpenIndex(i)}
              className={i === 0 ? buttonClass : `${ghostButtonClass} py-2.5`}
            >
              {d.buttonLabel}
            </button>
          ))}
        </div>
      </div>

      {active ? (
        <Modal title={active.title ?? active.buttonLabel} wide={active.wide} onClose={() => setOpenIndex(null)}>
          {active.intro ? <div className="mb-3 text-sm text-zinc-500">{active.intro}</div> : null}
          <DialogContext.Provider value={control}>{active.content}</DialogContext.Provider>
        </Modal>
      ) : null}
    </div>
  );
}

interface RowDialogProps {
  /** Text on the small button, for example "Edit". */
  buttonLabel: string;
  /** Title of the pop-up. Defaults to the button label. */
  title?: string;
  /** The form to fill in. */
  children: ReactNode;
}

function PenIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </svg>
  );
}

/**
 * A small pen-icon button for use inside a table row that opens a form in a pop-up. buttonLabel is the
 * accessible name and tooltip. A successful save closes the pop-up, and the pop-up is only mounted while
 * open so the form always starts from the saved values.
 */
export function RowFormDialog({ buttonLabel, title, children }: RowDialogProps) {
  const [open, setOpen] = useState(false);
  const succeeded = useCallback(() => setOpen(false), []);
  const control = useMemo(() => ({ succeeded }), [succeeded]);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={buttonLabel}
        title={buttonLabel}
        className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-line bg-surface text-ink hover:bg-brand-soft"
      >
        <PenIcon />
      </button>
      {open ? (
        <Modal title={title ?? buttonLabel} onClose={() => setOpen(false)}>
          <DialogContext.Provider value={control}>{children}</DialogContext.Provider>
        </Modal>
      ) : null}
    </>
  );
}

interface Props extends Omit<DialogSpec, "content"> {
  header: ReactNode;
  /** The form to fill in. */
  children: ReactNode;
}

/** The common case: a header with one button at the top right that opens one form in a pop-up. */
export function FormDialog({ header, children, ...spec }: Props) {
  return <FormDialogGroup header={header} dialogs={[{ ...spec, content: children }]} />;
}
