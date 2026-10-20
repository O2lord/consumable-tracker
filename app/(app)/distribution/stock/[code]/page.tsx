import Link from "next/link";
import { notFound } from "next/navigation";
import { requirePermission } from "@/server/auth/session";
import { canWorkAtAnyLocation } from "@/server/auth/permissions";
import { listActiveLocations } from "@/server/services/catalog.service";
import { getSerialItemAtLocation } from "@/server/services/stock.service";
import { tableClass, tdClass, thClass } from "@/components/ui/styles";
import { Tabs } from "@/components/ui/Tabs";

export const metadata = { title: "Stock item" };

const OUTCOME_LABEL: Record<string, string> = {
  RETURNED: "Used",
  RETURNED_UNUSED: "Unused, back in stock",
  VOIDED: "Voided",
};

export default async function StockItemPage({
  params,
  searchParams,
}: {
  params: Promise<{ code: string }>;
  searchParams: Promise<{ location?: string }>;
}) {
  const session = await requirePermission("view_location_stock");
  const isSupervisor = canWorkAtAnyLocation(session.role);
  const { code } = await params;
  const { location } = await searchParams;
  const locationId = isSupervisor && location ? location : session.homeLocationId;

  if (!locationId) {
    return (
      <p className="max-w-xl rounded-xl border border-line bg-surface p-4 text-sm">
        Your account has no home location. Ask an admin to set one.
      </p>
    );
  }

  const data = await getSerialItemAtLocation(locationId, decodeURIComponent(code));
  if (!data) notFound();

  const locations = isSupervisor ? await listActiveLocations() : [];
  const where = isSupervisor ? (locations.find((l) => l.id === locationId)?.name ?? "this location") : "your location";
  const backHref = `/distribution/stock${isSupervisor ? `?location=${locationId}` : ""}`;
  const bottleHref = (serial: string) => `/distribution/issue/${encodeURIComponent(serial)}`;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link href={backHref} className="text-sm underline">
          Back to stock
        </Link>
        <h1 className="mt-2 text-[22px] font-bold tracking-tight">{data.item.name}</h1>
        <p className="mt-1 text-sm text-zinc-500">At {where}: what is on the shelf, what is out, and what came back.</p>
      </div>

      <Tabs
        label="Bottles"
        tabs={[
          {
            id: "available",
            label: "Available",
            count: data.available.length,
            content: (
              <section className="overflow-x-auto rounded-xl border border-line bg-surface px-2 py-1">
                <table className={tableClass}>
                  <thead>
                    <tr>
                      <th className={thClass}>Bottle</th>
                      <th className={thClass}>Batch</th>
                      <th className={thClass}>Expires</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.available.map((r) => (
                      <tr key={r.serial}>
                        <td className={tdClass}>
                          <Link href={bottleHref(r.serial)} className="font-mono underline">
                            {r.serial}
                          </Link>
                        </td>
                        <td className={`${tdClass} font-mono`}>{r.batchCode}</td>
                        <td className={tdClass}>{r.expiryDate ?? "-"}</td>
                      </tr>
                    ))}
                    {data.available.length === 0 ? (
                      <tr>
                        <td className={tdClass} colSpan={3}>
                          Nothing is on the shelf.
                        </td>
                      </tr>
                    ) : null}
                  </tbody>
                </table>
              </section>
            ),
          },
          {
            id: "issued",
            label: "Issued, not returned",
            count: data.issued.length,
            content: (
              <section className="overflow-x-auto rounded-xl border border-line bg-surface px-2 py-1">
                <table className={tableClass}>
                  <thead>
                    <tr>
                      <th className={thClass}>Patient</th>
                      <th className={thClass}>Bottle</th>
                      <th className={thClass}>Batch</th>
                      <th className={thClass}>Issued</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.issued.map((r) => (
                      <tr key={r.serial}>
                        <td className={`${tdClass} font-mono`}>{r.patientHospitalNo ?? "-"}</td>
                        <td className={tdClass}>
                          <Link href={bottleHref(r.serial)} className="font-mono underline">
                            {r.serial}
                          </Link>
                        </td>
                        <td className={`${tdClass} font-mono`}>{r.batchCode}</td>
                        <td className={tdClass}>{r.issuedAt ? r.issuedAt.toLocaleString("en-GB") : "-"}</td>
                      </tr>
                    ))}
                    {data.issued.length === 0 ? (
                      <tr>
                        <td className={tdClass} colSpan={4}>
                          Nothing is out.
                        </td>
                      </tr>
                    ) : null}
                  </tbody>
                </table>
              </section>
            ),
          },
          {
            id: "returned",
            label: "Returned",
            count: data.returned.length,
            content: (
              <section className="overflow-x-auto rounded-xl border border-line bg-surface px-2 py-1">
                <table className={tableClass}>
                  <thead>
                    <tr>
                      <th className={thClass}>Patient</th>
                      <th className={thClass}>Bottle</th>
                      <th className={thClass}>What happened</th>
                      <th className={thClass}>Returned</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.returned.map((r) => (
                      <tr key={r.eventId}>
                        <td className={`${tdClass} font-mono`}>{r.patientHospitalNo ?? "-"}</td>
                        <td className={tdClass}>
                          <Link href={bottleHref(r.serial)} className="font-mono underline">
                            {r.serial}
                          </Link>
                        </td>
                        <td className={tdClass}>{OUTCOME_LABEL[r.outcome] ?? r.outcome}</td>
                        <td className={tdClass}>{r.returnedAt.toLocaleString("en-GB")}</td>
                      </tr>
                    ))}
                    {data.returned.length === 0 ? (
                      <tr>
                        <td className={tdClass} colSpan={4}>
                          Nothing has been returned yet.
                        </td>
                      </tr>
                    ) : null}
                  </tbody>
                </table>
              </section>
            ),
          },
        ]}
      />
    </div>
  );
}
