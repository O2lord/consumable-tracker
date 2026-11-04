// TSPL (TSC) templates, for label printers that speak TSPL such as the Xprinter XP-365B.
// Pure string building, like zpl.ts. Unlike a PDF through the driver, the job states the label size and the gap
// itself, so the printer feeds to the next gap every time instead of guessing from a paper size.
//
// Sizes are in mm and positions in dots (203 dpi = 8 dots per mm). Change the constants below to fit another label.
// The layout is worked out once (layoutLabel) and used both for the printer commands and for the on-screen preview.

import { barcodeText, detailLine, truncate, type Label } from "./label-types.ts";

export const DOTS_PER_MM = 8;

/** Label width across the print head, in mm. Measured on the roll. */
export const TSPL_LABEL_W_MM = 50;
/** Label height along the feed, in mm. Labels repeat every 25 mm, so 22 mm label plus a 3 mm gap. */
export const TSPL_LABEL_H_MM = 22;
export const TSPL_GAP_MM = 3;

/** 0 or 1. If a test label comes out upside down, change this to the other value. */
export const TSPL_DIRECTION: 0 | 1 = 0;

/**
 * Moves everything up or down on the label, in dots (8 dots = 1 mm). Negative moves it UP, positive moves it down.
 * From a tablet or phone the job goes straight to the printer without the PC driver's own offset, so the print
 * can start too low on the label. If the writing starts too low, make this more negative (-8 = 1 mm higher).
 * If it starts too high or is cut off at the top, make it less negative. 0 sends no shift at all.
 */
export const TSPL_SHIFT_Y_DOTS: number = -64;

/** The SHIFT line for a job, or nothing when the shift is 0. */
function shiftCommand(): string[] {
  return TSPL_SHIFT_Y_DOTS === 0 ? [] : [`SHIFT ${TSPL_SHIFT_Y_DOTS}`];
}

/**
 * Where the text and the barcode all start, measured from the left edge of the label, in dots (8 dots = 1 mm).
 * Raise it to move everything right, lower it to move everything left. Do not go below about 4, or the
 * writing runs off the left edge.
 */
export const LEFT_X_DOTS = 16;
/** Space kept clear at the right edge, in dots. */
const RIGHT_MARGIN_DOTS = 16;

export const LABEL_W_DOTS = TSPL_LABEL_W_MM * DOTS_PER_MM;
export const LABEL_H_DOTS = TSPL_LABEL_H_MM * DOTS_PER_MM;
const INNER_DOTS = LABEL_W_DOTS - LEFT_X_DOTS - RIGHT_MARGIN_DOTS;

/** The printer's built-in fonts: the size of one character cell, in dots. */
export const FONT_CELL = {
  "1": { w: 8, h: 12 },
  "2": { w: 12, h: 20 },
  "3": { w: 16, h: 24 },
} as const;
export type TsplFont = keyof typeof FONT_CELL;

export interface TextItem {
  x: number;
  y: number;
  font: TsplFont;
  text: string;
}

export interface BarcodeItem {
  x: number;
  y: number;
  height: number;
  /** Width of the thinnest bar, in dots. */
  narrow: number;
  /** Total width in dots. */
  width: number;
  code: string;
}

export interface LabelLayout {
  texts: TextItem[];
  barcode: BarcodeItem;
}

