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

// --- Receiving by carton, pack or pieces --------------------------------------------------------------------
// A delivery arrives in cartons (packs per carton, pieces per pack). The ledger still counts in the item's own stock
// unit and never converts; these helpers turn what the receiver typed into that unit and say how many cartons, packs
// and items get a barcode. Pure arithmetic: nothing here touches a database.

/** What a delivery line can be counted in. */
export const RECEIVE_ENTRIES = ["carton", "pack", "pieces"] as const;
export type ReceiveEntry = (typeof RECEIVE_ENTRIES)[number];

/** The largest quantity (in the item's own stock unit) one delivery line may record. */
export const MAX_RECEIVED_QUANTITY = 10_000_000;

/** The item facts a receipt needs. `packsPerCarton` is null when the item has no carton size. */
export interface ReceiveItem {
  unit: string | null | undefined;
  packSize: number;
  /** Packs (or bags, rolls, bottles) in one carton as delivered. */
  packsPerCarton: number | null | undefined;
  /**
   * Tests one container covers, for a reagent counted in tests. Left out or null for every other item. For such a
   * reagent the stock unit is the container itself: each container is received as one and gets its own PK label, and
   * `packSize` (which holds the tests) is never used to multiply a count.
   */
  testsPerUnit?: number | null;
}

function piecesPerPackOf(packSize: number): number {
  return Number.isInteger(packSize) && packSize >= 1 ? packSize : 1;
}

/** The tests per container of a reagent counted in tests, or null for any other item. */
function containerTestsOf(testsPerUnit: number | null | undefined): number | null {
  return typeof testsPerUnit === "number" && Number.isInteger(testsPerUnit) && testsPerUnit >= 1 ? testsPerUnit : null;
}

/** Pieces in one pack when counting a received line. A reagent container is one stock unit, so it is 1 there. */
function receivedPiecesPerPack(item: { packSize: number; testsPerUnit?: number | null }): number {
  return containerTestsOf(item.testsPerUnit) !== null ? 1 : piecesPerPackOf(item.packSize);
}

/** Pieces in one unit of the item's own stock unit: a whole pack for a pack item, otherwise one. */
function piecesPerStockUnit(unit: string | null | undefined, packSize: number): number {
  return isPackUnit(unit) ? piecesPerPackOf(packSize) : 1;
}

function hasCartonSize(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1;
}

/** True when the item has a pack level at all: a real pack size, or a pack or roll that is counted as one. */
export function hasPackLevel(
  unit: string | null | undefined,
  packSize: number,
  testsPerUnit?: number | null,
): boolean {
  return containerTestsOf(testsPerUnit) !== null || piecesPerPackOf(packSize) > 1 || hasPackLabels(unit);
}

/** True for a reagent counted in tests: every container it comes in gets its own PK label. */
export function hasContainerLabels(testsPerUnit: number | null | undefined): boolean {
  return containerTestsOf(testsPerUnit) !== null;
}

export interface ReceiveChoices {
  carton: boolean;
  pack: boolean;
  pieces: true;
  /** What the form starts on: cartons when the item has a carton size, then packs, then pieces. */
  default: ReceiveEntry;
}

/** Which of carton, pack and pieces this item can be received in. Pieces always can. */
export function receiveChoices(item: ReceiveItem): ReceiveChoices {
  const carton = hasCartonSize(item.packsPerCarton);
  const pack = hasPackLevel(item.unit, item.packSize, item.testsPerUnit);
  return { carton, pack, pieces: true, default: carton ? "carton" : pack ? "pack" : "pieces" };
}

/**
 * Turns a quantity typed in cartons, packs or pieces into the item's own stock unit (what the ledger records).
 * `cartons` is how many cartons were counted, or null when the line was not counted in cartons. Pieces that do not
 * come to a whole number of packs are refused for a pack item: stock comes in as whole packs.
 */
