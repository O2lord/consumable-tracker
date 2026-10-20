import Link from "next/link";
import { type ResolvedDiscrepancy, type ResolvedSummary } from "@/server/services/discrepancy.service";
import { StatCard } from "@/components/ui/StatCard";
import { Tag } from "@/components/ui/Tag";
import { Pagination } from "@/components/ui/Pagination";
import type { PageInfo } from "@/lib/pagination";
import { tableClass, tdClass, thClass } from "@/components/ui/styles";

interface Props {
  rows: ResolvedDiscrepancy[];
  /** Paging numbers for the rows shown. */
  info: PageInfo;
  /** Who carried the transfer and who resolved each one are only shown to roles that may see who was involved. */
  canSeePeople: boolean;
  /** May open the full bottle history report. */
  canSeeHistory: boolean;
  /** May open the transfer page. */
  canOpenTransfer: boolean;
  /** What the filter pop-up has applied, so the page can say what it is showing. */
  filters: { outcome?: "FOUND" | "WRITTEN_OFF"; from?: string; to?: string };
}

const when = (date: Date) => date.toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" });

/** "10 pieces" for a resolution of loose pieces, otherwise the bare number. */
function amount(n: number, inPieces: boolean): string {
  return inPieces ? `${n.toLocaleString("en-GB")} ${n === 1 ? "piece" : "pieces"}` : String(n);
}

/** Whole units and loose pieces cannot be added together, so a total shows them side by side: "4 + 30 pieces". */
function total(side: { units: number; pieces: number }): string {
  if (side.pieces === 0) return String(side.units);
  return side.units > 0 ? `${side.units} + ${amount(side.pieces, true)}` : amount(side.pieces, true);
}

/** The three count cards for the history tab, worked out over everything the filter matches, not just this page. */
export function HistoryStats({ summary }: { summary: ResolvedSummary }) {
  const writtenOffCount = summary.writtenOff.units + summary.writtenOff.pieces;
  return (
    <div className="grid gap-4 sm:grid-cols-3">
      <StatCard value={summary.total} label="resolutions" />
      <StatCard value={total(summary.found)} label="found, back in stock" tone="ok" />
      <StatCard value={total(summary.writtenOff)} label="written off" tone={writtenOffCount > 0 ? "bad" : "ok"} />
    </div>
  );
}

/** Every resolved discrepancy, with the outcome, the reason, who carried the transfer and who resolved it. */
export function ResolvedHistory({ rows, info, canSeePeople, canSeeHistory, canOpenTransfer, filters }: Props) {
  const filtered = Boolean(filters.outcome || filters.from || filters.to);
  const summary = [
    filters.outcome === "FOUND" ? "Found" : filters.outcome === "WRITTEN_OFF" ? "Written off" : null,
    filters.from ? `from ${filters.from}` : null,
    filters.to ? `to ${filters.to}` : null,
  ]
    .filter(Boolean)
    .join(", ");

  return (
    <div className="flex flex-col gap-3">
      {filtered ? <p className="text-sm text-zinc-500">Filtered: {summary}</p> : null}

      <section className="overflow-x-auto rounded-xl border border-line bg-surface px-2 py-1">
        <table className={tableClass}>
          <thead>
            <tr>
              <th className={thClass}>When</th>
              <th className={thClass}>Outcome</th>
              <th className={thClass}>Item</th>
              <th className={thClass}>Serial or batch</th>
              <th className={thClass}>Quantity</th>
              <th className={thClass}>Transfer</th>
              <th className={thClass}>Location</th>
              <th className={thClass}>Reason</th>
              {canSeePeople ? <th className={thClass}>Carried by</th> : null}
              {canSeePeople ? <th className={thClass}>Resolved by</th> : null}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.eventId}>
                <td className={tdClass}>{when(r.resolvedAt)}</td>
                <td className={tdClass}>
                  {r.outcome === "FOUND" ? <Tag tone="ok">Found</Tag> : <Tag tone="bad">Written off</Tag>}
                </td>
                <td className={tdClass}>{r.itemName ?? "-"}</td>
                <td className={`${tdClass} font-mono`}>
                  {r.serial && canSeeHistory ? (
                    <Link href={`/reports/bottle/${encodeURIComponent(r.serial)}`} className="underline" title="See this bottle's full history">
                      {r.serial}
                    </Link>
                  ) : (
                    (r.serial ?? r.batchCode ?? "-")
                  )}
                </td>
                <td className={tdClass}>{amount(r.quantity, r.inPieces)}</td>
                <td className={`${tdClass} font-mono`}>
                  {r.transferCode && canOpenTransfer ? (
                    <Link href={`/store/transfers/${r.transferCode}`} className="underline">
                      {r.transferCode}
                    </Link>
                  ) : (
                    (r.transferCode ?? "-")
                  )}
                </td>
                <td className={tdClass}>{r.locationName}</td>
                <td className={tdClass}>{r.reason ?? "-"}</td>
                {canSeePeople ? <td className={tdClass}>{r.carriedBy ?? "Not recorded"}</td> : null}
                {canSeePeople ? <td className={tdClass}>{r.resolvedBy}</td> : null}
              </tr>
            ))}
            {rows.length === 0 ? (
              <tr>
                <td className={tdClass} colSpan={canSeePeople ? 10 : 8}>
                  {filtered ? "Nothing matches these filters." : "Nothing has been resolved yet."}
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
        <Pagination
          info={info}
          pathname="/reports/discrepancies"
          params={{ tab: "history", outcome: filters.outcome, from: filters.from, to: filters.to }}
          noun="resolutions"
        />
      </section>
    </div>
  );
}
