// apps/backend/__tests__/field-safety-patient-deceased.test.ts — GAP-135 (M20 §4.4 `m5-patient-deceased.consumer`).
//
// A death retires the OPEN safety obligations on the decedent's upcoming visits so the §4.8 detector cannot walk the
// D4 ladder at a clinician visiting a patient who has died. Recorded / incident rows are history and are left alone.
import { describe, expect, it } from "vitest";
import {
  type SafetyScheduleRowFacts,
  decidePatientDeceased,
} from "../src/modules/20-field-safety/consumers";

const row = (
  id: string,
  kind: SafetyScheduleRowFacts["kind"],
  state: SafetyScheduleRowFacts["state"],
): SafetyScheduleRowFacts => ({
  scheduleId: id as SafetyScheduleRowFacts["scheduleId"],
  kind,
  state,
  expectedAt: "2026-07-01T10:00:00.000Z" as SafetyScheduleRowFacts["expectedAt"],
  windowMinutes: 15,
  clinicianMembershipId: "m_1" as SafetyScheduleRowFacts["clinicianMembershipId"],
});

describe("decidePatientDeceased", () => {
  it("retires every open obligation (proposed, overdue, escalated) across all of the decedent's visits", () => {
    const decision = decidePatientDeceased({
      rowsByVisit: [
        [row("a", "pre_visit", "proposed"), row("b", "mid_visit", "overdue")],
        [row("c", "post_visit", "escalated")],
      ],
    });
    expect(decision.mutations).toEqual([
      { kind: "retire", scheduleId: "a", reason: "patient_deceased" },
      { kind: "retire", scheduleId: "b", reason: "patient_deceased" },
      { kind: "retire", scheduleId: "c", reason: "patient_deceased" },
    ]);
    expect(decision.effects.length).toBeGreaterThan(0);
  });

  it("leaves recorded history and supervisor-owned incident rows alone", () => {
    const decision = decidePatientDeceased({
      rowsByVisit: [[row("a", "pre_visit", "recorded"), row("b", "post_visit", "incident_opened")]],
    });
    expect(decision.mutations).toEqual([]);
    expect(decision.effects).toEqual([]);
  });

  it("is a no-op for a patient with no upcoming visits (and on redelivery)", () => {
    expect(decidePatientDeceased({ rowsByVisit: [] }).mutations).toEqual([]);
  });
});
