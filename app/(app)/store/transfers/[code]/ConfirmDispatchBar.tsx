import { ActionForm } from "@/components/forms/ActionForm";
import { Combobox } from "@/components/ui/Dropdown";
import { Field } from "@/components/ui/Field";
import { inputClass, panelClass } from "@/components/ui/styles";
import { confirmTransferAction } from "./actions";

interface Props {
  transferId: string;
  code: string;
  /** Bottles and whole bulk units on the draft right now. */
  total: number;
  /** Loose pieces on the draft right now. Not added to `total`, because the two are different units. */
  pieceTotal: number;
  pharmacyQuantity: number | null;
  /** Names recently typed as carrier, offered as suggestions to save typing. */
  recentCarriers: readonly string[];
}

/**
 * The bar at the bottom of a draft transfer. Nothing is dispatched until this is confirmed, and the
 * button stays greyed out while the draft is empty. The store keeper types who is carrying the stock;
 * it cannot be changed afterwards.
 */
export function ConfirmDispatchBar({ transferId, code, total, pieceTotal, pharmacyQuantity, recentCarriers }: Props) {
  // A draft with loose pieces is not compared to the Pharmacy quantity (the server skips that check too).
  const needsExplanation = pharmacyQuantity !== null && pieceTotal === 0 && pharmacyQuantity !== total;
  const empty = total === 0 && pieceTotal === 0;

  return (
    <section className={`${panelClass} flex flex-col gap-4`}>
      <div className="text-[15px]">
        <p>Nothing leaves the store until you confirm.</p>
        {pharmacyQuantity !== null ? (
          <p className="mt-0.5 text-sm text-zinc-500">Pharmacy transfer quantity: {pharmacyQuantity}.</p>
        ) : null}
      </div>
      <ActionForm
        action={confirmTransferAction}
        submitLabel="Confirm dispatch"
        resetOnSuccess={false}
        confirm="Confirm dispatch? The bottles will be marked in transit."
        disabled={empty}
        className="flex flex-wrap items-end gap-3"
        buttonClassName="rounded-lg border border-transparent bg-brand px-6 py-2 font-semibold text-brand-ink hover:brightness-95 disabled:cursor-not-allowed disabled:opacity-40"
      >
        <input type="hidden" name="transferId" value={transferId} />
        <input type="hidden" name="code" value={code} />
        <Field label="Carried by">
          <Combobox name="carriedByName" required suggestions={recentCarriers} defaultValue="" wrapperClassName="w-72 max-w-full" />
        </Field>
        {needsExplanation ? (
          <Field label="Why does the total differ from Pharmacy?">
            <input name="explanation" required minLength={3} maxLength={500} className={inputClass} />
          </Field>
        ) : null}
        {/* Hints sit on their own line under the row, so the button lines up with the inputs. */}
        <p className="order-last basis-full text-sm text-muted">
          Name of the person taking this stock. It cannot be changed after dispatch.
          {needsExplanation ? ` You scanned ${total} but Pharmacy says ${pharmacyQuantity}. Explain before dispatching.` : ""}
        </p>
      </ActionForm>
    </section>
  );
}
