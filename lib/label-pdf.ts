// PDF labels for office printers (the fallback when no Zebra printer is available).
// "label" layout: one page per label, for label printers with a normal driver. The page is the size of the label.
// "a4" layout: a grid of the same labels on A4 sheets, for plain paper and test prints.
//
// Everything about the shape of the label can be changed per request (see PdfOptions and the query string of
// /api/labels), so a new printer or driver can be tuned with test prints and no code change:
//   &w=50 &h=22   label width and height in mm (the height is the label pitch the driver feeds)
//   &pw=50        page width in mm, when the driver's paper is wider than the label
//   &turn=none|cw|ccw|flip
//   &portrait=cw|ccw  make the PAGE tall and narrow (label height x label width) with the artwork turned inside it. Chrome
//                     picks the printer's orientation from the page shape and a wide page makes it send "landscape"
//                     (macOS then turns the print 90 degrees); a tall page makes it send "portrait".
//   &shift=0      nudge sideways in mm (negative = left)
//   &outline=1    draw a thin border at the label's edges, for calibration

import {
  PDFDocument,
  StandardFonts,
  concatTransformationMatrix,
  popGraphicsState,
  pushGraphicsState,
  rgb,
  type PDFFont,
  type PDFPage,
} from "pdf-lib";
import { code128Png } from "./barcode.ts";
import { barcodeText, detailLine, truncate, type Label } from "./label-types.ts";

const MM = 72 / 25.4;

// How the label is turned. The page keeps its size. Only the artwork on it is turned.
//   "none"    : normal.
//   "flip"    : artwork turned 180 degrees (upside down).
//   "cw"      : artwork turned 90 degrees clockwise (left side goes UP), shrunk to fit inside the page height.
//   "ccw"     : artwork turned 90 degrees counterclockwise (left side goes DOWN), shrunk to fit inside the page height.
//   "mirrorV" : TEST ONLY. Mirrored top to bottom. Text and barcode are mirrored.
//   "mirrorH" : TEST ONLY. Mirrored left to right. Text and barcode are mirrored.
// "cw" and "ccw" shrink the artwork, because turned on its side it is taller than the page. Use them only when the
// printer driver itself turns the page.
export type Turn = "none" | "flip" | "cw" | "ccw" | "mirrorV" | "mirrorH";
export const TURNS: readonly Turn[] = ["none", "flip", "cw", "ccw", "mirrorV", "mirrorH"];

export interface PdfOptions {
  /** Label width in mm. */
  labelW?: number;
  /** Label height in mm: the distance from one label to the next as the driver feeds it. */
  labelH?: number;
  /** Page width in mm. Defaults to the label width. */
  pageW?: number;
  turn?: Turn;
  /** Nudge everything sideways, in mm. Negative moves left, positive moves right. */
  shiftX?: number;
  /**
   * Makes the page tall and narrow (label height wide, label width tall) with the upright artwork turned inside it, so
   * Chrome asks the printer for portrait. "cw": the label's left edge goes up. "ccw": it goes down. Overrides turn and
   * page width.
   */
  portrait?: "cw" | "ccw";
  /** Draw a thin grey border at the exact edges of the label, for calibration. */
  outline?: boolean;
}

// Defaults: the label in use is 50 mm wide and 22 mm tall (a 25 mm pitch with a 3 mm gap), the same as the printer
// commands in lib/tspl.ts, drawn upright.
export const DEFAULT_PDF_OPTIONS = {
  labelW: 50,
  labelH: 22,
  turn: "none" as Turn,
  shiftX: 0,
  outline: false,
};

// Padding inside the label, equal on the left and right.
const PAD_X = 4 * MM;
const PAD_Y = 2.5 * MM;

// Height of the barcode bars when there is room (shorter labels get a shorter barcode, never overlapping the text).
const BARCODE_MAX_H = 11 * MM;

const A4_W = 210 * MM;
const A4_H = 297 * MM;
const A4_MARGIN = 10 * MM;
const GAP = 2 * MM;

export type PdfLayout = "label" | "a4";

interface Fonts {
  regular: PDFFont;
  bold: PDFFont;
}

interface Geometry {
  labelW: number;
  labelH: number;
  pageW: number;
  turn: Turn;
  portrait: "cw" | "ccw" | null;
  shiftX: number;
  outline: boolean;
}

function mmInRange(value: number, fallback: number, min: number, max: number): number {
  return Number.isFinite(value) && value >= min && value <= max ? value : fallback;
}

function geometryOf(options: PdfOptions = {}): Geometry {
  const labelW = mmInRange(options.labelW ?? NaN, DEFAULT_PDF_OPTIONS.labelW, 10, 200);
  const labelH = mmInRange(options.labelH ?? NaN, DEFAULT_PDF_OPTIONS.labelH, 10, 200);
  const pageW = mmInRange(options.pageW ?? NaN, labelW, 10, 300);
  const turn = options.turn && TURNS.includes(options.turn) ? options.turn : DEFAULT_PDF_OPTIONS.turn;
  return {
    labelW: labelW * MM,
    labelH: labelH * MM,
    pageW: pageW * MM,
    turn,
    portrait: options.portrait === "cw" || options.portrait === "ccw" ? options.portrait : null,
    shiftX: mmInRange(options.shiftX ?? NaN, DEFAULT_PDF_OPTIONS.shiftX, -30, 30) * MM,
    outline: options.outline ?? DEFAULT_PDF_OPTIONS.outline,
  };
}

