// ADR-0089 S2 - the export notification consumer: one fixed-text alert per request, nothing identifying in it, idempotent on the job id, and a
// failed emit propagates so the relay redelivers.
import type { AlertEmitter } from "@chartwarden/messaging";
import { describe, expect, it, vi } from "vitest";
import {
  EXPORT_APPROVAL_DEEP_LINK,
  EXPORT_REQUESTED_ALERT_TEXT,
  M36_EXPORT_NOTIFICATION_CONSUMER,
  buildM36ExportNotificationsConsumer,
} from "./export-notifications";

const ORG = "11111111-1111-4111-8111-111111111111";
const JOB = "22222222-2222-4222-8222-222222222222";
const PAYLOAD = {
  organizationId: ORG,
  jobId: JOB,
  requestedBy: "33333333-3333-4333-8333-333333333333",
  at: "2026-10-21T10:00:00.000Z",
};

function setup(
  emit: AlertEmitter["emit"] = async () => ({ alertId: "a", resolvedRecipientCount: 1 }),
) {
  const spy = vi.fn(emit);
  const consumer = buildM36ExportNotificationsConsumer({ alerts: { emit: spy } });
  const event = (eventType: string, payload: unknown = PAYLOAD) =>
    ({ id: "e1", eventType, organizationId: ORG, payload }) as never;
  return { consumer, spy, event };
}

describe("m36 export notifications consumer", () => {
  it("is named for the m36 module and consumes only the requested event", () => {
    const { consumer } = setup();
    expect(consumer.consumerName).toBe(M36_EXPORT_NOTIFICATION_CONSUMER);
    expect(consumer.consumerModule).toBe("m36");
    expect([...consumer.eventTypes]).toEqual(["m36.export.requested"]);
  });

  it("emits one generic warn alert keyed on the job, with no scope, name or free text", async () => {
    const { consumer, spy, event } = setup();
    await consumer.handle(event("m36.export.requested"));
    expect(spy).toHaveBeenCalledTimes(1);
    const [org, input] = spy.mock.calls[0] as [string, Parameters<AlertEmitter["emit"]>[1]];
    expect(org).toBe(ORG);
    expect(input).toMatchObject({
      eventType: "m36.export.requested",
      severity: "warn",
      correlationId: `export:${JOB}:requested`,
    });
    expect(input.payload).toEqual({
      jobId: JOB,
      requestedBy: PAYLOAD.requestedBy,
      message: EXPORT_REQUESTED_ALERT_TEXT,
      deepLink: EXPORT_APPROVAL_DEEP_LINK,
    });
  });

  it("ignores any other event and rejects a payload with no job id", async () => {
    const { consumer, spy, event } = setup();
    await consumer.handle(event("m36.export.approved"));
    expect(spy).not.toHaveBeenCalled();
    await expect(
      consumer.handle(event("m36.export.requested", { organizationId: ORG })),
    ).rejects.toThrow(/missing jobId/);
  });

  it("lets a failed emit propagate so the relay redelivers", async () => {
    const { consumer, event } = setup(async () => {
      throw new Error("alerts down");
    });
    await expect(consumer.handle(event("m36.export.requested"))).rejects.toThrow("alerts down");
  });
});
