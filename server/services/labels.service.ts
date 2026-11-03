import "server-only";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "../db/client";
import type { DbOrTx } from "../audit/events";
import { batches, cartons, conversionLines, conversions, deliveries, events, itemTypes, locations, packs, units } from "../db/schema";
import { NotFoundError, ValidationError } from "../domain/errors";
import { env } from "../env";
import { isValidBatchCode, normalizeCode, PACK_PREFIX, parseCartonCode, parseDeliveryCode, parsePackCode, parseSerial } from "../../lib/serial";
import { labelsToZpl } from "../../lib/zpl";
import { labelsToTspl } from "../../lib/tspl";
import { renderTsplPreviewHtml } from "../../lib/tspl-preview";
import { renderLabelsPdf, type PdfLayout, type PdfOptions } from "../../lib/label-pdf";
import { sendToPrinter, sendToQueue } from "../../lib/printer";
import type { Label } from "../../lib/label-types";
import { unitWasTransferred } from "./containment.service";

// Composes label content from the database and renders it as PDF or ZPL, or sends it to the printer.
// The caller checks the permission.

/** Which part of a delivery to print: its own DV label, or just the batch labels of its items. */
export type DeliveryLabelScope = "delivery" | "batches";
/**
 * Which part of a batch to print: its own batch (or box) label, only its carton, pack or bottle labels, or everything
 * under it (items). Cartons, packs and bottles are separate levels so a store can print one level at a time.
 */
export type BatchLabelScope = "batch" | "items" | "cartons" | "packs" | "bottles";
/** Which part of a carton to print: its own label, or only the pack or bottle labels inside it. */
export type CartonLabelScope = "carton" | "packs" | "bottles";
/** Which part of a pack to print: its own label, or only the bottle labels inside it. */
export type PackLabelScope = "pack" | "bottles";

/** Leave `only` out to get the label and everything under it together. */
export type LabelTarget =
  | { batch: string; only?: BatchLabelScope }
  | { carton: string; only?: CartonLabelScope }
  | { pack: string; only?: PackLabelScope }
  | { serial: string }
  | { delivery: string; only?: DeliveryLabelScope };

type Level = "carton" | "pack" | "bottle";

/** Which level a label belongs to, for printing one level at a time. */
function levelOf(label: Label): Level {
  if (label.kind === "carton") return "carton";
  if (label.kind === "serial" && label.serial.startsWith(PACK_PREFIX)) return "pack";
  return "bottle";
}

const SCOPE_LEVEL: Record<string, Level> = {
  cartons: "carton",
  carton: "carton",
  packs: "pack",
  pack: "pack",
  bottles: "bottle",
};

/** A pack or roll label. It reuses the serial label layout: the barcode is the pack code (PK...). */
function packLabel(p: {
  code: string;
  piecesPerPack: number;
  itemName: string;
  unitOfMeasure: string;
  batchCode: string;
  expiryDate: string | null;
  lotNo: string | null;
  /** Set for a reagent counted in tests: the label then says how many tests the container covers. */
  testsPerUnit?: number | null;
}): Label {
  const unit = /^rolls?$/i.test(p.unitOfMeasure.trim()) ? "Roll" : "Pack";
  return {
    kind: "serial",
    serial: p.code,
    itemName: p.itemName,
    containerType:
      p.testsPerUnit != null
        ? `Container of ${p.testsPerUnit} ${p.testsPerUnit === 1 ? "test" : "tests"}`
        : p.piecesPerPack > 1
          ? `${unit} of ${p.piecesPerPack}`
          : unit,
    batchCode: p.batchCode,
    expiryDate: p.expiryDate,
    lotNo: p.lotNo,
  };
}

/** A carton label. Its barcode is the carton code (CN...). */
function cartonLabel(c: {
  code: string;
  packsCount: number;
  piecesCount: number;
  itemName: string;
  unitOfMeasure: string;
  batchCode: string;
  expiryDate: string | null;
  lotNo: string | null;
}): Label {
  return {
    kind: "carton",
    code: c.code,
    itemName: `Carton - ${c.itemName}`,
    packsCount: c.packsCount,
    piecesCount: c.piecesCount,
    packWord: /^rolls?$/i.test(c.unitOfMeasure.trim()) ? "roll" : "pack",
    batchCode: c.batchCode,
    expiryDate: c.expiryDate,
    lotNo: c.lotNo,
  };
}