// Transformation matrix [a, b, c, d, e, f] that maps the landscape artwork onto the same-sized page.
function turnMatrix(g: Geometry): [number, number, number, number, number, number] | null {
  // Portrait page: the page is labelH wide and labelW tall, and the upright artwork (labelW x labelH) is turned 90
  // degrees to fill it exactly, with no shrinking.
  if (g.portrait === "cw") return [0, -1, 1, 0, 0, g.labelW];
  if (g.portrait === "ccw") return [0, 1, -1, 0, g.labelH, 0];
  switch (g.turn) {
    case "flip":
      return [-1, 0, 0, -1, g.pageW, g.labelH];
    case "mirrorV":
      return [1, 0, 0, -1, 0, g.labelH];
    case "mirrorH":
      return [-1, 0, 0, 1, g.pageW, 0];
    case "cw":
    case "ccw": {
      // Turn 90 degrees about the page centre, then shrink so the turned artwork (page height wide, page width
      // tall) fits in the page height.
      const s = g.labelH / g.pageW;
      const sin = g.turn === "cw" ? -1 : 1;
      const a = 0;
      const b = s * sin;
      const c = -s * sin;
      const d = 0;
      const cx = g.pageW / 2;
      const cy = g.labelH / 2;
      return [a, b, c, d, cx - (a * cx + c * cy), cy - (b * cx + d * cy)];
    }
    default:
      return null;
  }
}

async function drawLabel(
  pdf: PDFDocument,
  page: PDFPage,
  fonts: Fonts,
  label: Label,
  x: number,
  y: number,
  g: Geometry,
  outline: boolean,
  turnIt: boolean,
) {
  // The artwork is always laid out upright. Turning is done by one matrix around everything.
  const matrix = turnIt ? turnMatrix(g) : null;
  if (matrix) page.pushOperators(pushGraphicsState(), concatTransformationMatrix(...matrix));

  const left = PAD_X + g.shiftX;
  const inner = g.labelW - 2 * PAD_X;
  const text = barcodeText(label);

  if (outline) {
    page.drawRectangle({
      x,
      y,
      width: g.labelW,
      height: g.labelH,
      borderColor: rgb(0.6, 0.6, 0.6),
      borderWidth: 0.5,
    });
  }

  const itemName = truncate(label.itemName, 34);
  page.drawText(itemName, { x: x + left, y: y + g.labelH - PAD_Y - 6, size: 6.5, font: fonts.regular });

  const image = await pdf.embedPng(await code128Png(text));
  // The bars run from just under the item name down to just above the code text, so they never overlap either.
  const barsTop = y + g.labelH - PAD_Y - 6 - 3;
  const barsBottom = y + PAD_Y + 9 + 7.2 + 2;
  const barcodeH = Math.max(8, Math.min(BARCODE_MAX_H, barsTop - barsBottom));
  // Width is set by the label; the height is fixed, so the bars always reach down close to the code text.
  // Stretching a 1D barcode vertically is safe: only the bar widths matter to a scanner.
  const scale = Math.min(inner / image.width, barcodeH / image.height);
  const barcodeW = image.width * scale;
  page.drawImage(image, {
    // Centre the barcode inside the padded area so the left and right gaps match.
    x: x + left + (inner - barcodeW) / 2,
    y: barsTop - barcodeH,
    width: barcodeW,
    height: barcodeH,
  });

  page.drawText(text, { x: x + left, y: y + PAD_Y + 9, size: 10, font: fonts.bold });
  const details = detailLine(label);
  if (details) {
    page.drawText(truncate(details, 40), { x: x + left, y: y + PAD_Y, size: 6, font: fonts.regular });
  }

  if (matrix) page.pushOperators(popGraphicsState());
}

export async function renderLabelsPdf(
  labels: Label[],
  layout: PdfLayout = "label",
  options: PdfOptions = {},
): Promise<Uint8Array> {
  const g = geometryOf(options);
  const pdf = await PDFDocument.create();
  const fonts: Fonts = {
    regular: await pdf.embedFont(StandardFonts.Helvetica),
    bold: await pdf.embedFont(StandardFonts.HelveticaBold),
  };
  const pageSize: [number, number] = g.portrait ? [g.labelH, g.labelW] : [g.pageW, g.labelH];

  if (layout === "label") {
    for (const label of labels) {
      const page = pdf.addPage(pageSize);
      await drawLabel(pdf, page, fonts, label, 0, 0, g, g.outline, true);
    }
  } else {
    const cols = Math.floor((A4_W - 2 * A4_MARGIN + GAP) / (g.labelW + GAP));
    const rows = Math.floor((A4_H - 2 * A4_MARGIN + GAP) / (g.labelH + GAP));
    const perPage = Math.max(1, cols * rows);
    let page: PDFPage | null = null;
    for (let i = 0; i < labels.length; i++) {
      const slot = i % perPage;
      if (slot === 0) page = pdf.addPage([A4_W, A4_H]);
      const col = slot % cols;
      const row = Math.floor(slot / cols);
      const x = A4_MARGIN + col * (g.labelW + GAP);
      const y = A4_H - A4_MARGIN - (row + 1) * g.labelH - row * GAP;
      await drawLabel(pdf, page!, fonts, labels[i], x, y, g, true, false);
    }
  }

  if (pdf.getPageCount() === 0) pdf.addPage(pageSize);
  return pdf.save();
}
