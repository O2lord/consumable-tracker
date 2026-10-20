import { requirePermission } from "@/server/auth/session";
import { getInvestigationImportStats, listOrphanIssuesPage } from "@/server/services/import.service";
import { tableClass, tdClass, thClass } from "@/components/ui/styles";
import { Pagination } from "@/components/ui/Pagination";
import { parsePage } from "@/lib/pagination";

export const metadata = { title: "Orphan issues" };

const PROBLEM_LABEL = {
  NOT_IN_IMPORT: "Not seen on the portal",
  MRN_MISMATCH: "Different patient",
} as const;

export default async function OrphanIssuesPage({ searchParams }: { searchParams: Promise<{ page?: string }> }) {
  await requirePermission("view_reports");
  const sp = await searchParams;
  const [stats, orphanPage] = await Promise.all([getInvestigationImportStats(), listOrphanIssuesPage(parsePage(sp.page))]);
  const rows = orphanPage.rows;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-[22px] font-bold tracking-tight">Orphan issues</h1>
        <p className="mt-1 max-w-3xl text-sm text-zinc-500">
          Bottles issued against an investigation number the tracker has not seen on the staff portal. The Chrome
          extension records every investigation it reads, so an issue made through the extension never shows here.
          &quot;Not seen on the portal&quot; means the bottle was issued by typing the number in the Issue page: it may be
          a typo or a made-up number. &quot;Different patient&quot; means the number exists but belongs to another hospital
          number than the one recorded at issue.
        </p>
        <p className="mt-2 text-sm">
          {stats.total === 0
            ? "No investigations have been recorded yet, so any issue made without the extension will show here."
            : `Checked against ${stats.total} investigations recorded from the portal.`}
        </p>
      </div>

      <section className="overflow-x-auto rounded-xl border border-line bg-surface px-2 py-1">
        <table className={tableClass}>
          <thead>
            <tr>
              <th className={thClass}>Problem</th>
              <th className={thClass}>Investigation</th>
              <th className={thClass}>Patient on issue</th>
              <th className={thClass}>Patient in import</th>
              <th className={thClass}>Item</th>
              <th className={thClass}>Location</th>
              <th className={thClass}>Issued by</th>
              <th className={thClass}>Issued</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.linkId}>
                <td className={tdClass}>{PROBLEM_LABEL[r.problem]}</td>
                <td className={`${tdClass} font-mono`}>{r.referenceRef}</td>
                <td className={`${tdClass} font-mono`}>{r.patientHospitalNo ?? "-"}</td>
                <td className={`${tdClass} font-mono`}>{r.importedPatientHospitalNo ?? "-"}</td>
                <td className={tdClass}>
                  {r.itemName} <span className="font-mono">{r.itemRef}</span>
                  {r.clearedAt ? <span className="text-zinc-500"> (returned unused)</span> : null}
                </td>
                <td className={tdClass}>{r.locationName}</td>
                <td className={tdClass}>{r.issuedByName}</td>
                <td className={tdClass}>{r.issuedAt.toLocaleString("en-GB")}</td>
              </tr>
            ))}
            {rows.length === 0 ? (
              <tr>
                <td className={tdClass} colSpan={8}>
                  {stats.total === 0 ? "Nothing to show." : "Every investigation issue matches an investigation recorded from the portal."}
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
        <Pagination info={orphanPage} pathname="/reports/orphans" noun="issues" />
      </section>
    </div>
  );
}
