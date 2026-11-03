import { requirePermission } from "@/server/auth/session";
import { can, canWorkAtAnyLocation } from "@/server/auth/permissions";
import {
  listActiveRecipes,
  listConversionAvailability,
  listConversionsPage,
} from "@/server/services/conversion.service";
import { tableClass, tdClass, thClass } from "@/components/ui/styles";
import { Pagination } from "@/components/ui/Pagination";
import { parsePage } from "@/lib/pagination";
import { formatDay } from "@/lib/dashboard";
import { FormDialog } from "@/components/forms/FormDialog";
import { LabelButtons } from "@/app/(app)/store/stock-in/LabelButtons";
import { ConversionForm } from "./ConversionForm";
import { VoidConversionButton } from "./VoidConversionButton";

export const metadata = { title: "Conversion" };

const n = (v: number) => v.toLocaleString("en-GB");

export default async function ConversionPage({ searchParams }: { searchParams: Promise<{ page?: string }> }) {
  const session = await requirePermission("record_conversion");
  const sp = await searchParams;
  // Where the person is working: set in the app bar (a supervisor's choice, or everyone else's home location).
  const workLocationId = session.workLocationId;

  if (!workLocationId) {
    return (
      <p className="max-w-xl rounded-xl border border-line bg-surface p-4 text-sm">
        {canWorkAtAnyLocation(session.role)
          ? "Choose where you are working, at the top of the page, to record a conversion."
          : "Your account has no home location, so you cannot record a conversion. Ask an admin to set one."}
      </p>
    );
  }

  const [recipes, availability, recentPage] = await Promise.all([
    listActiveRecipes(),
    // What the shelf holds now, per input item and location, so the form can show it as soon as a recipe is picked.
    listConversionAvailability(),
    listConversionsPage(workLocationId, parsePage(sp.page)),
  ]);

  const canVoid = can(session.role, "void");

  return (
    <div className="flex flex-col gap-6">
      <FormDialog
        // A new working location starts the pop-up over, so it never records at the old place.
        key={workLocationId}
        buttonLabel="New conversion"
        disabled={recipes.length === 0}
        header={
          <div className="max-w-2xl">
            <h1 className="text-[22px] font-bold tracking-tight">Conversion</h1>
            <p className="mt-1 text-sm text-zinc-500">
              Turn stock held here into another item by a fixed recipe, for example concentrated formalin into the 10%
              working solution. Newest first.
            </p>
            {recipes.length === 0 ? (
              <p className="mt-2 text-sm text-zinc-500">
                There are no recipes yet. An admin adds them under Admin &gt; Conversions.
              </p>
            ) : null}
          </div>
        }
        intro="Pick a recipe and type how much to take. The amount made, the expiry date and the label code are worked out for you. The amount taken comes off the shelf here and the result goes onto it."
      >
        <ConversionForm
          workLocationId={workLocationId}
          availability={availability}
          recipes={recipes.map((r) => ({
            id: r.id,
            name: r.name,
            inputItemTypeId: r.inputItemTypeId,
            inputItemName: r.inputItemName,
            outputItemName: r.outputItemName,
            inputAmount: r.inputAmount,
            outputAmount: r.outputAmount,
            measureLabel: r.measureLabel,
            shelfLifeDays: r.shelfLifeDays,
          }))}
        />
      </FormDialog>

      <section className="overflow-x-auto rounded-xl border border-line bg-surface px-2 py-1">
        <h2 className="mb-2 font-medium">Recently converted here</h2>
        <table className={tableClass}>
          <thead>
            <tr>
              <th className={thClass}>When</th>
              <th className={thClass}>Code</th>
              <th className={thClass}>Took</th>
              <th className={thClass}>Made</th>
              <th className={thClass}>Expires</th>
              <th className={thClass}>Converted by</th>
              <th className={thClass}>Label</th>
              <th className={thClass}>Status</th>
            </tr>
          </thead>
          <tbody>
            {recentPage.rows.map((r) => (
              <tr key={r.id} className={r.voidedAt ? "text-muted" : undefined}>
                <td className={tdClass}>{r.convertedAt.toLocaleString("en-GB")}</td>
                <td className={tdClass}>
                  <span className="font-mono">{r.code}</span>
                  <span className="block text-xs text-muted">{r.recipeName}</span>
                  {r.note ? <span className="block text-xs text-muted">{r.note}</span> : null}
                </td>
                <td className={tdClass}>
                  {n(r.inputQuantity)} {r.measureLabel}
                  <span className="block text-xs text-muted">{r.inputItemName}</span>
                </td>
                <td className={tdClass}>
                  {n(r.outputQuantity)} {r.measureLabel}
                  <span className="block text-xs text-muted">
                    {r.outputItemName}, batch {r.outputBatchCode}
                  </span>
                </td>
                <td className={tdClass}>{r.expiryDate ? formatDay(r.expiryDate) : "Does not expire"}</td>
                <td className={tdClass}>{r.convertedByName}</td>
                <td className={tdClass}>
                  {r.voidedAt ? (
                    "-"
                  ) : (
                    <LabelButtons batch={r.outputBatchCode} only="batch" label="Print label" single />
                  )}
                </td>
                <td className={tdClass}>
                  {r.voidedAt ? (
                    <>
                      <span className="font-medium">Voided</span> {r.voidedAt.toLocaleString("en-GB")}
                      {r.voidReason ? <span className="block text-xs">{r.voidReason}</span> : null}
                    </>
                  ) : canVoid ? (
                    <VoidConversionButton
                      conversionId={r.id}
                      code={r.code}
                      workLocationId={workLocationId}
                      tookText={`${n(r.inputQuantity)} ${r.measureLabel} of ${r.inputItemName}`}
                      madeText={`${n(r.outputQuantity)} ${r.measureLabel} of ${r.outputItemName}`}
                    />
                  ) : null}
                </td>
              </tr>
            ))}
            {recentPage.rows.length === 0 ? (
              <tr>
                <td className={tdClass} colSpan={8}>
                  Nothing converted yet.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
        <Pagination info={recentPage} pathname="/lab/conversion" noun="conversions" />
      </section>
    </div>
  );
}
