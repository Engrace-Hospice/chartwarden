// The dyspnea-assessment rules shared by the composer's helper and the plan-of-care prompt. Dyspnea has NO severity band, rise
// threshold, vital-sign trigger or behavioural-scale cut-off (no source defines one; see the module header and
// docs/research/DYSPNEA_ASSESSMENT_AND_PLAN_OF_CARE_RESEARCH.md), so the hard limits are pinned here as tests: a numeric score is
// only ever compared with the clinician's own typed goal, and a high score alone triggers nothing beyond the impact statement itself.
import { describe, expect, it } from "vitest";
import {
  DYSPNEA_ASSESSMENT_CODES as C,
  DYSPNEA_CHANGE_OPTIONS,
  DYSPNEA_CHARACTERISTICS,
  DYSPNEA_CHARACTERISTIC_LABELS,
  DYSPNEA_PLAN_DECISIONS,
  DYSPNEA_RESPONSE_OPTIONS,
  DYSPNEA_SETTING_OPTIONS,
  type DyspneaSelection,
  DYSPNEA_STATEMENT_CODE as IMPACT,
  dyspneaCompleteness,
  dyspneaFactsFrom,
  dyspneaPlanReviewReasons,
  dyspneaPlanReviewReference,
  isDyspneaAssessmentCode,
} from "../src/dyspnea-assessment";
import { PAIN_PLAN_DECISIONS, PLAN_REVIEW_BASIS_LABELS } from "../src/pain-assessment";

const impact = (): DyspneaSelection => ({
  code: IMPACT,
  params: { ambulation_distance: "25 feet" },
});
const text = (code: string, slot: string, value: string | number): DyspneaSelection => ({
  code,
  params: { [slot]: value },
});
const score = (value: string | number): DyspneaSelection => text(C.score, "dyspnea_score", value);
const goal = (value: string | number): DyspneaSelection => text(C.goal, "dyspnea_goal", value);
const change = (value: string): DyspneaSelection => text(C.change, "dyspnea_change", value);
const response = (value: string): DyspneaSelection => text(C.response, "dyspnea_response", value);
const ids = (selections: readonly DyspneaSelection[]): string[] =>
  dyspneaPlanReviewReasons(selections).map((r) => r.id);

describe("the pinned values", () => {
  it("carry the lists the corpus offers and the characteristics the sources name", () => {
    expect(DYSPNEA_CHARACTERISTICS).toEqual([
      "intensity",
      "onset",
      "setting",
      "triggers",
      "relieved_by",
      "quality",
      "distress",
      "function",
    ]);
    expect(DYSPNEA_SETTING_OPTIONS).toEqual([
      "at rest",
      "on exertion",
      "at rest and on exertion",
      "at other times",
    ]);
    expect(DYSPNEA_RESPONSE_OPTIONS).toEqual([
      "complete relief",
      "partial relief",
      "no relief",
      "no measures tried",
    ]);
    expect(DYSPNEA_CHANGE_OPTIONS).toEqual(["improved", "unchanged", "worsened", "new dyspnea"]);
    expect(DYSPNEA_PLAN_DECISIONS).toEqual([...PAIN_PLAN_DECISIONS]);
  });

  it("label every characteristic", () => {
    for (const characteristic of DYSPNEA_CHARACTERISTICS) {
      expect(DYSPNEA_CHARACTERISTIC_LABELS[characteristic].length).toBeGreaterThan(0);
    }
  });
});

describe("isDyspneaAssessmentCode", () => {
  it("is true for the helper's statements and false for the impact statement, pain statements and anything else", () => {
    expect(isDyspneaAssessmentCode(C.score)).toBe(true);
    expect(isDyspneaAssessmentCode(C.planDecision)).toBe(true);
    expect(isDyspneaAssessmentCode(IMPACT)).toBe(false);
    expect(isDyspneaAssessmentCode("nv.sym.pain_goal")).toBe(false);
    expect(isDyspneaAssessmentCode("nv.resp.dyspnea")).toBe(false);
  });

  it("covers all fifteen statements", () => {
    expect(Object.values(C)).toHaveLength(15);
    expect(Object.values(C).every(isDyspneaAssessmentCode)).toBe(true);
  });
});

