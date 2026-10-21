// @chartwarden/terminology-loader — the parser registry: one pure `file bytes → rows` function per system.
import { bundleFromBytes } from "../bytes";
import { LoaderDataError } from "../errors";
import type { LoadableSystemId, ParsedSource, SourceBundle } from "../types";
import { parseCvx } from "./cvx";
import { parseHcpcs } from "./hcpcs";
import { parseIcd10cm } from "./icd10cm";
import { parseIcd10pcs } from "./icd10pcs";
import { parseLoinc } from "./loinc";
import { parseNdc } from "./ndc";
import { parseNormalizedCsv } from "./normalized-csv";
import { parseRxnorm } from "./rxnorm";
import { parseSnomed } from "./snomed";
import { isX12Html, parseX12CodeListHtml } from "./x12-code-list-html";

const PARSERS: Readonly<Record<LoadableSystemId, (bundle: SourceBundle) => ParsedSource>> = {
  icd10cm: parseIcd10cm,
  icd10pcs: parseIcd10pcs,
  snomed: parseSnomed,
  loinc: parseLoinc,
  rxnorm: parseRxnorm,
  ndc: parseNdc,
  hcpcs: parseHcpcs,
  cvx: parseCvx,
  revenue: (b) => parseNormalizedCsv("revenue", b),
  // X12 publishes CARC/RARC only as web pages: accept the saved page, or the documented normalized CSV.
  carc: (b) => (isX12Html(b) ? parseX12CodeListHtml("carc", b) : parseNormalizedCsv("carc", b)),
  rarc: (b) => (isX12Html(b) ? parseX12CodeListHtml("rarc", b) : parseNormalizedCsv("rarc", b)),
};

/** Parse the bytes of an uploaded/fetched source for `system`. Throws {@link LoaderDataError} on any fault. */
export function parseSource(system: LoadableSystemId, bytes: Uint8Array): ParsedSource {
  const parser = PARSERS[system];
  if (!parser) throw new LoaderDataError("SYSTEM_NOT_LOADABLE", `${system} has no parser`);
  try {
    return parser(bundleFromBytes(bytes));
  } catch (err) {
    // A parser is pure over the bytes, so any fault it raises (including a zlib/inflate error or the legacy
    // ICD reader's plain Error) is deterministic: retrying cannot help, so it is a data error that fails the version.
    if (err instanceof LoaderDataError) throw err;
    throw new LoaderDataError("SOURCE_INVALID", err instanceof Error ? err.message : String(err));
  }
}

export {
  parseCvx,
  parseHcpcs,
  parseIcd10cm,
  parseIcd10pcs,
  parseLoinc,
  parseNdc,
  parseNormalizedCsv,
  parseRxnorm,
  parseSnomed,
  parseX12CodeListHtml,
};
export { icd10cmOrderEntries } from "./icd10cm";
export { toNdc11 } from "./ndc";
export { parseHcpcsFixedWidth } from "./hcpcs";
