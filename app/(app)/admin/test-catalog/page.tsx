import { requirePermission } from "@/server/auth/session";
import { listActiveItemTypes } from "@/server/services/catalog.service";
import { listStandardItemsByTest, listTests } from "@/server/services/policy.service";
import { CONTAINER_TYPE_SUGGESTIONS } from "@/server/domain/types";
import { ActionForm } from "@/components/forms/ActionForm";
import { FormDialog, RowFormDialog } from "@/components/forms/FormDialog";
import { Field } from "@/components/ui/Field";
import { Combobox, MultiSelect } from "@/components/ui/Dropdown";
import { Tag } from "@/components/ui/Tag";
import { HoverList } from "@/components/ui/HoverList";
import { inputClass, tableClass, tdClass, thClass } from "@/components/ui/styles";
import { perTestUnit } from "@/lib/pack-size";
import { createTestAction, saveTestAction, setTestActiveAction } from "./actions";
import { StandardItemsEditor } from "./StandardItemsEditor";

export const metadata = { title: "Test catalog" };

export default async function TestCatalogPage() {
  await requirePermission("manage_test_catalog");
  const rows = await listTests();
  const standardByTest = await listStandardItemsByTest();
  // Only bulk items can be listed: a serialized bottle or tube is scanned and issued on its own, and a bench
  // supply (cotton wool, gloves...) is recorded by the lab under Used for test, not listed per test.
  const choices = (await listActiveItemTypes())
    .filter((i) => i.trackingMode === "QUANTITY" && !i.benchSupply)
    .map((i) => ({ id: i.id, name: i.name, unit: perTestUnit(i.unitOfMeasure, i.packSize) }));
  // A test with no required container accepts any container, so there is nothing to confirm for it.
  const unconfirmed = rows.filter((row) => row.active && row.requiredContainerType && !row.containersConfirmed).length;
  // Likewise a test with no items listed has no quantities to confirm.
  const unconfirmedItems = rows.filter(
    (row) => row.active && (standardByTest.get(row.id)?.length ?? 0) > 0 && !row.consumptionConfirmed,
  ).length;

  return (
    <div className="flex flex-col gap-6">
      <FormDialog
        buttonLabel="Add test"
        title="Add a test"
        header={
          <>
            <h1 className="text-[22px] font-bold tracking-tight">Test catalog</h1>
            <p className="mt-1 text-sm text-zinc-500">
              The tests the lab runs and the container each one needs. When a bottle is issued for a test, its container
              type must match; a mismatch is blocked unless a supervisor overrides it. Codes cannot be changed once
              created. This list is later synced from the EMR.
            </p>
          </>
        }
      >
        <ActionForm action={createTestAction} submitLabel="Add test">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Code" hint="For example LFT">
              <input name="code" required className={inputClass} autoCapitalize="characters" />
            </Field>
            <Field label="Name">
              <input name="name" required className={inputClass} />
            </Field>
            <Field
              label="Required container type"
              hint="Leave blank if any container will do. Must match the item type's container type."
            >
              <Combobox name="requiredContainerType" suggestions={CONTAINER_TYPE_SUGGESTIONS} autoCapitalize="characters" />
            </Field>
            <Field
              label="Also accepts"
              hint="Other containers that are fine for this test (for example GEL when a plain tube or a gel tube will do). Leave blank if only the required one works."
            >
              <MultiSelect name="alternateContainerTypes" options={CONTAINER_TYPE_SUGGESTIONS} placeholder="None" ariaLabel="Also accepts" />
            </Field>
            <label className="flex items-center gap-2 text-sm sm:col-span-2">
              <input type="checkbox" name="containersConfirmed" />
              Container and alternates confirmed with the lab
            </label>

            <div className="flex flex-col gap-3 sm:col-span-2">
              <hr className="border-line" />
              <p className="text-sm text-zinc-500">
                The bulk items one run of this test normally uses. They come up when someone issues for this test and can be
                changed there. Nothing moves stock from here. You can also add them later.
              </p>
              <StandardItemsEditor choices={choices} initial={[]} />
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" name="consumptionConfirmed" />
                Items and quantities confirmed with the lab
              </label>
            </div>
          </div>
        </ActionForm>
      </FormDialog>

      {unconfirmed > 0 ? (
        <p className="rounded-xl border border-line bg-warn-soft px-4 py-2.5 text-sm text-warn">
          {unconfirmed} {unconfirmed === 1 ? "test has" : "tests have"} a container mapping the lab has not confirmed yet. The
          plain and gel tube choices are best guesses until then. Check each with the lab, correct it, and tick Confirmed.
          Nothing is blocked while a mapping is unconfirmed.
        </p>
      ) : null}

      {unconfirmedItems > 0 ? (
        <p className="rounded-xl border border-line bg-warn-soft px-4 py-2.5 text-sm text-warn">
          {unconfirmedItems} {unconfirmedItems === 1 ? "test has" : "tests have"} a list of items and quantities the lab has
          not confirmed yet. These pre-fill the items on the Issue screen, where they can be changed on the spot. Check each
          with the lab, correct it, and tick Confirmed. Nothing is blocked while a list is unconfirmed.
        </p>
      ) : null}

      <section className="overflow-x-auto rounded-xl border border-line bg-surface px-2 py-1">
        <table className={tableClass}>
          <thead>
            <tr>
              <th className={thClass}>Code</th>
              <th className={thClass}>Name</th>
              <th className={thClass}>Container</th>
              <th className={thClass}>Also accepts</th>
              <th className={thClass}>Items per test</th>
              <th className={thClass}>Status</th>
              <th className={thClass}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <td className={tdClass}>{row.code}</td>
                <td className={tdClass}>{row.name}</td>
                <td className={tdClass}>
                  <span className="flex flex-wrap items-center gap-2">
                    {row.requiredContainerType ?? "Any"}
                    {row.requiredContainerType && !row.containersConfirmed ? <Tag tone="warn">Unconfirmed</Tag> : null}
                  </span>
                </td>
                <td className={tdClass}>{row.alternateContainerTypes.length > 0 ? row.alternateContainerTypes.join(", ") : "-"}</td>
                <td className={tdClass}>
                  {(() => {
                    const items = standardByTest.get(row.id) ?? [];
                    if (items.length === 0) return "-";
                    return (
                      <span className="flex flex-wrap items-center gap-2">
                        <HoverList
                          summary={items.length === 1 ? "1 item" : `${items.length} items`}
                          lines={items.map((i) => `${i.quantity} x ${i.name}`)}
                          label={`Items used by ${row.code}`}
                        />
                        {!row.consumptionConfirmed ? <Tag tone="warn">Unconfirmed</Tag> : null}
                      </span>
                    );
                  })()}
                </td>
                <td className={tdClass}>{row.active ? "Active" : "Inactive"}</td>
                <td className={tdClass}>
                  <div className="flex flex-nowrap items-center gap-2 whitespace-nowrap">
                    <RowFormDialog buttonLabel="Edit" title={`Edit ${row.code}`}>
                      <ActionForm action={saveTestAction} submitLabel="Save" resetOnSuccess={false}>
                        <input type="hidden" name="id" value={row.id} />
                        <Field label="Name">
                          <input name="name" required defaultValue={row.name} className={inputClass} />
                        </Field>
                        <div className="grid grid-cols-1 items-start gap-3 sm:grid-cols-2">
                          <Field
                            label="Required container type"
                            hint="Leave blank if any container will do. Must match the item type's container type."
                          >
                            <Combobox
                              name="requiredContainerType"
                              suggestions={CONTAINER_TYPE_SUGGESTIONS}
                              defaultValue={row.requiredContainerType ?? ""}
                              placeholder="any container"
                              autoCapitalize="characters"
                            />
                          </Field>
                          <Field
                            label="Also accepts"
                            hint="Other containers that are fine for this test. Leave blank if only the required one works."
                          >
                            <MultiSelect
                              name="alternateContainerTypes"
                              options={CONTAINER_TYPE_SUGGESTIONS}
                              defaultValues={row.alternateContainerTypes}
                              placeholder="None"
                              ariaLabel="Also accepts"
                            />
                          </Field>
                        </div>
                        <label className="flex items-center gap-2 text-sm">
                          <input type="checkbox" name="containersConfirmed" defaultChecked={row.containersConfirmed} />
                          Container and alternates confirmed with the lab
                        </label>

                        <hr className="border-line" />

                        <p className="text-sm text-zinc-500">
                          The bulk items one run of this test normally uses. They come up when someone issues for this test and
                          can be changed there. Nothing moves stock from here.
                        </p>
                        <StandardItemsEditor
                          choices={choices}
                          initial={(standardByTest.get(row.id) ?? []).map((i) => ({
                            itemTypeId: i.itemTypeId,
                            name: i.name,
                            unit: perTestUnit(i.unitOfMeasure, i.packSize),
                            quantity: i.quantity,
                          }))}
                        />
                        <label className="flex items-center gap-2 text-sm">
                          <input type="checkbox" name="consumptionConfirmed" defaultChecked={row.consumptionConfirmed} />
                          Items and quantities confirmed with the lab
                        </label>
                      </ActionForm>
                    </RowFormDialog>
                    <ActionForm
                      action={setTestActiveAction}
                      submitLabel={row.active ? "Deactivate" : "Activate"}
                      compact
                      className="flex items-center"
                      confirm={row.active ? `Deactivate ${row.code}?` : undefined}
                      danger={row.active}
                    >
                      <input type="hidden" name="id" value={row.id} />
                      <input type="hidden" name="active" value={row.active ? "false" : "true"} />
                    </ActionForm>
                  </div>
                </td>
              </tr>
            ))}
            {rows.length === 0 ? (
              <tr>
                <td className={tdClass} colSpan={7}>
                  No tests yet.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </section>
    </div>
  );
}