describe("dyspneaFactsFrom", () => {
  it("reads a number typed in the form (a string) and a stored one (a number) alike", () => {
    expect(dyspneaFactsFrom([score("6")]).score).toBe(6);
    expect(dyspneaFactsFrom([score(6)]).score).toBe(6);
    expect(dyspneaFactsFrom([score(" 6 ")]).score).toBe(6);
    expect(dyspneaFactsFrom([score(0)]).score).toBe(0);
    expect(dyspneaFactsFrom([score(10)]).score).toBe(10);
  });

  it("ignores a value that is blank, not a number, or off the 0 to 10 scale", () => {
    for (const bad of ["", "  ", "six", "11", "-1", "NaN", "1e1", "5 of 10", Number.NaN, 11, -1]) {
      expect(dyspneaFactsFrom([score(bad)]).score, String(bad)).toBeNull();
    }
  });

  it("reads the goal from its own statement and carries no last-visit score (no rule reads one)", () => {
    const facts = dyspneaFactsFrom([
      score("7"),
      goal("3"),
      text(C.lastScore, "dyspnea_last_score", "5"),
    ]);
    expect(facts).toEqual({
      hasDyspneaStatement: false,
      score: 7,
      goal: 3,
      change: null,
      response: null,
    });
  });

  it("reports whether the impact statement is picked, and nothing is recorded by default", () => {
    expect(dyspneaFactsFrom([impact()]).hasDyspneaStatement).toBe(true);
    expect(dyspneaFactsFrom([score("4")]).hasDyspneaStatement).toBe(false);
    expect(dyspneaFactsFrom([])).toEqual({
      hasDyspneaStatement: false,
      score: null,
      goal: null,
      change: null,
      response: null,
    });
  });

  it("accepts only the offered choices, and never a pain statement's wording", () => {
    expect(dyspneaFactsFrom([change("worsened")]).change).toBe("worsened");
    expect(dyspneaFactsFrom([change("new dyspnea")]).change).toBe("new dyspnea");
    expect(dyspneaFactsFrom([change("new pain")]).change).toBeNull();
    expect(dyspneaFactsFrom([change("a bit worse")]).change).toBeNull();
    expect(dyspneaFactsFrom([response("no relief")]).response).toBe("no relief");
    expect(dyspneaFactsFrom([response("no dose taken")]).response).toBeNull();
  });

  it("tolerates a selection with no params, an unset slot, the wrong slot, or a junk value", () => {
    const junk: readonly DyspneaSelection[] = [
      { code: C.score },
      { code: C.goal, params: {} },
      { code: C.lastScore, params: { dyspnea_last_score: undefined } },
      { code: C.change, params: { pain_change: "worsened" } },
      { code: C.response, params: { dyspnea_response: Number.NaN } },
      { code: "nv.unknown", params: { dyspnea_score: "9" } },
    ];
    expect(dyspneaFactsFrom(junk)).toEqual({
      hasDyspneaStatement: false,
      score: null,
      goal: null,
      change: null,
      response: null,
    });
  });
});

