import { requirePermission } from "@/server/auth/session";
import { listVoidReasons } from "@/server/services/catalog.service";
import { PROTECTED_VOID_REASONS } from "@/server/domain/types";
import { ActionForm } from "@/components/forms/ActionForm";
import { FormDialog, RowFormDialog } from "@/components/forms/FormDialog";
import { Field } from "@/components/ui/Field";
import { inputClass, tableClass, tdClass, thClass } from "@/components/ui/styles";
import { createVoidReasonAction, setVoidReasonActiveAction, updateVoidReasonAction } from "./actions";

export const metadata = { title: "Void reasons" };

export default async function VoidReasonsPage() {
  await requirePermission("manage_void_reasons");
  const rows = await listVoidReasons();
  const protectedCodes: readonly string[] = PROTECTED_VOID_REASONS;

  return (
    <div className="flex flex-col gap-6">
      <FormDialog
        buttonLabel="Add reason"
        title="Add a reason"
        header={
          <>
            <h1 className="text-[22px] font-bold tracking-tight">Void reasons</h1>
            <p className="mt-1 text-sm text-zinc-500">
              The controlled list staff choose from when a bottle is voided or stock is wasted. Codes cannot be
              changed once created. {PROTECTED_VOID_REASONS.join(" and ")} are used by the system and cannot be
              deactivated.
            </p>
          </>
        }
      >
        <ActionForm action={createVoidReasonAction} submitLabel="Add reason">
          <Field label="Code" hint="For example LEAKING">
            <input name="code" required className={inputClass} autoCapitalize="characters" />
          </Field>
          <Field label="Label">
            <input name="label" required className={inputClass} />
          </Field>
        </ActionForm>
      </FormDialog>

      <section className="overflow-x-auto rounded-xl border border-line bg-surface px-2 py-1">
        <table className={tableClass}>
          <thead>
            <tr>
              <th className={thClass}>Code</th>
              <th className={thClass}>Label</th>
              <th className={thClass}>Status</th>
              <th className={thClass}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <td className={tdClass}>{row.code}</td>
                <td className={tdClass}>{row.label}</td>
                <td className={tdClass}>{row.active ? "Active" : "Inactive"}</td>
                <td className={tdClass}>
                  <div className="flex flex-nowrap items-center gap-2 whitespace-nowrap">
                    <RowFormDialog buttonLabel="Edit" title={`Edit ${row.code}`}>
                      <ActionForm action={updateVoidReasonAction} submitLabel="Save" resetOnSuccess={false}>
                        <input type="hidden" name="id" value={row.id} />
                        <Field label="Label" hint="The code cannot be changed.">
                          <input name="label" required defaultValue={row.label} className={inputClass} />
                        </Field>
                      </ActionForm>
                    </RowFormDialog>
                    {protectedCodes.includes(row.code) ? null : (
                      <ActionForm
                        action={setVoidReasonActiveAction}
                        submitLabel={row.active ? "Deactivate" : "Activate"}
                        compact
                        className="flex items-center"
                        confirm={row.active ? `Deactivate ${row.code}?` : undefined}
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
