"use client";

import dynamic from "next/dynamic";
import { useRef, useState } from "react";
import { Field } from "@/components/ui/Field";
import { ghostButtonClass, inputClass } from "@/components/ui/styles";

// Loaded only when the camera is opened, so the decoder code stays out of every page's first load.
const CameraScanner = dynamic(() => import("./CameraScanner").then((m) => m.CameraScanner), { ssr: false });

interface Props {
  /** The form field name the scanned code is submitted under. */
  name: string;
  label: string;
  hint?: string;
  autoFocus?: boolean;
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
 * A form field that takes a scanned code: a USB or Bluetooth scanner types it (and presses Enter),
 * or the device camera reads it. Either way the code lands in the field and focus moves on to the
 * next one. Enter never submits the form from here, so scanning first and filling in details after
 * does not trip the "please fill in this field" warning.
 *
 * The input is uncontrolled on purpose: the form's own reset clears it after a successful save.
 */
export function ScanField({ name, label, hint, autoFocus = false }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [cameraOpen, setCameraOpen] = useState(false);

  return (
    <div className="flex flex-col gap-2">
      <Field label={label} hint={hint}>
        <input
          ref={inputRef}
          name={name}
          required
          autoFocus={autoFocus}
          autoComplete="off"
          autoCapitalize="characters"
          autoCorrect="off"
          spellCheck={false}
          inputMode={cameraOpen ? "none" : undefined}
          placeholder="Point the scanner at the label, or use the camera"
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
      ) : (
        <div>
          <button type="button" onClick={() => setCameraOpen(true)} className={`${ghostButtonClass} py-1`}>
            Use camera
          </button>
        </div>
      )}
    </div>
  );
}
