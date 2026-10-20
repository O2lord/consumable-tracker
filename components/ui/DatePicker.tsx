"use client";

import { useRef, useState, type KeyboardEvent } from "react";
import { FloatingList, useClickOutside } from "./Dropdown";
import { inputClass } from "./styles";

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
const SHORT_MONTHS = MONTHS.map((m) => m.slice(0, 3));
const WEEKDAYS = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];

const pad = (n: number) => String(n).padStart(2, "0");
const toIso = (y: number, m: number, d: number) => `${y}-${pad(m + 1)}-${pad(d)}`;

function parseIso(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  return match ? { y: Number(match[1]), m: Number(match[2]) - 1, d: Number(match[3]) } : null;
}

function todayIso() {
  const now = new Date();
  return toIso(now.getFullYear(), now.getMonth(), now.getDate());
}

function formatShown(value: string) {
  const p = parseIso(value);
  return p ? `${pad(p.d)} ${SHORT_MONTHS[p.m]} ${p.y}` : "";
}

function Arrow({ dir }: { dir: "left" | "right" }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 20 20"
      className="h-4 w-4"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={dir === "left" ? "M12 5l-5 5 5 5" : "M8 5l5 5-5 5"} />
    </svg>
  );
}

function CalendarIcon() {
  return (
    <svg
      aria-hidden
      viewBox="0 0 20 20"
      className="h-4 w-4 shrink-0 text-muted"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="3" y="4.5" width="14" height="12.5" rx="2" />
      <path d="M3 8.5h14M7 3v3M13 3v3" />
    </svg>
  );
}

interface DatePickerProps {
  name: string;
  /** Starting date as YYYY-MM-DD, or empty for none. */
  defaultValue?: string;
  /** Hides the Clear button. */
  required?: boolean;
  /** Earliest and latest date that can be picked, as YYYY-MM-DD. */
  min?: string;
  max?: string;
  placeholder?: string;
  /** Accessible name when the field has no visible <label>. */
  ariaLabel?: string;
  /** Extra classes for the outer wrapper, for example a fixed width. */
  wrapperClassName?: string;
  /** Called with the new date (YYYY-MM-DD, or empty when cleared) as soon as the person picks or clears it. */
  onChange?: (value: string) => void;
  /** Line the calendar's right edge up with the field's, for a field that sits against the right side of the page. */
  alignRight?: boolean;
}

/**
 * Our own date picker, replacing <input type="date">. Pick a day from a calendar that matches the rest of the
 * app; the chosen date is submitted as YYYY-MM-DD through a hidden input.
 */
