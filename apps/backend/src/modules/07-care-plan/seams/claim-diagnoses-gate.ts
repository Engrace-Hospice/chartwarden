// apps/backend/src/modules/07-care-plan/seams/claim-diagnoses-gate.ts — F-214 (#251): the 42 CFR Part 2 consent
// gate on the claim-diagnosis read. PURE (no I/O) so the gate logic is unit-testable apart from Postgres.
//
// A `problem.sud_related = true` diagnosis is Part 2-protected. Putting its ICD-10 code on a Medicare claim is a
// disclosure to an external party (the MAC / CMS), so the code is included ONLY when a valid Part 2 release is
// on file (decided by M39's ConsentEvaluator — see `part2BillingDisclosureAllowed` in drizzle-store.ts).
// Otherwise the code is WITHHELD: it never enters the returned sequence, and the result carries a non-PHI
// summary (a count + a terminal flag — never a code, never a description) so the M23 rule layer can hold the
// claim instead of letting it go out silently short of a diagnosis.

/** One candidate problem row, already ordered terminal -> related -> unrelated -> created_at -> id. */
export interface ClaimDiagnosisCandidate {
  readonly code: string;
  readonly kind: "terminal" | "related" | "unrelated";
  readonly sudRelated: boolean;
}

/** One claim diagnosis position: code + relationship ONLY — never the free-text description. */
export interface ClaimDiagnosisRecord {
  /** 1..12 — the X12 diagnosis-pointer position. */
  readonly position: number;
  readonly code: string;
  readonly relationship: "terminal" | "related" | "unrelated";
}

/** The claim-diagnosis read result: the releasable sequence plus the non-PHI withholding summary. */
export interface ClaimDiagnosisResult {
  readonly sequence: readonly ClaimDiagnosisRecord[];
  /** Distinct codes withheld because they are Part 2 (`sud_related`) and no valid release covers billing.
   *  A COUNT only — never the codes. */
  readonly withheldForConsentCount: number;
  /** True when the withheld set included the terminal (principal) diagnosis. */
  readonly terminalWithheldForConsent: boolean;
}

/** The X12 837 diagnosis-pointer ceiling — a claim carries at most 12 diagnoses. */
export const CLAIM_DIAGNOSIS_MAX = 12;

/** Does any candidate need the consent decision at all? (Skips the consent round-trip otherwise.) */
export function needsPart2Decision(rows: readonly ClaimDiagnosisCandidate[]): boolean {
  return rows.some((r) => r.sudRelated);
}

/**
 * Apply the gate + rank. `part2Allowed` is the consent verdict (FAIL-CLOSED upstream: any error/unbound
 * evaluator arrives here as `false`). When not allowed, a code is withheld if ANY active row carrying that
 * code is `sud_related` — a same-code non-SUD twin must not smuggle the protected code out. Positions are
 * assigned AFTER withholding (contiguous 1..n) and the cap applies after it. A withheld terminal is NOT
 * replaced: the next diagnosis keeps its own `related`/`unrelated` relationship, so `icd10_sequencing` (which
 * requires position 1 to be `terminal`) fails rather than a related condition being promoted to principal.
 */
export function applyPart2ClaimGate(
  rows: readonly ClaimDiagnosisCandidate[],
  part2Allowed: boolean,
): ClaimDiagnosisResult {
  const withheldCodes = new Set<string>();
  let terminalWithheld = false;
  if (!part2Allowed) {
    for (const r of rows) if (r.sudRelated) withheldCodes.add(r.code);
    for (const r of rows) {
      if (r.kind === "terminal" && withheldCodes.has(r.code)) terminalWithheld = true;
    }
  }
  const seen = new Set<string>();
  const sequence: ClaimDiagnosisRecord[] = [];
  for (const r of rows) {
    if (r.code === "" || withheldCodes.has(r.code) || seen.has(r.code)) continue;
    seen.add(r.code);
    sequence.push({ position: sequence.length + 1, code: r.code, relationship: r.kind });
    if (sequence.length === CLAIM_DIAGNOSIS_MAX) break;
  }
  return {
    sequence,
    withheldForConsentCount: withheldCodes.size,
    terminalWithheldForConsent: terminalWithheld,
  };
}
