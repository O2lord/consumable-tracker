import "server-only";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { db } from "../db/client";
import type { DbOrTx } from "../audit/events";
import { batches, deliveries, events, itemTypes, locations, packs, units } from "../db/schema";
import { NotFoundError, ValidationError } from "../domain/errors";
import { env } from "../env";
import { isValidBatchCode, normalizeCode, parseDeliveryCode, parsePackCode, parseSerial } from "../../lib/serial";
import { labelsToZpl } from "../../lib/zpl";
import { renderLabelsPdf, type PdfLayout } from "../../lib/label-pdf";
import { sendToPrinter } from "../../lib/printer";
import type { Label } from "../../lib/label-types";

// Composes label content from the database and renders it as PDF or ZPL, or sends it to the printer.
// The caller checks the permission.

/** Which part of a delivery to print: its own DV label, or just the batch labels of its items. */
export type DeliveryLabelScope = "delivery" | "batches";
/** Which part of a batch to print: its own batch (or box) label, or just the pack, roll or bottle labels under it. */
export type BatchLabelScope = "batch" | "items";

/** Leave `only` out to get the label and everything under it together. */
export type LabelTarget =
  | { batch: string; only?: BatchLabelScope }
  | { serial: string }
  | { delivery: string; only?: DeliveryLabelScope };

/** A pack or roll label. It reuses the serial label layout: the barcode is the pack code (PK...). */
function packLabel(p: {
  code: string;
  piecesPerPack: number;
  itemName: string;
  unitOfMeasure: string;
  batchCode: string;
  expiryDate: string | null;
  lotNo: string | null;
}): Label {
  const unit = /^rolls?$/i.test(p.unitOfMeasure.trim()) ? "Roll" : "Pack";
  return {
    kind: "serial",
    serial: p.code,
    itemName: p.itemName,
    containerType: p.piecesPerPack > 1 ? `${unit} of ${p.piecesPerPack}` : unit,
    batchCode: p.batchCode,
    expiryDate: p.expiryDate,
    lotNo: p.lotNo,
  };
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
export async function loadLabels(target: LabelTarget, conn: DbOrTx = db()): Promise<LabelSet> {
  const set = await composeLabels(target, conn);
  if (set.labels.length === 0) throw new ValidationError("There are no labels of that kind to print");
  return set;
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
      expiryDate: l.expiryDate,
      lotNo: l.lotNo,
    }));
    const part = target.only === "delivery" ? "head" : target.only === "batches" ? "children" : undefined;
    return { labels: pickLabels(deliveryLabel, batchLabels, part), name: deliveryCode };
  }

  if ("serial" in target) {
    // A pack or roll code (PK...) reprints on its own, like a bottle serial.
    const packCode = parsePackCode(target.serial);
    if (packCode) {
      const [pack] = await conn
        .select({
          code: packs.code,
          piecesPerPack: packs.piecesPerPack,
          itemName: itemTypes.name,
          unitOfMeasure: itemTypes.unitOfMeasure,
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

  const code = normalizeCode(target.batch);
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
    })
    .from(batches)
    .innerJoin(itemTypes, eq(batches.itemTypeId, itemTypes.id))
    .where(eq(batches.code, code));
  if (!batch) throw new NotFoundError("Batch");
  const part = target.only === "batch" ? "head" : target.only === "items" ? "children" : undefined;

  if (batch.trackingMode === "QUANTITY") {
    const packRows = await conn
      .select({ code: packs.code, piecesPerPack: packs.piecesPerPack })
      .from(packs)
      .where(eq(packs.batchId, batch.id))
      .orderBy(asc(packs.code));
    // The batch label comes first, then one label per pack or roll (none for stock received before pack labels).
    const batchLabel: Label = {
      kind: "batch",
      code: batch.code,
      itemName: batch.itemName,
      quantity: batch.quantity,
      expiryDate: batch.expiryDate,
      lotNo: batch.lotNo,
    };
    const packLabels = packRows.map((p) =>
      packLabel({
        code: p.code,
        piecesPerPack: p.piecesPerPack,
        itemName: batch.itemName,
        unitOfMeasure: batch.unitOfMeasure,
        batchCode: batch.code,
        expiryDate: batch.expiryDate,
        lotNo: batch.lotNo,
      }),
    );
    return { labels: pickLabels(batchLabel, packLabels, part), name: batch.code };
  }

  const rows = await conn.select({ serial: units.serial }).from(units).where(eq(units.batchId, batch.id)).orderBy(asc(units.serial));
  // The box label comes first when everything prints together. It can also print on its own: stick it on the box,
  // then scan it at dispatch before scanning the bottles that go out.
  const boxLabel: Label = {
    kind: "batch",
    code: batch.code,
    itemName: batch.itemName,
    quantity: batch.quantity,
    expiryDate: batch.expiryDate,
    lotNo: batch.lotNo,
  };
  const bottleLabels: Label[] = rows.map((r) => ({
    kind: "serial" as const,
    serial: r.serial,
    itemName: batch.itemName,
    containerType: batch.containerType,
    batchCode: batch.code,
    expiryDate: batch.expiryDate,
    lotNo: batch.lotNo,
  }));
  return { labels: pickLabels(boxLabel, bottleLabels, part), name: batch.code };
}

export async function renderPdf(target: LabelTarget, layout: PdfLayout) {
  const set = await loadLabels(target);
  return { bytes: await renderLabelsPdf(set.labels, layout), name: set.name };
}

export async function renderZpl(target: LabelTarget) {
  const set = await loadLabels(target);
  return { zpl: labelsToZpl(set.labels), name: set.name, count: set.labels.length };
}

export function isPrinterConfigured(): boolean {
  return Boolean(env().PRINTER_HOST);
}

/** Sends the labels to the configured Zebra printer. Returns how many labels were sent. */
export async function printLabels(target: LabelTarget): Promise<number> {
  const host = env().PRINTER_HOST;
  if (!host) throw new ValidationError("No label printer is set up (PRINTER_HOST). Download the PDF instead.");
  const { zpl, count } = await renderZpl(target);
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

    // Pack and roll codes (PK...), if this batch has them. Stock received before pack labels has none.
    const packRows = await db()
      .select({ code: packs.code })
      .from(packs)
      .where(eq(packs.batchId, row.id))
      .orderBy(asc(packs.code))
      .limit(12);
    samplePacks = packRows.map((p) => p.code);
    const [counted] = await db()
      .select({ n: sql<number>`count(*)::int` })
      .from(packs)
      .where(eq(packs.batchId, row.id));
    packCount = counted?.n ?? 0;
  }
  return { ...row, sampleSerials, samplePacks, packCount, storeName };
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
