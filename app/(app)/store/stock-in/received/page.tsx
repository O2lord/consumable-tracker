import Link from "next/link";
import { notFound } from "next/navigation";
import { requirePermission } from "@/server/auth/session";
import { getBatchSummary } from "@/server/services/labels.service";
import {
  linkButtonClass,
  pageSubtitleClass,
  pageTitleClass,
  panelClass,
  primaryLinkButtonClass,
  tableClass,
  tdClass,
  thClass,
} from "@/components/ui/styles";
import { describeRequestQuantity } from "@/lib/pack-size";
import { Pagination } from "@/components/ui/Pagination";
import { pageInfo, parsePage } from "@/lib/pagination";

export const metadata = { title: "Delivery received" };

/** Summary after a delivery with several items: one row per batch, each with its own labels. */
export default async function ReceivedBatchesPage({
  searchParams,
}: {
  searchParams: Promise<{ batches?: string; page?: string }>;
}) {
  await requirePermission("stock_in");
  const { batches, page } = await searchParams;
  const codes = [...new Set((batches ?? "").split(",").map((c) => c.trim()).filter(Boolean))];
  if (codes.length === 0) notFound();

  const info = pageInfo(parsePage(page), codes.length);
  const found = await Promise.all(codes.slice(info.offset, info.offset + info.pageSize).map((code) => getBatchSummary(code)));
  const rows = found.filter((b): b is NonNullable<typeof b> => !!b);
  if (rows.length === 0) notFound();

  return (
    <div className="flex flex-col gap-5">
      <div>
        <span className="inline-flex items-center gap-1.5 rounded-full bg-ok-soft px-2.5 py-0.5 text-xs font-semibold text-ok">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <path d="M3 8.5l3 3 7-7" />
          </svg>
          Stock recorded
        </span>
        <h1 className={`${pageTitleClass} mt-3`}>{codes.length} items received</h1>
        <p className={pageSubtitleClass}>
          Each item is its own batch with its own barcode label. Open a batch to print or download its labels.
        </p>
      </div>

      <section className={`${panelClass} overflow-x-auto`}>
        <table className={tableClass}>
          <thead>
            <tr>
              <th className={thClass}>Batch</th>
              <th className={thClass}>Item</th>
              <th className={`${thClass} text-left`}>Quantity</th>
              <th className={thClass}>Lot</th>
              <th className={thClass}>Expiry</th>
              <th className={`${thClass} text-right`}>
                <span className="sr-only">Labels</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((b) => (
              <tr key={b.code}>
                <td className={`${tdClass} font-mono text-[13px]`}>{b.code}</td>
                <td className={tdClass}>{b.itemName}</td>
                <td className={`${tdClass} text-left`}>
                  {b.trackingMode === "SERIAL" ? b.quantity : describeRequestQuantity(b.quantity, b.unit, false)}
                </td>
                <td className={tdClass}>{b.lotNo ?? "-"}</td>
                <td className={tdClass}>{b.expiryDate ?? "-"}</td>
                <td className={`${tdClass} text-right`}>
                  <Link href={`/store/stock-in/${b.code}`} className={linkButtonClass}>
                    Open labels
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <Pagination info={info} pathname="/store/stock-in/received" params={{ batches }} noun="items" />
      </section>

      <div className="flex flex-wrap items-center gap-6 text-sm font-semibold text-side-title">
        <Link href="/store/stock-in" className={primaryLinkButtonClass}>
          Receive another delivery
        </Link>
        <Link href="/store/label-check" className="underline">
          Check a printed label
        </Link>
      </div>
    </div>
  );
}
