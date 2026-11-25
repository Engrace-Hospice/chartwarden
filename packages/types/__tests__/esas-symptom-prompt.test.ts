// The advisory ESAS-r item prompt: one sourced cut-off (4 or more on the 0 to 10 scale) and the pure functions around it. The value is
// pinned rather than only exercised: a change to it is a clinical decision (see the module header for its source and its limits).
import { describe, expect, it } from "vitest";
import {
  ESAS_R_FULLER_ASSESSMENT_MIN_SCORE,
  ESAS_R_ITEM_KEYS,
  ESAS_R_ITEM_LABELS,
  type EsasrItemScores,
  esasrItemScoresFrom,
  esasrItemsForFullerAssessment,
} from "../src/esas-symptom-prompt";

const zeros: EsasrItemScores = {
  pain: 0,
  tiredness: 0,
  drowsiness: 0,
  nausea: 0,
  lackOfAppetite: 0,
  shortnessOfBreath: 0,
  depression: 0,
  anxiety: 0,
  wellbeing: 0,
};
const withScores = (patch: Partial<EsasrItemScores>): EsasrItemScores => ({ ...zeros, ...patch });

describe("the pinned cut-off and the nine items", () => {
  it("carries the value its source states", () => {
    expect(ESAS_R_FULLER_ASSESSMENT_MIN_SCORE).toBe(4); // Oldenmenger 2013: 4 or more triggers a fuller assessment
  });

  it("names the nine ESAS-r items in the published order, each with its published label", () => {
    expect(ESAS_R_ITEM_KEYS).toEqual([
      "pain",
      "tiredness",
      "drowsiness",
      "nausea",
      "lackOfAppetite",
      "shortnessOfBreath",
      "depression",
      "anxiety",
      "wellbeing",
    ]);
    expect(ESAS_R_ITEM_KEYS.map((key) => ESAS_R_ITEM_LABELS[key])).toEqual([
      "Pain",
      "Tiredness",
      "Drowsiness",
      "Nausea",
      "Lack of appetite",
      "Shortness of breath",
      "Depression",
      "Anxiety",
      "Wellbeing",
    ]);
  });
});

describe("esasrItemsForFullerAssessment", () => {
  it("lists nothing when every item is below the cut-off", () => {
    expect(esasrItemsForFullerAssessment(withScores({ pain: 3, nausea: 3 }))).toEqual([]);
  });

  it("includes an item at exactly the cut-off and excludes the one just below it", () => {
    const items = esasrItemsForFullerAssessment(withScores({ pain: 4, nausea: 3 }));
    expect(items).toEqual([{ key: "pain", label: "Pain", score: 4 }]);
  });

  it("lists every qualifying item, in the published order, with its score", () => {
    const items = esasrItemsForFullerAssessment(
      withScores({ wellbeing: 10, tiredness: 6, shortnessOfBreath: 4 }),
    );
    expect(items).toEqual([
      { key: "tiredness", label: "Tiredness", score: 6 },
      { key: "shortnessOfBreath", label: "Shortness of breath", score: 4 },
      { key: "wellbeing", label: "Wellbeing", score: 10 },
    ]);
  });

  it("treats a score of 10 as in range and a score above 10 as not a reading", () => {
    expect(esasrItemsForFullerAssessment(withScores({ pain: 10 }))).toHaveLength(1);
    expect(esasrItemsForFullerAssessment({ ...zeros, pain: 11 })).toEqual([]);
  });

  it("ignores a missing, non-numeric, negative or non-finite value and never throws", () => {
    const messy = {
      pain: "7",
      tiredness: null,
      drowsiness: undefined,
      nausea: Number.NaN,
      lackOfAppetite: Number.POSITIVE_INFINITY,
      shortnessOfBreath: -5,
      depression: {},
      anxiety: 5,
    };
    expect(esasrItemsForFullerAssessment(messy)).toEqual([
      { key: "anxiety", label: "Anxiety", score: 5 },
    ]);
  });

  it("returns nothing for input that is not a record", () => {
    for (const input of [null, undefined, 4, "pain", [], true]) {
      expect(esasrItemsForFullerAssessment(input)).toEqual([]);
    }
  });

  it("ignores keys that are not one of the nine items", () => {
    expect(
      esasrItemsForFullerAssessment({ ...zeros, otherSymptom: 9, total: 90, free: "text" }),
    ).toEqual([]);
  });

  it("carries no severity, band or action beyond the item, its label and its score", () => {
    const [item] = esasrItemsForFullerAssessment(withScores({ pain: 9 }));
    expect(Object.keys(item ?? {}).sort()).toEqual(["key", "label", "score"]);
  });
});

describe("esasrItemScoresFrom", () => {
  it("keeps exactly the nine numeric scores of a recorded ESAS-r and drops everything else", () => {
    const recorded = {
      ...withScores({ pain: 5, wellbeing: 2 }),
      otherSymptom: { label: "itch", severity: 8 },
      reportedBy: "patient",
      otherSymptomText: "free text that must never travel",
    };
    const scores = esasrItemScoresFrom(recorded);
    expect(scores).toEqual(withScores({ pain: 5, wellbeing: 2 }));
    expect(Object.keys(scores ?? {}).sort()).toEqual([...ESAS_R_ITEM_KEYS].sort());
    expect(JSON.stringify(scores)).not.toContain("free text");
  });

  it("answers undefined unless all nine items are numbers from 0 to 10", () => {
    const { pain: _omitted, ...missingOne } = zeros;
    expect(esasrItemScoresFrom(missingOne)).toBeUndefined();
    expect(esasrItemScoresFrom({ ...zeros, pain: "5" })).toBeUndefined();
    expect(esasrItemScoresFrom({ ...zeros, pain: 11 })).toBeUndefined();
    expect(esasrItemScoresFrom({ ...zeros, pain: -1 })).toBeUndefined();
    expect(esasrItemScoresFrom({ ...zeros, pain: Number.NaN })).toBeUndefined();
  });

  it("answers undefined for input that is not a record", () => {
    for (const input of [null, undefined, 7, "x", [], {}]) {
      expect(esasrItemScoresFrom(input)).toBeUndefined();
    }
  });
});
