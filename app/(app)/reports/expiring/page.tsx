import Link from "next/link";
import { requirePermission } from "@/server/auth/session";
import { EXPIRY_WINDOWS, listExpiringStock } from "@/server/services/report.service";
import { PackEquivalent } from "@/components/ui/PackEquivalent";
import { Tag } from "@/components/ui/Tag";
import { tableClass, tabClass, tdClass, thClass } from "@/components/ui/styles";
import { Pagination } from "@/components/ui/Pagination";
import { pageOfArray, parsePage } from "@/lib/pagination";

export const metadata = { title: "Expiring stock" };

type WindowDays = (typeof EXPIRY_WINDOWS)[number];

function parseWindow(value: string | undefined): WindowDays {
  const n = Number(value);
  return (EXPIRY_WINDOWS as readonly number[]).includes(n) ? (n as WindowDays) : 30;
}

export default async function ExpiringStockPage({
  searchParams,
}: {
  searchParams: Promise<{ days?: string; page?: string }>;
}) {
  await requirePermission("view_reports");
  const { days, page } = await searchParams;
  const window = parseWindow(days);
  const rows = await listExpiringStock(window);
  const expired = rows.filter((r) => r.daysLeft < 0).length;
  const rowPage = pageOfArray(rows, parsePage(page));

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-[22px] font-bold tracking-tight">Expiring stock</h1>
        <p className="mt-1 max-w-3xl text-sm text-zinc-500">
          Stock on the shelf at each location that expires within the chosen window, soonest first. Stock that has
          already expired is listed too: it is blocked from dispatch and issue, but someone should take it off the
          shelf. Bottles already issued to a patient are not counted.
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <nav aria-label="Expiry window" className="flex gap-1 overflow-x-auto rounded-xl bg-[var(--track)] p-1">
            {EXPIRY_WINDOWS.map((d) => (
              <Link
                key={d}
                href={`/reports/expiring?days=${d}`}
                aria-current={d === window ? "page" : undefined}
                className={tabClass(d === window)}
              >
                Within {d} days
              </Link>
            ))}
          </nav>
          <span className="text-sm text-zinc-500">
            {rows.length} {rows.length === 1 ? "line" : "lines"}
            {expired > 0 ? `, ${expired} already expired` : ""}
          </span>
        </div>
      </div>

      <section className="overflow-x-auto rounded-xl border border-line bg-surface px-2 py-1">
        <table className={tableClass}>
          <thead>
            <tr>
              <th className={thClass}>Expires</th>
              <th className={thClass}>Status</th>
              <th className={thClass}>Item</th>
              <th className={thClass}>Batch</th>
              <th className={thClass}>Location</th>
              <th className={thClass}>On shelf</th>
            </tr>
          </thead>
          <tbody>
            {rowPage.rows.map((r) => (
              <tr key={`${r.locationName}|${r.batchCode}`}>
                <td className={tdClass}>{r.expiryDate}</td>
                <td className={tdClass}>
                  {r.daysLeft < 0 ? (
                    <Tag tone="bad">Expired {-r.daysLeft} {r.daysLeft === -1 ? "day" : "days"} ago</Tag>
                  ) : r.daysLeft === 0 ? (
                    <Tag tone="warn">Expires today</Tag>
                  ) : (
                    <Tag tone="warn">
                      {r.daysLeft} {r.daysLeft === 1 ? "day" : "days"} left
                    </Tag>
                  )}
                </td>
                <td className={tdClass}>{r.itemName}</td>
                <td className={`${tdClass} font-mono`}>{r.batchCode}</td>
                <td className={tdClass}>{r.locationName}</td>
                <td className={tdClass}>
                  {r.quantity}
                  <PackEquivalent quantity={r.quantity} unit={r.unit} packSize={r.packSize} confirmed={r.packSizeConfirmed} />
                </td>
              </tr>
            ))}
            {rows.length === 0 ? (
              <tr>
                <td className={tdClass} colSpan={6}>
                  Nothing on the shelf expires within {window} days.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
        <Pagination info={rowPage} pathname="/reports/expiring" params={{ days: String(window) }} noun="lines" />
      </section>
    </div>
  );
}
