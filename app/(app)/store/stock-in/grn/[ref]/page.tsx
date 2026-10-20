import Link from "next/link";
import { notFound } from "next/navigation";
import { requirePermission } from "@/server/auth/session";
import { listActiveItemTypes, listActiveLocations } from "@/server/services/catalog.service";
import { getGrnReceipt } from "@/server/services/grn.service";
import { ActionForm } from "@/components/forms/ActionForm";
import { tableClass, tdClass, thClass } from "@/components/ui/styles";
import { Select } from "@/components/ui/Dropdown";
import { receiveGrnLineAction } from "../../actions";

export const metadata = { title: "Receive a GRN" };

export default async function GrnReceivePage({ params }: { params: Promise<{ ref: string }> }) {
  const session = await requirePermission("stock_in");
  const { ref } = await params;
  const grnRef = decodeURIComponent(ref);

  const [lines, itemTypes, locations] = await Promise.all([
    getGrnReceipt(grnRef),
    listActiveItemTypes(),
    listActiveLocations(),
  ]);
  if (!lines) notFound();

  const stores = locations.filter((l) => l.type === "STORE");
  const defaultStoreId = stores.find((s) => s.id === session.homeLocationId)?.id ?? stores[0]?.id;
  const open = lines.filter((l) => !l.receivedBatchCode).length;
  const unmatched = lines.filter((l) => !l.receivedBatchCode && !l.suggestedItemTypeId).length;
  const supplier = lines.find((l) => l.supplier)?.supplier ?? null;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <p className="text-sm">
          <Link href="/store/stock-in/grn" className="underline">
            All GRNs
          </Link>
        </p>
        <h1 className="mt-1 text-[22px] font-bold tracking-tight">
          GRN <span className="font-mono">{grnRef}</span>
        </h1>
        <p className="mt-1 text-sm text-zinc-500">
          {supplier ? `${supplier}. ` : ""}
          {lines.length} lines, {open === 0 ? "all received" : `${open} still to receive`}. Quantity, batch number and
          expiry are Pharmacy&apos;s and cannot be changed here. Pick the item type for each line and receive it into a store.
        </p>
        {unmatched > 0 ? (
          <p className="mt-2 max-w-3xl text-sm">
            {unmatched} line{unmatched === 1 ? " has" : "s have"} no item type chosen for you. To have it filled in next
            time, set the item type&apos;s &quot;Pharmacy catalog id&quot; (under Admin, Item types) to the medication name
            shown here.
          </p>
        ) : null}
      </div>

      {stores.length === 0 || itemTypes.length === 0 ? (
        <p className="max-w-xl rounded-xl border border-line bg-surface p-4 text-sm">
          A STORE location and at least one item type must exist before a GRN can be received. Ask an admin to add them.
        </p>
      ) : (
        <section className="overflow-x-auto rounded-xl border border-line bg-surface px-2 py-1">
          <table className={tableClass}>
            <thead>
              <tr>
                <th className={thClass}>Medication</th>
                <th className={thClass}>Batch</th>
                <th className={thClass}>Expiry</th>
                <th className={thClass}>Quantity</th>
                <th className={thClass}>Receive</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((l) => (
                <tr key={`${l.batchNo}-${l.itemKey}`}>
                  <td className={tdClass}>
                    {l.itemLabel}
                    {l.unit ? <span className="text-zinc-500"> ({l.unit})</span> : null}
                  </td>
                  <td className={`${tdClass} font-mono`}>{l.batchNo}</td>
                  <td className={tdClass}>{l.expiryDate ?? "-"}</td>
                  <td className={tdClass}>{l.quantity}</td>
                  <td className={tdClass}>
                    {l.receivedBatchCode ? (
                      <span>
                        Received as{" "}
                        <Link href={`/store/stock-in/${l.receivedBatchCode}`} className="font-mono underline">
                          {l.receivedBatchCode}
                        </Link>
                      </span>
                    ) : (
                      <ActionForm
                        action={receiveGrnLineAction}
                        submitLabel="Receive and make labels"
                        compact
                        resetOnSuccess={false}
                        className="flex flex-wrap items-center gap-2"
                        confirm={`Receive ${l.quantity} x ${l.itemLabel}, batch ${l.batchNo}?`}
                      >
                        <input type="hidden" name="grnRef" value={l.grnRef} />
                        <input type="hidden" name="batchNo" value={l.batchNo} />
                        <input type="hidden" name="itemKey" value={l.itemKey} />
                        <div className="w-72">
                          <Select
                            name="itemTypeId"
                            required
                            ariaLabel="Item type"
                            placeholder="Item type..."
                            defaultValue={l.suggestedItemTypeId ?? ""}
                            options={itemTypes.map((i) => ({
                              value: i.id,
                              label: `${i.name} (${i.code}, ${i.trackingMode})`,
                            }))}
                          />
                        </div>
                        <div className="w-44">
                          <Select
                            name="locationId"
                            required
                            ariaLabel="Store"
                            defaultValue={defaultStoreId ?? ""}
                            options={stores.map((s) => ({ value: s.id, label: s.name }))}
                          />
                        </div>
                      </ActionForm>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}
