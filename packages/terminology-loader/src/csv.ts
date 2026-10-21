// @chartwarden/terminology-loader — a small RFC-4180 CSV reader (quoted fields, doubled quotes, embedded
// newlines) and a header-keyed record view. No dependency: the LOINC release file is the one that needs it.
import { LoaderDataError } from "./errors";

/** Split CSV text into rows of fields. */
export function parseCsv(text: string, delimiter = ","): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === delimiter) {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else field += ch;
  }
  if (quoted) throw new LoaderDataError("CSV_INVALID", "unterminated quoted field");
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** One data row keyed by the (lower-cased, trimmed) header. */
export type CsvRecord = Readonly<Record<string, string>>;

/** Parse CSV with a header row into records; `requiredColumns` must all be present. */
export function parseCsvRecords(
  text: string,
  requiredColumns: readonly string[],
  delimiter = ",",
): { readonly header: readonly string[]; readonly records: readonly CsvRecord[] } {
  const rows = parseCsv(text, delimiter);
  const head = rows[0];
  if (!head) throw new LoaderDataError("CSV_INVALID", "file has no header row");
  const header = head.map((h) => h.trim().toLowerCase());
  const missing = requiredColumns.filter((c) => !header.includes(c.toLowerCase()));
  if (missing.length > 0) {
    throw new LoaderDataError("CSV_INVALID", `missing required column(s): ${missing.join(", ")}`);
  }
  const records = rows.slice(1).map((cells, i) => {
    if (cells.length !== header.length) {
      throw new LoaderDataError(
        "CSV_INVALID",
        `data row ${i + 1} has ${cells.length} fields, header has ${header.length}`,
      );
    }
    return Object.fromEntries(header.map((h, idx) => [h, (cells[idx] as string).trim()]));
  });
  return { header, records };
}
