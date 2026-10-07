// @wardenx/terminology-loader — CVX parser (CDC vaccine administered codes; tier 1 public).
//
// Input: the CDC `cvx.txt` — pipe-delimited, one vaccine per line:
//   CVX code | short description | full vaccine name | notes | status | … trailing fields (ignored)
// The code is space-padded in the file. ⚠ Layout provenance: fields 0-4 are as documented by CDC to the author;
// no real file is in the repository, so the reader is strict (numeric code, known status) and fixture-pinned.
// A normalized CSV (./normalized-csv) is accepted as an alternative.
import { iterLines, requireEntry } from "../bytes";
import { LoaderDataError } from "../errors";
import type { ConceptStatus, ParsedSource, SourceBundle } from "../types";
import { isNormalizedCsv, parseNormalizedCsv } from "./normalized-csv";
import { assertCodeShape, assertDisplay, concept, finish } from "./shared";

const CVX_CODE = /^\d{1,3}$/;

/** CDC `VaccineStatus` → `concept_status`. */
const STATUS: Readonly<Record<string, ConceptStatus>> = {
  active: "active",
  pending: "active",
  "not applicable": "active",
  inactive: "deprecated",
  "never active": "retired",
};

/** Parse a CVX bundle. */
export function parseCvx(bundle: SourceBundle): ParsedSource {
  if (isNormalizedCsv(bundle)) return parseNormalizedCsv("cvx", bundle);
  const name = requireEntry(bundle, /cvx.*\.txt$/i, "cvx.txt");
  const concepts = [];
  let n = 0;
  for (const line of iterLines(bundle.read(name))) {
    n++;
    if (line.trim() === "") continue;
    const f = line.split("|").map((s) => s.trim());
    if (f.length < 5)
      throw new LoaderDataError("RECORD_INVALID", `cvx line ${n}: fewer than 5 fields`);
    const code = f[0] as string;
    assertCodeShape("cvx", code, CVX_CODE, `line ${n}`);
    const status = STATUS[(f[4] as string).toLowerCase()];
    if (!status)
      throw new LoaderDataError("STATUS_INVALID", `cvx line ${n}: unknown vaccine status`);
    const display = (f[2] as string) || (f[1] as string);
    assertDisplay("cvx", display, `line ${n}`);
    concepts.push(
      concept(code, display, status, {
        properties: { shortDescription: f[1], notes: f[3] || undefined, cdcStatus: f[4] },
      }),
    );
  }
  return finish("cvx", concepts);
}
