"use client";

import { useState, type ReactNode } from "react";
import { ActionForm } from "@/components/forms/ActionForm";
import { FormDialog } from "@/components/forms/FormDialog";
import { Select } from "@/components/ui/Dropdown";
import { Field } from "@/components/ui/Field";
import { inputClass, linkButtonClass } from "@/components/ui/styles";
import { UnitSwitch } from "@/components/ui/UnitSwitch";
import { isPackUnit, planReceipt, receiveChoices, type ReceiveEntry, type ReceiptPlan } from "@/lib/pack-size";
import { MAX_SERIAL_BATCH } from "@/types/stock-in";
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
  /** Packs (bags, rolls, bottles) in one carton as delivered. Null when no carton size is set. */
  packsPerCarton: number | null;
  /** Tests one container covers, for a reagent counted in tests. Each container is received whole and gets its own label. */
  testsPerUnit: number | null;
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

const n = (value: number) => value.toLocaleString("en-GB");
const plural = (count: number, one: string, many: string) => `${n(count)} ${count === 1 ? one : many}`;

/** What a line counted this way comes to, for example "2 cartons = 36 packs = 3,600 bottles. 3,639 labels will be made". */
function describePlan(item: ItemTypeOption, plan: ReceiptPlan, entry: ReceiveEntry): string {
  // A reagent counted in tests is received in containers, each with its own label and all its tests.
  if (item.testsPerUnit !== null) {
    const parts: string[] = [];
    if (plan.cartons > 0) parts.push(plural(plan.cartons, "carton", "cartons"));
    parts.push(plural(plan.quantity, "container", "containers"));
    parts.push(plural(plan.quantity * item.testsPerUnit, "test", "tests"));
    return `${parts.join(" = ")}. ${plural(1 + plan.cartons + plan.packs, "label", "labels")} will be made`;
  }
  const serial = item.trackingMode === "SERIAL";
  const perPack = item.packSize >= 1 ? item.packSize : 1;
  // Pieces: bottles for a serial item, otherwise the stock unit counted out (a pack item holds packSize pieces a pack).
  const pieces = serial ? plan.quantity : plan.quantity * (isPackUnit(item.unit) ? perPack : 1);
  const packsTotal = perPack > 1 && pieces % perPack === 0 ? pieces / perPack : plan.packs > 0 ? plan.packs : null;
  const noun = serial ? plural(pieces, "bottle", "bottles") : plural(pieces, "piece", "pieces");

  const parts: string[] = [];
  if (plan.cartons > 0) parts.push(plural(plan.cartons, "carton", "cartons"));
  if (packsTotal !== null && (entry !== "pieces" || plan.cartons === 0)) parts.push(plural(packsTotal, "pack", "packs"));
  if (parts.length === 0 || pieces !== packsTotal) parts.push(noun);
  // A batch label always prints; cartons, packs and bottles add to it.
  const labels = 1 + plan.cartons + plan.packs + plan.items;
  return `${parts.join(" = ")}. ${plural(labels, "label", "labels")} will be made`;
}

/** Which of cartons, packs and pieces an item can be received in (pure, from its sizes). */
function choicesOf(item: ItemTypeOption) {
  return receiveChoices({
    unit: item.unit,
    packSize: item.packSize,
    packsPerCarton: item.packsPerCarton,
    testsPerUnit: item.testsPerUnit,
  });
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
  const selected = itemTypes.find((i) => i.id === itemTypeId);
  // What the quantity is counted in. It starts on cartons when the item has a carton size, then packs, then pieces.
  const [entry, setEntry] = useState<ReceiveEntry>(() => (selected ? choicesOf(selected).default : "pieces"));

  const isSerial = selected?.trackingMode === "SERIAL";
  const choices = selected ? choicesOf(selected) : null;
  const isRoll = !!selected && /^rolls?$/i.test(selected.unit.trim());
  const isContainer = !!selected && selected.testsPerUnit !== null;
  const packWord = isContainer ? "containers" : isRoll ? "rolls" : "packs";
  const qty = Number(quantity);
  const plan: ReceiptPlan | { error: string } | null =
    selected && Number.isInteger(qty) && qty > 0
      ? planReceipt({
          unit: selected.unit,
          packSize: selected.packSize,
          packsPerCarton: selected.packsPerCarton,
          testsPerUnit: selected.testsPerUnit,
          entry,
          quantity: qty,
          serial: isSerial,
        })
      : null;
  // One line makes at most this many bottle or pack labels, so a big delivery has to be split over two lines.
  const tooMany =
    plan && !("error" in plan) && (plan.items > MAX_SERIAL_BATCH || plan.packs > MAX_SERIAL_BATCH)
      ? `That comes to ${n(Math.max(plan.items, plan.packs))} labels, and at most ${n(MAX_SERIAL_BATCH)} can be made at a time. Receive it as two or more lines.`
      : null;
  const unitLabel = !selected ? "" : entry === "carton" ? "cartons" : entry === "pack" ? packWord : isSerial ? "bottles" : "pieces";

  let hint: string;
  if (isSerial) hint = `One barcode label is made for each bottle (up to ${n(MAX_SERIAL_BATCH)} at a time), and one for each carton and pack.`;
  else if (isContainer) hint = "One label is made for the whole batch, plus one for each carton and one for each container, so a container can be scanned when it is opened.";
  else hint = "One label is made for the whole batch, plus one for each carton and pack.";

  const handleDone = () => {
    // An empty quantity is fine here: the row stays marked "Quantity needed" and is checked when the delivery is received.
    if (quantity && (!Number.isInteger(qty) || qty < 1)) return setError("Enter a whole-number quantity.");
    if (plan && "error" in plan) return setError(plan.error);
    if (tooMany) return setError(tooMany);
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
                const next = itemTypes.find((i) => i.id === value);
                setEntry(next ? choicesOf(next).default : "pieces");
                setError(null);
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
              {selected && choices ? (
                <UnitSwitch
                  ariaLabel={`Count ${selected.name} in`}
                  value={entry}
                  onChange={(value) => {
                    setEntry(value as ReceiveEntry);
                    setError(null);
                  }}
                  options={[
                    { value: "carton", label: "Cartons", disabled: !choices.carton, title: "No carton size is set for this item" },
                    {
                      value: "pack",
                      label: isContainer ? "Containers" : isRoll ? "Rolls" : "Packs",
                      disabled: !choices.pack,
                      title: "No pack size is set for this item",
                    },
                    {
                      value: "pieces",
                      label: isSerial ? "Bottles" : "Pieces",
                      disabled: isRoll || isContainer,
                      title: isContainer ? "A reagent is counted in whole containers" : "Rolls are counted whole",
                    },
                  ]}
                />
              ) : null}
            </div>
          </Field>
        </div>
        <p className="-mt-1 text-xs text-zinc-500">{hint}</p>

        {plan && "error" in plan ? (
          <p className="text-xs text-warn">{plan.error}</p>
        ) : plan && selected ? (
          <p className={`text-xs ${tooMany ? "font-semibold text-warn" : "text-zinc-500"}`}>
            {tooMany ?? describePlan(selected, plan, entry)}
            {selected.packSizeConfirmed || entry === "pieces" ? null : (
              <span className="ml-1 rounded-full bg-warn-soft px-1.5 py-0.5 text-[10px] font-semibold text-warn">unconfirmed</span>
            )}
          </p>
        ) : selected && choices && !choices.carton && !choices.pack ? (
          <p className="text-xs text-zinc-500">No carton or pack size is set for this item, so it can only be received in pieces.</p>
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
