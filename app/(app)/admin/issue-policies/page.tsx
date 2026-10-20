import { requirePermission } from "@/server/auth/session";
import { listIssuePolicies } from "@/server/services/policy.service";
import { ISSUE_RULES, POLICY_PATIENT_TYPES, REFERENCE_TYPES } from "@/server/domain/types";
import { ActionForm } from "@/components/forms/ActionForm";
import { FormDialog } from "@/components/forms/FormDialog";
import { Field } from "@/components/ui/Field";
import { inputClass, tableClass, tdClass, thClass } from "@/components/ui/styles";
import { deletePolicyAction, savePolicyAction } from "./actions";

export const metadata = { title: "Issue policies" };

const RULE_HELP: Record<string, string> = {
  MUST_BE_PAID: "Blocked when known to be unpaid. Recorded as unverified when payment cannot be checked.",
  CHARGE_TO_ADMISSION: "No prepayment: the charge goes to the admission's bill.",
  NONE: "No payment check.",
};

const label = (value: string) => value.charAt(0) + value.slice(1).toLowerCase().replace(/_/g, " ");

export default async function IssuePoliciesPage() {
  await requirePermission("manage_policies");
  const rows = await listIssuePolicies();

  return (
    <div className="flex flex-col gap-6">
      <FormDialog
        buttonLabel="Set a rule"
        header={
          <>
            <h1 className="text-[22px] font-bold tracking-tight">Issue policies</h1>
            <p className="mt-1 text-sm text-zinc-500">
              Whether payment or a charge is needed before something is issued. A rule for &quot;Any&quot; patient type is
              the fallback for a reference type; where nothing matches, no check is made. Saving a combination that
              already exists changes its rule.
            </p>
          </>
        }
      >
        <ActionForm action={savePolicyAction} submitLabel="Save rule">
          <Field label="Reference type">
            <select name="referenceType" required defaultValue="INVESTIGATION" className={inputClass}>
              {REFERENCE_TYPES.map((t) => (
                <option key={t} value={t}>
                  {label(t)}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Patient type">
            <select name="patientType" required defaultValue="ANY" className={inputClass}>
              {POLICY_PATIENT_TYPES.map((t) => (
                <option key={t} value={t}>
                  {label(t)}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Rule">
            <select name="rule" required defaultValue="NONE" className={inputClass}>
              {ISSUE_RULES.map((r) => (
                <option key={r} value={r}>
                  {label(r)}
                </option>
              ))}
            </select>
          </Field>
        </ActionForm>
      </FormDialog>

      <section className="overflow-x-auto rounded-xl border border-line bg-surface px-2 py-1">
        <table className={tableClass}>
          <thead>
            <tr>
              <th className={thClass}>Reference type</th>
              <th className={thClass}>Patient type</th>
              <th className={thClass}>Rule</th>
              <th className={thClass} />
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <td className={tdClass}>{label(row.referenceType)}</td>
                <td className={tdClass}>{label(row.patientType)}</td>
                <td className={tdClass}>
                  {label(row.rule)}
                  <span className="block text-xs text-zinc-500">{RULE_HELP[row.rule]}</span>
                </td>
                <td className={tdClass}>
                  <ActionForm
                    action={deletePolicyAction}
                    submitLabel="Remove"
                    compact
                    danger
                    confirm="Remove this rule? Issues of this kind will fall back to the Any rule, or no check."
                  >
                    <input type="hidden" name="id" value={row.id} />
                  </ActionForm>
                </td>
              </tr>
            ))}
            {rows.length === 0 ? (
              <tr>
                <td className={tdClass} colSpan={4}>
                  No rules. Nothing is checked before issuing.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </section>
    </div>
  );
}
