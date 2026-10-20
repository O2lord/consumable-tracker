import Link from "next/link";
import { notFound } from "next/navigation";
import { requirePermission } from "@/server/auth/session";
import { canWorkAtAnyLocation } from "@/server/auth/permissions";
import { findTransferByCode, getReceiptProgress } from "@/server/services/receive.service";
import { getTransferDetail } from "@/server/services/transfer.service";
import { TRANSFER_STATUS_LABEL } from "@/types/transfers";
import { canSwitchUnit, lineCountUnit } from "@/lib/pack-size";
import { tableClass, tdClass, thClass } from "@/components/ui/styles";
import { ColdStorageTag } from "@/components/ui/ColdStorageTag";
import { StatusIcon } from "@/components/ui/StatusIcon";
import { ReceiveSession } from "./ReceiveSession";

export const metadata = { title: "Receive transfer" };

const SERIAL_ROWS_SHOWN = 300;

export default async function ReceiveTransferPage({ params }: { params: Promise<{ code: string }> }) {
  const session = await requirePermission("receive");
  const { code } = await params;
  const found = await findTransferByCode(decodeURIComponent(code));
  // A transfer for another location looks the same as one that does not exist.
  if (!found || (!canWorkAtAnyLocation(session.role) && found.toLocationId !== session.homeLocationId)) notFound();

  if (found.status === "DISPATCHED") {
    return (
      <div className="flex max-w-xl flex-col gap-3">
        <h1 className="flex items-center gap-2 font-mono text-[22px] font-bold tracking-tight">
          {found.code}
          <StatusIcon status="DISPATCHED" />
        </h1>
        <p className="text-sm text-zinc-500">Carried by {found.carriedByName ?? "Not recorded"}</p>
        <p className="text-sm">This transfer has not been opened yet. Scan its slip to start receiving.</p>
        <Link href="/distribution/receive" className="text-sm underline">
          Back to receive
        </Link>
      </div>
    );
  }

  if (found.status === "RECEIVING") {
    const p = await getReceiptProgress(found.id);
    return (
      <div className="flex flex-col gap-4">
        <div>
          <p className="text-sm text-zinc-500">Being received</p>
          <h1 className="flex items-center gap-2 font-mono text-[22px] font-bold tracking-tight">
            {p.code}
            <StatusIcon status="RECEIVING" />
          </h1>
          <p className="mt-1 text-sm text-zinc-500">Carried by {p.carriedByName ?? "Not recorded"}</p>
        </div>
        <ReceiveSession
          transferId={p.transferId}
          code={p.code}
          userId={session.userId}
          serialExpected={p.serialExpected}
          serialScanned={p.serialScanned}
          unscannedByItem={p.unscannedByItem}
          packsOnSlip={p.packsOnSlip}
          packsReceived={p.packsReceived}
          quantityLines={p.quantityLines.map((l) => ({
            batchCode: l.batchCode,
            itemName: l.itemName,
            coldStorage: l.coldStorage,
            counted: l.counted,
            inPieces: l.inPieces,
            canSwitch: canSwitchUnit(l.unit, l.packSize),
            lineUnit: lineCountUnit(l.unit, l.inPieces),
            byScan: l.byScan,
            packsScanned: l.packsScanned,
          }))}
        />
      </div>
    );
  }

  // Closed, read-only summary. Drafts and cancelled transfers are not the receiver's business.
  if (found.status === "DRAFT" || found.status === "CANCELLED") notFound();
  const detail = await getTransferDetail(found.code);
  if (!detail) notFound();
  const missingSerials = detail.serialItems.filter((i) => !i.received);
  const shortBatches = detail.quantityItems.filter((i) => i.missing > 0);
  const receivedSerials = detail.serialItems.filter((i) => i.received);
  const receivedBatches = detail.quantityItems.filter((i) => (i.received ?? 0) > 0);
  // Whole units and loose pieces cannot be added together, so the heading counts them apart.
  const receivedPacks = receivedBatches.filter((i) => !i.inPieces).reduce((n, i) => n + (i.received ?? 0), 0);
  const receivedPieces = receivedBatches.filter((i) => i.inPieces).reduce((n, i) => n + (i.received ?? 0), 0);
  const receivedTotalText = [
    receivedPacks > 0 || receivedPieces === 0 ? String(receivedPacks) : null,
    receivedPieces > 0 ? `${receivedPieces.toLocaleString("en-GB")} ${receivedPieces === 1 ? "piece" : "pieces"}` : null,
  ]
    .filter(Boolean)
    .join(" and ");
  const withUnit = (n: number, inPieces: boolean) => (inPieces ? `${n.toLocaleString("en-GB")} ${n === 1 ? "piece" : "pieces"}` : String(n));

  return (
    <div className="flex max-w-2xl flex-col gap-4">
      <div>
        {found.status === "RECEIVED" ? null : (
          <p className="text-sm text-zinc-500">{TRANSFER_STATUS_LABEL[found.status] ?? found.status}</p>
        )}
        <h1 className="flex items-center gap-2 font-mono text-[22px] font-bold tracking-tight">
          {detail.transfer.code}
          <StatusIcon status={found.status} />
        </h1>
        <p className="mt-1 text-sm text-zinc-500">
          {detail.fromName} to {detail.toName}
        </p>
        <p className="text-sm text-zinc-500">Carried by {detail.transfer.carriedByName ?? "Not recorded"}</p>
      </div>

      {missingSerials.length === 0 && shortBatches.length === 0 ? (
        <p className="rounded-xl border border-ok bg-ok-soft p-3 text-sm">Everything on this transfer is accounted for.</p>
      ) : (
        <>
          {missingSerials.length > 0 ? (
            <section className="overflow-x-auto rounded-xl border border-line bg-surface px-2 py-1">
              <h2 className="mb-2 font-medium">Bottles reported missing ({missingSerials.length})</h2>
              <table className={tableClass}>
                <thead>
                  <tr>
                    <th className={thClass}>Serial</th>
                    <th className={thClass}>Item</th>
                    <th className={thClass}>Outcome</th>
                  </tr>
                </thead>
                <tbody>
                  {missingSerials.map((i) => (
                    <tr key={i.itemId}>
                      <td className={`${tdClass} font-mono`}>{i.serial}</td>
                      <td className={tdClass}>{i.itemName}</td>
                      <td className={tdClass}>
                        {i.resolution === "FOUND" ? "Found" : i.resolution === "WRITTEN_OFF" ? "Written off" : "Awaiting supervisor"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          ) : null}
          {shortBatches.length > 0 ? (
            <section className="overflow-x-auto rounded-xl border border-line bg-surface px-2 py-1">
              <h2 className="mb-2 font-medium">Short counts</h2>
              <table className={tableClass}>
                <thead>
                  <tr>
                    <th className={thClass}>Batch</th>
                    <th className={thClass}>Item</th>
                    <th className={thClass}>Sent</th>
                    <th className={thClass}>Counted</th>
                    <th className={thClass}>Short by</th>
                  </tr>
                </thead>
                <tbody>
                  {shortBatches.map((i) => (
                    <tr key={i.itemId}>
                      <td className={`${tdClass} font-mono`}>{i.batchCode}</td>
                      <td className={tdClass}>
                        {i.itemName}
                        <ColdStorageTag cold={i.coldStorage} />
                      </td>
                      <td className={tdClass}>{withUnit(i.dispatched, i.inPieces)}</td>
                      <td className={tdClass}>{withUnit(i.received ?? 0, i.inPieces)}</td>
                      <td className={tdClass}>{withUnit(i.missing, i.inPieces)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          ) : null}
        </>
      )}

      {receivedBatches.length > 0 ? (
        <section className="overflow-x-auto rounded-xl border border-line bg-surface px-2 py-1">
          <h2 className="mb-2 pt-2 font-medium">
            Bulk items received ({receivedTotalText})
          </h2>
          <table className={tableClass}>
            <thead>
              <tr>
                <th className={thClass}>Batch</th>
                <th className={thClass}>Item</th>
                <th className={thClass}>Sent</th>
                <th className={thClass}>Received</th>
              </tr>
            </thead>
            <tbody>
              {receivedBatches.map((i) => (
                <tr key={i.itemId}>
                  <td className={`${tdClass} font-mono`}>{i.batchCode}</td>
                  <td className={tdClass}>
                    {i.itemName}
                    <ColdStorageTag cold={i.coldStorage} />
                  </td>
                  <td className={tdClass}>{withUnit(i.dispatched, i.inPieces)}</td>
                  <td className={tdClass}>{withUnit(i.received ?? 0, i.inPieces)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : null}

      {receivedSerials.length > 0 ? (
        <section className="overflow-x-auto rounded-xl border border-line bg-surface px-2 py-1">
          <h2 className="mb-2 pt-2 font-medium">Bottles received ({receivedSerials.length})</h2>
          <table className={tableClass}>
            <thead>
              <tr>
                <th className={thClass}>Serial</th>
                <th className={thClass}>Item</th>
              </tr>
            </thead>
            <tbody>
              {receivedSerials.slice(0, SERIAL_ROWS_SHOWN).map((i) => (
                <tr key={i.itemId}>
                  <td className={`${tdClass} font-mono`}>{i.serial}</td>
                  <td className={tdClass}>{i.itemName}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {receivedSerials.length > SERIAL_ROWS_SHOWN ? (
            <p className="mt-2 text-sm text-zinc-500">
              Showing the first {SERIAL_ROWS_SHOWN} of {receivedSerials.length}.
            </p>
          ) : null}
        </section>
      ) : null}

      <Link href="/distribution/receive" className="text-sm underline">
        Back to receive
      </Link>
    </div>
  );
}
