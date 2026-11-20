// apps/backend/__tests__/care-plan-change-proposal-rules.test.ts — WF09: the pure half of the plan-of-care change proposals (no DB).
// What a proposal body may carry per kind, how it maps onto the table's columns and back, and that the three places the value sets
// live (the schema constants, migration 1530's CHECKs, the element enums they mirror) cannot drift apart.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CARE_PLAN_CHANGE_PROPOSAL_DISCIPLINES,
  CARE_PLAN_CHANGE_PROPOSAL_DISMISSAL_REASONS,
  CARE_PLAN_CHANGE_PROPOSAL_GOAL_SOURCES,
  CARE_PLAN_CHANGE_PROPOSAL_GOAL_STATUSES,
  CARE_PLAN_CHANGE_PROPOSAL_KINDS,
  CARE_PLAN_CHANGE_PROPOSAL_PROBLEM_KINDS,
  CARE_PLAN_CHANGE_PROPOSAL_PROBLEM_SOURCES,
  CARE_PLAN_CHANGE_PROPOSAL_STATUSES,
  carePlanChangeProposals,
  goalSource,
  goalStatus,
  interventionDiscipline,
  problemKind,
  problemSource,
} from "@chartwarden/db/schema";
import { parse } from "@chartwarden/shared/route-kit";
import { getTableColumns } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  assertChangeConsistent,
  changeViewOf,
  columnsOf,
  targetRefOf,
} from "../src/modules/07-care-plan/change-proposals-rules";
import {
  type ChangeProposalChange,
  CreateChangeProposalSchema,
  DismissChangeProposalSchema,
  ReplaceChangeProposalSchema,
} from "../src/modules/07-care-plan/routes/change-proposal-typebox";

const PROBLEM = "11111111-1111-4111-8111-111111111111";
const GOAL = "22222222-2222-4222-8222-222222222222";
const GOAL_2 = "33333333-3333-4333-8333-333333333333";
const INTERVENTION = "44444444-4444-4444-8444-444444444444";
const ENCOUNTER = "55555555-5555-4555-8555-555555555555";
const PARENT = "66666666-6666-4666-8666-666666666666";

const MIGRATION = readFileSync(
  join(__dirname, "../../../packages/db/migrations/1530_m7_care_plan_change_proposal.sql"),
  "utf8",
);

const ALL_CHANGES: readonly ChangeProposalChange[] = [
  {
    kind: "problem_add",
    description: "Uncontrolled pain (synthetic)",
    problemKind: "related",
    sudRelated: false,
  },
  { kind: "problem_resolve", problemId: PROBLEM, resolutionNote: "Pain controlled (synthetic)" },
  { kind: "goal_add", problemId: PROBLEM, originalText: "Sleep through the night (synthetic)" },
  { kind: "goal_update", goalId: GOAL, goalStatus: "in_progress" },
  {
    kind: "intervention_add",
    problemId: PROBLEM,
    scopeText: "Reassess pain",
    frequencyText: "weekly",
    frequencyValue: "1:visit:week",
    discipline: "rn",
  },
  { kind: "intervention_discontinue", interventionId: INTERVENTION, reason: "No longer needed" },
];

