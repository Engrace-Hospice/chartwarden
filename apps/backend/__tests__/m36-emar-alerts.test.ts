import type { AlertEmitter } from "@wardenx/messaging";
import { describe, expect, it, vi } from "vitest";
import type { DispatchableOutboxEvent } from "../src/bootstrap/outbox-dispatcher";
import {
  M36_EMAR_ALERT_EVENT_TYPES,
  buildM36EmarAlertConsumer,
} from "../src/modules/36-messaging/outbox-consumers/emar-alerts";

const ORG = "11111111-1111-4111-8111-111111111111";
const PATIENT = "22222222-2222-4222-8222-222222222222";

function event(eventType: string, payload: Record<string, unknown>): DispatchableOutboxEvent {
  return {
    id: "33333333-3333-4333-8333-333333333333",
    organizationId: ORG,
    eventType,
    aggregateKind: "x",
    aggregateId: "agg",
    payload,
    attemptCount: 0,
    createdAt: new Date("2026-09-10T15:00:00.000Z"),
  };
}

function harness() {
  const emit = vi.fn(async () => ({}) as never);
  const consumer = buildM36EmarAlertConsumer({ emit } as unknown as AlertEmitter);
  return { emit, consumer };
}

describe("M36 eMAR alert consumer (GAP-039/040)", () => {
  it("binds exactly the five M13 deadline/detection events", () => {
    expect(buildM36EmarAlertConsumer({} as AlertEmitter).eventTypes).toEqual(
      M36_EMAR_ALERT_EVENT_TYPES,
    );
    expect(M36_EMAR_ALERT_EVENT_TYPES).toContain("m13.prn_reassessment.overdue");
  });

  it("raises a critical dose-missed alert for a controlled substance, warn otherwise, keyed on the dose", async () => {
    const { emit, consumer } = harness();
    const base = {
      patientId: PATIENT,
      scheduledDoseId: "sd-1",
      missedDoseId: "md-1",
      medicationOrderId: "o-1",
      dueAt: "2026-09-10T13:00:00.000Z",
    };
    await consumer.handle(event("m13.scheduled_dose.missed", { ...base, isControlled: true }));
    await consumer.handle(
      event("m13.scheduled_dose.missed", { ...base, scheduledDoseId: "sd-2", isControlled: false }),
    );

    expect(emit).toHaveBeenNthCalledWith(
      1,
      ORG,
      expect.objectContaining({
        eventType: "emar.dose_missed",
        severity: "critical",
        correlationId: "outbox:m13.scheduled_dose.missed:sd-1",
      }),
    );
    expect(emit).toHaveBeenNthCalledWith(
      2,
      ORG,
      expect.objectContaining({
        severity: "warn",
        correlationId: "outbox:m13.scheduled_dose.missed:sd-2",
      }),
    );
  });

  it("alerts on an overdue PRN reassessment with a per-PRN correlation id (a cron retry cannot page twice)", async () => {
    const { emit, consumer } = harness();
    await consumer.handle(
      event("m13.prn_reassessment.overdue", {
        patientId: PATIENT,
        prnAdministrationId: "prn-1",
        medicationOrderId: "o-1",
        recommendedReassessmentScale: "painad",
        reassessmentDueAt: "2026-09-10T14:50:00.000Z",
      }),
    );
    expect(emit).toHaveBeenCalledWith(
      ORG,
      expect.objectContaining({
        eventType: "m13.prn_reassessment.overdue",
        severity: "warn",
        correlationId: "outbox:m13.prn_reassessment.overdue:prn-1",
      }),
    );
  });

  it("makes the kit-return nag one alert per day and the reconciliation overdue tier critical", async () => {
    const { emit, consumer } = harness();
    await consumer.handle(
      event("m13.comfort_kit.return_overdue", {
        patientId: PATIENT,
        deploymentId: "k-1",
        daysOverdue: 35,
      }),
    );
    await consumer.handle(
      event("m13.reconciliation.overdue", {
        patientId: PATIENT,
        worksheetId: "w-1",
        triggerKind: "admission",
        dueAt: "x",
        overdueHours: 0.5,
      }),
    );
    expect(emit).toHaveBeenNthCalledWith(
      1,
      ORG,
      expect.objectContaining({
        severity: "critical",
        correlationId: "outbox:m13.comfort_kit.return_overdue:k-1:35",
      }),
    );
    expect(emit).toHaveBeenNthCalledWith(
      2,
      ORG,
      expect.objectContaining({
        severity: "critical",
        correlationId: "outbox:m13.reconciliation.overdue:w-1",
      }),
    );
  });

  it("carries no free text or drug name — ids, instants and constant copy only", async () => {
    const { emit, consumer } = harness();
    await consumer.handle(
      event("m13.scheduled_dose.missed", {
        patientId: PATIENT,
        scheduledDoseId: "sd-1",
        missedDoseId: "md-1",
        medicationOrderId: "o-1",
        dueAt: "t",
        isControlled: false,
        drugName: "Morphine",
      }),
    );
    const [, alert] = emit.mock.calls[0] as unknown as [
      string,
      { payload: Record<string, unknown> },
    ];
    expect(JSON.stringify(alert.payload)).not.toContain("Morphine");
  });

  it("throws on a malformed event (retry -> DLQ), never silently dropping the alert", async () => {
    const { emit, consumer } = harness();
    await expect(
      consumer.handle(event("m13.prn_reassessment.overdue", { prnAdministrationId: "prn-1" })),
    ).rejects.toThrow(/no patientId/);
    expect(emit).not.toHaveBeenCalled();
  });
});
