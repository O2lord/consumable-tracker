"use client";

import { useState } from "react";
import { Select } from "@/components/ui/Dropdown";
import { ghostButtonClass, inputClass } from "@/components/ui/styles";

export interface ItemChoice {
  id: string;
  name: string;
  unit: string;
}

interface Props {
  /** The bulk item types that can be listed. Serialized items are scanned one by one, so they are not offered. */
  choices: ItemChoice[];
  /** What is saved for this test now. Names come with it so a deactivated item is still readable. */
  initial: { itemTypeId: string; name: string; unit: string; quantity: number }[];
}

/**
 * The list of items one run of a test uses, with a quantity for each. Rows are submitted as paired
 * `itemTypeId` / `quantity` fields in the same order. Saving an empty list clears the test's items.
 */
export function StandardItemsEditor({ choices, initial }: Props) {
  const [rows, setRows] = useState(initial.map((r) => ({ itemTypeId: r.itemTypeId, quantity: String(r.quantity) })));
  const [toAdd, setToAdd] = useState("");

  const known = new Map<string, ItemChoice>([
    ...choices.map((c) => [c.id, c] as const),
    ...initial.map((r) => [r.itemTypeId, { id: r.itemTypeId, name: r.name, unit: r.unit }] as const),
  ]);
  const addable = choices.filter((c) => !rows.some((r) => r.itemTypeId === c.id));

  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm font-medium">Items used per test</p>
      {rows.length === 0 ? <p className="text-sm text-zinc-500">No items listed yet.</p> : null}
      {rows.map((row, index) => {
        const item = known.get(row.itemTypeId);
        return (
          <div key={row.itemTypeId} className="grid grid-cols-[1fr_7rem_auto] items-center gap-2">
            <span className="min-w-0 truncate text-sm">
              {item?.name ?? "Item"}
              {item ? <span className="text-zinc-500"> ({item.unit})</span> : null}
            </span>
            <input type="hidden" name="itemTypeId" value={row.itemTypeId} />
            <input
              name="quantity"
              type="number"
              min={1}
              step={1}
              required
              inputMode="numeric"
              aria-label={`Quantity of ${item?.name ?? "item"} per test`}
              value={row.quantity}
              onChange={(e) => setRows(rows.map((r, i) => (i === index ? { ...r, quantity: e.target.value } : r)))}
              className={inputClass}
            />
            <button
              type="button"
              onClick={() => {
                setRows(rows.filter((_, i) => i !== index));
                setToAdd("");
              }}
              className={ghostButtonClass}
              aria-label={`Remove ${item?.name ?? "item"}`}
            >
              Remove
            </button>
          </div>
        );
      })}
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          {/* Remounted after each add (the key) so the choice goes back to blank. */}
          <Select
            key={rows.length}
            name="addItem"
            ariaLabel="Item to add"
            emptyLabel="Add an item"
            options={addable.map((c) => ({ value: c.id, label: `${c.name} (${c.unit})` }))}
            onChange={setToAdd}
          />
        </div>
        <button
          type="button"
          disabled={!toAdd}
          onClick={() => {
            setRows([...rows, { itemTypeId: toAdd, quantity: "1" }]);
            setToAdd("");
          }}
          className={ghostButtonClass}
        >
          Add
        </button>
      </div>
    </div>
  );
}
