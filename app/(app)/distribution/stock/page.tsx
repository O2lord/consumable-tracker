import Link from "next/link";
import { requireSession } from "@/server/auth/session";
import { can, canWorkAtAnyLocation } from "@/server/auth/permissions";
import { listActiveLocations } from "@/server/services/catalog.service";
import { getLocationStock } from "@/server/services/stock.service";
import { tableClass, tdClass, thClass } from "@/components/ui/styles";
import { Tabs } from "@/components/ui/Tabs";
import { Pagination } from "@/components/ui/Pagination";
import { pageOfArray, parsePage } from "@/lib/pagination";
import { notFound } from "next/navigation";
import { BulkStock } from "./BulkStock";
import { CountTab } from "./CountTab";
import { LocationPicker } from "./LocationPicker";

export const metadata = { title: "Stock here" };

export default async function StockPage({
  searchParams,
}: {
  searchParams: Promise<{ location?: string; tab?: string; spage?: string; bpage?: string; cpage?: string }>;
}) {
  const session = await requireSession();
  // Stock and stock counts share this page: each tab appears for the people allowed to use it.
  const mayView = can(session.role, "view_location_stock");
  const mayCount = can(session.role, "count_stock");
  if (!mayView && !mayCount) notFound();
  const isSupervisor = canWorkAtAnyLocation(session.role);
  const { location, tab, spage, bpage, cpage } = await searchParams;
  const locations = isSupervisor ? await listActiveLocations() : [];
  const locationId = isSupervisor && location ? location : session.homeLocationId;

  if (!locationId) {
    return (
      <p className="max-w-xl rounded-xl border border-line bg-surface p-4 text-sm">
        Your account has no home location. Ask an admin to set one.
      </p>
    );
  }

  const stock = mayView ? await getLocationStock(locationId) : null;
  const name = isSupervisor ? (locations.find((l) => l.id === locationId)?.name ?? "this location") : "your location";
  const firstTab = stock ? "serial" : "count";
  const initialId = (tab === "count" || cpage) && mayCount ? "count" : bpage && stock ? "bulk" : firstTab;
  // Other query values a page link has to carry along, so changing page keeps the location and the other lists' pages.
  const keep = { location: isSupervisor ? location : undefined, spage, bpage, cpage };
  const serialPage = pageOfArray(stock?.serial ?? [], parsePage(spage));
  const bulkPage = pageOfArray(stock?.quantity ?? [], parsePage(bpage));

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-[22px] font-bold tracking-tight">Stock at {name}</h1>
        <p className="mt-1 text-sm text-zinc-500">
          What is on the shelf and what has been used.
          {mayCount ? " Use the Stock count tab to count the shelf." : ""}
        </p>
      </div>

      {isSupervisor ? (
        <LocationPicker value={locationId} options={locations.map((l) => ({ value: l.id, label: l.name }))} />
      ) : null}

      <Tabs
        label="Stock"
        initialId={initialId}
        tabs={[
          ...(stock
            ? [
          {
            id: "serial",
            label: "Serialized items",
            count: stock.serial.length,
            content: (
      <section className="overflow-x-auto rounded-xl border border-line bg-surface px-2 py-1">
        <table className={tableClass}>
          <thead>
            <tr>
              <th className={thClass}>Item</th>
              <th className={thClass}>In stock</th>
              <th className={thClass}>Issued</th>
              <th className={thClass}>Status</th>
            </tr>
          </thead>
          <tbody>
            {serialPage.rows.map((r) => (
              <tr key={r.itemCode} className="relative hover:bg-black/[0.03]">
                <td className={tdClass}>
                  <Link
                    href={`/distribution/stock/${encodeURIComponent(r.itemCode)}${isSupervisor ? `?location=${locationId}` : ""}`}
                    className="underline after:absolute after:inset-0 after:content-['']"
                  >
                    {r.itemName}
                  </Link>
                </td>
                <td className={tdClass}>{r.inStock}</td>
                <td className={tdClass}>{r.issued}</td>
                <td className={tdClass}>
                  {r.inStock > 0 ? (
                    <span className="inline-flex rounded-full bg-ok-soft px-2.5 py-0.5 text-xs font-semibold text-ok">On shelf</span>
                  ) : (
                    <span className="inline-flex rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-semibold text-amber-800">
                      {r.issued > 0 ? "All issued" : "None"}
                    </span>
                  )}
                </td>
              </tr>
            ))}
            {stock.serial.length === 0 ? (
              <tr>
                <td className={tdClass} colSpan={4}>
                  None.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
        <p className="mt-2 text-xs text-zinc-500">Open an item to see what is on the shelf, what is out, and what came back.</p>
        <Pagination info={serialPage} pathname="/distribution/stock" params={keep} param="spage" noun="items" />
      </section>
            ),
          },
          {
            id: "bulk",
            label: "Bulk items",
            count: stock.quantity.length,
            content: (
              <BulkStock
                rows={bulkPage.rows}
                pager={<Pagination info={bulkPage} pathname="/distribution/stock" params={keep} param="bpage" noun="items" />}
              />
            ),
          },
          ]
            : []),
          ...(mayCount
            ? [
                {
                  id: "count",
                  label: "Stock count",
                  content: <CountTab locationId={locationId} page={parsePage(cpage)} keep={keep} />,
                },
              ]
            : []),
        ]}
      />
    </div>
  );
}
