"use client";

import { Fragment, useMemo, useState } from "react";
import { ActionForm } from "@/components/forms/ActionForm";
import type { FormState } from "@/components/forms/form-state";
import { DatePicker } from "@/components/ui/DatePicker";
import { Field } from "@/components/ui/Field";
import { buttonClass, ghostButtonClass, inputClass } from "@/components/ui/styles";
import { isPackUnit, isPieceUnit, type CountUnit } from "@/lib/pack-size";
import { CountUnitSelect } from "../receive/CountUnitSelect";
import { recordUsageAction } from "./actions";

/** A bench supply that can be recorded as used. `unit` says what the quantity counts ("pieces", "Roll"...). */
export interface BenchItemOption {
  id: string;
  name: string;
  unit: string;
  /** Pieces in one pack. */
  packSize: number;
  /** The lab can enter this item in whole packs as well as pieces. */
  canSwitch: boolean;
}

interface Props {
  /** Where the person is working (the app bar). Sent so the server refuses a form left open across a switch. */
  workLocationId: string;
  benchItems: BenchItemOption[];
  /** What is on the shelf now: `{ [itemTypeId]: { [locationId]: available } }`. A missing entry means none. */
  availability: Record<string, Record<string, number>>;
  /** Today, and the earliest day an entry may be dated, as YYYY-MM-DD. */
  today: string;
  earliest: string;
}

/** Search is only worth showing once the list is long enough to need it. */
const SEARCH_FROM = 7;

const validQuantity = (q: string) => Number.isInteger(Number(q)) && Number(q) >= 1;

/** The unit as a lower-case word that fits the number: "1 piece", "5 pieces", "2 packs". Other units are kept as they are. */
function unitWord(unit: string, n: number): string {
  const u = unit.trim().toLowerCase();
  if (isPieceUnit(u)) return n === 1 ? "piece" : "pieces";
  if (isPackUnit(u)) return n === 1 ? "pack" : "packs";
  return u;
}

/**
 * The end-of-day entry, shown in a pop-up, in two steps: first tick every bench item the lab used and press Done,
 * then the list goes away and only the chosen items are left, each with a quantity box. Several entries a day are
 * fine, and the date can be earlier so a missed day can be filled in the next morning. There is no patient and
 * nothing to scan: the stock comes off the shelf by earliest expiry, the way an issue does.
 *
 * What is ticked lives in React state and is submitted through hidden fields, so searching the list (which
 * removes rows) can never drop a ticked item from the entry.
 */
