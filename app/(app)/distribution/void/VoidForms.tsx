"use client";

import type { ReactNode } from "react";
import { ActionForm } from "@/components/forms/ActionForm";
import { FormDialogGroup } from "@/components/forms/FormDialog";
import { ScanField } from "@/components/scanner/ScanField";
import { Field } from "@/components/ui/Field";
import { Select } from "@/components/ui/Dropdown";
import { inputClass } from "@/components/ui/styles";
import { voidQuantityAction, voidUnitAction } from "./actions";

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
        required
        defaultValue={defaultLocationId}
        options={locations.map((l) => ({ value: l.id, label: l.name }))}
      />
    </Field>
  );
}

function ReasonField({ reasons }: { reasons: Props["reasons"] }) {
  return (
    <Field label="Reason">
      <Select
        name="reasonCode"
        required
        placeholder="Choose a reason"
        options={reasons.map((r) => ({ value: r.code, label: r.label }))}
      />
    </Field>
  );
}

export function VoidForms({ header, reasons, locations, defaultLocationId }: Props) {
  return (
    <FormDialogGroup
      header={header}
      dialogs={[
        {
          buttonLabel: "Void bottle",
          title: "Void a bottle",
          content: (
            <ActionForm action={voidUnitAction} submitLabel="Void bottle" danger confirm="Void this bottle? This cannot be undone.">
              <LocationField locations={locations} defaultLocationId={defaultLocationId} />
              <ScanField name="serial" label="Scan the bottle" autoFocus />
              <ReasonField reasons={reasons} />
              <Field label="Note (optional)">
                <input name="note" maxLength={500} className={inputClass} />
              </Field>
            </ActionForm>
          ),
        },
        {
          buttonLabel: "Write off bulk",
          title: "Write off bulk items",
          content: (
            <ActionForm action={voidQuantityAction} submitLabel="Write off" danger confirm="Write off this quantity? This cannot be undone.">
              <LocationField locations={locations} defaultLocationId={defaultLocationId} />
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Batch code (from the box label)">
                  <input name="batch" required autoFocus autoComplete="off" className={`${inputClass} font-mono`} />
                </Field>
                <Field label="Quantity">
                  <input name="quantity" type="number" min={1} step={1} required inputMode="numeric" className={inputClass} />
                </Field>
              </div>
              <ReasonField reasons={reasons} />
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
