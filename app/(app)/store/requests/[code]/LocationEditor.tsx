"use client";

import { ActionForm } from "@/components/forms/ActionForm";
import { RowFormDialog } from "@/components/forms/FormDialog";
import { Field } from "@/components/ui/Field";
import { Select } from "@/components/ui/Dropdown";
import { changeDraftLocationsAction } from "../actions";

interface LocationOption {
  id: string;
  name: string;
}

interface Props {
  requestId: string;
  code: string;
  requestingName: string;
  storeName: string;
  requestingLocationId: string;
  storeLocationId: string;
  /** The stores the draft can be moved to. */
  stores: LocationOption[];
  /** Supervisors and admins can also change which location is asking. Left out for lab staff. */
  requestingOptions?: LocationOption[];
}

/**
 * "Fast Track Lab asked Main Store" with a pen at the end. The pen opens a pop-up with the location dropdowns,
 * so a draft can be moved to another store (for example when the first one has no stock). A saved change
 * closes the pop-up and the page shows the new store.
 */
export function LocationEditor({
  requestId,
  code,
  requestingName,
  storeName,
  requestingLocationId,
  storeLocationId,
  stores,
  requestingOptions,
}: Props) {
  return (
    <p className="flex items-center gap-2">
      <span>
        {requestingName} asked {storeName}.
      </span>
      <RowFormDialog buttonLabel="Change location" title="Change location">
        <ActionForm
          action={changeDraftLocationsAction}
          submitLabel="Save"
          resetOnSuccess={false}
          className="flex flex-col gap-4 text-ink"
        >
          <input type="hidden" name="requestId" value={requestId} />
          <input type="hidden" name="code" value={code} />
          <p className="text-sm text-zinc-500">
            Move this draft to another store, for example when the first one has no stock. This can only be done
            before the request is sent.
          </p>
          {requestingOptions ? (
            <Field label="Requesting location">
              <Select
                name="requestingLocationId"
                required
                placeholder="Choose a location"
                defaultValue={requestingLocationId}
                options={requestingOptions.map((l) => ({ value: l.id, label: l.name }))}
              />
            </Field>
          ) : null}
          <Field label="Ask which store?">
            <Select
              name="storeLocationId"
              required
              placeholder="Choose a store"
              defaultValue={storeLocationId}
              options={stores.map((s) => ({ value: s.id, label: s.name }))}
            />
          </Field>
        </ActionForm>
      </RowFormDialog>
    </p>
  );
}
