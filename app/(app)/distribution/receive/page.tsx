import Link from "next/link";
import { requirePermission } from "@/server/auth/session";
import { canWorkAtAnyLocation } from "@/server/auth/permissions";
import { listTransfersPage } from "@/server/services/transfer.service";
import { TRANSFER_STATUS_LABEL } from "@/types/transfers";
import { tableClass, tdClass, thClass } from "@/components/ui/styles";
import { Pagination } from "@/components/ui/Pagination";
import { pageOfArray, parsePage } from "@/lib/pagination";
import { OpenReceipt } from "./OpenReceipt";
import { ReceiveTabs } from "./ReceiveTabs";

export const metadata = { title: "Receive" };

export default async function ReceivePage({
  searchParams,
}: {
  searchParams: Promise<{ ppage?: string; rpage?: string }>;
}) {
  const session = await requirePermission("receive");
  const sp = await searchParams;
  const anywhere = canWorkAtAnyLocation(session.role);
  const noLocation = !anywhere && !session.homeLocationId;
  const toLocationId = anywhere ? undefined : (session.homeLocationId as string);

  const [pendingPage, receivedPage] = noLocation
    ? [pageOfArray([], 1), pageOfArray([], 1)]
    : await Promise.all([
        listTransfersPage({ statuses: ["DISPATCHED", "RECEIVING"], toLocationId }, parsePage(sp.ppage)),
        listTransfersPage(
          { statuses: ["RECEIVED", "RECEIVED_WITH_DISCREPANCY", "DISCREPANCY_RESOLVED"], toLocationId },
          parsePage(sp.rpage),
        ),
      ]);
  const pending = pendingPage.rows;
  const received = receivedPage.rows;

  const header = (
    <>
      <h1 className="text-[22px] font-bold tracking-tight">Receive</h1>
      <p className="mt-1 text-sm text-zinc-500">
        Scan the barcode on the transfer slip, then scan every bottle and count every bulk batch.
      </p>
    </>
  );

  return (
    <div className="flex flex-col gap-6">
      {noLocation ? (
        <>
          <div>{header}</div>
          <p className="max-w-xl rounded-xl border border-line bg-surface p-4 text-sm">
            Your account has no home location, so you cannot receive stock. Ask an admin to set it.
          </p>
        </>
      ) : (
        <OpenReceipt header={header} userId={session.userId} />
      )}

      <ReceiveTabs
        pendingCount={pendingPage.total}
        receivedCount={receivedPage.total}
        initialTab={sp.rpage && !sp.ppage ? "received" : "pending"}
        pending={
      <section className="overflow-x-auto rounded-xl border border-line bg-surface px-2 py-1">
        <table className={tableClass}>
          <thead>
            <tr>
              <th className={thClass}>Transfer</th>
              <th className={thClass}>Status</th>
              <th className={thClass}>From</th>
              {anywhere ? <th className={thClass}>To</th> : null}
              <th className={thClass}>Dispatched</th>
            </tr>
          </thead>
          <tbody>
            {pending.map((t) => (
              <tr key={t.id}>
                <td className={tdClass}>
                  {t.status === "RECEIVING" ? (
                    <Link href={`/distribution/receive/${t.code}`} className="font-mono underline">
                      {t.code}
                    </Link>
                  ) : (
                    <span className="font-mono">{t.code}</span>
                  )}
                </td>
                <td className={tdClass}>{TRANSFER_STATUS_LABEL[t.status] ?? t.status}</td>
                <td className={tdClass}>{t.fromName}</td>
                {anywhere ? <td className={tdClass}>{t.toName}</td> : null}
                <td className={tdClass}>{t.dispatchedAt ? t.dispatchedAt.toLocaleString("en-GB") : "-"}</td>
              </tr>
            ))}
            {pending.length === 0 ? (
              <tr>
                <td className={tdClass} colSpan={anywhere ? 5 : 4}>
                  Nothing is waiting.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
        <p className="mt-2 text-xs text-zinc-500">A transfer that is on its way opens when its slip is scanned.</p>
        <Pagination
          info={pendingPage}
          pathname="/distribution/receive"
          params={{ rpage: sp.rpage }}
          param="ppage"
          noun="transfers"
        />
      </section>
        }
        received={
      <section className="overflow-x-auto rounded-xl border border-line bg-surface px-2 py-1">
        <table className={tableClass}>
          <thead>
            <tr>
              <th className={thClass}>Transfer</th>
              <th className={thClass}>Status</th>
              <th className={thClass}>From</th>
              {anywhere ? <th className={thClass}>To</th> : null}
              <th className={thClass}>Items</th>
              <th className={thClass}>Received</th>
            </tr>
          </thead>
          <tbody>
            {received.map((t) => (
              <tr key={t.id}>
                <td className={tdClass}>
                  <Link href={`/distribution/receive/${t.code}`} className="font-mono underline">
                    {t.code}
                  </Link>
                </td>
                <td className={tdClass}>{TRANSFER_STATUS_LABEL[t.status] ?? t.status}</td>
                <td className={tdClass}>{t.fromName}</td>
                {anywhere ? <td className={tdClass}>{t.toName}</td> : null}
                <td className={tdClass}>
                  {[t.serialCount ? `${t.serialCount} bottle${t.serialCount === 1 ? "" : "s"}` : "", t.quantityTotal ? `${t.quantityTotal} bulk` : ""]
                    .filter(Boolean)
                    .join(", ") || "-"}
                </td>
                <td className={tdClass}>{t.receivedAt ? t.receivedAt.toLocaleString("en-GB") : "-"}</td>
              </tr>
            ))}
            {received.length === 0 ? (
              <tr>
                <td className={tdClass} colSpan={anywhere ? 6 : 5}>
                  Nothing has been received yet.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
        <p className="mt-2 text-xs text-zinc-500">Open one to see what was scanned and what was missing.</p>
        <Pagination
          info={receivedPage}
          pathname="/distribution/receive"
          params={{ ppage: sp.ppage }}
          param="rpage"
          noun="transfers"
        />
      </section>
        }
      />
    </div>
  );
}