/**
 * Puts a batch's labels in the order they are used at the bench, grouped by carton: the carton label, then each pack in
 * it with the bottle labels of that pack straight after, then any bottles that sit in the carton with no pack. Packs
 * and bottles with no carton come last. A label never appears twice, and none is dropped.
 */
function arrangeByCarton(args: {
  cartons: { id: string; label: Label }[];
  packs: { id: string; cartonId: string | null; label: Label }[];
  units: { packId: string | null; cartonId: string | null; label: Label }[];
}): Label[] {
  // A pack or bottle whose carton is not among the cartons given (one pack was asked for on its own, so its carton
  // is not part of the set) is treated as having no carton, so it is still printed.
  const cartonIds = new Set(args.cartons.map((c) => c.id));
  const unitsOfPack = new Map<string, Label[]>();
  const looseInCarton = new Map<string, Label[]>();
  const unattached: Label[] = [];
  for (const u of args.units) {
    if (u.packId) pushTo(unitsOfPack, u.packId, u.label);
    else if (u.cartonId && cartonIds.has(u.cartonId)) pushTo(looseInCarton, u.cartonId, u.label);
    else unattached.push(u.label);
  }
  const packsOfCarton = new Map<string, typeof args.packs>();
  const freePacks: typeof args.packs = [];
  for (const p of args.packs) {
    if (p.cartonId && cartonIds.has(p.cartonId)) pushTo(packsOfCarton, p.cartonId, p);
    else freePacks.push(p);
  }

  const out: Label[] = [];
  const emitPack = (p: (typeof args.packs)[number]) => {
    out.push(p.label);
    for (const l of unitsOfPack.get(p.id) ?? []) out.push(l);
  };
  for (const c of args.cartons) {
    out.push(c.label);
    for (const p of packsOfCarton.get(c.id) ?? []) emitPack(p);
    for (const l of looseInCarton.get(c.id) ?? []) out.push(l);
  }
  for (const p of freePacks) emitPack(p);
  for (const l of unattached) out.push(l);
  return out;
}

function pushTo<T>(map: Map<string, T[]>, key: string, value: T): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

export interface LabelSet {
  labels: Label[];
  /** For download file names. */
  name: string;
}

/** The label for the thing itself ("head"), the labels under it ("children"), or both with the head first. */
function pickLabels(head: Label, children: Label[], part: "head" | "children" | undefined): Label[] {
  if (part === "head") return [head];
  if (part === "children") return children;
  return [head, ...children];
}

/**
 * A delivery gives its own label first (the DV code), then one batch label per item line, in the same order as the
 * delivery page lists them. It does not include each bottle or pack label: open an item to print those.
 * SERIAL batches give a box label first, then one label per unit (in serial order); QUANTITY batches give a batch
 * label, then one label per pack or roll. A single serial can be reprinted on its own.
 *
 * `only` narrows a delivery or batch to one part, so a label that is already printed is not printed again by accident:
 * a delivery gives just its DV label ("delivery") or just its batch labels ("batches"); a batch gives just its batch or
 * box label ("batch") or just the pack, roll or bottle labels under it ("items"). Leave `only` out for everything.
 */
export async function loadLabels(target: LabelTarget, conn: DbOrTx = db(), pick?: number[]): Promise<LabelSet> {
  const set = await composeLabels(target, conn);
  if (set.labels.length === 0) throw new ValidationError("There are no labels of that kind to print");
  return pick ? applyPick(set, pick) : set;
}

/**
 * Keeps only the labels at the given 1-based positions (as numbered in the preview), in the order given.
 * Positions that do not exist are ignored; if none are left, that is an error.
 */
function applyPick(set: LabelSet, pick: number[]): LabelSet {
  const labels = pick.filter((n) => n >= 1 && n <= set.labels.length).map((n) => set.labels[n - 1]);
  if (labels.length === 0) throw new ValidationError("None of the chosen labels exist");
  return { ...set, labels };
}

