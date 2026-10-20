import { requirePermission } from "@/server/auth/session";
import { COUNT_REASON_LABEL } from "@/server/domain/stock-count-rules";
import { listActiveLocations } from "@/server/services/catalog.service";
import { endOfDay, isIsoDate, startOfDay } from "@/server/services/report.service";
import { listCountVariances } from "@/server/services/stock-count.service";
import { DatePicker } from "@/components/ui/DatePicker";
import { Select } from "@/components/ui/Dropdown";
import { PackEquivalent } from "@/components/ui/PackEquivalent";
import { StatCard } from "@/components/ui/StatCard";
import { Tag } from "@/components/ui/Tag";
import { tableClass, tdClass, thClass } from "@/components/ui/styles";
import { Pagination } from "@/components/ui/Pagination";
import { pageOfArray, parsePage } from "@/lib/pagination";

export const metadata = { title: "Count variances" };

const DAY = 24 * 3600 * 1000;
const isoDay = (d: Date) => d.toISOString().slice(0, 10);
const when = (d: Date) => d.toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" });

export default async function CountVariancesPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string; location?: string; page?: string }>;
}) {
  await requirePermission("view_reports");
  const sp = await searchParams;
  const now = new Date();
  const from = isIsoDate(sp.from) ? sp.from : isoDay(new Date(now.getTime() - 90 * DAY));
  const to = isIsoDate(sp.to) ? sp.to : isoDay(now);
  const locationId = sp.location || undefined;

  const [report, locations] = await Promise.all([
    listCountVariances({ from: startOfDay(from), to: endOfDay(to), locationId }),
    listActiveLocations(),
  ]);
  const differences = report.rows.filter((r) => r.variance !== 0);
  const differencePage = pageOfArray(differences, parsePage(sp.page));

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-[22px] font-bold tracking-tight">Count variances</h1>
        <p className="mt-1 max-w-3xl text-sm text-zinc-500">
          Posted stock counts: what was counted against what the ledger expected, per location and batch, with the reason
          given for each difference. Short means less on the shelf than expected; over means more. Each difference was
          written to the ledger as an adjustment when the count was posted.
        </p>
      </div>

      <form method="get" className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1 text-sm font-medium">
          <span>From</span>
          <DatePicker name="from" defaultValue={from} ariaLabel="From date" required />
        </div>
        <div className="flex flex-col gap-1 text-sm font-medium">
          <span>To</span>
          <DatePicker name="to" defaultValue={to} ariaLabel="To date" required />
        </div>
        <div className="flex flex-col gap-1 text-sm font-medium">
          <span>Location</span>
          <div className="w-52">
            <Select
              name="location"
              ariaLabel="Location"
              emptyLabel="All locations"
              defaultValue={locationId ?? ""}
              options={locations.map((l) => ({ value: l.id, label: l.name }))}
            />
          </div>
        </div>
        <button type="submit" className="rounded-lg border border-line bg-surface px-4 py-2 text-sm font-medium hover:bg-brand-soft">
          Show
        </button>
      </form>

      <div className="grid gap-4 sm:grid-cols-3 lg:grid-cols-6">
        <StatCard value={report.linesCounted} label="figures counted" />
        <StatCard value={report.linesWithVariance} label="figures that differed" tone={report.linesWithVariance > 0 ? "bad" : "ok"} />
        <StatCard value={report.unitsShort} label="units short" tone={report.unitsShort > 0 ? "bad" : "ok"} />
        <StatCard value={report.unitsOver} label="units over" />
        <StatCard value={report.piecesShort} label="loose pieces short" tone={report.piecesShort > 0 ? "bad" : "ok"} />
        <StatCard value={report.piecesOver} label="loose pieces over" />
      </div>

      <section className="overflow-x-auto rounded-xl border border-line bg-surface px-2 py-1">
        <table className={tableClass}>
          <thead>
            <tr>
              <th className={thClass}>Posted</th>
              <th className={thClass}>Location</th>
              <th className={thClass}>Item</th>
              <th className={thClass}>Batch</th>
              <th className={thClass}>Counted</th>
              <th className={thClass}>Expected</th>
              <th className={thClass}>Difference</th>
              <th className={thClass}>Reason</th>
              <th className={thClass}>Counted by</th>
            </tr>
          </thead>
          <tbody>
            {differencePage.rows.map((r) => (
              <tr key={`${r.countId}|${r.batchCode}|${r.kind}`}>
                <td className={tdClass}>{when(r.postedAt)}</td>
                <td className={tdClass}>{r.locationName}</td>
                <td className={tdClass}>
                  {r.itemName}
                  {r.kind === "PIECES" ? <span className="block text-xs text-zinc-500">Loose pieces</span> : null}
                </td>
                <td className={`${tdClass} font-mono`}>{r.batchCode}</td>
                <td className={tdClass}>
                  {r.counted}
                  {r.kind === "PACKS" ? (
                    <PackEquivalent quantity={r.counted} unit={r.unit} packSize={r.packSize} confirmed={r.packSizeConfirmed} />
                  ) : null}
                </td>
                <td className={tdClass}>
                  {r.expected}
                  {r.kind === "PACKS" ? (
                    <PackEquivalent quantity={r.expected} unit={r.unit} packSize={r.packSize} confirmed={r.packSizeConfirmed} />
                  ) : null}
                </td>
                <td className={tdClass}>
                  <Tag tone="bad">
                    {r.variance > 0 ? "+" : ""}
                    {r.variance}
                  </Tag>
                </td>
                <td className={tdClass}>
                  {r.reasonCode ? (COUNT_REASON_LABEL[r.reasonCode as keyof typeof COUNT_REASON_LABEL] ?? r.reasonCode) : "-"}
                  {r.note ? <span className="block text-xs text-zinc-500">{r.note}</span> : null}
                </td>
                <td className={tdClass}>{r.countedByName}</td>
              </tr>
            ))}
            {differences.length === 0 ? (
              <tr>
                <td className={tdClass} colSpan={9}>
                  {report.linesCounted === 0
                    ? "No counts were posted in this period."
                    : "Every counted line matched what the ledger expected."}
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
        <Pagination
          info={differencePage}
          pathname="/reports/stock-counts"
          params={{ from, to, location: locationId }}
          noun="differences"
        />
      </section>
    </div>
  );
}
