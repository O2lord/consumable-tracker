import { requirePermission } from "@/server/auth/session";
import { getInvestigationImportStats, listImportHistory } from "@/server/services/import.service";
import { tableClass, tdClass, thClass } from "@/components/ui/styles";
import { StatCard } from "@/components/ui/StatCard";
import { Tag } from "@/components/ui/Tag";

export const metadata = { title: "Imports" };

export default async function ImportsPage() {
  await requirePermission("manage_imports");
  const [stats, history] = await Promise.all([getInvestigationImportStats(), listImportHistory()]);

  return (
    <div className="flex flex-col gap-8">
      <div>
        <h1 className="text-[22px] font-bold tracking-tight">Imports</h1>
        <p className="mt-1 max-w-3xl text-sm text-zinc-500">
          Investigations are not uploaded. The Chrome extension records each one from the staff portal the first time it is
          opened or a bottle is issued against it.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard value={stats.total} label="investigations recorded" tone="brand" />
      </div>

      <section className="overflow-x-auto rounded-xl border border-line bg-surface px-2 py-1">
        <h2 className="mb-2 font-medium">Import history</h2>
        <table className={tableClass}>
          <thead>
            <tr>
              <th className={thClass}>When</th>
              <th className={thClass}>File</th>
              <th className={thClass}>What</th>
              <th className={thClass}>Rows</th>
              <th className={thClass}>Added</th>
              <th className={thClass}>Updated</th>
              <th className={thClass}>Rejected</th>
            </tr>
          </thead>
          <tbody>
            {history.map((h) => (
              <tr key={h.id}>
                <td className={tdClass}>{h.startedAt.toLocaleString("en-GB")}</td>
                <td className={tdClass}>{h.fileName ?? "-"}</td>
                <td className={tdClass}>{h.what}</td>
                <td className={tdClass}>{h.rowsTotal}</td>
                <td className={tdClass}>{h.rowsInserted}</td>
                <td className={tdClass}>{h.rowsUpdated}</td>
                <td className={tdClass}>
                  {h.rowsRejected > 0 ? <Tag tone="warn">{h.rowsRejected} rejected</Tag> : <Tag tone="ok">None</Tag>}
                  {h.errors.length > 0 ? (
                    <details className="mt-1 text-xs">
                      <summary className="cursor-pointer underline">Show rows</summary>
                      <ul className="mt-1 list-disc pl-4">
                        {h.errors.map((e) => (
                          <li key={`${e.row}-${e.message}`}>
                            Row {e.row}: {e.message}
                          </li>
                        ))}
                      </ul>
                      {h.rowsRejected > h.errors.length ? <p className="mt-1">Only the first {h.errors.length} are kept.</p> : null}
                    </details>
                  ) : null}
                </td>
              </tr>
            ))}
            {history.length === 0 ? (
              <tr>
                <td className={tdClass} colSpan={7}>
                  No imports yet.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </section>
    </div>
  );
}
