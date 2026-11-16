// apps/backend/__tests__/care-plan-idg-consumer.test.ts — M7-T08 the LIVE `idg.decision_recorded`
// care-plan consumer's proposal builder (§7.9). The builder turns one M14 `care_plan_update` mutation
// ({ op: 'problem_add' | 'problem_update' | ... }) into a governed `care_plan_idg_proposed_change` row; it
// NEVER writes a clinical row (the fake tx below has no insert/update, so any write would throw) — the
// active care-plan rows change only when the idg_review version reaches quorum. It also refuses, with a
// typed IdgProposalRefusal the handler persists as a durable `conflict` application, every mutation the
// element machines (lifecycle/elements.ts) or the T4 STRIDE rule would reject. No DB; the persisted
// refusal / no-active-plan / open-version paths are proven in m7-care-plan-write.live.test.ts.
import { describe, expect, it } from "vitest";
import {
  M7_IDG_DECISION_CONSUMER,
  buildProposedChange,
} from "../src/modules/07-care-plan/outbox-consumers/m14-idg-decision-recorded";
import { IdgProposalRefusal } from "../src/modules/07-care-plan/outbox-consumers/m14-idg-proposal-guards";

// ── fixtures ──────────────────────────────────────────────────────────────────────────────────────────

const ORG = "11111111-1111-4111-8111-111111111111";
const PLAN_ID = "22222222-2222-4222-8222-222222222222";
const DECISION = "33333333-3333-4333-8333-333333333333";
const MEETING = "44444444-4444-4444-8444-444444444444";
const APPLICATION = "55555555-5555-4555-8555-555555555555";
const PROBLEM = "66666666-6666-4666-8666-666666666666";
const GOAL = "77777777-7777-4777-8777-777777777777";
const INTERVENTION = "88888888-8888-4888-8888-888888888888";

/** A read-only stand-in for the org-scoped tx: every `select().from().where().limit()` resolves to `rows`. */
function readOnlyTx(rows: readonly unknown[]) {
  const query: Promise<readonly unknown[]> & Record<"from" | "where" | "limit", () => unknown> =
    Object.assign(Promise.resolve(rows), {
      from: () => query,
      where: () => query,
      limit: () => query,
    });
  return { select: () => query } as never;
}

const plan = { id: PLAN_ID, providerEntityId: null, locationId: null } as never;

function build(mutation: unknown, rows: readonly unknown[] = []) {
  return buildProposedChange(readOnlyTx(rows), {
    organizationId: ORG,
    plan,
    mutation,
    applicationId: APPLICATION,
    decisionId: DECISION,
    meetingId: MEETING,
    ordinal: 0,
  });
}

async function refusalOf(
  mutation: unknown,
  rows: readonly unknown[] = [],
): Promise<IdgProposalRefusal> {
  try {
    await build(mutation, rows);
  } catch (error) {
    expect(error).toBeInstanceOf(IdgProposalRefusal);
    return error as IdgProposalRefusal;
  }
  throw new Error("expected the mutation to be refused");
}

const problemRow = (over: Record<string, unknown> = {}) => ({
  id: PROBLEM,
  kind: "related",
  status: "active",
  description: "Pain",
  ...over,
});

// ── problem_add → a proposal, never an active row ─────────────────────────────────────────────────────

describe("M7 IDG proposal builder — additions are proposals", () => {
  it("problem_add yields a proposed-change insert with a fresh target id and no clinical write", async () => {
    const row = await build({
      op: "problem_add",
      icd10Code: null,
      snomedCode: null,
      description: "New dyspnea",
      problemKind: "related",
    });
    expect(row).toMatchObject({
      applicationId: APPLICATION,
      carePlanId: PLAN_ID,
      idgDecisionId: DECISION,
      idgMeetingId: MEETING,
      entityType: "problem",
      operation: "problem_add",
      before: null,
      ordinal: 0,
    });
    const proposed = row.proposed as { id: string; status: string; description: string };
    expect(row.targetEntityId).toBe(proposed.id);
    expect(proposed).toMatchObject({ status: "active", description: "New dyspnea" });
    // the stored change defaults to status 'proposed' (it is not applied until quorum)
    expect(row).not.toHaveProperty("status");
  });

  it("intervention_add maps md/np to md_np and refuses an unknown discipline (M14 accepts any string)", async () => {
    const add = (discipline: string) => ({
      op: "intervention_add",
      problemId: PROBLEM,
      goalRefs: [],
      discipline,
      scopeText: "Reassess pain",
      frequencyText: "3x weekly",
      frequencyValue: "3:visit:week",
    });
    const mapped = await build(add("np"), [{ id: PROBLEM }]);
    expect((mapped.proposed as { discipline: string }).discipline).toBe("md_np");

    const refusal = await refusalOf(add("hospice_wizard"), [{ id: PROBLEM }]);
    expect(refusal.code).toBe("unsupported_intervention_discipline");
    expect(refusal.message).not.toContain("hospice_wizard");
  });
});

// ── T4 — IDG never resolves/deactivates a terminal problem ────────────────────────────────────────────

