// apps/backend/src/modules/07-care-plan/change-proposals-apply.ts — WF09: what ACCEPTING a change proposal does to the plan.
//
// It runs the SAME service operation the manual Care Plans route for that kind runs (`addProblem`, `resolveProblem`, `addGoal`, `patchGoal`,
// `addIntervention`, `discontinueIntervention` of `createDbCarePlanRouteService`), so every rule those carry — the §2.3 validators, the
// §2.2.3 element machines, the §7.4 discipline scope, the `m7.*` outbox event — applies here unchanged, with nothing copied. The service is
// built over the caller's OWN transaction: its `withOrgContext` becomes a savepoint, so the element write and the proposal's stamp commit
// together, and an error (a version in review, a terminal target) rolls the element write back and leaves the proposal pending.
//
// Before calling it, the target is re-read: a proposal is a snapshot of what a clinician saw during a visit, and the plan may have moved since.
// A target that is gone or already finished is a clear 409 (`PROPOSAL_TARGET_UNAVAILABLE`), not a 404 or a 500 from deep inside the service.
import { type DbClient, schema } from "@chartwarden/db";
import {
  ChartWardenError,
  type GoalSource,
  type GoalStatus,
  type InterventionDiscipline,
  type ProblemKind,
  type ProblemSource,
} from "@chartwarden/types";
import { and, eq } from "drizzle-orm";
import type { AuthoringDisciplineScope } from "./authoring/index";
import {
  type CarePlanWriteOutboxPort,
  createDbCarePlanRouteService,
} from "./care-plan-route-service-db";
import type { ProposalElementType } from "./change-proposals-rules";

const CPCP = schema.carePlanChangeProposals;
const PROB = schema.problems;
const GOAL = schema.goals;
const INTV = schema.interventions;

type Row = typeof CPCP.$inferSelect;

/** The element an accepted proposal created or changed. */
export interface AppliedElement {
  readonly type: ProposalElementType;
  readonly id: string;
}

/** Who accepts: stamped as the element's author, and the discipline scope the manual route would have applied to them. */
export interface ProposalDecider {
  readonly membershipId: string;
  readonly disciplineScope: AuthoringDisciplineScope;
  /** §7.6: the accepter's disclosure verdict; the element service answers 404 for a Part 2 goal a caller without it links. */
  readonly sudDisclosureAllowed: boolean;
}

const unavailable = (message: string): ChartWardenError =>
  new ChartWardenError("PROPOSAL_TARGET_UNAVAILABLE", message, 409);

/** A column the kind's CHECK constraint guarantees. Reaching the throw means the row was written around the constraint. */
function required<T>(value: T | null, column: string): T {
  if (value === null)
    throw new Error(
      `care_plan_change_proposal: ${column} is null on a row its CHECK forbids that for`,
    );
  return value;
}

/** The problem a new goal / intervention belongs to: an existing one, or the one a proposal of the same visit created. */
async function problemIdFor(t: DbClient, planId: string, row: Row): Promise<string> {
  if (row.problemId) {
    const [problem] = await t
      .select({ id: PROB.id })
      .from(PROB)
      .where(and(eq(PROB.id, row.problemId), eq(PROB.carePlanId, planId)))
      .limit(1);
    if (!problem) throw unavailable("the problem this change belongs to is no longer on the plan");
    return problem.id;
  }
  const [parent] = await t
    .select({ status: CPCP.status, resultElementId: CPCP.resultElementId })
    .from(CPCP)
    .where(
      and(
        eq(CPCP.id, required(row.parentProposalId, "parent_proposal_id")),
        eq(CPCP.carePlanId, planId),
      ),
    )
    .limit(1);
  if (parent?.status === "dismissed" || parent?.status === "withdrawn") {
    // Dismissing a problem proposal dismisses its pending goals / interventions with it, so this is a row that predates that, or a race: the
    // reviewer is told the truth (the problem will never exist), not to "accept it first".
    throw new ChartWardenError(
      "PROPOSAL_PARENT_DISMISSED",
      `the problem this change belongs to was ${parent.status}, so this change cannot be applied: dismiss it`,
      409,
    );
  }
  if (parent?.status !== "accepted" || !parent.resultElementId) {
    throw new ChartWardenError(
      "PROPOSAL_PARENT_NOT_ACCEPTED",
      "the problem this change belongs to is still a proposal: accept it first",
      409,
    );
  }
  return parent.resultElementId;
}

async function activeProblem(t: DbClient, planId: string, id: string) {
  const [row] = await t
    .select({ version: PROB.version, status: PROB.status })
    .from(PROB)
    .where(and(eq(PROB.id, id), eq(PROB.carePlanId, planId)))
    .limit(1);
  if (!row) throw unavailable("the problem this change targets is no longer on the plan");
  if (row.status !== "active") throw unavailable(`the problem is already ${row.status}`);
  return row;
}

