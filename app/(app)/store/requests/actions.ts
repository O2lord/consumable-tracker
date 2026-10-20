"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { can, canWorkAtAnyLocation } from "@/server/auth/permissions";
import { requirePermission } from "@/server/auth/session";
import {
  approveRequest,
  cancelRequest,
  closeRequestLine,
  createRequest,
  createTransferForRequest,
  rejectRequest,
  submitRequest,
  updateDraftLocations,
  updateDraftRequest,
} from "@/server/services/request.service";
import { listActiveItemTypes } from "@/server/services/catalog.service";
import { toFormError } from "@/server/actions/form-result";
import { toRequestQuantity, type EntryUnit } from "@/lib/pack-size";
import { formDataToObject } from "@/lib/form";
import type { FormState } from "@/components/forms/form-state";

const refresh = (code: string) => {
  revalidatePath(`/store/requests/${code}`);
  revalidatePath("/store/requests");
};

type ParsedLines = { lines: { itemTypeId: string; quantity: number; inPieces: boolean }[] } | { error: string };

/**
 * Item rows come as repeated `itemTypeId` / `quantity` / `entryUnit` fields. Rows with no item chosen are skipped.
 * `entryUnit` says whether the number was typed in the item's own unit ("stock") or the other one ("alt": pieces for
 * a pack item, packs for a pieces item). Pieces that come to whole packs are saved as packs; any other number of
 * pieces of a pack item is saved as pieces (`inPieces`), so a lab can ask for 10 swabs from a pack of 100.
 */
async function readLines(formData: FormData): Promise<ParsedLines> {
  const ids = formData.getAll("itemTypeId").map(String);
  const quantities = formData.getAll("quantity").map(String);
  const entries = formData.getAll("entryUnit").map(String);
  const itemById = new Map((await listActiveItemTypes()).map((i) => [i.id, i] as const));
  const lines: { itemTypeId: string; quantity: number; inPieces: boolean }[] = [];
  for (let i = 0; i < ids.length; i++) {
    if (!ids[i]) continue;
    const typed = Number(quantities[i]);
    if (!Number.isInteger(typed) || typed < 1) return { error: "Enter a whole number of at least 1 for every item" };
    const entry: EntryUnit = entries[i] === "alt" ? "alt" : "stock";
    const item = itemById.get(ids[i]);
    if (entry === "alt" && !item) return { error: "One of the items is no longer available. Choose it again" };
    const saved = item ? toRequestQuantity(typed, entry, item.unitOfMeasure, item.packSize) : { quantity: typed, inPieces: false };
    if ("error" in saved) return { error: `${item?.name ?? "Item"}: ${saved.error}` };
    lines.push({ itemTypeId: ids[i], quantity: saved.quantity, inPieces: saved.inPieces });
  }
  if (lines.length === 0) return { error: "Add at least one item" };
  return { lines };
}

// --- lab side -----------------------------------------------------------------------------

export async function createRequestAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const session = await requirePermission("create_request");
  const raw = formDataToObject(formData);
  const parsed = await readLines(formData);
  if ("error" in parsed) return { error: parsed.error };

  // Lab staff always request for their own location. Supervisors and admins choose.
  const requestingLocationId = canWorkAtAnyLocation(session.role)
    ? String(raw.requestingLocationId ?? "")
    : (session.homeLocationId ?? "");
  if (!requestingLocationId) return { error: "Your account has no location. Ask an admin to set one" };

  let code: string;
  try {
    const request = await createRequest(
      {
        requestingLocationId,
        storeLocationId: String(raw.storeLocationId ?? ""),
        note: raw.note === undefined ? undefined : String(raw.note),
        lines: parsed.lines,
      },
      session,
    );
    code = request.code;
  } catch (err) {
    return toFormError(err);
  }
  revalidatePath("/store/requests");
  // redirect() works by throwing, so it stays outside the try block.
  redirect(`/store/requests/${code}`);
}

export async function updateDraftAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const session = await requirePermission("create_request");
  const raw = formDataToObject(formData);
  const code = String(raw.code ?? "");
  const parsed = await readLines(formData);
  if ("error" in parsed) return { error: parsed.error };
  try {
    await updateDraftRequest(
      String(raw.requestId ?? ""),
      { note: raw.note === undefined ? null : String(raw.note), lines: parsed.lines },
      session,
    );
    refresh(code);
    return { message: "Draft saved" };
  } catch (err) {
    return toFormError(err);
  }
}

