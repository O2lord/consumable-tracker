// PDF labels for office printers (the fallback when no Zebra printer is available).
// "label" layout: one 59 x 27 mm page per label, for label printers with a normal driver.
// "a4" layout: a grid of the same labels on A4 sheets, for plain paper and test prints.

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

// Label size: measure the real label width with a ruler and put it here (the printer self-test
// only reports a stored width). Height 27 mm and 3 mm gap come from the self-test.
// Measured label: 50 mm wide. The page is the driver's paper size ("Consumable Tracker", 59 x 27 mm), so
// Chrome's "Fit to paper" prints it at exactly 100% instead of enlarging it.
const LABEL_W = 50 * MM;
const LABEL_H = 27 * MM;
const PAGE_W = 59 * MM;

// Padding inside the label, equal on the left and right.
const PAD_X = 4 * MM;
const PAD_Y = 2.5 * MM;

// Height of the barcode bars.
const BARCODE_H = 11 * MM;

// Nudge everything sideways, in mm, to correct for the printer's offset.
// Negative moves left, positive moves right. Adjust after a test print.
const X_SHIFT = -2.5;

// TEMPORARY: draw a thin grey border at the exact edges of the label page in "label" layout.
// Set back to false once calibration is done.
const DEBUG_OUTLINE = false;

// How the label is turned. The page is ALWAYS 59 x 27 mm landscape. Only the artwork on it is turned.
// Change TURN to play around:
//   "none"    : normal.
//   "flip"    : artwork turned 180 degrees (upside down).
//   "cw"      : artwork turned 90 degrees clockwise (left side goes UP), shrunk to fit inside the 27 mm height.
//   "ccw"     : artwork turned 90 degrees counterclockwise (left side goes DOWN), shrunk to fit inside the 27 mm height.
//   "mirrorV" : TEST ONLY. Mirrored top to bottom. Text and barcode are mirrored.
//   "mirrorH" : TEST ONLY. Mirrored left to right. Text and barcode are mirrored.
// "cw" and "ccw" shrink the artwork to about 46% (27 / 59), because turned on its side it is taller than the page.
type Turn = "none" | "flip" | "cw" | "ccw" | "mirrorV" | "mirrorH";
const TURN = "cw" as Turn;

// Where the writing starts. false: text starts at the left edge and runs right. true: text starts at the right edge
// and runs back toward the left (right-aligned). The letters themselves are NOT mirrored, so it stays readable.
const ALIGN_RIGHT = false;

const PAGE_SIZE: [number, number] = [PAGE_W, LABEL_H];

const A4_W = 210 * MM;
const A4_H = 297 * MM;
const A4_MARGIN = 10 * MM;
const GAP = 2 * MM;

export type PdfLayout = "label" | "a4";

interface Fonts {
  regular: PDFFont;
  bold: PDFFont;
}

// Transformation matrix [a, b, c, d, e, f] that maps the 59 x 27 mm landscape artwork onto the same-sized page.
function turnMatrix(turnMode: Turn): [number, number, number, number, number, number] | null {
  switch (turnMode) {
    case "flip":
      return [-1, 0, 0, -1, PAGE_W, LABEL_H];
    case "mirrorV":
      return [1, 0, 0, -1, 0, LABEL_H];
    case "mirrorH":
      return [-1, 0, 0, 1, PAGE_W, 0];
    case "cw":
    case "ccw": {
      // Turn 90 degrees about the page centre, then shrink so the turned artwork (27 wide x 59 tall) fits in 27 tall.
      const s = LABEL_H / PAGE_W;
      const sin = turnMode === "cw" ? -1 : 1;
      const a = 0;
      const b = s * sin;
      const c = -s * sin;
      const d = 0;
      const cx = PAGE_W / 2;
      const cy = LABEL_H / 2;
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
  outline: boolean,
  turnMode: Turn = "none",
) {
  // The artwork is always laid out as a 59 x 27 mm landscape label. Turning is done by one matrix around everything.
  const matrix = turnMatrix(turnMode);
  if (matrix) page.pushOperators(pushGraphicsState(), concatTransformationMatrix(...matrix));

  const left = PAD_X + X_SHIFT * MM;
  const inner = LABEL_W - 2 * PAD_X;
  const text = barcodeText(label);
  // Where a line of text begins along the label's length: at the left padding, or pushed to the right padding.
  const startU = (str: string, size: number, font: PDFFont) =>
    ALIGN_RIGHT ? x + left + inner - font.widthOfTextAtSize(str, size) : x + left;

  if (outline) {
    page.drawRectangle({
      x,
      y,
      width: LABEL_W,
      height: LABEL_H,
      borderColor: rgb(0.75, 0.75, 0.75),
      borderWidth: 0.5,
    });
  }

  const itemName = truncate(label.itemName, 34);
  page.drawText(itemName, {
    x: startU(itemName, 6.5, fonts.regular),
    y: y + LABEL_H - PAD_Y - 6,
    size: 6.5,
    font: fonts.regular,
  });

  const image = await pdf.embedPng(await code128Png(text));
  // Width is set by the label; the height is fixed, so the bars always reach down close to the code text.
  // Stretching a 1D barcode vertically is safe: only the bar widths matter to a scanner.
  const scale = Math.min(inner / image.width, BARCODE_H / image.height);
  const barcodeW = image.width * scale;
  page.drawImage(image, {
    // Centre the barcode inside the padded area so the left and right gaps match.
    x: x + left + (inner - barcodeW) / 2,
    y: y + LABEL_H - PAD_Y - 6 - 3 - BARCODE_H,
    width: barcodeW,
    height: BARCODE_H,
  });

  page.drawText(text, { x: startU(text, 10, fonts.bold), y: y + PAD_Y + 9, size: 10, font: fonts.bold });
  const details = detailLine(label);
  if (details) {
    const detailText = truncate(details, 40);
    page.drawText(detailText, {
      x: startU(detailText, 6, fonts.regular),
      y: y + PAD_Y,
      size: 6,
      font: fonts.regular,
    });
  }

  if (matrix) page.pushOperators(popGraphicsState());
}

export async function renderLabelsPdf(labels: Label[], layout: PdfLayout = "label"): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const fonts: Fonts = {
    regular: await pdf.embedFont(StandardFonts.Helvetica),
    bold: await pdf.embedFont(StandardFonts.HelveticaBold),
  };

  if (layout === "label") {
    for (const label of labels) {
      const page = pdf.addPage(PAGE_SIZE);
      await drawLabel(pdf, page, fonts, label, 0, 0, DEBUG_OUTLINE, TURN);
    }
  } else {
    const cols = Math.floor((A4_W - 2 * A4_MARGIN + GAP) / (LABEL_W + GAP));
    const rows = Math.floor((A4_H - 2 * A4_MARGIN + GAP) / (LABEL_H + GAP));
    const perPage = cols * rows;
    let page: PDFPage | null = null;
    for (let i = 0; i < labels.length; i++) {
      const slot = i % perPage;
      if (slot === 0) page = pdf.addPage([A4_W, A4_H]);
      const col = slot % cols;
      const row = Math.floor(slot / cols);
      const x = A4_MARGIN + col * (LABEL_W + GAP);
      const y = A4_H - A4_MARGIN - (row + 1) * LABEL_H - row * GAP;
      await drawLabel(pdf, page!, fonts, labels[i], x, y, true);
    }
  }

  if (pdf.getPageCount() === 0) pdf.addPage(PAGE_SIZE);
  return pdf.save();
}
