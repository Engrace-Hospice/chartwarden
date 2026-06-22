import { type TransitionResult, result } from "./effects";
// apps/backend/src/modules/07-care-plan/lifecycle/elements.ts — M7-T03 (§2.2.3).
//
// The three care-plan element lifecycles (problem / goal / intervention) as pure transition machines.
// These are the MUTABLE rows of the hybrid-versioning model (§2.1) — clinicians edit them over the
// admission; each signed version snapshots their state. Terminal statuses are retained so historical
// signed snapshots still resolve referentially (§2.2.3). A patient/family/agent-stated goal that is
// `revised` keeps its `original_text` verbatim (the new text goes to `revised_text`, D6 — enforced by
// `./validation`). Each transition emits the matching `m7.{problem,goal,intervention}.*` outbox event.
import { CarePlanStateError, require_ } from "./errors";

// ── Problem (§2.2.3) ────────────────────────────────────────────────────────────────────────────────

/** The §2.2.3 problem states (mirrors `problem_status`). */
export type ProblemLifecycleState = "active" | "resolved" | "inactive";

/** The §2.2.3 problem events. */
export type ProblemEvent =
  | { readonly type: "resolve"; readonly resolutionNote: string }
  | { readonly type: "deactivate" };

export type ProblemTransition = TransitionResult<ProblemLifecycleState, ProblemEvent["type"]>;

/** The legal §2.2.3 problem transition graph. */
export const PROBLEM_GRAPH: Readonly<
  Record<ProblemLifecycleState, ReadonlyArray<ProblemEvent["type"]>>
> = {
  active: ["resolve", "deactivate"],
  resolved: [],
  inactive: [],
};

/** Apply a problem event (§2.2.3). `resolve` requires a resolution note; both are terminal. */
export function transitionProblem(
  from: ProblemLifecycleState,
  event: ProblemEvent,
): ProblemTransition {
  if (!PROBLEM_GRAPH[from].includes(event.type)) {
    throw new CarePlanStateError(
      "ILLEGAL_TRANSITION",
      `problem cannot ${event.type} from '${from}'`,
    );
  }
  switch (event.type) {
    case "resolve": {
      require_(
        event.resolutionNote.trim().length >= 1,
        "RESOLUTION_NOTE_REQUIRED",
        "a resolution note is required to resolve a problem",
      );
      return result(from, event.type, "resolved", [
        { kind: "audit" },
        { kind: "outbox", event: "m7.problem.resolved" },
      ]);
    }
    case "deactivate": {
      return result(from, event.type, "inactive", [
        { kind: "audit" },
        { kind: "outbox", event: "m7.problem.updated" },
      ]);
    }
  }
}

// ── Goal (§2.2.3) ─────────────────────────────────────────────────────────────────────────────────────

/** The §2.2.3 goal states (mirrors `goal_status`). */
export type GoalLifecycleState =
  | "not_started"
  | "in_progress"
  | "met"
  | "not_met"
  | "revised"
  | "discontinued";

/** The §2.2.3 goal events. */
export type GoalEvent =
  | { readonly type: "start" }
  | { readonly type: "markMet" }
  | { readonly type: "markNotMet" }
  | { readonly type: "revise" }
  | { readonly type: "discontinue" }
  | { readonly type: "resumeRevised" };

export type GoalTransition = TransitionResult<GoalLifecycleState, GoalEvent["type"]>;

/** The legal §2.2.3 goal transition graph. */
export const GOAL_GRAPH: Readonly<Record<GoalLifecycleState, ReadonlyArray<GoalEvent["type"]>>> = {
  not_started: ["start"],
  in_progress: ["markMet", "markNotMet", "revise", "discontinue"],
  met: [],
  not_met: [],
  revised: ["resumeRevised"],
  discontinued: [],
};

/** Apply a goal event (§2.2.3). `revise` preserves `original_text` (D6); `met`/`not_met`/`discontinued` are terminal. */
export function transitionGoal(from: GoalLifecycleState, event: GoalEvent): GoalTransition {
  if (!GOAL_GRAPH[from].includes(event.type)) {
    throw new CarePlanStateError("ILLEGAL_TRANSITION", `goal cannot ${event.type} from '${from}'`);
  }
  switch (event.type) {
    case "start":
      return result(from, event.type, "in_progress", [
        { kind: "audit" },
        { kind: "outbox", event: "m7.goal.updated" },
      ]);
    case "markMet":
      return result(from, event.type, "met", [
        { kind: "audit" },
        { kind: "outbox", event: "m7.goal.met" },
      ]);
    case "markNotMet":
      return result(from, event.type, "not_met", [
        { kind: "audit" },
        { kind: "outbox", event: "m7.goal.updated" },
      ]);
    case "revise":
      // `revised_text` changes; `original_text` is preserved verbatim (checked in ./validation).
      return result(from, event.type, "revised", [
        { kind: "audit" },
        { kind: "outbox", event: "m7.goal.updated" },
      ]);
    case "resumeRevised":
      return result(from, event.type, "in_progress", [
        { kind: "audit" },
        { kind: "outbox", event: "m7.goal.updated" },
      ]);
    case "discontinue":
      return result(from, event.type, "discontinued", [
        { kind: "audit" },
        { kind: "outbox", event: "m7.goal.discontinued" },
      ]);
  }
}

// ── Intervention (§2.2.3) ───────────────────────────────────────────────────────────────────────────

/** The §2.2.3 intervention states (mirrors `intervention_status`). */
export type InterventionLifecycleState = "active" | "discontinued" | "completed";

/** The §2.2.3 intervention events. */
export type InterventionEvent =
  | { readonly type: "discontinue"; readonly reason: string }
  | { readonly type: "complete" };

export type InterventionTransition = TransitionResult<
  InterventionLifecycleState,
  InterventionEvent["type"]
>;

/** The legal §2.2.3 intervention transition graph. */
export const INTERVENTION_GRAPH: Readonly<
  Record<InterventionLifecycleState, ReadonlyArray<InterventionEvent["type"]>>
> = {
  active: ["discontinue", "complete"],
  discontinued: [],
  completed: [],
};

/** Apply an intervention event (§2.2.3). `discontinue` requires a reason; both targets are terminal. */
export function transitionIntervention(
  from: InterventionLifecycleState,
  event: InterventionEvent,
): InterventionTransition {
  if (!INTERVENTION_GRAPH[from].includes(event.type)) {
    throw new CarePlanStateError(
      "ILLEGAL_TRANSITION",
      `intervention cannot ${event.type} from '${from}'`,
    );
  }
  switch (event.type) {
    case "discontinue": {
      require_(
        event.reason.trim().length >= 1,
        "DISCONTINUE_REASON_REQUIRED",
        "a reason is required to discontinue an intervention",
      );
      return result(from, event.type, "discontinued", [
        { kind: "audit" },
        { kind: "outbox", event: "m7.intervention.discontinued" },
      ]);
    }
    case "complete": {
      return result(from, event.type, "completed", [
        { kind: "audit" },
        { kind: "outbox", event: "m7.intervention.updated" },
      ]);
    }
  }
}
