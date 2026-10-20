import type { ReactNode } from "react";

interface FieldProps {
  label: string;
  hint?: string;
  /** Help shown in a small pop-up when the (i) beside the label is hovered or focused, instead of text under the field. */
  tip?: string;
  /** Marks the field with a red asterisk. Use it for custom dropdowns, which cannot use the browser's own "required" check. */
  required?: boolean;
  children: ReactNode;
}

/** A labelled form control. Pass the input, select or textarea as children. */
export function Field({ label, hint, tip, required, children }: FieldProps) {
  return (
    <label className="flex flex-col gap-1 text-sm font-medium">
      <span className="flex items-center gap-1.5">
        <span>
          {label}
          {required ? (
            <>
              <span className="ml-0.5 text-red-600" aria-hidden="true">
                *
              </span>
              <span className="sr-only"> (required)</span>
            </>
          ) : null}
        </span>
        {tip ? (
          <span className="group relative inline-flex">
            <span
              tabIndex={0}
              role="note"
              aria-label={tip}
              className="inline-flex h-4 w-4 cursor-help items-center justify-center rounded-full border border-zinc-400 text-[10px] font-semibold leading-none text-zinc-500 outline-none focus-visible:ring-2 focus-visible:ring-zinc-400"
            >
              i
            </span>
            <span
              role="tooltip"
              className="pointer-events-none absolute left-0 top-full z-20 mt-1 hidden w-64 rounded-lg border border-line bg-surface px-3 py-2 text-xs font-normal text-zinc-600 shadow-lg group-focus-within:block group-hover:block"
            >
              {tip}
            </span>
          </span>
        ) : null}
      </span>
      {children}
      {hint ? <span className="text-xs font-normal text-zinc-500">{hint}</span> : null}
    </label>
  );
}
