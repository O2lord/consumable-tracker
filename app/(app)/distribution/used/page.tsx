import { requirePermission } from "@/server/auth/session";
import { canWorkAtAnyLocation } from "@/server/auth/permissions";
import { listActiveItemTypes, listActiveLocations } from "@/server/services/catalog.service";
import { MAX_BACKDATE_DAYS, listBenchAvailability, listLabUsagePage } from "@/server/services/lab-usage.service";
import { tableClass, tdClass, thClass } from "@/components/ui/styles";
import { Pagination } from "@/components/ui/Pagination";
import { parsePage } from "@/lib/pagination";
import { canSwitchUnit, perTestUnit } from "@/lib/pack-size";
import { FormDialog } from "@/components/forms/FormDialog";
import { UsedForm } from "./UsedForm";

export const metadata = { title: "Used for test" };

const isoDay = (d: Date) => d.toISOString().slice(0, 10);

export default async function UsedPage({ searchParams }: { searchParams: Promise<{ page?: string }> }) {
  const session = await requirePermission("record_usage");
  const sp = await searchParams;
  const isSupervisor = canWorkAtAnyLocation(session.role);

  if (!isSupervisor && !session.homeLocationId) {
    return (
      <p className="max-w-xl rounded-xl border border-line bg-surface p-4 text-sm">
        Your account has no home location, so you cannot record usage. Ask an admin to set one.
      </p>
    );
  }

  const [locations, itemTypes, recentPage, availability] = await Promise.all([
    isSupervisor ? listActiveLocations() : Promise.resolve(undefined),
    listActiveItemTypes(),
    // Supervisors and admins see entries from everywhere (with a Where column); everyone else sees their own location.
    listLabUsagePage(isSupervisor ? undefined : (session.homeLocationId as string), parsePage(sp.page)),
    // What is on the shelf now, per item and location, so the form can show it as soon as an item is picked.
    listBenchAvailability(),
  ]);

  const recent = recentPage.rows;

  // Bench supplies only: cotton wool, gloves, AHG reagent and the like. Items used per patient are issued with the
  // patient on Issue, and serialized bottles are scanned.
  const benchItems = itemTypes
    .filter((i) => i.trackingMode === "QUANTITY" && i.benchSupply)
    .map((i) => ({
      id: i.id,
      name: i.name,
      unit: perTestUnit(i.unitOfMeasure, i.packSize),
      packSize: i.packSize,
      canSwitch: canSwitchUnit(i.unitOfMeasure, i.packSize),
    }));

  const now = new Date();
  const earliest = new Date(now);
  earliest.setUTCDate(earliest.getUTCDate() - MAX_BACKDATE_DAYS);

  return (
    <div className="flex flex-col gap-6">
      <FormDialog
        buttonLabel="Record usage"
        header={
          <div className="max-w-2xl">
            <h1 className="text-[22px] font-bold tracking-tight">Used for test</h1>
            <p className="mt-1 text-sm text-zinc-500">
              What the lab used at the bench, newest first. Items used per patient are issued with the patient on Issue,
              and breakage or spoilage goes through Void.
            </p>
          </div>
        }
        intro="At the end of the day, record what the lab used at the bench, for example 1 pack of cotton wool, 10 AHG. There is no patient and nothing to scan. It comes off the shelf, and stock counts then show whether the shelf matches."
      >
        <UsedForm
          locations={locations?.map((l) => ({ id: l.id, name: l.name }))}
          defaultLocationId={session.homeLocationId ?? undefined}
          benchItems={benchItems}
          availability={availability}
          today={isoDay(now)}
          earliest={isoDay(earliest)}
        />
      </FormDialog>

      <section className="overflow-x-auto rounded-xl border border-line bg-surface px-2 py-1">
        <h2 className="mb-2 font-medium">{isSupervisor ? "Recently recorded" : "Recently recorded here"}</h2>
        <table className={tableClass}>
          <thead>
            <tr>
              <th className={thClass}>Used on</th>
              <th className={thClass}>Item</th>
              <th className={thClass}>Quantity</th>
              <th className={thClass}>For</th>
              {isSupervisor ? <th className={thClass}>Where</th> : null}
              <th className={thClass}>Entered by</th>
            </tr>
          </thead>
          <tbody>
            {recent.map((r) => (
              <tr key={r.id}>
                <td className={tdClass}>{r.usedOn ?? "-"}</td>
                <td className={tdClass}>{r.itemName}</td>
                <td className={tdClass}>
                  {r.quantity.toLocaleString("en-GB")}
                  {r.inPieces ? " pieces" : ""}
                </td>
                <td className={tdClass}>{r.section ?? "-"}</td>
                {isSupervisor ? <td className={tdClass}>{r.locationName}</td> : null}
                <td className={tdClass}>{r.enteredByName}</td>
              </tr>
            ))}
            {recent.length === 0 ? (
              <tr>
                <td className={tdClass} colSpan={isSupervisor ? 6 : 5}>
                  Nothing recorded yet.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
        <Pagination info={recentPage} pathname="/distribution/used" noun="entries" />
      </section>
    </div>
  );
}
