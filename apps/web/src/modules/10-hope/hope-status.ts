// apps/web/src/modules/10-hope — shared HOPE presentation helpers (R1, Lantern).
// The HOPE schedule / assessment / SFV / submission / finding enums each map to the §6.6 badge
// taxonomy tone (grounded in the @wardenx/types unions) so every M10 surface renders the same
// StatusPill for a state.
import type { StatusTone } from "@wardenx/ui";

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

// HopeSubmissionStatus = queued | in_flight | accepted | rejected | partially_accepted.
export const SUBMISSION_TONE: Record<string, StatusTone> = {
  queued: "progress",
  in_flight: "progress",
  accepted: "success",
  rejected: "error",
  partially_accepted: "warning",
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
