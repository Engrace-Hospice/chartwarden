// GAP-118 — M36 turns M5's amendment-SLA events into one deterministic alert each (redelivery-safe, PHI-free).
import { describe, expect, it, vi } from "vitest";
import {
  buildM36AmendmentSlaAlertConsumer,
  planAmendmentSlaAlert,
} from "../src/modules/36-messaging/outbox-consumers/amendment-sla-alerts";

const payload = {
  patientId: "p-1",
  organizationId: "org-1",
  amendmentId: "amd-1",
  slaDueAt: "2026-10-10T00:00:00.000Z",
};

describe("amendment SLA alerts", () => {
  it("plans a distinct correlation per tier and carries no free text", () => {
    const soon = planAmendmentSlaAlert({ eventType: "m5.patient.amendment_sla_due_soon", payload });
    const late = planAmendmentSlaAlert({ eventType: "m5.patient.amendment_sla_overdue", payload });
    expect(soon.correlationKey).toBe("amd-1:due_soon");
    expect(late.correlationKey).toBe("amd-1:overdue");
    expect(Object.keys(soon.safe).sort()).toEqual(
      ["amendmentId", "deepLink", "message", "patientId", "slaDueAt"].sort(),
    );
  });

  it("a malformed event throws (retry -> DLQ), never a silent drop", () => {
    expect(() =>
      planAmendmentSlaAlert({
        eventType: "m5.patient.amendment_sla_overdue",
        payload: { patientId: "p-1" },
      }),
    ).toThrow(/amendmentId/);
    expect(() => planAmendmentSlaAlert({ eventType: "m5.patient.created", payload })).toThrow(
      /unexpected/,
    );
  });

  it("emits one warn alert with the deterministic correlation id", async () => {
    const emit = vi.fn(async () => undefined);
    const consumer = buildM36AmendmentSlaAlertConsumer({ emit } as never);
    await consumer.handle({
      eventType: "m5.patient.amendment_sla_overdue",
      organizationId: "org-1",
      payload,
    } as never);
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith(
      "org-1",
      expect.objectContaining({
        eventType: "m5.patient.amendment_sla_overdue",
        severity: "warn",
        correlationId: "outbox:m5.patient.amendment_sla_overdue:amd-1:overdue",
      }),
    );
  });
});
