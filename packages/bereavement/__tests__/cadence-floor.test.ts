// @chartwarden/bereavement — ADR-0109 D2/D3/D4: the universal cadence floor, the assessment checkpoints and the
// legacy-mark inference. Pure data and pure functions: no IO.
import { describe, expect, it } from "vitest";

import {
  ASSESSMENT_LATE_GRACE_DAYS,
  BEREAVEMENT_ASSESSMENT_FLOOR,
  BEREAVEMENT_CADENCE_FLOOR,
  type BereavementCadenceMark,
  OUTREACH_DUE_AT_CEILING_DAYS,
  generateAssessmentTasks,
  inferLegacyMark,
} from "../src";

type Tier = "low" | "moderate" | "high" | "complicated";
const TIERS: readonly Tier[] = ["low", "moderate", "high", "complicated"];

const triples = (tier: Tier) =>
  BEREAVEMENT_CADENCE_FLOOR[tier].map((i) => [i.mark, i.offsetDays, i.kind] as const);

describe("ADR-0109 D2 — the universal floor, exactly", () => {
  it("low is the eight-item Medicare-aligned timeline", () => {
    expect(triples("low")).toEqual([
      ["condolence_letter", 2, "sympathy_letter"],
      ["initial_outreach", 28, "phone_call"],
      ["three_month", 90, "phone_call"],
      ["six_month", 180, "phone_call"],
      ["nine_month", 270, "phone_call"],
      ["anniversary", 365, "anniversary_letter"],
      ["anniversary_call", 365, "phone_call"],
      ["closeout_letter", 390, "sympathy_letter"],
    ]);
  });

  it("moderate adds week_2; high adds week_1 and two_month; complicated adds immediate_screen and visits at week_1", () => {
    const marks = (tier: Tier) => new Set(BEREAVEMENT_CADENCE_FLOOR[tier].map((i) => i.mark));
    const added = (higher: Tier, lower: Tier) =>
      [...marks(higher)].filter((m) => !marks(lower).has(m)).sort();
    expect(added("moderate", "low")).toEqual(["week_2"]);
    expect(added("high", "moderate")).toEqual(["two_month", "week_1"]);
    expect(added("complicated", "high")).toEqual(["immediate_screen"]);

    const week2 = BEREAVEMENT_CADENCE_FLOOR.moderate.find((i) => i.mark === "week_2");
    expect([week2?.offsetDays, week2?.kind]).toEqual([14, "phone_call"]);
    const week1 = BEREAVEMENT_CADENCE_FLOOR.high.find((i) => i.mark === "week_1");
    expect([week1?.offsetDays, week1?.kind]).toEqual([7, "phone_call"]);
    const twoMonth = BEREAVEMENT_CADENCE_FLOOR.high.find((i) => i.mark === "two_month");
    expect([twoMonth?.offsetDays, twoMonth?.kind]).toEqual([60, "phone_call"]);
    const screen = BEREAVEMENT_CADENCE_FLOOR.complicated.find((i) => i.mark === "immediate_screen");
    expect([screen?.offsetDays, screen?.kind]).toEqual([2, "phone_call"]);
    const visit = BEREAVEMENT_CADENCE_FLOOR.complicated.find((i) => i.mark === "week_1");
    expect(visit?.kind).toBe("in_person_visit");
  });

  it("counts 8 / 9 / 11 / 12", () => {
    expect(TIERS.map((t) => BEREAVEMENT_CADENCE_FLOOR[t].length)).toEqual([8, 9, 11, 12]);
  });

  it("keeps `one_month` in no tier's floor (deprecated alias only)", () => {
    for (const tier of TIERS) {
      expect(BEREAVEMENT_CADENCE_FLOOR[tier].map((i) => i.mark)).not.toContain("one_month");
    }
  });

  it("is a superset at every step up and stays inside the due_at ceiling", () => {
    for (const [lower, higher] of [
      ["low", "moderate"],
      ["moderate", "high"],
      ["high", "complicated"],
    ] as const) {
      const higherMarks = new Set(BEREAVEMENT_CADENCE_FLOOR[higher].map((i) => i.mark));
      for (const item of BEREAVEMENT_CADENCE_FLOOR[lower])
        expect(higherMarks.has(item.mark)).toBe(true);
    }
    for (const tier of TIERS) {
      for (const item of BEREAVEMENT_CADENCE_FLOOR[tier]) {
        expect(item.offsetDays).toBeLessThanOrEqual(OUTREACH_DUE_AT_CEILING_DAYS);
      }
    }
  });

  it("carries the 9-month milestone on its legacy anniversary mark and no phantom `one_month` reminder", () => {
    for (const tier of TIERS) {
      const anniversaryMarks = BEREAVEMENT_CADENCE_FLOOR[tier]
        .map((i) => i.anniversaryMark)
        .filter((m) => m !== null);
      expect(anniversaryMarks).toEqual([
        "three_month",
        "six_month",
        "nine_month_high_risk_only",
        "anniversary",
      ]);
    }
  });
});

