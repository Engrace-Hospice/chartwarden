// ADR-0114 S4b (VN-D58, VN-D59): which sources of a drafted section are M15 plan elements a visit can keep or leave out, and that the link rules are the
// SAME pure planners the M7 care-plan links use (care-plan-refs.ts), applied to the other table's rows. Synthetic ids only.
import { describe, expect, it } from "vitest";
import {
  type LinkRowState,
  isCarePlanRef,
  planLinks,
  planRemovals,
  removedElementIdsOf,
} from "../src/modules/08-encounters/drafting/care-plan-refs";
import {
  disciplinePlanElementsOf,
  isDisciplinePlanRef,
} from "../src/modules/08-encounters/drafting/discipline-plan-refs";

const GOAL = { kind: "discipline_plan_goal", id: "goal-1" } as const;
const INTERVENTION = { kind: "discipline_plan_intervention", id: "iv-1" } as const;
const M7_GOAL = { kind: "care_plan_goal", id: "cp-goal-1" } as const;
const VITALS = { kind: "vitals", id: "vitals-1" } as const;

describe("isDisciplinePlanRef", () => {
  it("is true for an M15 goal and an M15 intervention, and for nothing else a draft cites", () => {
    expect(isDisciplinePlanRef(GOAL)).toBe(true);
    expect(isDisciplinePlanRef(INTERVENTION)).toBe(true);
    expect(isDisciplinePlanRef(M7_GOAL)).toBe(false);
    expect(isDisciplinePlanRef(VITALS)).toBe(false);
  });

  it("does not claim an M7 care-plan element, and the M7 predicate does not claim an M15 one", () => {
    expect(isCarePlanRef(GOAL)).toBe(false);
    expect(isCarePlanRef(INTERVENTION)).toBe(false);
  });
});

describe("disciplinePlanElementsOf", () => {
  it("names the goals and interventions among a section's sources, in order, and drops the rest", () => {
    expect(disciplinePlanElementsOf([VITALS, INTERVENTION, M7_GOAL, GOAL])).toEqual([
      { kind: "intervention", id: "iv-1" },
      { kind: "goal", id: "goal-1" },
    ]);
  });

  it("is empty for a section with no M15 source", () => {
    expect(disciplinePlanElementsOf([VITALS, M7_GOAL])).toEqual([]);
    expect(disciplinePlanElementsOf([])).toEqual([]);
  });
});

describe("the link rules, over M15 elements", () => {
  const live = (
    id: string,
    goalId: string | null,
    interventionId: string | null,
  ): LinkRowState => ({
    id,
    goalId,
    interventionId,
    removedAt: null,
  });
  const removed = (
    id: string,
    goalId: string | null,
    interventionId: string | null,
  ): LinkRowState => ({ id, goalId, interventionId, removedAt: new Date("2026-11-20T12:00:00Z") });
  const elements = disciplinePlanElementsOf([GOAL, INTERVENTION]);

  it("a confirmation links each element once and writes nothing for one already live", () => {
    expect(planLinks([], elements).map((op) => op.op)).toEqual(["insert_live", "insert_live"]);
    expect(planLinks([live("l1", "goal-1", null)], elements).map((op) => op.op)).toEqual([
      "insert_live",
    ]);
  });

  it("a deselection soft-removes a live link and tombstones an element that was never linked", () => {
    const ops = planRemovals([live("l1", "goal-1", null)], elements);
    expect(ops).toEqual([
      { op: "remove_live", element: { kind: "goal", id: "goal-1" }, rowIds: ["l1"] },
      { op: "insert_removed", element: { kind: "intervention", id: "iv-1" } },
    ]);
  });

  it("an element is out of the draft only while it has a removed row and no live one", () => {
    expect([...removedElementIdsOf([removed("l1", "goal-1", null)])]).toEqual(["goal-1"]);
    expect([
      ...removedElementIdsOf([removed("l1", "goal-1", null), live("l2", "goal-1", null)]),
    ]).toEqual([]);
  });
});
