"use server";

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/server/auth/session";
import { toFormError } from "@/server/actions/form-result";
import { runPharmacyReconcile } from "@/server/services/pharmacy-reconcile.service";
import type { FormState } from "@/components/forms/form-state";

/** Records a reconcile run now (same as the daily job, but started by a person). */
export async function runReconcileAction(): Promise<FormState> {
  const session = await requirePermission("view_reports");
  try {
    const run = await runPharmacyReconcile({ triggeredBy: "USER", userId: session.userId });
    revalidatePath("/reports/pharmacy");
    return {
      message:
        run.problemsTotal === 0
          ? "Checked: nothing differs from Pharmacy."
          : `Checked: ${run.problemsTotal} difference${run.problemsTotal === 1 ? "" : "s"} recorded.`,
    };
  } catch (err) {
    return toFormError(err);
  }
}
