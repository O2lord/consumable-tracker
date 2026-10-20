"use client";

import { useState, type ReactNode } from "react";
import { ActionForm } from "@/components/forms/ActionForm";
import type { FormState } from "@/components/forms/form-state";
import { ScanField } from "@/components/scanner/ScanField";
import { Field } from "@/components/ui/Field";
import { Select } from "@/components/ui/Dropdown";
import { Modal } from "@/components/ui/Modal";
import { buttonClass, ghostButtonClass, inputClass } from "@/components/ui/styles";
import { departmentOnly, referenceAllowedAt } from "@/lib/issue-location";
import { COLLECTOR_TYPES, PATIENT_TYPES, REFERENCE_TYPES } from "@/server/domain/types";
import { issueUnitAction } from "./actions";

interface Place {
  id: string;
  name: string;
  /** What the place does for stock. A bench or the blood bank issues for its department only. */
  serviceRole: string | null;
}

/** A test and the per-patient items one run of it normally uses (empty when the lab has not listed any yet). */
export interface TestOption {
  code: string;
  name: string;
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
  /** Supervisors choose where they are working; everyone else works at their own location. */
  locations?: Place[];
  defaultLocationId?: string;
  /** The service role of the person's own location, used when they cannot choose one. */
  homeServiceRole?: string | null;
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

/** The test code after the first investigation number ("IXS181 LFT" gives "LFT"). Empty when there is none. */
function firstTestCode(references: string): string {
  const firstLine = references.split(/[\n;,]+/).find((s) => s.trim() !== "") ?? "";
  return (firstLine.trim().split(/\s+/)[1] ?? "").toUpperCase();
}

/**
 * Where stock is being issued from, and what that place does. Supervisors choose the place, so the choices
 * under "Issued for" follow their pick; everyone else works at their own location.
 */
function useWorkingPlace(
  locations: Place[] | undefined,
  defaultLocationId: string | undefined,
  homeServiceRole: string | null | undefined,
) {
  const [locationId, setLocationId] = useState(defaultLocationId ?? locations?.[0]?.id ?? "");
  const serviceRole = locations ? (locations.find((l) => l.id === locationId)?.serviceRole ?? null) : (homeServiceRole ?? null);
  return { locationId, setLocationId, serviceRole };
}

function LocationField({
  locations,
  value,
  onChange,
}: {
  locations?: Place[];
  value: string;
  onChange: (id: string) => void;
}) {
  if (!locations) return null;
  return (
    <Field label="Working at">
      <Select
        name="locationId"
        ariaLabel="Working at"
        required
        value={value}
        onChange={onChange}
        options={locations.map((l) => ({ value: l.id, label: l.name }))}
      />
    </Field>
  );
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
  locations,
  defaultLocationId,
  homeServiceRole,
  canOverride,
}: Pick<Props, "tests" | "bulkItems" | "locations" | "defaultLocationId" | "homeServiceRole" | "canOverride">) {
  const place = useWorkingPlace(locations, defaultLocationId, homeServiceRole);
  const [chosenType, setChosenType] = useState<string>("INVESTIGATION");
  const [references, setReferences] = useState("");
  const [lines, setLines] = useState<Line[]>([]);
  const [filledFor, setFilledFor] = useState("");

  // At a bench section or the blood bank only Department is offered, because those places use stock for the
  // department and not per patient (corrections C2); everywhere else every type is.
  const typeOptions = REFERENCE_TYPES.filter((t) => referenceAllowedAt(place.serviceRole, t));
  const referenceType = typeOptions.includes(chosenType as never) ? chosenType : (typeOptions[0] ?? "DEPARTMENT");
  const testCode = referenceType === "INVESTIGATION" ? filledFor : "";

  /** Chooses the test and fills the items list with its standard items. Edits made afterwards stay until the test changes. */
  function pickTest(code: string) {
    if (code === filledFor) return;
    setFilledFor(code);
    const chosen = tests.find((t) => t.code === code);
    setLines((chosen?.items ?? []).map((i) => ({ itemTypeId: i.itemTypeId, quantity: String(i.quantity) })));
  }

  function onReferences(text: string) {
    setReferences(text);
    // A test code typed after the first investigation number picks that test too.
    const typed = firstTestCode(text);
    if (referenceType === "INVESTIGATION" && typed && tests.some((t) => t.code === typed)) pickTest(typed);
  }

  const isInvestigation = referenceType === "INVESTIGATION";

  return (
    <>
      <LocationField locations={locations} value={place.locationId} onChange={place.setLocationId} />
      <div className="grid gap-3 sm:grid-cols-2">
        <Field
          label="Issued for"
          tip={
            departmentOnly(place.serviceRole)
              ? "What the bottle is for. This place uses stock for its department, not per patient."
              : "What the bottle is for. Choose Investigation for a patient's test."
          }
        >
          <Select
            name="referenceType"
            ariaLabel="Issued for"
            value={referenceType}
            onChange={setChosenType}
            options={typeOptions.map((t) => ({ value: t, label: label(t) }))}
          />
        </Field>
        {isInvestigation ? (
          <Field label="Test" tip="Choosing the test fills in the items it uses. It applies to every investigation listed.">
            <Select
              name="testCode"
              ariaLabel="Test"
              value={filledFor}
              onChange={pickTest}
              emptyLabel="Choose a test"
              options={tests.map((t) => ({ value: t.code, label: `${t.code} - ${t.name}` }))}
            />
          </Field>
        ) : null}
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Patient hospital number" tip="For example UATH/PT/123456. Not needed for a department.">
          <input name="patientHospitalNo" autoComplete="off" autoCapitalize="characters" className={`${inputClass} font-mono`} />
        </Field>
        <Field label="Patient type" tip="How the patient was seen. Leave as Not stated if you are not sure.">
          <Select
            name="patientType"
            ariaLabel="Patient type"
            defaultValue=""
            emptyLabel="Not stated"
            options={PATIENT_TYPES.map((t) => ({ value: t, label: label(t) }))}
          />
        </Field>
      </div>
      <Field
        label={isInvestigation ? "Investigation" : "References"}
        tip={
          isInvestigation
            ? "The investigation number, one per line. A test code after the number is optional if you chose the test above."
            : "The reference number, one per line."
        }
      >
        <textarea
          name="references"
          required
          rows={3}
          value={references}
          onChange={(e) => onReferences(e.target.value)}
          className={`${inputClass} font-mono`}
        />
      </Field>
      {isInvestigation ? (
        <ItemsIssued tests={tests} bulkItems={bulkItems} testCode={testCode} lines={lines} setLines={setLines} />
      ) : null}
      <CollectorFields />
      <OverrideFields canOverride={canOverride} />
    </>
  );
}

