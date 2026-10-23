"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { ActionForm, SubmitSlot } from "@/components/forms/ActionForm";
import type { FormState } from "@/components/forms/form-state";
import { ScanField } from "@/components/scanner/ScanField";
import { Field } from "@/components/ui/Field";
import { Select } from "@/components/ui/Dropdown";
import { Modal } from "@/components/ui/Modal";
import { DialogToast } from "@/components/ui/DialogToast";
import { playScanTone } from "@/components/scanner/ScanFeedback";
import { buttonClass, ghostButtonClass, inputClass } from "@/components/ui/styles";
import { referenceAllowedAt } from "@/lib/issue-location";
import { firstCatalogCode, issueAllPlan, parseRequest, remainingBottles, type Bottle, type BottlePlanEntry } from "@/lib/request-paste";
import { COLLECTOR_TYPES, PATIENT_TYPES, REFERENCE_TYPES } from "@/server/domain/types";
import { checkBottleStockAction, issueUnitAction } from "./actions";

/** A test and the per-patient items one run of it normally uses (empty when the lab has not listed any yet). */
export interface TestOption {
  code: string;
  name: string;
  /** The container the test needs (EDTA, PLAIN...); null when any container will do. */
  requiredContainerType: string | null;
  /** Ticked on the Test catalog once the lab has confirmed the list. */
  confirmed: boolean;
  items: { itemTypeId: string; quantity: number }[];
}

/** A per-patient item that can be added to a test's list at the point of issue. */
export interface BulkItemOption {
  id: string;
  name: string;
  unit: string;
}

interface Props {
  /** The page title and intro, shown on the left with the button on the right. */
  header: ReactNode;
  /** Where the person is working, set in the app bar. Sent with the form so a form left open across a switch is refused. */
  workLocationId: string;
  /** What that location does for stock. A bench or the blood bank issues for its department only. */
  workServiceRole: string | null;
  canOverride: boolean;
  /** Active tests with their standard items, which fill the "Items issued with it" list. */
  tests: TestOption[];
  /** Every per-patient item type, for adding to a test's list. */
  bulkItems: BulkItemOption[];
}

interface Line {
  itemTypeId: string;
  quantity: string;
}

const label = (value: string) => value.charAt(0) + value.slice(1).toLowerCase().replace(/_/g, " ");

/** A container as shown on a bottle row: the short codes stay in capitals (EDTA), the rest read as words (Plain). */
const containerLabel = (value: string) => (value.length <= 4 ? value : label(value));

/** The items list a test starts with: its standard items (empty when the test is not in the catalog or lists none). */
function linesFor(code: string, tests: TestOption[]): Line[] {
  const chosen = tests.find((t) => t.code === code);
  return (chosen?.items ?? []).map((i) => ({ itemTypeId: i.itemTypeId, quantity: String(i.quantity) }));
}

/** What has been issued from one pasted request so far, across the bottles the pop-up moved on through. */
interface IssuedRun {
  serials: string[];
  messages: string[];
  /** Any of it came from stock, so its labels come up to print when the request is done. */
  fromStock: boolean;
}

const NO_RUN: IssuedRun = { serials: [], messages: [], fromStock: false };

/**
 * What a pop-up that moved on to the next bottle of the same request starts from: the pasted text, the containers
 * already issued or removed from the list, and what was filled in beside it (so it is not typed again for each bottle).
 */
interface Resume {
  pasted: string;
  done: string[];
  removed: string[];
  patientType: string;
  collectorType: string;
  collectorName: string;
}

const FRESH: Resume = { pasted: "", done: [], removed: [], patientType: "", collectorType: "PATIENT", collectorName: "" };

