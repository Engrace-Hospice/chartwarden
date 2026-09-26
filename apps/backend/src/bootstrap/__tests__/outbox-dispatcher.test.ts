// TASK-006 — pure decision surface of the outbox dispatcher. The relay's DB behavior (claim /
// finalize / DLQ / purge under RLS) is exercised by the live-cluster suite (TASK-007 adds the CI
// row); what is unit-testable without a database is the backoff math the retry clock runs on.
import { Type } from "@sinclair/typebox";
import type { OutboxEventEntry } from "@wardenx/types";
import { describe, expect, it } from "vitest";
import {
  type OutboxConsumerBinding,
  type PlatformDispatchableOutboxEvent,
  type PlatformOutboxConsumerBinding,
  buildOutboxRoutingPlan,
  createOutboxDispatcher,
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

const platformBinding = (
  consumerModule: PlatformOutboxConsumerBinding["consumerModule"],
  eventType: string,
): PlatformOutboxConsumerBinding => ({
  consumerName: `${consumerModule}.platform-consumer`,
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

  // ── GAP-099: platform bindings ────────────────────────────────────────────────────────────────────
  it("collects a platform binding separately from the org list", () => {
    const event = entry("m1.test.changed", ["m40"]);
    const plan = buildOutboxRoutingPlan(
      new Map([[event.eventName, event]]),
      [],
      [platformBinding("m40", event.eventName)],
    );

    expect(plan.livePlatform.get(event.eventName)).toHaveLength(1);
    // The two lists never mix: `pollOrg` must not hand an org row to a consumer that expects no org.
    expect(plan.live.has(event.eventName)).toBe(false);
  });

  it("scores deferral across BOTH lists — a module bound platform-side counts as live", () => {
    // The point of scoring together: "is m40 wired?" is a question about the module, not about which
    // scope it listens on. Scoring per-list would leave this event deferred forever with m40 fully live.
    const event = entry("m1.test.changed", ["m5", "m40"]);
    const plan = buildOutboxRoutingPlan(
      new Map([[event.eventName, event]]),
      [binding("m5", event.eventName)],
      [platformBinding("m40", event.eventName)],
    );
    expect(plan.deferred.has(event.eventName)).toBe(false);
  });

  it("fails boot when a consumer name repeats across the org and platform lists", () => {
    // The `(event_id, consumer_name)` receipt identity is shared between the two paths, so a duplicated
    // name would let one binding's receipt suppress the other's delivery.
    const event = entry("m1.test.changed", ["m5"]);
    const clash: PlatformOutboxConsumerBinding = {
      consumerName: "m5.test-consumer",
      consumerModule: "m5",
      eventTypes: [event.eventName],
      async handle() {},
    };
    expect(() =>
      buildOutboxRoutingPlan(
        new Map([[event.eventName, event]]),
        [binding("m5", event.eventName)],
        [clash],
      ),
    ).toThrow("bound more than once");
  });

  it("fails boot for a platform binding on a record-only event", () => {
    const event = entry("m1.audit.recorded", []);
    expect(() =>
      buildOutboxRoutingPlan(
        new Map([[event.eventName, event]]),
        [],
        [platformBinding("m40", event.eventName)],
      ),
    ).toThrow("catalogued record-only");
  });
});

// GAP-099 — pollPlatform's delivery path over a fake `db.execute`. This is the seam that did not exist:
// before it, a claimed platform row could only be put back down as deferred, so `m29.nppes.provider_synced`
// accumulated pending forever. The live suite proves the SQL; this proves the control flow.
describe("createOutboxDispatcher — platform delivery (GAP-099)", () => {
  const PLATFORM_EVENT = entry("m1.platform.changed", ["m40"]);

  /**
   * Minimal fake of the two calls pollPlatform makes into Postgres: the `report_writer_*` functions
   * (matched by name in the compiled SQL) and nothing else. Records every call so a test can assert which
   * terminal shape the row reached.
   */
  function fakeDb(claimRows: readonly Record<string, unknown>[]) {
    const calls: string[] = [];
    let claimed = false;
    const receipts = new Set<string>();
    const db = {
      async execute(query: unknown) {
        const text = JSON.stringify(query);
        const fn = /report_writer_[a-z_]+|audit_writer_[a-z_]+/.exec(text)?.[0] ?? "unknown";
        calls.push(fn);
        if (fn === "report_writer_claim_platform_outbox") {
          if (claimed) return { rows: [] };
          claimed = true;
          return { rows: claimRows };
        }
        if (fn === "report_writer_platform_receipt_exists") {
          return { rows: [{ completed: receipts.has("seen") }] };
        }
        if (fn === "report_writer_insert_platform_receipt") {
          receipts.add("seen");
          return { rows: [] };
        }
        return { rows: [] };
      },
      async transaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
        return fn(db);
      },
    };
    return { db, calls };
  }

  const claimRow = (overrides: Record<string, unknown> = {}) => ({
    id: "11111111-1111-4111-8111-111111111111",
    event_type: PLATFORM_EVENT.eventName,
    aggregate_kind: "thing",
    aggregate_id: "22222222-2222-4222-8222-222222222222",
    payload: { hello: "world" },
    attempt_count: 1,
    created_at: new Date("2026-08-14T00:00:00Z"),
    ...overrides,
  });

  function dispatcher(
    db: unknown,
    platformConsumers: readonly PlatformOutboxConsumerBinding[],
    options: Record<string, unknown> = {},
  ) {
    return createOutboxDispatcher({
      db: db as never,
      orgs: { listActiveOrgs: async () => [] },
      consumers: [],
      platformConsumers,
      eventCatalog: new Map([[PLATFORM_EVENT.eventName, PLATFORM_EVENT]]),
      options: { log: () => {}, ...options } as never,
    });
  }

  it("delivers a claimed platform row to its binding and finalizes it dispatched", async () => {
    const { db, calls } = fakeDb([claimRow()]);
    const seen: PlatformDispatchableOutboxEvent[] = [];
    const summary = await dispatcher(db, [
      {
        consumerName: "m40.applier",
        consumerModule: "m40",
        eventTypes: [PLATFORM_EVENT.eventName],
        async handle(event) {
          seen.push(event);
        },
      },
    ]).tick();

    expect(summary.delivered).toBe(1);
    expect(summary.deferred).toBe(0);
    expect(seen).toHaveLength(1);
    // The org-less shape is the contract — a platform consumer has no tenant to act for.
    expect(seen[0]).not.toHaveProperty("organizationId");
    expect(seen[0]?.payload).toEqual({ hello: "world" });
    expect(calls).toContain("report_writer_insert_platform_receipt");
    expect(calls).toContain("report_writer_finalize_platform_outbox_dispatched");
  });

  it("retries a throwing binding on the backoff clock instead of dropping the row", async () => {
    const { db, calls } = fakeDb([claimRow()]);
    const summary = await dispatcher(db, [
      {
        consumerName: "m40.applier",
        consumerModule: "m40",
        eventTypes: [PLATFORM_EVENT.eventName],
        async handle() {
          throw new Error("canonical write lost a race");
        },
      },
    ]).tick();

    expect(summary.retried).toBe(1);
    expect(calls).toContain("report_writer_finalize_platform_outbox_retry");
    // No receipt: an attempt that threw must be replayable.
    expect(calls).not.toContain("report_writer_insert_platform_receipt");
  });

  it("dead-letters at maxAttempts and reports a NULL org to the DLQ sink", async () => {
    const { db, calls } = fakeDb([claimRow({ attempt_count: 8 })]);
    const deadLettered: Array<{ organizationId: string | null }> = [];
    const summary = await dispatcher(
      db,
      [
        {
          consumerName: "m40.applier",
          consumerModule: "m40",
          eventTypes: [PLATFORM_EVENT.eventName],
          async handle() {
            throw new Error("permanently broken");
          },
        },
      ],
      {
        maxAttempts: 8,
        onDeadLetter: (e: { organizationId: string | null }) => deadLettered.push(e),
      },
    ).tick();

    expect(summary.deadLettered).toBe(1);
    expect(calls).toContain("report_writer_finalize_platform_outbox_dead_letter");
    // Not a made-up sentinel uuid: a fake org id in a DLQ alert is worse than none.
    expect(deadLettered[0]?.organizationId).toBeNull();
  });

  it("still defers when a declared consumer module is not bound at all", async () => {
    const twoConsumers = entry("m1.platform.changed", ["m40", "m36"]);
    const { db, calls } = fakeDb([claimRow()]);
    const summary = await createOutboxDispatcher({
      db: db as never,
      orgs: { listActiveOrgs: async () => [] },
      consumers: [],
      platformConsumers: [
        {
          consumerName: "m40.applier",
          consumerModule: "m40",
          eventTypes: [twoConsumers.eventName],
          async handle() {},
        },
      ],
      eventCatalog: new Map([[twoConsumers.eventName, twoConsumers]]),
      options: { log: () => {} },
    }).tick();

    // The bound binding still ran and left its receipt — that is what makes a staged rollout restart-safe.
    expect(calls).toContain("report_writer_insert_platform_receipt");
    expect(summary.deferred).toBe(1);
    expect(summary.delivered).toBe(0);
  });
});