describe("the value sets cannot drift (schema constants, migration 1530, element enums)", () => {
  const sets: ReadonlyArray<readonly [string, readonly string[]]> = [
    ["kinds", CARE_PLAN_CHANGE_PROPOSAL_KINDS],
    ["statuses", CARE_PLAN_CHANGE_PROPOSAL_STATUSES],
    ["dismissal reasons", CARE_PLAN_CHANGE_PROPOSAL_DISMISSAL_REASONS],
    ["problem kinds", CARE_PLAN_CHANGE_PROPOSAL_PROBLEM_KINDS],
    ["problem sources", CARE_PLAN_CHANGE_PROPOSAL_PROBLEM_SOURCES],
    ["goal sources", CARE_PLAN_CHANGE_PROPOSAL_GOAL_SOURCES],
    ["goal statuses", CARE_PLAN_CHANGE_PROPOSAL_GOAL_STATUSES],
    ["disciplines", CARE_PLAN_CHANGE_PROPOSAL_DISCIPLINES],
  ];

  it.each(sets)(
    "migration 1530 lists every %s value in its CHECK, and nothing else",
    (_name, values) => {
      // Each value appears quoted in the migration…
      for (const value of values) expect(MIGRATION).toContain(`'${value}'`);
    },
  );

  it("each CHECK list in the migration equals its constant exactly", () => {
    const listOf = (constraint: string): string[] => {
      const line = MIGRATION.split("\n").find((l) =>
        l.includes(`"care_plan_change_proposal_${constraint}"`),
      );
      if (!line) throw new Error(`constraint ${constraint} not found`);
      return [...line.matchAll(/'([a-z0-9_]+)'/g)].map((m) => m[1] as string);
    };
    expect(listOf("kind_known")).toEqual([...CARE_PLAN_CHANGE_PROPOSAL_KINDS]);
    expect(listOf("status_known")).toEqual([...CARE_PLAN_CHANGE_PROPOSAL_STATUSES]);
    expect(listOf("problem_kind_known")).toEqual([...CARE_PLAN_CHANGE_PROPOSAL_PROBLEM_KINDS]);
    expect(listOf("problem_source_known")).toEqual([...CARE_PLAN_CHANGE_PROPOSAL_PROBLEM_SOURCES]);
    expect(listOf("goal_source_known")).toEqual([...CARE_PLAN_CHANGE_PROPOSAL_GOAL_SOURCES]);
    expect(listOf("goal_status_known")).toEqual([...CARE_PLAN_CHANGE_PROPOSAL_GOAL_STATUSES]);
    expect(listOf("discipline_known")).toEqual([...CARE_PLAN_CHANGE_PROPOSAL_DISCIPLINES]);
    expect(listOf("dismissal_reason_known")).toEqual([
      ...CARE_PLAN_CHANGE_PROPOSAL_DISMISSAL_REASONS,
    ]);
  });

  it("every proposable value is one the element table itself accepts", () => {
    expect([...CARE_PLAN_CHANGE_PROPOSAL_PROBLEM_KINDS]).toEqual([...problemKind.enumValues]);
    expect([...CARE_PLAN_CHANGE_PROPOSAL_DISCIPLINES]).toEqual([
      ...interventionDiscipline.enumValues,
    ]);
    for (const v of CARE_PLAN_CHANGE_PROPOSAL_PROBLEM_SOURCES)
      expect(problemSource.enumValues).toContain(v);
    for (const v of CARE_PLAN_CHANGE_PROPOSAL_GOAL_SOURCES)
      expect(goalSource.enumValues).toContain(v);
    for (const v of CARE_PLAN_CHANGE_PROPOSAL_GOAL_STATUSES)
      expect(goalStatus.enumValues).toContain(v);
  });

  it("a visit can claim neither DocLens' intake_extraction, a DPOA agent_stated goal nor a not_started move", () => {
    expect(CARE_PLAN_CHANGE_PROPOSAL_PROBLEM_SOURCES).not.toContain("intake_extraction");
    expect(CARE_PLAN_CHANGE_PROPOSAL_GOAL_SOURCES).not.toContain("agent_stated");
    expect(CARE_PLAN_CHANGE_PROPOSAL_GOAL_STATUSES).not.toContain("not_started");
  });

  it("the audit trigger scrubs every free-text column (twelve with the diagnosis codes), and no enum or id column", () => {
    const lists = [
      ...MIGRATION.matchAll(/audit_scrub\(to_jsonb\((?:OLD|NEW)\), ARRAY\[([^\]]+)\]::text\[\]\)/g),
    ].map((m) => [...(m[1] ?? "").matchAll(/'(\w+)'/g)].map((c) => c[1]).sort());
    // Before and after images scrub the same columns.
    expect(lists).toHaveLength(2);
    expect(lists[0]).toEqual(lists[1]);
    // A SUD diagnosis code on a Part 2 proposal is as identifying as its description; a role name is free text.
    expect(lists[0]).toEqual(
      [
        "description",
        "icd10_code",
        "snomed_code",
        "resolution_note",
        "goal_text",
        "measurable_outcome",
        "revised_text",
        "scope_text",
        "frequency_text",
        "frequency_value", // a free string at proposal time (the cadence format is only checked when the proposal is accepted)
        "responsible_role",
        "discontinue_reason",
      ].sort(),
    );
  });
});

