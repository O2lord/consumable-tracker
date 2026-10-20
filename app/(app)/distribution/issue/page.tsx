import Link from "next/link";
import { requirePermission } from "@/server/auth/session";
import { can, canWorkAtAnyLocation } from "@/server/auth/permissions";
import { listActiveItemTypes, listActiveLocations } from "@/server/services/catalog.service";
import { listIssuesPage } from "@/server/services/issue.service";
import { listStandardItemsByTest, listTests } from "@/server/services/policy.service";
import { tableClass, tdClass, thClass } from "@/components/ui/styles";
import { Pagination } from "@/components/ui/Pagination";
import { parsePage } from "@/lib/pagination";
import { perTestUnit } from "@/lib/pack-size";
import { IssueForms } from "./IssueForms";

export const metadata = { title: "Issue" };

export default async function IssuePage({ searchParams }: { searchParams: Promise<{ page?: string }> }) {
  const session = await requirePermission("issue");
  const sp = await searchParams;
  const isSupervisor = canWorkAtAnyLocation(session.role);
  const allLocations = await listActiveLocations();
  const locations = isSupervisor ? allLocations : undefined;
  const workLocationId = session.homeLocationId;
  // What the person's own location does for stock (a bench or the blood bank issues for its department only).
  const homeServiceRole = allLocations.find((l) => l.id === workLocationId)?.serviceRole ?? null;

  if (!isSupervisor && !workLocationId) {
    return (
      <p className="max-w-xl rounded-xl border border-line bg-surface p-4 text-sm">
        Your account has no home location, so you cannot issue stock. Ask an admin to set one.
      </p>
    );
  }

  // Supervisors and admins work at any location, so they see issues from everywhere (with a Where column).
  // Everyone else sees only their own location.
  // One line per bottle, however many investigations it is linked to.
  const recentPage = await listIssuesPage(isSupervisor ? undefined : (workLocationId as string), parsePage(sp.page));
  const recent = recentPage.rows;
  const colCount = 4;

  // For the items issued with a bottle: each active test with the per-patient items one run normally uses, and the
  // item types that can be added to the list. Serialized items are left out: they are scanned and issued on their own.
  // Bench supplies are left out too: the lab records them under Used for test, not per patient.
  const [allTests, standardByTest, itemTypes] = await Promise.all([
    listTests(),
    listStandardItemsByTest(),
    listActiveItemTypes(),
  ]);
  const tests = allTests
    .filter((t) => t.active)
    .map((t) => ({
      code: t.code,
      name: t.name,
      confirmed: t.consumptionConfirmed,
      items: (standardByTest.get(t.id) ?? []).map((i) => ({ itemTypeId: i.itemTypeId, quantity: i.quantity })),
    }));
  const bulkItems = itemTypes
    .filter((i) => i.trackingMode === "QUANTITY" && !i.benchSupply)
    .map((i) => ({
      id: i.id,
      name: i.name,
      unit: perTestUnit(i.unitOfMeasure, i.packSize),
    }));
  // A listed item that has since been deactivated still needs its name on the screen.
  for (const items of standardByTest.values()) {
    for (const i of items) {
      if (!bulkItems.some((b) => b.id === i.itemTypeId)) {
        bulkItems.push({
          id: i.itemTypeId,
          name: i.name,
          unit: perTestUnit(i.unitOfMeasure, i.packSize),
        });
      }
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <IssueForms
        header={
          <>
            <h1 className="text-[22px] font-bold tracking-tight">Issue</h1>
            <p className="mt-1 text-sm text-zinc-500">
              Hand a bottle to a patient. The swabs, needles and strips its test uses leave the shelf with it, linked to
              the investigation. Bench supplies such as cotton wool are recorded at the end of the day under Used for
              test.
            </p>
          </>
        }
        locations={locations?.map((l) => ({ id: l.id, name: l.name, serviceRole: l.serviceRole }))}
        defaultLocationId={workLocationId ?? undefined}
        homeServiceRole={homeServiceRole}
        canOverride={can(session.role, "approve_override")}
        tests={tests}
        bulkItems={bulkItems}
      />

      <section className="overflow-x-auto rounded-xl border border-line bg-surface px-2 py-1">
        <h2 className="mb-2 font-medium">{isSupervisor ? "Recently issued" : "Recently issued here"}</h2>
        <table className={tableClass}>
          <thead>
            <tr>
              <th className={thClass}>Patient</th>
              <th className={thClass}>Bottle</th>
              <th className={thClass}>Where</th>
              <th className={thClass} />
            </tr>
          </thead>
          <tbody>
            {recent.map((r) => (
              <tr key={r.key} className={r.serial ? "relative hover:bg-black/[0.03]" : undefined}>
                <td className={`${tdClass} font-mono`}>{r.patientHospitalNo ?? "-"}</td>
                <td className={tdClass}>
                  {r.serial ? (
                    <Link href={`/distribution/issue/${encodeURIComponent(r.serial)}`} className="font-mono underline after:absolute after:inset-0 after:content-['']">
                      {r.serial}
                    </Link>
                  ) : (
                    `${r.quantity}${r.inPieces ? " pieces of" : " x"} ${r.itemName}`
                  )}
                </td>
                <td className={tdClass}>{r.locationName}</td>
                <td className={tdClass}>
                  {r.serial ? (
                    <span className="flex gap-3">
                      <Link href={`/distribution/issue/${encodeURIComponent(r.serial)}`} className="relative z-10 underline">
                        Open
                      </Link>
                      {!r.cleared ? (
                        <a href={`/api/issues/${r.serial}/label`} target="_blank" rel="noreferrer" className="relative z-10 underline">
                          Label
                        </a>
                      ) : null}
                    </span>
                  ) : null}
                </td>
              </tr>
            ))}
            {recent.length === 0 ? (
              <tr>
                <td className={tdClass} colSpan={colCount}>
                  Nothing issued yet.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
        <Pagination info={recentPage} pathname="/distribution/issue" noun="issues" />
      </section>
    </div>
  );
}
