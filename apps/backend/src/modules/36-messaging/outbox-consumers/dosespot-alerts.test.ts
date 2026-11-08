// Review of slice 4, M3: M12 published `m12.dosespot_degraded` / `m12.dosespot_recovered` with no consumer, so no tenant administrator was
// ever told that signed prescriptions were not reaching DoseSpot. M36's consumer turns each into an alert: one per event (a redelivery
// is absorbed by the alert's correlation id), the tenant from the envelope, no free text from the payload, a malformed event throws.
import type { AlertEmitter } from "@chartwarden/messaging";
import { describe, expect, it, vi } from "vitest";

import {
  M36_DOSESPOT_ALERT_EVENT_TYPES,
  buildM36DosespotAlertConsumer,
  planDosespotAlert,
} from "./dosespot-alerts";

describe("M36 dosespot-alerts consumer", () => {
  const ORG = "11111111-1111-4111-8111-111111111111";
  const event = (eventType: string, payload: Record<string, unknown>, id = "evt-1") =>
    ({ id, eventType, organizationId: ORG, payload }) as never;
  const opened = {
    breakerName: `dosespot-queued_orders_stale:${ORG}`,
    openedAt: "2026-11-06T10:00:00.000Z",
    lastErrorClass: "queued_orders_stale",
  };
  const closed = {
    breakerName: `dosespot-queued_orders_stale:${ORG}`,
    closedAt: "2026-11-06T11:00:00.000Z",
  };

  it("turns an opened episode into a critical alert keyed by the event, naming the fault without free text", () => {
    const plan = planDosespotAlert(event("m12.dosespot_degraded", opened));
    expect(plan).toMatchObject({
      alertType: "m12.dosespot_degraded",
      severity: "critical",
      correlationId: "outbox:m12.dosespot_degraded:evt-1",
    });
    expect(plan.payload).toMatchObject({
      eventType: "m12.dosespot_degraded",
      breakerName: opened.breakerName,
      openedAt: opened.openedAt,
      lastErrorClass: "queued_orders_stale",
    });
    expect(String(plan.payload.detail)).toMatch(/waiting to be sent to DoseSpot/);
  });

  it("says something different for each kind of fault, and a generic thing for a breaker that opened", () => {
    const detail = (lastErrorClass: string) =>
      String(
        planDosespotAlert(event("m12.dosespot_degraded", { ...opened, lastErrorClass })).payload
          .detail,
      );
    expect(detail("config_unavailable")).toMatch(/configuration/);
    expect(detail("5xx_503")).toMatch(/temporarily unavailable/);
    expect(
      new Set([detail("config_unavailable"), detail("queued_orders_stale"), detail("5xx_503")])
        .size,
    ).toBe(3);
  });

  it("turns a closed episode into an informational notice", () => {
    const plan = planDosespotAlert(event("m12.dosespot_recovered", closed, "evt-2"));
    expect(plan).toMatchObject({
      alertType: "m12.dosespot_recovered",
      severity: "info",
      correlationId: "outbox:m12.dosespot_recovered:evt-2",
    });
    expect(plan.payload).toMatchObject({ closedAt: closed.closedAt });
  });

  it("a redelivery of the same event has the same correlation id, a different event a different one", () => {
    const a = planDosespotAlert(event("m12.dosespot_degraded", opened, "evt-1"));
    const again = planDosespotAlert(event("m12.dosespot_degraded", opened, "evt-1"));
    const other = planDosespotAlert(event("m12.dosespot_degraded", opened, "evt-9"));
    expect(again.correlationId).toBe(a.correlationId);
    expect(other.correlationId).not.toBe(a.correlationId);
  });

  it("throws on a malformed payload (relay retry, then DLQ) instead of dropping the alert", () => {
    expect(() =>
      planDosespotAlert(event("m12.dosespot_degraded", { ...opened, breakerName: "" })),
    ).toThrow(/breakerName/);
    expect(() =>
      planDosespotAlert(event("m12.dosespot_degraded", { ...opened, openedAt: undefined })),
    ).toThrow(/openedAt/);
    expect(() =>
      planDosespotAlert(event("m12.dosespot_degraded", { breakerName: "b", openedAt: "t" })),
    ).toThrow(/lastErrorClass/);
    expect(() => planDosespotAlert(event("m12.dosespot_recovered", { breakerName: "b" }))).toThrow(
      /closedAt/,
    );
    expect(() => planDosespotAlert(event("m12.dosespot_recovered", null as never))).toThrow(
      /breakerName/,
    );
  });

  it("turns a held transmission into a critical alert naming the order, with the way out in its sentence", () => {
    const plan = planDosespotAlert(
      event(
        "m12.medication_order.transmission_unconfirmed",
        { orderId: "order-1", lastErrorClass: "unconfirmed_outcome" },
        "evt-3",
      ),
    );
    expect(plan).toMatchObject({
      alertType: "m12.medication_order.transmission_unconfirmed",
      severity: "critical",
      correlationId: "outbox:m12.medication_order.transmission_unconfirmed:evt-3",
    });
    expect(plan.payload).toMatchObject({
      orderId: "order-1",
      lastErrorClass: "unconfirmed_outcome",
    });
    expect(String(plan.payload.detail)).toMatch(/DoseSpot account/);
    expect(() =>
      planDosespotAlert(
        event("m12.medication_order.transmission_unconfirmed", { lastErrorClass: "x" }),
      ),
    ).toThrow(/orderId/);
  });

  it("turns a retry-exhausted transmission into a critical alert naming the order, saying it has NOT reached the pharmacy", () => {
    const plan = planDosespotAlert(
      event(
        "m12.medication_order.transmission_failed",
        { orderId: "order-2", lastErrorClass: "degraded_retryable", retryCount: 5 },
        "evt-4",
      ),
    );
    expect(plan).toMatchObject({
      alertType: "m12.medication_order.transmission_failed",
      severity: "critical",
      correlationId: "outbox:m12.medication_order.transmission_failed:evt-4",
    });
    expect(plan.payload).toMatchObject({
      orderId: "order-2",
      lastErrorClass: "degraded_retryable",
      retryCount: 5,
    });
    expect(String(plan.payload.detail)).toMatch(/NOT reached the pharmacy/);
    expect(String(plan.payload.detail)).toMatch(/retransmit/i);
  });

  it("says the administrator's own word when a held order was resolved as not sent, and refuses a payload with no order", () => {
    const resolved = planDosespotAlert(
      event("m12.medication_order.transmission_failed", {
        orderId: "order-3",
        lastErrorClass: "resolved_not_sent",
        retryCount: 0,
      }),
    );
    expect(String(resolved.payload.detail)).toMatch(/administrator confirmed/);
    expect(() =>
      planDosespotAlert(
        event("m12.medication_order.transmission_failed", { lastErrorClass: "x", retryCount: 1 }),
      ),
    ).toThrow(/orderId/);
  });

  it("refuses an event it does not own (the deactivation alert is raised directly, so a second path would page twice)", () => {
    expect(() => planDosespotAlert(event("m12.dosespot_config.deactivated", {}))).toThrow(
      /unexpected event/,
    );
  });

  it("emits for the envelope's organization, never a payload's, through the AlertEmitter", async () => {
    const emit = vi.fn().mockResolvedValue({ alertId: "a", resolvedRecipientCount: 2 });
    const consumer = buildM36DosespotAlertConsumer({ emit } as unknown as AlertEmitter);
    expect(consumer.consumerModule).toBe("m36");
    expect(consumer.eventTypes).toEqual([...M36_DOSESPOT_ALERT_EVENT_TYPES]);
    expect(consumer.eventTypes).toEqual([
      "m12.dosespot_degraded",
      "m12.dosespot_recovered",
      "m12.medication_order.transmission_unconfirmed",
      "m12.medication_order.transmission_failed",
    ]);
    await consumer.handle(
      event("m12.dosespot_degraded", { ...opened, organizationId: "attacker-org" }),
    );
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit.mock.calls[0]?.[0]).toBe(ORG);
    expect(emit.mock.calls[0]?.[1]).toMatchObject({
      eventType: "m12.dosespot_degraded",
      severity: "critical",
      correlationId: "outbox:m12.dosespot_degraded:evt-1",
    });
  });

  it("lets an emitter failure propagate so the relay redelivers it", async () => {
    const emit = vi.fn().mockRejectedValue(new Error("emitter down"));
    const consumer = buildM36DosespotAlertConsumer({ emit } as unknown as AlertEmitter);
    await expect(consumer.handle(event("m12.dosespot_degraded", opened))).rejects.toThrow(
      "emitter down",
    );
  });
});