/** The containers already issued, as the form sends them back (a JSON list). */
function parseDone(value: FormDataEntryValue | null): string[] {
  try {
    const list: unknown = JSON.parse(String(value ?? "[]"));
    return Array.isArray(list) ? list.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/**
 * The per-patient items issued with the bottle. They come up when the first investigation has a test code and the
 * test has a list; each line can be changed or removed and other items added. What is left on screen when the
 * person confirms is what leaves the shelf, once for the bottle, linked to the patient.
 */
function ItemsIssued({
  tests,
  bulkItems,
  testCode,
  lines,
  setLines,
}: {
  tests: TestOption[];
  bulkItems: BulkItemOption[];
  testCode: string;
  lines: Line[];
  setLines: (lines: Line[]) => void;
}) {
  const [toAdd, setToAdd] = useState("");
  const test = tests.find((t) => t.code === testCode);
  const nameOf = (id: string) => bulkItems.find((b) => b.id === id);
  const addable = bulkItems.filter((b) => !lines.some((l) => l.itemTypeId === b.id));

  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm font-medium">Items issued with it</p>
      {!testCode ? (
        <p className="text-sm text-zinc-500">
          Choose a test above to bring up the items it uses.
        </p>
      ) : null}
      {test && test.items.length === 0 ? (
        <p className="text-sm text-zinc-500">
          No standard items are listed for {test.code} yet. Add what was used below, or ask an admin to list them on the
          Test catalog.
        </p>
      ) : null}
      {test && test.items.length > 0 && !test.confirmed ? (
        <p className="text-sm text-warn">The lab has not confirmed this list yet. Correct any quantity that is wrong.</p>
      ) : null}
      {lines.map((line, index) => {
        const item = nameOf(line.itemTypeId);
        return (
          <div key={line.itemTypeId} className="grid grid-cols-[1fr_7rem_auto] items-center gap-2">
            <span className="min-w-0 truncate text-sm">
              {item?.name ?? "Item"}
              {item ? <span className="text-zinc-500"> ({item.unit})</span> : null}
            </span>
            <input type="hidden" name="itemTypeId" value={line.itemTypeId} />
            <input
              name="lineQuantity"
              type="number"
              min={1}
              step={1}
              required
              inputMode="numeric"
              aria-label={`Quantity of ${item?.name ?? "item"}`}
              value={line.quantity}
              onChange={(e) => setLines(lines.map((l, i) => (i === index ? { ...l, quantity: e.target.value } : l)))}
              className={inputClass}
            />
            <button
              type="button"
              onClick={() => {
                setLines(lines.filter((_, i) => i !== index));
                setToAdd("");
              }}
              className={ghostButtonClass}
              aria-label={`Remove ${item?.name ?? "item"}`}
            >
              Remove
            </button>
          </div>
        );
      })}
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          {/* Remounted after each add or removal (the key) so the choice goes back to blank. */}
          <Select
            key={lines.length}
            name="addItem"
            ariaLabel="Item to add"
            emptyLabel="Add another item"
            options={addable.map((b) => ({ value: b.id, label: `${b.name} (${b.unit})` }))}
            onChange={setToAdd}
          />
        </div>
        <button
          type="button"
          disabled={!toAdd}
          onClick={() => {
            setLines([...lines, { itemTypeId: toAdd, quantity: "1" }]);
            setToAdd("");
          }}
          className={ghostButtonClass}
        >
          Add
        </button>
      </div>
      <p className="text-xs text-zinc-500">
        These come off the shelf here, earliest expiry first, and are linked to this patient. Shared bench supplies such as
        cotton wool go under Used for test instead. Remove every line to issue the bottle alone.
      </p>
    </div>
  );
}

/**
 * Everything in the issue form after the scan field: where, who the bottle is for, which investigations, who
 * collected it, and (for an investigation) the items issued with it. Picking the test code on the first
 * investigation line fills the items list with that test's standard items.
 */
function IssueFields({
  tests,
  bulkItems,
  workLocationId,
  workServiceRole,
  canOverride,
  fromStock,
  issueAll,
  onIssueAll,
  resume,
}: Pick<Props, "tests" | "bulkItems" | "workLocationId" | "workServiceRole" | "canOverride"> & {
  /** Issue from stock instead of a scanned bottle: the chosen bottle's container says which one to take. */
  fromStock: boolean;
  /** Issue every bottle the request needs from stock, one after the other (the selected bottle first). */
  issueAll: boolean;
  /** The "Issue all" button was pressed: the pop-up switches to stock mode and submits this form. */
  onIssueAll: (form: HTMLFormElement | null) => void;
  /** After a bottle was issued the pop-up opens again on the same request: what it starts from. */
  resume: Resume;
}) {
  const { pasted: initialPasted, done: doneContainers, removed: removedContainers } = resume;
  // A fresh pop-up starts empty. One that moved on to the next bottle starts from the same request: the text is kept,
  // the bottles already issued are marked, and the next one is selected with its items filled in.
  const [seed] = useState(() => {
    const parsed = initialPasted ? parseRequest(initialPasted, tests) : null;
    const list = (parsed?.bottles ?? []).filter((b) => !removedContainers.includes(b.container));
    const next = list.findIndex((b) => !doneContainers.includes(b.container));
    return { parsed, list, next, code: firstCatalogCode(list[next], tests) ?? "" };
  });
  const [references, setReferences] = useState(seed.parsed ? seed.parsed.investigations.join("\n") : "");
  const [lines, setLines] = useState<Line[]>(() => linesFor(seed.code, tests));
  const [filledFor, setFilledFor] = useState(seed.code);
  const [pasted, setPasted] = useState(initialPasted);
  const [patientNo, setPatientNo] = useState(seed.parsed?.patientHospitalNo ?? "");
  const [bottles, setBottles] = useState<Bottle[]>(seed.list);
  const [activeBottle, setActiveBottle] = useState(seed.next);
  // Bottles taken off the list because none is in stock (or none is wanted): they are not issued, and the pop-up does
  // not wait for them.
  const [removed, setRemoved] = useState<string[]>(removedContainers);
  // Which of the bottles still to issue have stock here, for the request it was looked up for (`key`).
  const [stock, setStock] = useState<{ key: string; available: Record<string, boolean> } | null>(null);
  const pasteRef = useRef<HTMLTextAreaElement>(null);

  // Every issue is for an investigation, except at a bench section or the blood bank, which use stock for the
  // department and not per patient (corrections C2): there it is a department reference.
  const typeOptions = REFERENCE_TYPES.filter((t) => referenceAllowedAt(workServiceRole, t));
  const referenceType = typeOptions.includes("INVESTIGATION" as never) ? "INVESTIGATION" : (typeOptions[0] ?? "DEPARTMENT");
  const testCode = referenceType === "INVESTIGATION" ? filledFor : "";

  /** Chooses the test and fills the items list with its standard items. Edits made afterwards stay until the test changes. */
  function pickTest(code: string) {
    if (code === filledFor) return;
    setFilledFor(code);
    setLines(linesFor(code, tests));
  }

  function onReferences(text: string) {
    setReferences(text);
  }

  /** Chooses a bottle from the pasted request: its first test that is in the catalog becomes the Test, which fills the items. */
  function chooseBottle(index: number, list: Bottle[]) {
    setActiveBottle(index);
    pickTest(firstCatalogCode(list[index], tests) ?? "");
  }

  /** Reads the pasted request: fills the patient's number and the bottles, and picks the first bottle. */
  function onPaste(text: string) {
    setPasted(text);
    const parsed = parseRequest(text, tests);
    // What was issued or removed stays that way only while the text is still the request it was for.
    const same = text.trim() === initialPasted.trim();
    const gone = same ? removedContainers : [];
    setRemoved(gone);
    const list = parsed.bottles.filter((b) => !gone.includes(b.container));
    setBottles(list);
    setPatientNo(parsed.patientHospitalNo);
    // At a department-only place the reference is typed in its own box, so the paste leaves it alone.
    if (referenceType === "INVESTIGATION") setReferences(parsed.investigations.join("\n"));
    const skip = same ? doneContainers : [];
    const next = list.findIndex((b) => !skip.includes(b.container));
    if (next >= 0) chooseBottle(next, list);
    else setActiveBottle(-1);
  }

  /** Takes a bottle off the list (none in stock), and moves the selection on when it was the selected one. */
  function removeBottle(container: string) {
    const current = bottles[activeBottle]?.container;
    const list = bottles.filter((b) => b.container !== container);
    setBottles(list);
    setRemoved([...removed, container]);
    if (current !== container) {
      setActiveBottle(list.findIndex((b) => b.container === current));
      return;
    }
    const next = list.findIndex((b) => !doneNow.includes(b.container));
    if (next >= 0) chooseBottle(next, list);
    else setActiveBottle(-1);
  }

  const activeTest = bottles[activeBottle]?.tests.find((t) => t.catalogCode && t.catalogCode === filledFor);
  const doneNow = pasted.trim() === initialPasted.trim() ? doneContainers : [];
  // Every bottle still to issue, the selected one first: what "Issue all" takes from stock.
  const plan = issueAllPlan(bottles, doneNow, bottles[activeBottle]?.container, tests);

  const isInvestigation = referenceType === "INVESTIGATION";

  // Whether each bottle still to issue has stock here. Only looked up: nothing is issued. "Issue all" waits for it, so
  // it never starts a run that would stop half-way, and the bottle with none in stock can be removed from the list.
  const stockRequest = JSON.stringify({ bottles: isInvestigation ? plan : [], locationId: workLocationId });
  useEffect(() => {
    const request: { bottles: BottlePlanEntry[]; locationId: string } = JSON.parse(stockRequest);
    if (request.bottles.length === 0) return;
    let cancelled = false;
    // A moment after the last change, so typing in the paste box does not look stock up for every letter.
    const timer = window.setTimeout(() => {
      checkBottleStockAction(request).then(
        (res) => {
          // A check that could not run blocks nothing: the issue itself still checks stock.
          if (!cancelled) setStock({ key: stockRequest, available: res.ok ? res.available : {} });
        },
        () => {
          if (!cancelled) setStock({ key: stockRequest, available: {} });
        },
      );
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [stockRequest]);
  const available = stock !== null && stock.key === stockRequest ? stock.available : null;
  const isOut = (container: string) => available !== null && available[container] === false;
  const outOfStock = plan.filter((p) => isOut(p.container));
  const checking = isInvestigation && plan.length > 0 && available === null;
  // The paste box is the only place the patient and the investigation come from, so it blocks the submit, with
  // a message, until both were found in it.
  const missing = isInvestigation
    ? [
        !patientNo && "the hospital number",
        references === "" && "the investigation number (IXS...)",
        fromStock && activeBottle < 0 && "the tests",
      ]
        .filter(Boolean)
        .join(" and ")
    : "";
  useEffect(() => {
    pasteRef.current?.setCustomValidity(missing ? `Paste the request with ${missing}.` : "");
  }, [missing]);

  return (
    <>
      <Field
        label="Paste the request"
        tip="Paste the patient's hospital number, the investigation number (IXS...) and the tests. The bottles are worked out from the tests."
      >
        <textarea
          ref={pasteRef}
          rows={4}
          value={pasted}
          onChange={(e) => onPaste(e.target.value)}
          placeholder="Paste the request here"
          className={inputClass}
        />
      </Field>
      {isInvestigation && pasted.trim() !== "" && missing ? (
        <p className="text-sm text-warn">Could not find {missing} in that text.</p>
      ) : null}
      {references !== "" && isInvestigation ? (
        <p className="text-sm">
          Investigation <span className="font-mono">{references.split("\n").join(", ")}</span>
        </p>
      ) : null}
      {bottles.length > 0 ? (
        <div className="flex flex-col gap-2">
          <p className="text-sm font-medium">
            {patientNo ? (
              <>
                Bottles to be issued for <span className="font-mono">{patientNo}</span>
              </>
            ) : (
              "Bottles to be issued"
            )}
          </p>
          {bottles.map((bottle, index) => {
            const issued = doneNow.includes(bottle.container);
            const out = !issued && isInvestigation && isOut(bottle.container);
            return (
              <div key={bottle.container} className="flex items-stretch gap-2">
                <button
                  type="button"
                  disabled={issued}
                  aria-pressed={index === activeBottle}
                  onClick={() => chooseBottle(index, bottles)}
                  className={`min-w-0 flex-1 rounded-xl border px-3 py-2 text-left text-sm disabled:opacity-60 ${index === activeBottle ? "border-ok bg-surface" : "border-line"}`}
                >
                  <span className="font-medium">{containerLabel(bottle.container)}</span>
                  <span className="text-zinc-500"> for {bottle.tests.map((t) => t.label).join(", ")}</span>
                  {issued ? <span className="text-ok"> · issued</span> : null}
                  {out ? <span className="text-warn"> · none in stock here</span> : null}
                </button>
                {out ? (
                  <button
                    type="button"
                    onClick={() => removeBottle(bottle.container)}
                    className={`${ghostButtonClass} py-1`}
                    aria-label={`Remove the ${containerLabel(bottle.container)} bottle`}
                  >
                    Remove
                  </button>
                ) : null}
              </div>
            );
          })}
          {isInvestigation && plan.length > 1 ? (
            <div className="flex flex-col gap-1">
              <div>
                <button
                  type="button"
                  disabled={checking || outOfStock.length > 0}
                  onClick={(event) => onIssueAll(event.currentTarget.form)}
                  className={`${ghostButtonClass} py-1 disabled:opacity-60`}
                >
                  {checking ? "Checking stock..." : `Issue all ${plan.length} bottles from stock`}
                </button>
              </div>
              {outOfStock.length > 0 ? (
                <p className="text-xs text-warn">
                  No {outOfStock.map((p) => containerLabel(p.container)).join(" or ")} bottle is in stock here. Remove{" "}
                  {outOfStock.length === 1 ? "it" : "them"} from the list to issue the rest, or scan{" "}
                  {outOfStock.length === 1 ? "it" : "them"} instead.
                </p>
              ) : (
                <p className="text-xs text-zinc-500">
                  Takes every bottle that is left from stock here, earliest expiry first, and issues each to the same
                  investigation. The items below go with the selected bottle; each of the others gets its test&apos;s
                  standard items.
                </p>
              )}
            </div>
          ) : null}
          <p className="text-xs text-zinc-500">
            {activeTest
              ? `Test set to ${activeTest.catalogCode} for the selected bottle, with its items below. Scan that bottle above, then issue. This pop-up then moves on to the next bottle.`
              : "None of the selected bottle's tests are in the Test catalog, so no items were filled. Add any used below."}
          </p>
        </div>
      ) : null}
      {/* Where the person is working (the app bar). Sent so the server refuses a form left open across a switch. */}
      <input type="hidden" name="locationId" value={workLocationId} />
      <input type="hidden" name="referenceType" value={referenceType} />
      {/* What the pop-up needs back after a save, to move on to the next bottle of the same request. */}
      <input type="hidden" name="requestText" value={pasted} />
      <input type="hidden" name="doneContainers" value={JSON.stringify(doneNow)} />
      <input type="hidden" name="removedContainers" value={JSON.stringify(removed)} />
      <input type="hidden" name="bottleContainer" value={bottles[activeBottle]?.container ?? ""} />
      {issueAll ? (
        <>
          <input type="hidden" name="issueAll" value="1" />
          <input type="hidden" name="bottlePlan" value={JSON.stringify(plan)} />
        </>
      ) : null}
      {fromStock ? <input type="hidden" name="stockContainer" value={bottles[activeBottle]?.container ?? ""} /> : null}
      {isInvestigation ? <input type="hidden" name="testCode" value={filledFor} /> : null}
      <div className="grid gap-3 sm:grid-cols-2">
        <input type="hidden" name="patientHospitalNo" value={patientNo} />
        <Field label="Patient type" tip="How the patient was seen. Leave as Not stated if you are not sure.">
          <Select
            name="patientType"
            ariaLabel="Patient type"
            defaultValue={resume.patientType}
            emptyLabel="Not stated"
            options={PATIENT_TYPES.map((t) => ({ value: t, label: label(t) }))}
          />
        </Field>
      </div>
      {isInvestigation ? (
        <input type="hidden" name="references" value={references} />
      ) : (
        <Field label="References" tip="The reference number, one per line.">
          <textarea
            name="references"
            required
            rows={3}
            value={references}
            onChange={(e) => onReferences(e.target.value)}
            className={`${inputClass} font-mono`}
          />
        </Field>
      )}
      {isInvestigation ? (
        <ItemsIssued tests={tests} bulkItems={bulkItems} testCode={testCode} lines={lines} setLines={setLines} />
      ) : null}
      <CollectorFields initialType={resume.collectorType} initialName={resume.collectorName} />
      <OverrideFields canOverride={canOverride} />
    </>
  );
}

function CollectorFields({ initialType, initialName }: { initialType: string; initialName: string }) {
  // A patient collecting their own sample needs no name (and none is stored); anyone else's name is required.
  const [type, setType] = useState<string>(initialType);
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <Field label="Collected by">
        <Select
          name="collectorType"
          ariaLabel="Collected by"
          required
          value={type}
          onChange={setType}
          options={COLLECTOR_TYPES.map((c) => ({ value: c, label: label(c) }))}
        />
      </Field>
      {type !== "PATIENT" ? (
        <Field label="Collector's name">
          <input name="collectorName" required maxLength={120} autoComplete="off" defaultValue={initialName} className={inputClass} />
        </Field>
      ) : null}
    </div>
  );
}

function OverrideFields({ canOverride }: { canOverride: boolean }) {
  if (!canOverride) return null;
  return (
    <details className="rounded-xl border border-line bg-surface p-3 text-sm">
      <summary className="cursor-pointer font-medium">Supervisor override</summary>
      <p className="mt-2 text-zinc-500">
        Only use this to issue past a container mismatch or an unpaid reference. The reason is recorded and shown in
        the reports.
      </p>
      <label className="mt-2 flex items-center gap-2">
        <input type="checkbox" name="useOverride" /> Override the block
      </label>
      <Field label="Reason for the override">
        <input name="overrideReason" maxLength={500} className={inputClass} />
      </Field>
    </details>
  );
}

/**
 * One button opens the issue pop-up: scan the bottle, say which investigations it is for, confirm the items that
 * go with it and save, all at once. When an issue is saved the pop-up closes and the result is shown on the page.
 */
export function IssueForms({ header, workLocationId, workServiceRole, canOverride, tests, bulkItems }: Props) {
  const [open, setOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  // The bottles issued in this go, kept so their labels can be opened again from the confirmation.
  const [labelSerials, setLabelSerials] = useState<string[]>([]);
  // The labels shown in a pop-up to print, right after an issue from stock, and which one is on screen.
  const [labelPreview, setLabelPreview] = useState<string[] | null>(null);
  const [labelIndex, setLabelIndex] = useState(0);
  const labelFrame = useRef<HTMLIFrameElement>(null);
  // The error from the last attempt, shown as a toast over the pop-up (which stays open with everything typed).
  const [errorToast, setErrorToast] = useState<{ id: number; message: string } | null>(null);
  // A bottle was issued and the request has more: the same toast style in green, over the pop-up that stayed open.
  const [okToast, setOkToast] = useState<{ id: number; message: string } | null>(null);
  // Take the bottle from stock instead of scanning one, as the browser extension can.
  const [fromStock, setFromStock] = useState(false);
  // With fromStock: take every bottle the request needs, not just the selected one.
  const [issueAll, setIssueAll] = useState(false);
  // After a bottle is issued and the request has more, the pop-up stays open on the same request. Null for a fresh
  // pop-up. `formKey` starts the form over (empty scan box, next bottle).
  const [carry, setCarry] = useState<Resume | null>(null);
  const [formKey, setFormKey] = useState(0);
  // Everything issued from the current request, across the bottles the pop-up moved on through (the form is started
  // over after each one, so the totals live here).
  const [issuedRun, setIssuedRun] = useState<IssuedRun>(NO_RUN);

  /** "Issue all": switch to stock mode for every bottle (so no scanned bottle is asked for) and submit at once. */
  function issueAllFromStock(form: HTMLFormElement | null) {
    flushSync(() => {
      setFromStock(true);
      setIssueAll(true);
    });
    form?.requestSubmit();
  }

  // A saved issue leaves its confirmation on the page. When the request still has bottles left, the pop-up stays open
  // on the next one (what was issued shows as a toast over it); otherwise it closes. A rejected one keeps the pop-up
  // open, with everything typed, and shows the error as a toast floating over it (the page's own toasts sit under an
  // open pop-up). An "issue all" that stopped part-way keeps what it issued and carries on with the rest. All make a
  // sound.
  function closingOnSuccess(action: (prev: FormState, formData: FormData) => Promise<FormState>) {
    return async (prev: FormState, formData: FormData): Promise<FormState> => {
      let result: FormState;
      try {
        result = await action(prev, formData);
      } finally {
        // Back to scanning once the attempt is over, so "Issue from stock" is there again if it failed.
        setFromStock(false);
        setIssueAll(false);
      }
      const issued = result.serials ?? (result.serial && !result.error ? [result.serial] : []);
      if (result.error && issued.length === 0) {
        playScanTone("error");
        setErrorToast({ id: Date.now(), message: result.error });
        // The toast carries the message, so the form itself shows no second copy.
        return { ...result, error: undefined };
      }
      if (issued.length === 0) return result;

      playScanTone(result.error ? "error" : "ok");
      const run: IssuedRun = {
        serials: [...issuedRun.serials, ...issued],
        messages: result.message ? [...issuedRun.messages, result.message] : issuedRun.messages,
        fromStock: issuedRun.fromStock || formData.get("fromStock") === "1",
      };
      setIssuedRun(run);
      setNotice(run.messages.join(" "));
      setLabelSerials(run.serials);

      // Which bottles of the pasted request are still to issue.
      const text = String(formData.get("requestText") ?? "");
      const single = String(formData.get("bottleContainer") ?? "");
      const done = [...parseDone(formData.get("doneContainers")), ...(result.containers ?? (single ? [single] : []))];
      const removed = parseDone(formData.get("removedContainers"));
      const left =
        text && formData.get("referenceType") === "INVESTIGATION"
          ? remainingBottles(parseRequest(text, tests).bottles, [...done, ...removed])
          : [];
      if (left.length > 0) {
        setCarry({
          pasted: text,
          done,
          removed,
          patientType: String(formData.get("patientType") ?? ""),
          collectorType: String(formData.get("collectorType") ?? "PATIENT"),
          collectorName: String(formData.get("collectorName") ?? ""),
        });
        setFormKey((k) => k + 1);
        if (result.error) {
          setOkToast(null);
          setErrorToast({ id: Date.now(), message: result.error });
        } else {
          setErrorToast(null);
          setOkToast({ id: Date.now(), message: result.message ?? "Issued." });
        }
        // The pop-up starts the form over, so this form shows no copy of the message.
        return { ...result, error: undefined, message: undefined };
      }
      setErrorToast(null);
      setOkToast(null);
      setCarry(null);
      setOpen(false);
      // From stock there was no bottle in hand to scan first, so the labels come up straight away to print.
      if (run.fromStock) {
        setLabelIndex(0);
        setLabelPreview(run.serials);
      }
      return result;
    };
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1 basis-80">{header}</div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => {
              setNotice(null);
              setLabelSerials([]);
              setErrorToast(null);
              setOkToast(null);
              setCarry(null);
              setFormKey((k) => k + 1);
              setIssuedRun(NO_RUN);
              setOpen(true);
            }}
            className={buttonClass}
          >
            Issue
          </button>
        </div>
      </div>

      {notice ? (
        <p role="status" className="rounded-xl border border-ok bg-surface px-4 py-3 text-sm text-ok">
          {notice}
          {labelSerials.map((serial, index) => (
            <span key={serial}>
              {" "}
              <a
                href={`/api/issues/${encodeURIComponent(serial)}/label`}
                target="_blank"
                rel="noreferrer"
                className="underline"
              >
                {labelSerials.length > 1 ? `Open label ${index + 1}` : "Open label"}
              </a>
            </span>
          ))}
        </p>
      ) : null}

      {open ? (
        <Modal
          title="Issue a bottle"
          onClose={() => {
            setOpen(false);
            setCarry(null);
          }}
        >
          <p className="mb-3 text-sm text-zinc-500">
            Scan the bottle, or issue one from stock, then paste the request with the patient&apos;s hospital number, the
            investigation number and the tests. The bottles those tests need come up, with the items each one uses, to
            confirm. Each bottle is linked to the investigation, and its items leave the shelf with it. With more than one
            bottle, issue them one at a time (this pop-up moves on to the next), or take them all from stock in one go.
          </p>
          {/* The Issue button is placed by <SubmitSlot />, in the same row as the scan and stock buttons. */}
          <ActionForm
            key={formKey}
            action={closingOnSuccess(issueUnitAction)}
            submitLabel="Issue"
            submitSlot
            busyText={
              issueAll ? "Issuing the bottles from stock..." : fromStock ? "Issuing a bottle from stock..." : "Issuing the bottle..."
            }
          >
            {fromStock ? (
              <div className="flex flex-col gap-2">
                <input type="hidden" name="fromStock" value="1" />
                <p className="text-sm font-medium">Bottle</p>
                <p className="text-sm text-zinc-500">
                  {issueAll
                    ? "Every bottle the request still needs is taken from stock here, earliest expiry first."
                    : "A bottle that fits the selected bottle's tests is taken from stock here, earliest expiry first."}
                </p>
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setFromStock(false);
                      setIssueAll(false);
                    }}
                    className={`${ghostButtonClass} py-1`}
                  >
                    Scan a bottle instead
                  </button>
                  <SubmitSlot />
                </div>
              </div>
            ) : (
              <ScanField
                name="serial"
                label="Scan the bottle"
                autoFocus
                actions={
                  <>
                    <button
                      type="button"
                      onClick={(event) => {
                        // One click issues: switch to stock mode (so no scanned bottle is asked for) and submit at once.
                        // The form still checks that the request was pasted and a bottle chosen.
                        const form = event.currentTarget.form;
                        flushSync(() => setFromStock(true));
                        form?.requestSubmit();
                      }}
                      className={`${ghostButtonClass} py-1`}
                    >
                      Issue from stock
                    </button>
                    <SubmitSlot />
                  </>
                }
              />
            )}
            <IssueFields
              fromStock={fromStock}
              issueAll={issueAll}
              onIssueAll={issueAllFromStock}
              resume={carry ?? FRESH}
              tests={tests}
              bulkItems={bulkItems}
              workLocationId={workLocationId}
              workServiceRole={workServiceRole}
              canOverride={canOverride}
            />
          </ActionForm>
          {errorToast ? (
            <DialogToast key={errorToast.id} message={errorToast.message} onDismiss={() => setErrorToast(null)} />
          ) : null}
          {okToast ? (
            <DialogToast key={okToast.id} tone="ok" message={okToast.message} onDismiss={() => setOkToast(null)} />
          ) : null}
        </Modal>
      ) : null}

      {labelPreview ? (
        <Modal title={labelPreview.length > 1 ? "Issue labels" : "Issue label"} onClose={() => setLabelPreview(null)}>
          {labelPreview.length > 1 ? (
            <div className="mb-3 flex flex-wrap gap-2">
              {labelPreview.map((serial, index) => (
                <button
                  key={serial}
                  type="button"
                  aria-pressed={index === labelIndex}
                  onClick={() => setLabelIndex(index)}
                  className={`rounded-xl border px-3 py-1 text-sm ${index === labelIndex ? "border-ok bg-surface" : "border-line"}`}
                >
                  Label {index + 1} <span className="font-mono text-zinc-500">{serial}</span>
                </button>
              ))}
            </div>
          ) : null}
          <iframe
            key={labelPreview[labelIndex]}
            ref={labelFrame}
            src={`/api/issues/${encodeURIComponent(labelPreview[labelIndex] ?? "")}/label`}
            title="Issue label"
            className="h-[60dvh] w-full rounded-lg border border-line"
          />
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button type="button" onClick={() => labelFrame.current?.contentWindow?.print()} className={buttonClass}>
              {labelPreview.length > 1 ? `Print label ${labelIndex + 1}` : "Print"}
            </button>
            <a
              href={`/api/issues/${encodeURIComponent(labelPreview[labelIndex] ?? "")}/label`}
              target="_blank"
              rel="noreferrer"
              className={`${ghostButtonClass} inline-block py-2 text-center`}
            >
              Open in new tab
            </a>
            <button type="button" onClick={() => setLabelPreview(null)} className={`${ghostButtonClass} py-2`}>
              Done
            </button>
          </div>
        </Modal>
      ) : null}
    </div>
  );
}
