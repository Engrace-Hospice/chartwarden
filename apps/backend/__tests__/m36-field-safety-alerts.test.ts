import type { AlertEmitter } from "@wardenx/messaging";
import { describe, expect, it, vi } from "vitest";
import type { DispatchableOutboxEvent } from "../src/bootstrap/outbox-dispatcher";
import {
  M36_FIELD_SAFETY_ALERT_EVENT_TYPES,
  buildM36FieldSafetyAlertConsumer,
} from "../src/modules/36-messaging/outbox-consumers/field-safety-alerts";

const ENVELOPE_ORG = "11111111-1111-4111-8111-111111111111";
const PAYLOAD_ORG = "99999999-9999-4999-8999-999999999999";
const PROVIDER = "22222222-2222-4222-8222-222222222222";
const CLINICIAN = "33333333-3333-4333-8333-333333333333";
const SCHEDULE = "44444444-4444-4444-8444-444444444444";

// The catalogued M20 shapes (events-by-m20.ts): `orgId` rides in the payload, `organizationId` does NOT.
const base = {
  orgId: PAYLOAD_ORG,
  providerEntityId: PROVIDER,
  occurredAt: "2026-09-10T15:00:00.000Z",
};

function event(eventType: string, payload: Record<string, unknown>): DispatchableOutboxEvent {
  return {
    id: "55555555-5555-4555-8555-555555555555",
    organizationId: ENVELOPE_ORG,
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
  const consumer = buildM36FieldSafetyAlertConsumer({ emit } as unknown as AlertEmitter);
  return { emit, consumer };
}

const overdue = {
  ...base,
  scheduleId: SCHEDULE,
  clinicianMembershipId: CLINICIAN,
  visitId: null,
  kind: "pre_visit",
  expectedAt: "2026-09-10T14:30:00.000Z",
  minutesOverdue: 30,
};
const escalated = {
  ...base,
  scheduleId: SCHEDULE,
  clinicianMembershipId: CLINICIAN,
  visitId: null,
  minutesOverdue: 45,
  afterHours: true,
  tier: "supervisor_alert",
};
const gap = {
  ...base,
  clinicianMembershipId: CLINICIAN,
  reason: "no_subscription",
  detectedAt: "2026-09-10T15:20:00.000Z",
};

describe("M36 field-safety alert consumer (GAP-061)", () => {
  it("binds exactly the three M20 watchdog events", () => {
    const binding = buildM36FieldSafetyAlertConsumer({} as AlertEmitter);
    expect(binding.eventTypes).toEqual(M36_FIELD_SAFETY_ALERT_EVENT_TYPES);
    expect(binding.consumerModule).toBe("m36");
  });

  it("raises a warn alert per overdue schedule under the ENVELOPE tenant, never the payload's", async () => {
    const { emit, consumer } = harness();
    await consumer.handle(event("m20.safety.check_in_overdue", overdue));
    expect(emit).toHaveBeenCalledWith(
      ENVELOPE_ORG,
      expect.objectContaining({
        eventType: "m20.safety.check_in_overdue",
        severity: "warn",
        correlationId: `outbox:m20.safety.check_in_overdue:${SCHEDULE}`,
      }),
    );
    expect(emit).not.toHaveBeenCalledWith(PAYLOAD_ORG, expect.anything());
  });

  it("raises a critical alert per escalation rung, so each D4 rung pages once and none is dropped", async () => {
    const { emit, consumer } = harness();
    await consumer.handle(event("m20.safety.check_in_escalated", escalated));
    await consumer.handle(
      event("m20.safety.check_in_escalated", { ...escalated, tier: "sos_equivalent" }),
    );
    const ids = emit.mock.calls.map(
      (c) => (c as unknown as [string, { correlationId: string }])[1].correlationId,
    );
    expect(ids).toEqual([
      `outbox:m20.safety.check_in_escalated:${SCHEDULE}:supervisor_alert`,
      `outbox:m20.safety.check_in_escalated_oncall:${SCHEDULE}:supervisor_alert`,
      `outbox:m20.safety.check_in_escalated:${SCHEDULE}:sos_equivalent`,
      `outbox:m20.safety.check_in_escalated_oncall:${SCHEDULE}:sos_equivalent`,
    ]);
    expect(emit).toHaveBeenCalledWith(
      ENVELOPE_ORG,
      expect.objectContaining({ severity: "critical" }),
    );
  });

  it("pages the M19 on-call roster with a second critical alert carrying the provider entity the on_call resolver reads", async () => {
    const { emit, consumer } = harness();
    await consumer.handle(event("m20.safety.check_in_escalated", escalated));
    const [org, input] = emit.mock.calls[1] as unknown as [
      string,
      { eventType: string; severity: string; payload: Record<string, unknown> },
    ];
    expect(org).toBe(ENVELOPE_ORG);
    expect(input).toMatchObject({
      eventType: "m20.safety.check_in_escalated_oncall",
      severity: "critical",
      payload: {
        eventType: "m20.safety.check_in_escalated_oncall",
        providerEntityId: PROVIDER,
        tier: "supervisor_alert",
      },
    });
    expect(input.payload).not.toHaveProperty("orgId");
    expect(input.payload).toMatchObject({ deepLink: "/safety" });
  });

  it("does not raise an on-call page for overdue or coverage-gap events", async () => {
    const { emit, consumer } = harness();
    await consumer.handle(event("m20.safety.check_in_overdue", overdue));
    await consumer.handle(event("m20.safety.coverage_gap_detected", gap));
    expect(emit).toHaveBeenCalledTimes(2);
  });

  it("alerts on a coverage gap, keyed per clinician/reason/hour so the hourly watchdog re-nags without double-paging", async () => {
    const { emit, consumer } = harness();
    await consumer.handle(event("m20.safety.coverage_gap_detected", gap));
    await consumer.handle(event("m20.safety.coverage_gap_detected", gap));
    await consumer.handle(
      event("m20.safety.coverage_gap_detected", { ...gap, detectedAt: "2026-09-10T16:20:00.000Z" }),
    );
    const ids = emit.mock.calls.map(
      (c) => (c as unknown as [string, { correlationId: string }])[1].correlationId,
    );
    expect(ids[0]).toBe(ids[1]);
    expect(ids[2]).not.toBe(ids[0]);
    expect(emit).toHaveBeenCalledWith(
      ENVELOPE_ORG,
      expect.objectContaining({
        eventType: "m20.safety.coverage_gap_detected",
        severity: "critical",
      }),
    );
  });

  it("carries ids and instants only (no PHI) and no organizationId from the payload", async () => {
    const { emit, consumer } = harness();
    await consumer.handle(event("m20.safety.check_in_overdue", overdue));
    const [, input] = emit.mock.calls[0] as unknown as [
      string,
      { payload: Record<string, unknown> },
    ];
    expect(input.payload).not.toHaveProperty("orgId");
    expect(input.payload).not.toHaveProperty("organizationId");
    expect(input.payload).toMatchObject({ clinicianMembershipId: CLINICIAN, minutesOverdue: 30 });
    expect(input.payload).toMatchObject({ deepLink: "/safety" });
  });

  it("throws on a malformed payload so the relay retries to the DLQ instead of dropping a safety page", async () => {
    const { emit, consumer } = harness();
    await expect(
      consumer.handle(event("m20.safety.check_in_escalated", { ...escalated, tier: undefined })),
    ).rejects.toThrow(/no tier/);
    await expect(
      consumer.handle(event("m20.safety.check_in_overdue", { ...overdue, scheduleId: "" })),
    ).rejects.toThrow(/no scheduleId/);
    expect(emit).not.toHaveBeenCalled();
  });
});
