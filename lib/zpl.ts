// ZPL (Zebra) templates. Pure string building, so it is easy to unit-test.
// Layout is designed for a 50 x 25 mm label at 203 dpi (400 x 200 dots), which suits sample bottles.
// For another label size, change the constants and the field positions below.

import { barcodeText, detailLine, truncate, type Label } from "./label-types.ts";

export const LABEL_WIDTH_DOTS = 400;
export const LABEL_HEIGHT_DOTS = 200;

/** ZPL treats ^ and ~ as command characters, so they must never appear in field data. */
export function zplText(text: string): string {
  return text.replace(/[\^~\\]/g, " ").replace(/[\r\n\t]+/g, " ").trim();
}

export function labelToZpl(label: Label): string {
  const code = zplText(barcodeText(label));
  const name = zplText(truncate(label.itemName, 30));
  const details = zplText(truncate(detailLine(label), 38));

  return [
    "^XA",
    "^CI28",
    `^PW${LABEL_WIDTH_DOTS}`,
    `^LL${LABEL_HEIGHT_DOTS}`,
    "^LH0,0",
    `^FO20,12^A0N,24,24^FD${name}^FS`,
    // Code 128, module width 2, ratio 3, height 70, no built-in text.
    `^FO20,44^BY2,3,70^BCN,70,N,N,N^FD${code}^FS`,
    `^FO20,124^A0N,34,34^FD${code}^FS`,
    `^FO20,164^A0N,22,22^FD${details}^FS`,
    "^XZ",
  ].join("\n");
}

/** One ZPL job holding every label, one after another. */
export function labelsToZpl(labels: Label[]): string {
  return labels.map(labelToZpl).join("\n") + "\n";
}
