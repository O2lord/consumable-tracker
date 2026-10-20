import Link from "next/link";
import { listCountableBatches, getOpenCount, listCountsPage } from "@/server/services/stock-count.service";
import { COUNT_STATUS_LABEL } from "@/types/stock-counts";
import { ActionForm } from "@/components/forms/ActionForm";
import { FormDialog } from "@/components/forms/FormDialog";
import { Field } from "@/components/ui/Field";
import { Tag } from "@/components/ui/Tag";
import { Pagination } from "@/components/ui/Pagination";
import { inputClass, tableClass, tdClass, thClass } from "@/components/ui/styles";
import { submitCountAction } from "../counts/actions";

const when = (d: Date) => d.toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" });

/** The history of counts for one location, with a button that opens the count sheet in a pop-up. Shown as a tab on the Stock page. */
export async function CountTab({
  locationId,
  page = 1,
  keep = {},
}: {
  locationId: string;
  page?: number;
  /** Other query values the page links must carry (the location and the other lists' pages). */
  keep?: Record<string, string | undefined>;
}) {
  const [open, batches, historyPage] = await Promise.all([
    getOpenCount(locationId),
    listCountableBatches(locationId),
    listCountsPage(locationId, page),
  ]);
  const history = historyPage.rows;

  const nothingToCount = batches.length === 0;

  return (
    <div className="flex flex-col gap-6">
      {open ? (
        <p className="max-w-3xl rounded-xl border border-line bg-warn-soft p-4 text-sm">
          A count from {when(open.countedAt)} is waiting to be posted.{" "}
          <Link href={`/distribution/counts/${open.id}`} className="font-semibold underline">
            Open it
          </Link>{" "}
          to post it or cancel it before starting another.
        </p>
      ) : nothingToCount ? (
        <p className="max-w-3xl rounded-xl border border-line bg-surface p-4 text-sm">
          Nothing to count here: no bulk batches (sealed packs or loose pieces) are on the books at this location.
        </p>
      ) : null}

      <FormDialog
        header={
          <div>
            <h2 className="text-base font-semibold">Count history</h2>
            <p className="mt-1 text-sm text-zinc-500">Counts done at this location, newest first. Open one to see its figures.</p>
          </div>
        }
        buttonLabel="New stock count"
        title="New stock count"
        wide
        disabled={Boolean(open) || nothingToCount}
        intro={
          <p className="max-w-3xl">
            Count what is physically on the shelf for each bulk item and enter it here. The system does not show what it
            expects until you submit, so count first. Leave a box blank to skip it. Anything that differs is explained
            and posted on the next page. Enter <strong>sealed packs</strong> and <strong>loose pieces</strong> in their
            own boxes: a pack that has been opened and partly used is not a sealed pack, so count its pieces in the
            pieces box.
          </p>
        }
      >
        <ActionForm
          key={locationId}
          action={submitCountAction}
          submitLabel="Submit count"
          resetOnSuccess={false}
          className="flex flex-col gap-4"
        >
          <input type="hidden" name="locationId" value={locationId} />
          <section className="overflow-x-auto rounded-xl border border-line bg-surface px-2 py-1">
            <table className={tableClass}>
              <thead>
                <tr>
                  <th className={thClass}>Item</th>
                  <th className={thClass}>Batch</th>
                  <th className={thClass}>Lot</th>
                  <th className={thClass}>Expires</th>
                  <th className={thClass}>Sealed packs / units</th>
                  <th className={thClass}>Loose pieces</th>
                </tr>
              </thead>
              <tbody>
                {batches.map((b) => (
                  <tr key={b.batchId}>
                    <td className={tdClass}>
                      {b.itemName} <span className="text-xs text-zinc-500">({b.unit})</span>
                      <input type="hidden" name="batchId" value={b.batchId} />
                    </td>
                    <td className={`${tdClass} font-mono`}>{b.batchCode}</td>
                    <td className={tdClass}>{b.lotNo ?? "-"}</td>
                    <td className={tdClass}>{b.expiryDate ?? "-"}</td>
                    <td className={tdClass}>
                      <input
                        name="counted"
                        type="number"
                        inputMode="numeric"
                        min={0}
                        step={1}
                        aria-label={`Sealed packs counted ${b.itemName} ${b.batchCode}`}
                        className={`${inputClass} w-28`}
                      />
                    </td>
                    <td className={tdClass}>
                      {b.acceptsPieces ? (
                        <input
                          name="countedPieces"
                          type="number"
                          inputMode="numeric"
                          min={0}
                          step={1}
                          aria-label={`Loose pieces counted ${b.itemName} ${b.batchCode}`}
                          className={`${inputClass} w-28`}
                        />
                      ) : (
                        <>
                          {/* Keeps the pieces list lined up with the batch list when an item has no pieces. */}
                          <input type="hidden" name="countedPieces" value="" />
                          <span className="text-zinc-400">-</span>
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
          <div className="max-w-xl">
            <Field label="Note (optional)">
              <textarea name="note" rows={2} maxLength={500} className={inputClass} />
            </Field>
          </div>
        </ActionForm>
      </FormDialog>

      <div className="overflow-x-auto rounded-xl border border-line bg-surface px-2 py-1">
        <table className={tableClass}>
          <thead>
            <tr>
              <th className={thClass}>When</th>
              <th className={thClass}>Counted by</th>
              <th className={thClass}>Lines</th>
              <th className={thClass}>Differences</th>
              <th className={thClass}>Status</th>
            </tr>
          </thead>
          <tbody>
            {history.map((c) => (
              <tr key={c.id} className="relative hover:bg-black/[0.03]">
                <td className={tdClass}>
                  <Link href={`/distribution/counts/${c.id}`} className="underline after:absolute after:inset-0 after:content-['']">
                    {when(c.countedAt)}
                  </Link>
                </td>
                <td className={tdClass}>{c.countedByName}</td>
                <td className={tdClass}>{c.lineCount}</td>
                <td className={tdClass}>{c.varianceLines}</td>
                <td className={tdClass}>
                  <Tag tone={c.status === "POSTED" ? "ok" : c.status === "OPEN" ? "warn" : "brand"}>
                    {COUNT_STATUS_LABEL[c.status] ?? c.status}
                  </Tag>
                </td>
              </tr>
            ))}
            {history.length === 0 ? (
              <tr>
                <td className={tdClass} colSpan={5}>
                  No counts yet.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
        <Pagination info={historyPage} pathname="/distribution/stock" params={{ ...keep, tab: "count" }} param="cpage" noun="counts" />
      </div>
    </div>
  );
}
