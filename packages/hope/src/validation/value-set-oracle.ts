// @chartwarden/hope — the M38 value-set membership port the pre-submission validator consumes (M10-T04;
// §3, deps:38). PURE interface. M10 depends on M38 (Clinical Terminology) for the HOPE value sets — the
// active hospice-terminal-diagnosis set (Section I) and the CMS HOPE J-code set (Section J). Those sets
// are survey-grade and historical: a surveyor's "was this code valid on the visit date?" must resolve
// against the value set AS OF the assessment's `target_date`, not today (M38 `asOfDate` lookups). Per
// ADR-0005 D1/D2 M10 reaches M38 ONLY through a boot-registered seam — never a direct schema import — so
// the engine here takes a SYNCHRONOUS oracle whose membership sets the T06 service pre-resolves from the
// M38 `TerminologyProvider` as of `target_date`, then hands in as data. This keeps the rule engine pure,
// deterministic, and unit-testable with a plain in-memory oracle.
//
// F-057 — `available` exists because "this code is not in the set" and "there is no set here" are
// different facts that a bare `boolean` collapses into one. M38 ships `hospice_terminal_diagnosis` and
// `hope_j_codes` as DEFINITIONS with no curated members (`PLATFORM_VALUE_SET_MEMBERS`' own header: the
// concept-data-dependent sets are populated once the per-system loaders have run), so on a deployment
// whose loaders have not run, every membership question answers `false`. Wiring the validator against
// that would have made rule 2 — an `error`, and therefore a submission blocker — fire on EVERY assessment
// carrying a terminal diagnosis, which is not a validation result but an outage. An unavailable set now
// yields a warning-severity `VALUE_SET_UNAVAILABLE` finding instead: the check that could not run says so
// in the record, the same shape as the D8 missing-PPS compensating finding one layer up.

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
  /**
   * Whether each value set could be resolved AT ALL as of target_date. `false` means M38 holds no
   * membership for that set in this deployment (loader not run / set not curated) — NOT that the codes
   * asked about are absent from it. The validator skips the corresponding membership rule and records
   * `VALUE_SET_UNAVAILABLE` instead of a false blocking error.
   */
  readonly available: HopeValueSetAvailability;
}

/** Per-set resolvability (see {@link HopeValueSetOracle.available}). */
export interface HopeValueSetAvailability {
  readonly hospiceTerminalDiagnosis: boolean;
  readonly hopeJCodes: boolean;
}

/** Build a {@link HopeValueSetOracle} from two pre-resolved (as-of target_date) code sets. The T06
 * service constructs this from M38; tests construct it inline. Codes are compared case-insensitively and
 * whitespace-trimmed (ICD-10 / J-codes are uppercase canonical). `available` defaults to "the set has at
 * least one member", which is the right reading for a caller that resolved membership by expansion; a
 * caller that probed membership code-by-code (and so cannot infer emptiness from what it asked about)
 * passes the flags explicitly. */
export function valueSetOracle(sets: {
  readonly hospiceTerminalDiagnoses: Iterable<string>;
  readonly hopeJCodes: Iterable<string>;
  readonly available?: HopeValueSetAvailability;
}): HopeValueSetOracle {
  const norm = (c: string): string => c.trim().toUpperCase();
  const dx = new Set([...sets.hospiceTerminalDiagnoses].map(norm));
  const jc = new Set([...sets.hopeJCodes].map(norm));
  return {
    isHospiceTerminalDiagnosis: (code) => dx.has(norm(code)),
    isRecognizedHopeJCode: (code) => jc.has(norm(code)),
    available: sets.available ?? {
      hospiceTerminalDiagnosis: dx.size > 0,
      hopeJCodes: jc.size > 0,
    },
  };
}
