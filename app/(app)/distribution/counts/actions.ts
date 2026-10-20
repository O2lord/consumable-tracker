"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requirePermission } from "@/server/auth/session";
import { cancelCount, postCount, submitCount } from "@/server/services/stock-count.service";
import { toFormError } from "@/server/actions/form-result";
import { formDataToObject } from "@/lib/form";
import type { FormState } from "@/components/forms/form-state";

const PATH = "/distribution/counts";
const STOCK_PATH = "/distribution/stock";

/**
 * The sheet posts one row per batch as repeated `batchId` / `counted` / `countedPieces` fields (every row sends all
 * three, so the lists line up). `counted` is sealed packs, `countedPieces` is loose pieces. A blank means "not counted";
 * a row with both blank is skipped.
 */
export async function submitCountAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const session = await requirePermission("count_stock");
  const raw = formDataToObject(formData);
  const ids = formData.getAll("batchId").map(String);
  const counted = formData.getAll("counted").map((v) => String(v).trim());
  const countedPieces = formData.getAll("countedPieces").map((v) => String(v).trim());

  const lines: { batchId: string; counted: number | null; countedPieces: number | null }[] = [];
  for (let i = 0; i < ids.length; i++) {
    const packs = counted[i] ?? "";
    const pieces = countedPieces[i] ?? "";
    if (packs === "" && pieces === "") continue;
    const p = packs === "" ? null : Number(packs);
    const q = pieces === "" ? null : Number(pieces);
    if ((p !== null && (!Number.isInteger(p) || p < 0)) || (q !== null && (!Number.isInteger(q) || q < 0))) {
      return { error: "Counts must be whole numbers, zero or more" };
    }
    lines.push({ batchId: ids[i], counted: p, countedPieces: q });
  }
  if (lines.length === 0) return { error: "Enter a count for at least one item (0 if there is none left)" };

  let countId: string;
  try {
    const count = await submitCount(
      {
        locationId: raw.locationId ? String(raw.locationId) : undefined,
        note: raw.note ? String(raw.note) : undefined,
        lines,
      },
      session,
    );
    countId = count.id;
  } catch (err) {
    return toFormError(err);
  }
  revalidatePath(PATH);
  // redirect() works by throwing, so it stays outside the try block.
  redirect(`${PATH}/${countId}`);
}

/**
 * Lines come as repeated fields, one set per line on the page: `lineId`, `reasonCode` / `lineNote` for the sealed
 * packs and `piecesReasonCode` / `piecesNote` for the loose pieces. Every line sends all five, so the lists line up.
 */
export async function postCountAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const session = await requirePermission("count_stock");
  const raw = formDataToObject(formData);
  const countId = String(raw.countId ?? "");
  const lineIds = formData.getAll("lineId").map(String);
  const reasons = formData.getAll("reasonCode").map(String);
  const notes = formData.getAll("lineNote").map(String);
  const piecesReasons = formData.getAll("piecesReasonCode").map(String);
  const piecesNotes = formData.getAll("piecesNote").map(String);

  try {
    const r = await postCount(
      countId,
      {
        lines: lineIds.map((lineId, i) => ({
          lineId,
          reasonCode: reasons[i] || null,
          note: notes[i] || null,
          piecesReasonCode: piecesReasons[i] || null,
          piecesNote: piecesNotes[i] || null,
        })),
      },
      session,
    );
    revalidatePath(PATH);
    revalidatePath(STOCK_PATH);
    revalidatePath(`${PATH}/${countId}`);
    return {
      message:
        r.adjustments === 0
          ? "Count posted. Everything matched"
          : `Count posted. ${r.adjustments} ${r.adjustments === 1 ? "adjustment" : "adjustments"} written to the ledger`,
    };
  } catch (err) {
    // A refreshed count shows its new expected figures, so the page has to reload either way.
    revalidatePath(`${PATH}/${countId}`);
    return toFormError(err);
  }
}

export async function cancelCountAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const session = await requirePermission("count_stock");
  const raw = formDataToObject(formData);
  const countId = String(raw.countId ?? "");
  let locationId: string;
  try {
    const cancelled = await cancelCount(countId, session);
    locationId = cancelled.locationId;
  } catch (err) {
    return toFormError(err);
  }
  revalidatePath(PATH);
  revalidatePath(STOCK_PATH);
  // Back to the Stock page's count tab, at the same location.
  redirect(`${STOCK_PATH}?tab=count&location=${encodeURIComponent(locationId)}`);
}
