// GAP-107 — M36's consumer of M37's IV bedside-check-overdue watchdog event.
import type { AlertEmitter } from "@chartwarden/messaging";
import { describe, expect, it, vi } from "vitest";
import type { DispatchableOutboxEvent } from "../src/bootstrap/outbox-dispatcher";
import {
  M36_IPU_IV_ALERT_EVENT_TYPES,
  buildM36IpuIvAlertConsumer,
} from "../src/modules/36-messaging/outbox-consumers/ipu-iv-alerts";

const ORG = "11111111-1111-4111-8111-111111111111";
const PATIENT = "22222222-2222-4222-8222-222222222222";
const NAME = "m37.iv_safety_overlay.bedside_check_overdue";

const event = (payload: Record<string, unknown>): DispatchableOutboxEvent => ({
  id: "33333333-3333-4333-8333-333333333333",
  organizationId: ORG,
  eventType: NAME,
  aggregateKind: "ipu_iv_safety_overlay",
  aggregateId: "ov-1",
  payload,
  attemptCount: 0,
  createdAt: new Date("2026-10-05T15:00:00.000Z"),
});

const payload = {
  ipuAdmissionId: "adm-1",
  orderId: "ord-1",
  overlayId: "ov-1",
  patientId: PATIENT,
  lastCheckAt: "2026-10-05T14:00:00.000Z",
  intervalMinutes: 60,
  minutesOverdue: 5,
  missedIntervals: 1,
};

function harness() {
  const emit = vi.fn(async (_org: string, _input: { correlationId: string }) => ({}) as never);
  return { emit, consumer: buildM36IpuIvAlertConsumer({ emit } as unknown as AlertEmitter) };
}

describe("M36 IPU IV alert consumer (GAP-107)", () => {
  it("binds exactly the bedside-check-overdue event", () => {
    expect(buildM36IpuIvAlertConsumer({} as AlertEmitter).eventTypes).toEqual(
      M36_IPU_IV_ALERT_EVENT_TYPES,
    );
  });

  it("raises one warn alert for the envelope's org, keyed on overlay + last check + interval count", async () => {
    const { emit, consumer } = harness();
    await consumer.handle(event(payload));
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith(
      ORG,
      expect.objectContaining({
        eventType: NAME,
        severity: "warn",
        correlationId: `outbox:${NAME}:ov-1:2026-10-05T14:00:00.000Z:1`,
        payload: expect.objectContaining({ patientId: PATIENT, intervalMinutes: 60 }),
      }),
    );
  });

  it("takes the tenant from the envelope, never the payload", async () => {
    const { emit, consumer } = harness();
    await consumer.handle(
      event({ ...payload, organizationId: "99999999-9999-4999-8999-999999999999" }),
    );
    expect(emit.mock.calls[0]?.[0]).toBe(ORG);
  });

  it("a further missed interval is a distinct alert; a redelivery of the same one is the same alert", async () => {
    const { emit, consumer } = harness();
    await consumer.handle(event(payload));
    await consumer.handle(event(payload));
    await consumer.handle(event({ ...payload, missedIntervals: 2 }));
    const ids = emit.mock.calls.map((c) => c[1].correlationId);
    expect(ids[0]).toBe(ids[1]);
    expect(ids[2]).not.toBe(ids[0]);
  });

  it.each(["patientId", "overlayId", "lastCheckAt"])(
    "throws (-> relay retry/DLQ) when %s is missing, never drops the alert",
    async (key) => {
      const { emit, consumer } = harness();
      await expect(consumer.handle(event({ ...payload, [key]: undefined }))).rejects.toThrow(key);
      expect(emit).not.toHaveBeenCalled();
    },
  );
});
