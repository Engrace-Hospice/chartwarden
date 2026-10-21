// @chartwarden/inpatient — M37-T05 unit tests for the §2.4 GIP criteria validators + reassessment clock.
import { describe, expect, it } from "vitest";
import {
  GIP_REASSESSMENT_MIN_HOURS,
  GIP_REASSESSMENT_STALENESS_FLOOR_HOURS,
  isReassessmentDue,
  normalizeReassessmentStalenessHours,
  validateGipCriteriaPayload,
} from "../src/domain/gip-criteria/validate";
import { IpuStateError } from "../src/errors";

const HOUR = 3_600_000;
const longText = (n: number) => "x".repeat(n);

describe("GIP criteria payload validation (§2.4 discriminated union)", () => {
  it("accepts a valid acute_symptom_management payload", () => {
    const p = validateGipCriteriaPayload({
      criterion_kind: "acute_symptom_management",
      uncontrolled_symptoms: [
        {
          symptom: "dyspnea",
          severity_score: 8,
          duration_hours: 12,
          interventions_attempted_in_home: ["oxygen titration"],
        },
      ],
      planned_inpatient_interventions: ["continuous opioid infusion"],
      rationale: longText(120),
    });
    expect(p.criterion_kind).toBe("acute_symptom_management");
  });

  it("accepts a valid imminent_death_terminal_care payload", () => {
    const p = validateGipCriteriaPayload({
      criterion_kind: "imminent_death_terminal_care",
      clinical_estimate_days_to_death: 3,
      signs_of_imminent_death: ["mottling", "terminal_secretions"],
      rationale_for_inpatient_setting: longText(120),
      home_environment_assessment_text: longText(60),
    });
    expect(p.criterion_kind).toBe("imminent_death_terminal_care");
  });

  it("rejects a payload with too-short rationale (below the 100-char floor)", () => {
    try {
      validateGipCriteriaPayload({
        criterion_kind: "acute_symptom_management",
        uncontrolled_symptoms: [
          {
            symptom: "pain",
            severity_score: 9,
            duration_hours: 6,
            interventions_attempted_in_home: ["oral morphine"],
          },
        ],
        planned_inpatient_interventions: ["IV titration"],
        rationale: "too short",
      });
      throw new Error("expected throw");
    } catch (e) {
      expect((e as IpuStateError).code).toBe("GIP_CRITERIA_INVALID_PAYLOAD");
      expect((e as IpuStateError).statusCode).toBe(422);
    }
  });

  it("rejects an unknown criterion_kind and a missing discriminator", () => {
    expect(() => validateGipCriteriaPayload({ criterion_kind: "nonsense" })).toThrow(IpuStateError);
    expect(() => validateGipCriteriaPayload({})).toThrow(IpuStateError);
    expect(() => validateGipCriteriaPayload(null)).toThrow(IpuStateError);
  });
});

describe("reassessment staleness clock (§2.4 D5)", () => {
  it("clamps a tightening to [4h, 24h] and rejects a loosening", () => {
    expect(normalizeReassessmentStalenessHours(24)).toBe(24);
    expect(normalizeReassessmentStalenessHours(6)).toBe(6);
    expect(normalizeReassessmentStalenessHours(1)).toBe(GIP_REASSESSMENT_MIN_HOURS);
    expect(() => normalizeReassessmentStalenessHours(48)).toThrow(
      /GIP_REASSESSMENT_NOT_TIGHTENING|loosen/,
    );
  });

  it("flags a reassessment due only past the staleness window", () => {
    const last = 100 * HOUR;
    expect(isReassessmentDue(last, last + 25 * HOUR, GIP_REASSESSMENT_STALENESS_FLOOR_HOURS)).toBe(
      true,
    );
    expect(isReassessmentDue(last, last + 23 * HOUR, GIP_REASSESSMENT_STALENESS_FLOOR_HOURS)).toBe(
      false,
    );
    // A tenant tightened to 4h fires sooner.
    expect(isReassessmentDue(last, last + 5 * HOUR, 4)).toBe(true);
  });
});