async function composeLabels(target: LabelTarget, conn: DbOrTx): Promise<LabelSet> {
  if ("delivery" in target) {
    const deliveryCode = parseDeliveryCode(target.delivery);
    if (!deliveryCode) throw new ValidationError("That is not a valid delivery code");
    const [delivery] = await conn
      .select({ id: deliveries.id, supplier: deliveries.supplier, receivedAt: deliveries.receivedAt })
      .from(deliveries)
      .where(eq(deliveries.code, deliveryCode));
    if (!delivery) throw new NotFoundError("Delivery");

    const lines = await conn
      .select({
        id: batches.id,
        code: batches.code,
        quantity: batches.quantity,
        expiryDate: batches.expiryDate,
        lotNo: batches.lotNo,
        itemName: itemTypes.name,
      })
      .from(batches)
      .innerJoin(itemTypes, eq(batches.itemTypeId, itemTypes.id))
      .where(eq(batches.deliveryId, delivery.id))
      .orderBy(asc(itemTypes.name), asc(batches.code));

    // Cartons per batch, so each batch label can say how many cartons it came in.
    const cartonTotals = await conn
      .select({ batchId: cartons.batchId, n: sql<number>`count(*)::int` })
      .from(cartons)
      .where(eq(cartons.deliveryId, delivery.id))
      .groupBy(cartons.batchId);
    const cartonsOfBatch = new Map(cartonTotals.map((c) => [c.batchId, c.n]));

    const deliveryLabel: Label = {
      kind: "delivery",
      code: deliveryCode,
      itemName: delivery.supplier ? `Delivery - ${delivery.supplier}` : "Delivery",
      itemCount: lines.length,
      receivedDate: delivery.receivedAt.toISOString().slice(0, 10),
    };
    const batchLabels: Label[] = lines.map((l) => ({
      kind: "batch",
      code: l.code,
      itemName: l.itemName,
      quantity: l.quantity,
      cartonCount: cartonsOfBatch.get(l.id) ?? 0,
      expiryDate: l.expiryDate,
      lotNo: l.lotNo,
    }));
    const part = target.only === "delivery" ? "head" : target.only === "batches" ? "children" : undefined;
    return { labels: pickLabels(deliveryLabel, batchLabels, part), name: deliveryCode };
  }

  if ("serial" in target) {
    // A carton code (CN...) reprints on its own.
    const cartonCode = parseCartonCode(target.serial);
    if (cartonCode) {
      const [carton] = await conn
        .select({
          code: cartons.code,
          packsCount: cartons.packsCount,
          piecesCount: cartons.piecesCount,
          itemName: itemTypes.name,
          unitOfMeasure: itemTypes.unitOfMeasure,
          batchCode: batches.code,
          expiryDate: batches.expiryDate,
          lotNo: batches.lotNo,
        })
        .from(cartons)
        .innerJoin(itemTypes, eq(cartons.itemTypeId, itemTypes.id))
        .innerJoin(batches, eq(cartons.batchId, batches.id))
        .where(eq(cartons.code, cartonCode));
      if (!carton) throw new NotFoundError("Carton");
      return { labels: [cartonLabel(carton)], name: carton.code };
    }

    // A pack or roll code (PK...) reprints on its own, like a bottle serial.
    const packCode = parsePackCode(target.serial);
    if (packCode) {
      const [pack] = await conn
        .select({
          code: packs.code,
          piecesPerPack: packs.piecesPerPack,
          itemName: itemTypes.name,
          unitOfMeasure: itemTypes.unitOfMeasure,
          testsPerUnit: itemTypes.testsPerUnit,
          batchCode: batches.code,
          expiryDate: batches.expiryDate,
          lotNo: batches.lotNo,
        })
        .from(packs)
        .innerJoin(itemTypes, eq(packs.itemTypeId, itemTypes.id))
        .innerJoin(batches, eq(packs.batchId, batches.id))
        .where(eq(packs.code, packCode));
      if (!pack) throw new NotFoundError("Pack");
      return { labels: [packLabel(pack)], name: pack.code };
    }

    const serial = parseSerial(target.serial);
    if (!serial) throw new ValidationError("That is not a valid serial");
    const [row] = await conn
      .select({
        serial: units.serial,
        itemName: itemTypes.name,
        containerType: itemTypes.containerType,
        batchCode: batches.code,
        expiryDate: batches.expiryDate,
        lotNo: batches.lotNo,
      })
      .from(units)
      .innerJoin(itemTypes, eq(units.itemTypeId, itemTypes.id))
      .innerJoin(batches, eq(units.batchId, batches.id))
      .where(eq(units.serial, serial));
    if (!row) throw new NotFoundError("Serial");
    return { labels: [{ kind: "serial", ...row }], name: serial };
  }

  // A carton or pack target finds the batch it belongs to, then prints just its own labels and what is under it.
  let cartonFilter: string | null = null;
  let packFilter: string | null = null;
  let targetCode: string | null = null;
  let batchInput: string;
  if ("carton" in target) {
    const cartonCode = parseCartonCode(target.carton);
    if (!cartonCode) throw new ValidationError("That is not a valid carton code");
    const [found] = await conn
      .select({ id: cartons.id, batchCode: batches.code })
      .from(cartons)
      .innerJoin(batches, eq(cartons.batchId, batches.id))
      .where(eq(cartons.code, cartonCode));
    if (!found) throw new NotFoundError("Carton");
    cartonFilter = found.id;
    targetCode = cartonCode;
    batchInput = found.batchCode;
  } else if ("pack" in target) {
    const packCode = parsePackCode(target.pack);
    if (!packCode) throw new ValidationError("That is not a valid pack code");
    const [found] = await conn
      .select({ id: packs.id, batchCode: batches.code })
      .from(packs)
      .innerJoin(batches, eq(packs.batchId, batches.id))
      .where(eq(packs.code, packCode));
    if (!found) throw new NotFoundError("Pack");
    packFilter = found.id;
    targetCode = packCode;
    batchInput = found.batchCode;
  } else {
    batchInput = target.batch;
  }

  const code = normalizeCode(batchInput);
  if (!isValidBatchCode(code)) throw new ValidationError("That is not a valid batch code");

  const [batch] = await conn
    .select({
      id: batches.id,
      code: batches.code,
      quantity: batches.quantity,
      expiryDate: batches.expiryDate,
      lotNo: batches.lotNo,
      itemName: itemTypes.name,
      containerType: itemTypes.containerType,
      trackingMode: itemTypes.trackingMode,
      unitOfMeasure: itemTypes.unitOfMeasure,
      testsPerUnit: itemTypes.testsPerUnit,
    })
    .from(batches)
    .innerJoin(itemTypes, eq(batches.itemTypeId, itemTypes.id))
    .where(eq(batches.code, code));
  if (!batch) throw new NotFoundError("Batch");
  const part = "only" in target && "batch" in target ? (target.only === "batch" ? "head" : target.only ? "children" : undefined) : undefined;

  // How many cartons the batch came in (all of them, even when one carton was asked for), so the batch label can say it.
  const [cartonTotal] = await conn
    .select({ n: sql<number>`count(*)::int` })
    .from(cartons)
    .where(eq(cartons.batchId, batch.id));

  // Was this batch made by a lab conversion? Then the label gives the day it was prepared.
  const [madeBy] = await conn
    .select({ convertedAt: conversions.convertedAt })
    .from(conversionLines)
    .innerJoin(conversions, eq(conversions.id, conversionLines.conversionId))
    .where(and(eq(conversionLines.batchId, batch.id), eq(conversionLines.direction, "OUTPUT")));

  const batchLabel: Label = {
    kind: "batch",
    code: batch.code,
    itemName: batch.itemName,
    quantity: batch.quantity,
    cartonCount: cartonTotal?.n ?? 0,
    // Stock the lab made by a conversion says the day it was prepared (see detailLine).
    preparedOn: madeBy ? madeBy.convertedAt.toISOString().slice(0, 10) : null,
    expiryDate: batch.expiryDate,
    lotNo: batch.lotNo,
  };

  // The cartons of this batch (just the one asked for, when a carton was scanned), and the packs in them.
  const cartonRows = packFilter
    ? []
    : await conn
        .select({ id: cartons.id, code: cartons.code, packsCount: cartons.packsCount, piecesCount: cartons.piecesCount })
        .from(cartons)
        .where(and(eq(cartons.batchId, batch.id), cartonFilter ? eq(cartons.id, cartonFilter) : undefined))
        .orderBy(asc(cartons.code));
  const packRows = await conn
    .select({ id: packs.id, code: packs.code, piecesPerPack: packs.piecesPerPack, cartonId: packs.cartonId })
    .from(packs)
    .where(
      and(
        eq(packs.batchId, batch.id),
        cartonFilter ? eq(packs.cartonId, cartonFilter) : undefined,
        packFilter ? eq(packs.id, packFilter) : undefined,
      ),
    )
    .orderBy(asc(packs.code));

  const cartonEntries = cartonRows.map((c) => ({
    id: c.id,
    label: cartonLabel({
      code: c.code,
      packsCount: c.packsCount,
      piecesCount: c.piecesCount,
      itemName: batch.itemName,
      unitOfMeasure: batch.unitOfMeasure,
      batchCode: batch.code,
      expiryDate: batch.expiryDate,
      lotNo: batch.lotNo,
    }),
  }));
  const packEntries = packRows.map((p) => ({
    id: p.id,
    cartonId: p.cartonId,
    label: packLabel({
      code: p.code,
      piecesPerPack: p.piecesPerPack,
      itemName: batch.itemName,
      unitOfMeasure: batch.unitOfMeasure,
      testsPerUnit: batch.testsPerUnit,
      batchCode: batch.code,
      expiryDate: batch.expiryDate,
      lotNo: batch.lotNo,
    }),
  }));

  // Bottles, tubes and blood bags (SERIAL). Packs and rolls of counted stock have no unit rows.
  const unitEntries: { packId: string | null; cartonId: string | null; label: Label }[] = [];
  if (batch.trackingMode === "SERIAL") {
    const rows = await conn
      .select({ serial: units.serial, packId: units.packId, cartonId: units.cartonId })
      .from(units)
      .where(
        and(
          eq(units.batchId, batch.id),
          cartonFilter ? eq(units.cartonId, cartonFilter) : undefined,
          packFilter ? eq(units.packId, packFilter) : undefined,
          // A bottle that has gone out on a transfer is not printed again with its pack, carton or batch.
          sql`not ${unitWasTransferred}`,
        ),
      )
      .orderBy(asc(units.serial));
    for (const r of rows) {
      unitEntries.push({
        packId: r.packId,
        cartonId: r.cartonId,
        label: {
          kind: "serial",
          serial: r.serial,
          itemName: batch.itemName,
          containerType: batch.containerType,
          batchCode: batch.code,
          expiryDate: batch.expiryDate,
          lotNo: batch.lotNo,
        },
      });
    }
  }

  // Grouped by carton, so each carton's labels come out together and can be stuck on as it is opened. For stock
  // received with no cartons this is the same order as before: the batch label, then the packs or bottles.
  const everything = arrangeByCarton({ cartons: cartonEntries, packs: packEntries, units: unitEntries });
  // Narrow to one level when asked (only the cartons, only the packs, only the bottles).
  const only = "only" in target ? target.only : undefined;
  const level = only ? SCOPE_LEVEL[only] : undefined;
  const children = level ? everything.filter((l) => levelOf(l) === level) : everything;
  if (targetCode) return { labels: children, name: targetCode };
  return { labels: pickLabels(batchLabel, children, part), name: batch.code };
}

