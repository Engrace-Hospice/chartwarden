// apps/backend/__tests__/care-plan-idg-consumer.test.ts — M7-T08 the `apply-idg-decision` decision core
// (§7.9 / §11 D4) + the deferred M14 consumer binding. Exercises the pure {@link decideIdgDecision} over
// the §7.9 IDG-revision flow (open-or-reuse draft v2, translate the meeting's add/update/discontinue
// mutations), the D4 idempotency no-op, the D2 closed-plan refusal, the malformed-change refusal, and
// the T4 terminal-problem-discontinue rejection — no DB, the version/element machines stay the only path
// to mutations. The worker composes M7's own services so there is no M14 schema import; the binding is
// forward-declared/deferred until M14 lands in Wave F.
import type { IdgDecisionPayload } from "@wardenx/types";
import { describe, expect, it } from "vitest";
import {
  type IdgApplyFacts,
  M7_IDG_DECISION_CONSUMER,
  M7_IDG_DECISION_CONSUMER_DEFERRED,
  decideIdgDecision,
  decideIdgDecisionRecorded,
} from "../src/modules/07-care-plan/index";

// ── fixtures ──────────────────────────────────────────────────────────────────────────────────────────

const PLAN = "cp-1";
const PAT = "pat-1";
const MEETING = "idg-meeting-1";
const TERMINAL = "prob-terminal";

function payload(over: Partial<IdgDecisionPayload> = {}): IdgDecisionPayload {
  return {
    idgDecisionId: "dec-1",
    idgMeetingId: MEETING,
    planId: PLAN,
    patientId: PAT,
    changes: [
      { target: "intervention", op: "add", discipline: "rn" },
      {
        target: "intervention",
        op: "discontinue",
        interventionId: "intv-grief",
        discipline: "msw",
      },
    ],
    ...over,
  };
}

function facts(over: Partial<IdgApplyFacts> = {}): IdgApplyFacts {
  return {
    alreadyApplied: false,
    planActive: true,
    openDraftVersionId: null,
    terminalProblemIds: [TERMINAL],
    ...over,
  };
}

// ── happy path (§7.9) ─────────────────────────────────────────────────────────────────────────────────

describe("decideIdgDecision — apply (§7.9)", () => {
  it("opens a fresh draft v2 when none is open and translates every change to a mutation", () => {
    const action = decideIdgDecision(payload(), facts({ openDraftVersionId: null }));
    expect(action.kind).toBe("apply");
    if (action.kind !== "apply") return;
    expect(action.openNewDraft).toBe(true);
    expect(action.targetVersionId).toBeNull();
    expect(action.idgMeetingId).toBe(MEETING);
    expect(action.planId).toBe(PLAN);
    expect(action.mutations).toEqual([
      { target: "intervention", op: "add", discipline: "rn" },
      { target: "intervention", op: "discontinue", elementId: "intv-grief", discipline: "msw" },
    ]);
  });

  it("reuses the open draft v2 when one already exists (no second draft opened)", () => {
    const action = decideIdgDecision(payload(), facts({ openDraftVersionId: "ver-2" }));
    expect(action.kind).toBe("apply");
    if (action.kind !== "apply") return;
    expect(action.openNewDraft).toBe(false);
    expect(action.targetVersionId).toBe("ver-2");
  });

  it("carries the referenced id for problem/goal update mutations (no id for add)", () => {
    const action = decideIdgDecision(
      payload({
        changes: [
          { target: "problem", op: "add" },
          { target: "goal", op: "update", goalId: "goal-7" },
        ],
      }),
      facts(),
    );
    expect(action.kind).toBe("apply");
    if (action.kind !== "apply") return;
    expect(action.mutations).toEqual([
      { target: "problem", op: "add" },
      { target: "goal", op: "update", elementId: "goal-7" },
    ]);
  });
});

// ── idempotency (D4) ──────────────────────────────────────────────────────────────────────────────────

describe("decideIdgDecision — idempotency (§11 D4)", () => {
  it("no-ops when a version already records this idgDecisionId", () => {
    expect(decideIdgDecision(payload(), facts({ alreadyApplied: true }))).toEqual({
      kind: "idempotent_skip",
    });
  });

  it("checks idempotency before any contract guard (a replayed terminal-discontinue still skips)", () => {
    const action = decideIdgDecision(
      payload({ changes: [{ target: "problem", op: "discontinue", problemId: TERMINAL }] }),
      facts({ alreadyApplied: true }),
    );
    expect(action).toEqual({ kind: "idempotent_skip" });
  });
});

// ── contract guards (D2 / T4) ─────────────────────────────────────────────────────────────────────────

describe("decideIdgDecision — contract guards", () => {
  it("refuses when the plan is not active (D2 — a discharged plan is closed)", () => {
    expect(decideIdgDecision(payload(), facts({ planActive: false }))).toEqual({
      kind: "refuse",
      reason: "plan_not_active",
    });
  });

  it("refuses an empty decision (no changes carries no work)", () => {
    expect(decideIdgDecision(payload({ changes: [] }), facts())).toEqual({
      kind: "refuse",
      reason: "no_changes",
    });
  });

  it("refuses an update/discontinue change missing its element id", () => {
    expect(
      decideIdgDecision(payload({ changes: [{ target: "goal", op: "update" }] }), facts()),
    ).toEqual({
      kind: "refuse",
      reason: "missing_element_id",
    });
  });

  it("rejects a discontinue of a terminal-kind problem (T4 — needs the RN + physician co-sign path)", () => {
    const action = decideIdgDecision(
      payload({ changes: [{ target: "problem", op: "discontinue", problemId: TERMINAL }] }),
      facts(),
    );
    expect(action).toEqual({ kind: "refuse", reason: "terminal_problem_discontinue" });
  });

  it("permits discontinue of a non-terminal problem", () => {
    const action = decideIdgDecision(
      payload({ changes: [{ target: "problem", op: "discontinue", problemId: "prob-related" }] }),
      facts(),
    );
    expect(action.kind).toBe("apply");
  });
});

// ── the deferred M14 binding ──────────────────────────────────────────────────────────────────────────

describe("M14 idg.decision_recorded consumer binding (deferred)", () => {
  it("is forward-declared (event → consumer) and not yet live-wired", () => {
    expect(M7_IDG_DECISION_CONSUMER).toEqual({
      eventName: "idg.decision_recorded",
      consumerName: "m7.apply-idg-decision",
    });
    expect(M7_IDG_DECISION_CONSUMER_DEFERRED).toBe(true);
  });

  it("re-exports the pure decider verbatim for the Wave-F boot wiring", () => {
    const p = payload();
    const f = facts();
    expect(decideIdgDecisionRecorded(p, f)).toEqual(decideIdgDecision(p, f));
  });
});
