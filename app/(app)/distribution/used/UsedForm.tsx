"use client";

import { Fragment, useMemo, useRef, useState } from "react";
import { ActionForm } from "@/components/forms/ActionForm";
import type { FormState } from "@/components/forms/form-state";
import { DatePicker } from "@/components/ui/DatePicker";
import { Select } from "@/components/ui/Dropdown";
import { Field } from "@/components/ui/Field";
import { buttonClass, ghostButtonClass, inputClass } from "@/components/ui/styles";
import { isPackUnit, isPieceUnit, type CountUnit } from "@/lib/pack-size";
import { USAGE_REASONS } from "@/lib/usage-reasons";
import { CountUnitSelect } from "../receive/CountUnitSelect";
import { recordUsageAction } from "./actions";

/** An item that can be recorded as used. `unit` says what the quantity counts ("pieces", "Roll", "tests"...). */
export interface BenchItemOption {
  id: string;
  name: string;
  unit: string;
  /** Pieces in one pack. For a reagent counted in tests, the tests in one container. */
  packSize: number;
  /** The lab can enter this item in whole packs as well as pieces. */
  canSwitch: boolean;
  /** Tests one container covers, for a reagent counted in tests. Null for every other item. */
  testsPerUnit: number | null;
  /** What one container is called (litre, bottle...), for a reagent counted in tests. */
  containerUnit: string;
}

interface Props {
  /** Where the person is working (the app bar). Sent so the server refuses a form left open across a switch. */
  workLocationId: string;
  benchItems: BenchItemOption[];
  /** What is on the shelf now: `{ [itemTypeId]: { [locationId]: available } }`. A missing entry means none. */
  availability: Record<string, Record<string, number>>;
  /** Tests left in the container already open: `{ [itemTypeId]: { [locationId]: tests } }`. A missing entry means none. */
  openTests: Record<string, Record<string, number>>;
  /** Sealed containers that have their own label: `{ [itemTypeId]: { [locationId]: count } }`. Where there is one, a new container is scanned when opened. */
  labelled: Record<string, Record<string, number>>;
  /** Today, and the earliest day an entry may be dated, as YYYY-MM-DD. */
  today: string;
  earliest: string;
}

/** Search is only worth showing once the list is long enough to need it. */
const SEARCH_FROM = 7;

interface AccountedRow {
  key: number;
  reason: string;
  quantity: string;
  note: string;
}

interface Line {
  itemTypeId: string;
  quantity: string;
  countedIn: CountUnit;
  /** Reagents counted in tests only: the part of the container that was not patient tests. */
  accounted: AccountedRow[];
  /** Reagents counted in tests only: the container is empty, so nothing may be left unexplained in it. */
  finished: boolean;
  /** Reagents counted in tests only: the labels scanned for the containers this entry opens, in order. */
  containers: string[];
}

const validQuantity = (q: string) => Number.isInteger(Number(q)) && Number(q) >= 1;
const validCount = (q: string) => q.trim() !== "" && Number.isInteger(Number(q)) && Number(q) >= 0;

const testsWord = (n: number) => (n === 1 ? "test" : "tests");

/** The unit as a lower-case word that fits the number: "1 piece", "5 pieces", "2 packs". Other units are kept as they are. */
function unitWord(unit: string, n: number): string {
  const u = unit.trim().toLowerCase();
  if (u === "tests") return testsWord(n);
  if (isPieceUnit(u)) return n === 1 ? "piece" : "pieces";
  if (isPackUnit(u)) return n === 1 ? "pack" : "packs";
  return u;
}

/**
 * The end-of-day entry, shown in a pop-up, in two steps: first tick every item the lab used and press Done, then the
 * list goes away and only the chosen items are left, each with a quantity box. Several entries a day are fine, and the
 * date can be earlier so a missed day can be filled in the next morning. There is no patient and nothing to scan:
 * the stock comes off the shelf by earliest expiry, the way an issue does.
 *
 * A reagent counted in tests asks for the tests done instead. A container that is only part used carries its
 * remaining tests forward; the part that was not patient tests (quality control, calibration, waste) is entered with a
 * reason, and when the container is finished nothing may be left unexplained in it.
 *
 * What is ticked lives in React state and is submitted through hidden fields, so searching the list (which
 * removes rows) can never drop a ticked item from the entry.
 */