/**
 * Records that these pack labels were printed: when, and one more time. Called when a PDF or printer job is produced,
 * never for the on-screen preview. A failure here must not stop the labels coming out, so it is only logged.
 */
async function markPacksPrinted(labels: Label[], conn: DbOrTx = db()): Promise<void> {
  const codes = labels.flatMap((l) => (l.kind === "serial" && l.serial.startsWith(PACK_PREFIX) ? [l.serial] : []));
  if (codes.length === 0) return;
  try {
    await conn
      .update(packs)
      .set({ labelPrintedAt: new Date(), labelPrintCount: sql`${packs.labelPrintCount} + 1` })
      .where(inArray(packs.code, codes));
  } catch (err) {
    console.error("Could not record printed pack labels", err);
  }
}

export async function renderPdf(target: LabelTarget, layout: PdfLayout, pick?: number[], options?: PdfOptions) {
  const set = await loadLabels(target, db(), pick);
  const bytes = await renderLabelsPdf(set.labels, layout, options);
  await markPacksPrinted(set.labels);
  return { bytes, name: set.name };
}

export async function renderZpl(target: LabelTarget, pick?: number[]) {
  const set = await loadLabels(target, db(), pick);
  const zpl = labelsToZpl(set.labels);
  await markPacksPrinted(set.labels);
  return { zpl, name: set.name, count: set.labels.length };
}

