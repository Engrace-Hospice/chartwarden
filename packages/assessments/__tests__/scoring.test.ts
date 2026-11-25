// @chartwarden/assessments — server-authoritative scoring (§4.3, §7.1, §7.2, D6) — M9-T03.
import { describe, expect, it } from "vitest";
import { SIGNIFICANT_CHANGE_THRESHOLDS } from "../src/detector";
import type { EsasrData, FastData, PainadData, PpsData } from "../src/scale-types";
import { esasrScorer } from "../src/scales/esas-r";
import { ESAS_R_SEVERE_ITEM_MIN_SCORE } from "../src/scales/esas-r/severe-item";
import { FAST_STAGE_ORDER, fastScorer } from "../src/scales/fast";
import { painadScorer } from "../src/scales/painad";
import { ppsScorer } from "../src/scales/pps";
import { hasScorer, scoreAssessment } from "../src/scoring";

const baseEsasr: EsasrData = {
  pain: 0,
  tiredness: 0,
  drowsiness: 0,
  nausea: 0,
  lackOfAppetite: 0,
  shortnessOfBreath: 0,
  depression: 0,
  anxiety: 0,
  wellbeing: 0,
  reportedBy: "patient",
};

describe("PPS scorer (§7.1 — leftward-reading best fit)", () => {
  it("scores the §7.1 reference capture (mainly_sit_lie) at 50%", () => {
    const data: PpsData = {
      ambulation: "mainly_sit_lie",
      activity: "unable_any_work",
      selfCare: "considerable_assist",
      intake: "reduced",
      consciousness: "full",
    };
    expect(scoreAssessment("pps", data).score).toBe(50);
  });

  it("resolves full ambulation to 90 (some-disease default) for normal activity, 80 otherwise", () => {
    expect(
      ppsScorer.score({
        ambulation: "full",
        activity: "normal",
        selfCare: "full",
        intake: "normal",
        consciousness: "full",
      }),
    ).toBe(90);
    expect(
      ppsScorer.score({
        ambulation: "full",
        activity: "reduced",
        selfCare: "full",
        intake: "normal",
        consciousness: "full",
      }),
    ).toBe(80);
  });

  it("refines totally bed-bound by oral intake (30 / 20 / 10)", () => {
    const bed = (intake: PpsData["intake"]): number =>
      ppsScorer.score({
        ambulation: "totally_bed_bound",
        activity: "unable_any_work",
        selfCare: "total_care",
        intake,
        consciousness: "drowsy_or_coma",
      });
    expect(bed("reduced")).toBe(30);
    expect(bed("minimal_to_sips")).toBe(20);
    expect(bed("mouth_care_only")).toBe(10);
  });

  it("always lands on a multiple of 10 in [0,100]", () => {
    const score = ppsScorer.score({
      ambulation: "reduced",
      activity: "unable_hobby_work",
      selfCare: "occasional_assist",
      intake: "normal",
      consciousness: "full",
    });
    expect(score % 10).toBe(0);
    expect(score).toBe(60);
  });
});

describe("ESAS-r scorer (§7.2 — 9-item total, other excluded)", () => {
  it("totals the nine numeric items and excludes the optional 'other' symptom", () => {
    const data: EsasrData = {
      ...baseEsasr,
      pain: 8,
      tiredness: 5,
      anxiety: 7,
      otherSymptom: { label: "itching", severity: 9 },
    };
    // 8 + 5 + 7 = 20; the other-symptom 9 is NOT in the total.
    expect(scoreAssessment("esas_r", data).score).toBe(20);
  });

  it("flags severe (≥7) items in the interpretation (§7.2 pain at 8)", () => {
    const r = scoreAssessment("esas_r", { ...baseEsasr, pain: 8 });
    expect(r.interpretation).toBe("ESAS-r total 8/90; severe (≥7): pain");
  });

  it("lists an item at exactly 7 and not one at 6, from the same cut-off the alert rule uses", () => {
    expect(esasrScorer.interpret({ ...baseEsasr, pain: 6 })).toBe("ESAS-r total 6/90");
    expect(esasrScorer.interpret({ ...baseEsasr, shortnessOfBreath: 7 })).toBe(
      "ESAS-r total 7/90; severe (≥7): shortness of breath",
    );
    // One number for both: the record's line and the esas_symptom_ge_7 rule cannot drift apart.
    expect(SIGNIFICANT_CHANGE_THRESHOLDS.esas_symptom_ge_7).toMatchObject({
      platform: ESAS_R_SEVERE_ITEM_MIN_SCORE,
      floor: ESAS_R_SEVERE_ITEM_MIN_SCORE,
    });
  });

  it("states the total as a number with no band: no source gives cut-offs for the 0 to 90 total", () => {
    const all = (score: number): EsasrData => ({
      ...baseEsasr,
      pain: score,
      tiredness: score,
      drowsiness: score,
      nausea: score,
      lackOfAppetite: score,
      shortnessOfBreath: score,
      depression: score,
      anxiety: score,
      wellbeing: score,
    });
    expect(esasrScorer.interpret(all(0))).toBe("ESAS-r total 0/90");
    for (const score of [0, 4, 7, 10]) {
      expect(esasrScorer.interpret(all(score))).not.toMatch(/mild|moderate|high|burden/i);
    }
  });

  it("rejects a reading with an item that is not a whole number from 0 to 10 (422), so the record and the alert cannot disagree", () => {
    const bad: ReadonlyArray<Partial<Record<keyof EsasrData, unknown>>> = [
      { pain: 11 }, // total 11 is inside 0..90, the item is not
      { pain: 9, nausea: -1 },
      { pain: 9, nausea: null },
      { pain: 9, nausea: "3" },
      { pain: 6.5 },
      { pain: Number.NaN },
    ];
    for (const patch of bad) {
      expect(() => scoreAssessment("esas_r", { ...baseEsasr, ...patch } as EsasrData)).toThrowError(
        expect.objectContaining({ code: "INVALID_ITEM_SCORE", statusCode: 422 }),
      );
    }
    // A missing item is the same refusal, not a NaN total that surfaced as a 500.
    const { nausea: _omitted, ...missing } = baseEsasr;
    expect(() => scoreAssessment("esas_r", missing as unknown as EsasrData)).toThrowError(
      expect.objectContaining({ code: "INVALID_ITEM_SCORE", statusCode: 422 }),
    );
  });

  it("accepts the bounds 0 and 10 on every item", () => {
    expect(scoreAssessment("esas_r", { ...baseEsasr, pain: 10, wellbeing: 10 }).score).toBe(20);
    expect(scoreAssessment("esas_r", baseEsasr).score).toBe(0);
  });
});

