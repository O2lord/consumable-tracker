import { requirePermission } from "@/server/auth/session";
import { PERMISSION_GROUPS, type Permission } from "@/server/auth/permissions";
import { listRoles } from "@/server/services/roles.service";
import { ActionForm } from "@/components/forms/ActionForm";
import { FormDialog, RowFormDialog } from "@/components/forms/FormDialog";
import { Field } from "@/components/ui/Field";
import { inputClass, tableClass, tdClass, thClass } from "@/components/ui/styles";
import { createRoleAction, deleteRoleAction, updateRoleAction } from "./actions";

export const metadata = { title: "Roles" };

type RoleRow = Awaited<ReturnType<typeof listRoles>>[number];

export default async function RolesPage() {
  await requirePermission("manage_roles");
  const rows = await listRoles();

  return (
    <div className="flex flex-col gap-6">
      <FormDialog
        buttonLabel="Add role"
        title="Add a role"
        header={
          <>
            <h1 className="text-[22px] font-bold tracking-tight">Roles</h1>
            <p className="mt-1 text-sm text-zinc-500">
              A role is a set of things a person may do. Give each person a role under Users. Changing a role
              takes effect for its people the next time they load a page.
            </p>
          </>
        }
      >
        <ActionForm action={createRoleAction} submitLabel="Create role">
          <Field label="Role name" hint="For example Lab supervisor">
            <input name="name" required maxLength={60} className={inputClass} />
          </Field>
          <Field label="Description (optional)">
            <input name="description" maxLength={300} className={inputClass} />
          </Field>
          <PermissionPicker selected={[]} />
        </ActionForm>
      </FormDialog>

      <section className="overflow-x-auto rounded-xl border border-line bg-surface px-2 py-1">
        <table className={tableClass}>
          <thead>
            <tr>
              <th className={thClass}>Role</th>
              <th className={thClass}>Description</th>
              <th className={thClass}>People</th>
              <th className={thClass}>Permissions</th>
              <th className={thClass}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.code}>
                <td className={tdClass}>
                  {row.name}
                  {row.locked ? <span className="ml-2 text-xs text-muted">Locked</span> : null}
                </td>
                <td className={tdClass}>{row.description || "-"}</td>
                <td className={tdClass}>{row.userCount}</td>
                <td className={tdClass}>{row.permissions.length}</td>
                <td className={tdClass}>
                  <div className="flex flex-nowrap items-center gap-2 whitespace-nowrap">
                    <RowFormDialog buttonLabel="Edit" title={`Edit ${row.name}`}>
                      <EditForm row={row} />
                    </RowFormDialog>
                    {row.locked ? null : <DeleteForm row={row} />}
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

function EditForm({ row }: { row: RoleRow }) {
  return (
    <ActionForm action={updateRoleAction} submitLabel="Save" resetOnSuccess={false}>
      <input type="hidden" name="code" value={row.code} />
      <Field label="Role name">
        <input name="name" required maxLength={60} defaultValue={row.name} className={inputClass} />
      </Field>
      <Field label="Description (optional)">
        <input name="description" maxLength={300} defaultValue={row.description} className={inputClass} />
      </Field>
      {row.locked ? (
        <p className="rounded-lg border border-line bg-brand-soft px-3 py-2 text-sm">
          This role is locked. It always has every administration screen, so there is always someone who can
          manage users and roles. Only its name and description can be changed.
        </p>
      ) : null}
      <PermissionPicker selected={row.permissions} locked={row.locked} />
    </ActionForm>
  );
}

function DeleteForm({ row }: { row: RoleRow }) {
  if (row.userCount > 0) {
    return <span className="text-xs text-muted">In use</span>;
  }
  return (
    <ActionForm
      action={deleteRoleAction}
      submitLabel="Delete"
      compact
      className="flex items-center"
      confirm={`Delete the role ${row.name}?`}
      danger
    >
      <input type="hidden" name="code" value={row.code} />
    </ActionForm>
  );
}

/** Every permission as a tick box, in groups. Ticked boxes arrive as repeated "permissions" fields. */
function PermissionPicker({ selected, locked = false }: { selected: readonly Permission[]; locked?: boolean }) {
  const chosen = new Set<Permission>(selected);
  return (
    <fieldset className="flex flex-col gap-4">
      <legend className="mb-1 text-sm font-semibold">What this role may do</legend>
      {PERMISSION_GROUPS.map((group) => (
        <div key={group.title} className="flex flex-col gap-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">{group.title}</h3>
          {group.items.map((item) => (
            <label key={item.permission} className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                name="permissions"
                value={item.permission}
                defaultChecked={chosen.has(item.permission)}
                disabled={locked}
                className="mt-0.5"
              />
              <span>
                {item.label}
                {item.hint ? <span className="block text-xs text-muted">{item.hint}</span> : null}
              </span>
            </label>
          ))}
        </div>
      ))}
    </fieldset>
  );
}