export async function renderTspl(target: LabelTarget, pick?: number[]) {
  const set = await loadLabels(target, db(), pick);
  const tspl = labelsToTspl(set.labels);
  await markPacksPrinted(set.labels);
  return { tspl, name: set.name, count: set.labels.length };
}

export async function renderTsplPreview(target: LabelTarget) {
  const set = await loadLabels(target);
  return { html: await renderTsplPreviewHtml(set.labels, set.name), name: set.name };
}

export function isPrinterConfigured(): boolean {
  const e = env();
  return Boolean(e.PRINTER_QUEUE || e.PRINTER_HOST);
}

/**
 * Prints the labels. A USB printer (PRINTER_QUEUE) gets TSPL commands through its local queue; otherwise a network
 * Zebra printer (PRINTER_HOST) gets ZPL. Returns how many labels were sent.
 */
export async function printLabels(target: LabelTarget, pick?: number[]): Promise<number> {
  const queue = env().PRINTER_QUEUE;
  if (queue) {
    const { tspl, count } = await renderTspl(target, pick);
    await sendToQueue(queue, tspl);
    return count;
  }
  const host = env().PRINTER_HOST;
  if (!host) throw new ValidationError("No label printer is set up (PRINTER_QUEUE or PRINTER_HOST). Download the PDF instead.");
  const { zpl, count } = await renderZpl(target, pick);
  await sendToPrinter(host, zpl);
  return count;
}

