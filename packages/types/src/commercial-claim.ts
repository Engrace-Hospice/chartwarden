// @chartwarden/types — M41 Billing — Commercial: claim assembly and validation closed sets (issue #722, migration 1261).
// The database holds these as text + CHECK (the M25 precedent, no pgEnum); this file is the code-side mirror and
// `commercial-claim.test.ts` fails if the two drift.

/**
 * Commercial claim lifecycle (spec section 2.1). `submitted` means the clearinghouse transport ACCEPTED the file (never "queued");
 * `accepted` is the PAYER stage only (ADR-0053 D2, ADR-0100 D9). `adjudicated`, `paid`, `denied` and `replaced` arrive with the
 * remittance slice (M25).
 */
export const COMMERCIAL_CLAIM_STATE_VALUES = [
  "draft",
  "ready",
  "submitted",
  "ack_pending",
  "accepted",
  "rejected",
  "void",
] as const;
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
  /** The send gate refused; the body carries every reason (code + fixed message). */
  sendRefused: "COMMERCIAL_SEND_REFUSED",
  /** The claim has a submission queued, in doubt or sent: it cannot be re-validated, re-readied, demoted or voided until that settles. */
  submissionInFlight: "COMMERCIAL_SUBMISSION_IN_FLIGHT",
  /** The facts the 837I is built from changed since the first attempt: this claim must be voided and assembled again. */
  payloadChanged: "COMMERCIAL_PAYLOAD_CHANGED",
  /** `not_received` was chosen but a receipt is on file for the submission (the transport accepted it): only `received` is open. */
  reconcileReceiptOnFile: "COMMERCIAL_RECONCILE_RECEIPT_ON_FILE",
  /** No drain is scheduled (the background schedule failed or Valkey is absent): a submission would be queued and never sent. */
  drainNotScheduled: "COMMERCIAL_DRAIN_NOT_SCHEDULED",
} as const;

/** Where a submission stands. `queued` has reached no transport; `sent` means the transport accepted it. */
export const COMMERCIAL_SUBMISSION_STATUS_VALUES = [
  "queued",
  "sent",
  "failed",
  "in_doubt",
] as const;
export type CommercialSubmissionStatus = (typeof COMMERCIAL_SUBMISSION_STATUS_VALUES)[number];

/** A queued submission is given up on (`failed`) after this many transport attempts. */
export const COMMERCIAL_SUBMISSION_MAX_ATTEMPTS = 5;
