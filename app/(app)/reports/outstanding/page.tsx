import Link from "next/link";
import { requirePermission } from "@/server/auth/session";
import { env } from "@/server/env";
import { listOpenRequestBalances, listOutstandingIssued } from "@/server/services/report.service";
import { tableClass, tdClass, thClass } from "@/components/ui/styles";
import { StatCard } from "@/components/ui/StatCard";
import { Tabs } from "@/components/ui/Tabs";
import { Tag } from "@/components/ui/Tag";
import { Pagination } from "@/components/ui/Pagination";
import { pageOfArray, parsePage } from "@/lib/pagination";

export const metadata = { title: "Outstanding bottles" };

export default async function OutstandingPage({
  searchParams,
}: {
  searchParams: Promise<{ bpage?: string; rpage?: string }>;
}) {
  await requirePermission("view_reports");
  const sp = await searchParams;
  const hours = env().OUTSTANDING_HOURS;
  const allRows = await listOutstandingIssued({ hours });
  const openBalances = await listOpenRequestBalances();
  const openRequestCount = new Set(openBalances.map((b) => b.requestId)).size;
  const bottlePage = pageOfArray(allRows, parsePage(sp.bpage));
  const balancePage = pageOfArray(openBalances, parsePage(sp.rpage));
  const rows = allRows;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-[22px] font-bold tracking-tight">Outstanding</h1>
        <p className="mt-1 max-w-3xl text-sm text-zinc-500">
          Bottles issued and not yet returned, and stock the store approved for a request but has not sent.
        </p>
      </div>

      <Tabs
        label="Outstanding"
        initialId={sp.rpage && !sp.bpage ? "requests" : "bottles"}
        tabs={[
          {
            id: "bottles",
            label: "Outstanding bottles",
            count: rows.length,
            content: (
      <div className="flex flex-col gap-6">
        <p className="max-w-3xl text-sm text-zinc-500">
          Serialized items issued more than {hours} hours ago and not yet returned, longest first. Each one should come
          back as used, unused or unusable, or be voided if its investigation was cancelled. The threshold is the
          OUTSTANDING_HOURS setting.
        </p>

      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard value={rows.length} label="overdue bottles" tone={rows.length > 0 ? "warn" : "ok"} />
        <StatCard value={rows.length > 0 ? Math.max(...rows.map((r) => r.hoursOut)) : 0} label="hours out, longest" tone={rows.length > 0 ? "bad" : "ok"} />
        <StatCard value={hours} label="hour limit before a bottle is overdue" />
      </div>

      <section className="overflow-x-auto rounded-xl border border-line bg-surface px-2 py-1">
        <table className={tableClass}>
          <thead>
            <tr>
              <th className={thClass}>Serial</th>
              <th className={thClass}>Item</th>
              <th className={thClass}>Location</th>
              <th className={thClass}>Issued for</th>
              <th className={thClass}>Patient</th>
              <th className={thClass}>Issued</th>
              <th className={thClass}>Hours out</th>
            </tr>
          </thead>
          <tbody>
            {bottlePage.rows.map((r) => (
              <tr key={r.unitId}>
                <td className={`${tdClass} font-mono`}>
                  <Link href={`/reports/bottle/${r.serial}`} className="underline">
                    {r.serial}
                  </Link>
                </td>
                <td className={tdClass}>{r.itemName}</td>
                <td className={tdClass}>{r.locationName}</td>
                <td className={tdClass}>{r.issuedFor ?? "-"}</td>
                <td className={`${tdClass} font-mono`}>{r.patientHospitalNo ?? "-"}</td>
                <td className={tdClass}>{r.issuedAt.toLocaleString("en-GB")}</td>
                <td className={tdClass}>
                  <Tag tone="warn">{r.hoursOut} h</Tag>
                </td>
              </tr>
            ))}
            {rows.length === 0 ? (
              <tr>
                <td className={tdClass} colSpan={7}>
                  Nothing is overdue.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
        <Pagination info={bottlePage} pathname="/reports/outstanding" params={{ rpage: sp.rpage }} param="bpage" noun="bottles" />
      </section>
      </div>
            ),
          },
          {
            id: "requests",
            label: "Open request balances",
            count: openRequestCount,
            content: (
      <div className="flex flex-col gap-6">
        <p className="max-w-3xl text-sm text-zinc-500">
          Items on approved stock requests that the store has not sent yet, oldest first. Closed lines are not shown.
          &quot;In transit&quot; is stock already dispatched but not yet counted at the requesting location.
        </p>

      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard value={openRequestCount} label="requests with stock still to send" tone={openRequestCount > 0 ? "warn" : "ok"} />
        <StatCard value={openBalances.reduce((n, b) => n + b.openBalance, 0)} label="items still to send" />
        <StatCard value={openBalances.length > 0 ? Math.max(...openBalances.map((b) => b.daysOpen)) : 0} label="days open, longest" />
      </div>

      <section className="overflow-x-auto rounded-xl border border-line bg-surface px-2 py-1">
        <table className={tableClass}>
          <thead>
            <tr>
              <th className={thClass}>Request</th>
              <th className={thClass}>Item</th>
              <th className={thClass}>Requested by</th>
              <th className={thClass}>Store</th>
              <th className={thClass}>Approved</th>
              <th className={thClass}>Sent</th>
              <th className={thClass}>Still to send</th>
              <th className={thClass}>In transit</th>
              <th className={thClass}>Days open</th>
            </tr>
          </thead>
          <tbody>
            {balancePage.rows.map((b) => (
              <tr key={`${b.requestId}-${b.itemName}`}>
                <td className={`${tdClass} font-mono`}>
                  <Link href={`/store/requests/${b.requestCode}`} className="underline">
                    {b.requestCode}
                  </Link>
                </td>
                <td className={tdClass}>{b.itemName}</td>
                <td className={tdClass}>{b.requestingName}</td>
                <td className={tdClass}>{b.storeName}</td>
                <td className={tdClass}>{b.approved}</td>
                <td className={tdClass}>{b.dispatched}</td>
                <td className={tdClass}>
                  <Tag tone="warn">{b.openBalance}</Tag>
                </td>
                <td className={tdClass}>{b.inTransit > 0 ? b.inTransit : "-"}</td>
                <td className={tdClass}>{b.daysOpen}</td>
              </tr>
            ))}
            {openBalances.length === 0 ? (
              <tr>
                <td className={tdClass} colSpan={9}>
                  No approved request has stock left to send.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
        <Pagination info={balancePage} pathname="/reports/outstanding" params={{ bpage: sp.bpage }} param="rpage" noun="lines" />
      </section>
      </div>
            ),
          },
        ]}
      />
    </div>
  );
}
