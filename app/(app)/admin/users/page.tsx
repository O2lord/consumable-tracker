import { requirePermission } from "@/server/auth/session";
import { listUsers } from "@/server/services/users.service";
import { listActiveLocations } from "@/server/services/catalog.service";
import { listRoleOptions } from "@/server/services/roles.service";
import { ActionForm } from "@/components/forms/ActionForm";
import { FormDialog, RowFormDialog } from "@/components/forms/FormDialog";
import { Field } from "@/components/ui/Field";
import { inputClass, tableClass, tdClass, thClass } from "@/components/ui/styles";
import { createUserAction, resetPasswordAction, setUserActiveAction, updateUserAction } from "./actions";

export const metadata = { title: "Users" };

type UserRow = Awaited<ReturnType<typeof listUsers>>[number];
type LocationOption = Awaited<ReturnType<typeof listActiveLocations>>[number];
type RoleOption = Awaited<ReturnType<typeof listRoleOptions>>[number];

export default async function UsersPage() {
  const session = await requirePermission("manage_users");
  const [rows, locations, roleOptions] = await Promise.all([listUsers(), listActiveLocations(), listRoleOptions()]);

  return (
    <div className="flex flex-col gap-6">
      <FormDialog
        buttonLabel="Add staff account"
        title="Add a staff account"
        header={
          <>
            <h1 className="text-[22px] font-bold tracking-tight">Users</h1>
            <p className="mt-1 text-sm text-zinc-500">
              Staff log in with their staff ID. Deactivating an account blocks login immediately and keeps
              its history.
            </p>
          </>
        }
      >
        <ActionForm action={createUserAction} submitLabel="Create account">
          <Field label="Staff ID" hint="Exactly as it appears in the EMR, for example UATH/STF/001">
            <input name="staffId" required autoCapitalize="characters" className={inputClass} />
          </Field>
          <Field label="Full name">
            <input name="name" required className={inputClass} />
          </Field>
          <RoleAndLocation locations={locations} roles={roleOptions} />
          <Field label="Initial password" hint="At least 8 characters. Tell the person in private.">
            <input name="password" type="password" required minLength={8} autoComplete="new-password" className={inputClass} />
          </Field>
        </ActionForm>
      </FormDialog>

      <section className="overflow-x-auto rounded-xl border border-line bg-surface px-2 py-1">
        <table className={tableClass}>
          <thead>
            <tr>
              <th className={thClass}>Staff ID</th>
              <th className={thClass}>Name</th>
              <th className={thClass}>Role</th>
              <th className={thClass}>Home location</th>
              <th className={thClass}>Status</th>
              <th className={thClass}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <td className={tdClass}>{row.staffId}</td>
                <td className={tdClass}>{row.name}</td>
                <td className={tdClass}>{row.roleName}</td>
                <td className={tdClass}>{row.homeLocationName ?? "-"}</td>
                <td className={tdClass}>{row.active ? "Active" : "Inactive"}</td>
                <td className={tdClass}>
                  <div className="flex flex-nowrap items-center gap-2 whitespace-nowrap">
                    <RowFormDialog buttonLabel="Edit" title={`Edit ${row.staffId}`}>
                      <div className="flex flex-col gap-6">
                        <EditForm row={row} locations={locations} roles={roleOptions} />
                        <div className="border-t border-line pt-4">
                          <h3 className="mb-3 text-sm font-semibold">Reset password</h3>
                          <ActionForm action={resetPasswordAction} submitLabel="Set password">
                            <input type="hidden" name="id" value={row.id} />
                            <Field label="New password" hint="At least 8 characters. Tell the person in private.">
                              <input
                                name="password"
                                type="password"
                                required
                                minLength={8}
                                autoComplete="new-password"
                                className={inputClass}
                              />
                            </Field>
                          </ActionForm>
                        </div>
                      </div>
                    </RowFormDialog>
                    {row.id === session.userId ? null : (
                      <ActionForm
                        action={setUserActiveAction}
                        submitLabel={row.active ? "Deactivate" : "Activate"}
                        compact
                        className="flex items-center"
                        confirm={row.active ? `Deactivate ${row.staffId}?` : undefined}
                        danger={row.active}
                      >
                        <input type="hidden" name="id" value={row.id} />
                        <input type="hidden" name="active" value={row.active ? "false" : "true"} />
                      </ActionForm>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}

function EditForm({ row, locations, roles }: { row: UserRow; locations: LocationOption[]; roles: RoleOption[] }) {
  return (
    <ActionForm action={updateUserAction} submitLabel="Save" resetOnSuccess={false}>
      <input type="hidden" name="id" value={row.id} />
      <Field label="Full name">
        <input name="name" required defaultValue={row.name} className={inputClass} />
      </Field>
      <RoleAndLocation locations={locations} roles={roles} row={row} />
    </ActionForm>
  );
}

function RoleAndLocation({
  locations,
  roles,
  row,
}: {
  locations: LocationOption[];
  roles: RoleOption[];
  row?: UserRow;
}) {
  return (
    <>
      <Field label="Role">
        <select name="role" required defaultValue={row?.role ?? roles.find((r) => r.code === "DISTRIBUTOR")?.code ?? roles[0]?.code} className={inputClass}>
          {roles.map((r) => (
            <option key={r.code} value={r.code}>
              {r.name}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Home location (optional)">
        <select name="homeLocationId" defaultValue={row?.homeLocationId ?? ""} className={inputClass}>
          <option value="">None</option>
          {locations.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name} ({l.code})
            </option>
          ))}
        </select>
      </Field>
    </>
  );
}
