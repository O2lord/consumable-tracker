// Turns an uploaded .csv or .xlsx file into rows of cell values. The only place that touches a
// spreadsheet library, so the parsers stay pure and testable. Server-side only.

/** A small RFC 4180 reader: quoted fields, doubled quotes, CRLF or LF, and a leading byte-order mark. */
export function parseCsv(input: string): string[][] {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += ch;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** A cell as the plain value a person sees: rich text, formulas and links are flattened. */
function excelValue(value: unknown): unknown {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value;
  if (typeof value !== "object") return value;
  const v = value as Record<string, unknown>;
  if (Array.isArray(v.richText)) return (v.richText as { text?: string }[]).map((t) => t.text ?? "").join("");
  if ("result" in v) return excelValue(v.result);
  if (typeof v.text === "string") return v.text;
  return "";
}

export class UnsupportedFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedFileError";
  }
}

/** First sheet of an .xlsx, or the whole of a .csv, as rows. */
export async function readRows(fileName: string, data: ArrayBuffer): Promise<unknown[][]> {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".csv")) return parseCsv(new TextDecoder("utf-8").decode(data));

  if (lower.endsWith(".xlsx")) {
    const { default: ExcelJS } = await import("exceljs");
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(Buffer.from(data) as unknown as import("exceljs").Buffer);
    const sheet = workbook.worksheets[0];
    if (!sheet) throw new UnsupportedFileError("The workbook has no sheets");
    const rows: unknown[][] = [];
    sheet.eachRow({ includeEmpty: true }, (row, rowNumber) => {
      const values = Array.isArray(row.values) ? (row.values as unknown[]) : [];
      rows[rowNumber - 1] = values.slice(1).map(excelValue);
    });
    for (let i = 0; i < rows.length; i++) rows[i] = rows[i] ?? [];
    return rows;
  }

  throw new UnsupportedFileError("Upload an .xlsx or .csv file");
}
