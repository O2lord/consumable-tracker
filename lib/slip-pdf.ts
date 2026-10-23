// Transfer slip: one A5 page that travels with the stock. Its Code 128 barcode is the transfer code
// the receiver scans to open the receipt (architecture 7.2 step 4).
//
// The slip shows the TOTAL expected, never a per-batch quantity, so counts of bulk items stay blind
// at the destination (architecture 7.3).

import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { code128Png } from "./barcode.ts";

const MM = 72 / 25.4;
const PAGE_W = 148 * MM;
const PAGE_H = 210 * MM;
const MARGIN = 12 * MM;

export interface SlipData {
  code: string;
  fromName: string;
  toName: string;
  dispatchedAt: Date | null;
  dispatchedByName: string | null;
  /** Who is carrying the stock, typed at dispatch. Null on transfers from before it was recorded. */
  carriedByName?: string | null;
  /** Serialized units: each is scanned one by one on arrival. */
  serialCount: number;
  /** Bulk items in total: counted on arrival. Lines counted in loose pieces are in `pieceTotal`. */
  quantityTotal: number;
  /** Loose pieces in total, counted on arrival. Kept apart because pieces and whole units cannot be added. */
  pieceTotal?: number;
  note: string | null;
  /**
   * Lettered parts of each batch on this transfer, for example BT7K2M9QXR4 part B. Names only, never a
   * quantity, so bulk counts stay blind at the destination.
   */
  parts?: { batchCode: string; letter: string }[];
}

/** Helvetica in pdf-lib only draws Latin-1; anything else would throw, so swap it for "?". */
function safe(text: string): string {
  return text.replace(/[^\x20-\x7e\u00a0-\u00ff]/g, "?");
}

function when(date: Date | null): string {
  return date ? date.toLocaleString("en-GB") : "not yet dispatched";
}

export async function renderSlipPdf(slip: SlipData): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const page = pdf.addPage([PAGE_W, PAGE_H]);
  const inner = PAGE_W - 2 * MARGIN;

  let y = PAGE_H - MARGIN;
  const line = (text: string, size: number, font = regular, gap = 4) => {
    y -= size;
    page.drawText(safe(text), { x: MARGIN, y, size, font, maxWidth: inner });
    y -= gap;
  };

  line("TRANSFER SLIP", 18, bold, 8);

  const image = await pdf.embedPng(await code128Png(slip.code, { height: 14 }));
  const scale = Math.min(inner / image.width, (22 * MM) / image.height);
  const h = image.height * scale;
  y -= h;
  page.drawImage(image, { x: MARGIN, y, width: image.width * scale, height: h });
  y -= 6;
  line(slip.code, 16, bold, 12);

  page.drawLine({
    start: { x: MARGIN, y },
    end: { x: PAGE_W - MARGIN, y },
    thickness: 0.5,
    color: rgb(0.6, 0.6, 0.6),
  });
  y -= 10;

  line("From", 8, regular, 1);
  line(slip.fromName, 13, bold, 8);
  line("To", 8, regular, 1);
  line(slip.toName, 13, bold, 8);
  line("Dispatched", 8, regular, 1);
  line(`${when(slip.dispatchedAt)}${slip.dispatchedByName ? `, by ${slip.dispatchedByName}` : ""}`, 11, regular, 8);
  line("Carried by", 8, regular, 1);
  line(slip.carriedByName ?? "Not recorded", 11, regular, 12);

  const total = slip.serialCount + slip.quantityTotal;
  const pieces = slip.pieceTotal ?? 0;
  line("Expected in this transfer", 8, regular, 1);
  if (total > 0 || pieces === 0) line(`${total} item${total === 1 ? "" : "s"} in total`, 14, bold, 3);
  if (pieces > 0) line(`${total > 0 ? "plus " : ""}${pieces.toLocaleString("en-GB")} loose piece${pieces === 1 ? "" : "s"}`, total > 0 ? 11 : 14, bold, 3);
  if (slip.serialCount > 0) line(`${slip.serialCount} serialized (scan each one)`, 10, regular, 2);
  if (slip.quantityTotal > 0) line(`${slip.quantityTotal} bulk (count each batch)`, 10, regular, pieces > 0 ? 2 : 8);
  if (pieces > 0) line(`${pieces.toLocaleString("en-GB")} pieces (count the pieces in each batch)`, 10, regular, 8);

  if (slip.parts && slip.parts.length > 0) {
    line("Batch parts", 8, regular, 1);
    for (const p of slip.parts.slice(0, 8)) line(`${p.batchCode}  part ${p.letter}`, 10, regular, 2);
    if (slip.parts.length > 8) line(`and ${slip.parts.length - 8} more`, 9, regular, 2);
    y -= 6;
  }

  if (slip.note) {
    y -= 4;
    line("Note", 8, regular, 1);
    line(slip.note, 10, regular, 8);
  }

  y = MARGIN + 28;
  line("Scan this barcode at the destination to start the receipt.", 8, regular, 2);
  line("Count bulk items before looking at any expected figure.", 8, regular, 0);

  return pdf.save();
}

/**
 * Just the transfer barcode and its code, on a 50 x 22 mm label (the same size as the bottle and box labels in
 * lib/tspl.ts and lib/label-pdf.ts), with nothing else on it. By default the page is exactly one label, for the
 * label printer (Xprinter XP-365B, stock set to 50 x 22 mm). Pass `sheet: "a4"` to centre the label on an A4 sheet
 * instead, for the office laser printer: a bare 50 x 22 mm page would land in the top-left corner of the paper.
 */
export async function renderTransferLabelPdf(code: string, options: { sheet?: "a4" | "label" } = {}): Promise<Uint8Array> {
  const width = 50 * MM;
  const height = 22 * MM;
  const pad = 2.5 * MM;
  const pdf = await PDFDocument.create();
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);

  const onA4 = options.sheet === "a4";
  const page = onA4 ? pdf.addPage([210 * MM, 297 * MM]) : pdf.addPage([width, height]);
  // Where the label's bottom-left corner sits on the page: the middle of the sheet, or the page corner.
  const ox = onA4 ? (page.getWidth() - width) / 2 : 0;
  const oy = onA4 ? (page.getHeight() - height) / 2 : 0;

  const image = await pdf.embedPng(await code128Png(code));
  const scale = Math.min((width - 2 * pad) / image.width, (11 * MM) / image.height);
  const w = image.width * scale;
  const h = image.height * scale;
  page.drawImage(image, { x: ox + (width - w) / 2, y: oy + height - pad - h, width: w, height: h });

  const size = 10;
  const textWidth = bold.widthOfTextAtSize(code, size);
  page.drawText(code, { x: ox + (width - textWidth) / 2, y: oy + pad, size, font: bold });

  return pdf.save();
}