describe("PAINAD scorer (§4.3 — 5 items 0..2, total 0..10)", () => {
  it("sums the five behavioral items", () => {
    const data: PainadData = {
      breathing: 2,
      negativeVocalization: 1,
      facialExpression: 1,
      bodyLanguage: 0,
      consolability: 0,
    };
    expect(scoreAssessment("painad", data).score).toBe(4);
  });

  it("bands severity (0 none / 1-3 mild / 4-6 moderate / 7-10 severe)", () => {
    expect(
      painadScorer.interpret({
        breathing: 0,
        negativeVocalization: 0,
        facialExpression: 0,
        bodyLanguage: 0,
        consolability: 0,
      }),
    ).toMatch(/no pain/);
    expect(
      painadScorer.interpret({
        breathing: 1,
        negativeVocalization: 1,
        facialExpression: 2,
        bodyLanguage: 1,
        consolability: 1,
      }),
    ).toMatch(/moderate/);
    expect(
      painadScorer.interpret({
        breathing: 2,
        negativeVocalization: 2,
        facialExpression: 2,
        bodyLanguage: 2,
        consolability: 2,
      }),
    ).toMatch(/severe/);
  });
});

describe("FAST scorer (§3.3 — ordinal stage index, monotonic for progression)", () => {
  it("maps each stage to its 1-based monotonic index", () => {
    expect(fastScorer.score({ stage: "1" })).toBe(1);
    expect(fastScorer.score({ stage: "7a" })).toBe(11);
    expect(fastScorer.score({ stage: "7f" })).toBe(16);
  });

  it("is strictly increasing across the canonical progression order", () => {
    const indices = FAST_STAGE_ORDER.map((stage) => fastScorer.score({ stage } as FastData));
    for (let i = 1; i < indices.length; i++) {
      expect(indices[i]!).toBeGreaterThan(indices[i - 1]!);
    }
  });

  it("renders the clinical descriptor in the interpretation", () => {
    expect(fastScorer.interpret({ stage: "7c" })).toMatch(/non-ambulatory/);
  });
});

describe("scoreAssessment dispatch (D6)", () => {
  it("reports which scales have a registered scorer (the four T03 scales)", () => {
    expect(hasScorer("pps")).toBe(true);
    expect(hasScorer("fast")).toBe(true);
    expect(hasScorer("painad")).toBe(true);
    expect(hasScorer("esas_r")).toBe(true);
    expect(hasScorer("kps")).toBe(false);
  });

  it("raises SCALE_SCORER_UNAVAILABLE (500) for a not-yet-built scale", () => {
    expect(() => scoreAssessment("kps", { score: 80 } as never)).toThrowError(
      expect.objectContaining({ code: "SCALE_SCORER_UNAVAILABLE", statusCode: 500 }),
    );
  });

  it("is server-authoritative — a client-sent score in data is ignored", () => {
    const data = { ...baseEsasr, pain: 3, score: 99 } as unknown as EsasrData;
    expect(scoreAssessment("esas_r", data).score).toBe(3);
  });
});
