// apps/web/src/modules/07-care-plan/change-proposals — the plain-language words of the plan-of-care change proposals, in one place:
// kinds, statuses, dismissal reasons, the vocabularies of the proposal forms, and the sentence for every refusal the server can give.
import { type StatusTone, describeOpsError } from "@chartwarden/ui";
import {
  type Discipline,
  type DismissalReason,
  type GoalSource,
  type GoalStatus,
  MAX_PROPOSALS_PER_VISIT,
  type ProblemKind,
  type ProblemSource,
  type ProposalKind,
  type ProposalStatus,
} from "./proposal-types";

export const KIND_LABEL: Readonly<Record<ProposalKind, string>> = {
  problem_add: "Add problem",
  problem_resolve: "Resolve problem",
  goal_add: "Add goal",
  goal_update: "Update goal",
  intervention_add: "Add intervention",
  intervention_discontinue: "Discontinue intervention",
};

export const STATUS_LABEL: Readonly<Record<ProposalStatus, string>> = {
  draft: "Draft",
  pending: "Waiting for review",
  accepted: "Accepted",
  dismissed: "Dismissed",
  withdrawn: "Withdrawn",
};

export const STATUS_TONE: Readonly<Record<ProposalStatus, StatusTone>> = {
  draft: "neutral",
  pending: "progress",
  accepted: "success",
  dismissed: "neutral",
  withdrawn: "neutral",
};

export const DISMISSAL_REASON_LABEL: Readonly<Record<DismissalReason, string>> = {
  not_clinically_appropriate: "Not clinically appropriate",
  already_addressed: "Already addressed",
  duplicate: "Duplicate of another change",
  entered_in_error: "Entered in error",
  defer_to_idg: "Defer to the next IDG review",
};

export const PROBLEM_KIND_LABEL: Readonly<Record<ProblemKind, string>> = {
  terminal: "Terminal diagnosis",
  related: "Related to the terminal diagnosis",
  unrelated: "Unrelated to the terminal diagnosis",
};

export const PROBLEM_SOURCE_LABEL: Readonly<Record<ProblemSource, string>> = {
  clinical: "Clinical assessment",
  patient_reported: "Patient reported",
  family_reported: "Family reported",
  history: "Chart history",
};

export const GOAL_SOURCE_LABEL: Readonly<Record<GoalSource, string>> = {
  clinical: "Clinical",
  patient_stated: "Patient's own words",
  family_stated: "Family's own words",
};

export const GOAL_STATUS_LABEL: Readonly<Record<GoalStatus, string>> = {
  in_progress: "In progress",
  met: "Met",
  not_met: "Not met",
  revised: "Revised",
  discontinued: "Discontinued",
};

export const DISCIPLINE_LABEL: Readonly<Record<Discipline, string>> = {
  rn: "Registered nurse (RN)",
  lpn: "Licensed practical nurse (LPN)",
  chha: "Hospice aide (CHHA)",
  msw: "Social worker (MSW)",
  chaplain: "Chaplain",
  volunteer: "Volunteer",
  bereavement: "Bereavement counselor",
  md_np: "Physician or nurse practitioner",
  pt: "Physical therapist",
  ot: "Occupational therapist",
  st: "Speech therapist",
  music_therapy: "Music therapist",
  dietitian: "Dietitian",
};

/** `{ value, label }` options for a kit select, in the order the label table lists them. */
export function optionsOf<K extends string>(
  labels: Readonly<Record<K, string>>,
): { value: K; label: string }[] {
  return (Object.keys(labels) as K[]).map((value) => ({ value, label: labels[value] }));
}

/** Shown on the review list when the server withheld Part 2 proposals (`redacted: true`). */
export const REDACTED_COPY =
  "Restricted content omitted: some proposed changes are not shown to your role.";

/** The one sentence that says what a proposal is: used by the composer step and the review list. */
export const PROPOSE_THEN_REVIEW_COPY =
  "Proposed changes go to the case manager for review when this visit is finalized. They do not change the plan.";

const NOT_AVAILABLE_COPY =
  "That proposal is not available. It may have been withdrawn, or it is restricted from your role.";

/** What each server refusal means to the person who met it, and what to do next. A code here wins over the server's own sentence. */
const ERROR_COPY: Readonly<Record<string, string>> = {
  VERSION_IN_REVIEW:
    "A plan version is waiting for signatures, so the plan cannot change right now. This proposal stays pending: accept it once that version is signed or returned to draft.",
  DISCIPLINE_SCOPE_VIOLATION:
    "This change is outside your discipline. Ask a clinician in that discipline to accept it.",
  PROPOSAL_TARGET_UNAVAILABLE:
    "The part of the plan this change points at was removed or is already finished. Dismiss this proposal.",
  PROPOSAL_PARENT_NOT_ACCEPTED:
    "This goal or intervention belongs to a new problem that has not been accepted yet. Accept the problem first.",
  PROPOSAL_PARENT_DISMISSED:
    "The new problem this goal or intervention belongs to was dismissed, so it cannot be applied. Dismiss this proposal too.",
  CARE_PLAN_CLOSED: "This care plan is closed, so it cannot change.",
  PROPOSAL_NOT_PENDING:
    "Someone else already decided this proposed change. The list has been refreshed.",
  PROPOSAL_NOT_DRAFT:
    "This proposal has already gone to review, so it can no longer be edited or withdrawn.",
  PROPOSAL_HAS_DEPENDENTS:
    "Goals or interventions in this visit depend on this problem. Withdraw them first.",
  TOO_MANY_PROPOSALS: `This visit already has the most proposed changes allowed (${MAX_PROPOSALS_PER_VISIT}).`,
};

/** Codes after which the review list is stale and is read again (the proposal moved or vanished). */
export const STALE_LIST_CODES: ReadonlySet<string> = new Set(["PROPOSAL_NOT_PENDING"]);

/** The code of the platform error envelope (`{ error: { code } }`), or null. */
export function errorCodeOf(error: unknown): string | null {
  const code = (error as { error?: { code?: unknown } } | null | undefined)?.error?.code;
  return typeof code === "string" ? code : null;
}

/**
 * Turn a refusal into a sentence a clinician can act on. `status` is null when the request got no answer at all.
 * The idempotency refusals, a lost connection and every other class are worded by the kit (`describeOpsError`);
 * this only adds this feature's codes.
 */
export function proposalErrorMessage(
  error: unknown,
  status: number | null,
  notFoundCopy: string = NOT_AVAILABLE_COPY,
): string {
  if (status === 404) return notFoundCopy;
  return describeOpsError(error, status === null ? null : { status }, ERROR_COPY).message;
}

/** The words for a refused link between a visit and a plan element (the server accepts only elements relevant to the visit). */
export const LINK_NOT_ALLOWED_COPY =
  "This part of the plan cannot be linked to this visit. Only items that fit the visit type and discipline can be.";
export const LINK_NOT_FOUND_COPY = "That link no longer exists. The list has been refreshed.";

/** Shown over the composer's plan items when the server withheld Part 2 content from this caller. */
export const PLAN_REDACTED_COPY =
  "Restricted content omitted: some problems, goals or interventions are not shown to your role.";
