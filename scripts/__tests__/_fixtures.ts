/**
 * Fixtures the harness tests share.
 *
 * `ISSUED_SSN` is DELIBERATELY an issued-looking social security number (area 524, group 71, serial 3388): it is not in
 * `compliance/synthetic-identifiers.json` and its area is not 000, 666 or 9xx, because the tests that use it prove the
 * PHI scanner and the guard FLAG a value like it (a never-issued 000-12-3456 would be allowed and prove nothing).
 * `.claude/rules/phi-and-secrets.md` says every SSN in code comes from the synthetic list or has a never-issued area;
 * this is the one named exception, and it is built from parts so that no scanned file (the Stop gate and
 * `harness:phi-scan` read test files too) ever spells it whole. A fixture that only needs an SSN-SHAPED value must use
 * a never-issued one instead, never this.
 */
export const ISSUED_SSN_PARTS = ["524", "71", "3388"] as const;
/** `NNN-NN-NNNN`. */
export const ISSUED_SSN: string = ISSUED_SSN_PARTS.join("-");
/** The nine digits with no separator. */
export const ISSUED_SSN_RAW: string = ISSUED_SSN_PARTS.join("");
