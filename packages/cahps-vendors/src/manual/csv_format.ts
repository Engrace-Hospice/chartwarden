// @chartwarden/cahps-vendors — manual-vendor CSV column schemas + helpers (M30 §4.5 manual adapter).
//
// For tenants without a vendor contract, the `manual` adapter renders a decedent CSV the QAPI Coordinator
// emails to a vendor of their choice, and accepts the vendor's aggregate back as a CSV upload (R-16). This
// module documents BOTH column schemas and owns the small, pure CSV render/parse helpers the adapter uses.
import { ChartWardenError } from "@chartwarden/types";

/** Manual DECEDENT export columns, in order (the file the coordinator sends out). */
export const MANUAL_DECEDENT_COLUMNS = [
  "decedent_id",
  "deceased_date",
  "primary_caregiver_name",
  "primary_caregiver_phone",
  "primary_caregiver_email",
  "exclusion_reason",
  "language_preference",
] as const;

/** Manual RESULT ingest columns, in order (the aggregate the coordinator uploads back). */
export const MANUAL_RESULT_COLUMNS = [
  "provider_entity_id",
  "reporting_period_start",
  "reporting_period_end",
  "top_box_percentages_json",
  "composite_scores_json",
  "response_count",
  "attempted_sample_count",
  "response_rate",
] as const;

/** RFC-4180 field escaping (quote + double inner quotes on comma/quote/newline). */
export function csvField(value: string | null): string {
  const raw = value ?? "";
  if (/[",\r\n]/.test(raw)) {
    return `"${raw.replaceAll('"', '""')}"`;
  }
  return raw;
}

/** Render a header + ordered rows into a CRLF CSV (RFC-4180), as UTF-8 bytes. */
export function renderCsv(
  header: readonly string[],
  rows: readonly (readonly (string | null)[])[],
): Buffer {
  const lines = [header.join(","), ...rows.map((cells) => cells.map(csvField).join(","))];
  return Buffer.from(`${lines.join("\r\n")}\r\n`, "utf8");
}

/**
 * Parse a CRLF/LF CSV into header + record objects keyed by column. RFC-4180 aware (handles quoted fields
 * with embedded commas, quotes, and newlines). Throws `VALIDATION_FAILED` on a row whose arity differs
 * from the header. Pure.
 */
export function parseCsv(payload: Buffer): { header: string[]; records: Record<string, string>[] } {
  const fields = tokenize(payload.toString("utf8"));
  if (fields.length === 0 || fields[0] === undefined || fields[0].length === 0) {
    throw new ChartWardenError("VALIDATION_FAILED", "CSV payload is empty", 422);
  }
  const header = fields[0];
  const records: Record<string, string>[] = [];
  for (let i = 1; i < fields.length; i++) {
    const row = fields[i];
    if (row === undefined) {
      continue;
    }
    if (row.length === 1 && row[0] === "") {
      continue; // tolerate a trailing blank line
    }
    if (row.length !== header.length) {
      throw new ChartWardenError(
        "VALIDATION_FAILED",
        `CSV row ${i} has ${row.length} fields; expected ${header.length}`,
        422,
      );
    }
    const record: Record<string, string> = {};
    header.forEach((col, idx) => {
      record[col] = row[idx] ?? "";
    });
    records.push(record);
  }
  return { header, records };
}

/** Tokenize CSV text into rows of fields (RFC-4180). Internal to the parser. */
function tokenize(text: string): string[][] {
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
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (ch !== "\r") {
      field += ch;
    }
  }
  // flush the final field/row when the file does not end in a newline
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}
