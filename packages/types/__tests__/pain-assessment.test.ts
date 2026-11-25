// The pain-assessment rules shared by the composer's helper and the plan-of-care prompt. Every number asserted here is a threshold with
// a source (see the module header and docs/research/PAIN_ASSESSMENT_AND_PLAN_OF_CARE_TRIGGERS_RESEARCH.md); a change to one is a
// clinical decision, so the values are pinned rather than only exercised.
import { describe, expect, it } from "vitest";
import {
  PAIN_ASSESSMENT_CODES as C,
  PAIN_CHARACTERISTICS,
  PAIN_HQRP_MIN_CHARACTERISTICS,
  PAIN_MEANINGFUL_RISE_POINTS,
  PAIN_PLAN_REVIEW_MAX_DAYS,
  PAIN_SEVERE_MIN_SCORE,
  PAIN_SFV_WINDOW_DAYS,
  type PainSelection,
  PAIN_STATEMENT_CODES as S,
  isPainAssessmentCode,
  painCompleteness,
  painFactsFrom,
  painPlanReviewReasons,
  painPlanReviewReference,
} from "../src/pain-assessment";

const limiting = (score: string | number = "6"): PainSelection => ({
  code: S.limiting,
  params: { pain_score: score },
});
const text = (code: string, slot: string, value: string): PainSelection => ({
  code,
  params: { [slot]: value },
});
const ids = (selections: readonly PainSelection[]): string[] =>
  painPlanReviewReasons(selections).map((r) => r.id);

describe("the pinned thresholds", () => {
  it("carry the values their sources state", () => {
    expect(PAIN_SEVERE_MIN_SCORE).toBe(7); // HOPE Table 4: 7 to 10 is severe
    expect(PAIN_MEANINGFUL_RISE_POINTS).toBe(2); // Farrar 2001: about 2 points
    expect(PAIN_HQRP_MIN_CHARACTERISTICS).toBe(5); // HQRP QM manual: 5 of the 7 characteristics
    expect(PAIN_CHARACTERISTICS).toHaveLength(7); // HOPE J0910C items 1 to 7
    expect(PAIN_SFV_WINDOW_DAYS).toBe(2); // HOPE J2052
    expect(PAIN_PLAN_REVIEW_MAX_DAYS).toBe(15); // 42 CFR 418.56(d)
  });
});

describe("isPainAssessmentCode", () => {
  it("is true for the helper's statements and false for the pain statements and anything else", () => {
    expect(isPainAssessmentCode(C.location)).toBe(true);
    expect(isPainAssessmentCode(C.planDecision)).toBe(true);
    expect(isPainAssessmentCode(S.limiting)).toBe(false);
    expect(isPainAssessmentCode("nv.pain.score")).toBe(false);
  });
});

describe("painFactsFrom", () => {
  it("reads a score typed in the form (a string) and a stored one (a number) alike", () => {
    expect(painFactsFrom([limiting("6")]).score).toBe(6);
    expect(painFactsFrom([limiting(6)]).score).toBe(6);
  });

  it("ignores a value that is blank, not a number, or off the 0 to 10 scale", () => {
    expect(painFactsFrom([limiting("")]).score).toBeNull();
    expect(painFactsFrom([limiting("six")]).score).toBeNull();
    expect(painFactsFrom([limiting("11")]).score).toBeNull();
    expect(painFactsFrom([limiting("-1")]).score).toBeNull();
  });

  it("takes the score from whichever pain statement is picked", () => {
    const controlled: PainSelection = { code: S.controlled, params: { pain_score: "2" } };
    expect(painFactsFrom([controlled])).toMatchObject({
      hasPainStatement: true,
      limitingFunction: false,
      score: 2,
    });
    expect(painFactsFrom([])).toMatchObject({ hasPainStatement: false, score: null });
  });

  it("accepts only the offered choices", () => {
    const relief = (value: string): PainSelection => text(C.prnRelief, "pain_prn_relief", value);
    expect(painFactsFrom([limiting(), relief("no relief")]).prnRelief).toBe("no relief");
    expect(painFactsFrom([limiting(), relief("a little")]).prnRelief).toBeNull();
  });
});

