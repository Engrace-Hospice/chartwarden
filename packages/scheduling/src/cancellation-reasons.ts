// @chartwarden/scheduling — the §3.2 Phase-D platform-default cancellation-reason value set (M17-T01).
//
// The tenant-extensible reason value set seeded at migration Phase D. The `reasonCode` on a cancel/
// reschedule carries one of these (or a tenant-defined extension); the free-text `reason ≥ 20 chars`
// captures the narrative. M38 backs the live value set; this is the platform floor every tenant inherits.

/** The §3.2 Phase-D platform-default visit-cancellation reason codes. */
export const PLATFORM_CANCELLATION_REASONS = [
  "patient_unavailable",
  "caregiver_request",
  "clinical_status_change",
  "scheduler_error",
  "weather",
  "clinician_unavailable",
  "transportation_issue",
  "documentation_only",
  "other_with_reason",
] as const;

/** A platform-default cancellation reason code. */
export type PlatformCancellationReason = (typeof PLATFORM_CANCELLATION_REASONS)[number];

/** §2.2.1 — the minimum length (chars) of the free-text reason on a cancel / reschedule / no-show. */
export const MIN_VISIT_REASON_LENGTH = 20;
