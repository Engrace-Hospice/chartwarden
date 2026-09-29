// F-184 (#248) — the pure half of the lab-order supersession alert: the decision table, the declarations that make
// the consumer bindable, and the platform-default alert rule that decides whether a human is actually reached.
// (The consumer's DB behaviour and tenancy are proven live in `m11-lab-cancellation.live.test.ts`.)
import { PLATFORM_DEFAULT_ALERT_RULES, validateAlertRuleSeed } from "@wardenx/messaging";
import { describe, expect, it } from "vitest";
import { M11_OUTBOX_SUBSCRIPTIONS } from "../src/modules/11-orders/consumers/index";
import { M11_OUTBOX_EVENTS } from "../src/modules/11-orders/index";
import {
  type LabCancellationFacts,
  M11_LAB_CANCELLATION_ALERT_TYPE,
  M11_LAB_CANCELLATION_CONSUMER,
  buildM11LabCancellationConsumer,
  decideLabCancellation,
} from "../src/modules/11-orders/outbox-consumers/lab-cancellation-required";

const SIGNED = new Date("2026-01-01T00:00:00Z");
const base: LabCancellationFacts = {
  kind: "lab",
  signedAt: SIGNED,
  transmissionStatus: "transmitted",
  transmissionFailureReason: null,
  resultsStatus: "awaiting_results",
};
const facts = (over: Partial<LabCancellationFacts>): LabCancellationFacts => ({ ...base, ...over });

describe("decideLabCancellation — does a superseded lab order need a human to tell the lab?", () => {
  it.each([
    ["transmitted", { transmissionStatus: "transmitted" }, "transmitted"],
    ["pending (ORM requested, not yet acknowledged)", { transmissionStatus: "pending" }, "in_flight"],
    ["pending_retry", { transmissionStatus: "pending_retry" }, "in_flight"],
    [
      "failed by an M29 terminal failure (delivery unverified)",
      { transmissionStatus: "failed", transmissionFailureReason: "dlq_exhausted" },
      "delivery_unverified",
    ],
    [
      "failed with no recorded reason",
      { transmissionStatus: "failed", transmissionFailureReason: null },
      "delivery_unverified",
    ],
    ["partial results (the lab is still working)", { resultsStatus: "partial_results_received" }, "transmitted"],
    ["results overdue", { resultsStatus: "results_overdue" }, "transmitted"],
  ] as const)("%s → alert", (_name, over, expected) => {
    expect(decideLabCancellation(facts(over))).toBe(expected);
  });

  it.each([
    ["an F-181 refusal never produced an ORM", { transmissionStatus: "failed", transmissionFailureReason: "orm_refused:sud_restricted" }],
    ["the lab has finished (results received)", { resultsStatus: "results_received" }],
    ["not a lab order", { kind: "dme" }],
    ["`not_required` (not a transmitted order)", { transmissionStatus: "not_required" }],
    // `insertDraft` writes transmission_status='pending' on EVERY lab draft: `pending` alone is not "in flight".
    ["a never-signed lab draft is born `pending` — no ORM was ever requested", { signedAt: null, transmissionStatus: "pending" }],
    ["never signed, whatever the status says", { signedAt: null, transmissionStatus: "transmitted" }],
  ] as const)("%s → nothing", (_name, over) => {
    expect(decideLabCancellation(facts(over))).toBeNull();
  });

  it("an unknown future transmission status fails SAFE — no alert, never a guess", () => {
    expect(decideLabCancellation(facts({ transmissionStatus: "something_new" }))).toBeNull();
  });
});

describe("declarations — the consumer is bindable and reaches a human", () => {
  const catalog = new Map(M11_OUTBOX_EVENTS.map((e) => [e.eventName, e]));

  it("the catalog names m11 as a (self-)consumer of both supersession events", () => {
    for (const name of M11_LAB_CANCELLATION_CONSUMER.eventNames) {
      expect(catalog.get(name)?.declaredConsumers, name).toContain("m11");
    }
  });

  it("M11's own subscription list (outbox-bindings rule 6) names the consumer on both events", () => {
    for (const name of M11_LAB_CANCELLATION_CONSUMER.eventNames) {
      expect(M11_OUTBOX_SUBSCRIPTIONS).toContainEqual({
        eventName: name,
        consumerName: M11_LAB_CANCELLATION_CONSUMER.consumerName,
      });
    }
  });

  it("the alert has a platform-default rule that resolves recipients from the payload's patientId", () => {
    const rule = PLATFORM_DEFAULT_ALERT_RULES.find((r) => r.eventType === M11_LAB_CANCELLATION_ALERT_TYPE);
    // Without a rule `AlertEmitterPorts.rulesFor` returns [] and the alert is dropped silently.
    expect(rule).toBeDefined();
    expect(rule?.enabled).toBe(true);
    expect(rule?.recipientResolver).toBe("care_team");
    expect(rule?.resolverArgs).toEqual({ patientIdPath: "patientId" });
  });

  it("the platform-default alert seed is still valid (M36 refuses to boot otherwise)", () => {
    expect(validateAlertRuleSeed()).toEqual([]);
  });
});

describe("the consumer refuses malformed events loudly (a dead-letter, never a silent drop)", () => {
  const consumer = buildM11LabCancellationConsumer({
    db: {} as never,
    alerts: { emit: async () => undefined },
  });

  it("subscribes to exactly the two supersession events", () => {
    expect([...consumer.eventTypes].sort()).toEqual(["m11.order.corrected", "m11.order.discontinued"]);
    expect(consumer.consumerModule).toBe("m11");
  });

  it("a discontinued payload with no orderId throws", async () => {
    await expect(
      consumer.handle({ eventType: "m11.order.discontinued", organizationId: "o", payload: {} }),
    ).rejects.toThrow(/no orderId/);
  });

  it("a corrected payload with no replacedOrderId throws (the ORIGINAL is the order at the lab)", async () => {
    await expect(
      consumer.handle({ eventType: "m11.order.corrected", organizationId: "o", payload: { newOrderId: "n" } }),
    ).rejects.toThrow(/no replacedOrderId/);
  });

  it("an event this consumer was not subscribed to throws", async () => {
    await expect(
      consumer.handle({ eventType: "m11.order.completed", organizationId: "o", payload: { orderId: "x" } }),
    ).rejects.toThrow(/unexpected event/);
  });
});
