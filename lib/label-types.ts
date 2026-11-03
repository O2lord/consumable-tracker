// What goes on a printed label. Pure types shared by the ZPL and PDF renderers.

export interface SerialLabel {
  kind: "serial";
  serial: string;
  itemName: string;
  containerType?: string | null;
  batchCode: string;
  /** YYYY-MM-DD */
  expiryDate?: string | null;
  lotNo?: string | null;
}

export interface BatchLabel {
  kind: "batch";
  /** The batch code (BT...) that is encoded in the barcode. */
  code: string;
  itemName: string;
  quantity: number;
  /** Cartons the batch was received as. When set, the label says this instead of the piece count. */
  cartonCount?: number;
  /**
   * YYYY-MM-DD. Set for stock the lab made itself (a conversion): the label then says when it was prepared, in place of
   * the quantity, and leaves the lot off (the lot is the conversion code, and the barcode already names the batch).
   */
  preparedOn?: string | null;
  expiryDate?: string | null;
  lotNo?: string | null;
}

/** One label for a whole delivery. It prints first, ahead of the batch labels of the items in it. */
export interface DeliveryLabel {
  kind: "delivery";
  /** The delivery code (DV...) that is encoded in the barcode. */
  code: string;
  /** The title line, for example "Delivery - Idris". */
  itemName: string;
  itemCount: number;
  /** YYYY-MM-DD */
  receivedDate?: string | null;
}

/** One label for a carton. Its barcode is the carton code (CN...); the pack and bottle labels inside point back to it. */
export interface CartonLabel {
  kind: "carton";
  /** The carton code (CN...) that is encoded in the barcode. */
  code: string;
  itemName: string;
  /** What the carton held when received: packs, or the items themselves when the item has no pack level. */
  packsCount: number;
  piecesCount: number;
  /** "pack", "bag", "roll"... as the item's own unit is worded. Defaults to "pack". */
  packWord?: string;
  batchCode: string;
  expiryDate?: string | null;
  lotNo?: string | null;
}

export type Label = SerialLabel | BatchLabel | DeliveryLabel | CartonLabel;

/** The text that is encoded in the barcode. */
export function barcodeText(label: Label): string {
  return label.kind === "serial" ? label.serial : label.code;
}

/** Cuts text to fit a label, adding "..." when shortened. */
export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 3))}...`;
}

/** Small details line shown under the barcode, for example "EXP 2027-03-31  LOT A123". */
export function detailLine(label: Label): string {
  const parts: string[] = [];
  if (label.kind === "batch") {
    // Made in the lab: the day it was prepared. Received in cartons: say how many cartons. Otherwise the quantity is
    // all there is to count.
    if (label.preparedOn) parts.push(`PREP ${label.preparedOn}`);
    else if (label.cartonCount) parts.push(`${label.cartonCount} ${label.cartonCount === 1 ? "CARTON" : "CARTONS"}`);
    else parts.push(`QTY ${label.quantity}`);
  }
  if (label.kind === "carton") {
    const word = (label.packWord ?? "pack").toUpperCase();
    parts.push(`${label.packsCount} ${word}${label.packsCount === 1 ? "" : "S"}`);
  }
  if (label.kind === "delivery") {
    parts.push(`${label.itemCount} ${label.itemCount === 1 ? "ITEM" : "ITEMS"}`);
    if (label.receivedDate) parts.push(label.receivedDate);
  }
  if (label.kind !== "delivery") {
    if (label.expiryDate) parts.push(`EXP ${label.expiryDate}`);
    // The details line fits about 38 characters: "PREP 2026-11-03  EXP 2026-11-25" does, with the lot it would not.
    if (label.lotNo && !(label.kind === "batch" && label.preparedOn)) parts.push(`LOT ${label.lotNo}`);
  }
  // Skip the container type when the item name already says it (for example "EDTA" in "EDTA-5ML Bottle").
  if (label.kind === "serial" && label.containerType && !label.itemName.toLowerCase().includes(label.containerType.toLowerCase())) {
    parts.unshift(label.containerType);
  }
  return parts.join("  ");
}