export function DatePicker({
  name,
  defaultValue = "",
  required,
  min,
  max,
  placeholder = "Select date",
  ariaLabel,
  wrapperClassName,
  onChange,
  alignRight,
}: DatePickerProps) {
  const [value, setValue] = useState(defaultValue);
  const [open, setOpen] = useState(false);
  const [view, setView] = useState(() => {
    const p = parseIso(defaultValue) ?? parseIso(todayIso())!;
    return { y: p.y, m: p.m };
  });
  const ref = useClickOutside(open, () => setOpen(false));
  const triggerRef = useRef<HTMLButtonElement>(null);
  const today = todayIso();

  const openCalendar = () => {
    const p = parseIso(value) ?? parseIso(today)!;
    setView({ y: p.y, m: p.m });
    setOpen(true);
  };
  const shiftMonth = (delta: number) =>
    setView(({ y, m }) => {
      const t = y * 12 + m + delta;
      return { y: Math.floor(t / 12), m: ((t % 12) + 12) % 12 };
    });
  const isDisabled = (iso: string) => Boolean((min && iso < min) || (max && iso > max));
  const pick = (iso: string) => {
    if (isDisabled(iso)) return;
    setValue(iso);
    onChange?.(iso);
    setOpen(false);
    triggerRef.current?.focus();
  };

  // Escape closes only the calendar, not a pop-up the field might be sitting in.
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape" && open) {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      triggerRef.current?.focus();
    }
  };

  // Monday-first grid: blanks before the 1st, then one cell per day.
  const firstWeekday = new Date(Date.UTC(view.y, view.m, 1)).getUTCDay(); // 0 = Sunday
  const lead = (firstWeekday + 6) % 7;
  const daysInMonth = new Date(Date.UTC(view.y, view.m + 1, 0)).getUTCDate();
  const cells: (number | null)[] = [
    ...Array<null>(lead).fill(null),
    ...Array.from({ length: daysInMonth }, (_, i) => i + 1),
  ];

  const shown = formatShown(value);

  return (
    <div ref={ref} className={`relative ${wrapperClassName ?? "w-44"}`} onKeyDown={onKeyDown}>
      <input type="hidden" name={name} value={value} />
      <button
        ref={triggerRef}
        type="button"
        aria-label={ariaLabel}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => (open ? setOpen(false) : openCalendar())}
        className={`${inputClass} flex w-full items-center justify-between gap-2 text-left`}
      >
        <span className={shown ? "" : "text-muted"}>{shown || placeholder}</span>
        <CalendarIcon />
      </button>
      {open ? (
        <FloatingList anchor={ref} tall role="dialog" alignRight={alignRight ?? false}>
          <div className="w-64 px-3 py-2" aria-label={`${MONTHS[view.m]} ${view.y}`}>
            <div className="mb-2 flex items-center justify-between">
              <button
                type="button"
                aria-label="Previous month"
                onClick={() => shiftMonth(-1)}
                className="rounded-lg p-1.5 text-ink hover:bg-brand-soft"
              >
                <Arrow dir="left" />
              </button>
              <span className="text-sm font-semibold">
                {MONTHS[view.m]} {view.y}
              </span>
              <button
                type="button"
                aria-label="Next month"
                onClick={() => shiftMonth(1)}
                className="rounded-lg p-1.5 text-ink hover:bg-brand-soft"
              >
                <Arrow dir="right" />
              </button>
            </div>
            <div className="grid grid-cols-7 gap-y-1 text-center text-sm">
              {WEEKDAYS.map((d) => (
                <span key={d} className="py-1 text-xs font-medium text-muted">
                  {d}
                </span>
              ))}
              {cells.map((day, i) => {
                if (day === null) return <span key={`blank-${i}`} />;
                const iso = toIso(view.y, view.m, day);
                const selected = iso === value;
                const disabled = isDisabled(iso);
                return (
                  <button
                    key={iso}
                    type="button"
                    disabled={disabled}
                    aria-pressed={selected}
                    onClick={() => pick(iso)}
                    className={`mx-auto h-8 w-8 rounded-lg ${
                      selected
                        ? "bg-brand font-semibold text-brand-ink"
                        : iso === today
                          ? "border border-brand text-ink hover:bg-brand-soft"
                          : "text-ink hover:bg-brand-soft"
                    } ${disabled ? "cursor-not-allowed opacity-40 hover:bg-transparent" : ""}`}
                  >
                    {day}
                  </button>
                );
              })}
            </div>
            <div className="mt-2 flex items-center justify-between border-t border-line pt-2 text-sm">
              {required ? (
                <span />
              ) : (
                <button
                  type="button"
                  onClick={() => {
                    setValue("");
                    onChange?.("");
                    setOpen(false);
                  }}
                  className="rounded-lg px-2 py-1 text-ink hover:bg-brand-soft"
                >
                  Clear
                </button>
              )}
              <button
                type="button"
                disabled={isDisabled(today)}
                onClick={() => pick(today)}
                className="rounded-lg px-2 py-1 font-semibold text-ink hover:bg-brand-soft disabled:opacity-40"
              >
                Today
              </button>
            </div>
          </div>
        </FloatingList>
      ) : null}
    </div>
  );
}
