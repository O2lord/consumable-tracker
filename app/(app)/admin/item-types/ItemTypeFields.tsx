"use client";

import { useState } from "react";
import {
  CONTAINER_TYPE_SUGGESTIONS,
  ITEM_CATEGORY_SUGGESTIONS,
  PACK_SIZE_MAX,
  SERVICE_ROLES,
  TRACKING_MODES,
} from "@/server/domain/types";
import { Field } from "@/components/ui/Field";
import { Combobox, Select } from "@/components/ui/Dropdown";
import { inputClass } from "@/components/ui/styles";

/** What the form needs from an existing item type. Plain values only, so it can cross from the server page. */
export interface ItemTypeFormRow {
  id: string;
  code: string;
  name: string;
  labelCode: string | null;
  category: string;
  trackingMode: (typeof TRACKING_MODES)[number];
  containerType: string | null;
  unitOfMeasure: string;
  reorderLevel: number;
  packSize: number;
  packSizeConfirmed: boolean;
  packsPerCarton: number | null;
  testsPerUnit: number | null;
  coldStorage: boolean;
  benchSupply: boolean;
  allowedServiceRoles: string[] | null;
}

const isReagent = (category: string) => category.trim().toUpperCase() === "REAGENT";

/**
 * The add and edit fields for an item type. The fields that apply depend on the category: a reagent is a quantity
 * item counted in tests (how many tests one container covers), so it has no bottle label, container type, tracking
 * mode or separate pack size to fill in. Every other category keeps the full form.
 */
