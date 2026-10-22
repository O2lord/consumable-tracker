import Link from "next/link";
import { notFound } from "next/navigation";
import { requirePermission } from "@/server/auth/session";
import { getDeliveryByCode } from "@/server/services/delivery.service";
import {
  linkButtonClass,
  monoChipClass,
  pageSubtitleClass,
  pageTitleClass,
  panelClass,
  tableClass,
  tdClass,
  thClass,
} from "@/components/ui/styles";
import { describeRequestQuantity } from "@/lib/pack-size";
import { LabelButtons } from "../../LabelButtons";

export const metadata = { title: "Delivery received" };

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="text-xs font-semibold uppercase tracking-wide text-muted">{label}</div>
      <div className="mt-0.5 break-words text-[15px] font-medium text-ink">{children}</div>
    </div>
  );
}

/** One delivery: who brought it, where it went, and every item line with a link to its labels. */
export default async function DeliveryPage({ params }: { params: Promise<{ code: string }> }) {
  await requirePermission("stock_in");
  const { code } = await params;
  const delivery = await getDeliveryByCode(code);
  if (!delivery) notFound();

  const received = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short" }).format(
    delivery.receivedAt,
  );
  const count = delivery.lines.length;

  return (
    <div className="flex flex-col gap-5">
      <div>
        <Link
          href="/store/stock-in"
          className="mb-4 flex w-fit items-center gap-1.5 text-sm font-semibold text-side-title hover:underline"
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <path d="M10 3L5 8l5 5" />
          </svg>
          Back
        </Link>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <h1 className={pageTitleClass}>
            Delivery <span className="font-mono">{delivery.code}</span>
          </h1>
          <span className="inline-flex items-center gap-1.5 rounded-full bg-ok-soft px-2.5 py-0.5 text-xs font-semibold text-ok">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <path d="M3 8.5l3 3 7-7" />
            </svg>
            Stock recorded
          </span>
          <LabelButtons delivery={delivery.code} only="delivery" label="Print label to printer" single />
        </div>
        <p className={pageSubtitleClass}>
          {count} {count === 1 ? "item" : "items"} received together. Each item keeps its own lot, expiry and barcode
          label.
        </p>
      </div>

      <section className={`${panelClass} flex flex-col gap-5 lg:flex-row lg:items-stretch lg:gap-8`}>
        <div className="grid flex-1 content-start gap-x-8 gap-y-5 sm:grid-cols-2">
          <Detail label="Supplier">{delivery.supplier ?? "-"}</Detail>
          <Detail label="Received into">{delivery.locationName}</Detail>
          <Detail label="Received by">{delivery.receivedByName}</Detail>
          <Detail label="Received">{received}</Detail>
          {delivery.reference ? (
            <div className="sm:col-span-2">
              <Detail label="Invoice or delivery note">{delivery.reference}</Detail>
            </div>
          ) : null}
        </div>

        <div className="flex flex-col gap-3 lg:w-72 lg:shrink-0">
          <LabelButtons delivery={delivery.code} only="batches" label="Print batch labels" stacked />
        </div>
      </section>

      <section className={`${panelClass} flex flex-col gap-3`}>
        <h2 className="text-[17px] font-semibold">
          Items received <span className="font-normal text-muted">({count})</span>
        </h2>
        <div className="overflow-x-auto">
          <table className={tableClass}>
            <thead>
              <tr>
                <th className={thClass}>Item</th>
                <th className={`${thClass} text-left`}>Quantity</th>
                <th className={thClass}>Lot</th>
                <th className={thClass}>Expiry</th>
                <th className={thClass}>Batch</th>
                <th className={`${thClass} text-right`}>
                  <span className="sr-only">Labels</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {delivery.lines.map((l) => (
                <tr key={l.batchCode}>
                  <td className={`${tdClass} font-medium`}>{l.itemName}</td>
                  <td className={`${tdClass} text-left`}>
                    {l.trackingMode === "SERIAL" ? l.quantity : describeRequestQuantity(l.quantity, l.unit, false)}
                  </td>
                  <td className={tdClass}>{l.lotNo ?? "-"}</td>
                  <td className={tdClass}>{l.expiryDate ?? "-"}</td>
                  <td className={tdClass}>
                    <span className={monoChipClass}>{l.batchCode}</span>
                  </td>
                  <td className={`${tdClass} text-right`}>
                    <Link href={`/store/stock-in/${l.batchCode}`} className={linkButtonClass}>
                      Open labels
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
