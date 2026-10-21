// @chartwarden/terminology-loader — ICD-10-PCS parser (CMS; tier 1 public).
//
// The PCS order file (`icd10pcs_order_YYYY.txt`) has the SAME fixed-width layout as the ICD-10-CM order
// file (order no · code · valid-for-submission flag · short title · long title), so it shares that reader.
// PCS codes carry no dot and have no tabular-derived properties.
import { decodeUtf8, requireEntry } from "../bytes";
import type { ParsedSource, SourceBundle } from "../types";
import { parseOrderFile } from "./icd10cm-release";
import { concept, finish } from "./shared";

const ORDER_ENTRY = /icd10pcs[-_]order[-_]\d{4}\.txt$/i;
/** PCS codes are 3–7 alphanumerics and (unlike CM) may start with a digit. */
const PCS_CODE = /^[0-9A-Z]{3,7}$/;

/** Parse an ICD-10-PCS order-file bundle. */
export function parseIcd10pcs(bundle: SourceBundle): ParsedSource {
  const name = requireEntry(bundle, ORDER_ENTRY, "icd10pcs_order_YYYY.txt");
  const order = parseOrderFile(decodeUtf8(bundle.read(name)), PCS_CODE);
  return finish(
    "icd10pcs",
    order.map((e) =>
      concept(e.code, e.longTitle, "active", {
        properties: { isBillableLeaf: e.billable, shortTitle: e.shortTitle },
      }),
    ),
  );
}
