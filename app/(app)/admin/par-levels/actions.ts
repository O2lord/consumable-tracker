"use server";

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/server/auth/session";
import { saveParLevels } from "@/server/services/par-level.service";
import { toFormError } from "@/server/actions/form-result";
import type { FormState } from "@/components/forms/form-state";

/** The form posts one row per item as repeated `itemTypeId` / `target` / `minimum` fields. A blank target means none. */
export async function saveParLevelsAction(_prev: FormState, formData: FormData): Promise<FormState> {
  await requirePermission("manage_par_levels");
  const locationId = String(formData.get("locationId") ?? "");
  const ids = formData.getAll("itemTypeId").map(String);
  const targets = formData.getAll("target").map((v) => String(v).trim());
  const minimums = formData.getAll("minimum").map((v) => String(v).trim());

  const rows: { itemTypeId: string; target: number | null; minimum: number }[] = [];
  for (let i = 0; i < ids.length; i++) {
    const target = targets[i] === "" || targets[i] === undefined ? null : Number(targets[i]);
    const minimum = minimums[i] === "" || minimums[i] === undefined ? 0 : Number(minimums[i]);
    if ((target !== null && !Number.isInteger(target)) || !Number.isInteger(minimum)) {
      return { error: "Targets and minimums must be whole numbers" };
    }
    if (target === null && minimum > 0) {
      return { error: "A minimum needs a target. Set a target for that item or clear its minimum" };
    }
    rows.push({ itemTypeId: ids[i], target, minimum });
  }

  try {
    const r = await saveParLevels({ locationId, rows });
    revalidatePath("/admin/par-levels");
    return { message: `Saved: ${r.set} ${r.set === 1 ? "target" : "targets"} set, ${r.removed} removed` };
  } catch (err) {
    return toFormError(err);
  }
}
