import { Tag } from "@/components/ui/Tag";

/**
 * "Keep cold" beside an item that must be stored in the fridge (corrections C9). Shows nothing for other items.
 * Display only: it never blocks or changes anything.
 */
export function ColdStorageTag({ cold }: { cold: boolean | null | undefined }) {
  if (!cold) return null;
  return (
    <span className="ml-2 inline-block align-middle">
      <Tag tone="brand">Keep cold</Tag>
    </span>
  );
}
