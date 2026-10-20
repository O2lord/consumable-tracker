"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requirePermission } from "@/server/auth/session";
import {
  addPackToDraft,
  addUnitToTransfer,
  cancelTransfer,
  confirmTransfer,
  lookupBatchForDispatch,
  removePackFromDraft,
  removeTransferItem,
  setBatchQuantity,
} from "@/server/services/transfer.service";
import { toFormError } from "@/server/actions/form-result";
import { toScanError } from "@/server/actions/scan-result";
import { formDataToObject } from "@/lib/form";
import { isValidBatchCode, isValidPackCode, normalizeCode } from "@/lib/serial";
import { partLetter } from "@/lib/part-letter";
import { describeHolding, isPackUnit } from "@/lib/pack-size";
import type { FormState } from "@/components/forms/form-state";
import type { ScanOutcome } from "@/components/scanner/ScanFeedback";
import type { DispatchBatchInfo, DispatchScanResult } from "@/types/dispatch-scan";

const refresh = (code: string) => revalidatePath(`/store/transfers/${code}`);

/**
 * Puts one scanned pack or roll on the draft as a whole pack. The batch comes back with it, so the screen keeps its
 * counts right and follows the pack to its own batch if that is not the one that was open.
 */
async function addWholePack(transferId: string, code: string, packCode: string): Promise<DispatchScanResult> {
  const r = await addPackToDraft(transferId, packCode);
  refresh(code);
  const batch = await lookupBatchForDispatch(transferId, r.batchCode);
  return {
    kind: "ok",
    message: `Added pack ${r.packCode}, ${r.itemName} (${r.quantity} ${r.quantity === 1 ? "pack" : "packs"} on the draft)`,
    undoId: `pack:${r.packCode}`,
    batchCount: r.quantity,
    batch,
  };
}

/**
 * One scan on the dispatch screen. A box label (BT...) means packs of that batch are being sent, so the person then
 * scans each pack. A pack or roll label (PK...) scanned on its own means pieces of that pack: the person enters how
 * many, or sends the whole pack. A bottle label (CT...) goes on the draft, and when a box is active the bottle must
 * belong to it.
 *
 * With `wholePacks` on (a box label was scanned and the screen is sending packs), a pack or roll label goes on the
 * draft as one whole pack, so its location can follow it to the receiving store. Otherwise it only selects that pack.
 */
export async function scanDispatchAction(
  transferId: string,
  code: string,
  value: string,
  activeBatch: string | null,
  wholePacks = false,
): Promise<DispatchScanResult> {
  await requirePermission("dispatch");
  try {
    if (wholePacks && isValidPackCode(value)) return await addWholePack(transferId, code, value);
    if (isValidBatchCode(normalizeCode(value)) || isValidPackCode(value)) {
      const info = await lookupBatchForDispatch(transferId, value);
      // A pack that is not in the sending store cannot be sent from here, whether as pieces or whole.
      if (isValidPackCode(value) && info.trackingMode === "QUANTITY" && !info.pack) {
        return { kind: "error", message: `Pack ${normalizeCode(value)} is not in the sending store, so it cannot be sent from here` };
      }
      if (info.pack ? info.pack.piecesLeft === 0 : info.available === 0) {
        return {
          kind: "error",
          message: info.pack
            ? `Pack ${info.pack.code} has no pieces left to send`
            : `No ${info.itemName} from batch ${info.batchCode} is free in this store`,
        };
      }
      const next = partLetter(info.partsSent + 1);
      const piecesOk = info.packSize > 1 && isPackUnit(info.unit);
      let message: string;
      if (info.trackingMode === "SERIAL") {
        message = `Box ${info.batchCode}: ${info.itemName}, ${info.available} here, ${info.onDraft} on this draft. Scan the bottles you are sending (part ${next})`;
      } else if (info.pack) {
        // A pack scanned on its own: pieces from it, or the whole pack when it is still sealed.
        const p = info.pack;
        message = piecesOk
          ? `Pack ${p.code}: ${p.piecesLeft} of ${p.piecesPerPack} pieces left. Enter how many pieces you are sending${p.intact ? ", or send the whole pack" : ". It has been opened, so it can only go as pieces"} (part ${next})`
          : `Pack ${p.code}: ${info.itemName}. Send the whole pack (part ${next})`;
      } else if (info.hasPackLabels) {
        // A box label: packs are being sent, so each one is scanned.
        message = `Box ${info.batchCode}: ${info.itemName}, ${info.available} ${info.available === 1 ? "pack" : "packs"} here. Scan each pack you are sending (part ${next})`;
      } else {
        // Stock received before pack labels existed has no pack labels to scan, so it is still typed.
        message =
          info.packSize > 1
            ? `Box ${info.batchCode}: ${info.itemName}, ${describeHolding(info.available, info.looseAvailable)} available. This stock has no pack labels: enter the quantity below, in packs or pieces (part ${next})`
            : `Box ${info.batchCode}: ${info.itemName}, ${info.available} available. Enter the quantity below (part ${next})`;
      }
      return { kind: "ok", message, batch: info };
    }

    const r = await addUnitToTransfer(transferId, value, undefined, activeBatch ?? undefined);
    refresh(code);
    if (r.status === "duplicate") {
      return {
        kind: "duplicate",
        message: `${r.serial} is already on this transfer`,
        batchCount: r.batchCount,
      };
    }
    return {
      kind: "ok",
      message: `Added ${r.serial}, ${r.itemName}`,
      undoId: r.itemId,
      batchCount: r.batchCount,
    };
  } catch (err) {
    return toScanError(err);
  }
}

