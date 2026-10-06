// apps/web/src/modules/06-admission — shared admission-domain status presentation helpers (R1, Lantern).
// The admission, referral, and compliance-window state enums each map to the §6.6 badge taxonomy tone
// so every M6 surface renders the same StatusPill for a given state.
import type { StatusTone } from "@wardenx/ui";

// Admission lifecycle (M6 §5.2) → tone. Real DB enum (packages/db/src/schema/admission/admissions.ts):
// referred, pending, notice_of_rights_acknowledged, active, on_hold, discharged, bereavement, closed.
export const ADMISSION_TONE: Record<string, StatusTone> = {
  referred: "progress",
  pending: "progress",
  notice_of_rights_acknowledged: "progress",
  active: "success",
  on_hold: "warning",
  discharged: "neutral",
  bereavement: "neutral",
  closed: "neutral",
};

/** States the admission state machine accepts `executeDischarge` from (state-machines/admission.ts). */
export const DISCHARGEABLE_STATES: ReadonlySet<string> = new Set(["active", "on_hold"]);

/**
 * Keys that let an actor use at least one path of the discharge workflow (`discharge-workflow.tsx`):
 * route 39's umbrella key plus each per-reason key the server derives, revocation and transfer-out.
 * Display gating only — the server is the enforcement point.
 */
export const DISCHARGE_WORKFLOW_PERMISSIONS: readonly string[] = [
  "discharge.create",
  "discharge.moved",
  "discharge.no_longer_terminal",
  "discharge.for_cause",
  "discharge.other",
  "revocation.create",
  "transfer.out",
];

export const REFERRAL_TONE: Record<string, StatusTone> = {
  received: "progress",
  under_review: "progress",
  pending_information: "warning",
  qualified: "success",
  declined: "error",
  duplicate: "warning",
  withdrawn: "neutral",
  converted: "success",
};

export const REFERRAL_LABEL: Record<string, string> = {
  received: "New",
  under_review: "Under review",
  pending_information: "Pending information",
  qualified: "Ready",
  declined: "Declined",
  duplicate: "Duplicate",
  withdrawn: "Withdrawn",
  converted: "Converted",
};

export const PATIENT_RESOLUTION_TONE: Record<string, StatusTone> = {
  unresolved: "warning",
  possible_match: "progress",
  matched: "success",
  created: "success",
};

export const PATIENT_RESOLUTION_LABEL: Record<string, string> = {
  unresolved: "Not resolved",
  possible_match: "Review match",
  matched: "Matched",
  created: "New patient",
};

export const PRIORITY_LABEL: Record<string, string> = {
  routine: "Routine",
  high: "High",
  urgent: "Urgent",
};

// Compliance-window state (M6 §5.2.11) → tone. Overdue is a deadline breach → error.
export const WINDOW_TONE: Record<string, StatusTone> = {
  open: "progress",
  overdue: "error",
  closed: "neutral",
};

/** Title-case an underscore enum value, e.g. `on_hold` → `On Hold`. */
export function stateLabel(s: string): string {
  return REFERRAL_LABEL[s] ?? s?.replace(/_/g, " ")?.replace(/\b\w/g, (c) => c.toUpperCase());
}
