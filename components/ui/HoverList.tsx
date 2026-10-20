"use client";

import { useState, type ReactNode } from "react";
import { FloatingList, useClickOutside } from "./Dropdown";

interface Props {
  /** The short text shown in the table, for example "3 items". */
  summary: ReactNode;
  /** The full list, one line each, shown on hover, keyboard focus or tap. */
  lines: readonly string[];
  /** Accessible name of the trigger, for example "Items used by BCS". */
  label: string;
}

/**
 * A short summary that reveals the full list when the person hovers it, focuses it or taps it. The list is
 * drawn by FloatingList, so a table's scroll area cannot clip it.
 */
export function HoverList({ summary, lines, label }: Props) {
  const [open, setOpen] = useState(false);
  const ref = useClickOutside(open, () => setOpen(false));

  return (
    <div ref={ref} className="inline-block" onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
      <button
        type="button"
        aria-label={label}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={(event) => {
          if (event.key === "Escape") setOpen(false);
        }}
        className="cursor-help text-left underline decoration-dotted underline-offset-4"
      >
        {summary}
      </button>
      {open ? (
        <FloatingList anchor={ref} role="tooltip">
          <ul className="px-3 py-1.5 text-sm text-ink">
            {lines.map((line) => (
              <li key={line} className="py-0.5">
                {line}
              </li>
            ))}
          </ul>
        </FloatingList>
      ) : null}
    </div>
  );
}
