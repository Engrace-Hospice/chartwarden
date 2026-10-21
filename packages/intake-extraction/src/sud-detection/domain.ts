// @chartwarden/intake-extraction — §1.1 / D8 the SUD-detection domain (42 CFR Part 2 §2.31).
//
// The DocLens classifier/extractor flag SUD-related content; M22 emits `m22.intake.sud_detected` which M5
// consumes to create an interim PrivacyFlag, and the SUD-flagged extraction is gated by
// `sud_consent_present` before commit can complete. T01 ships the suggested-SUD-kind taxonomy as DOMAIN
// data; the actual pattern flagger (`flagger.ts`) lands in a later M22 task. Leaf-import only.

/** §1.1 / D8 — the coarse SUD category surfaced on `m22.intake.sud_detected` (`suggestedSudKind`). */
export const SUD_SUGGESTED_KINDS = [
  "medication", // methadone / buprenorphine / naltrexone in a med list (§2.31)
  "diagnosis", // SUD diagnosis in an H&P
  "social_history", // substance-use history in social history
] as const;

/** One of the §1.1 suggested SUD categories. */
export type SudSuggestedKind = (typeof SUD_SUGGESTED_KINDS)[number];
