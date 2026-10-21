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
  return s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
