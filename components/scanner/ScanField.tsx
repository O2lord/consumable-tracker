"use client";

import dynamic from "next/dynamic";
import { useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { Field } from "@/components/ui/Field";
import { ghostButtonClass, inputClass } from "@/components/ui/styles";
import { isTouchScreen, subscribeTouch, useSerialScanner } from "./useSerialScanner";

// Loaded only when the camera is opened, so the decoder code stays out of every page's first load.
const CameraScanner = dynamic(() => import("./CameraScanner").then((m) => m.CameraScanner), { ssr: false });

interface Props {
  /** The form field name the scanned code is submitted under. */
  name: string;
  label: string;
  hint?: string;
  autoFocus?: boolean;
  /** Extra buttons shown on the same row as "Use camera". */
  actions?: ReactNode;
}

/** Moves focus to the next field of the same form (a scanner ends each code with Enter). */
function focusNextField(input: HTMLInputElement | null) {
  const form = input?.form;
  if (!input || !form) return;
  const fields = Array.from(form.elements).filter(
    (el): el is HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement =>
      (el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement) &&
      !el.disabled &&
      !(el instanceof HTMLInputElement && el.type === "hidden"),
  );
  fields[fields.indexOf(input) + 1]?.focus();
}

/**
 * A form field that takes a scanned code, the same way the Label check page does: a USB or Bluetooth scanner types
 * it (and presses Enter), a USB scanner in serial mode is read directly through Web Serial ("Connect scanner", then it
 * reconnects by itself), or the device camera reads it. Either way the code lands in the field and focus moves on to
 * the next one. Enter never submits the form from here, so scanning first and filling in details after
 * does not trip the "please fill in this field" warning.
 *
 * On a computer the field keeps focus while it is empty: if focus drops to nothing (the page body), it comes back, so
 * the next scan lands here. It never takes focus from another field the person clicked into.
 *
 * The input is uncontrolled on purpose: the form's own reset clears it after a successful save.
 */
export function ScanField({ name, label, hint, autoFocus = false, actions }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [cameraOpen, setCameraOpen] = useState(false);
  const touch = useSyncExternalStore(subscribeTouch, isTouchScreen, () => false);
  const { canUseSerial, serialConnected, serialBusy, connect } = useSerialScanner((code) => {
    if (inputRef.current) inputRef.current.value = code.trim();
    focusNextField(inputRef.current);
  });

  function refocusIfEmpty() {
    if (isTouchScreen()) return;
    window.setTimeout(() => {
      const active = document.activeElement;
      const input = inputRef.current;
      if (input && input.value === "" && (!active || active === document.body)) input.focus();
    }, 0);
  }

  return (
    <div className="flex flex-col gap-2">
      <Field label={label} hint={hint ?? (touch ? undefined : "Scanner ready. Focus stays here.")}>
        <input
          ref={inputRef}
          name={name}
          required
          autoFocus={autoFocus}
          // Inside a pop-up, the pop-up focuses this field when it opens (a plain autoFocus is lost before it shows).
          data-autofocus={autoFocus && !touch ? "" : undefined}
          autoComplete="off"
          autoCapitalize="characters"
          autoCorrect="off"
          spellCheck={false}
          inputMode={cameraOpen ? "none" : undefined}
          placeholder="Point the scanner at the label, or use the camera"
          onBlur={refocusIfEmpty}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              focusNextField(inputRef.current);
            }
          }}
          className={`${inputClass} font-mono`}
        />
      </Field>
      {cameraOpen ? (
        <CameraScanner
          paused={false}
          onCode={(value) => {
            if (inputRef.current) inputRef.current.value = value.trim();
            setCameraOpen(false);
            focusNextField(inputRef.current);
          }}
          onClose={() => setCameraOpen(false)}
        />
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        {!cameraOpen ? (
          <button type="button" onClick={() => setCameraOpen(true)} className={`${ghostButtonClass} py-1`}>
            Use camera
          </button>
        ) : null}
        {actions}
        {canUseSerial && !serialConnected ? (
          <button type="button" onClick={connect} className={`${ghostButtonClass} py-1`}>
            Connect scanner
          </button>
        ) : null}
        {serialConnected ? <span className="text-xs font-normal text-muted">USB scanner connected.</span> : null}
        {serialBusy && !serialConnected ? (
          <span className="text-xs font-normal text-muted">
            The scanner is in use by the extension panel. Close the panel, then press Connect scanner.
          </span>
        ) : null}
      </div>
    </div>
  );
}
