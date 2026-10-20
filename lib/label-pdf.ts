// PDF labels for office printers (the fallback when no Zebra printer is available).
// "label" layout: one 53 x 27 mm page per label, for label printers with a normal driver.
// "a4" layout: a grid of the same labels on A4 sheets, for plain paper and test prints.

import { PDFDocument, StandardFonts, degrees, rgb, type PDFFont, type PDFPage } from "pdf-lib";
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

// Set to true for a TALL page (27 x 59 mm) with the artwork turned 90 degrees. Chrome swaps the paper size to
// 4 x 6 in for that, so it is off. The default is the landscape 59 x 27 mm page that printed correctly from WPS.
const PORTRAIT_PAGE = false;

// Only used when PORTRAIT_PAGE is true: switch between "ccw" and "cw" if it prints upside down.
const TURN: "ccw" | "cw" = "ccw";

const A4_W = 210 * MM;
const A4_H = 297 * MM;
const A4_MARGIN = 10 * MM;
const GAP = 2 * MM;

export type PdfLayout = "label" | "a4";

interface Fonts {
  regular: PDFFont;
  bold: PDFFont;
}

async function drawLabel(
  pdf: PDFDocument,
  page: PDFPage,
  fonts: Fonts,
  label: Label,
  x: number,
  y: number,
  outline: boolean,
  rotated = false,
) {
  // The artwork is laid out as a 59 x 27 mm landscape label. When rotated, every point is mapped onto the tall page.
  const pt = (u: number, v: number) => {
    if (!rotated) return { x: u, y: v };
    return TURN === "ccw" ? { x: LABEL_H - v, y: u } : { x: v, y: PAGE_W - u };
  };
  const turn = rotated ? { rotate: degrees(TURN === "ccw" ? 90 : -90) } : {};
  const left = PAD_X + X_SHIFT * MM;
  const inner = LABEL_W - 2 * PAD_X;
  const text = barcodeText(label);

  if (outline) {
    const w = rotated ? LABEL_H : LABEL_W;
    const h = rotated ? PAGE_W : LABEL_H;
    page.drawRectangle({ x, y, width: w, height: h, borderColor: rgb(0.75, 0.75, 0.75), borderWidth: 0.5 });
  }

  page.drawText(truncate(label.itemName, 34), {
    ...pt(x + left, y + LABEL_H - PAD_Y - 6),
    ...turn,
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
    ...pt(x + left + (inner - barcodeW) / 2, y + LABEL_H - PAD_Y - 6 - 3 - BARCODE_H),
    ...turn,
    width: barcodeW,
    height: BARCODE_H,
  });

  page.drawText(text, { ...pt(x + left, y + PAD_Y + 9), ...turn, size: 10, font: fonts.bold });
  const details = detailLine(label);
  if (details) {
    page.drawText(truncate(details, 40), { ...pt(x + left, y + PAD_Y), ...turn, size: 6, font: fonts.regular });
  }
}

export async function renderLabelsPdf(labels: Label[], layout: PdfLayout = "label"): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const fonts: Fonts = {
    regular: await pdf.embedFont(StandardFonts.Helvetica),
    bold: await pdf.embedFont(StandardFonts.HelveticaBold),
  };

  if (layout === "label") {
    for (const label of labels) {
      const page = pdf.addPage(PORTRAIT_PAGE ? [LABEL_H, PAGE_W] : [PAGE_W, LABEL_H]);
      await drawLabel(pdf, page, fonts, label, 0, 0, DEBUG_OUTLINE, PORTRAIT_PAGE);
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

  if (pdf.getPageCount() === 0) pdf.addPage(PORTRAIT_PAGE ? [LABEL_H, PAGE_W] : [PAGE_W, LABEL_H]);
  return pdf.save();
}