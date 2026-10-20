"use client";

import { useState } from "react";
import { ActionForm } from "@/components/forms/ActionForm";
import { ScanSession } from "@/components/scanner/ScanSession";
import { Field } from "@/components/ui/Field";
import { Modal } from "@/components/ui/Modal";
import { ProgressDonut } from "@/components/ui/ProgressDonut";
import { inputClass } from "@/components/ui/styles";
import { partLetter } from "@/lib/part-letter";
import { describeHolding, isPackUnit } from "@/lib/pack-size";
import { isValidBatchCode, normalizeCode } from "@/lib/serial";
import type { FormState } from "@/components/forms/form-state";
import type { ScanOutcome } from "@/components/scanner/ScanFeedback";
import type { DispatchBatchInfo, DispatchScanResult } from "@/types/dispatch-scan";
import {
  lookupBatchAction,
  scanDispatchAction,
  sendWholePackAction,
  setQuantityAction,
  undoItemAction,
} from "./actions";

interface Props {
  transferId: string;
  code: string;
  fromName: string;
  toName: string;
  bottleCount: number;
  bulkTotal: number;
  /** Loose pieces on the draft, kept apart from `bulkTotal` (packs). */
  pieceTotal: number;
  bottles: { id: string; serial: string; itemName: string }[];
  bulk: { id: string; batchCode: string; itemName: string; quantity: number; inPieces: boolean }[];
}

const PREVIEW_ROWS = 5;

/** What the last scan meant: a box label means packs are being sent, a pack label on its own means pieces of it. */
type ScanMode = "packs" | "pieces";

const textButtonClass = "w-fit text-sm font-medium text-brand underline";

/**
 * The working part of a draft transfer. Scan a box label first, then the items you are sending out of it:
 *
 * - Bottles: scan each bottle. The count goes up with each scan, and a bottle from a different box is rejected.
 * - Packs and rolls: a box label means packs are being sent, so scan each pack. Each scan puts one whole pack on the
 *   draft, so it can be followed to the receiving store.
 * - Pieces: a pack label scanned on its own means pieces of that pack. Enter how many, or send the whole pack.
 *
 * Stock received before pack labels existed has no pack labels to scan, so it is still typed as a quantity.
 * Each box can go out in several parts to different places; the parts become A, B, C when the transfer is dispatched.
 * The Confirm dispatch bar lives under the item tables on the page, not in this pop-up.
 *
 * The pop-up is kept to one job at a time: a progress card for the current box or pack, the scan field, the last
 * result with Undo beside it, and one main button. The draft list folds away as "Scan history".
 */
