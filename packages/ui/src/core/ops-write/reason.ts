// @chartwarden/ui core — the written reason a platform operator gives for a write, judged the way the server judges it.
//
// The reason is copied into the tenant-visible audit trail, so the server collapses whitespace (line breaks and tabs included) to one
// space and removes control and format characters (`\p{C}`: NUL, zero-width, bidi overrides) BEFORE it counts. A reason of "abcd    "
// is a 422 there, not an audit row. The form counts the same way, or it lets through what the server refuses.
// The server stays the authority (it also screens for patient identifiers and answers EVIDENCE_LOOKS_LIKE_PHI); this only saves a
// round trip for the common mistake.

export interface ReasonRule {
  readonly min: number;
  readonly max: number;
}

/** The bounds each kind of platform write enforces (route schema and service agree). */
export const REASON_RULES = {
  /** Attest, re-open, approve or revoke go-live (the wizard routes). */
  decision: { min: 8, max: 1000 },
  /** Assigning the compliance officer. */
  officer: { min: 8, max: 500 },
  /** Entering a tenant's onboarding data on its behalf (provider entity, location, credential, clearinghouse). */
  onboardingData: { min: 8, max: 500 },
  /** Skipping a step. */
  skip: { min: 8, max: 2000 },
  /** Pricing writes (sign a contract, change the billing service). */
  pricing: { min: 1, max: 2000 },
} as const satisfies Record<string, ReasonRule>;

/** Whitespace runs become one space, control and format characters go, the ends are trimmed. Whitespace first, so "a\nb" never fuses. */
export function normalizeReason(raw: string): string {
  return raw
    .replace(/\s+/gu, " ")
    .replace(/\p{C}+/gu, "")
    .replace(/ {2,}/gu, " ")
    .trim();
}

/** The operator-readable problem with `raw` under `rule`, or null when it is acceptable. */
export function checkReason(raw: string, rule: ReasonRule): string | null {
  const length = normalizeReason(raw).length;
  if (length < rule.min) {
    return rule.min === 1
      ? "Enter a reason."
      : `Enter a reason of at least ${rule.min} characters (spaces and invisible characters do not count).`;
  }
  if (length > rule.max) return `Shorten the reason to at most ${rule.max} characters.`;
  return null;
}