/** TSPL strings sit between double quotes, so quotes and line breaks must never appear in field data. */
export function tsplText(text: string): string {
  return text
    .replace(/["\\]/g, "'")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/[^\x20-\x7e]/g, "?")
    .trim();
}

/** How many modules wide a Code 128 barcode is: 11 per symbol (start, data, check) plus a 13 module stop. */
export function barcodeModules(chars: number): number {
  return 11 * (chars + 2) + 13;
}

/** Where everything sits on the label, in dots. The text and the barcode all start at the same left edge. */
export function layoutLabel(label: Label): LabelLayout {
  const code = tsplText(barcodeText(label));
  const name = tsplText(truncate(label.itemName, 30));
  const details = tsplText(truncate(detailLine(label), 38));

  // Use the wider bars when they fit, so the barcode scans more easily.
  const modules = barcodeModules(code.length);
  const narrow = modules * 2 <= INNER_DOTS ? 2 : 1;
  const width = modules * narrow;
  const left = LEFT_X_DOTS;

  return {
    // Everything sits a little higher than before and the details line ends well inside the label (about 6 mm
    // above the bottom edge of the 22 mm label), because the printer feeds a little low and the last line was
    // being cut off at the label edge.
    texts: [
      { x: left, y: 4, font: "2", text: name },
      { x: left, y: 90, font: "3", text: code },
      ...(details ? [{ x: left, y: 120, font: "1" as const, text: details }] : []),
    ],
    barcode: { x: left, y: 30, height: 54, narrow, width, code },
  };
}

export function labelToTspl(label: Label): string {
  const { texts, barcode } = layoutLabel(label);
  const [name, ...rest] = texts;
  const text = (t: TextItem) => `TEXT ${t.x},${t.y},"${t.font}",0,1,1,"${t.text}"`;

  return [
    `SIZE ${TSPL_LABEL_W_MM} mm,${TSPL_LABEL_H_MM} mm`,
    `GAP ${TSPL_GAP_MM} mm,0 mm`,
    `DIRECTION ${TSPL_DIRECTION}`,
    "REFERENCE 0,0",
    ...shiftCommand(),
    "CLS",
    text(name),
    `BARCODE ${barcode.x},${barcode.y},"128",${barcode.height},0,0,${barcode.narrow},${barcode.narrow},"${barcode.code}"`,
    ...rest.map(text),
    "PRINT 1,1",
  ].join("\r\n");
}

export interface IssueLabelTspl {
  serial: string;
  patientHospitalNo: string | null;
  references: { type: string; ref: string; testCode: string | null }[];
  issuedAt: Date;
  collectorType: string | null;
  collectorName: string | null;
  locationName: string;
}

const ISSUE_MAX_REFERENCES = 3;

/** The issue label (stuck on a bottle when it is handed out) for the same printer, laid out like the PDF one. */
export function issueLabelToTspl(label: IssueLabelTspl): string {
  const left = LEFT_X_DOTS;
  const text = (x: number, y: number, font: TsplFont, value: string) => `TEXT ${x},${y},"${font}",0,1,1,"${tsplText(value)}"`;
  const lines: string[] = [];
  let y = 4;

  lines.push(text(left, y, "3", truncate(label.patientHospitalNo ?? label.locationName, 24)));
  y += 28;
  const shown = label.references.slice(0, ISSUE_MAX_REFERENCES);
  for (const r of shown) {
    lines.push(text(left, y, "1", truncate(r.testCode ? `${r.ref}  ${r.testCode}` : r.ref, 46)));
    y += 14;
  }
  const extra = label.references.length - shown.length;
  if (extra > 0) {
    lines.push(text(left, y, "1", `+ ${extra} more`));
    y += 14;
  }
  const collector = [label.collectorType, label.collectorName].filter(Boolean).join(": ");
  lines.push(text(left, y, "1", truncate(`${label.issuedAt.toLocaleDateString("en-GB")}${collector ? `  ${collector}` : ""}`, 46)));
  y += 16;

  const code = tsplText(label.serial);
  const modules = barcodeModules(code.length);
  const narrow = modules * 2 <= INNER_DOTS ? 2 : 1;
  const barcodeH = Math.max(24, Math.min(44, LABEL_H_DOTS - 28 - y));

  return [
    `SIZE ${TSPL_LABEL_W_MM} mm,${TSPL_LABEL_H_MM} mm`,
    `GAP ${TSPL_GAP_MM} mm,0 mm`,
    `DIRECTION ${TSPL_DIRECTION}`,
    "REFERENCE 0,0",
    ...shiftCommand(),
    "CLS",
    ...lines,
    `BARCODE ${left},${y},"128",${barcodeH},0,0,${narrow},${narrow},"${code}"`,
    text(left, y + barcodeH + 3, "2", label.serial),
    "PRINT 1,1",
    "",
  ].join("\r\n");
}

/** One job holding every label, one after another. */
export function labelsToTspl(labels: Label[]): string {
  return labels.map(labelToTspl).join("\r\n") + "\r\n";
}
