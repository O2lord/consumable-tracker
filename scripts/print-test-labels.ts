// Generates a sheet of sample labels for testing the printer and the scanner.
// The serials are valid (correct check character) but are NOT in the database, so the label-check
// screen will say "valid format, not in the system": that is the expected result for test labels.
//
// Run:  npm run print-test-labels                 writes tmp/test-labels/test-labels.pdf (A4 sheet) and .zpl
//       npm run print-test-labels -- --count 12   change how many labels (default 24, max 200)
//       npm run print-test-labels -- --print      also sends the ZPL to PRINTER_HOST

import { mkdir, writeFile } from "node:fs/promises";
import { generateBatchCode, generateSerial } from "../lib/serial.ts";
import { labelsToZpl } from "../lib/zpl.ts";
import { renderLabelsPdf } from "../lib/label-pdf.ts";
import { sendToPrinter } from "../lib/printer.ts";
import type { Label } from "../lib/label-types.ts";

function readCount(args: string[]): number {
  const i = args.indexOf("--count");
  if (i === -1) return 24;
  const n = Number(args[i + 1]);
  if (!Number.isInteger(n) || n < 1 || n > 200) throw new Error("--count must be a whole number from 1 to 200");
  return n;
}

async function main() {
  const args = process.argv.slice(2);
  const count = readCount(args);
  const print = args.includes("--print");

  const labels: Label[] = [];
  for (let i = 0; i < count - 1; i++) {
    labels.push({
      kind: "serial",
      serial: generateSerial(),
      itemName: "TEST EDTA 5ML TUBE",
      containerType: "EDTA",
      batchCode: "TEST",
      expiryDate: "2030-12-31",
      lotNo: "TEST",
    });
  }
  // One box label so both barcode kinds are exercised.
  labels.push({ kind: "batch", code: generateBatchCode(), itemName: "TEST BOX OF GLOVES", quantity: 100, expiryDate: "2030-12-31", lotNo: "TEST" });

  const dir = "tmp/test-labels";
  await mkdir(dir, { recursive: true });
  const zpl = labelsToZpl(labels);
  await writeFile(`${dir}/test-labels.zpl`, zpl, "utf8");
  await writeFile(`${dir}/test-labels.pdf`, await renderLabelsPdf(labels, "a4"));
  await writeFile(`${dir}/test-labels-single.pdf`, await renderLabelsPdf(labels, "label"));
  console.log(`Wrote ${labels.length} labels to ${dir}/ (A4 sheet PDF, one-per-page PDF, ZPL).`);

  if (print) {
    const host = process.env.PRINTER_HOST;
    if (!host) throw new Error("PRINTER_HOST is not set in .env.local");
    await sendToPrinter(host, zpl);
    console.log(`Sent to the printer at ${host}.`);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
