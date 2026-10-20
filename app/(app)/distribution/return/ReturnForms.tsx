"use client";

import { useState, type ReactNode } from "react";
import { ActionForm } from "@/components/forms/ActionForm";
import { FormDialogGroup } from "@/components/forms/FormDialog";
import { Select } from "@/components/ui/Dropdown";
import { Field } from "@/components/ui/Field";
import { inputClass } from "@/components/ui/styles";
import { ScanField } from "@/components/scanner/ScanField";
import { returnUnitAction } from "./actions";

interface Props {
  /** The page title and intro, shown on the left with the two buttons on the right. */
  header: ReactNode;
  reasons: { code: string; label: string }[];
  locations?: { id: string; name: string }[];
  defaultLocationId?: string;
}

function LocationField({ locations, defaultLocationId }: Pick<Props, "locations" | "defaultLocationId">) {
  if (!locations) return null;
  return (
    <Field label="Working at">
      <Select
        name="locationId"
        ariaLabel="Working at"
        required
        defaultValue={defaultLocationId ?? locations[0]?.id}
        options={locations.map((l) => ({ value: l.id, label: l.name }))}
      />
    </Field>
  );
}

function ReasonField({ reasons, hint }: { reasons: Props["reasons"]; hint: string }) {
  return (
    <Field label="Reason" hint={hint}>
      <Select
        name="reasonCode"
        ariaLabel="Reason"
        required
        placeholder="Choose a reason"
        options={reasons.map((r) => ({ value: r.code, label: r.label }))}
      />
    </Field>
  );
}

/** The outcome picker. The reason only appears (and is required) when the outcome is the bad one. */
function OutcomeAndReason({
  options,
  defaultOutcome,
  reasonOutcome,
  reasons,
  hint,
}: {
  options: { value: string; label: string }[];
  defaultOutcome: string;
  reasonOutcome: string;
  reasons: Props["reasons"];
  hint: string;
}) {
  const [outcome, setOutcome] = useState(defaultOutcome);
  return (
    <>
      <Field label="What happened to it">
        <Select name="outcome" ariaLabel="What happened to it" required value={outcome} onChange={setOutcome} options={options} />
      </Field>
      {outcome === reasonOutcome ? <ReasonField reasons={reasons} hint={hint} /> : null}
    </>
  );
}

export function ReturnForms({ header, reasons, locations, defaultLocationId }: Props) {
  return (
    <FormDialogGroup
      header={header}
      dialogs={[
        {
          buttonLabel: "Return bottle",
          title: "Return a bottle",
          intro:
            "Scan the bottle, then say what happened to it. Used means a sample is inside; unused goes back in stock (where this location allows it); unusable is voided with a reason.",
          content: (
            <ActionForm action={returnUnitAction} submitLabel="Record return">
              <LocationField locations={locations} defaultLocationId={defaultLocationId} />
              <ScanField name="serial" label="Scan the bottle" autoFocus />
              <OutcomeAndReason
                options={[
                  { value: "USED", label: "Used (sample inside)" },
                  { value: "UNUSED", label: "Unused and intact" },
                  { value: "UNUSABLE", label: "Unusable (broken, contaminated, wrong tube...)" },
                ]}
                defaultOutcome="USED"
                reasonOutcome="UNUSABLE"
                reasons={reasons}
                hint="Why the bottle cannot be used."
              />
              <Field label="Note (optional)">
                <input name="note" maxLength={500} className={inputClass} />
              </Field>
            </ActionForm>
          ),
        },
      ]}
    />
  );
}
