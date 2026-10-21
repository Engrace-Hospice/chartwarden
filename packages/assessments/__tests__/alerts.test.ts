// @chartwarden/assessments — §4.9 M36 typed-alert builder (M9-T06).
import { describe, expect, it } from "vitest";
import {
  buildSignificantChangeAlert,
  escalatesOnNoAck,
  medicalDirectorRouting,
  significantChangeBody,
} from "../src/alerts";

const base = {
  organizationId: "org-1",
  patientId: "pat-1",
  assessmentId: "asm-1",
  scaleType: "pps" as const,
};

describe("buildSignificantChangeAlert — §4.9 severity floor", () => {
  it("CRITICAL rules emit clinical_urgent with immediate medical-director routing at first emission", () => {
    const alert = buildSignificantChangeAlert({
      ...base,
      ruleId: "pps_drop_20_in_14d",
      deltaValue: 30,
      thresholdValue: 20,
    });
    expect(alert.kind).toBe("m9.assessment.significant_change");
    expect(alert.severity).toBe("clinical_urgent");
    expect(alert.recipients).toEqual({
      careTeamChannel: true,
      caseManagerInbox: true,
      clinicalSupervisorInbox: true,
      medicalDirectorInbox: "immediate",
    });
    expect(alert.deltaValue).toBe(30);
    expect(alert.thresholdValue).toBe(20);
    expect(alert.bodyTemplate).toContain("PPS");
    expect(alert.bodyTemplate).toContain("pps_drop_20_in_14d");
  });

  it("non-CRITICAL rules emit medium with no medical-director notification at first emission", () => {
    const alert = buildSignificantChangeAlert({
      ...base,
      scaleType: "esas_r",
      ruleId: "esas_symptom_ge_7",
      deltaValue: null,
      thresholdValue: 7,
    });
    expect(alert.severity).toBe("medium");
    expect(alert.recipients.medicalDirectorInbox).toBe(false);
  });

  it("the escalation cron's severityOverride upgrades a medium to high (on_escalation routing)", () => {
    const alert = buildSignificantChangeAlert(
      { ...base, scaleType: "morse", ruleId: "morse_ge_51" },
      "high",
    );
    expect(alert.severity).toBe("high");
    expect(alert.recipients.medicalDirectorInbox).toBe("on_escalation");
    // categorical rule with no magnitude → null delta/threshold, body omits the Δ clause
    expect(alert.deltaValue).toBeNull();
    expect(alert.thresholdValue).toBeNull();
    expect(alert.bodyTemplate).not.toContain("Δ");
  });
});

describe("medicalDirectorRouting / escalatesOnNoAck", () => {
  it("maps each severity to its §4.9 routing", () => {
    expect(medicalDirectorRouting("clinical_urgent")).toBe("immediate");
    expect(medicalDirectorRouting("high")).toBe("on_escalation");
    expect(medicalDirectorRouting("medium")).toBe(false);
  });

  it("only CRITICAL rules escalate on no-ack (§2.2.2)", () => {
    expect(escalatesOnNoAck("pps_drop_20_in_14d")).toBe(true);
    expect(escalatesOnNoAck("braden_le_12")).toBe(true);
    expect(escalatesOnNoAck("nyha_class_iv")).toBe(true);
    expect(escalatesOnNoAck("esas_symptom_ge_7")).toBe(false);
    expect(escalatesOnNoAck("painad_ge_4")).toBe(false);
  });

  it("the body is deterministic for the same inputs (M36 delivers it verbatim)", () => {
    const a = significantChangeBody(
      { ruleId: "braden_le_12", scaleType: "braden", deltaValue: 11, thresholdValue: 12 },
      "clinical_urgent",
    );
    const b = significantChangeBody(
      { ruleId: "braden_le_12", scaleType: "braden", deltaValue: 11, thresholdValue: 12 },
      "clinical_urgent",
    );
    expect(a).toBe(b);
    expect(a).toContain("Δ 11 vs threshold 12");
  });
});
