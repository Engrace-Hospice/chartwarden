// The observation form restates the server's rules as field hints (so most 422s never happen). This suite holds the
// restatement to the server: for each case the form's hints and packages/assessments' validator must AGREE on which rule
// is broken. The one rule only the form has — record at least one finding — is tested on its own.
import { validateWoundObservation } from "@chartwarden/assessments";
import { describe, expect, it } from "vitest";
import {
  type DraftProblems,
  EMPTY_DRAFT,
  type ObservationDraft,
  correctBodyOf,
  draftAreaCm2,
  draftFromObservation,
  draftProblems,
  recordBodyOf,
  recordsAFinding,
  togglePeriwound,
} from "./wound-observation-draft";
import { observation } from "./wound-test-fixture";
import type { WoundEtiology } from "./wounds-api";

const REQUIRES_AREA_HINT = "A depth needs the length and the width.";

/** For each server rule the form restates: does the form hint at it? */
const HINTED: Record<string, (hints: DraftProblems) => boolean> = {
  WOUND_STAGE_NOT_APPLICABLE: (h) => h.stage !== undefined,
  WOUND_DEPTH_REQUIRES_AREA: (h) => h.depthCm === REQUIRES_AREA_HINT,
  WOUND_MEASUREMENT_RANGE: (h) =>
    [h.lengthCm, h.widthCm, h.depthCm].some((m) => m !== undefined && m !== REQUIRES_AREA_HINT),
  WOUND_DRESSING_REQUIRED: (h) => h.dressing !== undefined,
  WOUND_PERIWOUND_INTACT_EXCLUSIVE: (h) => h.periwound !== undefined,
};

const draft = (over: Partial<ObservationDraft>): ObservationDraft => ({
  ...EMPTY_DRAFT,
  trend: "stable",
  ...over,
});

/**
 * What the server's validator says about this draft as typed (numbers as numbers). The body is built as for a pressure
 * injury so a stage typed against another cause still reaches the validator: the form never SENDS one, but its hint
 * must still say it is wrong.
 */
function serverViolations(etiology: WoundEtiology, d: ObservationDraft): string[] {
  const { correctionReason: _reason, ...fields } = correctBodyOf(
    d,
    "pressure_injury",
    "other",
    null,
  );
  return validateWoundObservation(etiology, fields).map((v) => v.code);
}

const CASES: [string, WoundEtiology, ObservationDraft][] = [
  [
    "a clean pressure injury",
    "pressure_injury",
    draft({ stage: "stage_2", lengthCm: "3", widthCm: "2", depthCm: "0.5" }),
  ],
  ["a stage on a venous ulcer", "venous_ulcer", draft({ stage: "stage_2" })],
  ["a depth with no length or width", "pressure_injury", draft({ depthCm: "0.5" })],
  ["a depth with only a length", "pressure_injury", draft({ depthCm: "0.5", lengthCm: "3" })],
  ["a length over 100 cm", "pressure_injury", draft({ lengthCm: "101", widthCm: "2" })],
  ["a depth over 30 cm", "pressure_injury", draft({ lengthCm: "3", widthCm: "2", depthCm: "31" })],
  ["a width with two decimals", "pressure_injury", draft({ lengthCm: "3", widthCm: "2.55" })],
  ["a negative length", "pressure_injury", draft({ lengthCm: "-1", widthCm: "2" })],
  ["a dressing changed with none named", "surgical", draft({ dressingChanged: "yes" })],
  ["a dressing changed and named", "surgical", draft({ dressingChanged: "yes", dressing: "foam" })],
  ["intact skin with another finding", "surgical", draft({ periwound: ["intact", "erythema"] })],
  [
    "a measurement at the limits",
    "surgical",
    draft({ lengthCm: "100", widthCm: "100", depthCm: "30" }),
  ],
];

