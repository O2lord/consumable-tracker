"use client";

import { useRouter } from "next/navigation";
import { ActionForm } from "@/components/forms/ActionForm";
import { ScanSession } from "@/components/scanner/ScanSession";
import { ColdStorageTag } from "@/components/ui/ColdStorageTag";
import { ProgressRing } from "@/components/ui/ProgressRing";
import { cardClass, inputClass } from "@/components/ui/styles";
import type { CountUnit } from "@/lib/pack-size";
import { isValidPackCode } from "@/lib/serial";
import { submitScan } from "@/offline/sync";
import { useSyncState } from "@/offline/use-sync-state";
import { closeReceiptAction, countQuantityAction, receivePackAction } from "../actions";
import { CountUnitSelect } from "../CountUnitSelect";

export interface QuantityLine {
  batchCode: string;
  itemName: string;
  /** Shows a "Keep cold" tag. Display only. */
  coldStorage: boolean;
  /** null until someone has counted it. The expected quantity is never sent to this screen. */
  counted: number | null;
  /** Sent as loose pieces: the count is a number of pieces, not packs. */
  inPieces: boolean;
  /** The receiver can count this batch in packs or pieces. */
  canSwitch: boolean;
  /** The unit the line was sent in: the default choice, and the unit the saved count is shown in. */
  lineUnit: CountUnit;
  /** Every pack of this line was scanned when it was sent, so it is received by scanning each pack in. */
  byScan: boolean;
  /** Packs of this line scanned in so far. Never the number sent: counts stay blind. */
  packsScanned: number;
}

interface Props {
  transferId: string;
  code: string;
  /** Who is scanning. Scans queued on this device are only ever sent under this person's sign-in. */
  userId: string;
  serialExpected: number;
  serialScanned: number;
  /** How many bottles of each item are still unscanned. Never their codes, so they cannot be copied into the scan box. */
  unscannedByItem: { itemName: string; count: number }[];
  /** Whole packs were scanned one by one when this transfer was sent, so their labels can be scanned in here. */
  packsOnSlip: boolean;
  /** Packs scanned in so far. Never the number sent: counts stay blind. */
  packsReceived: number;
  quantityLines: QuantityLine[];
}

/**
 * Receiving: scan each bottle, count each bulk batch blind, then close.
 * Bottle scans are saved on this device first and sent to the server, so scanning carries on through a
 * dropped connection and nothing is lost or counted twice. Counting bulk items and closing the receipt
 * need the connection, and closing waits until every scan on this device has been sent.
 */
