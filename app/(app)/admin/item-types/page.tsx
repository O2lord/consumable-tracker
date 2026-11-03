import { requirePermission } from "@/server/auth/session";
import { listItemTypes } from "@/server/services/catalog.service";
import { ActionForm } from "@/components/forms/ActionForm";
import { FormDialog, RowFormDialog } from "@/components/forms/FormDialog";
import { Tag } from "@/components/ui/Tag";
import { ListSearch } from "@/components/ui/ListSearch";
import { tableClass, tdClass, thClass } from "@/components/ui/styles";
import { createItemTypeAction, setItemTypeActiveAction, updateItemTypeAction } from "./actions";
import { ItemTypeFields, type ItemTypeFormRow } from "./ItemTypeFields";

export const metadata = { title: "Item types" };

type ItemTypeRow = Awaited<ReturnType<typeof listItemTypes>>[number];

/** The plain values the form needs, so nothing else from the row is sent to the browser. */
function toFormRow(row: ItemTypeRow): ItemTypeFormRow {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    labelCode: row.labelCode,
    category: row.category,
    trackingMode: row.trackingMode,
    containerType: row.containerType,
    unitOfMeasure: row.unitOfMeasure,
    reorderLevel: row.reorderLevel,
    packSize: row.packSize,
    packSizeConfirmed: row.packSizeConfirmed,
    packsPerCarton: row.packsPerCarton,
    testsPerUnit: row.testsPerUnit,
    coldStorage: row.coldStorage,
    benchSupply: row.benchSupply,
    allowedServiceRoles: row.allowedServiceRoles,
  };
}

export default async function ItemTypesPage({ searchParams }: { searchParams: Promise<{ q?: string | string[] }> }) {
  await requirePermission("manage_item_types");
  const sp = await searchParams;
  const query = (Array.isArray(sp.q) ? sp.q[0] : sp.q)?.trim() ?? "";
  const allRows = await listItemTypes();
  // The unconfirmed-pack-size warning is about every item, not just the ones the search leaves showing.
  const unconfirmedPackSizes = allRows.filter((row) => row.active && !row.packSizeConfirmed && row.trackingMode === "QUANTITY").length;
  // Every word typed must match somewhere in the row (name, code, category, type, unit, label code, where it is allowed).
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const rows = words.length
    ? allRows.filter((row) => {
        const haystack = [
          row.name,
          row.code,
          row.labelCode,
          row.category,
          row.trackingMode,
          row.containerType,
          row.unitOfMeasure,
          row.coldStorage ? "keep cold" : "",
          row.benchSupply ? "bench supply" : "",
          row.active ? "active" : "inactive",
          ...(row.allowedServiceRoles ?? []),
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        return words.every((w) => haystack.includes(w));
      })
    : allRows;

  return (
    <div className="flex flex-col gap-6">
      <FormDialog
        buttonLabel="Add item type"
        title="Add an item type"
        header={
          <>
            <h1 className="text-[22px] font-bold tracking-tight">Item types</h1>
            <p className="mt-1 text-sm text-zinc-500">
              SERIAL items (sample bottles, specimen containers) get one barcode each and are scanned at every
              step. QUANTITY items (gloves, syringes) are tracked by batch and counted. REAGENT items are counted in
              tests: you say how many tests one container covers.
            </p>
          </>
        }
      >
        <ActionForm action={createItemTypeAction} submitLabel="Add item type">
          <ItemTypeFields />
        </ActionForm>
      </FormDialog>

      {unconfirmedPackSizes > 0 ? (
        <p className="rounded-xl border border-line bg-warn-soft px-4 py-2.5 text-sm text-warn">
          {unconfirmedPackSizes} {unconfirmedPackSizes === 1 ? "item has" : "items have"} an unconfirmed pack size. Check
          each with the lab, correct it, and tick Confirmed. Changing a pack size never changes a stock count.
        </p>
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <ListSearch placeholder="Search item types" className="w-full max-w-sm" />
        {query ? (
          <p className="text-sm text-muted">
            {rows.length} of {allRows.length} {allRows.length === 1 ? "item type" : "item types"}
          </p>
        ) : null}
      </div>

      <section className="overflow-x-auto rounded-xl border border-line bg-surface px-2 py-1">
        <table className={tableClass}>
          <thead>
            <tr>
              <th className={thClass}>Item</th>
              <th className={thClass}>Type</th>
              <th className={thClass}>Unit</th>
              <th className={thClass}>Pack size</th>
              <th className={thClass}>Allowed at</th>
              <th className={thClass}>Reorder at</th>
              <th className={thClass}>Status</th>
              <th className={thClass}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <td className={tdClass}>
                  <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="font-medium">{row.name}</span>
                    {row.coldStorage ? <Tag tone="brand">Keep cold</Tag> : null}
                    {row.benchSupply ? <Tag tone="brand">Bench supply</Tag> : null}
                  </span>
                  <span className="block text-xs text-muted">
                    {row.code}
                    {row.trackingMode === "SERIAL" ? (
                      <>
                        {" · "}
                        {row.labelCode ? (
                          <>
                            bottles start <span className="font-mono font-semibold text-ink">{row.labelCode}</span>
                          </>
                        ) : (
                          "label code set at first stock-in"
                        )}
                      </>
                    ) : null}
                  </span>
                </td>
                <td className={tdClass}>
                  {row.category}
                  <span className="block text-xs text-muted">
                    {row.trackingMode}
                    {row.containerType ? ` · ${row.containerType}` : ""}
                  </span>
                </td>
                <td className={tdClass}>{row.unitOfMeasure}</td>
                <td className={tdClass}>
                  {row.testsPerUnit ? (
                    <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      {row.testsPerUnit.toLocaleString("en-GB")} {row.testsPerUnit === 1 ? "test" : "tests"}
                      {row.packsPerCarton ? <span className="text-xs text-muted">· {row.packsPerCarton} per carton</span> : null}
                      {row.packSizeConfirmed ? null : <Tag tone="warn">Unconfirmed</Tag>}
                    </span>
                  ) : row.packSize > 1 || row.packsPerCarton || row.trackingMode === "QUANTITY" ? (
                    <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      {row.packSize}
                      {row.packsPerCarton ? <span className="text-xs text-muted">· {row.packsPerCarton} per carton</span> : null}
                      {row.packSizeConfirmed ? null : <Tag tone="warn">Unconfirmed</Tag>}
                    </span>
                  ) : (
                    "-"
                  )}
                </td>
                <td className={tdClass}>{row.allowedServiceRoles?.join(", ") ?? "Any"}</td>
                <td className={tdClass}>{row.reorderLevel}</td>
                <td className={tdClass}>{row.active ? "Active" : "Inactive"}</td>
                <td className={tdClass}>
                  <div className="flex flex-nowrap items-center gap-2 whitespace-nowrap">
                    <RowFormDialog buttonLabel="Edit" title={`Edit ${row.code}`}>
                      <ActionForm action={updateItemTypeAction} submitLabel="Save" resetOnSuccess={false}>
                        <input type="hidden" name="id" value={row.id} />
                        <ItemTypeFields row={toFormRow(row)} />
                      </ActionForm>
                    </RowFormDialog>
                    <ActionForm
                      action={setItemTypeActiveAction}
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
                <td className={tdClass} colSpan={8}>
                  {query
                    ? `No item types match "${query}".`
                    : "No item types yet. Start with the sample bottles you want to track."}
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </section>
    </div>
  );
}
