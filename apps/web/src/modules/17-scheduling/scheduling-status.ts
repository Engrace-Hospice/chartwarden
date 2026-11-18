// apps/web/src/modules/17-scheduling — shared scheduling presentation helpers (R1, Lantern).
// The §2.2.1 visit, §2.2.4 proposal, §2.2.3 recurring, and §2.2.6 time-off enums each map to the §6.6
// badge taxonomy tone (grounded in the @chartwarden/types unions) so every M17 surface renders the same
// StatusPill for a state.
import { VISIT_PURPOSE_LABELS, type VisitPurpose, visitPurposeLabel } from "@chartwarden/types";
import type { StatusTone } from "@chartwarden/ui";

// VisitStatus = proposed | published | en_route | in_visit | completed | no_show | cancelled | rescheduled.
export const VISIT_TONE: Record<string, StatusTone> = {
  proposed: "neutral",
  published: "progress",
  en_route: "progress",
  in_visit: "success",
  completed: "success",
  no_show: "error",
  cancelled: "neutral",
  rescheduled: "neutral",
};

// VisitProposalStatus = pending | published | dismissed | stale.
export const PROPOSAL_TONE: Record<string, StatusTone> = {
  pending: "progress",
  published: "success",
  dismissed: "neutral",
  stale: "warning",
};

// RecurringVisitStatus = active | discontinued.
export const RECURRING_TONE: Record<string, StatusTone> = {
  active: "success",
  discontinued: "neutral",
};

// TimeOffState = requested | approved | denied | cancelled | consumed.
export const TIMEOFF_TONE: Record<string, StatusTone> = {
  requested: "progress",
  approved: "success",
  denied: "error",
  cancelled: "neutral",
  consumed: "neutral",
};

/** Title-case an underscore enum value, e.g. `en_route` → `En Route`. */
export function stateLabel(s: string): string {
  if (s === "huv1") return "HUV1";
  if (s === "huv2") return "HUV2";
  if (s === "sfv") return "SFV";
  return s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * The discipline that usually performs each visit purpose (the fallback color when the assigned
 * clinician's credential is not readable). It mirrors the first discipline listed for each purpose in
 * `VISIT_PURPOSE_DISCIPLINES` (packages/scheduling/src/policy.ts), which is the authority; the
 * `scheduling-status` test fails if the two drift. `recert` and `loc_change` are RN visits and `f2f` is the
 * physician/NP encounter.
 */
const USUAL_DISCIPLINE: Readonly<Record<VisitPurpose, string>> = {
  routine_visit: "rn",
  prn: "rn",
  aide_poc: "chha",
  msw_assessment: "msw",
  msw_followup: "msw",
  chaplain_visit: "chaplain",
  chaplain_assessment: "chaplain",
  volunteer_visit: "volunteer",
  f2f: "md",
  recert: "rn",
  loc_change: "rn",
  pronouncement: "rn",
  admission_visit: "rn",
  discharge_visit: "rn",
  huv1: "rn",
  huv2: "rn",
  sfv: "rn",
};

/** Visit purpose → display label (the shared `VISIT_PURPOSE_LABELS`) and its usual discipline. */
export const PURPOSES: Record<string, { label: string; discipline: string }> = Object.fromEntries(
  (Object.keys(USUAL_DISCIPLINE) as VisitPurpose[]).map((purpose) => [
    purpose,
    { label: VISIT_PURPOSE_LABELS[purpose], discipline: USUAL_DISCIPLINE[purpose] },
  ]),
);

/** The label every scheduling surface shows for a visit purpose, so the picker and the calendar agree. */
export const purposeLabel = (p: string): string => visitPurposeLabel(p) ?? stateLabel(p);
