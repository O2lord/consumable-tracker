"use client";

import { useState, type ReactNode } from "react";
import { ActionForm } from "@/components/forms/ActionForm";
import { FormDialog } from "@/components/forms/FormDialog";
import { Select } from "@/components/ui/Dropdown";
import { Field } from "@/components/ui/Field";
import { PackEquivalent } from "@/components/ui/PackEquivalent";
import { inputClass, linkButtonClass } from "@/components/ui/styles";
import { UnitSwitch } from "@/components/ui/UnitSwitch";
import { canSwitchUnit, describeRequestQuantity, isPackUnit, isPieceUnit, toStockQuantity, type EntryUnit } from "@/lib/pack-size";
import { stockInManyAction } from "./actions";

export interface ItemTypeOption {
  id: string;
  name: string;
  code: string;
  trackingMode: "SERIAL" | "QUANTITY";
  /** What a quantity of this item counts: "Pack", "Pieces", "Roll"... */
  unit: string;
  /** Pieces in one pack, for converting between packs and pieces. */
  packSize: number;
  packSizeConfirmed: boolean;
}
export interface StoreOption {
  id: string;
  name: string;
}

interface FormProps {
  itemTypes: ItemTypeOption[];
  stores: StoreOption[];
  defaultStoreId?: string;
}

function formatDate(value: string) {
  if (!value) return "";
  const [y, m, d] = value.split("-");
  return y && m && d ? `${d}/${m}/${y}` : value;
}

/**
 * One item in the delivery: its own item type, quantity, lot and expiry. The fields are submitted in line order,
 * so stockInManyAction can pair them up again by position.
 *
 * While `editing` the fields are shown. After "Done" they collapse into a one-line summary, but stay in the DOM
 * (just hidden) so they are still submitted with the form.
 */
