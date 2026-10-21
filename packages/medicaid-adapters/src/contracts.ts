// @chartwarden/medicaid-adapters — M24 canonical shared DOMAIN VALUE TYPES (id aliases, pgEnum-mirroring
// unions, the aggregate snapshot DTOs the validation rules read). Mirrors the @chartwarden/billing M23
// `contracts.ts` precedent. PURE DOMAIN: types/constants only — no Fastify, Drizzle, BullMQ, clock, PHI.
//
// Scalar id/date aliases are re-exported from @chartwarden/billing so M23 and M24 share ONE definition; the
// MBI-equivalent state Medicaid Recipient ID is NEVER a field here (D12/§3.6 — only masked/format-flag facts).
import type {
  Cents,
  IsoDate,
  IsoDateTime,
  OrgId,
  PatientId,
  ProviderEntityId,
} from "@chartwarden/billing";

export type { Cents, IsoDate, IsoDateTime, OrgId, PatientId, ProviderEntityId };

// ── M24 id aliases ───────────────────────────────────────────────────────────────────────────────────
export type MedicaidClaimId = string;
export type MedicaidClaimLineId = string;
export type RbArrangementId = string;
export type RbDayId = string;
export type MedicaidEligibilityCheckId = string;
export type MedicareClaimId = string; // M23 claim id (logical, COB)
export type McoId = string; // M40 state_medicaid_mco id
export type StateRateScheduleId = string; // M40 logical
/** Two-letter US state code (the per-claim adapter routing key, §1.1). */
export type StateCode = string;

// ── enum-mirroring unions (mirror the §3.3 m24_ pgEnums) ───────────────────────────────────────────────

/** `m24_claim_state` — the 18-state §2.2 lifecycle. */
export type MedicaidClaimState =
  | "DRAFT"
  | "VALIDATING"
  | "FAILED_VALIDATION"
  | "READY"
  | "AWAITING_MEDICARE_PRIMARY"
  | "FAILED_MEDICARE_PRIMARY"
  | "SUBMITTED"
  | "POLLING"
  | "ACK_PENDING"
  | "ACK_TIMEOUT"
  | "ACK_ACCEPTED"
  | "ACK_REJECTED"
  | "ACK_PARTIAL"
  | "PAID"
  | "DENIED"
  | "REPLACED"
  | "VOIDED"
  | "ABANDONED";

export const MEDICAID_CLAIM_STATES: readonly MedicaidClaimState[] = [
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
] as const;

export type MedicaidClaimKind = "combined_hospice_rb" | "hospice_only" | "rb_only";

/** `m24_claim_line_loc` — Medicaid hospice LOC including the NF Room & Board line. */
export type MedicaidLevelOfCare = "RHC" | "CHC" | "IRC" | "GIP" | "NF_RB";
export const MEDICAID_LOCS: readonly MedicaidLevelOfCare[] = [
  "RHC",
  "CHC",
  "IRC",
  "GIP",
  "NF_RB",
] as const;

export type MedicaidTob = "811" | "812" | "813" | "814" | "817" | "818";

export type MedicaidEligibilityOutcome =
  | "active"
  | "inactive"
  | "unknown"
  | "mco_assignment"
  | "error";

export type RbArrangementState = "DRAFT" | "ACTIVE" | "EXPIRED" | "TERMINATED" | "SUPERSEDED";

export type RbDayStatus = "pending" | "billable" | "excluded" | "voided" | "billed";

export type MedicaidChannel =
  | "direct_mmis"
  | "cco_clearinghouse"
  | "sftp"
  | "portal"
  | "state_proprietary";

export type MedicaidSubmissionResult =
  | "pending"
  | "accepted_sync"
  | "pending_async"
  | "rejected_sync"
  | "transport_failure"
  | "timeout"
  | "cancelled";

/** M18 EVV bracket state (reused vocabulary; D9). `unresolved_missing` always blocks. */
export type EvvBracketState =
  | "compliant"
  | "not_required"
  | "documented_missing"
  | "unresolved_missing";
