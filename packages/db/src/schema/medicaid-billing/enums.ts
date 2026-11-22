// @chartwarden/db — M24 Billing — Medicaid: shared pgEnum declarations (spec §3.3). The enums live in this
// single home so the fan-out table files import them without ever redeclaring a pgEnum (check-ddl-legality
// rule 3). Filename intentionally avoids the substring "schema" (table-ownership/tenancy heuristic gotcha).
//
// CONVENTIONS (mirror @chartwarden/db billing M23 / remittance M25 / cap M26 / cost-report M27 — the proven
// precedent): every DB ENUM type name is `m24_`-prefixed so it can never collide with another module's enum;
// the exported Drizzle const is camelCase `m24X`. Spec §3.3 wrote bare names (medicaid_claim_state, …); the
// `m24_` prefix is the repo-wide anti-collision posture and supersedes the spec's bare names (convention wins).
import { pgEnum } from "drizzle-orm/pg-core";

// medicaid_claim lifecycle (§2.2) — the M23-mirrored state machine plus the dual-eligible holding states.
export const m24ClaimState = pgEnum("m24_claim_state", [
  "DRAFT",
  "VALIDATING",
  "FAILED_VALIDATION",
  "READY",
  "AWAITING_MEDICARE_PRIMARY",
  "FAILED_MEDICARE_PRIMARY",
  "SUBMITTED",
  "POLLING",
  "ACK_PENDING",
  "ACK_TIMEOUT",
  "ACK_ACCEPTED",
  "ACK_REJECTED",
  "ACK_PARTIAL",
  "PAID",
  "DENIED",
  "REPLACED",
  "VOIDED",
  "ABANDONED",
]);

export const m24ClaimKind = pgEnum("m24_claim_kind", [
  "combined_hospice_rb", // combined line-family kind; state-specific claim-format support is a separate decision
  "hospice_only", // hospice-only claim (no NF residence)
  "rb_only", // R&B-only on a separate claim (some states' path)
]);

export const m24ClaimLineLoc = pgEnum("m24_claim_line_loc", ["RHC", "CHC", "IRC", "GIP", "NF_RB"]);

export const m24SubmissionResult = pgEnum("m24_submission_result", [
  "pending",
  "accepted_sync",
  "pending_async",
  "rejected_sync",
  "transport_failure",
  "timeout",
  "cancelled",
]);

export const m24AcknowledgmentKind = pgEnum("m24_acknowledgment_kind", [
  "sync_999", // X12 999 (functional ack — file syntax)
  "sync_277ca", // X12 277CA (claim-level ack)
  "async_state_specific", // proprietary state ack file
]);

export const m24AcknowledgmentOutcome = pgEnum("m24_acknowledgment_outcome", [
  "accepted",
  "rejected",
  "partial",
]);

export const m24ValidationOutcome = pgEnum("m24_validation_outcome", [
  "pass",
  "fail",
  "warn",
  "info",
  "skip_not_applicable",
]);

export const m24EligibilityOutcome = pgEnum("m24_eligibility_outcome", [
  "active",
  "inactive",
  "unknown",
  "mco_assignment",
  "error",
]);

// Oregon payer identity is an explicit, effective-dated fact. Null on historical claims is
// intentionally not backfilled: it remains distinguishable from verified FFS/Open Card.
export const m24MedicaidProgramKind = pgEnum("m24_medicaid_program_kind", [
  "ffs_open_card",
  "managed_care",
  "other_managed_care",
  "unsupported",
  "unresolved",
  "ambiguous",
]);
export const m24ProgramAssignmentStatus = pgEnum("m24_program_assignment_status", [
  "candidate",
  "pending",
  "verified",
  "rejected",
  "revoked",
  "superseded",
]);
export const m24EnrollmentEvidenceKind = pgEnum("m24_enrollment_evidence_kind", [
  "state_medicaid_provider_enrollment",
  "mco_participation",
  "837i_enrollment",
  "835_era_enrollment",
  "clearinghouse_payer_route",
  "institutional_format_qualification",
  "payer_transport_certification",
  "production_activation_approval",
]);
export const m24EnrollmentEvidenceStatus = pgEnum("m24_enrollment_evidence_status", [
  "pending",
  "verified",
  "rejected",
  "expired",
  "revoked",
  "superseded",
]);
export const m24PayerAuthorizationEventKind = pgEnum("m24_payer_authorization_event_kind", [
  "clinical_document_available",
  "notification_prepared",
  "notification_sent",
  "receipt_acknowledged",
  "authorization_pending",
  "authorization_approved",
  "authorization_denied",
  "authorization_expired",
  "authorization_revoked",
  "unknown_unverified",
]);
export const m24PayerAuthorizationEvidenceStatus = pgEnum(
  "m24_payer_authorization_evidence_status",
  ["unverified", "verified", "rejected", "superseded"],
);

export const m24RbArrangementState = pgEnum("m24_rb_arrangement_state", [
  "DRAFT",
  "ACTIVE",
  "EXPIRED",
  "TERMINATED",
  "SUPERSEDED",
]);

export const m24RbDayStatus = pgEnum("m24_rb_day_status", [
  "pending",
  "billable",
  "excluded",
  "voided",
  "billed",
]);

export const m24Channel = pgEnum("m24_channel", [
  "direct_mmis",
  "cco_clearinghouse",
  "sftp",
  "portal",
  "state_proprietary",
]);