export function toReceivedQuantity(
  args: ReceiveItem & { entry: ReceiveEntry; quantity: number },
): { quantity: number; cartons: number | null } | { error: string } {
  const { entry, quantity } = args;
  if (!Number.isInteger(quantity) || quantity < 1) return { error: "Enter a whole-number quantity" };
  // A reagent container is one stock unit: counting 5 containers is 5, never 5 x its tests.
  const perPack = receivedPiecesPerPack(args);

  let pieces: number;
  if (entry === "carton") {
    if (!hasCartonSize(args.packsPerCarton)) {
      return { error: "This item has no carton size set, so it cannot be received in cartons" };
    }
    pieces = quantity * args.packsPerCarton * perPack;
  } else if (entry === "pack") {
    if (!hasPackLevel(args.unit, args.packSize, args.testsPerUnit)) {
      return { error: "This item has no pack size set, so it cannot be received in packs" };
    }
    pieces = quantity * perPack;
  } else {
    pieces = quantity;
  }

  const perStock = containerTestsOf(args.testsPerUnit) !== null ? 1 : piecesPerStockUnit(args.unit, args.packSize);
  if (pieces % perStock !== 0) {
    return {
      error: `${pieces.toLocaleString("en-GB")} pieces is not a whole number of packs (${perStock.toLocaleString("en-GB")} pieces per pack). Stock comes in as whole packs: loose pieces only appear when a pack is opened and part of it is sent`,
    };
  }
  const stock = pieces / perStock;
  if (stock > MAX_RECEIVED_QUANTITY) return { error: "That quantity is too large for one delivery line" };
  return { quantity: stock, cartons: entry === "carton" ? quantity : null };
}

/** What receiving a line creates: the stock quantity, and how many labels each level gets. */
export interface ReceiptPlan {
  /** In the item's own stock unit: what the ledger records and `batches.quantity` holds. */
  quantity: number;
  /** Carton labels (CN...). Zero unless the line was counted in cartons. */
  cartons: number;
  /** Pack labels (PK...). Zero when the item gets none. */
  packs: number;
  /** Item labels (CT...), one per bottle. Zero for items that are counted, not tracked one by one. */
  items: number;
  /** What one carton holds: packs, or the items themselves when the item has no pack level. */
  packsPerCarton: number;
  piecesPerPack: number;
}

/**
 * The single place that decides what a received line becomes. Leave `entry` out to count in the item's own unit with
 * no cartons and no extra pack labels (how every receipt worked before cartons existed).
 *
 * - SERIAL items: one CT label per bottle. Pack labels exist only when the line was counted in packs or cartons and
 *   the item has a pack size above 1; the bottles then belong to those packs.
 * - QUANTITY items counted in packs or rolls: one PK label per pack or roll, as before.
 * - QUANTITY items counted in pieces (anti-sera, markers): no PK labels. A scan of a pack could only move one piece
 *   for them, so pack labels wait for the scanning step. Cartons still get labels.
 * - Reagents counted in tests (formalin, a kit): the container is the stock unit and gets one PK label, so two
 *   containers of the same batch can be told apart when one is opened. `piecesPerPack` is then the tests per container.
 */
export function planReceipt(
  args: ReceiveItem & { entry: ReceiveEntry | undefined; quantity: number; serial: boolean },
): ReceiptPlan | { error: string } {
  const containerTests = containerTestsOf(args.testsPerUnit);
  const perPack = receivedPiecesPerPack(args);
  const packsPerCarton = hasCartonSize(args.packsPerCarton) ? args.packsPerCarton : 0;

  let quantity: number;
  let cartons = 0;
  if (args.entry === undefined) {
    if (!Number.isInteger(args.quantity) || args.quantity < 1) return { error: "Enter a whole-number quantity" };
    quantity = args.quantity;
  } else {
    const converted = toReceivedQuantity({ ...args, entry: args.entry });
    if ("error" in converted) return converted;
    quantity = converted.quantity;
    cartons = converted.cartons ?? 0;
  }

  let packs = 0;
  if (args.serial) {
    if (args.entry !== undefined && args.entry !== "pieces" && perPack > 1 && quantity % perPack === 0) {
      packs = quantity / perPack;
    }
  } else if (hasPackLabels(args.unit) || containerTests !== null) {
    packs = quantity;
  }
  return {
    quantity,
    cartons,
    packs,
    items: args.serial ? quantity : 0,
    packsPerCarton,
    piecesPerPack: containerTests ?? perPack,
  };
}

