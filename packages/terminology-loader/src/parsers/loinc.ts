// @chartwarden/terminology-loader — LOINC parser (Regenstrief; tier 2: free licence + attribution).
//
// Input: `Loinc.csv` from the LOINC release (a zip with the file under `LoincTable/`, or the CSV raw). Columns are
// read BY NAME, so the several releases that reorder or add columns all parse. Status mapping:
// ACTIVE/TRIAL → active · DISCOURAGED → deprecated · DEPRECATED → retired.
import { decodeUtf8, requireEntry } from "../bytes";
import { parseCsvRecords } from "../csv";
import { LoaderDataError } from "../errors";
import type { ConceptStatus, ParsedSource, SourceBundle } from "../types";
import { assertCodeShape, assertDisplay, concept, finish } from "./shared";

const LOINC_NUM = /^\d{1,7}-\d$/;
const REQUIRED = [
  "loinc_num",
  "component",
  "property",
  "time_aspct",
  "system",
  "scale_typ",
  "method_typ",
  "status",
  "shortname",
  "long_common_name",
];
const STATUS: Readonly<Record<string, ConceptStatus>> = {
  ACTIVE: "active",
  TRIAL: "active",
  DISCOURAGED: "deprecated",
  DEPRECATED: "retired",
};

/** Parse a LOINC table bundle. */
export function parseLoinc(bundle: SourceBundle): ParsedSource {
  const name = requireEntry(bundle, /(?:^|\/)Loinc\.csv$/i, "Loinc.csv");
  const { records } = parseCsvRecords(decodeUtf8(bundle.read(name)), REQUIRED);
  const concepts = records.map((r, i) => {
    const where = `row ${i + 1}`;
    const code = r.loinc_num as string;
    assertCodeShape("loinc", code, LOINC_NUM, where);
    const status = STATUS[(r.status as string).toUpperCase()];
    if (!status) throw new LoaderDataError("STATUS_INVALID", `loinc ${where}: unknown STATUS`);
    const display = r.long_common_name || (r.shortname as string);
    assertDisplay("loinc", display, where);
    return concept(code, display, status, {
      properties: {
        component: r.component || null,
        property: r.property || null,
        time: r.time_aspct || null,
        system: r.system || null,
        scale: r.scale_typ || null,
        method: r.method_typ || null,
        shortName: r.shortname || null,
        loincClass: r.class || undefined,
      },
    });
  });
  return finish("loinc", concepts);
}