describe("dyspneaCompleteness", () => {
  it("is empty and 0 of 8 when nothing is recorded", () => {
    const result = dyspneaCompleteness([]);
    expect(result).toEqual({
      documented: [],
      missing: [...DYSPNEA_CHARACTERISTICS],
      count: 0,
      total: 8,
    });
  });

  it("counts the effect on function from the impact statement alone", () => {
    const result = dyspneaCompleteness([impact()]);
    expect(result.documented).toEqual(["function"]);
    expect(result.count).toBe(1);
    expect(result.total).toBe(8);
    expect(result.missing).toEqual([
      "intensity",
      "onset",
      "setting",
      "triggers",
      "relieved_by",
      "quality",
      "distress",
    ]);
  });

  it("counts the effect on function from the function text without the impact statement", () => {
    const only = dyspneaCompleteness([text(C.function, "dyspnea_function", "cannot climb stairs")]);
    expect(only.documented).toEqual(["function"]);
  });

  it("counts the effect on function once when both the impact statement and the text are present", () => {
    const both = dyspneaCompleteness([
      impact(),
      text(C.function, "dyspnea_function", "cannot climb stairs"),
    ]);
    expect(both.documented).toEqual(["function"]);
    expect(both.count).toBe(1);
  });

  it("does not count blank function text unless the impact statement is picked", () => {
    const blank = text(C.function, "dyspnea_function", "  ");
    expect(dyspneaCompleteness([blank]).documented).toEqual([]);
    expect(dyspneaCompleteness([impact(), blank]).documented).toEqual(["function"]);
  });

  it("counts a characteristic only once its value is filled in", () => {
    const blank = dyspneaCompleteness([text(C.onset, "dyspnea_onset", "  ")]);
    expect(blank.documented).not.toContain("onset");
    const filled = dyspneaCompleteness([text(C.onset, "dyspnea_onset", "two days ago")]);
    expect(filled.documented).toContain("onset");
  });

  it("counts intensity from the score statement, and not when the score is blank or off the scale", () => {
    expect(dyspneaCompleteness([score("4")]).documented).toEqual(["intensity"]);
    expect(dyspneaCompleteness([score("0")]).documented).toEqual(["intensity"]);
    expect(dyspneaCompleteness([score("")]).documented).toEqual([]);
    expect(dyspneaCompleteness([score("11")]).documented).toEqual([]);
  });

  it("counts intensity from the signs observed in a patient who cannot self-report, without a score", () => {
    const signs = text(C.nonverbal, "dyspnea_nonverbal", "accessory muscle use");
    expect(dyspneaCompleteness([signs]).documented).toEqual(["intensity"]);
    const both = dyspneaCompleteness([signs, score("4")]);
    expect(both.documented).toEqual(["intensity"]);
    expect(both.count).toBe(1);
  });

  it("does not count intensity from blank signs observed or from a blank score beside them", () => {
    const blankSigns = text(C.nonverbal, "dyspnea_nonverbal", "  ");
    expect(dyspneaCompleteness([blankSigns]).documented).toEqual([]);
    expect(dyspneaCompleteness([blankSigns, score("")]).documented).toEqual([]);
  });

  it("counts each of the other characteristics from its own statement", () => {
    const cases: readonly [string, string, string, string][] = [
      ["onset", C.onset, "dyspnea_onset", "gradual"],
      ["setting", C.setting, "dyspnea_setting", "on exertion"],
      ["triggers", C.triggers, "dyspnea_triggers", "lying flat"],
      ["relieved_by", C.relievedBy, "dyspnea_relieved_by", "sitting upright"],
      ["quality", C.quality, "dyspnea_quality", "air hunger"],
      ["distress", C.distress, "dyspnea_distress", "anxious at night"],
    ];
    for (const [characteristic, code, slot, value] of cases) {
      expect(dyspneaCompleteness([text(code, slot, value)]).documented, characteristic).toEqual([
        characteristic,
      ]);
    }
  });

  it("is a count of documented items, in the characteristics' order, with no benchmark", () => {
    const all = dyspneaCompleteness([
      text(C.distress, "dyspnea_distress", "anxious"),
      impact(),
      score("5"),
      text(C.onset, "dyspnea_onset", "last week"),
    ]);
    expect(all.documented).toEqual(["intensity", "onset", "distress", "function"]);
    expect(all.count).toBe(4);
    expect(Object.keys(all).sort()).toEqual(["count", "documented", "missing", "total"]);
  });

  it("does not count the statements that are not one of the eight", () => {
    const extras = dyspneaCompleteness([
      text(C.nonDrug, "dyspnea_nondrug", "a fan"),
      response("partial relief"),
      goal("3"),
      text(C.lastScore, "dyspnea_last_score", "4"),
      change("worsened"),
      text(C.planDecision, "dyspnea_plan_decision", "physician notified"),
    ]);
    expect(extras.count).toBe(0);
  });
});

