import Link from "next/link";
import { requirePermission } from "@/server/auth/session";
import { getBatchReport } from "@/server/services/report.service";
import { tableClass, tdClass, thClass } from "@/components/ui/styles";

export const metadata = { title: "Batch" };

const readable = (value: string) => value.toLowerCase().replace(/_/g, " ");

export default async function BatchReportPage({ params }: { params: Promise<{ code: string }> }) {
  await requirePermission("view_reports");
  const { code } = await params;
  const report = await getBatchReport(decodeURIComponent(code));

  if (!report) {
    return (
      <div className="flex max-w-xl flex-col gap-3">
        <h1 className="text-[22px] font-bold tracking-tight">Batch not found</h1>
        <p className="text-sm text-zinc-500">No batch with that code is in the system.</p>
        <Link href="/reports/bottle" className="text-sm underline">
          Back to bottle history
        </Link>
      </div>
    );
  }

  const { batch, units } = report;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="font-mono text-[22px] font-bold tracking-tight">{batch.code}</h1>
        <p className="mt-1 text-sm text-zinc-500">
          {batch.quantity} x {batch.itemName}
          {batch.lotNo ? `, lot ${batch.lotNo}` : ""}
          {batch.expiryDate ? `, expires ${batch.expiryDate}` : ""}
          {batch.supplier ? `, from ${batch.supplier}` : ""}.
        </p>
      </div>

      <section className="overflow-x-auto rounded-xl border border-line bg-surface px-2 py-1">
        <h2 className="mb-2 font-medium">Items in this batch ({units.length})</h2>
        <table className={tableClass}>
          <thead>
            <tr>
              <th className={thClass}>Serial</th>
              <th className={thClass}>Status</th>
              <th className={thClass}>Current location</th>
            </tr>
          </thead>
          <tbody>
            {units.map((u) => (
              <tr key={u.serial} className="relative hover:bg-black/[0.03]">
                <td className={`${tdClass} font-mono`}>
                  <Link href={`/reports/bottle/${encodeURIComponent(u.serial)}`} className="underline after:absolute after:inset-0 after:content-['']">
                    {u.serial}
                  </Link>
                </td>
                <td className={tdClass}>{readable(u.state)}</td>
                <td className={tdClass}>
                  <Link href={`/reports/location/${u.locationId}`} className="relative z-10 underline">
                    {u.locationName}
                  </Link>
                </td>
              </tr>
            ))}
            {units.length === 0 ? (
              <tr>
                <td className={tdClass} colSpan={3}>
                  No serialized items in this batch.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </section>
    </div>
  );
}
