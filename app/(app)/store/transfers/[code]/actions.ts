"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requirePermission } from "@/server/auth/session";
import {
  addCartonToDraft,
  addUnitToTransfer,
  addWholePackToDraft,
  cancelTransfer,
  confirmTransfer,
  lookupBatchForDispatch,
  removeCartonFromDraft,
  removeAllTransferItems,
  removeTransferItem,
  removeWholePackFromDraft,
  setBatchQuantity,
} from "@/server/services/transfer.service";
import { toFormError } from "@/server/actions/form-result";
import { toScanError } from "@/server/actions/scan-result";
import { formDataToObject } from "@/lib/form";
import { isValidBatchCode, isValidCartonCode, isValidPackCode, normalizeCode } from "@/lib/serial";
import { partLetter } from "@/lib/part-letter";
import { describeHolding, isPackUnit } from "@/lib/pack-size";
import type { FormState } from "@/components/forms/form-state";
import type { ScanOutcome } from "@/components/scanner/ScanFeedback";
import type { DispatchBatchInfo, DispatchScanResult } from "@/types/dispatch-scan";

const refresh = (code: string) => revalidatePath(`/store/transfers/${code}`);

/**
 * Puts one scanned pack or roll on the draft as a whole pack (for bottles, every bottle in it). The batch comes back
 * with it, so the screen keeps its counts right and follows the pack to its own carton or batch if that is not the one
 * that was open.
 */
async function addWholePack(transferId: string, code: string, packCode: string): Promise<DispatchScanResult> {
  const w = await addWholePackToDraft(transferId, packCode);
  refresh(code);
  // Stay on the pack's carton when it has one, so the carton's progress keeps counting.
  const batch = await lookupBatchForDispatch(transferId, w.cartonCode ?? w.result.batchCode);
  if (w.kind === "packs") {
    const r = w.result;
    return {
      kind: "ok",
      message: `Added pack ${r.packCode}, ${r.itemName} (${r.quantity} ${r.quantity === 1 ? "pack" : "packs"} on the draft)`,
      undoId: `pack:${r.packCode}`,
      batchCount: r.quantity,
      batch,
    };
  }
  const r = w.result;
  return {
    kind: "ok",
    message: `Added pack ${r.code}, ${r.itemName} (${r.added} ${r.added === 1 ? "bottle" : "bottles"})`,
    undoId: `pack:${r.code}`,
    batch,
  };
}

/** "Send whole carton": every bottle (or pack) in the scanned carton goes on the draft in one go. */
export async function sendWholeCartonAction(transferId: string, code: string, cartonCode: string): Promise<DispatchScanResult> {
  await requirePermission("dispatch");
  try {
    const r = await addCartonToDraft(transferId, cartonCode);
    refresh(code);
    const noun = r.contents === "bottles" ? (r.added === 1 ? "bottle" : "bottles") : r.added === 1 ? "pack" : "packs";
    return {
      kind: "ok",
      message: `Added carton ${r.code}, ${r.itemName} (${r.added.toLocaleString("en-GB")} ${noun}). Scan the next carton, or press Done`,
      undoId: `carton:${r.code}`,
    };
  } catch (err) {
    return toScanError(err);
  }
}

/**
 * One scan on the dispatch screen. The labels nest: box (BT...) > carton (CN...) > pack or roll (PK...) > bottle (CT...).
 *
 * - A box label picks the batch. If it came in cartons the person is asked for the carton they are sending.
 * - A carton label asks whether the whole carton goes, or only some of its packs.
 * - A pack or roll label scanned on its own asks whether the whole pack goes, or only pieces of it.
 * - A bottle label goes on the draft, and when a box (or a pack) is active the bottle must belong to it.
 *
 * With `wholePacks` on (the person chose to send packs, so each pack is scanned), a pack or roll label goes on the
 * draft as one whole pack, so its location can follow it to the receiving store. Otherwise it only selects that pack.
 * `activePack` is set when the person chose to send bottles out of one pack: bottles from any other pack are refused.
 */
