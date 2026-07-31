// apps/backend/src/modules/15-discipline-care-plans/lifecycle/elements.ts — M15-T03 (§2.2.3).
//
// The three discipline-plan element lifecycles (goal / intervention / assessment) as pure transition
// machines. These are the MUTABLE rows of the hybrid-versioning model (§2.1): clinicians edit them across
// the admission and each finalized version seals their state into `state_snapshot`. Terminal statuses are
// retained so historical signed snapshots still resolve referentially.
//
//   • `discipline_goal` — `not_started → in_progress → {met, not_met, revised, discontinued}`. A
//     patient/family/agent-stated goal that is `revised` keeps its `original_text` VERBATIM; the new
//     wording goes to `revised_text` (§2.3, enforced by `./validation`).
//   • `discipline_intervention` — `active → {discontinued, completed}`; discontinuation requires a reason.
//   • `discipline_assessment` — `draft → signed → amended`, append-only correction-of-record mirroring
//     M9 D9: an amendment NEVER rewrites the signed row, it supersedes it with a new row carrying
//     `amends_assessment_id` + a reason, and emits `m15.discipline_assessment.amended` for M22/M30.
//
// A SIGNED INITIAL assessment is what closes the §1.1 D10 clock (`./initial-clock` owns that math): the
// signed transition therefore declares the `initial_assessment_signed_at` timestamp effect on the plan.
import type { DisciplineAssessmentKind, IsoInstant } from "@wardenx/types";
import { type TransitionResult, result } from "./effects";
import { DisciplinePlanStateError, require_ } from "./errors";
import { TEXT_MINIMUMS } from "./validation";

// ── discipline_goal (§2.2.3) ────────────────────────────────────────────────────────────────────────

/** The §2.2.3 goal states (mirrors `discipline_goal_status`). */
export type DisciplineGoalLifecycleState =
  | "not_started"
  | "in_progress"
  | "met"
  | "not_met"
  | "revised"
  | "discontinued";

/** The §2.2.3 goal events. */
export type DisciplineGoalEvent =
  | { readonly type: "start" }
  | { readonly type: "meet" }
  | { readonly type: "missTarget" }
  /** A revision — `original_text` is preserved; `revisedText` is the new wording (§2.3). */
  | { readonly type: "revise"; readonly revisedText: string }
  | { readonly type: "discontinue"; readonly reason: string };

export type DisciplineGoalTransition = TransitionResult<
  DisciplineGoalLifecycleState,
  DisciplineGoalEvent["type"]
>;

/** The legal §2.2.3 goal transition graph. `revised` re-opens for continued work; the rest are terminal. */
export const DISCIPLINE_GOAL_GRAPH: Readonly<
  Record<DisciplineGoalLifecycleState, ReadonlyArray<DisciplineGoalEvent["type"]>>
> = {
  not_started: ["start", "revise", "discontinue"],
  in_progress: ["meet", "missTarget", "revise", "discontinue"],
  met: [],
  not_met: ["revise", "discontinue"],
  revised: ["start", "meet", "missTarget", "discontinue"],
  discontinued: [],
};

/** Apply a `discipline_goal` event (§2.2.3). */
export function transitionDisciplineGoal(
  from: DisciplineGoalLifecycleState,
  event: DisciplineGoalEvent,
): DisciplineGoalTransition {
  if (!DISCIPLINE_GOAL_GRAPH[from].includes(event.type)) {
    throw new DisciplinePlanStateError(
      "ILLEGAL_TRANSITION",
      `discipline goal cannot ${event.type} from '${from}'`,
    );
  }
  switch (event.type) {
    case "start":
      return result(from, event.type, "in_progress", [{ kind: "audit" }]);
    case "meet":
      return result(from, event.type, "met", [{ kind: "audit" }]);
    case "missTarget":
      return result(from, event.type, "not_met", [{ kind: "audit" }]);
    case "revise": {
      require_(
        event.revisedText.trim().length >= 1,
        "GOAL_TEXT_IMMUTABLE",
        "a goal revision must supply revised_text (original_text is never overwritten)",
      );
      return result(from, event.type, "revised", [{ kind: "audit" }]);
    }
    case "discontinue": {
      require_(
        event.reason.trim().length >= TEXT_MINIMUMS.discontinueReason,
        "DISCONTINUE_REASON_REQUIRED",
        "a discontinued goal must carry a reason",
      );
      return result(from, event.type, "discontinued", [{ kind: "audit" }]);
    }
  }
}

// ── discipline_intervention (§2.2.3) ────────────────────────────────────────────────────────────────

/** The §2.2.3 intervention states (mirrors `discipline_intervention_status`). */
export type DisciplineInterventionLifecycleState = "active" | "discontinued" | "completed";

/** The §2.2.3 intervention events. */
export type DisciplineInterventionEvent =
  | { readonly type: "discontinue"; readonly reason: string }
  | { readonly type: "complete" };

export type DisciplineInterventionTransition = TransitionResult<
  DisciplineInterventionLifecycleState,
  DisciplineInterventionEvent["type"]
