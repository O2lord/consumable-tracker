import Link from "next/link";
import { notFound } from "next/navigation";
import { requirePermission } from "@/server/auth/session";
import { getDeliveryByCode } from "@/server/services/delivery.service";
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
import { LabelButtons } from "../../LabelButtons";

export const metadata = { title: "Delivery received" };

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
        <span className="inline-flex items-center gap-1.5 rounded-full bg-ok-soft px-2.5 py-0.5 text-xs font-semibold text-ok">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <path d="M3 8.5l3 3 7-7" />
          </svg>
          Stock recorded
        </span>
        <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-3">
          <h1 className={pageTitleClass}>
            Delivery <span className="font-mono">{delivery.code}</span>
          </h1>
          <LabelButtons delivery={delivery.code} only="delivery" label="Print label" single />
        </div>
        <p className={pageSubtitleClass}>
          {count} {count === 1 ? "item" : "items"} received together. Each item keeps its own lot, expiry and barcode
          label. Open an item to print or download its labels.
        </p>
      </div>

      <section className={`${panelClass} flex flex-col gap-3`}>
        <h2 className="text-[17px] font-semibold">
          Batch labels ({count} {count === 1 ? "label" : "labels"})
        </h2>
        <p className="text-sm text-zinc-500">
          One batch label for each item. The delivery label prints separately, next to the title. For the individual
          bottle and pack labels, open the item.
        </p>
        <LabelButtons delivery={delivery.code} only="batches" label="Print batch labels" />
      </section>

      <section className={`${panelClass} grid gap-x-8 gap-y-3 p-4 text-sm sm:grid-cols-2`}>
        <div>
          <div className="text-xs font-semibold uppercase tracking-wide text-muted">Supplier</div>
          <div>{delivery.supplier ?? "-"}</div>
        </div>
        <div>
          <div className="text-xs font-semibold uppercase tracking-wide text-muted">Received into</div>
          <div>{delivery.locationName}</div>
        </div>
        <div>
          <div className="text-xs font-semibold uppercase tracking-wide text-muted">Received by</div>
          <div>{delivery.receivedByName}</div>
        </div>
        <div>
          <div className="text-xs font-semibold uppercase tracking-wide text-muted">Received</div>
          <div>{received}</div>
        </div>
        {delivery.reference ? (
          <div>
            <div className="text-xs font-semibold uppercase tracking-wide text-muted">Invoice or delivery note</div>
            <div>{delivery.reference}</div>
          </div>
        ) : null}
      </section>

      <section className={`${panelClass} overflow-x-auto`}>
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
                <td className={tdClass}>{l.itemName}</td>
                <td className={`${tdClass} text-left`}>
                  {l.trackingMode === "SERIAL" ? l.quantity : describeRequestQuantity(l.quantity, l.unit, false)}
                </td>
                <td className={tdClass}>{l.lotNo ?? "-"}</td>
                <td className={tdClass}>{l.expiryDate ?? "-"}</td>
                <td className={`${tdClass} font-mono text-[13px]`}>{l.batchCode}</td>
                <td className={`${tdClass} text-right`}>
                  <Link href={`/store/stock-in/${l.batchCode}`} className={linkButtonClass}>
                    Open labels
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
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
