"use client";

import { useRef, useState, useTransition } from "react";
import { itemKept, type QuantityUnit, type WidgetKey, type WidgetPref } from "@/lib/dashboard-prefs";
import { saveWidgetPrefAction } from "@/app/(app)/dashboard/actions";

/** One item type the person can pick. "bottle" items are serialized; "bulk" items are counted by quantity. */
export interface ItemOption {
  id: string;
  name: string;
  kind: "bottle" | "bulk";
}

/** One location the person can pick. */
export interface LocationOption {
  id: string;
  name: string;
}

const UNIT_OPTIONS: { value: QuantityUnit; label: string }[] = [
  { value: "pieces", label: "Pieces" },
  { value: "packs", label: "Packs" },
];

function ItemGroup({
  title,
  options,
  selected,
  max,
  onToggle,
  onAll,
  onNone,
}: {
  title: string;
  options: ItemOption[];
  selected: Set<string>;
  /** The most that can be ticked. When set, the All link is hidden and the count reads "2 of 4". */
  max?: number;
  onToggle: (id: string) => void;
  onAll: () => void;
  onNone: () => void;
}) {
  const [expanded, setExpanded] = useState(true);
  if (options.length === 0) return null;
  const count = options.filter((o) => selected.has(o.id)).length;
  const full = max !== undefined && count >= max;
  const listId = `group-${title.replace(/\s+/g, "-").toLowerCase()}`;
  return (
    <div role="group" aria-label={title} className="min-w-0">
      <div className="mb-1 flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          aria-controls={listId}
          className="flex items-center gap-1 text-xs font-semibold text-muted hover:text-ink"
        >
          <svg
            viewBox="0 0 24 24"
            className={`size-3.5 transition-transform ${expanded ? "rotate-90" : ""}`}
            fill="none"
            stroke="currentColor"
            strokeWidth={2.2}
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            <path d="M9 6l6 6-6 6" />
          </svg>
          {max !== undefined ? `${title} (${count} of ${max} at most)` : `${title} (${count}/${options.length})`}
        </button>
        <div className="flex gap-3 text-xs font-medium">
          {max === undefined ? (
            <button type="button" onClick={onAll} className="text-brand hover:underline">
              All
            </button>
          ) : null}
          <button type="button" onClick={onNone} className="text-muted hover:underline">
            None
          </button>
        </div>
      </div>
      <ul id={listId} hidden={!expanded} className="max-h-56 overflow-y-auto rounded-lg border border-line">
        {options.map((o) => {
          const blocked = full && !selected.has(o.id);
          return (
            <li key={o.id} className="border-b border-line last:border-b-0">
              <label className={`flex items-center gap-2.5 px-3 py-2 text-sm ${blocked ? "cursor-not-allowed opacity-50" : "cursor-pointer hover:bg-brand-soft"}`}>
                <input
                  type="checkbox"
                  checked={selected.has(o.id)}
                  disabled={blocked}
                  onChange={() => onToggle(o.id)}
                  className="size-4 shrink-0 accent-brand"
                />
                <span className="min-w-0 flex-1 truncate">{o.name}</span>
              </label>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/**
 * A small settings icon for one dashboard widget. It opens a pop-up where the person ticks the items the widget
 * shows and picks whether bulk quantities are in packs or pieces. Nothing changes until Save is pressed.
 */
export function WidgetSettings({
  widget,
  title,
  initial,
  options,
  locations,
  maxLocations,
  defaultPlaceIds,
  dark = false,
}: {
  widget: WidgetKey;
  /** The widget's name, for the icon's label and the pop-up heading. */
  title: string;
  initial: WidgetPref;
  /** Every item type that could be shown. */
  options: ItemOption[];
  /** Every location that could be shown. Leave out for a widget that is not split by location. */
  locations?: LocationOption[];
  /** The most locations that can be ticked. Leave out for no limit. */
  maxLocations?: number;
  /** The locations shown while none has been picked yet, so the list starts with those ticked. */
  defaultPlaceIds?: string[];
  /** True on the dark green card, so the icon stays readable there. */
  dark?: boolean;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const idsFrom = (pref: WidgetPref) => new Set(options.filter((o) => itemKept(pref.items, o.id)).map((o) => o.id));
  const placesFrom = (pref: WidgetPref) =>
    new Set(
      (locations ?? [])
        .filter((l) => (pref.places === null && defaultPlaceIds ? defaultPlaceIds.includes(l.id) : itemKept(pref.places, l.id)))
        .map((l) => l.id),
    );

  // What is saved, and what is being edited in the pop-up. Cancel throws the edits away.
  const [saved, setSaved] = useState(() => ({ unit: initial.unit, selected: idsFrom(initial), places: placesFrom(initial) }));
  const [unit, setUnit] = useState<QuantityUnit>(saved.unit);
  const [selected, setSelected] = useState<Set<string>>(saved.selected);
  const [places, setPlaces] = useState<Set<string>>(saved.places);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const bottles = options.filter((o) => o.kind === "bottle");
  const bulk = options.filter((o) => o.kind === "bulk");

  const open = () => {
    setUnit(saved.unit);
    setSelected(new Set(saved.selected));
    setPlaces(new Set(saved.places));
    setError(null);
    dialog.current?.showModal();
  };
  const close = () => dialog.current?.close();

  const toggle = (id: string) =>
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const setGroup = (group: ItemOption[], on: boolean) =>
    setSelected((s) => {
      const next = new Set(s);
      for (const o of group) {
        if (on) next.add(o.id);
        else next.delete(o.id);
      }
      return next;
    });

  const togglePlace = (id: string) => {
    if (!places.has(id) && maxLocations !== undefined && places.size >= maxLocations) {
      setError(`Pick no more than ${maxLocations} locations.`);
      return;
    }
    setError(null);
    setPlaces((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const setAllPlaces = (on: boolean) => setPlaces(on ? new Set((locations ?? []).map((l) => l.id)) : new Set());

  const save = () => {
    if (selected.size === 0) {
      setError("Pick at least one item.");
      return;
    }
    if (locations && places.size === 0) {
      setError("Pick at least one location.");
      return;
    }
    setError(null);
    startTransition(async () => {
      const result = await saveWidgetPrefAction(widget, {
        unit,
        selected: [...selected],
        ...(locations ? { places: [...places] } : {}),
      });
      if (!result.ok) {
        setError(result.error ?? "Could not save. Try again.");
        return;
      }
      setSaved({ unit, selected: new Set(selected), places: new Set(places) });
      close();
    });
  };

  return (
    <>
      <button
        type="button"
        onClick={open}
        aria-haspopup="dialog"
        aria-label={`${title} settings`}
        title="Settings"
        className={`flex size-8 items-center justify-center rounded-lg border ${
          dark ? "border-white/30 text-white hover:bg-white/10" : "border-line bg-surface text-muted hover:bg-brand-soft"
        }`}
      >
        <svg viewBox="0 0 24 24" className="size-[18px]" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <circle cx={12} cy={12} r={3} />
          <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3h0a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8v0a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z" />
        </svg>
      </button>

      {/* A native modal dialog: it sits above the page, dims it, traps focus and closes on Escape. */}
      <dialog
        ref={dialog}
        aria-label={`${title} settings`}
        onClick={(e) => {
          // A click on the dimmed area outside the box closes it.
          if (e.target === dialog.current) close();
        }}
        className="m-auto w-[min(92vw,26rem)] rounded-2xl border border-line bg-surface p-0 text-ink shadow-xl backdrop:bg-black/40"
      >
        <div className="flex max-h-[85vh] flex-col">
          <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-3">
            <h2 className="text-base font-semibold">{title}</h2>
            <button
              type="button"
              onClick={close}
              aria-label="Close"
              className="flex size-8 items-center justify-center rounded-lg text-muted hover:bg-brand-soft"
            >
              <svg viewBox="0 0 24 24" className="size-[18px]" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" aria-hidden>
                <path d="M6 6l12 12M18 6L6 18" />
              </svg>
            </button>
          </div>

          <div className="flex flex-col gap-4 overflow-y-auto px-4 py-3">
            <div className="flex flex-col gap-3">
              <p className="text-sm font-medium">Items</p>
              <ItemGroup
                title="Bottles"
                options={bottles}
                selected={selected}
                onToggle={toggle}
                onAll={() => setGroup(bottles, true)}
                onNone={() => setGroup(bottles, false)}
              />
              <ItemGroup
                title="Bulk items"
                options={bulk}
                selected={selected}
                onToggle={toggle}
                onAll={() => setGroup(bulk, true)}
                onNone={() => setGroup(bulk, false)}
              />
            </div>

            {locations ? (
              <div className="flex flex-col gap-3">
                <p className="text-sm font-medium">Locations</p>
                <ItemGroup
                  title="Locations"
                  options={locations.map((l) => ({ id: l.id, name: l.name, kind: "bottle" as const }))}
                  selected={places}
                  max={maxLocations}
                  onToggle={togglePlace}
                  onAll={() => setAllPlaces(true)}
                  onNone={() => setAllPlaces(false)}
                />
              </div>
            ) : null}

            <div className="flex flex-col gap-1">
              <p className="text-sm font-medium">Show bulk items in</p>
              <div role="group" aria-label="Show bulk items in" className="inline-flex rounded-lg border border-line bg-page p-0.5">
                {UNIT_OPTIONS.map((o) => (
                  <button
                    key={o.value}
                    type="button"
                    aria-pressed={unit === o.value}
                    onClick={() => setUnit(o.value)}
                    className={`flex-1 rounded-md px-3 py-1.5 text-sm ${
                      unit === o.value ? "bg-brand font-semibold text-brand-ink" : "text-ink hover:bg-brand-soft"
                    }`}
                  >
                    {o.label}
                  </button>
                ))}
              </div>
              <p className="text-xs text-muted">
                {unit === "packs"
                  ? "Pack items show as packs (for example 4.8). Other items stay as they are."
                  : "Pack items show as single pieces."}
              </p>
            </div>
          </div>

          <div className="flex items-center justify-between gap-3 border-t border-line px-4 py-3">
            <p role="alert" className="min-h-4 text-xs text-bad">
              {error}
            </p>
            <div className="flex gap-2">
              <button type="button" onClick={close} className="rounded-lg border border-line px-3 py-1.5 text-sm hover:bg-brand-soft">
                Cancel
              </button>
              <button
                type="button"
                onClick={save}
                disabled={pending}
                className="rounded-lg bg-brand px-4 py-1.5 text-sm font-semibold text-brand-ink disabled:opacity-60"
              >
                {pending ? "Saving..." : "Save"}
              </button>
            </div>
          </div>
        </div>
      </dialog>
    </>
  );
}
