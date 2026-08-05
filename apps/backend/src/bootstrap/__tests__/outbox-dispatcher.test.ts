// TASK-006 — pure decision surface of the outbox dispatcher. The relay's DB behavior (claim /
// finalize / DLQ / purge under RLS) is exercised by the live-cluster suite (TASK-007 adds the CI
// row); what is unit-testable without a database is the backoff math the retry clock runs on.
import { Type } from "@sinclair/typebox";
import type { OutboxEventEntry } from "@wardenx/types";
import { describe, expect, it } from "vitest";
import {
  type OutboxConsumerBinding,
  buildOutboxRoutingPlan,
  outboxBackoffMs,
} from "../outbox-dispatcher";

const entry = (
  eventName: `m${number}.${string}.${string}`,
  declaredConsumers: OutboxEventEntry["declaredConsumers"],
): OutboxEventEntry => ({
  eventName,
  moduleOwner: "m1",
  description: eventName,
  payloadSchema: Type.Object({}),
  declaredConsumers,
  isOutboxOnly: true,
});

const binding = (
  consumerModule: OutboxConsumerBinding["consumerModule"],
  eventType: string,
): OutboxConsumerBinding => ({
  consumerName: `${consumerModule}.test-consumer`,
  consumerModule,
  eventTypes: [eventType],
  async handle() {},
});

describe("outboxBackoffMs", () => {
  it("doubles per attempt from the base (attempt is 1-based)", () => {
    expect(outboxBackoffMs(1, 5_000, 900_000)).toBe(5_000);
    expect(outboxBackoffMs(2, 5_000, 900_000)).toBe(10_000);
    expect(outboxBackoffMs(3, 5_000, 900_000)).toBe(20_000);
    expect(outboxBackoffMs(6, 5_000, 900_000)).toBe(160_000);
  });

  it("caps at the ceiling instead of growing unboundedly", () => {
    expect(outboxBackoffMs(20, 5_000, 900_000)).toBe(900_000);
  });

  it("treats a degenerate attempt 0 as the base delay (never negative/zero backoff)", () => {
    expect(outboxBackoffMs(0, 5_000, 900_000)).toBe(5_000);
  });
});

describe("buildOutboxRoutingPlan", () => {
  it("routes landed bindings while keeping an incomplete fan-out deferred", () => {
    const event = entry("m1.test.changed", ["m5", "m6"]);
    const catalog = new Map([[event.eventName, event]]);

    const plan = buildOutboxRoutingPlan(catalog, [binding("m5", event.eventName)]);

    expect(plan.deferred.has(event.eventName)).toBe(true);
    expect(plan.live.get(event.eventName)).toHaveLength(1);
    expect(plan.recordOnly.has(event.eventName)).toBe(false);
  });

  it("routes only after every declared consumer module is bound", () => {
    const event = entry("m1.test.changed", ["m5", "m6"]);
    const catalog = new Map([[event.eventName, event]]);

    const plan = buildOutboxRoutingPlan(catalog, [
      binding("m5", event.eventName),
      binding("m6", event.eventName),
    ]);

    expect(plan.live.get(event.eventName)).toHaveLength(2);
    expect(plan.deferred.has(event.eventName)).toBe(false);
  });

  it("marks only explicit zero-consumer catalog entries record-only", () => {
    const event = entry("m1.audit.recorded", []);
    const plan = buildOutboxRoutingPlan(new Map([[event.eventName, event]]), []);
    expect(plan.recordOnly.has(event.eventName)).toBe(true);
  });

  it("fails boot for a consumer binding absent from the catalog", () => {
    expect(() => buildOutboxRoutingPlan(new Map(), [binding("m5", "m5.unknown.changed")])).toThrow(
      "unknown catalog event",
    );
  });

  it("fails boot when the catalog calls a live-bound event record-only", () => {
    const event = entry("m1.audit.recorded", []);
    expect(() =>
      buildOutboxRoutingPlan(new Map([[event.eventName, event]]), [binding("m5", event.eventName)]),
    ).toThrow("catalogued record-only");
  });

  it("fails boot when a binding module is not declared by the catalog", () => {
    const event = entry("m1.test.changed", ["m6"]);
    expect(() =>
      buildOutboxRoutingPlan(new Map([[event.eventName, event]]), [binding("m5", event.eventName)]),
    ).toThrow("is not declared");
  });
});
