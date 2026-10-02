// apps/backend/src/modules/15-discipline-care-plans/consumers/apply-idg-decision.ts — the M15 side of the
// M14 IDG-decision contract (F-234 / #248; M15 spec §1.1, §7.7, §4.5; ADR-0023 / M15-F07). PURE DECISION CORE.
//
// M14 records a `discipline_plan_update` decision ("discontinue the MSW grief-counseling intervention; add a
// chaplain weekly-presence visit") and, at adjournment, emits `idg.decision_recorded`. M15 consumes it: open a
// draft next version on the target plan if none is open, apply the mutations to the plan's goals and
// interventions, and acknowledge with `m15.idg_decision.applied`. The live binding is
// ./m14-idg-decision-recorded.ts; this core is given the parsed mutations plus the facts that binding reads
// and returns the ONE effect to execute — so every refusal rule is unit-testable with no database.
//
// WHAT "APPLIED" MEANS HERE. §7.7: the mutations land on the plan's working rows while the plan is
// `draft_revising` and the new `idg_review` version is a DRAFT — nothing is signed and the last signed version
// stays current, so the chart never has a gap. The clinician sees "auto-applied — review and finalize" and
// finalizes/signs through M15's existing routes. (M7 differs on purpose: its consumer stages a governed
// proposal because the IPOC is signed by the whole IDG; a discipline plan is one discipline's document.)
//
// FAIL-CLOSED, and the verdict is permanent. A decision the plan cannot take — discharged, not yet signed, a
// Part 2 (42 CFR Part 2) goal targeted, an element that is not on this plan, an illegal §2.2.3 transition — is
// REFUSED: the binding records a terminal `refused` row (idempotent, nothing applied, NO acknowledgement
// event) rather than retrying forever. The decision is all-or-nothing: one bad mutation refuses the whole
// decision, so a half-applied IDG decision can never exist. Transient conditions (no plan bootstrapped yet,
// the plan's open version is sealed `in_review`) are the binding's THROW, never a refusal.
//
// SUD. The consumer is a system actor holding no `sud_disclosure_allowed`. It therefore never touches a goal
// flagged `sud_related` (revise/meet/discontinue it) and never links a new intervention to one: changing or
// referencing Part 2 content without the disclosure predicate is exactly the read M15 §7.8 redacts.
import type { DisciplineGoalSource } from "@wardenx/types";
import {
  type DisciplineGoalEvent,
  type DisciplineGoalLifecycleState,
  type DisciplineInterventionLifecycleState,
  transitionDisciplineGoal,
  transitionDisciplineIntervention,
} from "../lifecycle/elements";
import { DisciplinePlanStateError } from "../lifecycle/errors";

/** The discriminator M14 uses on `idg.decision_recorded.payload.kind` (string literal — M15 imports no M14). */
export const DISCIPLINE_PLAN_UPDATE_KIND = "discipline_plan_update" as const;

/** The `addedByDiscipline` stamped on rows an IDG decision authors — the documented IDG-Coordinator override
 *  of the §1.1 D1 authoring matrix (an IDG decision is a team decision, not one discipline's edit). */
export const IDG_AUTHORING_DISCIPLINE = "idg_coordinator" as const;

/** One parsed M15 mutation (the `DisciplinePlanMutation` wire arm, re-declared so M15 imports no M14 type). */
export type ParsedDisciplineMutation =
  | {
      readonly op: "goal_add";
      readonly parentProblemId: string;
      readonly source: DisciplineGoalSource;
      readonly originalText: string;
      readonly measurableOutcome: string | null;
    }
  | {
      readonly op: "goal_update";
      readonly goalId: string;
      readonly event: DisciplineGoalEvent["type"];
      readonly revisedText?: string;
      readonly reason?: string;
    }
  | {
      readonly op: "intervention_add";
      readonly goalRefs: readonly string[];
      readonly discipline: string;
      readonly scopeText: string;
      readonly frequencyText: string;
      readonly frequencyValue: string;
    }
  | {
      readonly op: "intervention_discontinue";
      readonly interventionId: string;
      readonly reason: string;
    };

/** The facts the binding reads before deciding (resolved under the tenant's RLS, plan row locked). */
export interface IdgApplyFacts {
  /** `discipline_care_plan.status` of the target plan. */
  readonly planStatus: "draft" | "active" | "draft_revising" | "discharged";
  /** The plan's open (`draft`/`in_review`) version if any — the single-open-draft rule (§2.2.2). */
  readonly openVersion: { readonly id: string; readonly status: "draft" | "in_review" } | null;
  /** The plan's goals by id. */
  readonly goals: ReadonlyMap<
    string,
    { readonly status: DisciplineGoalLifecycleState; readonly sudRelated: boolean }
  >;
  /** The plan's interventions by id. */
  readonly interventions: ReadonlyMap<
    string,
    { readonly status: DisciplineInterventionLifecycleState }
  >;
  /** The patient's ACTIVE M7 IPOC problem ids (a discipline goal's required parent, §2.1). */
  readonly activeProblemIds: ReadonlySet<string>;
}

