"use client";

export interface UnitSwitchOption {
  value: string;
  label: string;
  disabled?: boolean;
  /** Shown on hover when the option is disabled, to say why. */
  title?: string;
}

/**
 * A small two-way switch for choosing which unit a quantity is counted in (Pack / Pieces). It only reports the
 * choice; the caller decides what to do with it.
 */
export function UnitSwitch({
  options,
  value,
  onChange,
  ariaLabel,
}: {
  options: UnitSwitchOption[];
  value: string;
  onChange: (value: string) => void;
  ariaLabel: string;
}) {
  return (
    <div role="group" aria-label={ariaLabel} className="inline-flex rounded-lg border border-line bg-page p-0.5">
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={active}
            disabled={option.disabled}
            title={option.disabled ? option.title : undefined}
            onClick={() => onChange(option.value)}
            className={`rounded-md px-2.5 py-1.5 text-sm font-medium ${
              active ? "bg-brand text-brand-ink" : "text-ink hover:bg-brand-soft"
            } disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent`}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
