import { requirePermission } from "@/server/auth/session";
import { listItemTypes } from "@/server/services/catalog.service";
import {
  CONTAINER_TYPE_SUGGESTIONS,
  ITEM_CATEGORY_SUGGESTIONS,
  PACK_SIZE_MAX,
  SERVICE_ROLES,
  TRACKING_MODES,
} from "@/server/domain/types";
import { ActionForm } from "@/components/forms/ActionForm";
import { FormDialog, RowFormDialog } from "@/components/forms/FormDialog";
import { Field } from "@/components/ui/Field";
import { Combobox, Select } from "@/components/ui/Dropdown";
import { Tag } from "@/components/ui/Tag";
import { inputClass, tableClass, tdClass, thClass } from "@/components/ui/styles";
import { createItemTypeAction, setItemTypeActiveAction, updateItemTypeAction } from "./actions";

export const metadata = { title: "Item types" };

type ItemTypeRow = Awaited<ReturnType<typeof listItemTypes>>[number];

export default async function ItemTypesPage() {
  await requirePermission("manage_item_types");
  const rows = await listItemTypes();
  const unconfirmedPackSizes = rows.filter((row) => row.active && !row.packSizeConfirmed && row.trackingMode === "QUANTITY").length;

  return (
    <div className="flex flex-col gap-6">
      <FormDialog
        buttonLabel="Add item type"
        title="Add an item type"
        header={
          <>
            <h1 className="text-[22px] font-bold tracking-tight">Item types</h1>
            <p className="mt-1 text-sm text-zinc-500">
              SERIAL items (sample bottles, specimen containers) get one barcode each and are scanned at every
              step. QUANTITY items (gloves, syringes) are tracked by batch and counted.
            </p>
          </>
        }
      >
        <ActionForm action={createItemTypeAction} submitLabel="Add item type">
          <ItemTypeFields />
        </ActionForm>
      </FormDialog>

      {unconfirmedPackSizes > 0 ? (
        <p className="rounded-xl border border-line bg-warn-soft px-4 py-2.5 text-sm text-warn">
          {unconfirmedPackSizes} {unconfirmedPackSizes === 1 ? "item has" : "items have"} an unconfirmed pack size. Check
          each with the lab, correct it, and tick Confirmed. Changing a pack size never changes a stock count.
        </p>
      ) : null}

      <section className="overflow-x-auto rounded-xl border border-line bg-surface px-2 py-1">
        <table className={tableClass}>
          <thead>
            <tr>
              <th className={thClass}>Item</th>
              <th className={thClass}>Type</th>
              <th className={thClass}>Unit</th>
              <th className={thClass}>Pack size</th>
              <th className={thClass}>Allowed at</th>
              <th className={thClass}>Reorder at</th>
              <th className={thClass}>Status</th>
              <th className={thClass}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <td className={tdClass}>
                  <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="font-medium">{row.name}</span>
                    {row.coldStorage ? <Tag tone="brand">Keep cold</Tag> : null}
                    {row.benchSupply ? <Tag tone="brand">Bench supply</Tag> : null}
                  </span>
                  <span className="block text-xs text-muted">{row.code}</span>
                </td>
                <td className={tdClass}>
                  {row.category}
                  <span className="block text-xs text-muted">
                    {row.trackingMode}
                    {row.containerType ? ` · ${row.containerType}` : ""}
                  </span>
                </td>
                <td className={tdClass}>{row.unitOfMeasure}</td>
                <td className={tdClass}>
                  {row.trackingMode === "QUANTITY" ? (
                    <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      {row.packSize}
                      {row.packSizeConfirmed ? null : <Tag tone="warn">Unconfirmed</Tag>}
                    </span>
                  ) : (
                    "-"
                  )}
                </td>
                <td className={tdClass}>{row.allowedServiceRoles?.join(", ") ?? "Any"}</td>
                <td className={tdClass}>{row.reorderLevel}</td>
                <td className={tdClass}>{row.active ? "Active" : "Inactive"}</td>
                <td className={tdClass}>
                  <div className="flex flex-nowrap items-center gap-2 whitespace-nowrap">
                    <RowFormDialog buttonLabel="Edit" title={`Edit ${row.code}`}>
                      <ActionForm action={updateItemTypeAction} submitLabel="Save" resetOnSuccess={false}>
                        <input type="hidden" name="id" value={row.id} />
                        <ItemTypeFields row={row} />
                      </ActionForm>
                    </RowFormDialog>
                    <ActionForm
                      action={setItemTypeActiveAction}
                      submitLabel={row.active ? "Deactivate" : "Activate"}
                      compact
                      className="flex items-center"
                      confirm={row.active ? `Deactivate ${row.code}?` : undefined}
                      danger={row.active}
                    >
                      <input type="hidden" name="id" value={row.id} />
                      <input type="hidden" name="active" value={row.active ? "false" : "true"} />
                    </ActionForm>
                  </div>
                </td>
              </tr>
            ))}
            {rows.length === 0 ? (
              <tr>
                <td className={tdClass} colSpan={8}>
                  No item types yet. Start with the sample bottles you want to track.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </section>
    </div>
  );
}

function ItemTypeFields({ row }: { row?: ItemTypeRow }) {
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
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" name="packSizeConfirmed" defaultChecked={row?.packSizeConfirmed ?? false} />
        Confirmed with the lab
      </label>
      <label className="flex items-center gap-2 text-sm sm:col-span-2">
        <input type="checkbox" name="coldStorage" defaultChecked={row?.coldStorage ?? false} />
        Needs cold storage (shows a &quot;Keep cold&quot; tag on stock, transfer and receive screens)
      </label>
      <label className="flex items-start gap-2 text-sm sm:col-span-2">
        <input type="checkbox" name="benchSupply" defaultChecked={row?.benchSupply ?? false} className="mt-1" />
        <span>
          Bench supply (shared by many patients, like cotton wool or gloves). Send it to the lab with a transfer, then
          the lab records what it used under Used for test and counts it in stock counts. It is not listed against a
          test or a patient, and ticking this removes it from any test list it is on.
        </span>
      </label>
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
