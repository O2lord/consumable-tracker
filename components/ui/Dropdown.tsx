"use client";

import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { inputClass } from "./styles";

type Options = readonly string[];

function optionClass(active: boolean, selected: boolean, size: "text-sm" | "text-base" = "text-base") {
  return `block w-full px-3 py-2 text-left ${size} ${selected ? "font-semibold" : "font-normal"} text-ink ${
    active ? "bg-brand-soft" : "hover:bg-brand-soft"
  }`;
}

/** Close the list when the person clicks anywhere outside it (the floating list itself counts as inside). */
export function useClickOutside(open: boolean, onClose: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const handler = (event: MouseEvent) => {
      const target = event.target as Element | null;
      if (target?.closest?.("[data-floating-list]")) return;
      if (ref.current && !ref.current.contains(target as Node)) onClose();
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open, onClose]);
  return ref;
}

/**
 * The list of choices under a field. It is drawn on top of the page with fixed positioning, so a table's
 * scroll area or a pop-up's edge cannot clip it, and it opens upwards when there is no room below.
 * Inside a pop-up it is mounted in that <dialog>, because a modal dialog sits above everything else.
 */
export function FloatingList({
  anchor,
  children,
  tall = false,
  role = "listbox",
  alignRight = false,
}: {
  anchor: RefObject<HTMLElement | null>;
  children: ReactNode;
  /** For tall content such as a calendar: needs more room before it flips upwards and is allowed to grow. */
  tall?: boolean;
  role?: string;
  /** Line the list's right edge up with the field's, for a field that sits against the right side of the page. */
  alignRight?: boolean;
}) {
  const [style, setStyle] = useState<CSSProperties | null>(null);

  useLayoutEffect(() => {
    const update = () => {
      const el = anchor.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const below = window.innerHeight - r.bottom - 12;
      const above = r.top - 12;
      const cap = tall ? 400 : 256;
      const need = tall ? 340 : 180;
      const up = below < need && above > below;
      setStyle({
        ...(alignRight ? { right: window.innerWidth - r.right } : { left: r.left }),
        minWidth: r.width,
        maxHeight: Math.max(120, Math.min(cap, up ? above : below)),
        ...(up ? { bottom: window.innerHeight - r.top + 4 } : { top: r.bottom + 4 }),
      });
    };
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [anchor, tall, alignRight]);

  if (!style) return null;
  const host = anchor.current?.closest("dialog") ?? document.body;
  return createPortal(
    <div
      role={role}
      data-floating-list
      style={style}
      className="fixed z-[200] w-max max-w-[min(24rem,calc(100vw-1.5rem))] overflow-y-auto rounded-lg border border-line bg-surface py-1 shadow-lg"
    >
      {children}
    </div>,
    host,
  );
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 20 20"
      className={`h-4 w-4 shrink-0 text-muted transition-transform ${open ? "rotate-180" : ""}`}
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M5 8l5 5 5-5" />
    </svg>
  );
}

interface DropdownOption {
  value: string;
  label: string;
}

interface DropdownProps {
  ariaLabel: string;
  options: readonly DropdownOption[];
  value: string;
  onChange: (value: string) => void;
}

