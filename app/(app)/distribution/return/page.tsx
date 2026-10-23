import Link from "next/link";
import { requirePermission } from "@/server/auth/session";
import { canWorkAtAnyLocation } from "@/server/auth/permissions";
import { listVoidReasons } from "@/server/services/catalog.service";
import { listOutAtLocationPage, listReturnedAtLocationPage } from "@/server/services/stock.service";
import { tableClass, tdClass, thClass } from "@/components/ui/styles";
import { Pagination } from "@/components/ui/Pagination";
import { parsePage } from "@/lib/pagination";
import { ReturnForms } from "./ReturnForms";
import { ReturnTabs } from "./ReturnTabs";

const OUTCOME_LABEL: Record<string, string> = {
  RETURNED: "Used",
  RETURNED_UNUSED: "Unused, back in stock",
  VOIDED: "Voided",
};

export const metadata = { title: "Return" };

export default async function ReturnPage({
  searchParams,
}: {
  searchParams: Promise<{ opage?: string; rpage?: string }>;
}) {
  const session = await requirePermission("return");
  const sp = await searchParams;
  // Where the person is working: set in the app bar (a supervisor's choice, or everyone else's home location).
  const workLocationId = session.workLocationId;

  if (!workLocationId) {
    return (
      <p className="max-w-xl rounded-xl border border-line bg-surface p-4 text-sm">
        {canWorkAtAnyLocation(session.role)
          ? "Choose where you are working, at the top of the page, to record returns."
          : "Your account has no home location. Ask an admin to set one."}
      </p>
    );
  }

  const [reasons, outPage, returnedPage] = await Promise.all([
    listVoidReasons(),
    listOutAtLocationPage(workLocationId, parsePage(sp.opage)),
    listReturnedAtLocationPage(workLocationId, parsePage(sp.rpage)),
  ]);
  // The out list already has one row per bottle.
  const bottles = outPage.rows;
  const returned = returnedPage.rows;

  return (
    <div className="flex flex-col gap-6">
      <ReturnForms
        // A new working location starts the forms over, so an open pop-up never acts at the old place.
        key={workLocationId}
        header={
          <>
            <h1 className="text-[22px] font-bold tracking-tight">Return</h1>
            <p className="mt-1 text-sm text-zinc-500">Bring an issued bottle back and say what happened to it.</p>
          </>
        }
        reasons={reasons.filter((r) => r.active).map((r) => ({ code: r.code, label: r.label }))}
        workLocationId={workLocationId}
      />

      <ReturnTabs
        outCount={outPage.total}
        returnedCount={returnedPage.total}
        initialTab={sp.rpage && !sp.opage ? "returned" : "out"}
        out={
      <section className="overflow-x-auto rounded-xl border border-line bg-surface px-2 py-1">
        <table className={tableClass}>
          <thead>
            <tr>
              <th className={thClass}>Patient</th>
              <th className={thClass}>Bottle</th>
              <th className={thClass} />
            </tr>
          </thead>
          <tbody>
            {bottles.map((r) => (
              <tr key={r.serial} className="relative hover:bg-black/[0.03]">
                <td className={`${tdClass} font-mono`}>{r.patientHospitalNo ?? "-"}</td>
                <td className={tdClass}>
                  <Link href={`/distribution/issue/${encodeURIComponent(r.serial)}`} className="font-mono underline after:absolute after:inset-0 after:content-['']">
                    {r.serial}
                  </Link>
                </td>
                <td className={tdClass}>
                  <Link href={`/distribution/issue/${encodeURIComponent(r.serial)}`} className="relative z-10 underline">
                    Open
                  </Link>
                </td>
              </tr>
            ))}
            {bottles.length === 0 ? (
              <tr>
                <td className={tdClass} colSpan={3}>
                  Nothing is out.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
        <Pagination info={outPage} pathname="/distribution/return" params={{ rpage: sp.rpage }} param="opage" noun="bottles" />
      </section>
        }
        returned={
      <section className="overflow-x-auto rounded-xl border border-line bg-surface px-2 py-1">
        <table className={tableClass}>
          <thead>
            <tr>
              <th className={thClass}>Patient</th>
              <th className={thClass}>Bottle</th>
              <th className={thClass}>What happened</th>
              <th className={thClass}>Returned</th>
              <th className={thClass} />
            </tr>
          </thead>
          <tbody>
            {returned.map((r) => (
              <tr key={r.eventId} className="relative hover:bg-black/[0.03]">
                <td className={`${tdClass} font-mono`}>{r.patientHospitalNo ?? "-"}</td>
                <td className={`${tdClass} font-mono`}>{r.serial}</td>
                <td className={tdClass}>{OUTCOME_LABEL[r.outcome] ?? r.outcome}</td>
                <td className={tdClass}>{r.returnedAt.toLocaleString("en-GB")}</td>
                <td className={tdClass}>
                  <Link href={`/distribution/issue/${encodeURIComponent(r.serial)}`} className="underline">
                    Open
                  </Link>
                </td>
              </tr>
            ))}
            {returned.length === 0 ? (
              <tr>
                <td className={tdClass} colSpan={5}>
                  Nothing has been returned yet.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
        <Pagination info={returnedPage} pathname="/distribution/return" params={{ opage: sp.opage }} param="rpage" noun="returns" />
      </section>
        }
      />
    </div>
  );
}
