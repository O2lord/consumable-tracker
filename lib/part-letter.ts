// Part letters for a batch that is sent in pieces: A, B, C ... Z, then AA, AB ... (spreadsheet style).
// The first piece dispatched from a batch is part A, the second part B, and so on.
// SQL backfill in 20261007000700_transfer_batch_parts.sql uses the same scheme.

/** 1 -> "A", 26 -> "Z", 27 -> "AA", 28 -> "AB", 702 -> "ZZ". */
export function partLetter(n: number): string {
  if (!Number.isInteger(n) || n < 1) throw new RangeError("Part number must be a whole number from 1");
  let rest = n;
  let out = "";
  while (rest > 0) {
    const r = (rest - 1) % 26;
    out = String.fromCharCode(65 + r) + out;
    rest = Math.floor((rest - 1) / 26);
  }
  return out;
}

/** How a part is written on screens and slips, for example "BT7K2M9QXR4 part B". */
export function partName(batchCode: string, letter: string): string {
  return `${batchCode} part ${letter}`;
}