/** A compact pill-shaped dropdown for filters and headers (controlled: the parent owns the value). */
export function Dropdown({ ariaLabel, options, value, onChange }: DropdownProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const ref = useClickOutside(open, () => setOpen(false));

  const selectedIndex = Math.max(
    0,
    options.findIndex((o) => o.value === value),
  );
  const current = options[selectedIndex];
  // Only the choices that contain what was typed in the search box are listed.
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? options.filter((o) => o.label.toLowerCase().includes(q)) : options;
  }, [options, query]);

  const openList = () => {
    setQuery("");
    setActive(selectedIndex);
    setOpen(true);
  };
  const choose = (option: DropdownOption) => {
    setOpen(false);
    setQuery("");
    if (option.value !== value) onChange(option.value);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    const typing = event.target instanceof HTMLInputElement; // in the search box a space is just a space
    if (event.key === "Escape" && open) {
      event.preventDefault();
      setOpen(false);
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      if (!open) openList();
      else setActive((i) => Math.min(visible.length - 1, i + 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      if (!open) openList();
      else setActive((i) => Math.max(0, i - 1));
    } else if ((event.key === "Enter" || (event.key === " " && !typing)) && open) {
      event.preventDefault();
      if (visible[active]) choose(visible[active]);
    }
  };

  return (
    <div ref={ref} className="relative inline-block">
      <button
        type="button"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => (open ? setOpen(false) : openList())}
        onKeyDown={onKeyDown}
        className="inline-flex items-center gap-2 rounded-full border border-line bg-surface px-3 py-1.5 text-sm font-medium text-ink hover:bg-brand-soft"
      >
        <span>{current?.label ?? ""}</span>
        <Chevron open={open} />
      </button>
      {open ? (
        <FloatingList anchor={ref} alignRight>
          <div className="sticky top-0 z-10 bg-surface px-2 pb-1 pt-1">
            <input
              autoFocus
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setActive(0);
              }}
              onKeyDown={onKeyDown}
              placeholder="Search..."
              aria-label={`Search ${ariaLabel}`}
              autoComplete="off"
              className={`${inputClass} w-full py-1.5 text-sm`}
            />
          </div>
          {visible.map((option, i) => (
            <button
              key={option.value}
              type="button"
              role="option"
              aria-selected={option.value === value}
              onMouseEnter={() => setActive(i)}
              onClick={() => choose(option)}
              className={`${optionClass(i === active, option.value === value, "text-sm")} whitespace-nowrap`}
            >
              {option.label}
            </button>
          ))}
          {visible.length === 0 ? <p className="px-3 py-2 text-sm text-muted">No matches</p> : null}
        </FloatingList>
      ) : null}
    </div>
  );
}

type SelectOption = string | { value: string; label: string };

interface SelectProps {
  name: string;
  /** Plain strings (the value is the label) or {value, label} pairs, for example a location's id and name. */
  options: readonly SelectOption[];
  /** Accessible name when the field has no visible <label>. */
  ariaLabel?: string;
  defaultValue?: string;
  /**
   * Makes the parent own the value (like a native controlled <select>): the field shows this value and follows it
   * when it changes. Leave it out to let the field keep its own value, starting from defaultValue.
   */
  value?: string;
  required?: boolean;
  placeholder?: string;
  /** Adds a first choice with an empty value (for example "None") so an optional field can be cleared. */
  emptyLabel?: string;
  /** Called with the new value as soon as the person picks an option. */
  onChange?: (value: string) => void;
  /**
   * Shows a search box at the top of the list that filters the choices as the person types. On for every
   * dropdown, so no list ever needs scrolling to find one; pass false to turn it off.
   */
  searchable?: boolean;
}