describe("painCompleteness", () => {
  it("counts severity and effect on function from the limiting statement alone", () => {
    const result = painCompleteness([limiting()]);
    expect(result.documented).toEqual(["severity", "function_quality_of_life"]);
    expect(result.count).toBe(2);
    expect(result.total).toBe(7);
    expect(result.missing).toEqual([
      "location",
      "character",
      "duration",
      "frequency",
      "relieving_worsening",
    ]);
  });

  it("does not count effect on function for 'pain controlled'", () => {
    const controlled: PainSelection = { code: S.controlled, params: { pain_score: "2" } };
    expect(painCompleteness([controlled]).documented).toEqual(["severity"]);
  });

  it("counts a characteristic only once its value is filled in", () => {
    const blank = painCompleteness([limiting(), text(C.location, "pain_location", "  ")]);
    expect(blank.documented).not.toContain("location");
    const filled = painCompleteness([limiting(), text(C.location, "pain_location", "right hip")]);
    expect(filled.documented).toContain("location");
  });

  it("counts 'what relieves or worsens it' once, whichever of the two is recorded", () => {
    const worse = text(C.worsenedBy, "pain_worsened_by", "turning");
    const better = text(C.relievedBy, "pain_relieved_by", "a warm pack");
    expect(painCompleteness([limiting(), worse]).count).toBe(3);
    expect(painCompleteness([limiting(), worse, better]).count).toBe(3);
  });

  it("takes a recorded observation scale as the severity of a patient who cannot self-report", () => {
    const observed: PainSelection = {
      code: C.observationScale,
      params: { observation_tool: "PAINAD", observation_score: "5" },
    };
    expect(painCompleteness([observed]).documented).toEqual(["severity"]);
    const unscored: PainSelection = {
      code: C.observationScale,
      params: { observation_tool: "PAINAD", observation_score: "" },
    };
    expect(painCompleteness([unscored]).documented).toEqual([]);
  });

  it("reaches the quality-measure benchmark at 5 of 7 and not at 4", () => {
    const four = [
      limiting(),
      text(C.location, "pain_location", "lower back"),
      text(C.character, "pain_character", "aching"),
    ];
    expect(painCompleteness(four)).toMatchObject({ count: 4, meetsQualityMeasureBenchmark: false });
    const five = [...four, text(C.frequency, "pain_frequency", "constant")];
    expect(painCompleteness(five)).toMatchObject({ count: 5, meetsQualityMeasureBenchmark: true });
  });
});

