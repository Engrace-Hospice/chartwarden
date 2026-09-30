/**
 * F-232 (#248) — the pure M15 IDG-decision decider, the wire parser, and the M14 envelope arm. No database.
 * The live loop is `m15-idg-decision-apply.live.test.ts`; this pins every refusal rule and the contract shape.
 */
import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";
import { M14_OUTBOX_SUBSCRIPTIONS } from "../src/modules/14-idg/consumers/index";
import { IDG_DECISION_PAYLOAD_SCHEMA } from "../src/modules/14-idg/decision-payload-schema";
import { M14_OUTBOX_EVENTS } from "../src/modules/14-idg/index";
import {
  type IdgApplyFacts,
  type ParsedDisciplineMutation,
  decideDisciplinePlanDecision,
  parseDisciplinePlanDecision,
} from "../src/modules/15-discipline-care-plans/index";

const PROBLEM = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const GOAL = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SUD_GOAL = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const INTERVENTION = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const ORG = "11111111-1111-4111-8111-111111111111";

const facts = (over: Partial<IdgApplyFacts> = {}): IdgApplyFacts => ({
  planStatus: "active",
  openVersion: null,
  goals: new Map([
    [GOAL, { status: "in_progress", sudRelated: false }],
    [SUD_GOAL, { status: "in_progress", sudRelated: true }],
  ]),
  interventions: new Map([[INTERVENTION, { status: "active" }]]),
  activeProblemIds: new Set([PROBLEM]),
  ...over,
});

const goalAdd: ParsedDisciplineMutation = {
  op: "goal_add",
  parentProblemId: PROBLEM,
  source: "clinical",
  originalText: "New goal",
  measurableOutcome: null,
};

describe("decideDisciplinePlanDecision", () => {
  it("applies and asks for a new version when none is open; reuses an open draft", () => {
    const fresh = decideDisciplinePlanDecision([goalAdd], facts());
    expect(fresh).toMatchObject({ kind: "apply", openNewVersion: true });
    const reuse = decideDisciplinePlanDecision(
      [goalAdd],
      facts({ planStatus: "draft_revising", openVersion: { id: "v", status: "draft" } }),
    );
    expect(reuse).toMatchObject({ kind: "apply", openNewVersion: false });
  });

  it("refuses a discharged plan and a plan that never reached active", () => {
    expect(decideDisciplinePlanDecision([goalAdd], facts({ planStatus: "discharged" }))).toEqual({
      kind: "refuse",
      reason: "plan_discharged",
    });
    expect(decideDisciplinePlanDecision([goalAdd], facts({ planStatus: "draft" }))).toEqual({
      kind: "refuse",
      reason: "plan_not_yet_active",
    });
    expect(decideDisciplinePlanDecision([], facts())).toEqual({
      kind: "refuse",
      reason: "no_mutations",
    });
  });

  it("FAILS CLOSED on Part 2: never updates or links a sud_related goal", () => {
    expect(
      decideDisciplinePlanDecision(
        [{ op: "goal_update", goalId: SUD_GOAL, event: "meet" }],
        facts(),
      ),
    ).toEqual({ kind: "refuse", reason: "sud_goal_targeted" });
    expect(
      decideDisciplinePlanDecision(
        [
          {
            op: "intervention_add",
            goalRefs: [GOAL, SUD_GOAL],
            discipline: "msw",
            scopeText: "x",
            frequencyText: "y",
            frequencyValue: "1:visit:week",
          },
        ],
        facts(),
      ),
    ).toEqual({ kind: "refuse", reason: "sud_goal_targeted" });
  });

  it("refuses off-plan elements, an inactive parent problem, and illegal transitions", () => {
    const other = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    expect(
      decideDisciplinePlanDecision([{ op: "goal_update", goalId: other, event: "meet" }], facts()),
    ).toEqual({ kind: "refuse", reason: "goal_not_on_plan" });
    expect(
      decideDisciplinePlanDecision(
        [{ op: "intervention_discontinue", interventionId: other, reason: "r" }],
        facts(),
      ),
    ).toEqual({ kind: "refuse", reason: "intervention_not_on_plan" });
    expect(decideDisciplinePlanDecision([{ ...goalAdd, parentProblemId: other }], facts())).toEqual(
      { kind: "refuse", reason: "parent_problem_not_active" },
    );
    expect(
      decideDisciplinePlanDecision(
        [
          {
            op: "intervention_add",
            goalRefs: [other],
            discipline: "msw",
            scopeText: "x",
            frequencyText: "y",
            frequencyValue: "1:visit:week",
          },
        ],
        facts(),
      ),
    ).toEqual({ kind: "refuse", reason: "goal_ref_not_on_plan" });
    // §2.2.3: a met goal is terminal — cannot be revised.
    expect(
      decideDisciplinePlanDecision(
        [{ op: "goal_update", goalId: GOAL, event: "revise", revisedText: "x" }],
        facts({ goals: new Map([[GOAL, { status: "met", sudRelated: false }]]) }),
      ),
    ).toEqual({ kind: "refuse", reason: "illegal_transition" });
    // a discontinued intervention cannot be discontinued again
    expect(
      decideDisciplinePlanDecision(
        [{ op: "intervention_discontinue", interventionId: INTERVENTION, reason: "r" }],
        facts({ interventions: new Map([[INTERVENTION, { status: "discontinued" }]]) }),
      ),
    ).toEqual({ kind: "refuse", reason: "illegal_transition" });
  });

  it("judges a second mutation on one element against the state the first leaves", () => {
    expect(
      decideDisciplinePlanDecision(
        [
          { op: "goal_update", goalId: GOAL, event: "meet" },
          { op: "goal_update", goalId: GOAL, event: "revise", revisedText: "x" },
        ],
        facts(),
      ),
    ).toEqual({ kind: "refuse", reason: "illegal_transition" });
    expect(
      decideDisciplinePlanDecision(
        [
          { op: "intervention_discontinue", interventionId: INTERVENTION, reason: "a" },
          { op: "intervention_discontinue", interventionId: INTERVENTION, reason: "b" },
        ],
        facts(),
      ),
    ).toEqual({ kind: "refuse", reason: "illegal_transition" });
  });
});

