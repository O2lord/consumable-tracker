// Piece equivalents for items counted in packs (corrections C3). Display only: the ledger counts in the item's
// own unit and never converts, so nothing here ever changes a stock figure.

/** True for an item whose stock unit is a pack ("Pack", "Packs"). */
export function isPackUnit(unit: string | null | undefined): boolean {
  return /^packs?$/i.test((unit ?? "").trim());
}

/** True for an item whose stock unit is a physical pack or roll, so each one gets its own barcode label. */
export function hasPackLabels(unit: string | null | undefined): boolean {
  return /^(packs?|rolls?)$/i.test((unit ?? "").trim());
}

/**
 * How many pieces `quantity` packs come to, or null when there is nothing worth showing: the unit is not a
 * pack, or a pack is a single piece (the number would only repeat itself).
 */
export function pieceEquivalent(quantity: number, unit: string | null | undefined, packSize: number): number | null {
  if (!isPackUnit(unit)) return null;
  if (!Number.isInteger(packSize) || packSize <= 1) return null;
  return quantity * packSize;
}

// --- Loose pieces -------------------------------------------------------------------------------------------
// A location holds sealed packs and, separately, loose pieces (an opened pack with some pieces taken out). The
// ledger keeps the two apart: sealed packs in v_quantity_balance, loose pieces in v_loose_pieces. These helpers are
// the pure arithmetic for moving between them. They never touch a database.

/** How a dispatch of loose pieces is taken from a batch: how many sealed packs get opened, and what is left. */
export interface PieceDispatchPlan {
  /** Sealed packs to open first. Zero when the loose pieces already cover it. */
  opened: number;
  sealedAfter: number;
  looseAfter: number;
}

/**
 * Takes `pieces` from a batch holding `sealed` packs and `loose` pieces. Loose pieces go first; only when they run
 * out is another sealed pack opened, and what is left of that pack stays loose. For the store with 10 packs of
 * 100 sending 20 pieces: one pack is opened, leaving 9 sealed packs and 80 loose pieces.
 */
export function planPieceDispatch(args: {
  sealed: number;
  loose: number;
  packSize: number;
  pieces: number;
}): PieceDispatchPlan | { error: string } {
  const { sealed, loose, packSize, pieces } = args;
  if (!Number.isInteger(pieces) || pieces < 1) return { error: "Enter a whole number of pieces, at least 1" };
  if (!Number.isInteger(packSize) || packSize <= 1) return { error: "This item has no pack size set" };

  const available = Math.max(sealed, 0) * packSize + Math.max(loose, 0);
  if (pieces > available) {
    return { error: `Only ${available.toLocaleString("en-GB")} pieces are available (${describeHolding(sealed, loose)})` };
  }
  const short = Math.max(pieces - loose, 0);
  const opened = Math.ceil(short / packSize);
  return { opened, sealedAfter: sealed - opened, looseAfter: loose + opened * packSize - pieces };
}

/**
 * What a batch still has free once other open drafts have taken their share. Drafts in pieces take loose pieces
 * first and then open sealed packs, exactly as the dispatch will; drafts in packs take sealed packs. Never negative.
 */
export function holdingAfterDrafts(args: {
  sealed: number;
  loose: number;
  packSize: number;
  reservedPacks: number;
  reservedPieces: number;
}): { sealed: number; loose: number } {
  const { loose, packSize, reservedPacks, reservedPieces } = args;
  const sealed = Math.max(args.sealed - reservedPacks, 0);
  if (reservedPieces <= 0) return { sealed, loose: Math.max(loose, 0) };
  const plan = planPieceDispatch({ sealed, loose, packSize, pieces: reservedPieces });
  if ("error" in plan) return { sealed: 0, loose: 0 };
  return { sealed: plan.sealedAfter, loose: plan.looseAfter };
}

/** Total pieces a location holds: sealed packs counted out in pieces, plus the loose ones. */
export function totalPieces(sealed: number, loose: number, packSize: number): number {
  return sealed * packSize + loose;
}

/** "9 packs + 80 pieces", "20 pieces", "10 packs", "1 pack + 1 piece", or "0 packs" for nothing. */
export function describeHolding(sealed: number, loose: number): string {
  const parts: string[] = [];
  if (sealed !== 0 || loose === 0) parts.push(`${sealed.toLocaleString("en-GB")} ${sealed === 1 ? "pack" : "packs"}`);
  if (loose > 0) parts.push(`${loose.toLocaleString("en-GB")} ${loose === 1 ? "piece" : "pieces"}`);
  return parts.join(" + ");
}

/** True for an item whose stock unit is single pieces ("Piece", "Pieces"). */
export function isPieceUnit(unit: string | null | undefined): boolean {
  return /^pieces?$/i.test((unit ?? "").trim());
}

/**
 * The unit a per-test quantity is counted in. A pack item (unit "Pack", pack size above 1) is issued for a test in
 * loose pieces, so its quantity there is a number of pieces; any other item uses its own unit.
 */
export function perTestUnit(unit: string | null | undefined, packSize: number): string {
  return isPackUnit(unit) && Number.isInteger(packSize) && packSize > 1 ? "pieces" : (unit ?? "").trim();
}

