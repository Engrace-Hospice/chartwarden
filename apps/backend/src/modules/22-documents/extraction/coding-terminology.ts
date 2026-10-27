// apps/backend/src/modules/22-documents/extraction/coding-terminology.ts — F-238: the DocLens coding checks'
// `CodingTerminology` port, implemented over M38's published `TerminologyProvider` seam (M22 never reads
// M38's tables). ICD-10-CM must be loaded (`bun run db:load:icd10cm`); with an EMPTY code set every lookup
// misses, so the checks would call every code "unknown" — `isLoaded()` lets the job skip them instead and
// say so, rather than flood a reviewer with false flags.
import type {
  CodingTerminology,
  IcdCodeFacts,
  IcdDeprecation,
} from "@chartwarden/intake-extraction";
import { getSeam } from "../../../bootstrap/index";

/** The slice of M38's provider this adapter reads (structural, like every other seam consumer). */
interface Icd10Concept {
  readonly code: string;
  readonly display: string;
  readonly effectiveDate: string;
  readonly endDate: string | null;
  readonly properties: { readonly isBillableLeaf?: boolean; readonly manifestation?: boolean };
}
export interface M38CodingReader {
  lookupBatch(
    system: "icd10cm",
    codes: readonly string[],
    asOf?: Date,
  ): Promise<Map<string, Icd10Concept>>;
  getDeprecationMapping(
    system: "icd10cm",
    code: string,
  ): Promise<{ deprecationEffective: string; successorCodes: readonly string[] } | null>;
  listVersions?(
    system: "icd10cm",
  ): Promise<readonly { effectiveFrom: string; effectiveTo: string | null }[]>;
}

export interface CodingTerminologyAdapter extends CodingTerminology {
  /** False when no ICD-10-CM release is loaded — the coding checks must not run on an empty code set. */
  isLoaded(): Promise<boolean>;
}

const toFacts = (c: Icd10Concept): IcdCodeFacts => ({
  code: c.code,
  display: c.display,
  billable: c.properties.isBillableLeaf ?? false,
  manifestation: c.properties.manifestation ?? false,
  effectiveDate: c.effectiveDate,
  endDate: c.endDate,
});

export function createCodingTerminology(
  reader: M38CodingReader = getSeam("TerminologyProvider") as M38CodingReader,
): CodingTerminologyAdapter {
  let windows: Promise<readonly { effectiveFrom: string; effectiveTo: string | null }[]> | null =
    null;
  const versions = () => {
    windows ??= reader.listVersions ? reader.listVersions("icd10cm") : Promise.resolve([]);
    return windows;
  };
  return {
    async isLoaded() {
      return (await versions()).length > 0;
    },
    async coverageFrom() {
      return (await versions())[0]?.effectiveFrom ?? null;
    },
    async lookup(codes, asOfIso) {
      if (codes.length === 0) return new Map();
      const found = await reader.lookupBatch("icd10cm", codes, new Date(`${asOfIso}T12:00:00Z`));
      return new Map([...found].map(([code, c]) => [code, toFacts(c)]));
    },
    async titles(codes) {
      // Probe each loaded release (its first and last day), oldest first, so the newest title wins and a
      // code retired since an older release is still recognised as a real code.
      const out = new Map<string, string>();
      if (codes.length === 0) return out;
      for (const w of await versions()) {
        for (const day of [w.effectiveFrom, w.effectiveTo].filter((d): d is string => d !== null)) {
          const found = await reader.lookupBatch("icd10cm", codes, new Date(`${day}T12:00:00Z`));
          for (const [code, c] of found) out.set(code, c.display);
        }
      }
      return out;
    },
    async deprecations(codes) {
      const out = new Map<string, IcdDeprecation>();
      for (const code of new Set(codes)) {
        const m = await reader.getDeprecationMapping("icd10cm", code);
        if (m)
          out.set(code, { code, effective: m.deprecationEffective, successors: m.successorCodes });
      }
      return out;
    },
  };
}
