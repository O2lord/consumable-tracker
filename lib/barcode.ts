// Code 128 barcode images via bwip-js (Node build). Used for PDF labels and test sheets.
import bwipjs from "bwip-js/node";

/** Code 128 can encode printable ASCII; serials and batch codes are a small subset of that. */
export function isCode128Safe(text: string): boolean {
  return text.length > 0 && /^[\x20-\x7e]+$/.test(text);
}

/** PNG of a Code 128 barcode with no human-readable text (the label draws its own). */
export async function code128Png(text: string, options: { scale?: number; height?: number } = {}): Promise<Uint8Array> {
  if (!isCode128Safe(text)) throw new Error(`Cannot encode "${text}" as Code 128`);
  const buffer = await bwipjs.toBuffer({
    bcid: "code128",
    text,
    scale: options.scale ?? 3,
    height: options.height ?? 10, // millimetres
    includetext: false,
    paddingwidth: 0,
    paddingheight: 0,
  });
  return new Uint8Array(buffer);
}
