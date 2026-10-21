// GAP-049 — M36 consumes M30's quality events and raises the §4.9 alerts (sentinel / abuse allegation, outbreak,
// threshold breach, CAHPS sample). Before this nothing consumed any m30.* event.
import type { AlertEmitter } from "@chartwarden/messaging";
import { describe, expect, it, vi } from "vitest";
import type { DispatchableOutboxEvent } from "../src/bootstrap/outbox-dispatcher";
import {
  M36_QUALITY_ALERT_EVENT_TYPES,
  buildM36QualityAlertConsumer,
} from "../src/modules/36-messaging/outbox-consumers/quality-alerts";

const ENVELOPE_ORG = "11111111-1111-4111-8111-111111111111";
const PAYLOAD_ORG = "99999999-9999-4999-8999-999999999999";
const INCIDENT = "22222222-2222-4222-8222-222222222222";

function event(eventType: string, payload: Record<string, unknown>): DispatchableOutboxEvent {
  return {
    id: "55555555-5555-4555-8555-555555555555",
    organizationId: ENVELOPE_ORG,
    eventType,
    aggregateKind: "x",
    aggregateId: "agg",
    payload,
    attemptCount: 0,
    createdAt: new Date("2026-10-08T12:00:00.000Z"),
  };
}

function harness() {
  // A real emitter always reports how many people it resolved; 1 here (the zero-recipient fallback is covered in
  // m30-alert-repeat-sweeps.test.ts and the GAP-049 live suite).
  const emit = vi.fn(async () => ({ alertId: "alert-1", resolvedRecipientCount: 1 }) as never);
  return { emit, consumer: buildM36QualityAlertConsumer({ emit } as unknown as AlertEmitter) };
}

const submitted = (kind: string, severity: string) =>
  event("m30.incident.submitted", {
    orgId: PAYLOAD_ORG,
    incidentId: INCIDENT,
    kind,
    severity,
    reportedAt: "2026-10-08T11:59:00.000Z",
    hasPatientLink: true,
  });

const emittedTypes = (emit: ReturnType<typeof harness>["emit"]) =>
  emit.mock.calls.map((c) => (c as unknown as [string, { eventType: string }])[1].eventType);

describe("M36 quality alert consumer (GAP-049)", () => {
  it("binds the four M30 events whose catalog text says M36 raises an alert", () => {
    const binding = buildM36QualityAlertConsumer({} as AlertEmitter);
    expect(binding.eventTypes).toEqual(M36_QUALITY_ALERT_EVENT_TYPES);
    expect(binding.consumerModule).toBe("m36");
  });

  it("raises a critical sentinel alert for a critical-severity incident, under the ENVELOPE tenant", async () => {
    const { emit, consumer } = harness();
    await consumer.handle(submitted("fall", "critical"));
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith(
      ENVELOPE_ORG,
      expect.objectContaining({
        eventType: "m30.alerts.incident_sentinel",
        severity: "critical",
        correlationId: `outbox:m30.alerts.incident_sentinel:${INCIDENT}`,
      }),
    );
    expect(emit).not.toHaveBeenCalledWith(PAYLOAD_ORG, expect.anything());
  });

  it("raises the abuse-allegation alert, and BOTH alerts for a critical abuse allegation", async () => {
    const abuse = harness();
    await abuse.consumer.handle(submitted("allegation_of_abuse", "moderate"));
    expect(emittedTypes(abuse.emit)).toEqual(["m30.alerts.incident_abuse_allegation"]);
    const both = harness();
    await both.consumer.handle(submitted("allegation_of_abuse", "critical"));
    expect(emittedTypes(both.emit)).toEqual([
      "m30.alerts.incident_sentinel",
      "m30.alerts.incident_abuse_allegation",
    ]);
  });

  it("raises nothing for an ordinary submitted incident", async () => {
    const { emit, consumer } = harness();
    await consumer.handle(submitted("fall", "moderate"));
    expect(emit).not.toHaveBeenCalled();
  });

  it("raises the outbreak, threshold-breach and CAHPS alerts with deterministic correlation ids", async () => {
    const { emit, consumer } = harness();
    await consumer.handle(
      event("m30.infection.outbreak_opened", {
        orgId: PAYLOAD_ORG,
        caseId: "case-1",
        pathogen: "c_diff",
        bodySite: "gi",
        eventCount: 3,
        firstEventAt: "2026-10-01T00:00:00.000Z",
        lastEventAt: "2026-10-08T00:00:00.000Z",
      }),
    );
    await consumer.handle(
      event("m30.measure.threshold_breached", {
        orgId: PAYLOAD_ORG,
        indicatorId: "ind-1",
        measureId: "hci_indicator_01",
        periodEnd: "2026-09-30T00:00:00.000Z",
        rate: 0.4,
        threshold: 0.3,
        severityBand: "red",
      }),
    );
    await consumer.handle(
      event("m30.cahps.sample_ready", {
        orgId: PAYLOAD_ORG,
        samplePeriod: { start: "2026-09-01", end: "2026-09-30" },
        decedentCount: 12,
        vendor: "vendor-x",
      }),
    );
    const ids = emit.mock.calls.map(
      (c) => (c as unknown as [string, { correlationId: string }])[1].correlationId,
    );
    expect(ids).toEqual([
      "outbox:m30.alerts.outbreak_detected:case-1",
      "outbox:m30.alerts.measure_threshold_breached:ind-1:2026-09-30T00:00:00.000Z",
      "outbox:m30.alerts.cahps_sample_ready:2026-09-01:2026-09-30",
    ]);
  });

  it("carries ids and counts only — no patient identifier reaches the alert payload", async () => {
    const { emit, consumer } = harness();
    await consumer.handle(submitted("fall", "critical"));
    const [, input] = emit.mock.calls[0] as unknown as [
      string,
      { payload: Record<string, unknown> },
    ];
    expect(Object.keys(input.payload)).not.toContain("patientId");
  });

  it("throws on a malformed payload so the relay retries to the DLQ instead of dropping a safety page", async () => {
    const { consumer } = harness();
    await expect(
      consumer.handle(event("m30.incident.submitted", { orgId: PAYLOAD_ORG, kind: "fall" })),
    ).rejects.toThrow(/incidentId/);
  });
});