/** A styled replacement for <select>: pick one value from a fixed list. Submits through a hidden input. */
export function Select({
  name,
  options,
  defaultValue,
  value: controlled,
  required,
  placeholder = "Select...",
  emptyLabel,
  ariaLabel,
  onChange,
  searchable,
}: SelectProps) {
  const [inner, setInner] = useState(defaultValue ?? "");
  const value = controlled ?? inner;
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const ref = useClickOutside(open, () => setOpen(false));
  const hasSearch = searchable ?? true;

  const list = useMemo(() => {
    const base = options.map((o) => (typeof o === "string" ? { value: o, label: o } : o));
    return emptyLabel !== undefined ? [{ value: "", label: emptyLabel }, ...base] : base;
  }, [options, emptyLabel]);
  const labelOf = (v: string) => list.find((o) => o.value === v)?.label ?? v;
  // With search on, only the choices that contain what was typed are listed.
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return hasSearch && q ? list.filter((o) => o.label.toLowerCase().includes(q)) : list;
  }, [list, query, hasSearch]);

  const openList = () => {
    setQuery("");
    setActive(Math.max(0, list.findIndex((o) => o.value === value)));
    setOpen(true);
  };
  const choose = (option: string) => {
    const changed = option !== value;
    setInner(option);
    setOpen(false);
    setQuery("");
    if (changed) onChange?.(option);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    const typing = event.target instanceof HTMLInputElement; // in the search box a space is just a space
    if (event.key === "Escape" && open) {
      event.preventDefault(); // keep the surrounding pop-up open
      setOpen(false);
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      if (!open) openList();
      else setActive((i) => Math.min(visible.length - 1, i + 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      if (!open) openList();
      else setActive((i) => Math.max(0, i - 1));
    } else if ((event.key === "Enter" || (event.key === " " && !typing)) && open) {
      event.preventDefault();
      if (visible[active]) choose(visible[active].value);
    }
  };

  const shownLabel = labelOf(value);

  return (
    <div ref={ref} className="relative">
      <input type="hidden" name={name} value={value} required={required} />
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => (open ? setOpen(false) : openList())}
        onKeyDown={onKeyDown}
        aria-label={ariaLabel}
        className={`${inputClass} flex w-full items-center justify-between gap-2 text-left`}
      >
        <span className={shownLabel ? "" : "text-muted"}>{shownLabel || placeholder}</span>
        <Chevron open={open} />
      </button>
      {open ? (
        <FloatingList anchor={ref}>
          {hasSearch ? (
            <div className="sticky top-0 z-10 bg-surface px-2 pb-1 pt-1">
              <input
                autoFocus
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setActive(0);
                }}
                onKeyDown={onKeyDown}
                placeholder="Search..."
                aria-label="Search the list"
                autoComplete="off"
                className={`${inputClass} w-full py-1.5 text-sm`}
              />
            </div>
          ) : null}
          {visible.map((option, i) => (
            <button
              key={option.value || "__empty__"}
              type="button"
              role="option"
              aria-selected={option.value === value}
              onMouseEnter={() => setActive(i)}
              onClick={() => choose(option.value)}
              className={optionClass(i === active, option.value === value)}
            >
              {option.label}
            </button>
          ))}
          {visible.length === 0 ? <p className="px-3 py-2 text-sm text-muted">No matches</p> : null}
        </FloatingList>
      ) : null}
    </div>
  );
}

interface MultiSelectProps {
  name: string;
  /** Everything that can be picked. */
  options: readonly string[];
  /** Picked when the form opens. A value that is not in `options` is still shown and kept. */
  defaultValues?: readonly string[];
  placeholder?: string;
  ariaLabel?: string;
}

/**
 * Pick any number of values from a list, with a search box. The list stays open while ticking so several
 * can be picked in one go. Submits as one comma-separated field (for example "GEL, EDTA"), the same shape
 * as typing them by hand.
 */
