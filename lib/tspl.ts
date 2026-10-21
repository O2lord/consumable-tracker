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
    texts: [
      { x: left, y: 10, font: "2", text: name },
      { x: left, y: 108, font: "3", text: code },
      ...(details ? [{ x: left, y: 144, font: "1" as const, text: details }] : []),
    ],
    barcode: { x: left, y: 40, height: 60, narrow, width, code },
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
    "CLS",
    text(name),
    `BARCODE ${barcode.x},${barcode.y},"128",${barcode.height},0,0,${barcode.narrow},${barcode.narrow},"${barcode.code}"`,
    ...rest.map(text),
    "PRINT 1,1",
  ].join("\r\n");
}

/**
 * Just the transfer barcode and its code, to stick on the box (the TSPL twin of renderTransferLabelPdf). Same roll,
 * gap, direction and left margin as the other labels, with the barcode and the code centred between the margins.
 */
export function transferLabelToTspl(code: string): string {
  const value = tsplText(code);
  const modules = barcodeModules(value.length);
  const narrow = modules * 2 <= INNER_DOTS ? 2 : 1;
  const barcodeX = LEFT_X_DOTS + Math.max(0, Math.floor((INNER_DOTS - modules * narrow) / 2));
  const textX = LEFT_X_DOTS + Math.max(0, Math.floor((INNER_DOTS - value.length * FONT_CELL["3"].w) / 2));

  return [
    `SIZE ${TSPL_LABEL_W_MM} mm,${TSPL_LABEL_H_MM} mm`,
    `GAP ${TSPL_GAP_MM} mm,0 mm`,
    `DIRECTION ${TSPL_DIRECTION}`,
    "REFERENCE 0,0",
    "CLS",
    `BARCODE ${barcodeX},16,"128",100,0,0,${narrow},${narrow},"${value}"`,
    `TEXT ${textX},130,"3",0,1,1,"${value}"`,
    "PRINT 1,1",
  ].join("\r\n") + "\r\n";
}

/** One job holding every label, one after another. */
export function labelsToTspl(labels: Label[]): string {
  return labels.map(labelToTspl).join("\r\n") + "\r\n";
}
