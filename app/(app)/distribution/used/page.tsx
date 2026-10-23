import { requirePermission } from "@/server/auth/session";
import { canWorkAtAnyLocation } from "@/server/auth/permissions";
import { listActiveItemTypes } from "@/server/services/catalog.service";
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
  // Where the person is working: set in the app bar (a supervisor's choice, or everyone else's home location).
  const workLocationId = session.workLocationId;

  if (!workLocationId) {
    return (
      <p className="max-w-xl rounded-xl border border-line bg-surface p-4 text-sm">
        {canWorkAtAnyLocation(session.role)
          ? "Choose where you are working, at the top of the page, to record usage."
          : "Your account has no home location, so you cannot record usage. Ask an admin to set one."}
      </p>
    );
  }

  const [itemTypes, recentPage, availability] = await Promise.all([
    listActiveItemTypes(),
    listLabUsagePage(workLocationId, parsePage(sp.page)),
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
        // A new working location starts the pop-up over, so it never records at the old place.
        key={workLocationId}
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
          workLocationId={workLocationId}
          benchItems={benchItems}
          availability={availability}
          today={isoDay(now)}
          earliest={isoDay(earliest)}
        />
      </FormDialog>

      <section className="overflow-x-auto rounded-xl border border-line bg-surface px-2 py-1">
        <h2 className="mb-2 font-medium">Recently recorded here</h2>
        <table className={tableClass}>
          <thead>
            <tr>
              <th className={thClass}>Used on</th>
              <th className={thClass}>Item</th>
              <th className={thClass}>Quantity</th>
              <th className={thClass}>For</th>
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
                <td className={tdClass}>{r.enteredByName}</td>
              </tr>
            ))}
            {recent.length === 0 ? (
              <tr>
                <td className={tdClass} colSpan={5}>
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
