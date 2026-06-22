// @wardenx/hope — the M38 value-set membership port the pre-submission validator consumes (M10-T04;
// §3, deps:38). PURE interface. M10 depends on M38 (Clinical Terminology) for the HOPE value sets — the
// active hospice-terminal-diagnosis set (Section I) and the CMS HOPE J-code set (Section J). Those sets
// are survey-grade and historical: a surveyor's "was this code valid on the visit date?" must resolve
// against the value set AS OF the assessment's `target_date`, not today (M38 `asOfDate` lookups). Per
// ADR-0005 D1/D2 M10 reaches M38 ONLY through a boot-registered seam — never a direct schema import — so
// the engine here takes a SYNCHRONOUS oracle whose membership sets the T06 service pre-resolves from the
// M38 `TerminologyProvider` as of `target_date`, then hands in as data. This keeps the rule engine pure,
// deterministic, and unit-testable with a plain in-memory oracle.

/**
 * §3 — the M38-backed value-set membership the validator needs. The implementation (M10-T06) resolves
 * both sets via the M38 `TerminologyProvider` seam as of the assessment's `target_date` and adapts them
 * to this synchronous shape; the engine itself performs no IO.
 */
export interface HopeValueSetOracle {
  /** True when `icd10Code` is in M38's active `hospice_terminal_diagnosis` value set at target_date. */
  isHospiceTerminalDiagnosis(icd10Code: string): boolean;
  /** True when `jCode` is in M38's CMS HOPE J-code value set (`hope_j_codes`) at target_date. */
  isRecognizedHopeJCode(jCode: string): boolean;
}

/** Build a {@link HopeValueSetOracle} from two pre-resolved (as-of target_date) code sets. The T06
 * service constructs this from M38; tests construct it inline. Codes are compared case-insensitively and
 * whitespace-trimmed (ICD-10 / J-codes are uppercase canonical). */
export function valueSetOracle(sets: {
  readonly hospiceTerminalDiagnoses: Iterable<string>;
  readonly hopeJCodes: Iterable<string>;
}): HopeValueSetOracle {
  const norm = (c: string): string => c.trim().toUpperCase();
  const dx = new Set([...sets.hospiceTerminalDiagnoses].map(norm));
  const jc = new Set([...sets.hopeJCodes].map(norm));
  return {
    isHospiceTerminalDiagnosis: (code) => dx.has(norm(code)),
    isRecognizedHopeJCode: (code) => jc.has(norm(code)),
  };
}
