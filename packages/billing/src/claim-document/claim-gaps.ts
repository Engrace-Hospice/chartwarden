// @wardenx/billing — the structured failure the claim-to-837I loader returns. A field with no source today is an
// explicit, typed gap (never an invented value). Gaps name the FIELD only, never its value (PHI).

export type ClaimGapReason =
  /** No source supplied a value. */
  | "missing"
  /** A value exists but the 837I cannot carry it. */
  | "invalid"
  /** Two sources disagree (e.g. the claim total vs the sum of its lines). */
  | "inconsistent";

export interface ClaimGap {
  /** A dotted field path, e.g. `lines[2].noncoveredCents` or `subscriber.address`. */
  readonly field: string;
  readonly reason: ClaimGapReason;
}

export type GapResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly gaps: readonly ClaimGap[] };

export const gap = (field: string, reason: ClaimGapReason): ClaimGap => ({ field, reason });