/** What the batch page shows after stock-in. */
export async function getBatchSummary(codeInput: string) {
  const code = normalizeCode(codeInput);
  if (!isValidBatchCode(code)) return null;
  const [row] = await db()
    .select({
      id: batches.id,
      code: batches.code,
      quantity: batches.quantity,
      lotNo: batches.lotNo,
      expiryDate: batches.expiryDate,
      supplier: batches.supplier,
      createdAt: batches.createdAt,
      itemName: itemTypes.name,
      trackingMode: itemTypes.trackingMode,
      unit: itemTypes.unitOfMeasure,
      packSize: itemTypes.packSize,
      deliveryCode: deliveries.code,
    })
    .from(batches)
    .innerJoin(itemTypes, eq(batches.itemTypeId, itemTypes.id))
    .leftJoin(deliveries, eq(batches.deliveryId, deliveries.id))
    .where(eq(batches.code, code));
  if (!row) return null;

  let sampleSerials: string[] = [];
  let samplePacks: string[] = [];
  let packCount = 0;
  let storeName: string | null = null;
  if (row.trackingMode === "SERIAL") {
    const rows = await db()
      .select({ serial: units.serial, location: locations.name })
      .from(units)
      .innerJoin(locations, eq(units.currentLocationId, locations.id))
      .where(eq(units.batchId, row.id))
      .orderBy(asc(units.serial))
      .limit(12);
    sampleSerials = rows.map((r) => r.serial);
    storeName = rows[0]?.location ?? null;
  } else {
    // Packs, rolls and other quantity stock have no unit rows, so the store is where the batch was stocked in.
    const [stocked] = await db()
      .select({ location: locations.name })
      .from(events)
      .innerJoin(locations, eq(events.locationId, locations.id))
      .where(and(eq(events.batchId, row.id), eq(events.type, "STOCKED")))
      .orderBy(asc(events.recordedAt))
      .limit(1);
    storeName = stocked?.location ?? null;
  }

  // Pack and roll codes (PK...) and carton codes (CN...), if this batch has them. Stock received before pack labels or
  // cartons existed has none, and so does stock received by the piece. Bottles that came in packs have them too.
  const packRows = await db()
    .select({ code: packs.code })
    .from(packs)
    .where(eq(packs.batchId, row.id))
    .orderBy(asc(packs.code))
    .limit(12);
  samplePacks = packRows.map((p) => p.code);
  const [countedPacks] = await db()
    .select({ n: sql<number>`count(*)::int` })
    .from(packs)
    .where(eq(packs.batchId, row.id));
  packCount = countedPacks?.n ?? 0;

  const cartonRows = await db()
    .select({ code: cartons.code, packsCount: cartons.packsCount, piecesCount: cartons.piecesCount })
    .from(cartons)
    .where(eq(cartons.batchId, row.id))
    .orderBy(asc(cartons.code))
    .limit(12);
  const sampleCartons = cartonRows.map((c) => c.code);
  const [countedCartons] = await db()
    .select({ n: sql<number>`count(*)::int` })
    .from(cartons)
    .where(eq(cartons.batchId, row.id));
  const cartonCount = countedCartons?.n ?? 0;
  // Every carton of one batch holds the same, so the first one says what each carton holds.
  const cartonContents = cartonRows[0] ? { packs: cartonRows[0].packsCount, pieces: cartonRows[0].piecesCount } : null;
  return { ...row, sampleSerials, samplePacks, packCount, sampleCartons, cartonCount, cartonContents, storeName };
}

export async function listRecentBatches(limit = 10) {
  return db()
    .select({
      code: batches.code,
      quantity: batches.quantity,
      createdAt: batches.createdAt,
      itemName: itemTypes.name,
      trackingMode: itemTypes.trackingMode,
      unit: itemTypes.unitOfMeasure,
    })
    .from(batches)
    .innerJoin(itemTypes, eq(batches.itemTypeId, itemTypes.id))
    .orderBy(desc(batches.createdAt))
    .limit(limit);
}
