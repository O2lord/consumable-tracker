"use client";

import { useState } from "react";
import { ActionForm } from "@/components/forms/ActionForm";
import type { FormState } from "@/components/forms/form-state";
import { Field } from "@/components/ui/Field";
import { Select } from "@/components/ui/Dropdown";
import { PackEquivalent } from "@/components/ui/PackEquivalent";
import { ghostButtonClass, inputClass } from "@/components/ui/styles";
import { UnitSwitch } from "@/components/ui/UnitSwitch";
import { canSwitchUnit, describeRequestQuantity, isPackUnit, isPieceUnit, toRequestQuantity, type EntryUnit } from "@/lib/pack-size";

export interface ItemOption {
  id: string;
  name: string;
  /** What a quantity of this item counts: "Pack", "Pieces", "Roll"... Shown beside every quantity so it is never a guess. */
  unit: string;
  /** Pieces in one pack, for the "(N pieces)" hint under a pack quantity. */
  packSize: number;
  packSizeConfirmed: boolean;
}

export interface LocationOption {
  id: string;
  name: string;
}

interface Row {
  key: number;
  itemTypeId: string;
  quantity: string;
  /** Which unit the quantity is typed in: the item's own unit, or the other one (pieces for packs, packs for pieces). */
  entry: EntryUnit;
}

interface Props {
  action: (prev: FormState, formData: FormData) => Promise<FormState>;
  submitLabel: string;
  items: ItemOption[];
  /** Create mode: the stores to choose from. Omit when editing (the locations are fixed). */
  stores?: LocationOption[];
  /** Create mode for supervisors and admins, who choose which location is asking. */
  requestingOptions?: LocationOption[];
  /** Create mode for supervisors and admins: the location that is pre-selected. */
  defaultRequestingLocationId?: string;
  /** Edit mode: sent back with the form so the action knows which draft this is. */
  requestId?: string;
  code?: string;
  initialNote?: string;
  /** `inPieces` marks a line saved as loose pieces of a pack item, so it reopens counted in pieces. */
  initialLines?: { itemTypeId: string; quantity: number; inPieces?: boolean }[];
  /** When set, shown as a heading on the left of a bar with the submit button on the right. */
  title?: string;
}

