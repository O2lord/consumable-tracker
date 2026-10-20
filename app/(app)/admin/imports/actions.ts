"use server";

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/server/auth/session";
import { importPharmacy } from "@/server/services/import.service";
import { PHARMACY_IMPORT_KINDS, type PharmacyImportKind } from "@/server/domain/types";
import { toFormError } from "@/server/actions/form-result";
import type { FormState } from "@/components/forms/form-state";

const PATH = "/admin/imports";

/**
 * Loads a Pharmacy export: stock on hand, one GRN, or the transfers list. Re-uploading updates the rows
 * already loaded. An inventory file with no location column needs the location chosen here.
 */
export async function importPharmacyAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const session = await requirePermission("manage_imports");

  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) return { error: "Choose a file to upload." };

  const kind = String(formData.get("kind") ?? "");
  if (!(PHARMACY_IMPORT_KINDS as readonly string[]).includes(kind)) {
    return { error: "Choose what the file is (stock on hand, a GRN or transfers)." };
  }

  const locationId = String(formData.get("locationId") ?? "").trim() || null;
  const grnRef = String(formData.get("grnRef") ?? "").trim() || null;

  try {
    const summary = await importPharmacy(
      { kind: kind as PharmacyImportKind, fileName: file.name, data: await file.arrayBuffer(), locationId, grnRef },
      session,
    );
    revalidatePath(PATH);
    revalidatePath("/reports/pharmacy");
    const rejected = summary.rejected > 0 ? ` ${summary.rejected} rows were rejected; see the history below.` : "";
    return {
      message: `${summary.fileName}: ${summary.inserted} added, ${summary.updated} updated.${rejected}`,
    };
  } catch (err) {
    return toFormError(err);
  }
}
