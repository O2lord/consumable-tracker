"use client";

import { useCallback, useState, type FormEvent, type ReactNode } from "react";
import { ActionForm } from "@/components/forms/ActionForm";
import { FormDialog, useFormDialog } from "@/components/forms/FormDialog";
import { ScanSession } from "@/components/scanner/ScanSession";
import { ProgressDonut } from "@/components/ui/ProgressDonut";
import { inputClass } from "@/components/ui/styles";
import type { CountUnit } from "@/lib/pack-size";
import { isValidPackCode } from "@/lib/serial";
import { submitScan } from "@/offline/sync";
import { useSyncState } from "@/offline/use-sync-state";
import { CountUnitSelect } from "./CountUnitSelect";
import {
  closeReceiptAction,
  countQuantityAction,
  getReceiptViewAction,
  openReceiptAction,
  receivePackAction,
  type ReceiptView,
} from "./actions";

/**
 * "Scan transfer slip" opens a pop-up that does the whole receiving job without leaving the page:
 * scan the slip, scan each bottle, count each bulk batch blind, then close the receipt.
 *
 * Leaving the pop-up any other way is safe. Every scan and count is saved as it happens and the
 * receipt stays open, so it carries on from /distribution/receive/<code> or by scanning the slip again.
 */
export function OpenReceipt({ header, userId }: { header: ReactNode; userId: string }) {
  return (
    <FormDialog buttonLabel="Scan transfer slip" title="Receive a transfer" header={header}>
      <ReceiveFlow userId={userId} />
    </FormDialog>
  );
}

function ReceiveFlow({ userId }: { userId: string }) {
  const [view, setView] = useState<ReceiptView | null>(null);

  if (!view) {
    return (
      <ScanSession
        compact
        label="Scan the barcode on the transfer slip"
        onScan={async (value) => {
          const result = await openReceiptAction(value);
          if (result.kind === "ok" && result.view) setView(result.view);
          return result;
        }}
      />
    );
  }
  return <Receiving view={view} onView={setView} userId={userId} />;
}