/** Lines editor shared by "new request" and "edit draft". Rows are posted as repeated itemTypeId / quantity fields. */
export function RequestForm({
  action,
  submitLabel,
  items,
  stores,
  requestingOptions,
  defaultRequestingLocationId,
  requestId,
  code,
  initialNote,
  initialLines,
  title,
}: Props) {
  const editing = Boolean(requestId);
  const itemById = new Map(items.map((i) => [i.id, i] as const));
  const [nextKey, setNextKey] = useState(() => (initialLines?.length ?? 1) + 1);
  const [rows, setRows] = useState<Row[]>(() =>
    initialLines && initialLines.length > 0
      ? initialLines.map((l, i) => ({
          key: i + 1,
          itemTypeId: l.itemTypeId,
          quantity: String(l.quantity),
          entry: l.inPieces ? ("alt" as const) : ("stock" as const),
        }))
      : [{ key: 1, itemTypeId: "", quantity: "1", entry: "stock" as const }],
  );

  const addRow = () => {
    setRows((r) => [...r, { key: nextKey, itemTypeId: "", quantity: "1", entry: "stock" }]);
    setNextKey((k) => k + 1);
  };
  const removeRow = (key: number) => setRows((r) => (r.length > 1 ? r.filter((x) => x.key !== key) : r));
  const update = (key: number, patch: Partial<Row>) =>
    setRows((r) => r.map((x) => (x.key === key ? { ...x, ...patch } : x)));

  return (
    <ActionForm
      action={action}
      submitLabel={submitLabel}
      resetOnSuccess={false}
      className="flex flex-col gap-4"
      topBar={title ? <h2 className="text-base font-medium text-ink">{title}</h2> : undefined}
      topBarClassName="sticky top-0 z-20 flex flex-wrap items-center justify-between gap-3 bg-surface pb-1"
    >
      {requestId ? <input type="hidden" name="requestId" value={requestId} /> : null}
      {code ? <input type="hidden" name="code" value={code} /> : null}
      <div className="flex max-w-2xl flex-col gap-4">

      {requestingOptions || stores ? (
        <div className="grid gap-4 sm:grid-cols-2">
          {requestingOptions ? (
            <Field label="Requesting location">
              <Select
                name="requestingLocationId"
                required
                placeholder="Choose a location"
                defaultValue={defaultRequestingLocationId ?? ""}
                options={requestingOptions.map((l) => ({ value: l.id, label: l.name }))}
              />
            </Field>
          ) : null}

          {stores ? (
            <Field label="Ask which store?">
              <Select
                name="storeLocationId"
                required
                placeholder="Choose a store"
                defaultValue={stores.length === 1 ? stores[0].id : ""}
                options={stores.map((s) => ({ value: s.id, label: s.name }))}
              />
            </Field>
          ) : null}
        </div>
      ) : null}

      <div className="flex flex-col gap-2">
        <span className="text-sm font-medium">Items</span>
        <p className="text-xs text-zinc-500">
          Choose Pack or Pieces beside the number to say how you are counting. You can ask for any number of pieces,
          for example 10 from a pack of 100. The store opens a pack and sends just those pieces.
        </p>
        <div className="hidden grid-cols-[1fr_16rem_auto] gap-2 px-0.5 text-xs font-medium text-muted sm:grid">
          <span>Item</span>
          <span>Quantity</span>
          <span className="w-[4.5rem]" />
        </div>
        {rows.map((row) => {
          const item = itemById.get(row.itemTypeId);
          const qty = Number(row.quantity);
          const switchable = item ? isPackUnit(item.unit) || isPieceUnit(item.unit) : false;
          const canConvert = item ? canSwitchUnit(item.unit, item.packSize) : false;
          const packIsStock = item ? isPackUnit(item.unit) : false;
          const converted =
            item && row.entry === "alt" && Number.isInteger(qty) && qty > 0
              ? toRequestQuantity(qty, row.entry, item.unit, item.packSize)
              : null;
          const enteredLabel = !item ? "" : row.entry === "alt" ? (packIsStock ? "Pieces" : "Pack") : item.unit;
          return (
            <div key={row.key} className="flex flex-col gap-1">
              <div className="grid grid-cols-[1fr_auto] items-center gap-2 sm:grid-cols-[1fr_16rem_auto]">
                <div className="col-span-2 min-w-0 sm:col-span-1">
                  <Select
                    name="itemTypeId"
                    ariaLabel="Item"
                    placeholder="Choose an item"
                    defaultValue={row.itemTypeId}
                    onChange={(value) => update(row.key, { itemTypeId: value, entry: "stock" })}
                    options={items.map((i) => ({ value: i.id, label: `${i.name} (${i.unit})` }))}
                  />
                </div>
                <div className="flex items-center gap-2">
                  <input
                    name="quantity"
                    type="number"
                    inputMode="numeric"
                    min={1}
                    step={1}
                    value={row.quantity}
                    onChange={(e) => update(row.key, { quantity: e.target.value })}
                    className={`${inputClass} w-20`}
                    aria-label={item ? `Quantity of ${item.name} in ${enteredLabel}` : "Quantity"}
                  />
                  <input type="hidden" name="entryUnit" value={row.entry} />
                  {item && switchable ? (
                    <UnitSwitch
                      ariaLabel={`Count ${item.name} in`}
                      value={row.entry === "stock" ? (packIsStock ? "pack" : "pieces") : packIsStock ? "pieces" : "pack"}
                      onChange={(value) => {
                        const wantsPack = value === "pack";
                        update(row.key, { entry: wantsPack === packIsStock ? "stock" : "alt" });
                      }}
                      options={[
                        {
                          value: "pack",
                          label: "Pack",
                          disabled: !packIsStock && !canConvert,
                          title: "No pack size is set for this item",
                        },
                        {
                          value: "pieces",
                          label: "Pieces",
                          disabled: packIsStock && !canConvert,
                          title: "No pack size is set for this item",
                        },
                      ]}
                    />
                  ) : (
                    <span className="min-w-[3.5rem] text-sm font-medium text-ink">{item?.unit ?? ""}</span>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => removeRow(row.key)}
                  disabled={rows.length === 1}
                  className="rounded-lg border border-line bg-surface px-2 py-1 text-xs text-ink hover:bg-brand-soft disabled:opacity-40"
                >
                  Remove
                </button>
              </div>
              {converted && "error" in converted ? (
                <p className="text-xs text-warn">{converted.error}</p>
              ) : converted && item ? (
                <p className="text-xs text-zinc-500">
                  Requested as {describeRequestQuantity(converted.quantity, item.unit, converted.inPieces)}
                  {item.packSizeConfirmed ? null : (
                    <span className="ml-1 rounded-full bg-warn-soft px-1.5 py-0.5 text-[10px] font-semibold text-warn">
                      unconfirmed
                    </span>
                  )}
                </p>
              ) : item && switchable && !canConvert ? (
                <p className="text-xs text-zinc-500">
                  No pack size is set for this item, so it can only be requested in {item.unit.toLowerCase()}.
                </p>
              ) : item && Number.isFinite(qty) && qty > 0 ? (
                <p className="text-xs">
                  <PackEquivalent quantity={qty} unit={item.unit} packSize={item.packSize} confirmed={item.packSizeConfirmed} />
                </p>
              ) : null}
            </div>
          );
        })}
        <div>
          <button type="button" onClick={addRow} className={ghostButtonClass}>
            Add another item
          </button>
        </div>
      </div>

      <Field label="Note for the store (optional)">
        <textarea name="note" rows={2} maxLength={500} defaultValue={initialNote ?? ""} className={inputClass} />
      </Field>
      {editing ? null : (
        <p className="text-xs text-zinc-500">
          This saves a draft. You send it to the store from the next page, where the stock check runs.
        </p>
      )}
      </div>
    </ActionForm>
  );
}
