import Link from "next/link";
import { requirePermission } from "@/server/auth/session";
import { listIssueOverrides, listLedgerMismatches, listUnverifiedIssues } from "@/server/services/report.service";
import { tableClass, tdClass, thClass } from "@/components/ui/styles";
import { StatCard } from "@/components/ui/StatCard";
import { Tabs } from "@/components/ui/Tabs";
import { Tag } from "@/components/ui/Tag";
import { Pagination } from "@/components/ui/Pagination";
import { pageOfArray, parsePage } from "@/lib/pagination";

export const metadata = { title: "Exceptions" };

export default async function ExceptionsPage({
  searchParams,
}: {
  searchParams: Promise<{ ppage?: string; opage?: string; lpage?: string }>;
}) {
  await requirePermission("view_reports");
  const sp = await searchParams;
  const [unverified, overrides, mismatches] = await Promise.all([
    listUnverifiedIssues(),
    listIssueOverrides(),
    listLedgerMismatches(),
  ]);
  const open = unverified.filter((u) => !u.clearedAt);
  const unverifiedPage = pageOfArray(unverified, parsePage(sp.ppage));
  const overridesPage = pageOfArray(overrides, parsePage(sp.opage));
  const mismatchesPage = pageOfArray(mismatches, parsePage(sp.lpage));
  const keep = { ppage: sp.ppage, opage: sp.opage, lpage: sp.lpage };

  return (
    <div className="flex flex-col gap-8">
      <div>
        <h1 className="text-[22px] font-bold tracking-tight">Exceptions</h1>
        <p className="mt-1 max-w-3xl text-sm text-zinc-500">
          Things that went through but deserve a second look: issues whose payment could not be checked, supervisor
          overrides, and any bottle whose state is not backed by the ledger.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard value={open.length} label="unverified payments, still active" tone={open.length > 0 ? "warn" : "ok"} />
        <StatCard value={overrides.length} label="supervisor overrides" />
        <StatCard value={mismatches.length} label="not backed by the ledger" tone={mismatches.length > 0 ? "bad" : "ok"} />
      </div>

      <Tabs
        label="Exceptions"
        initialId={sp.opage ? "overrides" : sp.lpage ? "ledger" : "payments"}
        tabs={[
          {
            id: "payments",
            label: "Payment not verified",
            count: open.length,
            content: (
      <section className="overflow-x-auto rounded-xl border border-line bg-surface px-2 py-1">
        <p className="mb-2 pt-2 text-sm text-zinc-500">
          Until the EMR is connected the tracker cannot check payment, so these were issued without confirmation.
          Check them against the cashier&apos;s records.
        </p>
        <table className={tableClass}>
          <thead>
            <tr>
              <th className={thClass}>Reference</th>
              <th className={thClass}>Patient</th>
              <th className={thClass}>Item</th>
              <th className={thClass}>Location</th>
              <th className={thClass}>Issued by</th>
              <th className={thClass}>When</th>
            </tr>
          </thead>
          <tbody>
            {unverifiedPage.rows.map((u) => (
              <tr key={u.linkId}>
                <td className={tdClass}>
                  {u.referenceType.toLowerCase()} {u.referenceRef}
                  {u.testCode ? ` (${u.testCode})` : ""}
                </td>
                <td className={`${tdClass} font-mono`}>
                  {u.patientHospitalNo ?? "-"}
                  {u.patientType ? <span className="block text-xs text-zinc-500">{u.patientType.toLowerCase()}</span> : null}
                </td>
                <td className={tdClass}>
                  {u.quantity > 1 ? `${u.quantity} x ` : ""}
                  {u.itemName}
                  <span className="block font-mono text-xs text-zinc-500">
                    {u.itemRef.startsWith("CT") && u.quantity === 1 ? (
                      <Link href={`/reports/bottle/${u.itemRef}`} className="underline">
                        {u.itemRef}
                      </Link>
                    ) : (
                      u.itemRef
                    )}
                  </span>
                </td>
                <td className={tdClass}>{u.locationName}</td>
                <td className={tdClass}>{u.issuedByName}</td>
                <td className={tdClass}>
                  {u.issuedAt.toLocaleString("en-GB")}
                  {u.clearedAt ? (
                    <>
                      {" "}
                      <Tag tone="ok">Cleared</Tag>
                    </>
                  ) : null}
                </td>
              </tr>
            ))}
            {unverified.length === 0 ? (
              <tr>
                <td className={tdClass} colSpan={6}>
                  None.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
        <Pagination info={unverifiedPage} pathname="/reports/exceptions" params={keep} param="ppage" noun="issues" />
      </section>
            ),
          },
          {
            id: "overrides",
            label: "Supervisor overrides",
            count: overrides.length,
            content: (
      <section className="overflow-x-auto rounded-xl border border-line bg-surface px-2 py-1">
        <table className={tableClass}>
          <thead>
            <tr>
              <th className={thClass}>Reference</th>
              <th className={thClass}>Patient</th>
              <th className={thClass}>Item</th>
              <th className={thClass}>Issued by</th>
              <th className={thClass}>Overridden by</th>
              <th className={thClass}>Reason</th>
              <th className={thClass}>When</th>
            </tr>
          </thead>
          <tbody>
            {overridesPage.rows.map((o) => (
              <tr key={o.linkId}>
                <td className={tdClass}>
                  {o.referenceType.toLowerCase()} {o.referenceRef}
                </td>
                <td className={`${tdClass} font-mono`}>{o.patientHospitalNo ?? "-"}</td>
                <td className={tdClass}>
                  {o.quantity > 1 ? `${o.quantity} x ` : ""}
                  {o.itemName}
                  <span className="block font-mono text-xs text-zinc-500">{o.itemRef}</span>
                </td>
                <td className={tdClass}>{o.issuedByName}</td>
                <td className={tdClass}>{o.overrideByName}</td>
                <td className={tdClass}>{o.overrideReason}</td>
                <td className={tdClass}>{o.issuedAt.toLocaleString("en-GB")}</td>
              </tr>
            ))}
            {overrides.length === 0 ? (
              <tr>
                <td className={tdClass} colSpan={7}>
                  None.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
        <Pagination info={overridesPage} pathname="/reports/exceptions" params={keep} param="opage" noun="overrides" />
      </section>
            ),
          },
          {
            id: "ledger",
            label: "Not backed by the ledger",
            count: mismatches.length,
            content: (
      <section className="overflow-x-auto rounded-xl border border-line bg-surface px-2 py-1">
        <p className="mb-2 pt-2 text-sm text-zinc-500">
          A bottle whose state differs from its latest event, or that has no events. This should always be empty; if it
          is not, something changed stock without recording it.
        </p>
        <table className={tableClass}>
          <thead>
            <tr>
              <th className={thClass}>Serial</th>
              <th className={thClass}>Item</th>
              <th className={thClass}>Location</th>
              <th className={thClass}>State now</th>
              <th className={thClass}>Ledger says</th>
              <th className={thClass}>Last event</th>
            </tr>
          </thead>
          <tbody>
            {mismatchesPage.rows.map((m) => (
              <tr key={m.unitId}>
                <td className={`${tdClass} font-mono`}>
                  <Link href={`/reports/bottle/${m.serial}`} className="underline">
                    {m.serial}
                  </Link>
                </td>
                <td className={tdClass}>{m.itemName}</td>
                <td className={tdClass}>{m.locationName}</td>
                <td className={tdClass}>
                  <Tag tone="bad">{m.unitState.toLowerCase().replace(/_/g, " ")}</Tag>
                </td>
                <td className={tdClass}>{m.ledgerState ? m.ledgerState.toLowerCase().replace(/_/g, " ") : "no events"}</td>
                <td className={tdClass}>
                  {m.lastEventType ? `${m.lastEventType}, ${m.lastEventAt?.toLocaleString("en-GB")}` : "-"}
                </td>
              </tr>
            ))}
            {mismatches.length === 0 ? (
              <tr>
                <td className={tdClass} colSpan={6}>
                  Everything agrees with the ledger.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
        <Pagination info={mismatchesPage} pathname="/reports/exceptions" params={keep} param="lpage" noun="bottles" />
      </section>
            ),
          },
        ]}
      />
    </div>
  );
}