describe("ADR-0109 D3 — assessment checkpoints are not outreach rows", () => {
  it("names the two checkpoints at day 28 and day 180", () => {
    expect(BEREAVEMENT_ASSESSMENT_FLOOR.map((i) => [i.taskKind, i.offsetDays])).toEqual([
      ["initial_assessment", 28],
      ["midpoint_reassessment", 180],
    ]);
  });

  it("anchors each task on the UTC-midnight death date with the late grace after it", () => {
    const tasks = generateAssessmentTasks("2026-03-01");
    expect(tasks.map((t) => t.taskKind)).toEqual(["initial_assessment", "midpoint_reassessment"]);
    expect(tasks[0]?.dueAt).toBe("2026-03-29T00:00:00.000Z");
    const graceMs = ASSESSMENT_LATE_GRACE_DAYS * 86_400_000;
    expect(Date.parse(tasks[0]?.lateGraceUntil ?? "") - Date.parse(tasks[0]?.dueAt ?? "")).toBe(
      graceMs,
    );
  });

  it("is forward-only from a given instant", () => {
    const tasks = generateAssessmentTasks("2026-03-01", { fromIso: "2026-05-01T00:00:00.000Z" });
    expect(tasks.map((t) => t.taskKind)).toEqual(["midpoint_reassessment"]);
  });

  it("refuses a malformed death date", () => {
    expect(() => generateAssessmentTasks("nope")).toThrow(RangeError);
  });
});

describe("ADR-0109 D4 — inferLegacyMark classifies rows written before cadence_mark existed", () => {
  const ANCHOR = "2026-03-01T00:00:00.000Z";
  const row = (
    kind: Parameters<typeof inferLegacyMark>[0]["kind"],
    offsetDays: number,
    anniversaryMark: Parameters<typeof inferLegacyMark>[0]["anniversaryMark"] = null,
  ) => ({
    kind,
    anniversaryMark,
    deathAnchorAt: ANCHOR,
    dueAt: new Date(Date.parse(ANCHOR) + offsetDays * 86_400_000).toISOString(),
  });

  const cases: ReadonlyArray<
    readonly [string, ReturnType<typeof row>, BereavementCadenceMark | null]
  > = [
    ["old condolence letter (d7)", row("sympathy_letter", 7), "condolence_letter"],
    ["new condolence letter (d2)", row("sympathy_letter", 2), "condolence_letter"],
    ["old one_month call", row("phone_call", 30, "one_month"), "one_month"],
    ["new initial outreach (d28)", row("phone_call", 28), "initial_outreach"],
    ["three-month call", row("phone_call", 90, "three_month"), "three_month"],
    ["six-month call", row("phone_call", 180, "six_month"), "six_month"],
    ["nine-month call", row("phone_call", 270, "nine_month_high_risk_only"), "nine_month"],
    ["anniversary letter", row("anniversary_letter", 365, "anniversary"), "anniversary"],
    [
      "a letter-only survivor's anniversary",
      row("sympathy_letter", 365, "anniversary"),
      "anniversary",
    ],
    ["anniversary call", row("phone_call", 365), "anniversary_call"],
    ["closeout letter", row("sympathy_letter", 390), "closeout_letter"],
    ["week-1 call (d7, not a letter)", row("phone_call", 7), "week_1"],
    ["complicated week-1 visit", row("in_person_visit", 7), "week_1"],
    ["week-2 call", row("phone_call", 14), "week_2"],
    ["two-month call", row("phone_call", 60), "two_month"],
    ["immediate screen", row("phone_call", 2), "immediate_screen"],
    ["an ad-hoc touchpoint off the floor", row("phone_call", 100), null],
    ["an ad-hoc letter off the floor", row("sympathy_card", 45), null],
  ];

  for (const [name, input, expected] of cases) {
    it(`${name} -> ${expected ?? "null"}`, () => {
      expect(inferLegacyMark(input)).toBe(expected);
    });
  }
});