describe("the request contract", () => {
  it("accepts one valid body per kind, with the visit on create", () => {
    for (const change of ALL_CHANGES) {
      expect(() => parse(ReplaceChangeProposalSchema, change)).not.toThrow();
      expect(() =>
        parse(CreateChangeProposalSchema, { ...change, sourceEncounterId: ENCOUNTER }),
      ).not.toThrow();
    }
  });

  it("refuses a create without the visit it was recorded in", () => {
    expect(() => parse(CreateChangeProposalSchema, ALL_CHANGES[0])).toThrow();
  });

  it.each([
    ["an unknown kind", { kind: "problem_delete", problemId: PROBLEM }],
    ["a field the kind does not take", { ...ALL_CHANGES[1], description: "x" }],
    ["a status field smuggled in", { ...ALL_CHANGES[0], status: "accepted" }],
    ["a DPOA agent_stated goal", { ...ALL_CHANGES[2], goalSource: "agent_stated" }],
    [
      "a DocLens intake_extraction problem",
      { ...ALL_CHANGES[0], problemSource: "intake_extraction" },
    ],
    ["a goal moved back to not_started", { ...ALL_CHANGES[3], goalStatus: "not_started" }],
    ["an empty resolution note", { ...ALL_CHANGES[1], resolutionNote: "" }],
    ["a non-uuid target", { ...ALL_CHANGES[1], problemId: "cp_1" }],
  ])("refuses %s", (_name, body) => {
    expect(() => parse(ReplaceChangeProposalSchema, body)).toThrow();
  });

  it("takes an optional coded dismissal reason and nothing free-form", () => {
    expect(() => parse(DismissChangeProposalSchema, {})).not.toThrow();
    expect(() => parse(DismissChangeProposalSchema, { reason: "duplicate" })).not.toThrow();
    expect(() => parse(DismissChangeProposalSchema, { reason: "because I said so" })).toThrow();
  });
});

describe("assertChangeConsistent", () => {
  it("accepts every well-formed change", () => {
    for (const change of ALL_CHANGES) expect(() => assertChangeConsistent(change)).not.toThrow();
  });

  it.each(["goal_add", "intervention_add"] as const)(
    "%s names exactly one of an existing problem or a proposed one",
    (kind) => {
      const base = ALL_CHANGES.find((c) => c.kind === kind) as ChangeProposalChange;
      const none = { ...base, problemId: undefined } as ChangeProposalChange;
      const both = {
        ...base,
        problemId: PROBLEM,
        parentProposalId: PARENT,
      } as ChangeProposalChange;
      const parentOnly = {
        ...base,
        problemId: undefined,
        parentProposalId: PARENT,
      } as ChangeProposalChange;
      expect(() => assertChangeConsistent(none)).toThrow(/problem/i);
      expect(() => assertChangeConsistent(both)).toThrow(/problem/i);
      expect(() => assertChangeConsistent(parentOnly)).not.toThrow();
    },
  );

  it("a goal update must change something", () => {
    expect(() =>
      assertChangeConsistent({ kind: "goal_update", goalId: GOAL } as ChangeProposalChange),
    ).toThrow(/change/i);
  });

  it("an intervention needs a real frequency, as the manual route does", () => {
    const blank = { ...ALL_CHANGES[4], frequencyValue: "   " } as ChangeProposalChange;
    expect(() => assertChangeConsistent(blank)).toThrow(/frequency/i);
  });
});

describe("columnsOf / changeViewOf", () => {
  it("fills only the columns the kind uses and nulls every other one (so a replace clears the old kind's)", () => {
    const resolve = columnsOf(ALL_CHANGES[1] as ChangeProposalChange);
    expect(resolve).toMatchObject({
      kind: "problem_resolve",
      targetElementId: PROBLEM,
      resolutionNote: "Pain controlled (synthetic)",
      problemId: null,
      parentProposalId: null,
      description: null,
      goalText: null,
      scopeText: null,
      discontinueReason: null,
      goalRefs: [],
      sudRelated: null,
    });
  });

  it("defaults the problem and goal source to clinical", () => {
    expect(columnsOf(ALL_CHANGES[0] as ChangeProposalChange)).toMatchObject({
      problemSource: "clinical",
      problemKind: "related",
      sudRelated: false,
    });
    expect(columnsOf(ALL_CHANGES[2] as ChangeProposalChange)).toMatchObject({
      goalSource: "clinical",
      goalText: "Sleep through the night (synthetic)",
      problemId: PROBLEM,
    });
  });

  it("maps a goal on a proposed problem to parentProposalId, and de-duplicates goalRefs", () => {
    const cols = columnsOf({
      ...(ALL_CHANGES[4] as ChangeProposalChange),
      problemId: undefined,
      parentProposalId: PARENT,
      goalRefs: [GOAL, GOAL_2, GOAL],
    } as ChangeProposalChange);
    expect(cols).toMatchObject({ problemId: null, parentProposalId: PARENT });
    expect(cols.goalRefs).toEqual([GOAL, GOAL_2]);
  });

  it("round-trips a change into the read view under the request's own field names", () => {
    const row = { ...columnsOf(ALL_CHANGES[4] as ChangeProposalChange) };
    const view = changeViewOf(row as never);
    expect(view).toMatchObject({
      scopeText: "Reassess pain",
      frequencyText: "weekly",
      frequencyValue: "1:visit:week",
      discipline: "rn",
      goalRefs: [],
      description: null,
      reason: null,
    });
    expect(changeViewOf(columnsOf(ALL_CHANGES[5] as ChangeProposalChange) as never).reason).toBe(
      "No longer needed",
    );
  });

  it("names the element each kind touches", () => {
    expect(targetRefOf(columnsOf(ALL_CHANGES[0] as ChangeProposalChange) as never)).toBeNull();
    expect(targetRefOf(columnsOf(ALL_CHANGES[1] as ChangeProposalChange) as never)).toEqual({
      type: "problem",
      id: PROBLEM,
    });
    expect(targetRefOf(columnsOf(ALL_CHANGES[2] as ChangeProposalChange) as never)).toEqual({
      type: "problem",
      id: PROBLEM,
    });
    expect(targetRefOf(columnsOf(ALL_CHANGES[3] as ChangeProposalChange) as never)).toEqual({
      type: "goal",
      id: GOAL,
    });
    expect(targetRefOf(columnsOf(ALL_CHANGES[5] as ChangeProposalChange) as never)).toEqual({
      type: "intervention",
      id: INTERVENTION,
    });
    const onProposed = columnsOf({
      ...(ALL_CHANGES[2] as ChangeProposalChange),
      problemId: undefined,
      parentProposalId: PARENT,
    } as ChangeProposalChange);
    expect(targetRefOf(onProposed as never)).toEqual({ type: "problem", id: null });
  });
});

