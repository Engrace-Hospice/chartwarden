// apps/web/src/modules/07-care-plan — shared status→tone mapping for the M7 Care Plan screens.
// §6.6 badge taxonomy: care-plan lifecycle statuses (plan / version / problem / goal / intervention /
// proposal / application) map to a StatusPill tone. The server owns every status; the UI only chooses a
// tone. Unknown values fall back to neutral. Imported by care-plan-view + version-history so the mapping
// never diverges. Every value of the M7 status enums in packages/db/src/enums.ts has an explicit entry
// (care-plan-status.test.ts reads the enum source and fails when one is missing).
import type { StatusTone } from "@chartwarden/ui";

export const STATUS_TONE: Readonly<Record<string, StatusTone>> = {
  // care_plan_status
  draft: "neutral",
  active: "success",
  discharged: "neutral",
  // care_plan_version_status — a version out for signature is NOT an idle draft.
  in_review: "progress",
  signed: "success",
  superseded: "neutral",
  // care_plan_idg_proposal_status / care_plan_idg_proposed_change_status
  proposed: "progress",
  applied: "success",
  conflict: "warning",
  // problem_status
  resolved: "neutral",
  inactive: "neutral",
  // problem_proposal_status
  pending: "progress",
  accepted: "success",
  dismissed: "neutral",
  // goal_status
  not_started: "neutral",
  in_progress: "progress",
  met: "success",
  not_met: "warning",
  revised: "progress",
  discontinued: "neutral",
  // intervention_status
  completed: "success",
};

export const toneFor = (s: string): StatusTone => STATUS_TONE[s] ?? "neutral";

export const cap = (s: string): string =>
  s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

/**
 * The server refuses to change a goal that is met, not met or discontinued, and an intervention that is not
 * `active` (routes/element-transitions.ts), so those rows get no Edit control: it could only end in a 409.
 */
export const isGoalEditable = (status: string): boolean =>
  status !== "met" && status !== "not_met" && status !== "discontinued";
export const isInterventionEditable = (status: string): boolean => status === "active";

/** The version-history page of a plan. The patient rides in the link (encoded) so the page can show their banner; the page checks the plan is theirs. */
export const versionHistoryPath = (plan: {
  readonly id: string;
  readonly patientId: string;
}): string => `/care-plans/${plan.id}/versions?patientId=${encodeURIComponent(plan.patientId)}`;
