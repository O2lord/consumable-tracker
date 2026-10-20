import Link from "next/link";
import { notFound } from "next/navigation";
import { requirePermission } from "@/server/auth/session";
import { canWorkAtAnyLocation } from "@/server/auth/permissions";
import { getIssuedBottle } from "@/server/services/issue.service";
import { env } from "@/server/env";
import { Tag, type Tone } from "@/components/ui/Tag";
import { cardClass, tableClass, tabClass, tabListClass, tdClass, thClass } from "@/components/ui/styles";

export const metadata = { title: "Issued bottle" };

const TABS = [
  { id: "overview", label: "Overview" },
  { id: "investigations", label: "Investigations" },
  { id: "results", label: "Results" },
] as const;
type TabId = (typeof TABS)[number]["id"];

const readable = (value: string) => value.toLowerCase().replace(/_/g, " ");
const PAYMENT: Record<string, { label: string; tone: Tone }> = {
  VERIFIED: { label: "Verified", tone: "ok" },
  UNVERIFIED: { label: "Unverified", tone: "warn" },
  NOT_REQUIRED: { label: "Not required", tone: "brand" },
};

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-[13px] font-semibold text-muted">{label}</dt>
      <dd className="mt-0.5 text-sm">{children}</dd>
    </div>
  );
}

