"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { ghostButtonClass } from "./styles";

interface Props {
  title: string;
  onClose: () => void;
  children: ReactNode;
  /** A smaller box, for short confirmations. */
  narrow?: boolean;
  /** A larger box, for forms with a wide table. */
  wide?: boolean;
  /**
   * The Close button in the title bar. Turn it off for a confirmation that already has its own Cancel button, so the
   * same choice is not offered twice. Escape and a click on the dimmed area still close the box.
   */
  closeButton?: boolean;
}

/**
 * A pop-up dialog built on the browser's own <dialog>, so it traps focus, closes on Escape and dims the
 * page behind it. Render it only while it should be open: it opens when it mounts, and unmounting it
 * throws away whatever was typed, so the next time it opens the form is empty.
 */
export function Modal({ title, onClose, children, narrow = false, wide = false, closeButton = true }: Props) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) {
      dialog.showModal();
      // showModal() focuses the first control (the Close button); let a field opt in to being focused instead.
      dialog.querySelector<HTMLElement>("[data-autofocus]")?.focus();
    }
    return () => {
      if (dialog?.open) dialog.close();
    };
  }, []);

  return (
    <dialog
      ref={ref}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        // The dimmed area behind the box counts as a click on the dialog itself.
        if (event.target === ref.current) onClose();
      }}
      className={`m-auto max-h-[92dvh] overflow-y-auto whitespace-normal rounded-2xl border border-line bg-surface p-0 text-ink backdrop:bg-black/50 ${
        narrow
          ? "w-[min(26rem,calc(100%-1.5rem))]"
          : wide
            ? "w-[min(64rem,calc(100%-1.5rem))]"
            : "w-[min(42rem,calc(100%-1.5rem))]"
      }`}
    >
      <div className="sticky top-0 z-10 flex items-center justify-between gap-3 border-b border-line bg-surface px-5 py-3">
        <h2 className="text-lg font-semibold">{title}</h2>
        {closeButton ? (
          <button type="button" onClick={onClose} className={`${ghostButtonClass} py-1`}>
            Close
          </button>
        ) : null}
      </div>
      <div className="p-5">{children}</div>
    </dialog>
  );
}
