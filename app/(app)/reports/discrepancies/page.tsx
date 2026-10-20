import Link from "next/link";
import { requirePermission } from "@/server/auth/session";
import { can } from "@/server/auth/permissions";
import { listActiveLocations } from "@/server/services/catalog.service";
import {
  listOpenDiscrepancies,
  listResolvedDiscrepanciesPage,
  type OpenDiscrepancy,
} from "@/server/services/discrepancy.service";
import { endOfDay, isIsoDate, startOfDay } from "@/server/services/report.service";
import { tableClass, tabClass, tdClass, thClass } from "@/components/ui/styles";
import { StatCard } from "@/components/ui/StatCard";
import { Tag } from "@/components/ui/Tag";
import { Pagination } from "@/components/ui/Pagination";
import { pageOfArray, parsePage } from "@/lib/pagination";
import { HistoryFilter } from "./HistoryFilter";
import { HistoryStats, ResolvedHistory } from "./ResolvedHistory";
import { TraceButton } from "./TraceButton";

export const metadata = { title: "Discrepancies" };

/** A quantity worded for people: "10 pieces" when the line is counted in loose pieces, otherwise the bare number. */
function amount(n: number, inPieces: boolean): string {
  return inPieces ? `${n.toLocaleString("en-GB")} ${n === 1 ? "piece" : "pieces"}` : String(n);
}