describe("M7 IDG proposal builder — T4 terminal-problem guard", () => {
  for (const status of ["resolved", "inactive"] as const) {
    it(`refuses problem_update status '${status}' on a terminal-kind problem`, async () => {
      const refusal = await refusalOf(
        { op: "problem_update", problemId: PROBLEM, updates: { status } },
        [problemRow({ kind: "terminal" })],
      );
      expect(refusal.code).toBe("terminal_problem_status_change");
    });
  }

  it("still allows a description-only update of a terminal problem", async () => {
    const row = await build(
      { op: "problem_update", problemId: PROBLEM, updates: { description: "Reworded" } },
      [problemRow({ kind: "terminal" })],
    );
    expect(row.proposed).toEqual({ description: "Reworded" });
  });
});

// ── element machines (lifecycle/elements.ts) ──────────────────────────────────────────────────────────

describe("M7 IDG proposal builder — element transitions follow the lifecycle machines", () => {
  it("refuses resolving a problem: M14's update carries no resolution note, which the machine requires", async () => {
    const refusal = await refusalOf(
      { op: "problem_update", problemId: PROBLEM, updates: { status: "resolved" } },
      [problemRow()],
    );
    expect(refusal.code).toBe("resolution_note_required");
  });

  it("allows deactivating an active non-terminal problem", async () => {
    const row = await build(
      { op: "problem_update", problemId: PROBLEM, updates: { status: "inactive" } },
      [problemRow()],
    );
    expect(row.proposed).toEqual({ status: "inactive" });
  });

  it("refuses re-activating a resolved problem, and treats a no-change 'active' on an active one as a no-op", async () => {
    const reactivate = await refusalOf(
      { op: "problem_update", problemId: PROBLEM, updates: { status: "active" } },
      [problemRow({ status: "resolved" })],
    );
    expect(reactivate.code).toBe("illegal_transition");
    // The apply path treats an unchanged status as a no-op (the web form re-sends it with a text edit), so a
    // proposal carrying it must be accepted rather than turned into a permanent conflict.
    const noChange = await build(
      {
        op: "problem_update",
        problemId: PROBLEM,
        updates: { status: "active", description: "Reworded" },
      },
      [problemRow()],
    );
    expect(noChange.proposed).toEqual({ status: "active", description: "Reworded" });
  });

  it("refuses ANY edit of a resolved problem or a terminal goal, not only a status change", async () => {
    // Apply and finalize refuse these; accepting one here would wedge the plan's single open-version slot.
    const problem = await refusalOf(
      { op: "problem_update", problemId: PROBLEM, updates: { description: "Reworded" } },
      [problemRow({ status: "resolved" })],
    );
    expect(problem.code).toBe("illegal_transition");
    for (const status of ["met", "not_met", "discontinued"]) {
      const goal = await refusalOf(
        { op: "goal_update", goalId: GOAL, updates: { statusNote: "note" } },
        [{ id: GOAL, status }],
      );
      expect(goal.code).toBe("illegal_transition");
    }
  });

  it("accepts a goal_update that re-sends the goal's current status with a text edit", async () => {
    const row = await build(
      {
        op: "goal_update",
        goalId: GOAL,
        updates: { status: "in_progress", revisedText: "Comfort at rest" },
      },
      [{ id: GOAL, status: "in_progress" }],
    );
    expect(row.proposed).toEqual({ status: "in_progress", revisedText: "Comfort at rest" });
  });

  it("refuses a goal status the goal machine cannot reach (met from not_started) and allows start", async () => {
    const goal = { id: GOAL, status: "not_started" };
    const refusal = await refusalOf(
      { op: "goal_update", goalId: GOAL, updates: { status: "met", statusNote: "done" } },
      [goal],
    );
    expect(refusal.code).toBe("illegal_transition");
    const ok = await build(
      { op: "goal_update", goalId: GOAL, updates: { status: "in_progress" } },
      [goal],
    );
    expect(ok.proposed).toEqual({ status: "in_progress" });
  });

  it("refuses discontinuing an intervention that is no longer active", async () => {
    const refusal = await refusalOf(
      { op: "intervention_discontinue", interventionId: INTERVENTION, reason: "declined" },
      [{ id: INTERVENTION, status: "discontinued" }],
    );
    expect(refusal.code).toBe("illegal_transition");
    const ok = await build(
      { op: "intervention_discontinue", interventionId: INTERVENTION, reason: "declined" },
      [{ id: INTERVENTION, status: "active" }],
    );
    expect(ok.proposed).toEqual({ status: "discontinued", discontinueReason: "declined" });
  });

  it("refuses an unsupported operation and a missing element as a typed refusal, not a retry", async () => {
    expect((await refusalOf({ op: "problem_delete" })).code).toBe("invalid_mutation");
    expect(
      (await refusalOf({ op: "goal_update", goalId: GOAL, updates: { status: "in_progress" } }, []))
        .code,
    ).toBe("element_not_found");
  });
});

// ── the live binding ──────────────────────────────────────────────────────────────────────────────────

describe("M14 idg.decision_recorded consumer binding", () => {
  it("targets the canonical event under the m7 consumer name", () => {
    expect(M7_IDG_DECISION_CONSUMER).toEqual({
      eventName: "idg.decision_recorded",
      consumerName: "m7.apply-idg-decision",
    });
  });
});
