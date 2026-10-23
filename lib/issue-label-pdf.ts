// Issue label: stuck on the bottle (or its bag) when it is handed out. It shows the patient's hospital
// number, every investigation the bottle serves, the date and who collected it, plus the bottle's
// own serial as a Code 128 barcode so it can be scanned back in on return (architecture 7.4 step 4).

import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { code128Png } from "./barcode.ts";

const MM = 72 / 25.4;
const PAGE_W = 75 * MM;
// The label is as tall as its content. Content is laid out on a tall scratch page, then the page is cut down to fit.
const SCRATCH_H = 150 * MM;
const MARGIN = 3 * MM;
// Less space above the first line than at the sides: the printer feeds the label a little low, so the bottom of the
// label (the barcode and its serial) was being cut off. A negative top margin starts the text just above the page edge
// (only the empty space above the capital letters is lost), which moves the whole artwork up.
const TOP_MARGIN = -0.8 * MM;
// Everything on the label (text, gaps, barcode) is drawn at this fraction of its full size. Lower it to shrink the
// artwork, raise it to 1 for the full size.
const SCALE = 0.9;
const MAX_REFERENCES = 5;

export interface IssueLabelData {
  serial: string;
  patientHospitalNo: string | null;
  references: { type: string; ref: string; testCode: string | null }[];
  issuedAt: Date;
  collectorType: string | null;
  collectorName: string | null;
  locationName: string;
}

/** Helvetica in pdf-lib only draws Latin-1; anything else would throw, so swap it for "?". */
function safe(text: string): string {
  return text.replace(/[^\x20-\x7e\u00a0-\u00ff]/g, "?");
}

export async function renderIssueLabelPdf(label: IssueLabelData): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const page = pdf.addPage([PAGE_W, SCRATCH_H]);
  const inner = PAGE_W - 2 * MARGIN;

  let y = SCRATCH_H - TOP_MARGIN;
  const line = (text: string, size: number, font = regular, gap = 1.5) => {
    const s = size * SCALE;
    y -= s;
    page.drawText(safe(text), { x: MARGIN, y, size: s, font, maxWidth: inner });
    y -= gap * SCALE;
  };

  line(label.patientHospitalNo ?? label.locationName, 11, bold, 2);

  const shown = label.references.slice(0, MAX_REFERENCES);
  for (const r of shown) line(r.testCode ? `${r.ref}  ${r.testCode}` : r.ref, 8, regular, 1);
  if (label.references.length > shown.length) {
    line(`+ ${label.references.length - shown.length} more`, 7, regular, 1);
  }

  const collector = [label.collectorType, label.collectorName].filter(Boolean).join(": ");
  y -= 2 * SCALE;
  line(`${label.issuedAt.toLocaleDateString("en-GB")}${collector ? `  ${collector}` : ""}`, 7, regular, 2);

  const image = await pdf.embedPng(await code128Png(label.serial, { height: 10 }));
  const height = Math.min(9 * MM * SCALE, image.height * (inner / image.width));
  const width = image.width * (height / image.height);
  // The barcode sits just under the details and the serial under it, so the label takes only the space it fills.
  const barcodeGap = 1 * SCALE; // the date line above already leaves a gap below it
  const barcodeY = y - barcodeGap - height;
  const serialY = barcodeY - 8 * SCALE;
  page.drawImage(image, { x: MARGIN, y: barcodeY, width: Math.min(width, inner), height });
  page.drawText(safe(label.serial), { x: MARGIN, y: serialY, size: 8 * SCALE, font: bold, color: rgb(0, 0, 0) });

  // Cut the page down: move everything down so the serial sits one margin above the bottom edge, then shorten.
  const unused = serialY - MARGIN;
  page.translateContent(0, -unused);
  page.setSize(PAGE_W, SCRATCH_H - unused);

  return pdf.save();
}
