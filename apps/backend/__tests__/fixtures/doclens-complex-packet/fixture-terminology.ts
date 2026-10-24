// F-238 — a CodingTerminology over `icd10cm-subset.json`: real CDC/NCHS FY2026+FY2027 rows (exported from
// the loaded M38 tables) covering every code an OCR reading in this packet can resolve to.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { CodingTerminology, IcdCodeFacts, IcdDeprecation } from "@chartwarden/intake-extraction";

interface Row extends IcdCodeFacts {
  readonly version: string;
}
const data = JSON.parse(readFileSync(join(__dirname, "icd10cm-subset.json"), "utf8")) as {
  concepts: Row[];
  deprecations: IcdDeprecation[];
};

export const fixtureTerminology: CodingTerminology = {
  async lookup(codes, asOf) {
    const out = new Map<string, IcdCodeFacts>();
    for (const r of data.concepts)
      if (
        codes.includes(r.code) &&
        r.effectiveDate <= asOf &&
        (r.endDate === null || r.endDate >= asOf)
      )
        out.set(r.code, r);
    return out;
  },
  async titles(codes) {
    const out = new Map<string, string>();
    for (const r of data.concepts) if (codes.includes(r.code)) out.set(r.code, r.display); // ordered oldest → newest
    return out;
  },
  async coverageFrom() {
    return data.concepts.reduce<string | null>(
      (m, r) => (m === null || r.effectiveDate < m ? r.effectiveDate : m),
      null,
    );
  },
  async deprecations(codes) {
    return new Map(data.deprecations.filter((d) => codes.includes(d.code)).map((d) => [d.code, d]));
  },
};
