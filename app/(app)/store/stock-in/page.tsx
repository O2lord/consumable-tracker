import Link from "next/link";
import { requirePermission } from "@/server/auth/session";
import { listActiveItemTypes, listActiveLocations } from "@/server/services/catalog.service";
import { listDeliveriesPage, listBatchesWithoutDeliveryPage } from "@/server/services/delivery.service";
import { Pagination } from "@/components/ui/Pagination";
import { parsePage } from "@/lib/pagination";
import { StockInForm } from "./StockInForm";
import { describeRequestQuantity } from "@/lib/pack-size";
import {
  calloutClass,
  linkButtonClass,
  pageSubtitleClass,
  pageTitleClass,
  panelClass,
  tableClass,
  tdClass,
  thClass,
} from "@/components/ui/styles";

export const metadata = { title: "Stock in" };

export default async function StockInPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string; bpage?: string }>;
}) {
  const session = await requirePermission("stock_in");
  const sp = await searchParams;
  const [itemTypes, locations, deliveryPage, legacyPage] = await Promise.all([
    listActiveItemTypes(),
    listActiveLocations(),
    listDeliveriesPage(parsePage(sp.page)),
    listBatchesWithoutDeliveryPage(parsePage(sp.bpage)),
  ]);
  const deliveries = deliveryPage.rows;
  const legacyBatches = legacyPage.rows;
  const stores = locations.filter((l) => l.type === "STORE");
  const homeStore = stores.find((s) => s.id === session.homeLocationId);

  const header = (
    <>
      <h1 className={pageTitleClass}>Stock in</h1>
      <p className={pageSubtitleClass}>
        Record a delivery. Bottles get their own barcode labels; bulk items get one label for the whole batch. Count
        packs or pieces, whichever the delivery note says.
      </p>
    </>
  );

  return (
    <div className="flex flex-col gap-6">
      {itemTypes.length === 0 || stores.length === 0 ? (
        <>
          <div>{header}</div>
          <p className="max-w-xl rounded-xl border border-line bg-surface p-4 text-sm">
            {stores.length === 0 ? "No store location exists yet. " : ""}
            {itemTypes.length === 0 ? "No item types exist yet. " : ""}
            Ask an admin to add {stores.length === 0 ? "a STORE location" : ""}
            {stores.length === 0 && itemTypes.length === 0 ? " and " : ""}
            {itemTypes.length === 0 ? "an item type" : ""} first.
          </p>
        </>
      ) : (
        <StockInForm
          header={header}
          itemTypes={itemTypes.map((i) => ({
            id: i.id,
            name: i.name,
            code: i.code,
            trackingMode: i.trackingMode,
            unit: i.unitOfMeasure,
            packSize: i.packSize,
            packSizeConfirmed: i.packSizeConfirmed,
          }))}
          stores={stores.map((s) => ({ id: s.id, name: s.name }))}
          defaultStoreId={homeStore?.id}
        />
      )}

      <p className={calloutClass}>
        Received something Pharmacy has already recorded?{" "}
        <Link href="/store/stock-in/grn" className="font-semibold text-side-title underline">
          Receive it from a Pharmacy GRN
        </Link>
      </p>

      <section className={`${panelClass} overflow-x-auto`}>
        <h2 className="mb-3 text-[17px] font-semibold">Recent deliveries</h2>
        <table className={tableClass}>
          <thead>
            <tr>
              <th className={thClass}>Delivery</th>
              <th className={thClass}>Supplier</th>
              <th className={thClass}>Items</th>
              <th className={thClass}>Received</th>
              <th className={`${thClass} text-right`}>
                <span className="sr-only">Open</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {deliveries.map((d) => (
              <tr key={d.code}>
                <td className={`${tdClass} font-mono text-[13px]`}>{d.code}</td>
                <td className={tdClass}>
                  {d.supplier ?? "-"}
                  {d.reference ? <div className="text-xs text-muted">{d.reference}</div> : null}
                </td>
                <td className={tdClass}>
                  <span title={d.itemNames || undefined} className="cursor-default underline decoration-dotted underline-offset-4">
                    {d.itemCount} {d.itemCount === 1 ? "item" : "items"}
                  </span>
                </td>
                <td className={tdClass}>{d.receivedAt.toLocaleString("en-GB")}</td>
                <td className={`${tdClass} text-right`}>
                  <Link href={`/store/stock-in/delivery/${d.code}`} className={linkButtonClass}>
                    Open delivery
                  </Link>
                </td>
              </tr>
            ))}
            {deliveries.length === 0 ? (
              <tr>
                <td className={tdClass} colSpan={5}>
                  Nothing received yet.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
        <Pagination
          info={deliveryPage}
          pathname="/store/stock-in"
          params={{ bpage: sp.bpage }}
          noun="deliveries"
        />
      </section>

      {legacyBatches.length > 0 ? (
        <section className={`${panelClass} overflow-x-auto`}>
          <h2 className="text-[17px] font-semibold">Received before deliveries</h2>
          <p className="mb-3 text-sm text-zinc-500">
            These batches were stocked in before deliveries had their own DV code, so they open straight to their labels.
          </p>
          <table className={tableClass}>
            <thead>
              <tr>
                <th className={thClass}>Batch</th>
                <th className={thClass}>Item</th>
                <th className={`${thClass} text-left`}>Quantity</th>
                <th className={thClass}>Received</th>
                <th className={`${thClass} text-right`}>
                  <span className="sr-only">Labels</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {legacyBatches.map((b) => (
                <tr key={b.code}>
                  <td className={`${tdClass} font-mono text-[13px]`}>{b.code}</td>
                  <td className={tdClass}>{b.itemName}</td>
                  <td className={`${tdClass} text-left`}>
                    {b.trackingMode === "SERIAL" ? b.quantity : describeRequestQuantity(b.quantity, b.unit, false)}
                  </td>
                  <td className={tdClass}>{b.createdAt.toLocaleString("en-GB")}</td>
                  <td className={`${tdClass} text-right`}>
                    <Link href={`/store/stock-in/${b.code}`} className={linkButtonClass}>
                      Open labels
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <Pagination info={legacyPage} pathname="/store/stock-in" params={{ page: sp.page }} param="bpage" noun="batches" />
        </section>
      ) : null}
    </div>
  );
}
