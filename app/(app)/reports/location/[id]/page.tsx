import Link from "next/link";
import { requirePermission } from "@/server/auth/session";
import { getLocationReport } from "@/server/services/report.service";
import { tableClass, tdClass, thClass } from "@/components/ui/styles";

export const metadata = { title: "Location" };

const readable = (value: string) => value.toLowerCase().replace(/_/g, " ");

export default async function LocationReportPage({ params }: { params: Promise<{ id: string }> }) {
  await requirePermission("view_reports");
  const { id } = await params;
  const report = await getLocationReport(decodeURIComponent(id));

  if (!report) {
    return (
      <div className="flex max-w-xl flex-col gap-3">
        <h1 className="text-[22px] font-bold tracking-tight">Location not found</h1>
        <Link href="/reports/bottle" className="text-sm underline">
          Back to bottle history
        </Link>
      </div>
    );
  }

  const { location, total, units } = report;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-[22px] font-bold tracking-tight">{location.name}</h1>
        <p className="mt-1 text-sm text-zinc-500">
          {total} bottle{total === 1 ? "" : "s"} here now.
          {total > units.length ? ` Showing the first ${units.length}.` : ""}
        </p>
      </div>

      <section className="overflow-x-auto rounded-xl border border-line bg-surface px-2 py-1">
        <table className={tableClass}>
          <thead>
            <tr>
              <th className={thClass}>Serial</th>
              <th className={thClass}>Item</th>
              <th className={thClass}>Batch</th>
              <th className={thClass}>Status</th>
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
                <td className={tdClass}>{u.itemName}</td>
                <td className={`${tdClass} font-mono`}>
                  <Link href={`/reports/batch/${encodeURIComponent(u.batchCode)}`} className="relative z-10 underline">
                    {u.batchCode}
                  </Link>
                </td>
                <td className={tdClass}>{readable(u.state)}</td>
              </tr>
            ))}
            {units.length === 0 ? (
              <tr>
                <td className={tdClass} colSpan={4}>
                  Nothing here right now.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </section>
    </div>
  );
}
