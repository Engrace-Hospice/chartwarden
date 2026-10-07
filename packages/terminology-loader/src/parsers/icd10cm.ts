// @wardenx/terminology-loader — ICD-10-CM parser (CDC/NCHS release; tier 1 public).
//
// Input: a zip (or raw file) holding `icd10cm-order-YYYY.txt` and, optionally, the Tabular List XML
// (`icd10cm-tabular*.xml`). The order file alone yields every code with its billable flag, parent and
// titles; the Tabular adds the chapter and the inherited instructional-note flags the coding checks read.
// The fixed-width / XML parsing rules are the F-238 ones (./icd10cm-release), unit-tested against fixtures.
import { decodeUtf8, findEntry, requireEntry } from "../bytes";
import type { ParsedSource, SourceBundle } from "../types";
import { type OrderEntry, buildConceptRows, parseOrderFile, parseTabular } from "./icd10cm-release";
import { concept, finish } from "./shared";

const ORDER_ENTRY = /icd10cm[-_]order[-_]\d{4}\.txt$/i;
const TABULAR_ENTRY = /icd10cm[-_]tabular.*\.xml$/i;

/** Parse an ICD-10-CM release bundle. */
export function parseIcd10cm(bundle: SourceBundle): ParsedSource {
  const orderName = requireEntry(bundle, ORDER_ENTRY, "icd10cm-order-YYYY.txt");
  const order = parseOrderFile(decodeUtf8(bundle.read(orderName)));
  const tabularName = findEntry(bundle, TABULAR_ENTRY);
  const warnings: string[] = [];
  const tabular = tabularName ? parseTabular(decodeUtf8(bundle.read(tabularName))) : [];
  if (!tabularName)
    warnings.push("Tabular List absent: chapter and instructional-note flags not derived");
  const rows = buildConceptRows(order, tabular);
  return finish(
    "icd10cm",
    rows.map((r) =>
      concept(r.code, r.display, "active", {
        properties: {
          isBillableLeaf: r.isBillableLeaf,
          chapter: r.chapter,
          parentCode: r.parentCode,
          ...r.properties,
        },
      }),
    ),
    warnings,
  );
}

/** The order entries of a bundle (used by the deprecation diff to find billable → header transitions). */
export function icd10cmOrderEntries(bundle: SourceBundle): OrderEntry[] {
  return parseOrderFile(decodeUtf8(bundle.read(requireEntry(bundle, ORDER_ENTRY, "order file"))));
}
