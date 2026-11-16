// apps/web/src/modules/10-hope — shared HOPE presentation helpers (R1, Lantern).
// The HOPE schedule / assessment / SFV / submission / finding enums each map to the §6.6 badge
// taxonomy tone (grounded in the @chartwarden/types unions) so every M10 surface renders the same
// StatusPill for a state.
import type {
  HopeScheduleSkipReasonCode,
  HopeSubmissionCancelReasonCode,
} from "@chartwarden/types";
import type { StatusTone } from "@chartwarden/ui";

// HopeScheduleStatus = open | completed | expired | skipped.
export const SCHEDULE_TONE: Record<string, StatusTone> = {
  open: "progress",
  completed: "success",
  expired: "error",
  skipped: "neutral",
};

// The client-derived dashboard window bucket (UX cue; server owns the authoritative status).
export const BUCKET_TONE: Record<string, StatusTone> = {
  open: "progress",
  closing: "warning",
  late: "error",
  expired: "neutral",
};

// HopeAssessmentStatus = draft | signed | superseded.
export const ASSESSMENT_TONE: Record<string, StatusTone> = {
  draft: "progress",
  signed: "success",
  superseded: "neutral",
};

// HopeSfvStatus = open | completed | overdue | missed.
export const SFV_TONE: Record<string, StatusTone> = {
  open: "progress",
  completed: "success",
  overdue: "warning",
  missed: "error",
};

export const WORKFLOW_TONE: Record<string, StatusTone> = {
  upcoming: "neutral",
  open: "progress",
  late: "warning",
  completed: "success",
  expired: "error",
  skipped: "neutral",
  not_applicable: "neutral",
  workflow_not_initialized: "error",
  overdue: "warning",
  missed: "error",
};

export const ATTENTION_TONE: Record<string, StatusTone> = {
  none: "neutral",
  upcoming: "neutral",
  due_soon: "warning",
  due: "warning",
  overdue: "error",
  window_expired: "error",
  missed: "error",
  workflow_issue: "error",
};

// HopeSubmissionStatus = ready | queued | packaged | exported | in_flight | submitted_pending_result | accepted |
// rejected | partially_accepted | accepted_with_warnings | file_error | cancelled.
export const SUBMISSION_TONE: Record<string, StatusTone> = {
  ready: "progress",
  queued: "progress",
  packaged: "progress",
  exported: "progress",
  in_flight: "progress",
  submitted_pending_result: "warning",
  accepted: "success",
  accepted_with_warnings: "warning",
  rejected: "error",
  partially_accepted: "warning",
  file_error: "error",
  cancelled: "neutral", // a package retired before upload: nothing reached CMS, its records are packaged again
};

/**
 * R-08 — why a generated package that never reached CMS was cancelled. The keys are the server's CLOSED list
 * (`HOPE_SUBMISSION_CANCEL_REASON_CODES`): a reason is never free text, so no PHI can be typed into it, and a
 * missing label here is a compile error.
 */
export const CANCEL_REASON_LABEL: Record<HopeSubmissionCancelReasonCode, string> = {
  package_lost: "Package lost",
  never_uploaded: "Never uploaded to the CMS portal",
  generated_in_error: "Generated in error",
  other: "Other",
};

/**
 * Why a timepoint window was skipped, worded for the clinician choosing it. The keys are the server's CLOSED list
 * (`HOPE_SCHEDULE_SKIP_REASON_CODES`), so a code added there is a compile error here rather than a label made from its name.
 */
export const SKIP_REASON_LABEL: Record<HopeScheduleSkipReasonCode, string> = {
  patient_deceased: "Patient died",
  patient_revoked: "Patient revoked the hospice benefit",
  patient_hospitalized: "Patient was hospitalized",
  transferred_out: "Patient transferred out",
  admission_discharged: "Admission was discharged",
  duplicate_window: "Duplicate timepoint window",
  other: "Other reason",
};

// HopeValidationSeverity = error | warning.
export const SEVERITY_TONE: Record<string, StatusTone> = {
  error: "error",
  warning: "warning",
};

// J2051Severity = none | mild | moderate | severe (drives the SFV trigger).
export const J2051_TONE: Record<string, StatusTone> = {
  none: "neutral",
  mild: "neutral",
  moderate: "warning",
  severe: "error",
};

// The five Reasons-For-Assessment carry a `0N_` ordering prefix; show the friendly timepoint name.
const RFA_LABELS: Record<string, string> = {
  "01_admission": "Admission",
  "02_huv1": "HUV1",
  "03_huv2": "HUV2",
  "04_sfv": "SFV",
  "05_discharge": "Discharge",
};
export function rfaLabel(rfa: string): string {
  return RFA_LABELS[rfa] ?? stateLabel(rfa);
}

/** Title-case an underscore enum value, e.g. `partially_accepted` → `Partially Accepted`. */
export function stateLabel(s: string): string {
  return s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

export function attentionLabel(s: string): string {
  if (s === "none") return "No active attention";
  if (s === "due_soon") return "Due soon";
  if (s === "window_expired") return "Capture window expired";
  if (s === "workflow_issue") return "Workflow issue";
  return stateLabel(s);
}