function CollectorFields() {
  // A patient collecting their own sample needs no name (and none is stored); anyone else's name is required.
  const [type, setType] = useState<string>("PATIENT");
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
          <input name="collectorName" required maxLength={120} autoComplete="off" className={inputClass} />
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
export function IssueForms({
  header,
  locations,
  defaultLocationId,
  homeServiceRole,
  canOverride,
  tests,
  bulkItems,
}: Props) {
  const [open, setOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  // A saved issue closes the pop-up and leaves its confirmation on the page. A rejected one keeps the
  // pop-up open with the error and everything typed.
  function closingOnSuccess(action: (prev: FormState, formData: FormData) => Promise<FormState>) {
    return async (prev: FormState, formData: FormData): Promise<FormState> => {
      const result = await action(prev, formData);
      if (!result.error && result.message) {
        setNotice(result.message);
        setOpen(false);
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
        </p>
      ) : null}

      {open ? (
        <Modal title="Issue a bottle" onClose={() => setOpen(false)}>
          <p className="mb-3 text-sm text-zinc-500">
            Choose the test and the items it uses come up to confirm, then scan the bottle and list the investigation
            numbers it is for, one per line. One scan links the bottle to all of them, and the items leave the shelf
            with it.
          </p>
          <ActionForm action={closingOnSuccess(issueUnitAction)} submitLabel="Issue">
            <ScanField name="serial" label="Scan the bottle" autoFocus />
            <IssueFields
              tests={tests}
              bulkItems={bulkItems}
              locations={locations}
              defaultLocationId={defaultLocationId}
              homeServiceRole={homeServiceRole}
              canOverride={canOverride}
            />
          </ActionForm>
        </Modal>
      ) : null}
    </div>
  );
}
