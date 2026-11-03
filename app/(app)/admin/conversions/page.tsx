import { requirePermission } from "@/server/auth/session";
import { listActiveItemTypes } from "@/server/services/catalog.service";
import { listRecipes, type AdminRecipe } from "@/server/services/conversion.service";
import { ActionForm } from "@/components/forms/ActionForm";
import { FormDialog, RowFormDialog } from "@/components/forms/FormDialog";
import { Field } from "@/components/ui/Field";
import { inputClass, tableClass, tdClass, thClass } from "@/components/ui/styles";
import { createRecipeAction, setRecipeActiveAction, updateRecipeAction } from "./actions";

export const metadata = { title: "Conversions" };

type ItemOption = Awaited<ReturnType<typeof listActiveItemTypes>>[number];

export default async function ConversionRecipesPage() {
  await requirePermission("manage_conversions");
  const [rows, allItems] = await Promise.all([listRecipes(), listActiveItemTypes()]);
  // Only plain counted items can be taken or made. The service checks the rest and explains any refusal.
  const items = allItems.filter((i) => i.trackingMode === "QUANTITY" && i.testsPerUnit === null);

  return (
    <div className="flex flex-col gap-6">
      <FormDialog
        buttonLabel="Add recipe"
        title="Add a conversion recipe"
        header={
          <>
            <h1 className="text-[22px] font-bold tracking-tight">Conversions</h1>
            <p className="mt-1 text-sm text-zinc-500">
              What a lab can turn into what, at a fixed ratio. The scientist enters only how much to take; the amount
              made, the expiry date and the code are worked out. A recipe that has been used keeps its items and ratio,
              so turn it off and add a new one to change them.
            </p>
          </>
        }
      >
        <ActionForm action={createRecipeAction} submitLabel="Add recipe">
          <Field label="Code" hint="For example FORMALIN-10. It cannot be changed later.">
            <input name="code" required className={inputClass} autoCapitalize="characters" />
          </Field>
          <RecipeFields items={items} />
        </ActionForm>
      </FormDialog>

      <section className="overflow-x-auto rounded-xl border border-line bg-surface px-2 py-1">
        <table className={tableClass}>
          <thead>
            <tr>
              <th className={thClass}>Code</th>
              <th className={thClass}>Name</th>
              <th className={thClass}>Takes</th>
              <th className={thClass}>Makes</th>
              <th className={thClass}>Ratio</th>
              <th className={thClass}>Shelf life</th>
              <th className={thClass}>Used</th>
              <th className={thClass}>Status</th>
              <th className={thClass}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td className={tdClass} colSpan={9}>
                  No recipes yet. Add one, for example 1 mL of concentrated formalin makes 10 mL of the 10% solution.
                </td>
              </tr>
            ) : null}
            {rows.map((row) => (
              <tr key={row.id}>
                <td className={tdClass}>{row.code}</td>
                <td className={tdClass}>{row.name}</td>
                <td className={tdClass}>{row.inputItemName}</td>
                <td className={tdClass}>{row.outputItemName}</td>
                <td className={tdClass}>
                  {row.inputAmount.toLocaleString("en-GB")} : {row.outputAmount.toLocaleString("en-GB")} {row.measureLabel}
                </td>
                <td className={tdClass}>{row.shelfLifeDays === null ? "Does not expire" : `${row.shelfLifeDays} days`}</td>
                <td className={tdClass}>{row.conversionCount.toLocaleString("en-GB")}</td>
                <td className={tdClass}>{row.active ? "Active" : "Off"}</td>
                <td className={tdClass}>
                  <div className="flex flex-nowrap items-center gap-2 whitespace-nowrap">
                    <RowFormDialog buttonLabel="Edit" title={`Edit ${row.code}`}>
                      <ActionForm action={updateRecipeAction} submitLabel="Save" resetOnSuccess={false}>
                        <input type="hidden" name="id" value={row.id} />
                        <RecipeFields items={items} row={row} />
                      </ActionForm>
                    </RowFormDialog>
                    <ActionForm
                      action={setRecipeActiveAction}
                      submitLabel={row.active ? "Turn off" : "Turn on"}
                      compact
                      className="flex items-center"
                      confirm={row.active ? `Turn off ${row.code}? Labs will no longer be able to use it.` : undefined}
                      danger={row.active}
                    >
                      <input type="hidden" name="id" value={row.id} />
                      <input type="hidden" name="active" value={row.active ? "false" : "true"} />
                    </ActionForm>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}

function ItemSelect({ name, items, defaultValue }: { name: string; items: ItemOption[]; defaultValue?: string }) {
  return (
    <select name={name} required defaultValue={defaultValue ?? ""} className={inputClass}>
      <option value="" disabled>
        Choose an item
      </option>
      {items.map((i) => (
        <option key={i.id} value={i.id}>
          {i.name} ({i.unitOfMeasure}
          {i.packSize > 1 ? `, pack of ${i.packSize.toLocaleString("en-GB")}` : ""})
        </option>
      ))}
    </select>
  );
}

/** The fields shared by Add and Edit. Once a recipe has been used, its items and ratio are shown but cannot be changed. */
function RecipeFields({ items, row }: { items: ItemOption[]; row?: AdminRecipe }) {
  const locked = row !== undefined && row.conversionCount > 0;
  return (
    <>
      <Field label="Name" hint="For example Formalin 10% from concentrate">
        <input name="name" required defaultValue={row?.name} className={inputClass} />
      </Field>

      {locked ? (
        <>
          <input type="hidden" name="inputItemTypeId" value={row.inputItemTypeId} />
          <input type="hidden" name="outputItemTypeId" value={row.outputItemTypeId} />
          <input type="hidden" name="inputAmount" value={row.inputAmount} />
          <input type="hidden" name="outputAmount" value={row.outputAmount} />
          <p className="rounded-lg border border-line bg-surface px-3 py-2 text-sm text-zinc-500">
            Takes {row.inputItemName}, makes {row.outputItemName} at {row.inputAmount.toLocaleString("en-GB")} :{" "}
            {row.outputAmount.toLocaleString("en-GB")}. This recipe has been used for{" "}
            {row.conversionCount.toLocaleString("en-GB")} {row.conversionCount === 1 ? "conversion" : "conversions"}, so
            these cannot change. Turn it off and add a new recipe instead.
          </p>
        </>
      ) : (
        <>
          <Field label="Item that is taken" hint="The concentrate. A 1 L bottle counts as 1,000 mL, so enter amounts in mL.">
            <ItemSelect name="inputItemTypeId" items={items} defaultValue={row?.inputItemTypeId} />
          </Field>
          <Field label="Item that is made" hint="Counted in one plain unit, such as an item in mL with pack size 1.">
            <ItemSelect name="outputItemTypeId" items={items} defaultValue={row?.outputItemTypeId} />
          </Field>
          <Field label="Takes" hint="1 : 10 means every 1 of the input makes 10 of the output.">
            <input name="inputAmount" type="number" min={1} step={1} required defaultValue={row?.inputAmount ?? 1} className={inputClass} />
          </Field>
          <Field label="Makes">
            <input name="outputAmount" type="number" min={1} step={1} required defaultValue={row?.outputAmount} className={inputClass} />
          </Field>
        </>
      )}

      <Field label="Unit" hint="The word shown beside the amounts, for example mL. It never changes a quantity.">
        <input name="measureLabel" required maxLength={20} defaultValue={row?.measureLabel ?? "mL"} className={inputClass} />
      </Field>
      <Field label="Shelf life (days, optional)" hint="Days from the day of conversion. Never later than the concentrate's own expiry. Leave empty if it does not expire.">
        <input name="shelfLifeDays" type="number" min={1} step={1} defaultValue={row?.shelfLifeDays ?? ""} className={inputClass} />
      </Field>
    </>
  );
}
