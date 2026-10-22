import { requirePermission } from "@/server/auth/session";
import { listLocations } from "@/server/services/catalog.service";
import { EXTERNAL_SYSTEMS, LOCATION_TYPES, SERVICE_ROLES } from "@/server/domain/types";
import { ActionForm } from "@/components/forms/ActionForm";
import { FormDialog, RowFormDialog } from "@/components/forms/FormDialog";
import { Field } from "@/components/ui/Field";
import { Select } from "@/components/ui/Dropdown";
import { inputClass, tableClass, tdClass, thClass } from "@/components/ui/styles";
import { createLocationAction, setLocationActiveAction, updateLocationAction } from "./actions";

export const metadata = { title: "Locations" };

type LocationRow = Awaited<ReturnType<typeof listLocations>>[number];

export default async function LocationsPage() {
  await requirePermission("manage_locations");
  const rows = await listLocations();

  return (
    <div className="flex flex-col gap-6">
      <FormDialog
        buttonLabel="Add location"
        title="Add a location"
        header={
          <>
            <h1 className="text-[22px] font-bold tracking-tight">Locations</h1>
            <p className="mt-1 text-sm text-zinc-500">
              Stores, labs, wards and theatres: anywhere stock is held. Stock can only be received into a STORE.
            </p>
          </>
        }
      >
        <ActionForm action={createLocationAction} submitLabel="Add location">
          <LocationFields />
        </ActionForm>
      </FormDialog>

      <section className="overflow-x-auto rounded-xl border border-line bg-surface px-2 py-1">
        <table className={tableClass}>
          <thead>
            <tr>
              <th className={thClass}>Code</th>
              <th className={thClass}>Name</th>
              <th className={thClass}>Type</th>
              <th className={thClass}>Service role</th>
              <th className={thClass}>EMR mapping</th>
              <th className={thClass}>Reuse unused</th>
              <th className={thClass}>Status</th>
              <th className={thClass}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <td className={tdClass}>{row.code}</td>
                <td className={tdClass}>{row.name}</td>
                <td className={tdClass}>{row.type}</td>
                <td className={tdClass}>{row.serviceRole ?? "-"}</td>
                <td className={tdClass}>
                  {row.externalSystem ? `${row.externalSystem}: ${row.externalId}` : "-"}
                </td>
                <td className={tdClass}>{row.allowUnusedReuse ? "Yes" : "No"}</td>
                <td className={tdClass}>{row.active ? "Active" : "Inactive"}</td>
                <td className={tdClass}>
                  <div className="flex flex-wrap items-center gap-2">
                    <RowFormDialog buttonLabel="Edit" title={`Edit ${row.code}`}>
                      <EditForm row={row} />
                    </RowFormDialog>
                    <ActionForm
                      action={setLocationActiveAction}
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
                  No locations yet. Add a main store first.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </section>
    </div>
  );
}

function EditForm({ row }: { row: LocationRow }) {
  return (
    <ActionForm action={updateLocationAction} submitLabel="Save" resetOnSuccess={false}>
      <input type="hidden" name="id" value={row.id} />
      <LocationFields row={row} />
    </ActionForm>
  );
}

function LocationFields({ row }: { row?: LocationRow }) {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <Field
        label="Code"
        hint={row ? "Permanent, cannot be changed" : "Short and permanent, for example MAIN-STORE or EPU-LAB"}
      >
        {row ? (
          <input value={row.code} disabled readOnly className={`${inputClass} opacity-70`} />
        ) : (
          <input name="code" required className={inputClass} autoCapitalize="characters" />
        )}
      </Field>
      <Field label="Name">
        <input name="name" required defaultValue={row?.name} className={inputClass} />
      </Field>
      <Field label="Type" hint="The physical kind of place">
        <Select name="type" required options={LOCATION_TYPES} defaultValue={row?.type ?? "STORE"} />
      </Field>
      <Field
        label="Service role (optional)"
        hint="What it does for stock. Collection points hand items to patients; benches and the blood bank use them in the lab. Blank means no restriction."
      >
        <Select name="serviceRole" options={SERVICE_ROLES} defaultValue={row?.serviceRole ?? ""} emptyLabel="None" />
      </Field>
      <Field label="EMR system (optional)">
        <Select name="externalSystem" options={EXTERNAL_SYSTEMS} defaultValue={row?.externalSystem ?? ""} emptyLabel="None" />
      </Field>
      <div className="sm:col-span-2">
        <Field label="EMR id (optional)" hint="The matching lab destination or ward in the EMR">
          <input name="externalId" defaultValue={row?.externalId ?? ""} className={inputClass} />
        </Field>
      </div>
      <label className="flex items-center gap-2 text-sm sm:col-span-2">
        <input type="checkbox" name="allowUnusedReuse" defaultChecked={row?.allowUnusedReuse ?? true} />
        Unused bottles returned here may go back into stock
      </label>
    </div>
  );
}