export function DraftBuilder({
  transferId,
  code,
  bottleCount,
  bulkTotal,
  pieceTotal,
  bottles,
  bulk,
}: Props) {
  // The box or pack scanned last. Bottles are checked against it until the person is done with that box.
  const [active, setActive] = useState<DispatchBatchInfo | null>(null);
  const [mode, setMode] = useState<ScanMode>("packs");
  // Only for stock with no pack labels: which unit the typed quantity is in, whole packs or pieces.
  const [unit, setUnit] = useState<"stock" | "pieces">("stock");
  // Scanning happens in a pop-up so the draft stays tidy: the button below opens it.
  const [scanning, setScanning] = useState(false);
  // What happened when "Send whole pack" was used, since that does not go through the scan field.
  const [packNote, setPackNote] = useState<{ text: string; ok: boolean } | null>(null);

  const bottleBatch = active?.trackingMode === "SERIAL" ? active.batchCode : null;
  const bulkBatch = active?.trackingMode === "QUANTITY" ? active : null;
  // Pieces can be sent only from a pack item whose pack size is known (above 1).
  const piecesOk = bulkBatch ? bulkBatch.packSize > 1 && isPackUnit(bulkBatch.unit) : false;
  // No pack labels on this batch (received before they existed): nothing to scan, so the quantity is typed.
  const typedQuantity = bulkBatch !== null && !bulkBatch.hasPackLabels;
  // A box label was scanned: packs are being sent, so each pack is scanned onto the draft as one whole pack.
  const sendingPacks = bulkBatch !== null && bulkBatch.hasPackLabels && mode === "packs";
  // A pack was scanned on its own: pieces of it are being sent, or the whole pack.
  const sendingPieces = bulkBatch !== null && bulkBatch.hasPackLabels && mode === "pieces";
  const scannedPack = sendingPieces ? (bulkBatch?.pack ?? null) : null;
  // The quantity form: pieces of the scanned pack, or the typed quantity for stock with no pack labels.
  const piecesForm = scannedPack !== null && piecesOk;
  const formInPieces = piecesForm || (typedQuantity && piecesOk && unit === "pieces");
  const showForm = bulkBatch !== null && (typedQuantity || piecesForm);
  const piecesMax = bulkBatch
    ? scannedPack
      ? Math.min(bulkBatch.piecesAvailable, scannedPack.piecesLeft)
      : bulkBatch.piecesAvailable
    : 0;

  async function handleScan(value: string): Promise<DispatchScanResult> {
    const isBoxLabel = isValidBatchCode(normalizeCode(value));
    setPackNote(null);
    const result = await scanDispatchAction(transferId, code, value, bottleBatch, sendingPacks);
    if (result.batch) {
      setActive(result.batch);
      // A box label means packs. A pack that went on whole keeps it that way. A pack scanned on its own means pieces.
      setMode(isBoxLabel || result.undoId?.startsWith("pack:") ? "packs" : "pieces");
      setUnit(result.batch.onDraftPieces > 0 ? "pieces" : "stock");
    } else if (result.batchCount !== undefined) {
      const count = result.batchCount;
      setActive((prev) => (prev ? { ...prev, onDraft: count } : prev));
    }
    return result;
  }

  async function handleUndo(itemId: string): Promise<ScanOutcome> {
    const outcome = await undoItemAction(transferId, code, itemId);
    if (outcome.kind !== "error" && active) {
      const fresh = await lookupBatchAction(transferId, active.batchCode);
      if (fresh) setActive(fresh);
    }
    return outcome;
  }

  async function sendWhole(packCode: string) {
    setPackNote(null);
    const r = await sendWholePackAction(transferId, code, packCode);
    setPackNote({ text: r.message, ok: r.kind !== "error" });
    if (r.kind !== "error") {
      // The pack is on the draft, so the next scan starts fresh.
      setActive(null);
      setMode("packs");
    }
  }

  // Once the quantity is saved the form has done its job, so it goes away and only Confirm is left.
  async function handleAddQuantity(prev: FormState, formData: FormData): Promise<FormState> {
    const result = await setQuantityAction(prev, formData);
    if (!result.error) setActive(null);
    return result;
  }

  const draftCount = bulk.length + bottles.length;

  // Shown inside the progress card, or on its own when the card is not shown.
  const earlierNote = active?.earlierBatch ? (
    <p className="rounded-lg bg-warn-soft px-3 py-2 text-sm text-warn">
      Batch <span className="font-mono font-semibold">{active.earlierBatch.batchCode}</span> of this item expires
      sooner ({active.earlierBatch.expiryDate}
      {active.expiryDate ? ` instead of ${active.expiryDate}` : ", and this one has no expiry date"}) and still has{" "}
      {active.earlierBatch.available} available here. Consider sending that one first.
    </p>
  ) : null;

  let scanLabel = "Scan a box label, a pack label or a bottle label";
  if (active) {
    if (bottleBatch) scanLabel = "Scan the next bottle";
    else if (sendingPacks) scanLabel = "Scan the next pack or roll";
    else if (sendingPieces) scanLabel = "Scan the pack the pieces come from";
    else scanLabel = "Scan another box or bottle label";
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setScanning(true)}
        className="rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-brand-ink hover:brightness-95"
      >
        Start scan
      </button>

      {scanning ? (
        <Modal title="Scan items to send" onClose={() => setScanning(false)}>
          <div className="flex flex-col gap-5">
            {active && piecesForm ? (
              // A scanned pack with its pieces form below needs no card of its own: the scan result and the form say it all.
              earlierNote
            ) : active ? (
              <section className="flex flex-col gap-3 rounded-xl border border-line bg-page p-4">
                <div className="flex flex-wrap items-baseline justify-between gap-x-3 text-sm">
                  <span className="text-zinc-500">
                    {sendingPieces && active.pack ? "Current pack" : "Current box"} · {active.itemName}
                  </span>
                  <span className="font-mono font-semibold">
                    {sendingPieces && active.pack ? active.pack.code : active.batchCode}
                  </span>
                </div>
                {active.trackingMode === "SERIAL" ? (
                  <div className="flex items-center justify-between gap-4">
                    <div>
                      <div className="flex items-baseline gap-2">
                        <span className="text-5xl font-bold leading-none text-brand">{active.onDraft}</span>
                        <span className="text-base text-zinc-500">of {active.available} bottles scanned</span>
                      </div>
                      <p className="mt-2 text-xs text-muted">Part {partLetter(active.partsSent + 1)} if dispatched now</p>
                    </div>
                    <ProgressDonut done={active.onDraft} total={active.available} label="bottles scanned" />
                  </div>
                ) : sendingPacks ? (
                  <div className="flex flex-col gap-3">
                    <div className="flex items-center justify-between gap-4">
                      <div>
                        <div className="flex items-baseline gap-2">
                          <span className="text-5xl font-bold leading-none text-brand">{active.onDraft}</span>
                          <span className="text-base text-zinc-500">of {active.available} packs scanned</span>
                        </div>
                        <p className="mt-2 text-xs text-muted">
                          Scan each pack or roll you are sending · Part {partLetter(active.partsSent + 1)} if dispatched now
                        </p>
                      </div>
                      <ProgressDonut done={active.onDraft} total={active.available} label="packs scanned" />
                    </div>
                    {piecesOk ? (
                      <button type="button" onClick={() => setMode("pieces")} className={textButtonClass}>
                        Send pieces from a pack instead
                      </button>
                    ) : null}
                  </div>
                ) : sendingPieces ? (
                  <div className="flex flex-col gap-2">
                    {active.pack ? (
                      <>
                        <p className="text-base font-medium">
                          {piecesOk ? "Pieces from this pack" : "Send this pack whole"}
                        </p>
                        <p className="text-sm text-zinc-500">
                          {active.pack.piecesLeft} of {active.pack.piecesPerPack} pieces left.
                          {piecesOk ? " Enter how many pieces you are sending below." : ""}
                          {active.pack.onTransfer
                            ? " This pack is already on a transfer that has not been received."
                            : !active.pack.intact
                              ? " It has been opened, so it can only go as pieces."
                              : ""}
                        </p>
                        {active.pack.intact && !active.pack.onTransfer ? (
                          <button
                            type="button"
                            onClick={() => sendWhole(active.pack!.code)}
                            className="w-fit rounded-lg border border-line bg-surface px-3 py-1.5 text-sm font-medium hover:bg-brand-soft"
                          >
                            Send whole pack
                          </button>
                        ) : null}
                      </>
                    ) : (
                      <p className="text-base font-medium">Scan the pack the pieces come from</p>
                    )}
                    <button type="button" onClick={() => setMode("packs")} className={textButtonClass}>
                      Send whole packs instead
                    </button>
                  </div>
                ) : (
                  <div className="flex flex-col gap-1">
                    <p className="text-base font-medium">No pack labels on this stock: enter the quantity below</p>
                    {active.packSize > 1 && isPackUnit(active.unit) ? (
                      <p className="text-sm text-zinc-500">
                        Here: {describeHolding(active.available, active.looseAvailable)}
                        {active.looseAvailable > 0 ? " (loose pieces go first)" : ""}
                      </p>
                    ) : null}
                  </div>
                )}
                {earlierNote}
              </section>
            ) : (
              <p className="text-sm text-zinc-500">
                Scan the batch code on the box, then scan each bottle or pack you are sending. To send pieces, scan the
                pack on its own instead. Bottles scanned without a box are still accepted.
              </p>
            )}

            <ScanSession compact label={scanLabel} onScan={handleScan} onUndo={handleUndo} />

            {packNote ? (
              <p role="status" className={`text-sm ${packNote.ok ? "text-ok" : "text-bad"}`}>
                {packNote.text}
              </p>
            ) : null}

            {showForm && bulkBatch ? (
              <section className="rounded-xl border border-line bg-page p-4">
                <h2 className="mb-2 font-medium">{formInPieces ? "Pieces to send" : "Quantity to send"}</h2>
                <ActionForm action={handleAddQuantity} submitLabel={piecesForm ? "Add pieces" : "Add quantity"}>
                  <input type="hidden" name="transferId" value={transferId} />
                  <input type="hidden" name="code" value={code} />
                  <input type="hidden" name="batch" value={bulkBatch.batchCode} />
                  <input type="hidden" name="unit" value={formInPieces ? "pieces" : "stock"} />
                  <input type="hidden" name="pack" value={piecesForm ? (scannedPack?.code ?? "") : ""} />
                  {typedQuantity && piecesOk ? (
                    <div className="mb-2 flex gap-2" role="group" aria-label="Count in">
                      {(
                        [
                          ["stock", "Packs"],
                          ["pieces", "Pieces"],
                        ] as const
                      ).map(([value, label]) => (
                        <button
                          key={value}
                          type="button"
                          aria-pressed={unit === value}
                          onClick={() => setUnit(value)}
                          className={`rounded-lg border px-3 py-1 text-sm ${
                            unit === value ? "border-brand bg-brand-soft font-semibold" : "border-line bg-surface"
                          }`}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                  ) : null}
                  <Field
                    label={
                      piecesForm && scannedPack
                        ? `${bulkBatch.itemName}, pack ${scannedPack.code}`
                        : `${bulkBatch.itemName} (${bulkBatch.batchCode})`
                    }
                    hint={
                      formInPieces
                        ? piecesForm && scannedPack
                          ? `${scannedPack.piecesLeft} of ${scannedPack.piecesPerPack} pieces left in this pack.${
                              scannedPack.onTransfer
                                ? " It is already on a transfer that has not been received."
                                : !scannedPack.intact
                                  ? " It has been opened, so it can only go as pieces."
                                  : ""
                            } Adding the same batch again replaces its quantity.`
                          : `${bulkBatch.piecesAvailable.toLocaleString("en-GB")} pieces available. If the loose pieces run out, a pack is opened for the rest. Adding the same batch again replaces its quantity.`
                        : `${bulkBatch.available} available. Adding the same batch again replaces its quantity.`
                    }
                  >
                    <div className={piecesForm ? "flex flex-wrap items-center gap-2" : undefined}>
                      {piecesForm && scannedPack && scannedPack.intact && !scannedPack.onTransfer ? (
                        <button
                          type="button"
                          onClick={() => sendWhole(scannedPack.code)}
                          className="rounded-lg border border-line bg-surface px-3 py-2 text-sm font-medium hover:bg-brand-soft"
                        >
                          Send whole pack
                        </button>
                      ) : null}
                      <input
                        key={formInPieces ? "pieces" : "stock"}
                        name="quantity"
                        type="number"
                        min={1}
                        max={formInPieces ? piecesMax : bulkBatch.available}
                        step={1}
                        required
                        inputMode="numeric"
                        autoFocus
                        placeholder={piecesForm ? "Pieces" : undefined}
                        className={piecesForm ? `${inputClass} w-32` : inputClass}
                      />
                    </div>
                  </Field>
                </ActionForm>
              </section>
            ) : null}

            {draftCount > 0 ? (
              <details className="text-sm">
                <summary className="cursor-pointer text-brand underline">Scan history ({draftCount})</summary>
                <ul className="mt-2 flex flex-col gap-1 rounded-xl border border-line bg-page p-4">
                  {bulk.slice(0, PREVIEW_ROWS).map((b) => (
                    <li key={b.id} className="flex justify-between gap-3">
                      <span>
                        <span className="font-mono">{b.batchCode}</span> {b.itemName}
                      </span>
                      <span className="font-medium">
                        {b.quantity.toLocaleString("en-GB")}
                        {b.inPieces ? (b.quantity === 1 ? " piece" : " pieces") : ""}
                      </span>
                    </li>
                  ))}
                  {bottles.slice(0, PREVIEW_ROWS).map((b) => (
                    <li key={b.id} className="flex justify-between gap-3">
                      <span className="font-mono">{b.serial}</span>
                      <span className="text-zinc-500">{b.itemName}</span>
                    </li>
                  ))}
                  {bulk.length > PREVIEW_ROWS || bottles.length > PREVIEW_ROWS ? (
                    <li className="mt-1 text-zinc-500">The full list is on the transfer page after you close this.</li>
                  ) : null}
                </ul>
              </details>
            ) : null}

            <div className="flex items-center justify-between gap-3 border-t border-line pt-4">
              <p className="text-sm font-medium">
                Draft total: {bottleCount} bottle{bottleCount === 1 ? "" : "s"}
                {bulkTotal > 0 ? ` · ${bulkTotal} bulk unit${bulkTotal === 1 ? "" : "s"}` : ""}
                {pieceTotal > 0 ? ` · ${pieceTotal.toLocaleString("en-GB")} piece${pieceTotal === 1 ? "" : "s"}` : ""}
              </p>
              <button
                type="button"
                onClick={() => {
                  setActive(null);
                  setMode("packs");
                  setScanning(false);
                }}
                className="rounded-lg bg-brand px-5 py-3 text-base font-semibold text-brand-ink hover:brightness-95"
              >
                Done
              </button>
            </div>
          </div>
        </Modal>
      ) : null}
    </>
  );
}