export default async function IssuedBottlePage({
  params,
  searchParams,
}: {
  params: Promise<{ serial: string }>;
  searchParams: Promise<{ tab?: string }>;
}) {
  const session = await requirePermission("issue");
  const { serial } = await params;
  const { tab: tabParam } = await searchParams;
  const tab: TabId = TABS.some((t) => t.id === tabParam) ? (tabParam as TabId) : "overview";

  const found = await getIssuedBottle(decodeURIComponent(serial));
  if (!found) notFound();
  const { unit, issued, lastReturn } = found;

  // Same rule as the list: only supervisors and admins see bottles from other locations.
  if (!canWorkAtAnyLocation(session.role) && session.homeLocationId !== unit.locationId) notFound();

  const active = issued.filter((l) => !l.clearedAt);
  const current = active.length > 0 ? active : issued;
  const first = current[0];
  const patientNos = [...new Set(issued.map((l) => l.patientHospitalNo).filter(Boolean))];
  const overrides = issued.filter((l) => l.overrideReason);
  // Only a return after the current issue counts; an earlier return belongs to an earlier issue.
  const returned = lastReturn && first && lastReturn.returnedAt >= first.issuedAt ? lastReturn : null;
  const href = (id: TabId) => `/distribution/issue/${encodeURIComponent(unit.serial)}?tab=${id}`;
  const portalBase = env().PORTAL_BASE_URL.replace(/\/$/, "");

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link href="/distribution/issue" className="text-sm underline">
          Back to Issue
        </Link>
        <div className="mt-2 flex flex-wrap items-baseline gap-x-4 gap-y-1">
          <h1 className="font-mono text-[22px] font-bold tracking-tight">{unit.serial}</h1>
          {first && active.length > 0 ? (
            <a href={`/api/issues/${unit.serial}/label`} target="_blank" rel="noreferrer" className="text-sm underline">
              Print label
            </a>
          ) : null}
        </div>
        <p className="mt-1 text-sm text-zinc-500">
          {unit.itemName}. Now {readable(unit.state)} at {unit.locationName}.
        </p>
      </div>

      <nav aria-label="Bottle sections" className={tabListClass}>
        {TABS.map((t) => (
          <Link
            key={t.id}
            href={href(t.id)}
            aria-current={tab === t.id ? "page" : undefined}
            className={tabClass(tab === t.id)}
          >
            {t.label}
            {t.id === "investigations" ? ` (${current.length})` : ""}
          </Link>
        ))}
      </nav>

      {tab === "overview" ? (
        <section className={cardClass}>
          <div className="grid gap-x-8 gap-y-6 sm:grid-cols-2 lg:grid-cols-3">
            <dl className="flex flex-col gap-4">
              <Detail label="Patient hospital no">
                <span className="font-mono">{patientNos.join(", ") || "-"}</span>
              </Detail>
              <Detail label="Issued by">{first?.issuedByName ?? "-"}</Detail>
              <Detail label="Issued at">{first?.issuedLocationName ?? "-"}</Detail>
              <Detail label="Time issued">{first ? first.issuedAt.toLocaleString("en-GB") : "Never issued"}</Detail>
              <Detail label="Collected by">
                {first ? [first.collectorType && readable(first.collectorType), first.collectorName].filter(Boolean).join(": ") || "-" : "-"}
              </Detail>
            </dl>
            <dl className="flex flex-col gap-4">
              <Detail label="Returned at">{returned?.locationName ?? "-"}</Detail>
              <Detail label="Time returned">{returned ? returned.returnedAt.toLocaleString("en-GB") : "Not returned yet"}</Detail>
              <Detail label="Received by">{returned?.receivedByName ?? "-"}</Detail>
              <Detail label="Investigations">
                <Link href={href("investigations")} className="underline">
                  {current.length} {active.length === 0 && issued.length > 0 ? "(all cleared)" : "linked"}
                </Link>
              </Detail>
            </dl>
            <dl className="flex flex-col gap-4">
              <Detail label="Batch">{unit.batchCode}</Detail>
              <Detail label="Lot">{unit.lotNo ?? "-"}</Detail>
              <Detail label="Expires at">{unit.expiryDate ?? "-"}</Detail>
            </dl>
          </div>
          {overrides.length > 0 ? (
            <p className="mt-4 rounded-lg bg-warn-soft px-3 py-2 text-sm text-warn">
              Override: {[...new Set(overrides.map((o) => o.overrideReason))].join("; ")}
            </p>
          ) : null}
        </section>
      ) : null}

      {tab === "investigations" ? (
        <section className="overflow-x-auto rounded-xl border border-line bg-surface px-2 py-1">
          <h2 className="mb-2 font-medium">Everything this bottle is linked to</h2>
          <table className={tableClass}>
            <thead>
              <tr>
                <th className={thClass}>Reference</th>
                <th className={thClass}>Test</th>
                <th className={thClass}>Payment</th>
                <th className={thClass}>Issued</th>
                <th className={thClass}>Status</th>
              </tr>
            </thead>
            <tbody>
              {issued.map((l) => (
                <tr key={l.id}>
                  <td className={tdClass}>
                    {l.referenceType === "INVESTIGATION" ? l.referenceRef : `${readable(l.referenceType)} ${l.referenceRef}`}
                  </td>
                  <td className={tdClass}>
                    {l.testName ?? l.importedTestName ?? "-"}
                    {l.testCode ? <span className="block font-mono text-xs text-zinc-500">{l.testCode}</span> : null}
                  </td>
                  <td className={tdClass}>
                    <Tag tone={PAYMENT[l.paymentCheck].tone}>{PAYMENT[l.paymentCheck].label}</Tag>
                  </td>
                  <td className={tdClass}>{l.issuedAt.toLocaleString("en-GB")}</td>
                  <td className={tdClass}>{l.clearedAt ? `cleared ${l.clearedAt.toLocaleString("en-GB")}` : "active"}</td>
                </tr>
              ))}
              {issued.length === 0 ? (
                <tr>
                  <td className={tdClass} colSpan={5}>
                    This bottle has not been issued.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </section>
      ) : null}

      {tab === "results" ? (
        <section className="overflow-x-auto rounded-xl border border-line bg-surface px-2 py-1">
          <h2 className="mb-1 font-medium">Results</h2>
          <p className="mb-2 text-sm text-zinc-500">
            Where each investigation stands, as last read from the staff portal (or the hospital export). The tracker does not hold lab values.
          </p>
          <table className={tableClass}>
            <thead>
              <tr>
                <th className={thClass}>Investigation</th>
                <th className={thClass}>Status</th>
                <th className={thClass}>Started</th>
                <th className={thClass}>Prepared</th>
                <th className={thClass}>Results released</th>
                <th className={thClass}>Completed</th>
                <th className={thClass}>Destination</th>
                <th className={thClass}>Last updated</th>
                <th className={thClass}>Result</th>
              </tr>
            </thead>
            <tbody>
              {issued.map((l) => {
                const step = (at: Date | null, by: string | null) =>
                  at ? (
                    <>
                      {at.toLocaleString("en-GB")}
                      {by ? <span className="block text-xs text-zinc-500">by {by}</span> : null}
                    </>
                  ) : (
                    "-"
                  );
                const updated = l.portalSyncedAt ?? l.importedAt;
                return (
                  <tr key={l.id}>
                    <td className={tdClass}>{l.referenceRef}</td>
                    <td className={tdClass}>{l.importedStatus ? readable(l.importedStatus) : "-"}</td>
                    <td className={tdClass}>{step(l.portalStartedAt, l.portalStartedBy)}</td>
                    <td className={tdClass}>{step(l.portalPreparedAt, l.portalPreparedBy)}</td>
                    <td className={tdClass}>{step(l.portalVerifiedAt, l.portalVerifiedBy)}</td>
                    <td className={tdClass}>{l.portalCompletedAt ? l.portalCompletedAt.toLocaleString("en-GB") : "-"}</td>
                    <td className={tdClass}>{l.importedDestination ?? "-"}</td>
                    <td className={tdClass}>{updated ? updated.toLocaleString("en-GB") : "Not read from the portal yet"}</td>
                    <td className={tdClass}>
                      {l.portalId ? (
                        <a href={`${portalBase}/lab-tests/${encodeURIComponent(l.portalId)}`} target="_blank" rel="noreferrer" className="underline">
                          View result
                        </a>
                      ) : (
                        <span className="text-zinc-500">Open it once in the portal</span>
                      )}
                    </td>
                  </tr>
                );
              })}
              {issued.length === 0 ? (
                <tr>
                  <td className={tdClass} colSpan={9}>
                    Nothing to show.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </section>
      ) : null}
    </div>
  );
}
