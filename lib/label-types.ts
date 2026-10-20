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

export type Label = SerialLabel | BatchLabel | DeliveryLabel;

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
  if (label.kind === "batch") parts.push(`QTY ${label.quantity}`);
  if (label.kind === "delivery") {
    parts.push(`${label.itemCount} ${label.itemCount === 1 ? "ITEM" : "ITEMS"}`);
    if (label.receivedDate) parts.push(label.receivedDate);
  }
  if (label.kind !== "delivery") {
    if (label.expiryDate) parts.push(`EXP ${label.expiryDate}`);
    if (label.lotNo) parts.push(`LOT ${label.lotNo}`);
  }
  // Skip the container type when the item name already says it (for example "EDTA" in "EDTA-5ML Bottle").
  if (label.kind === "serial" && label.containerType && !label.itemName.toLowerCase().includes(label.containerType.toLowerCase())) {
    parts.unshift(label.containerType);
  }
  return parts.join("  ");
}
