// @chartwarden/types — M41 Billing — Commercial: claim assembly and validation closed sets (issue #722, migration 1261).
// The database holds these as text + CHECK (the M25 precedent, no pgEnum); this file is the code-side mirror and
// `commercial-claim.test.ts` fails if the two drift.

/** Commercial claim lifecycle owned by this slice. `submitted` and later states arrive with the submission slice. */
export const COMMERCIAL_CLAIM_STATE_VALUES = ["draft", "ready", "void"] as const;
export type CommercialClaimState = (typeof COMMERCIAL_CLAIM_STATE_VALUES)[number];

export const COMMERCIAL_AUTHORIZATION_STATUS_VALUES = ["approved", "denied", "voided"] as const;
export type CommercialAuthorizationStatus = (typeof COMMERCIAL_AUTHORIZATION_STATUS_VALUES)[number];

/** Who pays after the commercial primary. Medicare Advantage is never here: its hospice claim goes to the MAC (ADR-0100 D7). */
export const COMMERCIAL_SECONDARY_PAYER_KIND_VALUES = ["medicare", "medicaid"] as const;
export type CommercialSecondaryPayerKind = (typeof COMMERCIAL_SECONDARY_PAYER_KIND_VALUES)[number];

export const COMMERCIAL_VALIDATION_TRIGGER_VALUES = [
  "initial_assembly",
  "manual_re_run",
  "ready_check",
] as const;
export type CommercialValidationTrigger = (typeof COMMERCIAL_VALIDATION_TRIGGER_VALUES)[number];

export const COMMERCIAL_VALIDATION_SEVERITY_VALUES = ["error", "warn", "info"] as const;
export type CommercialValidationSeverity = (typeof COMMERCIAL_VALIDATION_SEVERITY_VALUES)[number];

export const COMMERCIAL_VALIDATION_OUTCOME_VALUES = ["pass", "fail", "info"] as const;
export type CommercialValidationOutcome = (typeof COMMERCIAL_VALIDATION_OUTCOME_VALUES)[number];

/** The override reason floor (mirrors the M23 validation override and the `commercial_validation_override` CHECK). */
export const COMMERCIAL_OVERRIDE_REASON_MIN_LENGTH = 40;

/** Stable error codes the commercial lane returns (`ChartWardenError.code`). */
export const COMMERCIAL_ERROR_CODES = {
  /** The patient's primary coverage on the window is not a commercial plan (M23 / M24 / not recorded). */
  nonCommercialPrimary: "NON_COMMERCIAL_PRIMARY_PAYER",
  planNotFound: "COMMERCIAL_PLAN_NOT_FOUND",
  claimBlocked: "COMMERCIAL_CLAIM_BLOCKED",
} as const;