export function ReceiveSession({
  transferId,
  code,
  userId,
  serialExpected,
  serialScanned,
  unscannedByItem,
  packsOnSlip,
  packsReceived,
  quantityLines,
}: Props) {
  const router = useRouter();
  const sync = useSyncState();

  // Lines sent pack by pack are received by scanning each pack in, so only the others need a typed count.
  const scanLines = quantityLines.filter((l) => l.byScan);
  const typedLines = quantityLines.filter((l) => !l.byScan);
  const uncounted = typedLines.filter((l) => l.counted === null).length;
  const waitingHere = sync.events.filter((e) => e.status === "PENDING" && e.transferId === transferId);
  const shownScanned = Math.min(serialExpected, serialScanned + waitingHere.length);
  const notScanned = Math.max(0, serialExpected - shownScanned);
  const anyWaiting = sync.summary.pending > 0;
  const canClose = sync.online && !anyWaiting;
  // One scanner for everything: it works out from the label whether it is a bottle or a pack or roll.
  const scanLabel =
    serialExpected > 0 && packsOnSlip
      ? "Scan a bottle, pack or roll label"
      : packsOnSlip
        ? "Scan a pack or roll label"
        : "Scan a bottle label";
  // Packs scanned in so far, by item. Only the item name is shown, never a batch code.
  const packsByItem = Array.from(
    scanLines.reduce((m, l) => m.set(l.itemName, (m.get(l.itemName) ?? 0) + l.packsScanned), new Map<string, number>()),
  );

  return (
    <div className="flex max-w-2xl flex-col gap-6">
      {serialExpected > 0 || packsOnSlip ? (
        <section className={`flex flex-col gap-3 ${cardClass}`}>
          <h2 className="font-semibold">Scan what arrived</h2>
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
            {serialExpected > 0 ? <ProgressRing value={shownScanned} total={serialExpected} /> : null}
            <div className="flex min-w-0 flex-1 flex-col gap-2">
              {waitingHere.length > 0 ? (
                <p className="text-sm text-brand">
                  {waitingHere.length} saved on this device and not yet sent. They are checked when the connection returns.
                </p>
              ) : null}
              <ScanSession
                label={scanLabel}
                onScan={(value) =>
                  // Pack and roll labels are checked on the server straight away; bottles are saved on this device first.
                  isValidPackCode(value)
                    ? receivePackAction(transferId, code, value)
                    : submitScan({ transferId, transferCode: code, serial: value, userId })
                }
                onChanged={() => router.refresh()}
              />
            </div>
          </div>
          {packsOnSlip ? (
            <div className="flex flex-col gap-2">
              <p className="text-sm text-zinc-500">
                {packsReceived} pack{packsReceived === 1 ? "" : "s"} scanned in so far.
                {typedLines.length > 0 ? " Batches sent by number or as loose pieces are counted below." : ""} Any pack you
                do not scan is reported missing when you close.
              </p>
              {packsByItem.length > 0 ? (
                <ul className="flex flex-col gap-1 text-sm">
                  {packsByItem.map(([name, scanned]) => (
                    <li
                      key={name}
                      className="flex justify-between gap-3 rounded-lg border border-line bg-page px-3 py-2"
                    >
                      <span>{name}</span>
                      <span className="font-medium text-ok">{scanned} scanned in</span>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}
          {notScanned > 0 ? (
            <details className="text-sm">
              <summary className="cursor-pointer">Not scanned yet ({notScanned})</summary>
              <ul className="mt-2 flex flex-col gap-1">
                {unscannedByItem.map((u) => (
                  <li key={u.itemName} className="flex justify-between gap-3">
                    <span>{u.itemName}</span>
                    <span className="font-medium">{u.count}</span>
                  </li>
                ))}
              </ul>
              {waitingHere.length > 0 ? (
                <p className="mt-1 text-zinc-500">The list updates once the scans saved on this device are sent.</p>
              ) : null}
            </details>
          ) : null}
        </section>
      ) : null}

      {typedLines.length > 0 ? (
        <section className={`flex flex-col gap-3 ${cardClass}`}>
          <h2 className="font-semibold">Bulk items: count what arrived</h2>
          <p className="text-sm text-zinc-500">
            Count the boxes first. Enter 0 if none of a batch arrived.
            {sync.online ? "" : " Saving a count needs a connection, so wait until you are back online."}
          </p>
          {typedLines.map((line) => (
            <div key={line.batchCode} className="rounded-lg border border-line bg-page p-3">
              <p className="text-sm">
                <span className="font-mono">{line.batchCode}</span> {line.itemName}
                <ColdStorageTag cold={line.coldStorage} />
                {line.counted !== null ? (
                  <span className="ml-2 text-green-700">
                    counted: {line.counted}
                    {line.canSwitch
                      ? line.lineUnit === "pieces"
                        ? line.counted === 1 ? " piece" : " pieces"
                        : line.counted === 1 ? " pack" : " packs"
                      : line.inPieces ? (line.counted === 1 ? " piece" : " pieces") : ""}
                  </span>
                ) : null}
              </p>
              {line.canSwitch ? (
                <p className="mt-1 text-xs text-zinc-500">Choose Packs or Pieces to match how you counted.</p>
              ) : line.inPieces ? (
                <p className="mt-1 text-xs text-zinc-500">Sent as loose pieces: count the pieces, not the packs.</p>
              ) : null}
              <ActionForm
                action={countQuantityAction}
                submitLabel={line.counted === null ? "Save count" : "Change count"}
                resetOnSuccess={false}
                className="mt-2 flex flex-wrap items-center gap-2"
                compact
              >
                <input type="hidden" name="transferId" value={transferId} />
                <input type="hidden" name="code" value={code} />
                <input type="hidden" name="batch" value={line.batchCode} />
                <input
                  name="counted"
                  type="number"
                  min={0}
                  step={1}
                  required
                  inputMode="numeric"
                  defaultValue={line.counted ?? undefined}
                  aria-label={`Counted quantity for ${line.batchCode}`}
                  className={`${inputClass} w-28`}
                />
                {line.canSwitch ? (
                  <CountUnitSelect batchCode={line.batchCode} defaultValue={line.lineUnit} />
                ) : line.inPieces ? (
                  <span className="text-sm text-muted">pieces</span>
                ) : null}
              </ActionForm>
            </div>
          ))}
        </section>
      ) : null}

      <section className={cardClass}>
        <h2 className="mb-1 font-semibold">Close the receipt</h2>
        {canClose ? (
          <>
            <p className="mb-3 text-sm text-zinc-500">
              {serialExpected - serialScanned > 0
                ? `${serialExpected - serialScanned} bottle(s) have not been scanned and will be reported missing. `
                : ""}
              {uncounted > 0 ? `${uncounted} bulk batch(es) still need a count before you can close.` : ""}
            </p>
            <ActionForm
              action={closeReceiptAction}
              submitLabel="Close receipt"
              resetOnSuccess={false}
              confirm="Close the receipt? Anything not scanned or counted short will be reported as a discrepancy. This cannot be undone."
            >
              <input type="hidden" name="transferId" value={transferId} />
              <input type="hidden" name="code" value={code} />
            </ActionForm>
          </>
        ) : (
          <p className="text-sm text-zinc-500">
            {sync.online
              ? `${sync.summary.pending} scan(s) saved on this device have not been sent yet. Closing is available once they are, so nothing is wrongly reported missing.`
              : "You are offline. Closing the receipt needs a connection; keep scanning and close it once you are back online."}
          </p>
        )}
      </section>
    </div>
  );
}