/** Why a decision is refused — recorded on the terminal `refused` application row. */
export type IdgRefusalReason =
  | "plan_discharged"
  | "plan_not_yet_active"
  | "no_mutations"
  | "goal_not_on_plan"
  | "intervention_not_on_plan"
  | "parent_problem_not_active"
  | "goal_ref_not_on_plan"
  | "sud_goal_targeted"
  | "illegal_transition"
  | "malformed_mutation";

/** The planned, validated effect of one mutation — what the binding writes. */
export type PlannedDisciplineMutation =
  | {
      readonly op: "goal_add";
      readonly parentProblemId: string;
      readonly source: DisciplineGoalSource;
      readonly originalText: string;
      readonly measurableOutcome: string | null;
    }
  | {
      readonly op: "goal_update";
      readonly goalId: string;
      readonly to: DisciplineGoalLifecycleState;
      readonly revisedText: string | null;
    }
  | {
      readonly op: "intervention_add";
      readonly goalRefs: readonly string[];
      readonly discipline: string;
      readonly scopeText: string;
      readonly frequencyText: string;
      readonly frequencyValue: string;
    }
  | {
      readonly op: "intervention_discontinue";
      readonly interventionId: string;
      readonly reason: string;
    };

export type IdgApplyAction =
  | { readonly kind: "refuse"; readonly reason: IdgRefusalReason }
  | {
      readonly kind: "apply";
      /** True → insert a fresh draft `idg_review` version (and open the plan's next version); false → the
       *  plan already has an open DRAFT version to apply into. */
      readonly openNewVersion: boolean;
      readonly mutations: readonly PlannedDisciplineMutation[];
    };

const refuse = (reason: IdgRefusalReason): IdgApplyAction => ({ kind: "refuse", reason });

/**
 * Decide the single effect for a `discipline_plan_update` delivery (pure). Order: plan state, then each
 * mutation in payload order; the first violation refuses the whole decision.
 */
export function decideDisciplinePlanDecision(
  mutations: readonly ParsedDisciplineMutation[],
  facts: IdgApplyFacts,
): IdgApplyAction {
  if (facts.planStatus === "discharged") return refuse("plan_discharged");
  // A plan that never reached `active` has no signed version to revise (§2.2.1: only `active` may open a
  // next version). A decision recorded before the plan's first signature cannot be auto-applied.
  if (facts.planStatus === "draft") return refuse("plan_not_yet_active");
  if (mutations.length === 0) return refuse("no_mutations");

  const planned: PlannedDisciplineMutation[] = [];
  // Working copies: two mutations on one element inside a decision see each other's effect, so the second
  // is judged against the state the first leaves (a goal met then revised is an illegal transition).
  const goalState = new Map(facts.goals);
  const interventionState = new Map(facts.interventions);
  for (const m of mutations) {
    switch (m.op) {
      case "goal_add": {
        if (!facts.activeProblemIds.has(m.parentProblemId))
          return refuse("parent_problem_not_active");
        if (m.originalText.trim().length === 0) return refuse("malformed_mutation");
        planned.push({
          op: "goal_add",
          parentProblemId: m.parentProblemId,
          source: m.source,
          originalText: m.originalText,
          measurableOutcome: m.measurableOutcome,
        });
        break;
      }
      case "goal_update": {
        const goal = goalState.get(m.goalId);
        if (!goal) return refuse("goal_not_on_plan");
        if (goal.sudRelated) return refuse("sud_goal_targeted");
        try {
          const t = transitionDisciplineGoal(goal.status, {
            type: m.event,
            revisedText: m.revisedText ?? "",
            reason: m.reason ?? "",
          } as DisciplineGoalEvent);
          goalState.set(m.goalId, { ...goal, status: t.to });
          planned.push({
            op: "goal_update",
            goalId: m.goalId,
            to: t.to,
            revisedText: m.event === "revise" ? (m.revisedText ?? null) : null,
          });
        } catch (error) {
          if (error instanceof DisciplinePlanStateError) return refuse("illegal_transition");
          throw error;
        }
        break;
      }
      case "intervention_add": {
        for (const ref of m.goalRefs) {
          const goal = goalState.get(ref);
          if (!goal) return refuse("goal_ref_not_on_plan");
          if (goal.sudRelated) return refuse("sud_goal_targeted");
        }
        if (m.scopeText.trim().length === 0 || m.frequencyText.trim().length === 0) {
          return refuse("malformed_mutation");
        }
        planned.push({
          op: "intervention_add",
          goalRefs: [...new Set(m.goalRefs)],
          discipline: m.discipline,
          scopeText: m.scopeText,
          frequencyText: m.frequencyText,
          frequencyValue: m.frequencyValue,
        });
        break;
      }
      case "intervention_discontinue": {
        const intervention = interventionState.get(m.interventionId);
        if (!intervention) return refuse("intervention_not_on_plan");
        try {
          transitionDisciplineIntervention(intervention.status, {
            type: "discontinue",
            reason: m.reason,
          });
        } catch (error) {
          if (error instanceof DisciplinePlanStateError) return refuse("illegal_transition");
          throw error;
        }
        interventionState.set(m.interventionId, { status: "discontinued" });
        planned.push({
          op: "intervention_discontinue",
          interventionId: m.interventionId,
          reason: m.reason,
        });
        break;
      }
    }
  }

  return {
    kind: "apply",
    openNewVersion: facts.openVersion === null,
    mutations: planned,
  };
}
