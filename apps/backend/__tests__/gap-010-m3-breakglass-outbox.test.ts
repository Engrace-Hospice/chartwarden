import { PLATFORM_DEFAULT_ALERT_RULES } from "@chartwarden/messaging";
import { Value } from "@sinclair/typebox/value";
// GAP-010 — M3 break-glass durable Compliance notification: catalog + M36 consumer (unit).
import { describe, expect, it, vi } from "vitest";
import { M3_OUTBOX_EVENTS } from "../src/modules/03-authorization/events-by-m3";
import {
  M36_BREAKGLASS_ALERT_CONSUMER,
  buildM36BreakGlassAlertConsumer,
} from "../src/modules/36-messaging/outbox-consumers/breakglass-alert";

const invokedPayload = {
  breakGlassId: "bg-1",
  organizationId: "org-a",
  actorUserId: "user-1",
  targetPatientId: "pat-1",
  expiresAt: "2026-10-04T12:00:00.000Z",
  cosignRequired: false,
};
const event = (payload: unknown) => ({
  eventType: "m3.breakglass.invoked",
  organizationId: "org-a",
  payload,
});

describe("M3_OUTBOX_EVENTS", () => {
  it("registers the five spec'd m3.* events, all owned by m3", () => {
    expect(M3_OUTBOX_EVENTS.map((e) => e.eventName).sort()).toEqual(
      [
        "m3.breakglass.invoked",
        "m3.breakglass.ended",
        "m3.engagement.closed",
        "m3.role.assigned",
        "m3.role.revoked",
      ].sort(),
    );
    for (const e of M3_OUTBOX_EVENTS) expect(e.moduleOwner).toBe("m3");
  });

  it("breakglass.invoked declares m36 as its outbox consumer; the others are record-only", () => {
    for (const e of M3_OUTBOX_EVENTS) {
      expect(e.declaredConsumers).toEqual(e.eventName === "m3.breakglass.invoked" ? ["m36"] : []);
    }
  });

  it("the invoked payload schema accepts the real shape and carries no free-text reason", () => {
    const schema = M3_OUTBOX_EVENTS.find(
      (e) => e.eventName === "m3.breakglass.invoked",
    )!.payloadSchema;
    expect(Value.Check(schema, invokedPayload)).toBe(true);
    expect(Value.Check(schema, { ...invokedPayload, breakGlassId: undefined })).toBe(false);
    expect(Object.keys((schema as unknown as { properties: object }).properties)).not.toContain(
      "reason",
    );
  });
});

describe("M36 break-glass alert consumer", () => {
  it("emits a critical m3.breakglass.invoked alert for the event's org, correlated on the grant id", async () => {
    const emit = vi.fn(async () => ({}));
    const consumer = buildM36BreakGlassAlertConsumer({ alerts: { emit } });
    await consumer.handle(event(invokedPayload));
    expect(emit).toHaveBeenCalledWith("org-a", {
      eventType: "m3.breakglass.invoked",
      severity: "critical",
      correlationId: "m3.breakglass.invoked:bg-1",
      payload: invokedPayload,
    });
  });

  it("an emitter failure throws so the relay retries", async () => {
    const consumer = buildM36BreakGlassAlertConsumer({
      alerts: {
        emit: async () => {
          throw new Error("emitter down");
        },
      },
    });
    await expect(consumer.handle(event(invokedPayload))).rejects.toThrow("emitter down");
  });

  it("a malformed payload is a named poison event and emits nothing", async () => {
    const emit = vi.fn(async () => ({}));
    const consumer = buildM36BreakGlassAlertConsumer({ alerts: { emit } });
    await expect(consumer.handle(event({}))).rejects.toThrow(/m36\.breakglass-alert/);
    await expect(consumer.handle(event(undefined))).rejects.toThrow(/m36\.breakglass-alert/);
    expect(emit).not.toHaveBeenCalled();
  });

  it("binds m36 to exactly m3.breakglass.invoked", () => {
    const consumer = buildM36BreakGlassAlertConsumer({ alerts: { emit: async () => ({}) } });
    expect(consumer.consumerModule).toBe("m36");
    expect(consumer.eventTypes).toEqual(["m3.breakglass.invoked"]);
    expect(consumer.consumerName).toBe(M36_BREAKGLASS_ALERT_CONSUMER.consumerName);
  });

  it("a platform-default alert_rule routes m3.breakglass.invoked to compliance (org_admin backstop) at critical", () => {
    const rule = PLATFORM_DEFAULT_ALERT_RULES.find((r) => r.eventType === "m3.breakglass.invoked");
    expect(rule).toBeDefined();
    expect(rule!.severityFloor).toBe("critical");
    expect(rule!.recipientResolver).toBe("role_set");
    expect(rule!.resolverArgs).toEqual({ roleKeys: ["compliance_officer", "org_admin"] });
    expect(rule!.systemLocked).toBe(true);
    expect(rule!.enabled).toBe(true);
  });
});