/** "Send whole pack" for the pack that was just scanned: puts it on the draft as one whole pack, without another scan. */
export async function sendWholePackAction(transferId: string, code: string, packCode: string): Promise<DispatchScanResult> {
  await requirePermission("dispatch");
  try {
    return await addWholePack(transferId, code, packCode);
  } catch (err) {
    return toScanError(err);
  }
}

/** Re-reads the active box after an undo, so its "6 of 10" count stays right. */
export async function lookupBatchAction(transferId: string, batch: string): Promise<DispatchBatchInfo | null> {
  await requirePermission("dispatch");
  try {
    return await lookupBatchForDispatch(transferId, batch);
  } catch {
    return null;
  }
}

/** Takes the last scanned line off the draft. */
export async function undoItemAction(transferId: string, code: string, itemId: string): Promise<ScanOutcome> {
  await requirePermission("dispatch");
  try {
    // A whole pack that was scanned onto the draft is undone by its code; anything else by its line id.
    const counts = itemId.startsWith("pack:")
      ? await removePackFromDraft(transferId, itemId.slice("pack:".length))
      : await removeTransferItem(transferId, itemId);
    refresh(code);
    return {
      kind: "ok",
      message: itemId.startsWith("pack:") ? "Pack removed from the draft" : `Removed. ${counts.serialCount} bottles on the draft`,
    };
  } catch (err) {
    return toScanError(err);
  }
}

/** Sets how much of a bulk batch goes on the draft (scan the box label, then type the quantity). */
export async function setQuantityAction(_prev: FormState, formData: FormData): Promise<FormState> {
  await requirePermission("dispatch");
  const raw = formDataToObject(formData);
  const transferId = String(raw.transferId ?? "");
  const code = String(raw.code ?? "");
  const batch = String(raw.batch ?? "");
  const quantity = Number(raw.quantity);
  // "pieces" sends loose pieces out of a pack (a pack is opened when needed); anything else counts whole units.
  const inPieces = String(raw.unit ?? "") === "pieces";
  // The pack label that was scanned, if any. Only used for pieces: it lowers that pack's pieces remaining.
  const pack = String(raw.pack ?? "").trim();
  if (!batch) return { error: "Scan or type the batch code from the box label" };
  if (!Number.isInteger(quantity) || quantity <= 0) return { error: "Enter a whole number greater than zero" };
  try {
    const r = await setBatchQuantity(transferId, batch, quantity, undefined, { inPieces, packCode: pack || null });
    refresh(code);
    return {
      message: r.inPieces
        ? `${r.quantity} ${r.quantity === 1 ? "piece" : "pieces"} of ${r.itemName} (${r.batchCode}${r.packCode ? `, pack ${r.packCode}` : ""}) on the draft`
        : `${r.quantity} x ${r.itemName} (${r.batchCode}) on the draft`,
    };
  } catch (err) {
    return toFormError(err);
  }
}

/** Removes one line (used for bulk lines; scanned bottles use undo). */
export async function removeItemAction(_prev: FormState, formData: FormData): Promise<FormState> {
  await requirePermission("dispatch");
  const raw = formDataToObject(formData);
  const code = String(raw.code ?? "");
  try {
    await removeTransferItem(String(raw.transferId ?? ""), String(raw.itemId ?? ""));
    refresh(code);
    return { message: "Removed" };
  } catch (err) {
    return toFormError(err);
  }
}

export async function confirmTransferAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const session = await requirePermission("dispatch");
  const raw = formDataToObject(formData);
  const code = String(raw.code ?? "");
  try {
    const r = await confirmTransfer(String(raw.transferId ?? ""), session.userId, {
      explanation: raw.explanation === undefined ? undefined : String(raw.explanation),
      carriedByName: String(raw.carriedByName ?? ""),
    });
    refresh(code);
    const parts = r.parts.map((p) => `${p.batchCode} part ${p.letter}`).join(", ");
    const pieces = r.pieceTotal > 0 ? `${r.total > 0 ? " and " : ""}${r.pieceTotal} ${r.pieceTotal === 1 ? "piece" : "pieces"}` : "";
    const what = r.total > 0 || r.pieceTotal === 0 ? `${r.total} items` : "";
    return {
      message: `Dispatched ${what}${pieces}${parts ? ` (${parts})` : ""}. Print the slip and send it with the stock.`,
    };
  } catch (err) {
    return toFormError(err);
  }
}

export async function cancelTransferAction(_prev: FormState, formData: FormData): Promise<FormState> {
  await requirePermission("dispatch");
  const raw = formDataToObject(formData);
  try {
    await cancelTransfer(String(raw.transferId ?? ""));
  } catch (err) {
    return toFormError(err);
  }
  // redirect() works by throwing, so it stays outside the try block.
  redirect("/store/transfers");
}
