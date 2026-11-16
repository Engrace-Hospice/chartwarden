// apps/backend/src/modules/07-care-plan/routes/element-transitions.ts — the §2.2.3 element lifecycle
// machines (lifecycle/elements.ts) applied to every write path that changes a problem / goal /
// intervention row: the PATCH / resolve / discontinue routes (both services) and the IDG apply-at-quorum
// path. Resolved / inactive / met / not_met / discontinued / completed are TERMINAL — retained so a signed
// snapshot still resolves, never edited or re-opened. A terminal row refuses every write with
// 409 ILLEGAL_TRANSITION; a status move runs through the machine so an impossible jump (not_started → met,
// resolved → active) is refused the same way. Pure — no IO.
import {
  type GoalEvent,
  type GoalLifecycleState,
  type InterventionLifecycleState,
  PROBLEM_GRAPH,
  type ProblemLifecycleState,
  transitionGoal,
  transitionIntervention,
  transitionProblem,
} from "../lifecycle/elements";
import { CarePlanStateError } from "../lifecycle/errors";

const GOAL_STATES: ReadonlySet<string> = new Set([
  "not_started",
  "in_progress",
  "met",
  "not_met",
  "revised",
  "discontinued",
]);

const illegal = (message: string): CarePlanStateError =>
  new CarePlanStateError("ILLEGAL_TRANSITION", message);

/** A resolved/inactive problem is read-only history. */
export function assertProblemEditable(status: string): void {
  if (PROBLEM_GRAPH[status as ProblemLifecycleState]?.length === 0) {
    throw illegal(`problem is '${status}' (terminal) and cannot be changed`);
  }
}

/** The `resolve` transition (note required by the machine); refuses a row that is not `active`. */
export function resolveProblemStatus(from: string, resolutionNote: string): ProblemLifecycleState {
  return transitionProblem(from as ProblemLifecycleState, { type: "resolve", resolutionNote }).to;
}

/**
 * Validate a requested problem status (IDG `problem_update`): unchanged is a no-op, `resolved` /
 * `inactive` run the machine, anything else (re-opening to `active`) has no event and is refused.
 */
export function guardProblemStatusChange(
  from: string,
  to: string | undefined,
  resolutionNote: string,
): ProblemLifecycleState {
  assertProblemEditable(from);
  if (to === undefined || to === from) return from as ProblemLifecycleState;
  if (to === "resolved") return resolveProblemStatus(from, resolutionNote);
  if (to === "inactive")
    return transitionProblem(from as ProblemLifecycleState, { type: "deactivate" }).to;
  throw illegal(`problem cannot move from '${from}' to '${to}'`);
}

const isTerminalGoal = (status: string): boolean =>
  status === "met" || status === "not_met" || status === "discontinued";

/** A met / not_met / discontinued goal is read-only history. */
export function assertGoalEditable(status: string): void {
  if (isTerminalGoal(status)) throw illegal(`goal is '${status}' (terminal) and cannot be changed`);
}

function goalEventFor(from: string, to: string): GoalEvent["type"] | null {
  switch (to) {
    case "in_progress":
      return from === "revised" ? "resumeRevised" : "start";
    case "met":
      return "markMet";
    case "not_met":
      return "markNotMet";
    case "revised":
      return "revise";
    case "discontinued":
      return "discontinue";
    default:
      return null;
  }
}

/**
 * Validate a goal PATCH/IDG status move through the §2.2.3 graph. `to` undefined or unchanged is a
 * no-op (the web form re-sends the current status with a text edit); a terminal row refuses any write.
 */
export function guardGoalStatusChange(from: string, to: string | undefined): GoalLifecycleState {
  assertGoalEditable(from);
  if (to === undefined || to === from) return from as GoalLifecycleState;
  const event = to && GOAL_STATES.has(to) ? goalEventFor(from, to) : null;
  if (!event) throw illegal(`goal cannot move from '${from}' to '${to}'`);
  return transitionGoal(from as GoalLifecycleState, { type: event } as GoalEvent).to;
}

/** A discontinued/completed intervention is read-only history. */
export function assertInterventionEditable(status: string): void {
  if (status !== "active")
    throw illegal(`intervention is '${status}' (terminal) and cannot be changed`);
}

/** The `discontinue` transition (reason required by the machine); refuses a row that is not `active`. */
export function discontinueInterventionStatus(
  from: string,
  reason: string,
): InterventionLifecycleState {
  return transitionIntervention(from as InterventionLifecycleState, { type: "discontinue", reason })
    .to;
}
