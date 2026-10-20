import Link from "next/link";
import type { ReactNode } from "react";
import { requirePermission } from "@/server/auth/session";
import { getBottleReport } from "@/server/services/report.service";
import { tableClass, tdClass, thClass } from "@/components/ui/styles";
import { IssueHistoryButton, type IssueRow } from "./IssueHistoryButton";
import { MovementHistory } from "./MovementHistory";

export const metadata = { title: "Bottle history" };

const readable = (value: string) => value.toLowerCase().replace(/_/g, " ");

/** Timeline heading for an event: "Stocked", "Returned (used)", ... */
function eventLabel(type: string) {
  if (type === "RETURNED") return "Returned (used)";
  if (type === "RETURNED_UNUSED") return "Returned (unused)";
  const text = readable(type);
  return text.charAt(0).toUpperCase() + text.slice(1);
}

const timelineDate = (d: Date) =>
  d.toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });

function PinIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 21s-7-6.2-7-11a7 7 0 1 1 14 0c0 4.8-7 11-7 11z" />
      <circle cx="12" cy="10" r="2.5" />
    </svg>
  );
}

export default async function BottleHistoryPage({ params }: { params: Promise<{ serial: string }> }) {
  await requirePermission("view_reports");
  const { serial } = await params;
  const report = await getBottleReport(decodeURIComponent(serial));

  if (!report) {
    return (
      <div className="flex max-w-xl flex-col gap-3">
        <h1 className="text-[22px] font-bold tracking-tight">Bottle not found</h1>
        <p className="text-sm text-zinc-500">No bottle with that serial is in the system. Check the label and try again.</p>
        <Link href="/reports/bottle" className="text-sm underline">
          Search again
        </Link>
      </div>
    );
  }

  const { unit, history, issuedFor } = report;

  const issueRows: IssueRow[] = issuedFor.map((l) => ({
    reference: `${l.referenceType.toLowerCase()} ${l.referenceRef}${l.testCode ? ` (${l.testCode})` : ""}`,
    patient: l.patientHospitalNo ?? "-",
    payment: readable(l.paymentCheck),
    overrideReason: l.overrideReason ?? null,
    collectedBy: [l.collectorType, l.collectorName].filter(Boolean).join(": ") || "-",
    issued: l.issuedAt.toLocaleString("en-GB"),
    status: l.clearedAt ? `cleared ${l.clearedAt.toLocaleString("en-GB")}` : "active",
  }));

  /** Extra info for one event (issue history button, batch link, transfer, reason, note). Null when there is none. */
  const detailsFor = (h: (typeof history)[number]): ReactNode => {
    if (h.type === "ISSUED") {
      return <IssueHistoryButton rows={issueRows} serial={unit.serial} />;
    }
    const parts: ReactNode[] = [];
    if (h.type === "STOCKED") {
      parts.push(
        <Link key="batch" href={`/reports/batch/${encodeURIComponent(unit.batchCode)}`} className="font-mono underline">
          {unit.batchCode}
        </Link>,
      );
    }
    if (h.transferCode) {
      parts.push(
        <span key="transfer">
          transfer{" "}
          <Link href={`/store/transfers/${encodeURIComponent(h.transferCode)}`} className="font-mono underline">
            {h.transferCode}
          </Link>
        </span>,
      );
    }
    const text = [h.reasonCode ?? "", h.note ?? ""].filter(Boolean).join(", ");
    if (text) parts.push(<span key="text">{text}</span>);
    if (parts.length === 0) return null;
    return (
      <>
        {parts.map((p, i) => (
          <span key={i}>
            {i > 0 ? ", " : null}
            {p}
          </span>
        ))}
      </>
    );
  };

  const tableView = (
    <section className="overflow-x-auto rounded-xl border border-line bg-surface px-2 py-1">
      <table className={tableClass}>
        <thead>
          <tr>
            <th className={thClass}>When</th>
            <th className={thClass}>Event</th>
            <th className={thClass}>Change</th>
            <th className={thClass}>Where</th>
            <th className={thClass}>By</th>
            <th className={thClass}>Details</th>
          </tr>
        </thead>
        <tbody>
          {history.map((h) => (
            <tr key={h.id}>
              <td className={tdClass}>{h.occurredAt.toLocaleString("en-GB")}</td>
              <td className={tdClass}>{readable(h.type)}</td>
              <td className={tdClass}>
                {h.fromState ? `${readable(h.fromState)} to ${readable(h.toState ?? "")}` : h.toState ? readable(h.toState) : "-"}
              </td>
              <td className={tdClass}>{h.locationName}</td>
              <td className={tdClass}>{h.userName}</td>
              <td className={tdClass}>{detailsFor(h) ?? "-"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );

  const timelineView = (
    <section className="rounded-xl border border-line bg-surface px-5 py-5">
      <ol className="relative ml-1.5 border-l-2 border-line">
        {history.map((h) => {
          const details = detailsFor(h);
          return (
            <li key={h.id} className="relative pb-6 pl-6 last:pb-0">
              <span aria-hidden="true" className="absolute -left-[7px] top-1.5 h-3 w-3 rounded-full bg-brand" />
              <p className="flex flex-wrap items-baseline gap-x-2">
                <span className="text-base font-bold">{eventLabel(h.type)}</span>
                <span className="text-sm text-zinc-500">{timelineDate(h.occurredAt)}</span>
              </p>
              <p className="mt-0.5 text-sm text-zinc-500">
                {h.locationName} · {h.userName}
                {details ? <> · {details}</> : null}
              </p>
            </li>
          );
        })}
      </ol>
    </section>
  );

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="font-mono text-[22px] font-bold tracking-tight">{unit.serial}</h1>
        <p className="mt-1 flex flex-wrap items-center gap-x-1.5 text-sm text-zinc-500">
          <span>
            {unit.itemName}
            {unit.lotNo ? `, lot ${unit.lotNo}` : ""}
            {unit.expiryDate ? `, expires ${unit.expiryDate}` : ""}.
          </span>
          <span>Current location:</span>
          <Link href={`/reports/location/${unit.locationId}`} className="inline-flex items-center gap-1 font-medium text-ink underline">
            <PinIcon />
            {unit.locationName}
          </Link>
        </p>
      </div>

      <MovementHistory timeline={timelineView} table={tableView} />
    </div>
  );
}
