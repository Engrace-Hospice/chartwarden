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
  "combined_hospice_rb", // single 837I with hospice + R&B lines (Oregon path)
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
