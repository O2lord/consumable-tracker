import Link from "next/link";
import { requirePermission } from "@/server/auth/session";
import { canWorkAtAnyLocation } from "@/server/auth/permissions";
import { listActiveLocations, listVoidReasons } from "@/server/services/catalog.service";
import { listVoidedAtLocationPage } from "@/server/services/stock.service";
import { tableClass, tdClass, thClass } from "@/components/ui/styles";
import { Pagination } from "@/components/ui/Pagination";
import { parsePage } from "@/lib/pagination";
import { VoidForms } from "./VoidForms";

export const metadata = { title: "Void" };

export default async function VoidPage({ searchParams }: { searchParams: Promise<{ page?: string }> }) {
  const session = await requirePermission("void");
  const sp = await searchParams;
  const isSupervisor = canWorkAtAnyLocation(session.role);

  if (!isSupervisor && !session.homeLocationId) {
    return (
      <p className="max-w-xl rounded-xl border border-line bg-surface p-4 text-sm">
        Your account has no home location. Ask an admin to set one.
      </p>
    );
  }

  const [reasons, locations, voidedPage] = await Promise.all([
    listVoidReasons(),
    isSupervisor ? listActiveLocations() : Promise.resolve(undefined),
    listVoidedAtLocationPage(session.homeLocationId ?? null, parsePage(sp.page)),
  ]);
  const voided = voidedPage.rows;
  const reasonLabel = new Map(reasons.map((r) => [r.code, r.label]));

  return (
    <div className="flex flex-col gap-6">
      <VoidForms
      header={
        <>
          <h1 className="text-[22px] font-bold tracking-tight">Void</h1>
          <p className="mt-1 text-sm text-zinc-500">
            Use this for stock that is expired or damaged on the shelf, or a bottle whose investigation was cancelled.
            A bottle that came back from a patient goes through Return instead.
          </p>
        </>
      }
      reasons={reasons.filter((r) => r.active).map((r) => ({ code: r.code, label: r.label }))}
      locations={locations?.map((l) => ({ id: l.id, name: l.name }))}
      defaultLocationId={session.homeLocationId ?? undefined}
      />

      <section className="flex flex-col gap-2">
        <h2 className="text-base font-semibold">Recently voided</h2>
        <div className="overflow-x-auto rounded-xl border border-line bg-surface px-2 py-1">
          <table className={tableClass}>
            <thead>
              <tr>
                <th className={thClass}>Bottle</th>
                <th className={thClass}>Item</th>
                <th className={thClass}>Reason</th>
                <th className={thClass}>Voided from</th>
                <th className={thClass}>When</th>
                <th className={thClass} />
              </tr>
            </thead>
            <tbody>
              {voided.map((r) => (
                <tr key={r.eventId} className="hover:bg-black/[0.03]">
                  <td className={`${tdClass} font-mono`}>{r.serial}</td>
                  <td className={tdClass}>{r.itemName}</td>
                  <td className={tdClass}>{(r.reasonCode && reasonLabel.get(r.reasonCode)) || r.reasonCode || "-"}</td>
                  <td className={tdClass}>{r.fromState === "ISSUED" ? "Returned by a patient" : "On the shelf"}</td>
                  <td className={tdClass}>{r.voidedAt.toLocaleString("en-GB")}</td>
                  <td className={tdClass}>
                    <Link href={`/reports/bottle/${encodeURIComponent(r.serial)}`} className="underline">
                      History
                    </Link>
                  </td>
                </tr>
              ))}
              {voided.length === 0 ? (
                <tr>
                  <td className={tdClass} colSpan={6}>
                    Nothing has been voided yet.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
          <Pagination info={voidedPage} pathname="/distribution/void" noun="voided bottles" />
        </div>
      </section>
    </div>
  );
}