export default async function DiscrepanciesPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string; outcome?: string; from?: string; to?: string; page?: string }>;
}) {
  const session = await requirePermission("view_discrepancies");
  const sp = await searchParams;
  const tab = sp.tab === "history" ? "history" : "open";
  const outcome = sp.outcome === "FOUND" || sp.outcome === "WRITTEN_OFF" ? sp.outcome : undefined;
  const from = isIsoDate(sp.from) ? sp.from : undefined;
  const to = isIsoDate(sp.to) ? sp.to : undefined;
  const canResolve = can(session.role, "resolve_discrepancy");
  const canSeePeople = can(session.role, "view_discrepancy_people");
  const canSeeHistory = can(session.role, "view_reports");

  const page = parsePage(sp.page);
  const rows = await listOpenDiscrepancies();
  const history =
    tab === "history"
      ? await listResolvedDiscrepanciesPage(
          {
            outcome,
            from: from ? startOfDay(from) : undefined,
            to: to ? endOfDay(to) : undefined,
          },
          page,
        )
      : null;
  const locations = canResolve ? await listActiveLocations() : [];

  const byTransfer = new Map<string, OpenDiscrepancy[]>();
  for (const r of rows) byTransfer.set(r.transferCode, [...(byTransfer.get(r.transferCode) ?? []), r]);
  // The open list pages by transfer, so one transfer's lines always stay together on one page.
  const transferPage = pageOfArray([...byTransfer.entries()], page);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-[22px] font-bold tracking-tight">{tab === "history" ? "Discrepancy history" : "Open discrepancies"}</h1>
        <p className="mt-1 text-sm text-zinc-500">
          {tab === "history"
            ? "Every missing bottle or bulk item that has been resolved, as found or written off, with the reason."
            : `Bottles and bulk items that were sent but not received. ${canResolve ? "Resolve each one as found or written off, with a reason." : "A supervisor resolves these."}`}
        </p>
      </div>

      {history ? (
        <HistoryStats summary={history.summary} />
      ) : (
        <div className="grid gap-4 sm:grid-cols-3">
          <StatCard value={rows.length} label="open items" tone={rows.length > 0 ? "bad" : "ok"} />
          <StatCard value={rows.filter((r) => r.serial !== null).length} label="missing bottles" tone={rows.some((r) => r.serial !== null) ? "bad" : "ok"} />
          <StatCard value={byTransfer.size} label="transfers affected" tone={byTransfer.size > 0 ? "warn" : "ok"} />
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <nav aria-label="Discrepancy views" className="flex gap-1 overflow-x-auto rounded-xl bg-[var(--track)] p-1">
          <Link href="/reports/discrepancies" aria-current={tab === "open" ? "page" : undefined} className={tabClass(tab === "open")}>
            Open ({rows.length})
          </Link>
          <Link
            href="/reports/discrepancies?tab=history"
            aria-current={tab === "history" ? "page" : undefined}
            className={tabClass(tab === "history")}
          >
            History
          </Link>
        </nav>
        {tab === "history" ? <HistoryFilter filters={{ outcome, from, to }} /> : null}
      </div>

      {history ? (
        <ResolvedHistory
          rows={history.rows}
          info={history}
          canSeePeople={canSeePeople}
          canSeeHistory={canSeeHistory}
          canOpenTransfer={can(session.role, "dispatch")}
          filters={{ outcome, from, to }}
        />
      ) : rows.length === 0 ? (
        <p className="max-w-xl rounded-xl border border-ok bg-ok-soft p-4 text-sm">Nothing is outstanding.</p>
      ) : (
        <>
          {transferPage.rows.map(([code, items]) => (
          <section key={code} className="overflow-x-auto rounded-xl border border-line bg-surface px-2 py-1">
            <h2 className="mb-1 font-medium">
              {can(session.role, "dispatch") ? (
                <Link href={`/store/transfers/${code}`} className="font-mono underline" title="Open this transfer">
                  {code}
                </Link>
              ) : (
                <span className="font-mono">{code}</span>
              )}
              <span className="ml-2 text-sm font-normal text-zinc-500">
                {items[0].fromLocationName} to {items[0].toLocationName}
              </span>
            </h2>
            <table className={tableClass}>
              <thead>
                <tr>
                  <th className={thClass}>Item</th>
                  <th className={thClass}>Serial or batch</th>
                  <th className={thClass}>Sent</th>
                  <th className={thClass}>Received</th>
                  <th className={thClass}>Still missing</th>
                  <th className={thClass}>Trace</th>
                </tr>
              </thead>
              <tbody>
                {items.map((r) => (
                  <tr key={r.transferItemId}>
                    <td className={tdClass}>{r.itemName}</td>
                    <td className={`${tdClass} font-mono`}>
                      {r.serial !== null && canSeeHistory ? (
                        <Link href={`/reports/bottle/${encodeURIComponent(r.serial)}`} className="underline" title="See this bottle's full history">
                          {r.serial}
                        </Link>
                      ) : r.serial === null && canSeeHistory ? (
                        <Link href={`/reports/batch/${encodeURIComponent(r.batchCode)}`} className="underline" title="See this batch">
                          {r.batchCode}
                        </Link>
                      ) : (
                        (r.serial ?? r.batchCode)
                      )}
                    </td>
                    <td className={tdClass}>{amount(r.dispatched, r.inPieces)}</td>
                    <td className={tdClass}>{amount(r.received, r.inPieces)}</td>
                    <td className={tdClass}>
                      {amount(r.outstanding, r.inPieces)} {r.serial !== null ? <Tag tone="bad">Missing</Tag> : <Tag tone="warn">Count short</Tag>}
                    </td>
                    <td className={tdClass}>
                      <TraceButton
                        item={{
                          transferItemId: r.transferItemId,
                          transferId: r.transferId,
                          transferCode: r.transferCode,
                          serial: r.serial,
                          batchCode: r.batchCode,
                          itemName: r.itemName,
                          fromName: r.fromLocationName,
                          toName: r.toLocationName,
                          outstanding: r.outstanding,
                          inPieces: r.inPieces,
                        }}
                        canResolve={canResolve}
                        canSeeHistory={canSeeHistory}
                        otherLocations={locations.filter((l) => l.name !== r.toLocationName).map((l) => ({ id: l.id, name: l.name }))}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
          ))}
          <Pagination info={transferPage} pathname="/reports/discrepancies" noun="transfers" />
        </>
      )}
    </div>
  );
}
