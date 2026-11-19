// S1 PR C2b1 — the pure rules the Drizzle draft store executes: the care-plan link planners (VN-D8) and the vitals row -> draft input
// mapping (VN-D5, design §3.2 "Vitals"). The tables themselves are proven by the live suite.
import { M8_ACTION_CATALOG } from "@chartwarden/audit";
import { describe, expect, it } from "vitest";
import {
  type LinkRowState,
  carePlanElementsOf,
  isCarePlanRef,
  planLinks,
  planRemovals,
  removedElementIdsOf,
} from "../src/modules/08-encounters/drafting/care-plan-refs";
import { DRAFT_SECTION_AUDIT_EVENT } from "../src/modules/08-encounters/drafting/db-draft-unit";
import {
  type VitalsRow,
  vitalsDraftInput,
} from "../src/modules/08-encounters/drafting/vitals-input";

const AT = new Date("2026-11-18T15:00:00.000Z");
const row = (over: Partial<LinkRowState> = {}): LinkRowState => ({
  id: "r1",
  goalId: null,
  interventionId: null,
  removedAt: null,
  ...over,
});
const goal = (id: string) => ({ kind: "goal", id }) as const;
const intervention = (id: string) => ({ kind: "intervention", id }) as const;

describe("care-plan elements of a section's sources", () => {
  it("keeps goals and interventions, in order, and drops every other kind", () => {
    const refs = [
      { kind: "care_plan_intervention", id: "i1" },
      { kind: "medication_change", id: "o:started" },
      { kind: "care_plan_goal", id: "g1" },
      { kind: "vitals", id: "v1" },
      { kind: "scale_reading", id: "s1" },
    ] as const;
    expect(carePlanElementsOf(refs)).toEqual([intervention("i1"), goal("g1")]);
    expect(refs.filter(isCarePlanRef).map((r) => r.id)).toEqual(["i1", "g1"]);
  });
});

describe("which elements a draft leaves out", () => {
  it("an element with a removed link and no live one is removed", () => {
    expect(removedElementIdsOf([row({ goalId: "g1", removedAt: AT })])).toEqual(new Set(["g1"]));
  });

  it("an element linked again after a removal is back", () => {
    const rows = [row({ id: "a", goalId: "g1", removedAt: AT }), row({ id: "b", goalId: "g1" })];
    expect(removedElementIdsOf(rows)).toEqual(new Set());
  });

  it("a live link on its own removes nothing, and goals and interventions are both read", () => {
    const rows = [
      row({ id: "a", goalId: "g1" }),
      row({ id: "b", interventionId: "i1", removedAt: AT }),
    ];
    expect(removedElementIdsOf(rows)).toEqual(new Set(["i1"]));
  });
});

describe("confirming links the section's elements, once", () => {
  it("adds a live link for an element that has none", () => {
    expect(planLinks([], [goal("g1")])).toEqual([{ op: "insert_live", element: goal("g1") }]);
  });

  it("adds nothing for an element that already has a live link (idempotent)", () => {
    expect(planLinks([row({ goalId: "g1" })], [goal("g1")])).toEqual([]);
  });

  it("does not match a goal against an intervention that happens to share an id", () => {
    expect(planLinks([row({ interventionId: "x" })], [goal("x")])).toEqual([
      { op: "insert_live", element: goal("x") },
    ]);
  });
});

describe("deselecting removes the section's elements", () => {
  it("soft-removes every live link of an element", () => {
    const rows = [row({ id: "a", goalId: "g1" }), row({ id: "b", goalId: "g1" })];
    expect(planRemovals(rows, [goal("g1")])).toEqual([
      { op: "remove_live", element: goal("g1"), rowIds: ["a", "b"] },
    ]);
  });

  it("adds an already-removed tombstone for an element that was never linked", () => {
    expect(planRemovals([], [intervention("i1")])).toEqual([
      { op: "insert_removed", element: intervention("i1") },
    ]);
  });

  it("does nothing for an element whose links are all removed already", () => {
    expect(planRemovals([row({ goalId: "g1", removedAt: AT })], [goal("g1")])).toEqual([]);
  });
});

describe("a vitals row as a draft input", () => {
  const base: VitalsRow = {
    id: "v1",
    capturedAt: new Date("2026-11-18T14:20:00.000Z"),
    bpSystolic: 120,
    bpDiastolic: 70,
    heartRate: 72,
    respiratoryRate: 16,
    temperature: "98.6",
    temperatureUnit: "f",
    spo2: 97,
    painScore: 3,
    painScale: "nrs_0_10",
  };

  it("maps every captured field and the instant as ISO-8601 UTC", () => {
    expect(vitalsDraftInput(base)).toEqual({
      id: "v1",
      recordedAt: "2026-11-18T14:20:00.000Z",
      bpSystolic: 120,
      bpDiastolic: 70,
      heartRate: 72,
      respiratoryRate: 16,
      temperature: "98.6",
      temperatureUnit: "f",
      spo2: 97,
      painScore: 3,
    });
  });

  it("omits what was not captured instead of passing null", () => {
    const sparse = vitalsDraftInput({
      ...base,
      bpSystolic: null,
      bpDiastolic: null,
      heartRate: null,
      respiratoryRate: null,
      temperature: null,
      temperatureUnit: null,
      spo2: null,
      painScore: null,
      painScale: null,
    });
    expect(sparse).toEqual({ id: "v1", recordedAt: "2026-11-18T14:20:00.000Z" });
  });

  it("drops a temperature whose unit is not f or c, and a pain score on any scale but the 0-10 rating", () => {
    const out = vitalsDraftInput({ ...base, temperatureUnit: "kg", painScale: "flacc" });
    expect(out).not.toHaveProperty("temperature");
    expect(out).not.toHaveProperty("temperatureUnit");
    expect(out).not.toHaveProperty("painScore");
  });
});

describe("the explicit audit event of a resolution", () => {
  it("is catalogued, so the audit helper and the catalog agree on its name", () => {
    expect(DRAFT_SECTION_AUDIT_EVENT).toBe("m8.encounter.draft_section_resolved");
    expect(M8_ACTION_CATALOG.map((e) => e.action)).toContain(DRAFT_SECTION_AUDIT_EVENT);
  });
});