describe("dyspneaPlanReviewReasons", () => {
  it("is empty when nothing applies, with or without the impact statement", () => {
    expect(ids([])).toEqual([]);
    expect(ids([score("9")])).toEqual([]);
    expect(ids([score("3"), goal("3"), change("improved"), response("partial relief")])).toEqual(
      [],
    );
  });

  it("names only the function limit when the impact statement alone is picked", () => {
    expect(ids([impact()])).toEqual(["function_limit"]);
  });

  describe("without the impact statement (unticking it never hides what the helper rows show)", () => {
    it("names the function limit only when the impact statement is picked", () => {
      expect(ids([score("9"), goal("2"), change("worsened"), response("no relief")])).not.toContain(
        "function_limit",
      );
      expect(ids([impact(), score("9"), goal("2")])).toContain("function_limit");
    });
    it("still names a score above the goal", () => {
      expect(ids([score("5"), goal("3")])).toEqual(["above_goal"]);
    });
    it("still names worsening", () => {
      expect(ids([change("worsened")])).toEqual(["worsening"]);
    });
    it("still names new dyspnea", () => {
      expect(ids([change("new dyspnea")])).toEqual(["new_dyspnea"]);
    });
    it("still names no relief", () => {
      expect(ids([response("no relief")])).toEqual(["not_relieved"]);
    });
    it("lists them in the fixed order", () => {
      expect(ids([response("no relief"), change("worsened"), goal("3"), score("8")])).toEqual([
        "above_goal",
        "worsening",
        "not_relieved",
      ]);
    });
    it("gives the same reasons as with the impact statement, less the function limit", () => {
      const rest = [score("8"), goal("3"), change("new dyspnea"), response("no relief")];
      expect(ids(rest)).toEqual(ids([impact(), ...rest]).filter((id) => id !== "function_limit"));
    });
  });

  it("states the function limit as a guideline-based prompt that the goal may not be met", () => {
    const [reason] = dyspneaPlanReviewReasons([impact()]);
    expect(reason).toEqual({
      id: "function_limit",
      text: "Dyspnea is limiting function, so any comfort and function goal in the plan of care may not be met.",
      basis: "guideline",
      source:
        "National Consensus Project guidelines 4th ed. 2.1.1 and 2.3.4; CMS State Operations Manual, Appendix M, 418.56(c)(1) (re-evaluate the current plan of care)",
    });
  });

  describe("above the patient's own acceptable level", () => {
    it("fires when the score is above the goal", () => {
      expect(ids([impact(), score("5"), goal("3")])).toContain("above_goal");
    });
    it("does not fire at the goal or below it", () => {
      expect(ids([impact(), score("3"), goal("3")])).not.toContain("above_goal");
      expect(ids([impact(), score("2"), goal("3")])).not.toContain("above_goal");
    });
    it("does not fire without a goal or without a score", () => {
      expect(ids([impact(), score("9")])).not.toContain("above_goal");
      expect(ids([impact(), goal("3")])).not.toContain("above_goal");
    });
    it("states both numbers as typed, as common practice", () => {
      const reason = dyspneaPlanReviewReasons([impact(), score("5"), goal("3")]).find(
        (r) => r.id === "above_goal",
      );
      expect(reason).toEqual({
        id: "above_goal",
        text: "Dyspnea is 5 of 10, above the patient's own acceptable level of 3.",
        basis: "common_practice",
        source:
          "NHPCO Care Planning Primer (2023): a goal not met means the interventions are reviewed; National Consensus Project guidelines 4th ed. 2.1.1",
      });
    });
  });

  describe("worse than, or new since, the last visit", () => {
    const cmsSource =
      "CMS State Operations Manual, Appendix M, 418.56(c)(1) (re-evaluate the current plan of care); 42 CFR 418.54(d) and 418.56(d) set only a general duty to update as often as the condition requires";
    it("names worsening, as CMS guidance and not as a CMS rule", () => {
      const reason = dyspneaPlanReviewReasons([impact(), change("worsened")]).find(
        (r) => r.id === "worsening",
      );
      expect(reason).toEqual({
        id: "worsening",
        text: "Dyspnea is worse than at the last visit.",
        basis: "cms_guidance",
        source: cmsSource,
      });
      expect(PLAN_REVIEW_BASIS_LABELS[reason?.basis ?? "regulation"]).toBe("CMS guidance");
    });
    it("names new dyspnea, with the same basis and source", () => {
      const reason = dyspneaPlanReviewReasons([impact(), change("new dyspnea")]).find(
        (r) => r.id === "new_dyspnea",
      );
      expect(reason).toEqual({
        id: "new_dyspnea",
        text: "This dyspnea is new since the last visit.",
        basis: "cms_guidance",
        source: cmsSource,
      });
    });
    it("names neither for improved or unchanged", () => {
      expect(ids([impact(), change("improved")])).toEqual(["function_limit"]);
      expect(ids([impact(), change("unchanged")])).toEqual(["function_limit"]);
    });
    it("is decided by what the clinician chose, never by the two scores", () => {
      const last = text(C.lastScore, "dyspnea_last_score", "1");
      expect(ids([impact(), score("9"), last])).toEqual(["function_limit"]);
      expect(ids([impact(), score("9"), last, change("worsened")])).toContain("worsening");
    });
  });

  describe("measures tried for dyspnea", () => {
    it("names no relief, as a guideline-based prompt", () => {
      const reason = dyspneaPlanReviewReasons([impact(), response("no relief")]).find(
        (r) => r.id === "not_relieved",
      );
      expect(reason).toEqual({
        id: "not_relieved",
        text: "The measures tried for dyspnea gave no relief.",
        basis: "guideline",
        source:
          "National Consensus Project guidelines 4th ed. 2.2.4 and 2.3.4 (timely reassessment after treatment starts; re-evaluate response)",
      });
    });
    it("does not name partial or complete relief, or no measures tried", () => {
      for (const value of ["partial relief", "complete relief", "no measures tried"]) {
        expect(ids([impact(), response(value)]), value).not.toContain("not_relieved");
      }
    });
  });

  it("lists the reasons in a fixed order", () => {
    expect(
      ids([response("no relief"), change("worsened"), goal("3"), score("8"), impact()]),
    ).toEqual(["function_limit", "above_goal", "worsening", "not_relieved"]);
    expect(ids([impact(), change("new dyspnea"), response("no relief")])).toEqual([
      "function_limit",
      "new_dyspnea",
      "not_relieved",
    ]);
  });

  it("gives every reason a type and a source and ends each sentence", () => {
    const all = dyspneaPlanReviewReasons([
      impact(),
      score("8"),
      goal("3"),
      change("worsened"),
      response("no relief"),
    ]);
    expect(all).toHaveLength(4);
    for (const reason of all) {
      expect(reason.source.length).toBeGreaterThan(10);
      expect(reason.text.endsWith(".")).toBe(true);
      expect(Object.keys(PLAN_REVIEW_BASIS_LABELS)).toContain(reason.basis);
    }
  });

  describe("the hard limits: advisory only, no numeric threshold", () => {
    it("fires nothing on a high score alone", () => {
      expect(ids([impact(), score("10")])).toEqual(["function_limit"]);
      expect(ids([impact(), score(7)])).toEqual(["function_limit"]);
    });
    it("fires nothing on a jump between the typed scores", () => {
      const last = text(C.lastScore, "dyspnea_last_score", "0");
      expect(ids([impact(), score("10"), last])).toEqual(["function_limit"]);
    });
    it("has no severity, rise or vital-sign reason, whatever is typed", () => {
      const everything = [
        impact(),
        score("10"),
        goal("0"),
        text(C.lastScore, "dyspnea_last_score", "0"),
        change("worsened"),
        response("no relief"),
        text(C.nonverbal, "dyspnea_nonverbal", "respiratory rate 40, oxygen saturation 80"),
        text(C.distress, "dyspnea_distress", "panic"),
      ];
      const found = ids(everything);
      expect(found).toEqual(["function_limit", "above_goal", "worsening", "not_relieved"]);
      for (const banned of ["severe_score", "rise", "severity", "vital_signs", "rdos"]) {
        expect(found).not.toContain(banned);
      }
    });
    it("takes every number in a reason from what the clinician typed, plus the scale's own 10", () => {
      const reasons = dyspneaPlanReviewReasons([impact(), score("6"), goal("2")]);
      const digits = reasons.flatMap((r) => r.text.match(/\d+/g) ?? []);
      expect(digits).toEqual(["6", "10", "2"]);
    });
    it("does not read a note's free text as a trigger", () => {
      const notes = [
        text(C.quality, "dyspnea_quality", "severe, 10 of 10"),
        text(C.nonDrug, "dyspnea_nondrug", "oxygen at 4 L/min"),
      ];
      expect(ids([impact(), ...notes])).toEqual(["function_limit"]);
    });
  });
});