async function openGoal(t: DbClient, planId: string, id: string) {
  const [row] = await t
    .select({ version: GOAL.version, status: GOAL.status })
    .from(GOAL)
    .where(and(eq(GOAL.id, id), eq(GOAL.carePlanId, planId)))
    .limit(1);
  if (!row) throw unavailable("the goal this change targets is no longer on the plan");
  if (row.status === "met" || row.status === "not_met" || row.status === "discontinued") {
    throw unavailable(`the goal is already ${row.status.replace("_", " ")}`);
  }
  return row;
}

async function activeIntervention(t: DbClient, planId: string, id: string) {
  const [row] = await t
    .select({ version: INTV.version, status: INTV.status })
    .from(INTV)
    .where(and(eq(INTV.id, id), eq(INTV.carePlanId, planId)))
    .limit(1);
  if (!row) throw unavailable("the intervention this change targets is no longer on the plan");
  if (row.status !== "active") throw unavailable(`the intervention is already ${row.status}`);
  return row;
}

/**
 * Apply one pending proposal to the plan. The caller has locked the proposal row and the plan (`ensureNoVersionInReview`), so the version it
 * reads here is the one the service writes against.
 */
export async function applyProposal(
  t: DbClient,
  outbox: CarePlanWriteOutboxPort,
  org: string,
  planId: string,
  row: Row,
  decider: ProposalDecider,
): Promise<AppliedElement> {
  const plan = createDbCarePlanRouteService(t, outbox);
  const actor = { membershipId: decider.membershipId };
  switch (row.kind) {
    case "problem_add": {
      const created = await plan.addProblem(
        org,
        planId,
        {
          description: required(row.description, "description"),
          kind: required(row.problemKind, "problem_kind") as ProblemKind,
          source: required(row.problemSource, "problem_source") as ProblemSource,
          sudRelated: row.sudRelated,
          ...(row.icd10Code ? { icd10Code: row.icd10Code } : {}),
          ...(row.snomedCode ? { snomedCode: row.snomedCode } : {}),
          ...(row.onsetAt ? { onsetAt: row.onsetAt.toISOString() } : {}),
        },
        actor,
      );
      return { type: "problem", id: created.id };
    }
    case "problem_resolve": {
      const id = required(row.targetElementId, "target_element_id");
      const problem = await activeProblem(t, planId, id);
      await plan.resolveProblem(
        org,
        planId,
        id,
        Number(problem.version),
        required(row.resolutionNote, "resolution_note"),
      );
      return { type: "problem", id };
    }
    case "goal_add": {
      const created = await plan.addGoal(
        org,
        planId,
        {
          problemId: await problemIdFor(t, planId, row),
          originalText: required(row.goalText, "goal_text"),
          source: required(row.goalSource, "goal_source") as GoalSource,
          ...(row.measurableOutcome ? { measurableOutcome: row.measurableOutcome } : {}),
          ...(row.targetAt ? { targetAt: row.targetAt.toISOString() } : {}),
        },
        false, // no `agent_stated` goal can be proposed, so no DPOA consent is ever asked for
        actor,
      );
      return { type: "goal", id: created.id };
    }
    case "goal_update": {
      const id = required(row.targetElementId, "target_element_id");
      const goal = await openGoal(t, planId, id);
      await plan.patchGoal(org, planId, id, Number(goal.version), {
        ...(row.revisedText ? { revisedText: row.revisedText } : {}),
        ...(row.measurableOutcome ? { measurableOutcome: row.measurableOutcome } : {}),
        ...(row.goalStatus ? { status: row.goalStatus as GoalStatus } : {}),
        ...(row.targetAt ? { targetAt: row.targetAt.toISOString() } : {}),
      });
      return { type: "goal", id };
    }
    case "intervention_add": {
      const created = await plan.addIntervention(
        org,
        planId,
        {
          problemId: await problemIdFor(t, planId, row),
          goalRefs: row.goalRefs,
          scopeText: required(row.scopeText, "scope_text"),
          frequencyText: required(row.frequencyText, "frequency_text"),
          frequencyValue: required(row.frequencyValue, "frequency_value"),
          discipline: required(row.discipline, "discipline") as InterventionDiscipline,
          ...(row.responsibleRole ? { responsibleRole: row.responsibleRole } : {}),
        },
        decider.disciplineScope,
        actor,
        { sudDisclosureAllowed: decider.sudDisclosureAllowed },
      );
      return { type: "intervention", id: created.id };
    }
    case "intervention_discontinue": {
      const id = required(row.targetElementId, "target_element_id");
      const intervention = await activeIntervention(t, planId, id);
      await plan.discontinueIntervention(
        org,
        planId,
        id,
        Number(intervention.version),
        required(row.discontinueReason, "discontinue_reason"),
        decider.disciplineScope,
      );
      return { type: "intervention", id };
    }
    default:
      throw new Error(`care_plan_change_proposal: unknown kind '${row.kind}'`);
  }
}