describe("the form's hints agree with the server's rules", () => {
  it.each(CASES)("%s", (_name, etiology, d) => {
    const hinted = draftProblems(d, etiology);
    const violated = serverViolations(etiology, d);
    for (const [rule, isHinted] of Object.entries(HINTED)) {
      expect(isHinted(hinted), `${rule} as a hint`).toBe(violated.includes(rule));
    }
  });
});

describe("the form's own rule and helpers", () => {
  it("wants at least one finding", () => {
    expect(recordsAFinding(EMPTY_DRAFT)).toBe(false);
    expect(draftProblems(EMPTY_DRAFT, "surgical").findings).toBe("Record at least one finding.");
    expect(recordsAFinding({ ...EMPTY_DRAFT, woundBed: ["slough"] })).toBe(true);
    expect(recordsAFinding({ ...EMPTY_DRAFT, undermining: "no" })).toBe(true);
    expect(draftProblems(draft({}), "surgical").findings).toBeUndefined();
  });

  it("intact skin clears every other periwound finding, and any other finding clears intact", () => {
    expect(togglePeriwound(["erythema", "warm"], "intact")).toEqual(["intact"]);
    expect(togglePeriwound(["intact"], "erythema")).toEqual(["erythema"]);
    expect(togglePeriwound(["erythema"], "warm")).toEqual(["erythema", "warm"]);
    expect(togglePeriwound(["erythema", "warm"], "warm")).toEqual(["erythema"]);
  });

  it("computes the area the way the server does", () => {
    expect(draftAreaCm2(draft({ lengthCm: "3.3", widthCm: "2.1" }))).toBe(6.93);
    expect(draftAreaCm2(draft({ lengthCm: "3" }))).toBeNull();
  });

  it("a new observation sends only what was recorded, plus the visit it was made at", () => {
    const d = draft({ lengthCm: "3", widthCm: "2", woundBed: ["slough"] });
    expect(recordBodyOf(d, "surgical", "enc-1")).toEqual({
      lengthCm: 3,
      widthCm: 2,
      woundBed: ["slough"],
      trend: "stable",
      sourceEncounterId: "enc-1",
    });
    expect(recordBodyOf(d, "surgical")).not.toHaveProperty("sourceEncounterId");
  });

  it("never sends a stage for a wound that is not a pressure injury, even from a stale draft", () => {
    expect(recordBodyOf(draft({ stage: "stage_2" }), "venous_ulcer")).not.toHaveProperty("stage");
  });

  it("a correction restates the whole observation: cleared fields go as null and empty lists", () => {
    const d = draftFromObservation(
      observation({ lengthCm: 3, widthCm: 2, depthCm: null, woundBed: [], periwound: [] }),
    );
    expect(correctBodyOf(d, "pressure_injury", "measurement_error", "enc-1")).toMatchObject({
      depthCm: null,
      woundBed: [],
      periwound: [],
      sourceEncounterId: "enc-1",
      correctionReason: "measurement_error",
    });
    expect(correctBodyOf(d, "pressure_injury", "other", null)).not.toHaveProperty(
      "sourceEncounterId",
    );
  });

  it("a draft round-trips an observation, so a correction opens on what was recorded", () => {
    const original = observation({
      depthCm: 0.5,
      undermining: false,
      dressingChanged: false,
      infectionSigns: true,
    });
    const body = correctBodyOf(draftFromObservation(original), "pressure_injury", "other", null);
    expect(body).toMatchObject({
      stage: original.stage,
      lengthCm: original.lengthCm,
      widthCm: original.widthCm,
      depthCm: 0.5,
      undermining: false,
      woundBed: original.woundBed,
      exudateAmount: original.exudateAmount,
      exudateType: original.exudateType,
      odor: original.odor,
      periwound: original.periwound,
      painScore: original.painScore,
      dressing: original.dressing,
      dressingChanged: false,
      infectionSigns: true,
      trend: original.trend,
    });
  });
});