describe("dyspneaPlanReviewReference", () => {
  it("takes no argument and carries the plan-review cadence and the HOPE follow-up, nothing else", () => {
    expect(dyspneaPlanReviewReference.length).toBe(0);
    expect(dyspneaPlanReviewReference().map((r) => r.id)).toEqual([
      "idg_cadence",
      "hope_follow_up",
    ]);
  });

  it("states the cadence as the pain prompt does, from the shared constant", () => {
    const [cadence] = dyspneaPlanReviewReference();
    expect(cadence).toEqual({
      id: "idg_cadence",
      text: "The IDG, with the attending physician, reviews and revises the plan of care as often as the patient's condition requires, and at least every 15 calendar days.",
      basis: "regulation",
      source: "42 CFR 418.56(d)",
    });
  });

  it("states the HOPE follow-up as the impact the HOPE form records, which no score converts to", () => {
    const hope = dyspneaPlanReviewReference().find((r) => r.id === "hope_follow_up");
    expect(hope).toEqual({
      id: "hope_follow_up",
      text: "At a HOPE admission or update visit, a moderate or severe impact of shortness of breath calls for an in-person follow-up visit within 2 calendar days. That impact is how much the shortness of breath affects the patient (HOPE records not at all, slight, moderate or severe); it is not the 0 to 10 score, and no score converts to it.",
      basis: "cms_guidance",
      source: "CMS HOPE Guidance Manual v1.03, J2051 and J2052",
    });
  });

  it("never carries a level-of-care note: no source ties dyspnea or no relief to one", () => {
    const found = dyspneaPlanReviewReference().map((r) => r.id);
    expect(found).not.toContain("level_of_care");
    expect(JSON.stringify(dyspneaPlanReviewReference())).not.toMatch(
      /level of care|inpatient|continuous home care/i,
    );
  });
});