/**
 * Which way a quantity is being typed: "stock" is the item's own unit, "alt" is the other one
 * (pieces for a pack item, packs for a pieces item).
 */
export type EntryUnit = "stock" | "alt";

/** True when an item can be counted in its other unit: it is a pack or pieces item with a real pack size. */
export function canSwitchUnit(unit: string | null | undefined, packSize: number): boolean {
  if (!Number.isInteger(packSize) || packSize <= 1) return false;
  return isPackUnit(unit) || isPieceUnit(unit);
}

/** A request line as it is saved: a number, and whether that number counts loose pieces instead of the item's unit. */
export interface RequestLineQuantity {
  quantity: number;
  /** True when `quantity` is loose pieces of a pack item (the ledger then moves them as pieces, opening a pack). */
  inPieces: boolean;
}

/**
 * Turns what was typed on a request into what is saved. Pieces for a pack item that come to whole packs are saved
 * as packs (so the common case looks exactly as before); any other number of pieces is kept as pieces, which is
 * how a lab can ask for 10 swabs from a pack of 100. Packs for a pieces item always convert to pieces.
 */
export function toRequestQuantity(
  quantity: number,
  entry: EntryUnit,
  unit: string | null | undefined,
  packSize: number,
): RequestLineQuantity | { error: string } {
  if (entry === "stock") return { quantity, inPieces: false };
  if (!canSwitchUnit(unit, packSize)) {
    return { error: "This item has no pack size set, so it can only be requested in its own unit" };
  }
  if (isPackUnit(unit)) {
    return quantity % packSize === 0
      ? { quantity: quantity / packSize, inPieces: false }
      : { quantity, inPieces: true };
  }
  return { quantity: quantity * packSize, inPieces: false };
}

/** "10 pieces", "2 packs", "1 pack": a request quantity worded for people, using the item's unit unless it is in pieces. */
export function describeRequestQuantity(quantity: number, unit: string | null | undefined, inPieces: boolean): string {
  if (inPieces) return `${quantity.toLocaleString("en-GB")} ${quantity === 1 ? "piece" : "pieces"}`;
  const u = (unit ?? "").trim();
  if (isPackUnit(u)) return `${quantity.toLocaleString("en-GB")} ${quantity === 1 ? "pack" : "packs"}`;
  if (isPieceUnit(u)) return `${quantity.toLocaleString("en-GB")} ${quantity === 1 ? "piece" : "pieces"}`;
  return `${quantity.toLocaleString("en-GB")} ${u || "units"}`.trim();
}

/**
 * Turns a quantity typed in `entry` into the item's own stock unit, which is the only unit the ledger counts in.
 * Pieces for a pack item must come to a whole number of packs. Packs for a pieces item always convert.
 * (Requests use toRequestQuantity instead, which keeps part-pack pieces as pieces.)
 */
export function toStockQuantity(
  quantity: number,
  entry: EntryUnit,
  unit: string | null | undefined,
  packSize: number,
): { quantity: number } | { error: string } {
  if (entry === "stock") return { quantity };
  if (!canSwitchUnit(unit, packSize)) {
    return { error: "This item has no pack size set, so it can only be requested in its own unit" };
  }
  if (isPackUnit(unit)) {
    if (quantity % packSize !== 0) {
      return { error: `${quantity.toLocaleString("en-GB")} pieces is not a whole number of packs (${packSize.toLocaleString("en-GB")} pieces per pack)` };
    }
    return { quantity: quantity / packSize };
  }
  return { quantity: quantity * packSize };
}

// --- Counting a received batch ------------------------------------------------------------------------------
/** What a receiver says they counted: whole packs or single pieces. */
export type CountUnit = "pack" | "pieces";

/** The unit a received line is held in: pieces when it was sent as loose pieces (or the item is counted in pieces), else packs. */
export function lineCountUnit(unit: string | null | undefined, inPieces: boolean): CountUnit {
  return inPieces || isPieceUnit(unit) ? "pieces" : "pack";
}

/**
 * Turns what the receiver counted (in packs or in pieces) into the unit the line was sent in, so it can be compared
 * with the dispatched quantity. Pieces counted against a line sent in packs must come to a whole number of packs.
 * Items with no pack size, or in other units (rolls, boxes), have no choice: the count is taken as typed.
 */
export function toLineQuantity(args: {
  counted: number;
  countedIn: CountUnit;
  unit: string | null | undefined;
  inPieces: boolean;
  packSize: number;
}): { quantity: number } | { error: string } {
  const { counted, countedIn, unit, inPieces, packSize } = args;
  if (!canSwitchUnit(unit, packSize)) return { quantity: counted };
  const lineIn = lineCountUnit(unit, inPieces);
  if (countedIn === lineIn) return { quantity: counted };
  if (countedIn === "pack") return { quantity: counted * packSize }; // packs counted, line is in pieces
  if (counted % packSize !== 0) {
    return {
      error: `${counted.toLocaleString("en-GB")} pieces is not a whole number of packs (${packSize.toLocaleString("en-GB")} pieces per pack). This batch was sent in whole packs, so count it in packs`,
    };
  }
  return { quantity: counted / packSize }; // pieces counted, line is in packs
}