export async function scanDispatchAction(
  transferId: string,
  code: string,
  value: string,
  activeBatch: string | null,
  wholePacks = false,
  activePack: string | null = null,
): Promise<DispatchScanResult> {
  await requirePermission("dispatch");
  try {
    if (wholePacks && isValidPackCode(value)) return await addWholePack(transferId, code, value);
    if (isValidBatchCode(normalizeCode(value)) || isValidPackCode(value) || isValidCartonCode(value)) {
      const info = await lookupBatchForDispatch(transferId, value);
      const next = partLetter(info.partsSent + 1);

      if (info.carton) {
        // A carton label: whole carton, or packs out of it. The screen shows the two buttons.
        const c = info.carton;
        const noun = c.contents === "bottles" ? "bottles" : "packs";
        if (c.total === 0) return { kind: "error", message: `Carton ${c.code} has nothing recorded in it` };
        if (c.onDraft === c.total) return { kind: "duplicate", message: `Carton ${c.code} is already on this draft`, batch: info };
        if (c.avail === 0) {
          return { kind: "error", message: `Nothing from carton ${c.code} is free in this store, so it cannot be sent from here` };
        }
        const choice = !c.intact
          ? `Only ${c.avail} of ${c.total} ${noun} are free here, so it cannot go whole. ${c.packLabels > 0 ? "Scan the packs you are sending" : "Scan the bottles you are sending"}`
          : c.packLabels > 0
            ? "Send the whole carton, or choose packs from it"
            : "Send the whole carton";
        const holds =
          c.packLabels > 0
            ? `${c.packsTotal.toLocaleString("en-GB")} ${c.packsTotal === 1 ? "pack" : "packs"} (${c.total.toLocaleString("en-GB")} ${noun})`
            : `${c.total.toLocaleString("en-GB")} ${noun}`;
        return {
          kind: "ok",
          message: `Carton ${c.code}: ${info.itemName}, ${holds}. ${choice} (part ${next})`,
          batch: info,
        };
      }

      // A pack that is not in the sending store cannot be sent from here, whether as pieces or whole.
      if (isValidPackCode(value) && info.trackingMode === "QUANTITY" && !info.pack) {
        return { kind: "error", message: `Pack ${normalizeCode(value)} is not in the sending store, so it cannot be sent from here` };
      }
      if (info.pack ? info.pack.piecesLeft === 0 : info.available === 0) {
        return {
          kind: "error",
          message: info.pack
            ? `Pack ${info.pack.code} has no ${info.trackingMode === "SERIAL" ? "bottles" : "pieces"} left to send`
            : `No ${info.itemName} from batch ${info.batchCode} is free in this store`,
        };
      }
      const piecesOk = info.packSize > 1 && isPackUnit(info.unit);
      let message: string;
      if (info.pack && info.trackingMode === "SERIAL") {
        // A pack of bottles scanned on its own: the whole pack, or just some of its bottles.
        const p = info.pack;
        message = p.intact && !p.onTransfer
          ? `Pack ${p.code}: ${p.piecesLeft} bottles. Send the whole pack, or scan the bottles you are sending from it (part ${next})`
          : p.onTransfer
            ? `Pack ${p.code} is already on a transfer that has not been received`
            : `Pack ${p.code}: ${p.piecesLeft} of ${p.piecesPerPack} bottles left. It has been opened, so scan the bottles you are sending from it (part ${next})`;
      } else if (info.trackingMode === "SERIAL") {
        message =
          info.cartonCount > 0
            ? `Box ${info.batchCode}: ${info.itemName}, ${info.cartonCount} ${info.cartonCount === 1 ? "carton" : "cartons"}, ${info.cartonsOnDraft} on this draft. Scan the carton you are sending, or scan bottles one by one (part ${next})`
            : `Box ${info.batchCode}: ${info.itemName}, ${info.available} here, ${info.onDraft} on this draft. Scan the bottles you are sending (part ${next})`;
      } else if (info.pack) {
        // A pack scanned on its own: pieces from it, or the whole pack when it is still sealed.
        const p = info.pack;
        message = piecesOk
          ? `Pack ${p.code}: ${p.piecesLeft} of ${p.piecesPerPack} pieces left. Enter how many pieces you are sending${p.intact ? ", or send the whole pack" : ". It has been opened, so it can only go as pieces"} (part ${next})`
          : `Pack ${p.code}: ${info.itemName}. Send the whole pack (part ${next})`;
      } else if (info.hasPackLabels) {
        // A box label: if it came in cartons the carton is scanned next, otherwise each pack is.
        message =
          info.cartonCount > 0
            ? `Box ${info.batchCode}: ${info.itemName}, ${info.cartonCount} ${info.cartonCount === 1 ? "carton" : "cartons"}, ${info.cartonsOnDraft} on this draft. Scan the carton you are sending (part ${next})`
            : `Box ${info.batchCode}: ${info.itemName}, ${info.available} ${info.available === 1 ? "pack" : "packs"} here. Scan each pack you are sending (part ${next})`;
      } else {
        // Stock received before pack labels existed has no pack labels to scan, so it is still typed.
        message =
          info.packSize > 1
            ? `Box ${info.batchCode}: ${info.itemName}, ${describeHolding(info.available, info.looseAvailable)} available. This stock has no pack labels: enter the quantity below, in packs or pieces (part ${next})`
            : `Box ${info.batchCode}: ${info.itemName}, ${info.available} available. Enter the quantity below (part ${next})`;
      }
      return { kind: "ok", message, batch: info };
    }

    const r = await addUnitToTransfer(transferId, value, undefined, activeBatch ?? undefined, activePack ?? undefined);
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
    // A whole pack or carton that was added in one go is undone by its code; anything else by its line id.
    let message: string;
    if (itemId.startsWith("carton:")) {
      const counts = await removeCartonFromDraft(transferId, itemId.slice("carton:".length));
      message = `Carton removed from the draft. ${counts.serialCount} bottles on the draft`;
    } else if (itemId.startsWith("pack:")) {
      await removeWholePackFromDraft(transferId, itemId.slice("pack:".length));
      message = "Pack removed from the draft";
    } else {
      const counts = await removeTransferItem(transferId, itemId);
      message = `Removed. ${counts.serialCount} bottles on the draft`;
    }
    refresh(code);
    return { kind: "ok", message };
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

/** "Remove all" on the transfer page: clears every bottle line, or every bulk line, from the draft. */
export async function removeAllItemsAction(_prev: FormState, formData: FormData): Promise<FormState> {
  await requirePermission("dispatch");
  const raw = formDataToObject(formData);
  const code = String(raw.code ?? "");
  const scope = String(raw.scope ?? "") === "bulk" ? "bulk" : "bottles";
  try {
    const removed = await removeAllTransferItems(String(raw.transferId ?? ""), scope);
    refresh(code);
    if (removed === 0) return { message: "Nothing to remove" };
    return {
      message:
        scope === "bottles"
          ? `Removed ${removed.toLocaleString("en-GB")} ${removed === 1 ? "bottle" : "bottles"} from the draft`
          : `Removed ${removed.toLocaleString("en-GB")} bulk ${removed === 1 ? "line" : "lines"} from the draft`,
    };
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