export function UsedForm({ workLocationId, benchItems, availability, openTests, labelled, today, earliest }: Props) {
  const locationId = workLocationId;
  const [lines, setLines] = useState<Line[]>([]);
  const [choosing, setChoosing] = useState(true);
  const [query, setQuery] = useState("");
  const nextKey = useRef(1);

  // With nothing chosen there is nothing to enter a quantity for, so the list is always open then.
  const showList = choosing || lines.length === 0;

  // What the shelf holds at the working location.
  const stockOf = (id: string) => availability[id]?.[locationId] ?? 0;
  const openOf = (id: string) => openTests[id]?.[locationId] ?? 0;
  const itemOf = (id: string) => benchItems.find((b) => b.id === id);
  const isTests = (l: Line) => itemOf(l.itemTypeId)?.testsPerUnit != null;
  const accountedTotal = (l: Line) => l.accounted.reduce((sum, a) => sum + (validQuantity(a.quantity) ? Number(a.quantity) : 0), 0);
  // What the entry takes off the shelf, in pieces (or tests): a count of packs is turned into pieces for the check and for saving.
  const piecesOf = (l: Line) =>
    isTests(l)
      ? (validCount(l.quantity) ? Number(l.quantity) : 0) + accountedTotal(l)
      : Number(l.quantity) * (l.countedIn === "pack" ? (itemOf(l.itemTypeId)?.packSize ?? 1) : 1);
  // Tests left in the container after this entry: what is left of the open one, then whatever the next container leaves.
  const leftAfter = (l: Line) => {
    const size = itemOf(l.itemTypeId)?.testsPerUnit ?? 1;
    const open = openOf(l.itemTypeId);
    const total = piecesOf(l);
    if (total <= open) return open - total;
    const rest = (total - open) % size;
    return rest === 0 ? 0 : size - rest;
  };
  // New containers this entry opens: what the open one cannot cover, in whole containers.
  const opensOf = (l: Line) => {
    const size = itemOf(l.itemTypeId)?.testsPerUnit ?? 1;
    const beyond = piecesOf(l) - openOf(l.itemTypeId);
    return beyond > 0 ? Math.ceil(beyond / size) : 0;
  };
  // Where the shelf holds labelled containers, each one opened is scanned. Older stock with no labels has nothing to scan.
  const scanNeeded = (l: Line) => (isTests(l) && (labelled[l.itemTypeId]?.[locationId] ?? 0) > 0 ? opensOf(l) : 0);
  const scannedCodes = (l: Line) =>
    l.containers
      .slice(0, scanNeeded(l))
      .map((c) => c.trim().toUpperCase())
      .filter((c) => c !== "");
  const scanProblem = (l: Line) => {
    const need = scanNeeded(l);
    if (need === 0) return false;
    const codes = scannedCodes(l);
    return codes.length !== need || new Set(codes).size !== codes.length;
  };
  const accountedProblem = (l: Line) =>
    l.accounted.some(
      (a) => !a.reason || !validQuantity(a.quantity) || (a.reason === "OTHER" && a.note.trim() === ""),
    );
  const lineInvalid = (l: Line) =>
    isTests(l)
      ? !validCount(l.quantity) ||
        accountedProblem(l) ||
        piecesOf(l) < 1 ||
        (l.finished && leftAfter(l) > 0) ||
        scanProblem(l)
      : !validQuantity(l.quantity);
  const anyShort = lines.some((l) => piecesOf(l) > stockOf(l.itemTypeId));
  const anyInvalid = lines.some(lineInvalid);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? benchItems.filter((b) => b.name.toLowerCase().includes(q)) : benchItems;
  }, [benchItems, query]);

  const toggle = (id: string) =>
    setLines((current) =>
      current.some((l) => l.itemTypeId === id)
        ? current.filter((l) => l.itemTypeId !== id)
        : [
            ...current,
            {
              itemTypeId: id,
              quantity: benchItems.find((b) => b.id === id)?.testsPerUnit != null ? "" : "1",
              countedIn: "pieces" as CountUnit,
              accounted: [],
              finished: false,
              containers: [],
            },
          ],
    );

  const patch = (id: string, change: Partial<Line> | ((l: Line) => Partial<Line>)) =>
    setLines((current) =>
      current.map((l) => (l.itemTypeId === id ? { ...l, ...(typeof change === "function" ? change(l) : change) } : l)),
    );

  const addAccounted = (id: string, quantity = "") =>
    patch(id, (l) => ({ accounted: [...l.accounted, { key: nextKey.current++, reason: "", quantity, note: "" }] }));

  const patchAccounted = (id: string, key: number, change: Partial<AccountedRow>) =>
    patch(id, (l) => ({ accounted: l.accounted.map((a) => (a.key === key ? { ...a, ...change } : a)) }));

  const removeAccounted = (id: string, key: number) =>
    patch(id, (l) => ({ accounted: l.accounted.filter((a) => a.key !== key) }));

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
        Nothing can be recorded here yet. An admin marks an item as a bench supply, or sets the tests per container of a
        reagent, on Admin &gt; Item types, and it then appears here.
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
                const open = openOf(item.id);
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
                        {stock > 0
                          ? item.testsPerUnit != null
                            ? `${stock.toLocaleString("en-GB")} ${stock === 1 ? "test" : "tests"} can be done with this reagent`
                            : `${stock.toLocaleString("en-GB")} ${unitWord(item.unit, stock)} in stock here`
                          : "None in stock here"}
                        {item.testsPerUnit != null && open > 0
                          ? ` (${open.toLocaleString("en-GB")} left in the open container)`
                          : ""}
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
          <div className="flex flex-col gap-3">
            {lines.map((line, index) => {
              const item = itemOf(line.itemTypeId);
              const stock = stockOf(line.itemTypeId);
              const short = piecesOf(line) > stock;
              const tests = isTests(line);
              const inPacks = line.countedIn === "pack";
              const packSize = item?.packSize ?? 1;
              const maxInUnit = inPacks ? Math.floor(stock / packSize) : stock;
              const invalid = tests ? !validCount(line.quantity) : !validQuantity(line.quantity);
              const open = openOf(line.itemTypeId);
              const left = tests ? leftAfter(line) : 0;
              // A reagent counted in tests is held in containers. The item's unit of measure (litre, ml) is what it is
              // measured in, not what one is called, so the wording says "container".
              const container = "container";
              return (
                <div key={line.itemTypeId} className="flex flex-col gap-2">
                  <div className="grid grid-cols-[1fr_6.5rem_9rem_auto] items-center gap-2">
                    <span className="min-w-0 text-sm">
                      <span className="block truncate">
                        {item?.name ?? "Item"}
                      </span>
                      <span className={`block text-xs ${stock === 0 || short ? "font-medium text-red-700" : "text-zinc-500"}`}>
                        {stock > 0
                          ? tests
                            ? `${stock.toLocaleString("en-GB")} ${stock === 1 ? "test" : "tests"} can be done with this reagent`
                            : `${stock.toLocaleString("en-GB")} ${item ? unitWord(item.unit, stock) : ""} in stock here`
                          : "None in stock here"}
                        {tests && item ? ` (${item.testsPerUnit?.toLocaleString("en-GB")} per ${container})` : ""}
                        {inPacks ? ` (${packSize.toLocaleString("en-GB")} per pack)` : ""}
                        {short && stock > 0
                          ? tests
                            ? ", not enough for that many tests"
                            : maxInUnit >= 1
                              ? `, reduce to ${maxInUnit.toLocaleString("en-GB")} ${inPacks ? (maxInUnit === 1 ? "pack" : "packs") : ""} or less`
                              : ", not enough for a whole pack"
                          : ""}
                      </span>
                    </span>
                    <input
                      type="number"
                      min={tests ? 0 : 1}
                      step={1}
                      inputMode="numeric"
                      // The first quantity is ready to type into as soon as the list closes.
                      autoFocus={index === 0}
                      aria-label={tests ? `Tests done with ${item?.name ?? "item"}` : `Quantity of ${item?.name ?? "item"}`}
                      placeholder={tests ? "Tests done" : undefined}
                      aria-invalid={invalid || short}
                      value={line.quantity}
                      onChange={(e) => patch(line.itemTypeId, { quantity: e.target.value })}
                      className={`${inputClass} ${invalid || short ? "border-red-500" : ""}`}
                    />
                    {tests ? (
                      <span className="text-sm text-muted">tests done</span>
                    ) : item?.canSwitch ? (
                      <CountUnitSelect
                        batchCode={item.name}
                        defaultValue="pieces"
                        value={line.countedIn}
                        onChange={(unit) => patch(line.itemTypeId, { countedIn: unit })}
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

                  {tests ? (
                    <div className="ml-3 flex flex-col gap-2 border-l-2 border-line pl-3">
                      <p className="text-xs text-zinc-500">
                        {open > 0
                          ? `${open.toLocaleString("en-GB")} ${testsWord(open)} left in the open ${container}. `
                          : `No ${container} is open now, so a new one is opened. `}
                        Anything that was not a patient test (quality control, calibration, waste) is added below with a
                        reason. A part-used {container} carries its remaining tests to the next entry.
                      </p>

                      {scanNeeded(line) > 0 ? (
                        <div className="flex flex-col gap-1.5">
                          <p className="text-xs font-medium">
                            {scanNeeded(line) === 1
                              ? `This opens a new ${container}. Scan the label on it.`
                              : `This opens ${scanNeeded(line)} new ${container}s. Scan the label on each, in the order they were opened.`}
                          </p>
                          {Array.from({ length: scanNeeded(line) }, (_, i) => {
                            const value = line.containers[i] ?? "";
                            const typed = value.trim().toUpperCase();
                            const twice =
                              typed !== "" &&
                              line.containers.slice(0, scanNeeded(line)).filter((c) => c.trim().toUpperCase() === typed).length > 1;
                            return (
                              <input
                                key={i}
                                value={value}
                                autoComplete="off"
                                spellCheck={false}
                                aria-label={`Label of ${container} ${i + 1} opened`}
                                placeholder={`Scan label of ${container} ${scanNeeded(line) > 1 ? i + 1 : ""}`.trim()}
                                aria-invalid={typed === "" || twice}
                                onChange={(e) =>
                                  patch(line.itemTypeId, (l) => ({
                                    containers: Array.from({ length: Math.max(l.containers.length, i + 1) }, (_unused, k) =>
                                      k === i ? e.target.value : (l.containers[k] ?? ""),
                                    ),
                                  }))
                                }
                                // A scanner ends with Enter: move to the next label instead of submitting the entry.
                                onKeyDown={(e) => {
                                  if (e.key !== "Enter") return;
                                  e.preventDefault();
                                  const fields = e.currentTarget.parentElement?.querySelectorAll("input");
                                  fields?.[i + 1]?.focus();
                                }}
                                className={`${inputClass} font-mono ${typed === "" || twice ? "border-red-500" : ""}`}
                              />
                            );
                          })}
                          {scanProblem(line) ? (
                            <p className="text-xs font-medium text-red-700">
                              {scannedCodes(line).length < scanNeeded(line)
                                ? "Scan the label of every new container before recording."
                                : "The same label is entered twice."}
                            </p>
                          ) : null}
                        </div>
                      ) : null}

                      {line.accounted.map((a) => {
                        const rowBad = !a.reason || !validQuantity(a.quantity) || (a.reason === "OTHER" && a.note.trim() === "");
                        return (
                          <div key={a.key} className="grid grid-cols-[minmax(0,1.2fr)_5.5rem_minmax(0,1.5fr)_auto] items-center gap-2">
                            <Select
                              // Not read by the server (the reasons travel in the entry's own field), but each row needs its own name.
                              name={`reason-${a.key}`}
                              ariaLabel="Reason"
                              placeholder="Choose a reason"
                              value={a.reason}
                              onChange={(value) => patchAccounted(line.itemTypeId, a.key, { reason: value })}
                              options={USAGE_REASONS.map((r) => ({ value: r.code, label: r.label }))}
                            />
                            <input
                              type="number"
                              min={1}
                              step={1}
                              inputMode="numeric"
                              aria-label="Tests for this reason"
                              placeholder="Tests"
                              value={a.quantity}
                              onChange={(e) => patchAccounted(line.itemTypeId, a.key, { quantity: e.target.value })}
                              className={`${inputClass} ${!validQuantity(a.quantity) ? "border-red-500" : ""}`}
                            />
                            <input
                              maxLength={120}
                              autoComplete="off"
                              aria-label="Note"
                              placeholder={a.reason === "OTHER" ? "Say why (required)" : "Note (optional)"}
                              value={a.note}
                              onChange={(e) => patchAccounted(line.itemTypeId, a.key, { note: e.target.value })}
                              className={`${inputClass} ${rowBad && a.reason === "OTHER" && a.note.trim() === "" ? "border-red-500" : ""}`}
                            />
                            <button
                              type="button"
                              onClick={() => removeAccounted(line.itemTypeId, a.key)}
                              className={ghostButtonClass}
                              aria-label="Remove this reason"
                            >
                              Remove
                            </button>
                          </div>
                        );
                      })}

                      <div className="flex flex-wrap items-center gap-3">
                        <button type="button" onClick={() => addAccounted(line.itemTypeId)} className={`${ghostButtonClass} py-1.5`}>
                          Add a reason
                        </button>
                        <label className="flex items-center gap-2 text-sm">
                          <input
                            type="checkbox"
                            checked={line.finished}
                            onChange={(e) => patch(line.itemTypeId, { finished: e.target.checked })}
                          />
                          {`${container.charAt(0).toUpperCase()}${container.slice(1)} finished`}
                        </label>
                      </div>

                      {line.finished && left > 0 ? (
                        <p className="flex flex-wrap items-center gap-2 text-xs font-medium text-red-700">
                          {`${left.toLocaleString("en-GB")} ${testsWord(left)} still left in the ${container}. Account for ${left === 1 ? "it" : "them"} with a reason to finish it.`}
                          <button
                            type="button"
                            onClick={() => addAccounted(line.itemTypeId, String(left))}
                            className={`${ghostButtonClass} py-1`}
                          >
                            {`Account for ${left.toLocaleString("en-GB")}`}
                          </button>
                        </p>
                      ) : (
                        <p className="text-xs text-zinc-500">
                          {left > 0
                            ? `${left.toLocaleString("en-GB")} ${testsWord(left)} will be left in the ${container}.`
                            : piecesOf(line) > 0
                              ? `Nothing left in the ${container} after this entry.`
                              : ""}
                        </p>
                      )}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}

        {/* What is submitted. Kept apart from the visible rows so closing the list or searching never drops an item. */}
        {lines.map((l) => (
          <Fragment key={l.itemTypeId}>
            <input type="hidden" name="itemTypeId" value={l.itemTypeId} />
            <input
              type="hidden"
              name="lineQuantity"
              value={isTests(l) ? String(validCount(l.quantity) ? Number(l.quantity) : 0) : String(piecesOf(l))}
            />
            <input
              type="hidden"
              name="lineExtra"
              value={
                isTests(l)
                  ? JSON.stringify({
                      accounted: l.accounted.map((a) => ({
                        reason: a.reason,
                        quantity: Number(a.quantity),
                        ...(a.note.trim() ? { note: a.note.trim() } : {}),
                      })),
                      finished: l.finished,
                      containerCodes: scannedCodes(l),
                    })
                  : ""
              }
            />
          </Fragment>
        ))}
      </div>
    </ActionForm>
  );
}
