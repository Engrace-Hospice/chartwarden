// @wardenx/terminology-loader — the "WardenX normalized CSV" reader: the documented admin-upload format for
// code lists that have no single machine-readable vendor release (X12 CARC/RARC, UB-04 revenue codes) and the
// fallback for HCPCS / ICD-10-PCS / CVX when an operator hand-curates a file.
//
//   code,display[,status][,effective_date][,end_date][,<any other column → properties>]
//
// `status` is active|deprecated|retired (default active); dates are YYYY-MM-DD, YYYYMMDD or M/D/YYYY.
// UTF-8, comma separated, RFC-4180 quoting. Every row is validated against the system's code grammar.
import { decodeUtf8, requireEntry } from "../bytes";
import { parseCsvRecords } from "../csv";
import { LoaderDataError } from "../errors";
import type { ConceptStatus, LoadableSystemId, ParsedSource, SourceBundle } from "../types";
import {
  assertCodeShape,
  assertDisplay,
  concept,
  finish,
  parseDate,
  rejectCptShaped,
} from "./shared";

const STATUSES: readonly string[] = ["active", "deprecated", "retired"];
const KNOWN = new Set(["code", "display", "status", "effective_date", "end_date"]);

/** The code grammar per system for the normalized CSV (anchored, upper-case). */
export const NORMALIZED_CODE_SHAPE: Partial<Record<LoadableSystemId, RegExp>> = {
  revenue: /^\d{4}$/,
  carc: /^[A-Z0-9]{1,4}$/,
  rarc: /^[A-Z0-9]{1,8}$/,
  hcpcs: /^(?:[A-Z]\d{4}|[A-Z0-9]{2})$/,
  icd10pcs: /^[0-9A-Z]{3,7}$/,
  cvx: /^\d{1,3}$/,
};

/** Parse a normalized CSV for `system`. */
export function parseNormalizedCsv(system: LoadableSystemId, bundle: SourceBundle): ParsedSource {
  const shape = NORMALIZED_CODE_SHAPE[system];
  if (!shape) {
    throw new LoaderDataError("FORMAT_UNSUPPORTED", `${system} has no normalized CSV code grammar`);
  }
  const name = requireEntry(bundle, /\.csv$/i, "a .csv file");
  const { header, records } = parseCsvRecords(decodeUtf8(bundle.read(name)), ["code", "display"]);
  const extra = header.filter((h) => !KNOWN.has(h));
  const rows = records.map((r, i) => {
    const where = `row ${i + 1}`;
    const code = (r.code as string).toUpperCase();
    assertCodeShape(system, code, shape, where);
    if (system === "hcpcs") rejectCptShaped(code, system);
    assertDisplay(system, r.display as string, where);
    const status = (r.status || "active").toLowerCase();
    if (!STATUSES.includes(status)) {
      throw new LoaderDataError(
        "STATUS_INVALID",
        `${system} ${where}: status must be one of ${STATUSES.join("|")}`,
      );
    }
    const props = Object.fromEntries(extra.filter((c) => r[c] !== "").map((c) => [c, r[c]]));
    return concept(code, r.display as string, status as ConceptStatus, {
      effectiveDate: parseDate(r.effective_date, `${where} effective_date`),
      endDate: parseDate(r.end_date, `${where} end_date`),
      properties: props,
    });
  });
  return finish(system, rows);
}

/**
 * True when the bundle is a normalized CSV: a `.csv` member, or a single raw upload whose first line is the
 * `code,…` header. Lets HCPCS/CVX accept either their vendor file or a curated CSV.
 */
export function isNormalizedCsv(bundle: SourceBundle): boolean {
  if (bundle.names.some((n) => /\.csv$/i.test(n))) return true;
  if (bundle.names.length !== 1 || bundle.names[0] !== "upload") return false;
  const head = decodeUtf8(bundle.read("upload").subarray(0, 64));
  return /^\s*code\s*,/i.test(head);
}
