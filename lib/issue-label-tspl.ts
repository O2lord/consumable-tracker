// Issue label as TSPL, for the extension: stuck on a bottle when it is handed out. Same content as the PDF in
// issue-label-pdf.ts (hospital number, investigations, date and collector, serial barcode), but laid out on a fixed
// label, because a TSPL job states the label size up front. The PDF label is as tall as its content; this one is not.
//
// It is sized for the same roll as the other labels (50 x 22 mm). For a bigger roll, change the three constants
// below: ISSUE_LABEL_W_MM, ISSUE_LABEL_H_MM and MAX_REFERENCE_LINES (more height leaves room for more investigations).

import { truncate } from "./label-types.ts";
import type { IssueLabelData } from "./issue-label-pdf.ts";
import {
  DOTS_PER_MM,
  FONT_CELL,
  LEFT_X_DOTS,
  TSPL_DIRECTION,
  TSPL_GAP_MM,
  barcodeModules,
  tsplText,
  type BarcodeItem,
  type TextItem,
} from "./tspl.ts";

export const ISSUE_LABEL_W_MM = 50;
export const ISSUE_LABEL_H_MM = 22;
/** How many lines of investigations fit between the hospital number and the date line. */
const MAX_REFERENCE_LINES = 2;

const W_DOTS = ISSUE_LABEL_W_MM * DOTS_PER_MM;
const H_DOTS = ISSUE_LABEL_H_MM * DOTS_PER_MM;
const RIGHT_MARGIN_DOTS = 16;
const INNER_DOTS = W_DOTS - LEFT_X_DOTS - RIGHT_MARGIN_DOTS;
const LINE_GAP = 4;

export interface IssueLabelLayout {
  texts: TextItem[];
  barcode: BarcodeItem;
}

/** Investigations packed onto as few lines as fit, with "+N" at the end of the last line when some do not fit. */
function referenceLines(label: IssueLabelData, perLine: number): string[] {
  const refs = label.references.map((r) => (r.testCode ? `${r.ref} ${r.testCode}` : r.ref));
  const lines: string[] = [];
  let current = "";
  let consumed = 0;
  for (const ref of refs) {
    const candidate = current ? `${current}, ${ref}` : ref;
    if (candidate.length <= perLine) {
      current = candidate;
      consumed++;
      continue;
    }
    if (current) {
      lines.push(current);
      current = "";
    }
    if (lines.length >= MAX_REFERENCE_LINES) break;
    current = ref.slice(0, perLine); // one reference longer than a whole line is cut
    consumed++;
  }
  if (current && lines.length < MAX_REFERENCE_LINES) lines.push(current);

  const hidden = refs.length - consumed;
  if (hidden > 0 && lines.length > 0) {
    const suffix = ` +${hidden}`;
    const last = lines.length - 1;
    lines[last] = lines[last].slice(0, perLine - suffix.length) + suffix;
  }
  return lines;
}

export function layoutIssueLabel(label: IssueLabelData): IssueLabelLayout {
  const left = LEFT_X_DOTS;
  const texts: TextItem[] = [];
  let y = 8;
  const add = (font: TextItem["font"], text: string) => {
    texts.push({ x: left, y, font, text: tsplText(text) });
    y += FONT_CELL[font].h + LINE_GAP;
  };

  const perLine = (font: TextItem["font"]) => Math.floor(INNER_DOTS / FONT_CELL[font].w);

  add("3", truncate(label.patientHospitalNo ?? label.locationName, perLine("3")));
  for (const line of referenceLines(label, perLine("2"))) add("2", line);

  const collector = [label.collectorType, label.collectorName].filter(Boolean).join(": ");
  add("1", truncate(`${label.issuedAt.toLocaleDateString("en-GB")}${collector ? `  ${collector}` : ""}`, perLine("1")));

  // The serial is printed in words along the bottom edge; the barcode takes the space between.
  const serialY = H_DOTS - FONT_CELL["2"].h - 6;
  const code = tsplText(label.serial);
  texts.push({ x: left, y: serialY, font: "2", text: code });

  const modules = barcodeModules(code.length);
  const narrow = modules * 2 <= INNER_DOTS ? 2 : 1;
  const height = Math.max(24, Math.min(60, serialY - 4 - y));
  return { texts, barcode: { x: left, y, height, narrow, width: modules * narrow, code } };
}

export function issueLabelToTspl(label: IssueLabelData): string {
  const { texts, barcode } = layoutIssueLabel(label);
  return [
    `SIZE ${ISSUE_LABEL_W_MM} mm,${ISSUE_LABEL_H_MM} mm`,
    `GAP ${TSPL_GAP_MM} mm,0 mm`,
    `DIRECTION ${TSPL_DIRECTION}`,
    "REFERENCE 0,0",
    "CLS",
    ...texts.map((t) => `TEXT ${t.x},${t.y},"${t.font}",0,1,1,"${t.text}"`),
    `BARCODE ${barcode.x},${barcode.y},"128",${barcode.height},0,0,${barcode.narrow},${barcode.narrow},"${barcode.code}"`,
    "PRINT 1,1",
  ].join("\r\n") + "\r\n";
}