>;

/** The legal §2.2.3 intervention transition graph. */
export const DISCIPLINE_INTERVENTION_GRAPH: Readonly<
  Record<DisciplineInterventionLifecycleState, ReadonlyArray<DisciplineInterventionEvent["type"]>>
> = {
  active: ["discontinue", "complete"],
  discontinued: [],
  completed: [],
};

/** Apply a `discipline_intervention` event (§2.2.3). Discontinuation requires a reason. */
export function transitionDisciplineIntervention(
  from: DisciplineInterventionLifecycleState,
  event: DisciplineInterventionEvent,
): DisciplineInterventionTransition {
  if (!DISCIPLINE_INTERVENTION_GRAPH[from].includes(event.type)) {
    throw new DisciplinePlanStateError(
      "ILLEGAL_TRANSITION",
      `discipline intervention cannot ${event.type} from '${from}'`,
    );
  }
  switch (event.type) {
    case "discontinue": {
      require_(
        event.reason.trim().length >= TEXT_MINIMUMS.discontinueReason,
        "DISCONTINUE_REASON_REQUIRED",
        "a discontinued intervention must carry a reason",
      );
      return result(from, event.type, "discontinued", [{ kind: "audit" }]);
    }
    case "complete":
      return result(from, event.type, "completed", [{ kind: "audit" }]);
  }
}

// ── discipline_assessment (§2.2.3, §7.2, §7.3) ──────────────────────────────────────────────────────

/** The §2.2.3 assessment states (mirrors `discipline_assessment_status`). */
export type DisciplineAssessmentLifecycleState = "draft" | "signed" | "amended";

/** The §2.2.3 assessment events. */
export type DisciplineAssessmentEvent =
  | {
      /** Step-up-authenticated sign (M2 §2.6). A signed INITIAL assessment closes the D10 clock (§7.2). */
      readonly type: "sign";
      readonly at: IsoInstant;
      readonly isInitial: boolean;
      readonly kind: DisciplineAssessmentKind;
      /**
       * Whether the assessment's `source_encounter_id` resolved through M8's `SignedEncountersReader` to
       * a signed encounter on this patient (§2.3). `null` = no encounter referenced, which is legal.
       */
      readonly sourceEncounterValid: boolean | null;
    }
  | {
      /** Append-only correction of record (M9 D9): the signed row is superseded, never rewritten. */
      readonly type: "amend";
      readonly reason: string;
      readonly at: IsoInstant;
    };

export type DisciplineAssessmentTransition = TransitionResult<
  DisciplineAssessmentLifecycleState,
  DisciplineAssessmentEvent["type"]
>;

/** The legal §2.2.3 assessment transition graph. */
export const DISCIPLINE_ASSESSMENT_GRAPH: Readonly<
  Record<DisciplineAssessmentLifecycleState, ReadonlyArray<DisciplineAssessmentEvent["type"]>>
> = {
  draft: ["sign"],
  signed: ["amend"],
  // An amended row is itself a signed record of what was documented at the time; it may be amended again.
  amended: ["amend"],
};

/** Apply a `discipline_assessment` event (§2.2.3). */
export function transitionDisciplineAssessment(
  from: DisciplineAssessmentLifecycleState,
  event: DisciplineAssessmentEvent,
): DisciplineAssessmentTransition {
  if (!DISCIPLINE_ASSESSMENT_GRAPH[from].includes(event.type)) {
    throw new DisciplinePlanStateError(
      "ILLEGAL_TRANSITION",
      `discipline assessment cannot ${event.type} from '${from}'`,
    );
  }
  switch (event.type) {
    case "sign": {
      // A referenced encounter must be a real signed M8 encounter on this patient; `null` means the
      // assessment was captured outside an encounter (legal — e.g. a telephonic psychosocial follow-up).
      if (event.sourceEncounterValid !== null) {
        require_(
          event.sourceEncounterValid,
          "INVALID_ENCOUNTER_REFERENCE",
          "sourceEncounterId is not a signed encounter for this patient",
        );
      }
      return result(from, event.type, "signed", [
        { kind: "set_timestamp", field: "signed_at", at: event.at },
        // §7.2 / §7.3 — the signed INITIAL assessment is what satisfies the D10 clock on the plan.
        ...(event.isInitial
          ? ([
              {
                kind: "set_timestamp",
                field: "initial_assessment_signed_at",
                at: event.at,
              },
            ] as DisciplineAssessmentTransition["effects"])
          : []),
        { kind: "audit" },
      ]);
    }
    case "amend": {
      require_(
        event.reason.trim().length >= TEXT_MINIMUMS.amendmentReason,
        "AMENDMENT_REASON_REQUIRED",
        "an assessment amendment must carry a reason (correction of record)",
      );
      return result(from, event.type, "amended", [
        { kind: "set_timestamp", field: "updated_at", at: event.at },
        { kind: "audit" },
        { kind: "outbox", event: "m15.discipline_assessment.amended" },
      ]);
    }
  }
}
