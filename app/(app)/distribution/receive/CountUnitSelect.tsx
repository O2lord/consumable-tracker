"use client";

import { Select } from "@/components/ui/Dropdown";
import type { CountUnit } from "@/lib/pack-size";

const OPTIONS = [
  { value: "pack", label: "Packs" },
  { value: "pieces", label: "Pieces" },
] as const;

/**
 * Lets the receiver say whether they counted whole packs or single pieces, using the app's own dropdown.
 * Works inside a plain form (uncontrolled, posts as `countedIn`) or controlled when `value` and `onChange` are given.
 */
export function CountUnitSelect({
  batchCode,
  defaultValue,
  value,
  onChange,
}: {
  batchCode: string;
  defaultValue: CountUnit;
  value?: CountUnit;
  onChange?: (unit: CountUnit) => void;
}) {
  return (
    <div className="w-36">
      <Select
        name="countedIn"
        ariaLabel={`Counted in packs or pieces for ${batchCode}`}
        options={OPTIONS}
        defaultValue={defaultValue}
        value={value}
        searchable={false}
        onChange={(v) => onChange?.(v as CountUnit)}
      />
    </div>
  );
}
