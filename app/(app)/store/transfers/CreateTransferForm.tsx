"use client";

import type { ReactNode } from "react";
import { ActionForm } from "@/components/forms/ActionForm";
import { FormDialog } from "@/components/forms/FormDialog";
import { Field } from "@/components/ui/Field";
import { Select } from "@/components/ui/Dropdown";
import { inputClass } from "@/components/ui/styles";
import { createTransferAction } from "./actions";

export interface LocationOption {
  id: string;
  name: string;
}

/** A button at the top right opens the new-transfer form in a pop-up; starting one opens its draft. */
export function CreateTransferForm({
  header,
  stores,
  destinations,
  defaultStoreId,
}: {
  header: ReactNode;
  stores: LocationOption[];
  destinations: LocationOption[];
  defaultStoreId?: string;
}) {
  return (
    <FormDialog buttonLabel="Start transfer" title="Start a transfer" header={header}>
      <ActionForm action={createTransferAction} submitLabel="Start transfer" resetOnSuccess={false}>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Send from" required>
          <Select
            name="fromLocationId"
            required
            ariaLabel="Send from"
            defaultValue={defaultStoreId ?? stores[0]?.id ?? ""}
            options={stores.map((s) => ({ value: s.id, label: s.name }))}
          />
        </Field>
        <Field label="Send to" required>
          <Select
            name="toLocationId"
            required
            ariaLabel="Send to"
            placeholder="Choose a destination"
            defaultValue=""
            options={destinations.map((d) => ({ value: d.id, label: d.name }))}
          />
        </Field>
        </div>
        <Field label="Note (optional)">
          <input name="note" className={inputClass} maxLength={500} />
        </Field>
      </ActionForm>
    </FormDialog>
  );
}
