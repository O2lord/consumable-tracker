import { requirePermission } from "@/server/auth/session";
import { listActiveLocations } from "@/server/services/catalog.service";
import { endOfDay, getReconciliation, isIsoDate, startOfDay } from "@/server/services/report.service";
import { tableClass, tdClass, thClass } from "@/components/ui/styles";
import { DatePicker } from "@/components/ui/DatePicker";
import { Select } from "@/components/ui/Dropdown";
import { PackEquivalent } from "@/components/ui/PackEquivalent";
import { StatCard } from "@/components/ui/StatCard";
import { Tag } from "@/components/ui/Tag";
import { Pagination } from "@/components/ui/Pagination";
import { pageOfArray, parsePage } from "@/lib/pagination";

export const metadata = { title: "Reconciliation" };

const DAY = 24 * 3600 * 1000;
const isoDay = (d: Date) => d.toISOString().slice(0, 10);

function defaultRange() {
  const now = new Date();
  return { from: isoDay(new Date(now.getTime() - 30 * DAY)), to: isoDay(now) };
}

export default async function ReconciliationPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string; location?: string; page?: string }>;
}) {
  await requirePermission("view_reports");
  const sp = await searchParams;
  const defaults = defaultRange();
  const from = isIsoDate(sp.from) ? sp.from : defaults.from;
  const to = isIsoDate(sp.to) ? sp.to : defaults.to;
  const locationId = sp.location || undefined;

  const [rows, locations] = await Promise.all([
    getReconciliation({ from: startOfDay(from), to: endOfDay(to), locationId }),
    listActiveLocations(),
  ]);
  const problems = rows.filter((r) => r.unaccounted !== null && r.unaccounted !== 0);
  const rowPage = pageOfArray(rows, parsePage(sp.page));

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-[22px] font-bold tracking-tight">Reconciliation</h1>
        <p className="mt-1 max-w-3xl text-sm text-zinc-500">
          For each location and item: what was on the shelf at the start, what came in and went out during the period,
          and what is there at the end. Everything is worked out from the ledger. Unaccounted is the units actually in
          stock now minus what the ledger says should be there; it should always be 0. Bulk items have no separate count
          to compare with, so they show n/a.
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

      <div className="grid gap-4 sm:grid-cols-2">
        <StatCard value={rows.length} label="location and item lines" />
        <StatCard value={problems.length} label="lines that do not add up" tone={problems.length > 0 ? "bad" : "ok"} />
      </div>

      {problems.length > 0 ? (
        <p className="max-w-3xl rounded-xl border border-bad bg-bad-soft p-3 text-sm">
          {problems.length} line{problems.length === 1 ? "" : "s"} below do not add up. See the exceptions report for the
          units concerned.
        </p>
      ) : null}

      <section className="overflow-x-auto rounded-xl border border-line bg-surface px-2 py-1">
        <table className={tableClass}>
          <thead>
            <tr>
              <th className={thClass}>Location</th>
              <th className={thClass}>Item</th>
              <th className={thClass}>Start</th>
              <th className={thClass}>Stocked</th>
              <th className={thClass}>Received</th>
              <th className={thClass}>Found</th>
              <th className={thClass}>Dispatched</th>
              <th className={thClass}>Issued</th>
              <th className={thClass}>Used at bench</th>
              <th className={thClass}>Returned used</th>
              <th className={thClass}>Restocked</th>
              <th className={thClass}>Voided / wasted</th>
              <th className={thClass}>Missing</th>
              <th className={thClass}>End</th>
              <th className={thClass}>Unaccounted</th>
            </tr>
          </thead>
          <tbody>
            {rowPage.rows.map((r) => (
              <tr key={`${r.locationId}-${r.itemTypeId}`}>
                <td className={tdClass}>{r.locationName}</td>
                <td className={tdClass}>
                  {r.itemName}
                  <span className="block text-xs text-zinc-500">{r.trackingMode === "SERIAL" ? "serialized" : "bulk"}</span>
                </td>
                <td className={tdClass}>
                  {r.opening}
                  <PackEquivalent quantity={r.opening} unit={r.unit} packSize={r.packSize} confirmed={r.packSizeConfirmed} />
                </td>
                <td className={tdClass}>{r.stocked}</td>
                <td className={tdClass}>{r.received}</td>
                <td className={tdClass}>{r.found}</td>
                <td className={tdClass}>{r.dispatched}</td>
                <td className={tdClass}>{r.issued}</td>
                <td className={tdClass}>{r.used}</td>
                <td className={tdClass}>{r.returnedUsed}</td>
                <td className={tdClass}>{r.restocked}</td>
                <td className={tdClass}>{r.voidedOrWasted}</td>
                <td className={tdClass}>{r.missing}</td>
                <td className={tdClass}>
                  {r.closing}
                  <PackEquivalent quantity={r.closing} unit={r.unit} packSize={r.packSize} confirmed={r.packSizeConfirmed} />
                </td>
                <td className={tdClass}>
                  {r.unaccounted === null ? (
                    "n/a"
                  ) : r.unaccounted === 0 ? (
                    <Tag tone="ok">0</Tag>
                  ) : (
                    <Tag tone="bad">{r.unaccounted}</Tag>
                  )}
                </td>
              </tr>
            ))}
            {rows.length === 0 ? (
              <tr>
                <td className={tdClass} colSpan={15}>
                  No movements recorded.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
        <Pagination
          info={rowPage}
          pathname="/reports/reconciliation"
          params={{ from, to, location: locationId }}
          noun="lines"
        />
      </section>
    </div>
  );
}