describe("parseDisciplinePlanDecision", () => {
  const envelope = (payload: Record<string, unknown>, over: Record<string, unknown> = {}) => ({
    decisionId: "d1",
    meetingId: "m1",
    patientId: "p1",
    organizationId: ORG,
    payloadSchemaVersion: "2026-01-v1",
    recordedByMembershipId: "u1",
    payload,
    ...over,
  });
  const valid = {
    kind: "discipline_plan_update",
    planKind: "msw_plan",
    mutations: [{ op: "intervention_discontinue", interventionId: INTERVENTION, reason: "r" }],
  };

  it("returns null for another module's arm and parses its own", () => {
    expect(parseDisciplinePlanDecision(ORG, envelope({ kind: "order_request" }))).toBeNull();
    expect(parseDisciplinePlanDecision(ORG, envelope(valid))).toMatchObject({
      decisionId: "d1",
      planKind: "msw_plan",
    });
  });

  it("throws (never silently skips) on tampering: org mismatch, version, plan kind, op, frequency", () => {
    expect(() => parseDisciplinePlanDecision("other-org", envelope(valid))).toThrow(/organization/);
    expect(() =>
      parseDisciplinePlanDecision(ORG, envelope(valid, { payloadSchemaVersion: "2099-01-v9" })),
    ).toThrow(/schema version/);
    expect(() =>
      parseDisciplinePlanDecision(ORG, envelope({ ...valid, planKind: "rn_plan" })),
    ).toThrow(/planKind/);
    expect(() =>
      parseDisciplinePlanDecision(ORG, envelope({ ...valid, mutations: [{ op: "drop_table" }] })),
    ).toThrow(/unsupported/);
    expect(() => parseDisciplinePlanDecision(ORG, envelope({ ...valid, mutations: [] }))).toThrow(
      /mutations/,
    );
    expect(() =>
      parseDisciplinePlanDecision(
        ORG,
        envelope({
          ...valid,
          mutations: [
            {
              op: "intervention_add",
              goalRefs: [],
              discipline: "msw",
              scopeText: "x",
              frequencyText: "y",
              frequencyValue: "often",
            },
          ],
        }),
      ),
    ).toThrow(/frequencyValue/);
  });
});

describe("the M14 discipline_plan_update envelope arm", () => {
  const ok = {
    kind: "discipline_plan_update",
    planKind: "spiritual_plan",
    mutations: [
      {
        op: "goal_add",
        parentProblemId: PROBLEM,
        source: "patient_stated",
        originalText: "I want a chaplain visit each week",
        measurableOutcome: null,
      },
      { op: "goal_update", goalId: GOAL, event: "discontinue", reason: "declined" },
      {
        op: "intervention_add",
        goalRefs: [GOAL],
        discipline: "chaplain",
        scopeText: "Weekly presence",
        frequencyText: "Weekly",
        frequencyValue: "1:visit:week",
      },
      { op: "intervention_discontinue", interventionId: INTERVENTION, reason: "declined" },
    ],
  };

  it("accepts the four ops and rejects a bad plan kind, frequency, empty list and unknown op", () => {
    expect(Value.Check(IDG_DECISION_PAYLOAD_SCHEMA, ok)).toBe(true);
    expect(Value.Check(IDG_DECISION_PAYLOAD_SCHEMA, { ...ok, planKind: "rn_plan" })).toBe(false);
    expect(Value.Check(IDG_DECISION_PAYLOAD_SCHEMA, { ...ok, mutations: [] })).toBe(false);
    expect(
      Value.Check(IDG_DECISION_PAYLOAD_SCHEMA, { ...ok, mutations: [{ op: "problem_add" }] }),
    ).toBe(false);
    expect(
      Value.Check(IDG_DECISION_PAYLOAD_SCHEMA, {
        ...ok,
        mutations: [{ ...ok.mutations[2], frequencyValue: "weekly" }],
      }),
    ).toBe(false);
  });

  it("leaves the existing arms untouched (backward compatible inside 2026-01-v1)", () => {
    expect(Value.Check(IDG_DECISION_PAYLOAD_SCHEMA, { kind: "team_note", noteText: "x" })).toBe(
      true,
    );
    expect(
      Value.Check(IDG_DECISION_PAYLOAD_SCHEMA, {
        kind: "care_plan_update",
        mutations: [
          {
            op: "problem_add",
            icd10Code: null,
            snomedCode: null,
            description: "d",
            problemKind: "related",
          },
        ],
      }),
    ).toBe(true);
  });

  it("declares m15 on idg.decision_recorded and subscribes M14 to the acknowledgement", () => {
    const entry = M14_OUTBOX_EVENTS.find((e) => (e.eventName as string) === "idg.decision_recorded");
    expect(entry?.declaredConsumers).toContain("m15");
    expect(M14_OUTBOX_SUBSCRIPTIONS).toContainEqual({
      eventName: "m15.idg_decision.applied",
      consumerName: "m14.m15-idg-decision-applied",
    });
  });
});