export function UsedForm({ workLocationId, benchItems, availability, today, earliest }: Props) {
  const locationId = workLocationId;
  const [lines, setLines] = useState<{ itemTypeId: string; quantity: string; countedIn: CountUnit }[]>([]);
  const [choosing, setChoosing] = useState(true);
  const [query, setQuery] = useState("");

  // With nothing chosen there is nothing to enter a quantity for, so the list is always open then.
  const showList = choosing || lines.length === 0;

  // What the shelf holds at the working location.
  const stockOf = (id: string) => availability[id]?.[locationId] ?? 0;
  const itemOf = (id: string) => benchItems.find((b) => b.id === id);
  // What the entry takes off the shelf, in pieces: a count of packs is turned into pieces for the check and for saving.
  const piecesOf = (l: { itemTypeId: string; quantity: string; countedIn: CountUnit }) =>
    Number(l.quantity) * (l.countedIn === "pack" ? (itemOf(l.itemTypeId)?.packSize ?? 1) : 1);
  const anyShort = lines.some((l) => piecesOf(l) > stockOf(l.itemTypeId));
  const anyInvalid = lines.some((l) => !validQuantity(l.quantity));

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? benchItems.filter((b) => b.name.toLowerCase().includes(q)) : benchItems;
  }, [benchItems, query]);

  const toggle = (id: string) =>
    setLines((current) =>
      current.some((l) => l.itemTypeId === id)
        ? current.filter((l) => l.itemTypeId !== id)
        : [...current, { itemTypeId: id, quantity: "1", countedIn: "pieces" as CountUnit }],
    );

  const finishChoosing = () => {
    setQuery("");
    setChoosing(false);
  };

  // A saved entry closes the pop-up (ActionForm does that) and the next one starts empty. A rejected entry keeps
  // everything that was typed.
  async function save(prev: FormState, formData: FormData): Promise<FormState> {
    const result = await recordUsageAction(prev, formData);
    if (!result.error && result.message) {
      setLines([]);
      setChoosing(true);
    }
    return result;
  }

  if (benchItems.length === 0) {
    return (
      <p className="rounded-xl border border-line bg-surface p-4 text-sm">
        No bench supplies are set up yet. An admin marks an item as a bench supply on Admin &gt; Item types, and it
        then appears here.
      </p>
    );
  }

  return (
    <ActionForm
      action={save}
      submitLabel="Record usage"
      disabled={showList || lines.length === 0 || anyShort || anyInvalid}
    >
      <input type="hidden" name="locationId" value={locationId} />
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Date used" tip="Today, or an earlier day if one was missed.">
          <DatePicker name="usedOn" required defaultValue={today} min={earliest} max={today} ariaLabel="Date used" />
        </Field>
        <Field label="For which test or section" tip="Optional, for example Blood bank or AHG.">
          <input name="section" maxLength={60} autoComplete="off" className={inputClass} />
        </Field>
      </div>

      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-3">
          <p className="text-sm font-medium">What was used</p>
          {showList ? (
            <p className="text-xs text-zinc-500">{lines.length === 0 ? "Tick each item the lab used" : `${lines.length} selected`}</p>
          ) : (
            <button type="button" onClick={() => setChoosing(true)} className={`${ghostButtonClass} py-1.5`}>
              Change items
            </button>
          )}
        </div>

        {showList ? (
          <>
            {benchItems.length >= SEARCH_FROM ? (
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                // Enter in the search box must not submit the whole entry.
                onKeyDown={(e) => {
                  if (e.key === "Enter") e.preventDefault();
                }}
                placeholder="Search items..."
                aria-label="Search items"
                autoComplete="off"
                className={`${inputClass} w-full`}
              />
            ) : null}

            <div role="group" aria-label="Items the lab used" className="flex max-h-[45dvh] flex-col overflow-y-auto rounded-lg border border-line">
              {visible.map((item) => {
                const on = lines.some((l) => l.itemTypeId === item.id);
                const stock = stockOf(item.id);
                return (
                  <button
                    key={item.id}
                    type="button"
                    role="checkbox"
                    aria-checked={on}
                    onClick={() => toggle(item.id)}
                    className={`flex items-center gap-3 border-b border-line px-3 py-2.5 text-left last:border-b-0 hover:bg-brand-soft ${on ? "bg-brand-soft" : ""}`}
                  >
                    <span
                      aria-hidden
                      className={`flex h-5 w-5 shrink-0 items-center justify-center rounded border text-xs leading-none ${
                        on ? "border-brand bg-brand text-brand-ink" : "border-line bg-surface"
                      }`}
                    >
                      {on ? "✓" : ""}
                    </span>
                    <span className="min-w-0 flex-1 text-sm">
                      <span className={`block truncate ${on ? "font-semibold" : ""}`}>
                        {item.name}
                      </span>
                      <span className={`block text-xs ${stock === 0 ? "font-medium text-red-700" : "text-zinc-500"}`}>
                        {stock > 0 ? `${stock.toLocaleString("en-GB")} ${unitWord(item.unit, stock)} in stock here` : "None in stock here"}
                      </span>
                    </span>
                  </button>
                );
              })}
              {visible.length === 0 ? <p className="px-3 py-3 text-sm text-zinc-500">No items match that search.</p> : null}
            </div>

            <div className="flex justify-end">
              <button type="button" onClick={finishChoosing} disabled={lines.length === 0} className={buttonClass}>
                {lines.length === 0 ? "Done" : `Done, ${lines.length} selected`}
              </button>
            </div>
          </>
        ) : (
          <div className="flex flex-col gap-2">
            {lines.map((line, index) => {
              const item = itemOf(line.itemTypeId);
              const stock = stockOf(line.itemTypeId);
              const short = piecesOf(line) > stock;
              const inPacks = line.countedIn === "pack";
              const packSize = item?.packSize ?? 1;
              const maxInUnit = inPacks ? Math.floor(stock / packSize) : stock;
              const invalid = !validQuantity(line.quantity);
              return (
                <div key={line.itemTypeId} className="grid grid-cols-[1fr_6.5rem_9rem_auto] items-center gap-2">
                  <span className="min-w-0 text-sm">
                    <span className="block truncate">
                      {item?.name ?? "Item"}
                    </span>
                    <span className={`block text-xs ${stock === 0 || short ? "font-medium text-red-700" : "text-zinc-500"}`}>
                      {stock > 0 ? `${stock.toLocaleString("en-GB")} ${item ? unitWord(item.unit, stock) : ""} in stock here` : "None in stock here"}
                      {inPacks ? ` (${packSize.toLocaleString("en-GB")} per pack)` : ""}
                      {short && stock > 0
                        ? maxInUnit >= 1
                          ? `, reduce to ${maxInUnit.toLocaleString("en-GB")} ${inPacks ? (maxInUnit === 1 ? "pack" : "packs") : ""} or less`
                          : ", not enough for a whole pack"
                        : ""}
                    </span>
                  </span>
                  <input
                    type="number"
                    min={1}
                    step={1}
                    inputMode="numeric"
                    // The first quantity is ready to type into as soon as the list closes.
                    autoFocus={index === 0}
                    aria-label={`Quantity of ${item?.name ?? "item"}`}
                    aria-invalid={invalid || short}
                    value={line.quantity}
                    onChange={(e) =>
                      setLines((current) =>
                        current.map((l) => (l.itemTypeId === line.itemTypeId ? { ...l, quantity: e.target.value } : l)),
                      )
                    }
                    className={`${inputClass} ${invalid || short ? "border-red-500" : ""}`}
                  />
                  {item?.canSwitch ? (
                    <CountUnitSelect
                      batchCode={item.name}
                      defaultValue="pieces"
                      value={line.countedIn}
                      onChange={(unit) =>
                        setLines((current) =>
                          current.map((l) => (l.itemTypeId === line.itemTypeId ? { ...l, countedIn: unit } : l)),
                        )
                      }
                    />
                  ) : (
                    <span className="text-sm text-muted">{item ? unitWord(item.unit, Number(line.quantity)) : ""}</span>
                  )}
                  <button
                    type="button"
                    onClick={() => toggle(line.itemTypeId)}
                    className={ghostButtonClass}
                    aria-label={`Remove ${item?.name ?? "item"}`}
                  >
                    Remove
                  </button>
                </div>
              );
            })}
          </div>
        )}

        {/* What is submitted. Kept apart from the visible rows so closing the list or searching never drops an item. */}
        {lines.map((l) => (
          <Fragment key={l.itemTypeId}>
            <input type="hidden" name="itemTypeId" value={l.itemTypeId} />
            <input type="hidden" name="lineQuantity" value={String(piecesOf(l))} />
          </Fragment>
        ))}
      </div>
    </ActionForm>
  );
}
