"use server";

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/server/auth/session";
import { issueBottle } from "@/server/services/issue.service";
import { toFormError } from "@/server/actions/form-result";
import { formDataToObject } from "@/lib/form";
import type { FormState } from "@/components/forms/form-state";

const PATH = "/distribution/issue";

/** "IXS181 LFT" per line (reference, then the test it is for). A line without a test code gets the test chosen on screen. */
function parseReferenceLines(type: string, text: unknown, defaultTestCode?: string) {
  return String(text ?? "")
    .split(/[\n;,]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((line) => {
      if (type !== "INVESTIGATION") return { type, ref: line };
      const [ref, testCode] = line.split(/\s+/);
      return { type, ref, testCode: testCode || defaultTestCode || undefined };
    });
}

/**
 * Issue one bottle: one scan links it to every reference listed, and the per-patient items the person confirmed on
 * screen (edited, added or removed) leave the shelf with it, once, linked to the patient. The form sends the items
 * as paired itemTypeId / lineQuantity fields, in the same order.
 */
export async function issueUnitAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const session = await requirePermission("issue");
  const raw = formDataToObject(formData, ["useOverride"]);
  const type = String(raw.referenceType ?? "INVESTIGATION");
  const ids = formData.getAll("itemTypeId").map(String);
  const quantities = formData.getAll("lineQuantity").map(String);
  // Items always come off the shelf first-expiry-first-out; no pack is named.
  const items = ids
    .map((itemTypeId, i) => ({ itemTypeId, quantity: quantities[i] }))
    .filter((line) => line.itemTypeId.trim() !== "");
  try {
    const result = await issueBottle(
      {
        serial: String(raw.serial ?? ""),
        references: parseReferenceLines(type, raw.references, raw.testCode ? String(raw.testCode) : undefined) as never,
        patientHospitalNo: raw.patientHospitalNo as string | undefined,
        patientType: raw.patientType as never,
        collectorType: raw.collectorType as never,
        collectorName: String(raw.collectorName ?? ""),
        locationId: raw.locationId as string | undefined,
        override: raw.useOverride ? { reason: String(raw.overrideReason ?? "") } : undefined,
        items: items as never,
      },
      session,
    );
    revalidatePath(PATH);
    const refs = result.references.map((r) => r.ref).join(", ");
    const used = result.consumables
      .map((l) => `${l.quantity}${l.inPieces ? " pieces of" : " x"} ${l.itemName}`)
      .join(", ");
    const notes = [
      result.unverified > 0 ? `${result.unverified} payment(s) could not be verified and are flagged` : "",
      result.overridden ? "Supervisor override recorded" : "",
    ].filter(Boolean);
    return {
      message:
        `Issued ${result.serial} (${result.itemName}) for ${refs}.` +
        (used ? ` Items issued with it: ${used}.` : "") +
        ` Print the label from the list below.${notes.length ? ` ${notes.join(". ")}.` : ""}`,
    };
  } catch (err) {
    return toFormError(err);
  }
}
