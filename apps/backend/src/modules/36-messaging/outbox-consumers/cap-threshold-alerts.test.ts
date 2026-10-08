// GAP-040 — m26.cap.threshold_crossed -> typed cap alert, with a seeded rule for every kind it can raise.
import { PLATFORM_DEFAULT_ALERT_RULES } from "@wardenx/messaging";
import { describe, expect, it, vi } from "vitest";
import { buildM36CapThresholdAlertConsumer, planCapThresholdAlert } from "./cap-threshold-alerts";

const CROSSED = "m26.cap.threshold_crossed";
const base = {
  organizationId: "o1",
  capPeriodId: "cp1",
  eventId: "ev1",
  bandFrom: "safe",
};
const evt = (payload: Record<string, unknown>) => ({ eventType: CROSSED, payload });

describe("planCapThresholdAlert", () => {
  it("maps every aggregate band for the agency and patient scopes", () => {
    const cases: [string, string, string][] = [
      ["agency_aggregate", "watch_90", "m26.cap.agency_watch_90"],
      ["agency_aggregate", "warn_95", "m26.cap.agency_warn_95"],
      ["agency_aggregate", "breach_100", "m26.cap.agency_breach_100"],
      ["patient_aggregate", "watch_90", "m26.cap.patient_watch_90"],
      ["patient_aggregate", "warn_95", "m26.cap.patient_warn_95"],
      ["patient_aggregate", "breach_100", "m26.cap.patient_breach_100"],
    ];
    for (const [scope, bandTo, expected] of cases) {
      const plan = planCapThresholdAlert(evt({ ...base, scope, bandTo, patientId: "p1" }));
      expect(plan.alertEventType).toBe(expected);
    }
  });

  it("maps the inpatient 18% / 20% bands and treats a breach as critical", () => {
    expect(
      planCapThresholdAlert(evt({ ...base, scope: "inpatient", bandTo: "inpatient_watch_18" })),
    ).toMatchObject({ alertEventType: "m26.cap.inpatient_watch_18", severity: "warn" });
    expect(
      planCapThresholdAlert(evt({ ...base, scope: "inpatient", bandTo: "inpatient_breach_20" })),
    ).toMatchObject({ alertEventType: "m26.cap.inpatient_breach", severity: "critical" });
  });

  it("carries the figures as strings/percent and never a patient name", () => {
    const plan = planCapThresholdAlert(
      evt({
        ...base,
        scope: "patient_aggregate",
        bandTo: "warn_95",
        patientId: "p1",
        capYear: "FY2026",
        pctOfCap: 0.9612,
        paidYtdCents: 3_312_000,
        capAmountCents: 3_446_534,
      }),
    );
    expect(plan.safe).toMatchObject({
      patientId: "p1",
      utilizationPct: 96.12,
      paidToDate: "3312000",
      allocatedCap: "3446534",
    });
    expect(Object.keys(plan.safe)).not.toContain("patientDisplayName");
  });

  it("throws (retry -> DLQ) on a malformed event instead of dropping the alert", () => {
    expect(() => planCapThresholdAlert(evt({ ...base, scope: "agency_aggregate" }))).toThrow(
      /bandTo/,
    );
    expect(() =>
      planCapThresholdAlert(
        evt({ ...base, scope: "agency_aggregate", bandTo: "inpatient_breach_20" }),
      ),
    ).toThrow(/no alert kind/);
    expect(() => planCapThresholdAlert(evt({ ...base, scope: "nope", bandTo: "warn_95" }))).toThrow(
      /unknown scope/,
    );
    expect(() =>
      planCapThresholdAlert(evt({ ...base, scope: "patient_aggregate", bandTo: "warn_95" })),
    ).toThrow(/patientId/);
  });

  it("every alert kind it can raise has a seeded platform rule", () => {
    const seeded = new Set(PLATFORM_DEFAULT_ALERT_RULES.map((r) => r.eventType));
    for (const scope of ["agency_aggregate", "patient_aggregate"]) {
      for (const bandTo of ["watch_90", "warn_95", "breach_100"]) {
        const { alertEventType } = planCapThresholdAlert(
          evt({ ...base, scope, bandTo, patientId: "p1" }),
        );
        expect(seeded.has(alertEventType), alertEventType).toBe(true);
      }
    }
    for (const bandTo of ["inpatient_watch_18", "inpatient_breach_20"]) {
      const { alertEventType } = planCapThresholdAlert(
        evt({ ...base, scope: "inpatient", bandTo }),
      );
      expect(seeded.has(alertEventType), alertEventType).toBe(true);
    }
  });
});

describe("buildM36CapThresholdAlertConsumer", () => {
  it("emits one idempotently-keyed alert per threshold event in the event's org", async () => {
    const emit = vi.fn(async () => ({}));
    const consumer = buildM36CapThresholdAlertConsumer({ emit } as never);
    expect(consumer.eventTypes).toEqual([CROSSED]);
    await consumer.handle({
      id: "x",
      organizationId: "o9",
      eventType: CROSSED,
      aggregateKind: "cap_period",
      aggregateId: "cp1",
      payload: { ...base, scope: "agency_aggregate", bandTo: "warn_95" },
      attemptCount: 0,
      createdAt: new Date(),
    });
    expect(emit).toHaveBeenCalledWith(
      "o9",
      expect.objectContaining({
        eventType: "m26.cap.agency_warn_95",
        severity: "warn",
        correlationId: "outbox:m26.cap.threshold_crossed:ev1",
      }),
    );
  });
});