export function ItemTypeFields({ row }: { row?: ItemTypeFormRow }) {
  const [category, setCategory] = useState(row?.category ?? "SAMPLE_CONTAINER");
  const reagent = isReagent(category);

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <Field label="Code" hint={row ? "Permanent, cannot be changed" : "Short and permanent, for example EDTA-5ML"}>
        {row ? (
          <input value={row.code} disabled readOnly className={`${inputClass} opacity-70`} />
        ) : (
          <input name="code" required className={inputClass} autoCapitalize="characters" />
        )}
      </Field>
      <Field label="Name">
        <input name="name" required defaultValue={row?.name} className={inputClass} />
      </Field>
      <Field label="Category">
        <Combobox
          name="category"
          required
          suggestions={ITEM_CATEGORY_SUGGESTIONS}
          defaultValue={row?.category ?? "SAMPLE_CONTAINER"}
          onValueChange={setCategory}
        />
      </Field>

      {reagent ? (
        <>
          {/* A reagent is always a quantity item. Kept as hidden values so the rest of the app is unchanged. */}
          <input type="hidden" name="trackingMode" value="QUANTITY" />
          <input type="hidden" name="packSize" value={row?.packSize ?? 1} />
          {row?.benchSupply ? <input type="hidden" name="benchSupply" value="on" /> : null}

          <Field label="Unit of measure" hint="What one container is, for example litre, bottle or vial.">
            <input name="unitOfMeasure" defaultValue={row?.unitOfMeasure ?? "each"} className={inputClass} />
          </Field>
          <Field
            label="Tests per container"
            hint="How many tests one container covers, for example 100 for a container that does 100 tests. The lab records tests done under Used for test, and a container left part-used carries its remaining tests forward. It cannot be changed once tests have been recorded."
          >
            <input
              name="testsPerUnit"
              type="number"
              min={1}
              max={PACK_SIZE_MAX}
              step={1}
              defaultValue={row?.testsPerUnit ?? ""}
              className={inputClass}
            />
          </Field>
          <Field label="Reorder level" hint="In containers.">
            <input
              name="reorderLevel"
              type="number"
              min={0}
              step={1}
              defaultValue={row?.reorderLevel ?? 0}
              className={inputClass}
            />
          </Field>
          <Field
            label="Containers per carton (optional)"
            hint="Containers in one carton as delivered. Leave empty if it does not come in cartons."
          >
            <input
              name="packsPerCarton"
              type="number"
              min={1}
              max={PACK_SIZE_MAX}
              step={1}
              defaultValue={row?.packsPerCarton ?? ""}
              className={inputClass}
            />
          </Field>
          <label className="flex items-center gap-2 text-sm sm:col-span-2">
            <input type="checkbox" name="packSizeConfirmed" defaultChecked={row?.packSizeConfirmed ?? false} />
            Tests per container confirmed with the lab
          </label>
        </>
      ) : (
        <>
          <Field
            label="Label code (bottles)"
            hint="Two letters that start every bottle's serial, so its label says what it is: PT for a plain tube, ED for an EDTA tube. Leave blank to choose one from the name. Not I, L, O or U, and not CT, BT, DV, PK or CN. Serial items only. It can be changed until bottles carry it."
          >
            <input
              name="labelCode"
              maxLength={2}
              defaultValue={row?.labelCode ?? ""}
              placeholder="PT"
              className={`${inputClass} font-mono uppercase`}
              autoCapitalize="characters"
              autoComplete="off"
            />
          </Field>
          <Field label="Tracking mode" hint="Cannot be changed once stock of this type exists">
            <Select name="trackingMode" required options={TRACKING_MODES} defaultValue={row?.trackingMode ?? "SERIAL"} />
          </Field>
          <Field label="Container type (sample containers)" hint="Matched against what each test requires">
            <Combobox name="containerType" suggestions={CONTAINER_TYPE_SUGGESTIONS} defaultValue={row?.containerType ?? ""} />
          </Field>
          <Field label="Unit of measure">
            <input name="unitOfMeasure" defaultValue={row?.unitOfMeasure ?? "each"} className={inputClass} />
          </Field>
          <Field label="Reorder level">
            <input
              name="reorderLevel"
              type="number"
              min={0}
              step={1}
              defaultValue={row?.reorderLevel ?? 0}
              className={inputClass}
            />
          </Field>
          <Field
            label="Pack size"
            hint="Pieces in one pack. Used to show equivalents and to open a pack when pieces are sent. It cannot be changed once any pieces of this item have been opened or sent."
          >
            <input
              name="packSize"
              type="number"
              min={1}
              max={PACK_SIZE_MAX}
              step={1}
              defaultValue={row?.packSize ?? 1}
              className={inputClass}
            />
          </Field>
          <Field
            label="Packs per carton (optional)"
            hint="Packs, bags, rolls or bottles in one carton as delivered. Leave empty if it does not come in cartons. Lets a delivery be counted in cartons."
          >
            <input
              name="packsPerCarton"
              type="number"
              min={1}
              max={PACK_SIZE_MAX}
              step={1}
              defaultValue={row?.packsPerCarton ?? ""}
              className={inputClass}
            />
          </Field>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="packSizeConfirmed" defaultChecked={row?.packSizeConfirmed ?? false} />
            Confirmed with the lab
          </label>
        </>
      )}

      <label className="flex items-center gap-2 text-sm sm:col-span-2">
        <input type="checkbox" name="coldStorage" defaultChecked={row?.coldStorage ?? false} />
        Needs cold storage (shows a &quot;Keep cold&quot; tag on stock, transfer and receive screens)
      </label>
      {reagent ? null : (
        <label className="flex items-start gap-2 text-sm sm:col-span-2">
          <input type="checkbox" name="benchSupply" defaultChecked={row?.benchSupply ?? false} className="mt-1" />
          <span>
            Bench supply (shared by many patients, like cotton wool or gloves). Send it to the lab with a transfer, then
            the lab records what it used under Used for test and counts it in stock counts. It is not listed against a
            test or a patient, and ticking this removes it from any test list it is on.
          </span>
        </label>
      )}
      <fieldset className="sm:col-span-2">
        <legend className="mb-1 text-sm font-medium">Can be sent to</legend>
        <p className="mb-2 text-xs text-zinc-500">Tick the kinds of location this item may go to. Tick none for anywhere.</p>
        <div className="flex flex-wrap gap-x-5 gap-y-2">
          {SERVICE_ROLES.map((role) => (
            <label key={role} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                name="allowedServiceRoles"
                value={role}
                defaultChecked={row?.allowedServiceRoles?.includes(role) ?? false}
              />
              {role}
            </label>
          ))}
        </div>
      </fieldset>
    </div>
  );
}
