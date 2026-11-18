// apps/web/src/modules/17-scheduling — shared scheduling presentation helpers (R1, Lantern).
// The §2.2.1 visit, §2.2.4 proposal, §2.2.3 recurring, and §2.2.6 time-off enums each map to the §6.6
// badge taxonomy tone (grounded in the @chartwarden/types unions) so every M17 surface renders the same
// StatusPill for a state.
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
 * Visit purpose → display label and the discipline that usually performs it (the fallback color when
 * the assigned clinician's credential is not readable). It mirrors the first discipline listed for each
 * purpose in `VISIT_PURPOSE_DISCIPLINES` (packages/scheduling/src/policy.ts), which is the authority:
 * `recert` and `loc_change` are RN visits and `f2f` is the physician/NP encounter. Keep the two in step.
 */
export const PURPOSES: Record<string, { label: string; discipline: string }> = {
  routine_visit: { label: "Routine Visit", discipline: "rn" },
  prn: { label: "PRN Visit", discipline: "rn" },
  aide_poc: { label: "HHA Visit", discipline: "chha" },
  msw_assessment: { label: "MSW Assessment", discipline: "msw" },
  msw_followup: { label: "MSW Follow-up", discipline: "msw" },
  chaplain_visit: { label: "Chaplain Visit", discipline: "chaplain" },
  chaplain_assessment: { label: "Chaplain Assessment", discipline: "chaplain" },
  volunteer_visit: { label: "Volunteer Visit", discipline: "volunteer" },
  f2f: { label: "Face-to-Face", discipline: "md" },
  recert: { label: "Recert Kickoff (RN)", discipline: "rn" },
  loc_change: { label: "LOC Change", discipline: "rn" },
  pronouncement: { label: "Pronouncement", discipline: "rn" },
  admission_visit: { label: "Admission Visit", discipline: "rn" },
  discharge_visit: { label: "Discharge Visit", discipline: "rn" },
  huv1: { label: "HUV1", discipline: "rn" },
  huv2: { label: "HUV2", discipline: "rn" },
  sfv: { label: "SFV", discipline: "rn" },
};

/** The label every scheduling surface shows for a visit purpose, so the picker and the calendar agree. */
export const purposeLabel = (p: string): string => PURPOSES[p]?.label ?? stateLabel(p);