describe("painPlanReviewReasons", () => {
  it("is empty when no pain statement is picked", () => {
    expect(ids([text(C.goal, "pain_goal", "3")])).toEqual([]);
  });

  it("names the function limit when only 'pain limiting function' is picked", () => {
    expect(ids([limiting("2")])).toEqual(["function_limit"]);
  });

  it("does not name a function limit for 'pain controlled'", () => {
    const controlled: PainSelection = { code: S.controlled, params: { pain_score: "2" } };
    expect(ids([controlled])).toEqual([]);
  });

  describe("above the patient's own acceptable level", () => {
    const goal = (value: string): PainSelection => text(C.goal, "pain_goal", value);
    it("fires when the score is above the goal", () => {
      expect(ids([limiting("5"), goal("3")])).toContain("above_goal");
    });
    it("does not fire at the goal or below it", () => {
      expect(ids([limiting("3"), goal("3")])).not.toContain("above_goal");
      expect(ids([limiting("2"), goal("3")])).not.toContain("above_goal");
    });
    it("does not fire without a goal", () => {
      expect(ids([limiting("9")])).not.toContain("above_goal");
    });
    it("states both numbers", () => {
      const reason = painPlanReviewReasons([limiting("5"), goal("3")]).find(
        (r) => r.id === "above_goal",
      );
      expect(reason?.text).toBe("Pain is 5 of 10, above the patient's own acceptable level of 3.");
      expect(reason?.basis).toBe("common_practice");
    });
  });

  describe("severe on the CMS HOPE scale", () => {
    it("fires at 7 and above and not at 6", () => {
      expect(ids([limiting("7")])).toContain("severe_score");
      expect(ids([limiting("10")])).toContain("severe_score");
      expect(ids([limiting("6")])).not.toContain("severe_score");
    });
    it("is labelled as CMS guidance, not as a clinical cut-off", () => {
      const reason = painPlanReviewReasons([limiting("8")]).find((r) => r.id === "severe_score");
      expect(reason?.basis).toBe("cms_guidance");
      expect(reason?.text).toContain("CMS HOPE scale");
    });
  });

  describe("a rise since the last visit", () => {
    const last = (value: string): PainSelection => text(C.lastScore, "pain_last_score", value);
    it("fires at a rise of exactly 2 points and not at 1", () => {
      expect(ids([limiting("6"), last("4")])).toContain("rise");
      expect(ids([limiting("5"), last("4")])).not.toContain("rise");
    });
    it("does not fire for a fall", () => {
      expect(ids([limiting("3"), last("6")])).not.toContain("rise");
    });
    it("is labelled as a research benchmark", () => {
      const reason = painPlanReviewReasons([limiting("7"), last("4")]).find((r) => r.id === "rise");
      expect(reason?.basis).toBe("research");
      expect(reason?.text).toContain("rose 3 points");
    });
    it("is not repeated as 'worse than the last visit' when the clinician also says worse", () => {
      const worse = text(C.change, "pain_change", "worsened");
      const found = ids([limiting("6"), last("4"), worse]);
      expect(found).toContain("rise");
      expect(found).not.toContain("worsening");
    });
  });

  it("names worse and new pain as the clinician records them", () => {
    const change = (value: string): PainSelection => text(C.change, "pain_change", value);
    expect(ids([limiting("4"), change("worsened")])).toContain("worsening");
    expect(ids([limiting("4"), change("new pain")])).toContain("new_pain");
    expect(ids([limiting("4"), change("improved")])).not.toContain("worsening");
    expect(ids([limiting("4"), change("unchanged")])).not.toContain("worsening");
  });

  it("names no relief from the last as-needed dose, and not partial or no dose taken", () => {
    const relief = (value: string): PainSelection => text(C.prnRelief, "pain_prn_relief", value);
    expect(ids([limiting(), relief("no relief")])).toContain("not_relieved");
    expect(ids([limiting(), relief("partial relief")])).not.toContain("not_relieved");
    expect(ids([limiting(), relief("no dose taken")])).not.toContain("not_relieved");
  });

  it("names an inability to take oral medicine only once the reason is written", () => {
    expect(ids([limiting(), text(C.oralBarrier, "oral_barrier", "cannot swallow")])).toContain(
      "no_oral_route",
    );
    expect(ids([limiting(), text(C.oralBarrier, "oral_barrier", " ")])).not.toContain(
      "no_oral_route",
    );
  });

  it("lists the reasons in a fixed order", () => {
    const all = [
      limiting("8"),
      text(C.goal, "pain_goal", "3"),
      text(C.lastScore, "pain_last_score", "4"),
      text(C.prnRelief, "pain_prn_relief", "no relief"),
      text(C.oralBarrier, "oral_barrier", "cannot swallow"),
    ];
    expect(ids(all)).toEqual([
      "function_limit",
      "above_goal",
      "severe_score",
      "rise",
      "not_relieved",
      "no_oral_route",
    ]);
  });

  it("gives every reason a type and a source", () => {
    const all = painPlanReviewReasons([
      limiting("8"),
      text(C.goal, "pain_goal", "3"),
      text(C.lastScore, "pain_last_score", "4"),
      text(C.change, "pain_change", "new pain"),
      text(C.prnRelief, "pain_prn_relief", "no relief"),
      text(C.oralBarrier, "oral_barrier", "cannot swallow"),
    ]);
    expect(all.length).toBeGreaterThanOrEqual(7);
    for (const reason of all) {
      expect(reason.source.length).toBeGreaterThan(10);
      expect(reason.text.endsWith(".")).toBe(true);
    }
  });
});

describe("painPlanReviewReference", () => {
  it("always carries the plan-review cadence and the HOPE follow-up", () => {
    const ref = painPlanReviewReference(painPlanReviewReasons([limiting("2")]));
    expect(ref.map((r) => r.id)).toEqual(["idg_cadence", "hope_follow_up"]);
    expect(ref[0]?.text).toContain("at least every 15 calendar days");
    expect(ref[1]?.text).toContain("within 2 calendar days");
  });

  it("adds the level-of-care pointer only after a dose gave no relief", () => {
    const none = painPlanReviewReasons([
      limiting(),
      text(C.prnRelief, "pain_prn_relief", "no relief"),
    ]);
    expect(painPlanReviewReference(none).map((r) => r.id)).toContain("level_of_care");
    const severe = painPlanReviewReasons([limiting("9")]);
    expect(painPlanReviewReference(severe).map((r) => r.id)).not.toContain("level_of_care");
  });
});