function Receiving({ view, onView, userId }: { view: ReceiptView; onView: (v: ReceiptView) => void; userId: string }) {
  const dialog = useFormDialog();
  const sync = useSyncState();
  const { transferId, code, serialExpected, serialScanned, unscannedByItem, packsOnSlip, packsReceived, quantityLines } = view;

  const refresh = useCallback(async () => {
    try {
      const fresh = await getReceiptViewAction(transferId);
      if (fresh) onView(fresh);
    } catch {
      // Offline: the numbers below already include scans waiting on this device.
    }
  }, [transferId, onView]);

  // Lines sent pack by pack are received by scanning each pack in, so only the others need a typed count.
  const scanLines = quantityLines.filter((l) => l.byScan);
  const typedLines = quantityLines.filter((l) => !l.byScan);
  const uncounted = typedLines.filter((l) => l.counted === null).length;
  // Packs scanned in so far, by item. Only the item name is shown, never a batch code.
  const packsByItem = Array.from(
    scanLines.reduce((m, l) => m.set(l.itemName, (m.get(l.itemName) ?? 0) + l.packsScanned), new Map<string, number>()),
  );
  const waitingHere = sync.events.filter((e) => e.status === "PENDING" && e.transferId === transferId);
  const shownScanned = Math.min(serialExpected, serialScanned + waitingHere.length);
  const missing = Math.max(0, serialExpected - shownScanned);
  const anyWaiting = sync.summary.pending > 0;
  const canClose = sync.online && !anyWaiting && uncounted === 0;

  let status = "";
  if (!sync.online) status = "Offline. Keep scanning; closing needs a connection.";
  else if (anyWaiting) status = `${sync.summary.pending} scan(s) not sent yet. Closing opens once they are.`;
  else if (uncounted > 0) status = `${uncounted} bulk batch(es) still need a count.`;
  else if (missing > 0) status = `${missing} bottle(s) not scanned will be reported missing.`;

  return (
    <div className="flex flex-col gap-5">
      {serialExpected > 0 ? (
        <section className="flex flex-col gap-3 rounded-xl border border-line bg-page p-4">
          <div className="flex flex-wrap items-baseline justify-between gap-x-3 text-sm">
            <span className="text-zinc-500">Receiving</span>
            <span className="font-mono font-semibold">{code}</span>
          </div>
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-baseline gap-2">
              <span className="text-5xl font-bold leading-none text-brand">{shownScanned}</span>
              <span className="text-base text-zinc-500">of {serialExpected} bottles scanned</span>
            </div>
            <ProgressDonut done={shownScanned} total={serialExpected} label="bottles scanned" />
          </div>
        </section>
      ) : (
        <p className="text-sm text-zinc-500">
          Receiving <span className="font-mono font-semibold text-ink">{code}</span>
        </p>
      )}

      {packsOnSlip ? (
        <div className="flex flex-col gap-2">
          <p className="text-sm text-zinc-500">
            {packsReceived} pack{packsReceived === 1 ? "" : "s"} scanned in so far.
            {typedLines.length > 0 ? " Batches sent by number or as loose pieces are counted below." : ""} Any pack you do
            not scan is reported missing when you close.
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

      {serialExpected > 0 || packsOnSlip ? (
        <ScanSession
          compact
          label={
            serialExpected > 0 && packsOnSlip
              ? "Scan a bottle, pack or roll label"
              : packsOnSlip
                ? "Scan the next pack or roll"
                : "Scan the next bottle"
          }
          onScan={(value) =>
            // Pack and roll labels are checked on the server straight away; bottles are saved on this device first.
            isValidPackCode(value)
              ? receivePackAction(transferId, code, value)
              : submitScan({ transferId, transferCode: code, serial: value, userId })
          }
          onChanged={refresh}
        />
      ) : null}

      {typedLines.length > 0 ? (
        <section className="flex flex-col gap-2">
          <h2 className="text-sm font-medium">Bulk items: count what arrived</h2>
          <p className="text-xs text-zinc-500">
            Count the boxes first. Enter 0 if none of a batch arrived.
            {sync.online ? "" : " Saving a count needs a connection."}
          </p>
          {typedLines.map((line) => (
            <CountRow
              key={line.batchCode}
              transferId={transferId}
              code={code}
              batchCode={line.batchCode}
              itemName={line.itemName}
              counted={line.counted}
              inPieces={line.inPieces}
              canSwitch={line.canSwitch}
              lineUnit={line.lineUnit}
              onSaved={refresh}
            />
          ))}
        </section>
      ) : null}

      {missing > 0 ? (
        <details className="text-sm">
          <summary className="cursor-pointer text-brand underline">Not scanned yet ({missing})</summary>
          <ul className="mt-2 flex flex-col gap-1 rounded-xl border border-line bg-page p-4">
            {unscannedByItem.map((u) => (
              <li key={u.itemName} className="flex justify-between gap-3">
                <span>{u.itemName}</span>
                <span className="font-medium">{u.count}</span>
              </li>
            ))}
            {waitingHere.length > 0 ? (
              <li className="mt-1 text-zinc-500">The list updates once the scans saved on this device are sent.</li>
            ) : null}
          </ul>
        </details>
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4">
        <p className="min-w-0 flex-1 basis-48 text-sm text-zinc-500">
          {status || "Everything is scanned and counted."}
        </p>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => dialog?.succeeded("")}
            className="rounded-lg border border-line bg-surface px-4 py-3 text-base font-medium text-ink hover:bg-brand-soft"
          >
            Save and exit
          </button>
          <ActionForm
            action={closeReceiptAction}
            submitLabel="Close receipt"
            resetOnSuccess={false}
            className="flex"
            disabled={!canClose}
            buttonClassName="rounded-lg bg-brand px-5 py-3 text-base font-semibold text-brand-ink hover:brightness-95 disabled:opacity-50"
            confirm="Close the receipt? Anything not scanned or counted short will be reported as a discrepancy. This cannot be undone."
          >
            <input type="hidden" name="transferId" value={transferId} />
            <input type="hidden" name="code" value={code} />
          </ActionForm>
        </div>
      </div>
    </div>
  );
}

/**
 * One bulk batch: type what was counted and save. This is a plain form, not ActionForm, because a saved
 * ActionForm closes the pop-up it sits in and the receiver still has more to do.
 */
function CountRow({
  transferId,
  code,
  batchCode,
  itemName,
  counted,
  inPieces,
  canSwitch,
  lineUnit,
  onSaved,
}: {
  transferId: string;
  code: string;
  batchCode: string;
  itemName: string;
  counted: number | null;
  /** This line was sent as loose pieces, so the count is a number of pieces, not packs. */
  inPieces: boolean;
  /** The receiver can count this batch in packs or pieces. */
  canSwitch: boolean;
  /** The unit the line was sent in: the default choice, and the unit the saved count is shown in. */
  lineUnit: CountUnit;
  onSaved: () => Promise<void>;
}) {
  const [value, setValue] = useState(counted === null ? "" : String(counted));
  const [countedIn, setCountedIn] = useState<CountUnit>(lineUnit);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const data = new FormData();
    data.set("transferId", transferId);
    data.set("code", code);
    data.set("batch", batchCode);
    data.set("counted", value);
    if (canSwitch) data.set("countedIn", countedIn);
    try {
      const result = await countQuantityAction({}, data);
      if (result.error) setError(result.error);
      else await onSaved();
    } catch {
      setError("Could not save the count. Check the connection and try again");
    }
    setBusy(false);
  }

  // The saved count is held in the unit the line was sent in, so that is the word shown beside it.
  const savedWord = canSwitch ? lineUnit : inPieces ? "pieces" : null;
  const savedUnit = savedWord === null ? "" : savedWord === "pieces" ? (counted === 1 ? " piece" : " pieces") : counted === 1 ? " pack" : " packs";

  return (
    <form onSubmit={save} className="flex flex-col gap-2 rounded-xl border border-line bg-page p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 text-sm">
        <span>{itemName}</span>
        {counted !== null ? (
          <span className="font-medium text-ok">
            Counted: {counted}
            {savedUnit}
          </span>
        ) : null}
      </div>
      {canSwitch ? (
        <p className="text-xs text-zinc-500">Choose Packs or Pieces to match how you counted.</p>
      ) : inPieces ? (
        <p className="text-xs text-zinc-500">Sent as loose pieces: count the pieces, not the packs.</p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="number"
          min={0}
          step={1}
          required
          inputMode="numeric"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          aria-label={`Counted ${canSwitch ? countedIn === "pieces" ? "pieces" : "packs" : inPieces ? "pieces" : "quantity"} for ${batchCode}`}
          className={`${inputClass} w-32`}
        />
        {canSwitch ? (
          <CountUnitSelect batchCode={batchCode} defaultValue={lineUnit} value={countedIn} onChange={setCountedIn} />
        ) : inPieces ? (
          <span className="text-sm text-muted">pieces</span>
        ) : null}
        <button
          type="submit"
          disabled={busy}
          className="rounded-lg border border-line bg-surface px-4 py-2.5 text-sm font-medium text-ink hover:bg-brand-soft disabled:opacity-60"
        >
          {busy ? "Saving..." : counted === null ? "Save count" : "Change count"}
        </button>
      </div>
      {error ? (
        <p role="alert" className="text-sm text-bad">
          {error}
        </p>
      ) : null}
    </form>
  );
}