function StockInLine({
  index,
  itemTypes,
  availableItemTypes,
  itemTypeId,
  editing,
  onItemChange,
  onDone,
  onEdit,
  onRemove,
}: {
  index: number;
  itemTypes: ItemTypeOption[];
  /** The item types this line may pick: the ones no other line has taken. */
  availableItemTypes: ItemTypeOption[];
  itemTypeId: string;
  editing: boolean;
  onItemChange: (id: string) => void;
  onDone: () => void;
  onEdit: () => void;
  onRemove: () => void;
}) {
  const [quantity, setQuantity] = useState("");
  const [lotNo, setLotNo] = useState("");
  const [expiryDate, setExpiryDate] = useState("");
  const [error, setError] = useState<string | null>(null);
  // Which unit the quantity is typed in: the item's own unit, or the other one (pieces for packs, packs for pieces).
  const [entry, setEntry] = useState<EntryUnit>("stock");
  const selected = itemTypes.find((i) => i.id === itemTypeId);

  const isSerial = selected?.trackingMode === "SERIAL";
  // Only bulk items can be counted in packs or pieces. A bottle is always counted one by one.
  const switchable = !!selected && !isSerial && (isPackUnit(selected.unit) || isPieceUnit(selected.unit));
  const canConvert = !!selected && canSwitchUnit(selected.unit, selected.packSize);
  const packIsStock = !!selected && isPackUnit(selected.unit);
  const qty = Number(quantity);
  const converted =
    selected && switchable && entry === "alt" && Number.isInteger(qty) && qty > 0
      ? toStockQuantity(qty, entry, selected.unit, selected.packSize)
      : null;
  const unitLabel = !selected ? "" : isSerial ? "bottles" : entry === "alt" ? (packIsStock ? "Pieces" : "Pack") : selected.unit;

  let hint: string;
  if (isSerial) hint = "One barcode label is made for each bottle (up to 5000 at a time).";
  else if (switchable) hint = "One label is made for the whole batch, however many packs it holds.";
  else hint = "One label is made for the whole batch.";

  const handleDone = () => {
    // An empty quantity is fine here: the row stays marked "Quantity needed" and is checked when the delivery is received.
    if (quantity && (!Number.isInteger(qty) || qty < 1)) return setError("Enter a whole-number quantity.");
    if (converted && "error" in converted) return setError(converted.error);
    setError(null);
    onDone();
  };

  return (
    <div className="rounded-xl border border-line p-3">
      {/* Collapsed summary, shown after "Done". */}
      {!editing ? (
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold">{selected?.name ?? "No item chosen"}</p>
            <p className="truncate text-xs text-zinc-500">
              {quantity ? (
                [
                  `${quantity} ${unitLabel.toLowerCase()}`,
                  lotNo ? `Lot ${lotNo}` : null,
                  expiryDate ? `Exp ${formatDate(expiryDate)}` : null,
                ]
                  .filter(Boolean)
                  .join(" · ")
              ) : (
                <span className="font-semibold text-warn">Quantity needed</span>
              )}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-3 text-sm font-semibold">
            <button type="button" onClick={onEdit} className="underline">
              Edit
            </button>
            <button type="button" onClick={onRemove} className="text-warn underline">
              Remove
            </button>
          </div>
        </div>
      ) : null}

      {/* The fields. Hidden, not removed, when collapsed so they are still submitted. */}
      <div className={editing ? "flex flex-col gap-3" : "hidden"}>
        {/* Item type and quantity on one line */}
        <div className="grid gap-3 sm:grid-cols-[3fr_2fr]">
          <Field label="Item type">
            <Select
              name="itemTypeId"
              required
              ariaLabel={`Item type for item ${index + 1}`}
              value={itemTypeId}
              onChange={(value) => {
                onItemChange(value);
                setEntry("stock");
              }}
              searchable
              options={availableItemTypes.map((i) => ({ value: i.id, label: i.name }))}
            />
          </Field>
          <Field label={unitLabel ? `Quantity (${unitLabel.toLowerCase()})` : "Quantity"}>
            <div className="flex items-center gap-2">
              <input
                name="quantity"
                type="number"
                min={1}
                step={1}
                required
                value={quantity}
                onChange={(e) => setQuantity(e.target.value)}
                // A collapsed line with no quantity would block the submit without anything to focus: open it instead.
                onInvalid={() => {
                  if (!editing) onEdit();
                }}
                className={`${inputClass} min-w-0 flex-1`}
                inputMode="numeric"
                aria-label={selected ? `Quantity of ${selected.name} in ${unitLabel}` : "Quantity"}
              />
              <input type="hidden" name="entryUnit" value={entry} />
              {selected && switchable ? (
                <UnitSwitch
                  ariaLabel={`Count ${selected.name} in`}
                  value={entry === "stock" ? (packIsStock ? "pack" : "pieces") : packIsStock ? "pieces" : "pack"}
                  onChange={(value) => {
                    const wantsPack = value === "pack";
                    setEntry(wantsPack === packIsStock ? "stock" : "alt");
                  }}
                  options={[
                    {
                      value: "pack",
                      label: "Packs",
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
              ) : null}
            </div>
          </Field>
        </div>
        <p className="-mt-1 text-xs text-zinc-500">{hint}</p>

        {converted && "error" in converted ? (
          <p className="text-xs text-warn">
            {converted.error}. Stock comes in as whole packs: loose pieces only appear when a pack is opened and part of it is sent.
          </p>
        ) : converted && selected ? (
          <p className="text-xs text-zinc-500">
            Recorded as {describeRequestQuantity(converted.quantity, selected.unit, false)}
            {selected.packSizeConfirmed ? null : (
              <span className="ml-1 rounded-full bg-warn-soft px-1.5 py-0.5 text-[10px] font-semibold text-warn">unconfirmed</span>
            )}
          </p>
        ) : selected && switchable && Number.isFinite(qty) && qty > 0 ? (
          <p className="text-xs">
            <PackEquivalent quantity={qty} unit={selected.unit} packSize={selected.packSize} confirmed={selected.packSizeConfirmed} />
          </p>
        ) : selected && switchable && !canConvert ? (
          <p className="text-xs text-zinc-500">
            No pack size is set for this item, so it can only be received in {selected.unit.toLowerCase()}.
          </p>
        ) : null}

        {/* Lot number and expiry date on one line */}
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Lot number (optional)">
            <input name="lotNo" value={lotNo} onChange={(e) => setLotNo(e.target.value)} className={inputClass} />
          </Field>
          <Field label="Expiry date (optional)">
            <input
              name="expiryDate"
              type="date"
              value={expiryDate}
              onChange={(e) => setExpiryDate(e.target.value)}
              className={inputClass}
            />
          </Field>
        </div>

        <div className="flex items-center justify-between gap-2">
          <p className="text-xs font-semibold text-warn">{error}</p>
          <div className="flex items-center gap-3">
            <button type="button" onClick={onRemove} className="text-sm font-semibold text-warn underline">
              Remove
            </button>
            <button type="button" onClick={handleDone} className={linkButtonClass}>
              Done
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * The list of every item type that is not yet in the delivery. Search it, tick what arrived, click Done and the
 * ticked items are added to the delivery. Nothing here has a name, so none of it is submitted with the form.
 */
function ItemPicker({
  itemTypes,
  taken,
  onAdd,
  onCancel,
}: {
  itemTypes: ItemTypeOption[];
  taken: Set<string>;
  onAdd: (ids: string[]) => void;
  onCancel: () => void;
}) {
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<string[]>([]);

  const q = query.trim().toLowerCase();
  const options = itemTypes.filter(
    (i) => !taken.has(i.id) && (!q || i.name.toLowerCase().includes(q) || i.code.toLowerCase().includes(q)),
  );
  const toggle = (id: string) => setPicked((prev) => (prev.includes(id) ? prev.filter((p) => p !== id) : [...prev, id]));

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-line p-3">
      <input
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        // Enter in the search box must not submit the whole delivery.
        onKeyDown={(e) => {
          if (e.key === "Enter") e.preventDefault();
        }}
        placeholder="Search items"
        aria-label="Search items"
        className={inputClass}
        autoFocus
      />
      <div className="max-h-56 overflow-y-auto rounded-lg border border-line">
        {options.length === 0 ? (
          <p className="p-3 text-sm text-zinc-500">
            {q ? "No items match your search." : "Every item type is already in this delivery."}
          </p>
        ) : (
          options.map((item) => (
            <label key={item.id} className="flex cursor-pointer items-center gap-3 px-3 py-2 hover:bg-zinc-100">
              <input
                type="checkbox"
                checked={picked.includes(item.id)}
                onChange={() => toggle(item.id)}
                className="h-4 w-4 shrink-0"
              />
              <span className="min-w-0 flex-1 truncate text-sm font-medium">{item.name}</span>
              <span className="shrink-0 text-xs text-zinc-500">{item.code}</span>
            </label>
          ))
        )}
      </div>
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-zinc-500">{picked.length} selected</p>
        <div className="flex items-center gap-3">
          <button type="button" onClick={onCancel} className="text-sm font-semibold underline">
            Cancel
          </button>
          <button
            type="button"
            onClick={() => onAdd(picked)}
            disabled={picked.length === 0}
            className={`${linkButtonClass} disabled:opacity-50`}
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}

// Kept separate so its state (the lines) starts fresh each time the pop-up opens.
function StockInFields({ itemTypes, stores, defaultStoreId }: FormProps) {
  // Each line has a stable key so removing one in the middle does not hand its typed quantity to the next.
  // `editing` lines show their fields; the rest show a one-line summary. A delivery starts empty with the picker open.
  const [lines, setLines] = useState<{ key: number; itemTypeId: string; editing: boolean }[]>([]);
  const [nextKey, setNextKey] = useState(0);
  const [pickerOpen, setPickerOpen] = useState(true);

  const taken = new Set(lines.map((l) => l.itemTypeId));
  const canAdd = itemTypes.some((i) => !taken.has(i.id));

  // The ticked items join the delivery as summary rows. The first one opens so its quantity can be typed straight away.
  const addItems = (ids: string[]) => {
    setLines((prev) => [
      ...prev,
      ...ids.map((id, n) => ({ key: nextKey + n, itemTypeId: id, editing: n === 0 })),
    ]);
    setNextKey((k) => k + ids.length);
    setPickerOpen(false);
  };

  const setEditing = (key: number, editing: boolean) =>
    setLines((prev) => prev.map((l) => (l.key === key ? { ...l, editing } : l)));

  return (
    <ActionForm action={stockInManyAction} submitLabel="Receive stock and create labels" resetOnSuccess={false}>
      {/* Store, supplier and the supplier's invoice or delivery note number */}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Receive into store">
          <Select
            name="locationId"
            required
            ariaLabel="Receive into store"
            defaultValue={defaultStoreId ?? stores[0]?.id}
            options={stores.map((s) => ({ value: s.id, label: s.name }))}
          />
        </Field>
        <Field label="Supplier (optional)" hint="Applies to every item in this delivery.">
          <input name="supplier" className={inputClass} />
        </Field>
        <Field label="Invoice or delivery note no. (optional)" hint="The supplier's number for this delivery.">
          <input name="reference" maxLength={100} className={inputClass} />
        </Field>
      </div>

      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">
          Items <span className="font-normal text-zinc-500">({lines.length})</span>
        </h3>
        <button
          type="button"
          onClick={() => setPickerOpen(true)}
          disabled={!canAdd || pickerOpen}
          className={`${linkButtonClass} disabled:opacity-50`}
        >
          + Add item
        </button>
      </div>

      {pickerOpen ? (
        <ItemPicker itemTypes={itemTypes} taken={taken} onAdd={addItems} onCancel={() => setPickerOpen(false)} />
      ) : lines.length === 0 ? (
        <p className="text-sm text-zinc-500">No items yet. Click “+ Add item” to choose what arrived.</p>
      ) : null}

      {lines.map((line, index) => (
        <StockInLine
          key={line.key}
          index={index}
          itemTypes={itemTypes}
          // An item already on another line is hidden here, so the same item cannot be listed twice.
          availableItemTypes={itemTypes.filter((i) => i.id === line.itemTypeId || !taken.has(i.id))}
          itemTypeId={line.itemTypeId}
          editing={line.editing}
          onItemChange={(id) =>
            setLines((prev) => prev.map((l) => (l.key === line.key ? { ...l, itemTypeId: id } : l)))
          }
          onDone={() => setEditing(line.key, false)}
          onEdit={() => setEditing(line.key, true)}
          onRemove={() => setLines((prev) => prev.filter((l) => l.key !== line.key))}
        />
      ))}
    </ActionForm>
  );
}

/** A button at the top right opens the delivery form in a pop-up; saving takes you to the new batch's labels. */
export function StockInForm({ header, ...fields }: FormProps & { header: ReactNode }) {
  return (
    <FormDialog buttonLabel="Receive stock" title="Receive a delivery" header={header}>
      <StockInFields {...fields} />
    </FormDialog>
  );
}