describe("migration 1530 limits what the application role may update", () => {
  const columns = getTableColumns(carePlanChangeProposals);
  const columnOf = (key: string): string => (columns as Record<string, { name: string }>)[key].name;
  const granted = new Set(
    [
      ...(
        /GRANT UPDATE \(([^)]*)\) ON "care_plan_change_proposal" TO chartwarden_app/.exec(
          MIGRATION,
        )?.[1] ?? ""
      ).matchAll(/"(\w+)"/g),
    ].map((m) => m[1] as string),
  );
  const IDENTITY = [
    "id",
    "organization_id",
    "care_plan_id",
    "patient_id",
    "source_encounter_id",
    "proposed_by_membership_id",
    "created_at",
  ];

  it("grants UPDATE per column, never on the whole table", () => {
    expect(granted.size).toBeGreaterThan(0);
    expect(MIGRATION).not.toMatch(
      /GRANT[^;]*\bUPDATE\b[^;(]*ON "care_plan_change_proposal" TO chartwarden_app/,
    );
  });

  it("grants every column a replace writes, the Part 2 flag, and the lifecycle columns the decisions write", () => {
    const written = [
      ...Object.keys(columnsOf(ALL_CHANGES[0] as ChangeProposalChange)),
      "status",
      "releasedAt",
      "decidedByMembershipId",
      "decidedAt",
      "resultElementId",
      "dismissalReason",
      "updatedAt",
    ].map(columnOf);
    for (const column of written) expect(granted, column).toContain(column);
  });

  it("grants none of the plan, patient, visit, proposer or creation-time columns", () => {
    for (const column of IDENTITY) expect(granted, column).not.toContain(column);
  });

  it("refuses a change to those columns for every role, with a guard trigger", () => {
    const guard =
      /CREATE OR REPLACE FUNCTION care_plan_change_proposal_update_guard\(\)[\s\S]*?END \$\$;/.exec(
        MIGRATION,
      )?.[0];
    expect(guard).toBeDefined();
    for (const column of IDENTITY) expect(guard, column).toContain(`NEW.${column}`);
    expect(MIGRATION).toMatch(
      /CREATE TRIGGER "trg_care_plan_change_proposal_update_guard"\s+BEFORE UPDATE ON "care_plan_change_proposal"/,
    );
  });

  it("makes a decided or withdrawn proposal final, and a released Part 2 proposal stay Part 2, for every role", () => {
    const guard =
      /CREATE OR REPLACE FUNCTION care_plan_change_proposal_update_guard\(\)[\s\S]*?END \$\$;/.exec(
        MIGRATION,
      )?.[0] as string;
    expect(guard).toMatch(/OLD\.status IN \('accepted', 'dismissed', 'withdrawn'\)/);
    expect(guard).toMatch(/OLD\.sud_related AND NOT NEW\.sud_related AND OLD\.status <> 'draft'/);
    // Both refuse with the check-violation class the other table rules use.
    expect(guard.match(/ERRCODE = '23514'/g)).toHaveLength(3);
  });

  it("stays an expand migration with forced RLS and the audit trigger", () => {
    expect(MIGRATION.split("\n")[0]).toBe("-- compat: expand");
    expect(MIGRATION).toContain('ALTER TABLE "care_plan_change_proposal" FORCE ROW LEVEL SECURITY');
    expect(MIGRATION).toContain("trg_audit_care_plan_change_proposal");
  });
});
