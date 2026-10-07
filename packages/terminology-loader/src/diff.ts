// @wardenx/terminology-loader — stage-and-diff, the pure half (M38 §3.1 `stage-and-diff.ts`).
//
// The authoritative diff against the prior active version is computed by the database at `markStaged` /
// activation (set arithmetic over the staged rows and the prior version's concept rows — see migration 0364).
// What cannot be derived there is SUCCESSOR knowledge, which is system-specific and so lives here:
//   • ICD-10-CM — a code that was billable in the prior release and is a header (or gone) now maps to the new
//     billable codes that extend it ("narrower": pick the specific one); a code with no extension maps to none.
// Every other system's retirements are plain absences, which the database maps with kind `none` and a generic
// "no longer present — re-code from the documentation" guidance (a stated stance: no mapping is invented).
import { bare, dotted } from "./parsers/icd10cm-release";
import type { PriorConcept, StagedRow } from "./ports";
import type { DeprecationHint, LoadableSystemId, ParsedConcept } from "./types";

/** The deprecation hints for `next` relative to the prior version's current concepts. */
export function buildDeprecationHints(
  system: LoadableSystemId,
  prior: readonly PriorConcept[],
  next: readonly ParsedConcept[],
): DeprecationHint[] {
  if (system !== "icd10cm") return [];
  return icd10cmHints(prior, next);
}

function icd10cmHints(
  prior: readonly PriorConcept[],
  next: readonly ParsedConcept[],
): DeprecationHint[] {
  const nextByCode = new Map(next.map((c) => [c.code, c]));
  const nextBillable = next.filter((c) => c.properties.isBillableLeaf === true);
  const hints: DeprecationHint[] = [];
  for (const p of prior) {
    if (!p.isBillableLeaf) continue;
    const n = nextByCode.get(p.code);
    if (n?.properties.isBillableLeaf === true) continue; // still billable: not a deprecation
    const stem = bare(p.code);
    const successors = nextBillable
      .filter((c) => c.code !== p.code && bare(c.code).startsWith(stem))
      .map((c) => dotted(bare(c.code)));
    hints.push({
      code: p.code,
      successors,
      mappingKind: successors.length > 0 ? "narrower" : "none",
      guidance: n
        ? `${p.code} is a header from this release on; code to one of its ${successors.length} subcodes.`
        : `${p.code} was deleted; re-code from the documentation.`,
    });
  }
  return hints;
}

/** Project a hint into the staged-row shape (`kind = 'deprecation'`). */
export function hintToStagedRow(hint: DeprecationHint): StagedRow {
  return {
    code: hint.code,
    display: hint.code,
    status: "deprecated",
    effectiveDate: null,
    endDate: null,
    properties: {
      successors: hint.successors,
      mappingKind: hint.mappingKind,
      guidance: hint.guidance,
    },
  };
}

/** Project a parsed concept into the staged-row shape. */
export function conceptToStagedRow(c: ParsedConcept): StagedRow {
  return {
    code: c.code,
    display: c.display,
    status: c.status,
    effectiveDate: c.effectiveDate,
    endDate: c.endDate,
    properties: c.properties,
  };
}

/** Split `items` into chunks of at most `size` (bounded staging calls). */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
