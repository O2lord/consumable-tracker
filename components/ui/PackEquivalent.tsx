import { pieceEquivalent } from "@/lib/pack-size";

/** The wording behind the hover hint: "100 pieces", plus a note until the lab has confirmed the pack size. */
export function packEquivalentText(pieces: number, confirmed: boolean): string {
  return `${pieces.toLocaleString("en-GB")} ${pieces === 1 ? "piece" : "pieces"}${confirmed ? "" : " (pack size unconfirmed)"}`;
}

/**
 * A small "i" after a pack quantity. The piece count ("100 pieces") shows only when the pointer rests on it,
 * so tables and forms stay clean. The "i" turns amber until the lab has confirmed the pack size. Shows nothing
 * for items that are not counted in packs. Display only: it never changes the quantity it sits beside.
 */
export function PackEquivalent({
  quantity,
  unit,
  packSize,
  confirmed,
}: {
  quantity: number;
  unit: string | null | undefined;
  packSize: number;
  confirmed: boolean;
}) {
  const pieces = pieceEquivalent(quantity, unit, packSize);
  if (pieces === null) return null;
  const text = packEquivalentText(pieces, confirmed);
  return (
    <span
      role="img"
      aria-label={text}
      title={text}
      className={`ml-1.5 inline-flex h-4 w-4 cursor-help select-none items-center justify-center rounded-full border align-middle text-[10px] font-semibold leading-none ${
        confirmed ? "border-line text-muted hover:bg-brand-soft" : "border-warn/40 bg-warn-soft text-warn"
      }`}
    >
      i
    </span>
  );
}
