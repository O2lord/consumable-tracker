import { requirePermission } from "@/server/auth/session";
import { getInvestigationImportStats, listImportHistory } from "@/server/services/import.service";
import { getPharmacyImportStats } from "@/server/services/pharmacy-reconcile.service";
import { listActiveLocations } from "@/server/services/catalog.service";
import { ActionForm } from "@/components/forms/ActionForm";
import { FormDialog } from "@/components/forms/FormDialog";
import { Field } from "@/components/ui/Field";
import { inputClass, tableClass, tdClass, thClass } from "@/components/ui/styles";
import { StatCard } from "@/components/ui/StatCard";
import { Tag } from "@/components/ui/Tag";
import { importPharmacyAction } from "./actions";

export const metadata = { title: "Imports" };

const when = (d: Date | null) => (d ? d.toLocaleString("en-GB") : "never");

export default async function ImportsPage() {
  await requirePermission("manage_imports");
  const [stats, pharmacyStats, history, locations] = await Promise.all([
    getInvestigationImportStats(),
    getPharmacyImportStats(),
    listImportHistory(),
    listActiveLocations(),
  ]);

  return (
    <div className="flex flex-col gap-8">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard value={stats.total} label="investigations recorded" tone="brand" />
        <StatCard value={pharmacyStats.inventory.rows} label="stock rows" tone={pharmacyStats.inventory.rows === 0 ? "warn" : "brand"} />
        <StatCard value={pharmacyStats.grn.rows} label="GRN lines" tone={pharmacyStats.grn.rows === 0 ? "warn" : "brand"} />
        <StatCard value={pharmacyStats.transfers.rows} label="transfers loaded" tone={pharmacyStats.transfers.rows === 0 ? "warn" : "brand"} />
      </div>

      <p className="max-w-3xl text-sm text-zinc-500">
        Investigations are not uploaded. The Chrome extension records each one from the staff portal the first time it is
        opened or a bottle is issued against it ({stats.total} so far). Only Pharmacy exports are uploaded here.
      </p>

      <FormDialog
        buttonLabel="Upload Pharmacy export"
        title="Upload a Pharmacy export"
        header={
          <>
            <h1 className="text-[22px] font-bold tracking-tight">Pharmacy imports</h1>
            <p className="mt-1 max-w-3xl text-sm text-zinc-500">
              Upload what the Pharmacy exports: stock on hand, a goods received note (GRN), or the transfers list. The
              Pharmacy report compares them with the tracker, so a difference in stock per batch or in a transfer total shows
              up there. As with investigations, uploading a newer file updates the rows already loaded and nothing is
              deleted.
            </p>
            <ul className="mt-2 list-disc pl-5 text-sm">
              <li>
                Stock on hand: {pharmacyStats.inventory.rows} rows across {pharmacyStats.inventory.locations} locations, last
                import {when(pharmacyStats.inventory.lastImportedAt)}
              </li>
              <li>
                GRNs: {pharmacyStats.grn.rows} lines in {pharmacyStats.grn.grns} GRNs, last import{" "}
                {when(pharmacyStats.grn.lastImportedAt)}
              </li>
              <li>
                Transfers: {pharmacyStats.transfers.rows} loaded, last import {when(pharmacyStats.transfers.lastImportedAt)}
              </li>
            </ul>
          </>
        }
      >
        <ActionForm action={importPharmacyAction} submitLabel="Import">
          <Field label="What is in the file">
            <select name="kind" required defaultValue="INVENTORY" className={inputClass}>
              <option value="INVENTORY">Stock on hand (inventory)</option>
              <option value="GRN_LINE">A GRN (goods received note)</option>
              <option value="TRANSFER">Transfers</option>
            </select>
          </Field>
          <Field
            label="Location (stock on hand only)"
            hint="The inventory export does not say where the stock is, so choose the location it is for. Leave blank only if the file has a location column."
          >
            <select name="locationId" defaultValue="" className={inputClass}>
              <option value="">-</option>
              {locations.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name} ({l.code})
                </option>
              ))}
            </select>
          </Field>
          <Field
            label="GRN number (GRN only, optional)"
            hint="Read from a grn_ref column or from the file name (grn-GRNS00002.xlsx) when blank."
          >
            <input name="grnRef" className={inputClass} />
          </Field>
          <Field
            label="File"
            hint="Pharmacy portal headers (Generic, Strength, Brand, Batch, Expiry, Qty, Cost) work as they are."
          >
            <input name="file" type="file" required accept=".xlsx,.csv" className={inputClass} />
          </Field>
        </ActionForm>
      </FormDialog>

      <section className="overflow-x-auto rounded-xl border border-line bg-surface px-2 py-1">
        <h2 className="mb-2 font-medium">Import history</h2>
        <table className={tableClass}>
          <thead>
            <tr>
              <th className={thClass}>When</th>
              <th className={thClass}>File</th>
              <th className={thClass}>What</th>
              <th className={thClass}>Rows</th>
              <th className={thClass}>Added</th>
              <th className={thClass}>Updated</th>
              <th className={thClass}>Rejected</th>
            </tr>
          </thead>
          <tbody>
            {history.map((h) => (
              <tr key={h.id}>
                <td className={tdClass}>{h.startedAt.toLocaleString("en-GB")}</td>
                <td className={tdClass}>{h.fileName ?? "-"}</td>
                <td className={tdClass}>{h.what}</td>
                <td className={tdClass}>{h.rowsTotal}</td>
                <td className={tdClass}>{h.rowsInserted}</td>
                <td className={tdClass}>{h.rowsUpdated}</td>
                <td className={tdClass}>
                  {h.rowsRejected > 0 ? <Tag tone="warn">{h.rowsRejected} rejected</Tag> : <Tag tone="ok">None</Tag>}
                  {h.errors.length > 0 ? (
                    <details className="mt-1 text-xs">
                      <summary className="cursor-pointer underline">Show rows</summary>
                      <ul className="mt-1 list-disc pl-4">
                        {h.errors.map((e) => (
                          <li key={`${e.row}-${e.message}`}>
                            Row {e.row}: {e.message}
                          </li>
                        ))}
                      </ul>
                      {h.rowsRejected > h.errors.length ? <p className="mt-1">Only the first {h.errors.length} are kept.</p> : null}
                    </details>
                  ) : null}
                </td>
              </tr>
            ))}
            {history.length === 0 ? (
              <tr>
                <td className={tdClass} colSpan={7}>
                  No imports yet.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </section>
    </div>
  );
}
