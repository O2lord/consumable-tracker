import { requirePermission } from "@/server/auth/session";
import { listActiveLocations } from "@/server/services/catalog.service";
import { listParLevelsForLocation } from "@/server/services/par-level.service";
import { ActionForm } from "@/components/forms/ActionForm";
import { LocationSwitcher } from "@/components/forms/LocationSwitcher";
import { inputClass, tableClass, tdClass, thClass } from "@/components/ui/styles";
import { saveParLevelsAction } from "./actions";

export const metadata = { title: "Target stock" };

export default async function ParLevelsPage({ searchParams }: { searchParams: Promise<{ location?: string }> }) {
  await requirePermission("manage_par_levels");
  const { location } = await searchParams;
  const locations = await listActiveLocations();
  const chosen = locations.find((l) => l.id === location);
  const rows = chosen ? await listParLevelsForLocation(chosen.id) : [];
  const withTarget = rows.filter((r) => r.target !== null).length;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-[22px] font-bold tracking-tight">Target stock</h1>
        <p className="mt-1 max-w-3xl text-sm text-zinc-500">
          How much of each item a location should hold. The target is what a request tops the location back up to; the
          minimum flags the item as low. Leave the target blank for items that location does not stock. Targets move no
          stock. Numbers are in the item&apos;s own unit (packs for pack items).
        </p>
      </div>

      <LocationSwitcher
        basePath="/admin/par-levels"
        value={chosen?.id ?? ""}
        allowNone="Choose a location"
        options={locations.map((l) => ({ value: l.id, label: l.name }))}
      />

      {chosen ? (
        <ActionForm
          key={chosen.id}
          action={saveParLevelsAction}
          submitLabel="Save target stock"
          resetOnSuccess={false}
          className="flex flex-col gap-3"
          topBar={
            <>
              {chosen.name}: {withTarget} of {rows.length} items have a target.
            </>
          }
        >
          <input type="hidden" name="locationId" value={chosen.id} />
          <section className="overflow-x-auto rounded-xl border border-line bg-surface px-2 py-1">
            <table className={tableClass}>
              <thead>
                <tr>
                  <th className={thClass}>Item</th>
                  <th className={thClass}>Unit</th>
                  <th className={thClass}>Target</th>
                  <th className={thClass}>Minimum</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.itemTypeId}>
                    <td className={tdClass}>
                      {r.itemName}
                      <input type="hidden" name="itemTypeId" value={r.itemTypeId} />
                    </td>
                    <td className={tdClass}>{r.unit}</td>
                    <td className={tdClass}>
                      <input
                        name="target"
                        type="number"
                        inputMode="numeric"
                        min={1}
                        step={1}
                        defaultValue={r.target ?? ""}
                        aria-label={`Target for ${r.itemName}`}
                        className={`${inputClass} w-28`}
                      />
                    </td>
                    <td className={tdClass}>
                      <input
                        name="minimum"
                        type="number"
                        inputMode="numeric"
                        min={0}
                        step={1}
                        defaultValue={r.target !== null && r.minimum > 0 ? r.minimum : ""}
                        aria-label={`Minimum for ${r.itemName}`}
                        className={`${inputClass} w-28`}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        </ActionForm>
      ) : (
        <p className="text-sm text-zinc-500">Choose a location to set its targets.</p>
      )}
    </div>
  );
}