export function MultiSelect({ name, options, defaultValues = [], placeholder = "None", ariaLabel }: MultiSelectProps) {
  const [picked, setPicked] = useState<string[]>([...defaultValues]);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const ref = useClickOutside(open, () => setOpen(false));

  // Anything already saved stays listed even if it is not one of the usual choices.
  const all = useMemo(() => [...options, ...defaultValues.filter((v) => !options.includes(v))], [options, defaultValues]);
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? all.filter((o) => o.toLowerCase().includes(q)) : all;
  }, [all, query]);

  const toggle = (option: string) =>
    setPicked((current) => (current.includes(option) ? current.filter((v) => v !== option) : [...current, option]));

  const openList = () => {
    setQuery("");
    setActive(0);
    setOpen(true);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    const typing = event.target instanceof HTMLInputElement;
    if (event.key === "Escape" && open) {
      event.preventDefault(); // keep the surrounding pop-up open
      setOpen(false);
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      if (!open) openList();
      else setActive((i) => Math.min(visible.length - 1, i + 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      if (!open) openList();
      else setActive((i) => Math.max(0, i - 1));
    } else if ((event.key === "Enter" || (event.key === " " && !typing)) && open) {
      event.preventDefault();
      if (visible[active]) toggle(visible[active]);
    }
  };

  return (
    <div ref={ref} className="relative">
      <input type="hidden" name={name} value={picked.join(", ")} />
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        onClick={() => (open ? setOpen(false) : openList())}
        onKeyDown={onKeyDown}
        className={`${inputClass} flex w-full items-center justify-between gap-2 text-left`}
      >
        <span className="flex min-w-0 flex-wrap items-center gap-1.5">
          {picked.length === 0 ? (
            <span className="text-muted">{placeholder}</span>
          ) : (
            picked.map((v) => (
              <span key={v} className="rounded-md bg-brand-soft px-2 py-0.5 text-sm font-medium text-ink">
                {v}
              </span>
            ))
          )}
        </span>
        <Chevron open={open} />
      </button>
      {open ? (
        <FloatingList anchor={ref}>
          <div className="sticky top-0 z-10 bg-surface px-2 pb-1 pt-1">
            <input
              autoFocus
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setActive(0);
              }}
              onKeyDown={onKeyDown}
              placeholder="Search..."
              aria-label="Search the list"
              autoComplete="off"
              className={`${inputClass} w-full py-1.5 text-sm`}
            />
          </div>
          {visible.map((option, i) => {
            const selected = picked.includes(option);
            return (
              <button
                key={option}
                type="button"
                role="option"
                aria-selected={selected}
                onMouseEnter={() => setActive(i)}
                onClick={() => toggle(option)}
                className={`${optionClass(i === active, selected)} flex items-center gap-2`}
              >
                <span
                  aria-hidden
                  className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border text-[11px] leading-none ${
                    selected ? "border-brand bg-brand text-white" : "border-line bg-surface"
                  }`}
                >
                  {selected ? "✓" : ""}
                </span>
                {option}
              </button>
            );
          })}
          {visible.length === 0 ? <p className="px-3 py-2 text-sm text-muted">No matches</p> : null}
        </FloatingList>
      ) : null}
    </div>
  );
}

interface ComboboxProps {
  name: string;
  suggestions: Options;
  defaultValue?: string;
  required?: boolean;
  placeholder?: string;
  /** Extra classes for the text box, for example a smaller size inside a table row. */
  className?: string;
  /** Extra classes for the outer wrapper, for example a fixed width. */
  wrapperClassName?: string;
  /** Accessible name when the field has no visible label. */
  ariaLabel?: string;
  /** Soft-keyboard capitalisation hint, for example "characters" for codes. */
  autoCapitalize?: string;
}

/** A text box with a styled list of suggestions underneath. The person can pick one or type their own value. */
export function Combobox({
  name,
  suggestions,
  defaultValue,
  required,
  placeholder,
  className,
  wrapperClassName,
  ariaLabel,
  autoCapitalize,
}: ComboboxProps) {
  const [value, setValue] = useState(defaultValue ?? "");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const ref = useClickOutside(open, () => setOpen(false));

  // Show every suggestion until the person starts typing something different.
  const shown = useMemo(() => {
    const query = value.trim().toLowerCase();
    if (!query || suggestions.some((s) => s.toLowerCase() === query)) return suggestions;
    return suggestions.filter((s) => s.toLowerCase().includes(query));
  }, [value, suggestions]);

  const choose = (option: string) => {
    setValue(option);
    setOpen(false);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape" && open) {
      event.preventDefault();
      setOpen(false);
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      setOpen(true);
      setActive((i) => Math.min(shown.length - 1, i + 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((i) => Math.max(0, i - 1));
    } else if (event.key === "Enter" && open && active >= 0 && shown[active]) {
      event.preventDefault(); // pick the highlighted suggestion instead of submitting the form
      choose(shown[active]);
    }
  };

  return (
    <div ref={ref} className={`relative ${wrapperClassName ?? ""}`}>
      <div className="relative">
        <input
          name={name}
          value={value}
          required={required}
          placeholder={placeholder}
          aria-label={ariaLabel}
          autoCapitalize={autoCapitalize}
          autoComplete="off"
          onChange={(event) => {
            setValue(event.target.value);
            setActive(-1);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          className={`${inputClass} w-full pr-9 ${className ?? ""}`}
        />
        <button
          type="button"
          tabIndex={-1}
          aria-label="Show suggestions"
          onClick={() => setOpen((o) => !o)}
          className="absolute inset-y-0 right-0 flex w-9 items-center justify-center"
        >
          <Chevron open={open} />
        </button>
      </div>
      {open && shown.length > 0 ? (
        <FloatingList anchor={ref}>
          {shown.map((option, i) => (
            <button
              key={option}
              type="button"
              role="option"
              aria-selected={option === value}
              onMouseEnter={() => setActive(i)}
              onClick={() => choose(option)}
              className={optionClass(i === active, option === value)}
            >
              {option}
            </button>
          ))}
        </FloatingList>
      ) : null}
    </div>
  );
}
