import Link from "next/link";
import { canWorkAtAnyLocation } from "@/server/auth/permissions";
import { requirePermission } from "@/server/auth/session";
import { listActiveItemTypes, listActiveLocations } from "@/server/services/catalog.service";
import { suggestRequestFromTargets } from "@/server/services/par-level.service";
import { LocationSwitcher } from "@/components/forms/LocationSwitcher";
import { PackEquivalent } from "@/components/ui/PackEquivalent";
import { Tag } from "@/components/ui/Tag";
import { tableClass, tdClass, thClass } from "@/components/ui/styles";
import { createRequestAction } from "../actions";
import { RequestForm } from "../RequestForm";

export const metadata = { title: "New stock request" };

export default async function NewRequestPage({
  searchParams,
}: {
  searchParams: Promise<{ location?: string; suggest?: string }>;
}) {
  const session = await requirePermission("create_request");
  const privileged = canWorkAtAnyLocation(session.role);

  if (!privileged && !session.homeLocationId) {
    return (
      <div className="flex flex-col gap-3">
        <h1 className="text-xl font-semibold">New stock request</h1>
        <p className="text-sm text-zinc-500">Your account has no location yet. Ask an admin to set one.</p>
      </div>
    );
  }

  const sp = await searchParams;
  const [locations, itemTypes] = await Promise.all([listActiveLocations(), listActiveItemTypes()]);
  const stores = locations.filter((l) => l.type === "STORE").map((l) => ({ id: l.id, name: l.name }));
  const requestingOptions = privileged
    ? locations.filter((l) => l.type !== "STORE").map((l) => ({ id: l.id, name: l.name }))
    : undefined;
  const items = itemTypes.map((i) => ({ id: i.id, name: i.name, unit: i.unitOfMeasure, packSize: i.packSize, packSizeConfirmed: i.packSizeConfirmed }));

  // Who is asking: a lab always for its own location; supervisors and admins for the one they chose.
  const askingId = privileged ? (requestingOptions?.find((l) => l.id === sp.location)?.id ?? "") : (session.homeLocationId ?? "");
  const suggesting = sp.suggest === "1" && askingId !== "";
  const suggestions = suggesting ? await suggestRequestFromTargets(askingId) : [];
  const suggestHref = `/store/requests/new?${privileged ? `location=${askingId}&` : ""}suggest=1`;

  return (
    <div className="flex flex-col gap-4">
      <div>
        <p className="text-sm">
          <Link href="/store/requests" className="underline">
            Stock requests
          </Link>
        </p>
        <h1 className="text-xl font-semibold">New stock request</h1>
        <p className="mt-1 text-sm text-zinc-500">Choose the store and what you need. You can check and edit it before sending.</p>
      </div>

      {privileged && requestingOptions ? (
        <LocationSwitcher
          basePath="/store/requests/new"
          label="Requesting location"
          value={askingId}
          allowNone="Choose a location"
          options={requestingOptions.map((l) => ({ value: l.id, label: l.name }))}
        />
      ) : null}

      {askingId ? (
        <div className="flex max-w-2xl flex-col gap-2 rounded-xl border border-line bg-surface p-4 text-sm">
          <div className="flex flex-wrap items-center gap-3">
            <Link
              href={suggestHref}
              className="rounded-lg border border-line bg-surface px-3 py-1.5 font-medium hover:bg-brand-soft"
            >
              Suggest from target stock
            </Link>
            <span className="text-zinc-500">
              Fills the list with what it takes to get back to your targets, after what you hold and what is already on
              its way.
            </span>
          </div>
          {suggesting ? (
            suggestions.length === 0 ? (
              <p className="text-zinc-500">
                Nothing to suggest: either no targets are set for this location, or everything is at or above its target.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className={tableClass}>
                  <thead>
                    <tr>
                      <th className={thClass}>Item</th>
                      <th className={thClass}>Target</th>
                      <th className={thClass}>Have</th>
                      <th className={thClass}>On the way</th>
                      <th className={thClass}>Suggested</th>
                    </tr>
                  </thead>
                  <tbody>
                    {suggestions.map((s) => (
                      <tr key={s.itemTypeId}>
                        <td className={tdClass}>
                          {s.itemName} {s.belowMinimum ? <Tag tone="bad">Low</Tag> : null}
                        </td>
                        <td className={tdClass}>{s.target}</td>
                        <td className={tdClass}>
                          {s.onHand}
                          {s.loosePieces > 0 ? ` + ${s.loosePieces.toLocaleString("en-GB")} ${s.loosePieces === 1 ? "piece" : "pieces"}` : ""}
                        </td>
                        <td className={tdClass}>{s.onTheWay}</td>
                        <td className={tdClass}>
                          {s.quantity}
                          <PackEquivalent quantity={s.quantity} unit={s.unit} packSize={s.packSize} confirmed={s.packSizeConfirmed} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="mt-2 text-xs text-zinc-500">
                  The request below is pre-filled with these quantities. Change anything before saving.
                </p>
              </div>
            )
          ) : null}
        </div>
      ) : null}

      {stores.length === 0 ? (
        <p className="text-sm text-zinc-500">There is no active store to ask. Ask an admin to add one.</p>
      ) : (
        <RequestForm
          key={`${askingId}|${suggesting ? "s" : "n"}`}
          action={createRequestAction}
          submitLabel="Save draft"
          items={items}
          stores={stores}
          requestingOptions={requestingOptions}
          defaultRequestingLocationId={askingId}
          initialLines={suggestions.length > 0 ? suggestions.map((s) => ({ itemTypeId: s.itemTypeId, quantity: s.quantity })) : undefined}
        />
      )}
    </div>
  );
}
