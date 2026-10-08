// Pure helpers for CodeSearchInput: the system catalogue, code normalisation and result ranking.
// Kept free of React so the rules are unit-testable and the component stays small.

/** The code systems M38 serves a search/validate route for (CPT is deliberately absent, D4). */
export type CodeSearchSystem =
  | "icd10cm"
  | "icd10pcs"
  | "snomed"
  | "loinc"
  | "rxnorm"
  | "ndc"
  | "hcpcs"
  | "cvx"
  | "revenue"
  | "carc"
  | "rarc";

/** Human name used in empty/unverified messages ("Not found in the ICD-10-CM catalog"). */
export const CODE_SYSTEM_LABEL: Readonly<Record<CodeSearchSystem, string>> = {
  icd10cm: "ICD-10-CM",
  icd10pcs: "ICD-10-PCS",
  snomed: "SNOMED CT",
  loinc: "LOINC",
  rxnorm: "RxNorm",
  ndc: "NDC",
  hcpcs: "HCPCS",
  cvx: "CVX",
  revenue: "revenue code",
  carc: "CARC",
  rarc: "RARC",
};

/** Systems whose codes are case-insensitive letters+digits and are stored upper-case. */
const UPPERCASE_SYSTEMS: ReadonlySet<CodeSearchSystem> = new Set([
  "icd10cm",
  "icd10pcs",
  "hcpcs",
  "carc",
  "rarc",
]);

/** A concept row as the search route returns it (only the fields the picker reads). */
export interface CodeSearchConcept {
  readonly code: string;
  readonly display: string;
  readonly status?: string;
}

/** Trim a typed code and apply the system's canonical case. */
export function normalizeCode(system: CodeSearchSystem, raw: string): string {
  const trimmed = raw.trim();
  return UPPERCASE_SYSTEMS.has(system) ? trimmed.toUpperCase() : trimmed;
}

/** The `code – display` label shown in the input and in each option. */
export function conceptLabel(code: string, display: string | undefined): string {
  return display ? `${code} – ${display}` : code;
}

function rank(needle: string, concept: CodeSearchConcept): number {
  const code = concept.code.toLowerCase();
  const display = concept.display.toLowerCase();
  if (code === needle) return 0;
  if (code.startsWith(needle)) return 1;
  if (display.startsWith(needle)) return 2;
  if (code.includes(needle)) return 3;
  return 4;
}

/**
 * The server returns substring matches in storage order. Put the exact code first, then code prefixes,
 * then display prefixes, then the rest (stable within a rank, then by code), and drop rows with no code.
 */
export function rankConcepts(
  query: string,
  concepts: readonly CodeSearchConcept[],
): CodeSearchConcept[] {
  const needle = query.trim().toLowerCase();
  return concepts
    .filter((c) => Boolean(c.code))
    .map((concept, index) => ({ concept, index, score: rank(needle, concept) }))
    .sort(
      (a, b) =>
        a.score - b.score ||
        (a.score <= 1 ? a.concept.code.localeCompare(b.concept.code) : a.index - b.index),
    )
    .map((entry) => entry.concept);
}
