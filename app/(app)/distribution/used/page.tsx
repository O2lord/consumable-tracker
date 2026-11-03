import { requirePermission } from "@/server/auth/session";
import { canWorkAtAnyLocation } from "@/server/auth/permissions";
import { listActiveItemTypes } from "@/server/services/catalog.service";
import {
  MAX_BACKDATE_DAYS,
  listBenchAvailability,
  listLabUsagePage,
  listLabelledContainers,
  listOpenContainerTests,
} from "@/server/services/lab-usage.service";
import { tableClass, tdClass, thClass } from "@/components/ui/styles";
import { Pagination } from "@/components/ui/Pagination";
import { parsePage } from "@/lib/pagination";
import { canSwitchUnit, perTestUnit } from "@/lib/pack-size";
import { usageReasonLabel } from "@/lib/usage-reasons";
import { FormDialog } from "@/components/forms/FormDialog";
import { UsedForm } from "./UsedForm";

export const metadata = { title: "Used for test" };

const isoDay = (d: Date) => d.toISOString().slice(0, 10);

type UsageRow = Awaited<ReturnType<typeof listLabUsagePage>>["rows"][number];

interface UsageGroup {
  key: string;
  usedOn: string | null;
  itemName: string;
  section: string | null;
  enteredByName: string;
  /** True for a reagent counted in tests. */
  tests: boolean;
  /** Tests done (patient tests), or the quantity for any other item. */
  quantity: number;
  inPieces: boolean;
  /** The parts that were not patient tests, each with its reason. */
  accounted: { id: string; quantity: number; reason: string | null; note: string | null }[];
}

/** Puts the records of one entry (same time, person, item and day) into one row, keeping the newest-first order. */
function groupUsage(rows: UsageRow[]): UsageGroup[] {
  const groups = new Map<string, UsageGroup>();
  for (const r of rows) {
    const key = [r.enteredAt.getTime(), r.enteredByName, r.locationName, r.itemName, r.usedOn, r.section].join("|");
    let group = groups.get(key);
    if (!group) {
      group = {
        key,
        usedOn: r.usedOn,
        itemName: r.itemName,
        section: r.section,
        enteredByName: r.enteredByName,
        tests: r.kind !== null,
        quantity: 0,
        inPieces: r.inPieces,
        accounted: [],
      };
      groups.set(key, group);
    }
    if (r.kind === "ACCOUNTED") {
      group.accounted.push({ id: r.id, quantity: r.quantity, reason: r.reason, note: r.note });
    } else {
      group.quantity += r.quantity;
    }
  }
  return [...groups.values()];
}

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

  const [itemTypes, recentPage, availability, openTests, labelled] = await Promise.all([
    listActiveItemTypes(),
    listLabUsagePage(workLocationId, parsePage(sp.page)),
    // What is on the shelf now, per item and location, so the form can show it as soon as an item is picked.
    listBenchAvailability(),
    // Tests left in the container already open, per reagent and location.
    listOpenContainerTests(),
    // Sealed containers that have their own label, so the form knows when to ask for a scan.
    listLabelledContainers(),
  ]);

  // One entry is saved as several records (the tests done, then each part that was not a patient test, and one per batch
  // it came from), all with the same time, person, item and day. They are shown as one row, so a single entry reads as
  // a single entry: "60 tests" with "10 tests, Calibration" and "20 tests, Repeat or rerun" under it.
  const recent = groupUsage(recentPage.rows);

  // Bench supplies and reagents counted in tests: cotton wool, gloves, AHG reagent, formalin and the like. Items used
  // per patient are issued with the patient on Issue, and serialized bottles are scanned.
  const benchItems = itemTypes
    .filter((i) => i.trackingMode === "QUANTITY" && (i.benchSupply || i.testsPerUnit !== null))
    .map((i) => ({
      id: i.id,
      name: i.name,
      unit: i.testsPerUnit !== null ? "tests" : perTestUnit(i.unitOfMeasure, i.packSize),
      packSize: i.testsPerUnit ?? i.packSize,
      canSwitch: i.testsPerUnit !== null ? false : canSwitchUnit(i.unitOfMeasure, i.packSize),
      testsPerUnit: i.testsPerUnit,
      containerUnit: i.unitOfMeasure,
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
          openTests={openTests}
          labelled={labelled}
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
              <tr key={r.key}>
                <td className={tdClass}>{r.usedOn ?? "-"}</td>
                <td className={tdClass}>{r.itemName}</td>
                <td className={tdClass}>
                  {r.tests ? (
                    <>
                      {r.quantity > 0 ? (
                        <span className="block">
                          {r.quantity.toLocaleString("en-GB")} {r.quantity === 1 ? "test" : "tests"}
                        </span>
                      ) : null}
                      {r.accounted.map((a) => (
                        <span key={a.id} className="block text-xs text-muted">
                          {a.quantity.toLocaleString("en-GB")} {usageReasonLabel(a.reason)}
                          {a.note ? `: ${a.note}` : ""}
                        </span>
                      ))}
                    </>
                  ) : (
                    <>
                      {r.quantity.toLocaleString("en-GB")}
                      {r.inPieces ? " pieces" : ""}
                    </>
                  )}
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