export async function changeDraftLocationsAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const session = await requirePermission("create_request");
  const raw = formDataToObject(formData);
  const code = String(raw.code ?? "");
  // Only the fields the form posted are changed: lab staff have no requesting-location dropdown, so theirs stays.
  const requestingLocationId = String(raw.requestingLocationId ?? "");
  const storeLocationId = String(raw.storeLocationId ?? "");
  try {
    await updateDraftLocations(
      String(raw.requestId ?? ""),
      {
        ...(requestingLocationId ? { requestingLocationId } : {}),
        ...(storeLocationId ? { storeLocationId } : {}),
      },
      session,
    );
    refresh(code);
    return { message: "Locations saved" };
  } catch (err) {
    return toFormError(err);
  }
}

export async function submitRequestAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const session = await requirePermission("create_request");
  const raw = formDataToObject(formData);
  const code = String(raw.code ?? "");
  try {
    await submitRequest(String(raw.requestId ?? ""), session);
    refresh(code);
    return { message: "Sent to the store" };
  } catch (err) {
    return toFormError(err);
  }
}

export async function cancelRequestAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const session = await requirePermission("create_request");
  const raw = formDataToObject(formData);
  const code = String(raw.code ?? "");
  try {
    await cancelRequest(String(raw.requestId ?? ""), session);
    refresh(code);
    return { message: "Request cancelled" };
  } catch (err) {
    return toFormError(err);
  }
}

// --- store side ---------------------------------------------------------------------------

export async function approveRequestAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const session = await requirePermission("review_requests");
  const raw = formDataToObject(formData);
  const code = String(raw.code ?? "");

  const lineIds = formData.getAll("lineId").map(String);
  const approved = formData.getAll("quantityApproved").map(String);
  const lines: { lineId: string; quantityApproved: number }[] = [];
  for (let i = 0; i < lineIds.length; i++) {
    const quantityApproved = Number(approved[i]);
    if (!Number.isInteger(quantityApproved) || quantityApproved < 0) {
      return { error: "Enter a whole number for every item (0 declines an item)" };
    }
    lines.push({ lineId: lineIds[i], quantityApproved });
  }

  let transferCode: string;
  try {
    const r = await approveRequest(
      String(raw.requestId ?? ""),
      { lines, reviewNote: raw.reviewNote === undefined ? undefined : String(raw.reviewNote) },
      session,
    );
    transferCode = r.transfer.code;
  } catch (err) {
    return toFormError(err);
  }
  refresh(code);
  // The next job is filling the draft transfer. Send the store keeper straight to it when they may.
  redirect(can(session.role, "dispatch") ? `/store/transfers/${transferCode}` : `/store/requests/${code}`);
}

export async function rejectRequestAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const session = await requirePermission("review_requests");
  const raw = formDataToObject(formData);
  const code = String(raw.code ?? "");
  try {
    await rejectRequest(
      String(raw.requestId ?? ""),
      { reviewNote: raw.reviewNote === undefined ? "" : String(raw.reviewNote) },
      session,
    );
    refresh(code);
    return { message: "Request rejected" };
  } catch (err) {
    return toFormError(err);
  }
}

export async function closeLineAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const session = await requirePermission("review_requests");
  const raw = formDataToObject(formData);
  const code = String(raw.code ?? "");
  try {
    const r = await closeRequestLine(
      String(raw.requestId ?? ""),
      String(raw.lineId ?? ""),
      { reason: raw.reason === undefined ? "" : String(raw.reason) },
      session,
    );
    refresh(code);
    return { message: `Line closed. Request is now ${r.requestStatus.toLowerCase().replaceAll("_", " ")}` };
  } catch (err) {
    return toFormError(err);
  }
}

export async function anotherTransferAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const session = await requirePermission("review_requests");
  const raw = formDataToObject(formData);
  const code = String(raw.code ?? "");
  let transferCode: string;
  try {
    const transfer = await createTransferForRequest(String(raw.requestId ?? ""), session);
    transferCode = transfer.code;
  } catch (err) {
    return toFormError(err);
  }
  refresh(code);
  redirect(can(session.role, "dispatch") ? `/store/transfers/${transferCode}` : `/store/requests/${code}`);
}
