// Owner decision (round 2, Q4): a NOE / NOTR the tenant filed outside ChartWarden and recorded AFTER the due date is announced by a
// catalogued event; M23's own consumer raises the M36 alert to the tenant and a platform-ops notice. Ids and dates only.
import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";
import { buildOutboxRoutingPlan } from "../../../bootstrap/outbox-dispatcher";
import type {
  DispatchableOutboxEvent,
  OutboxConsumerBinding,
} from "../../../bootstrap/outbox-dispatcher";
import { buildBootOutboxCatalog } from "../../../bootstrap/outbox-persister";
import { M23_OUTBOX_EVENTS } from "../events-by-m23";
import {
  M23_NOTICE_FILED_LATE_EVENTS,
  buildM23NoticeFiledLateConsumer,
} from "./notice-filed-externally-late";

const ORG = "11111111-1111-4111-8111-111111111111";
const event = (eventType: string, payload: unknown): DispatchableOutboxEvent => ({
  id: "evt-1",
  organizationId: ORG,
  eventType,
  aggregateKind: "noe_record",
  aggregateId: "notice-1",
  payload,
  attemptCount: 0,
  createdAt: new Date("2026-11-10T15:00:00Z"),
});
const NOE = {
  noeId: "notice-1",
  admissionId: "adm-1",
  filedOn: "2026-11-08",
  windowTargetAt: "2026-11-06",
};
const NOTR = {
  notrId: "notice-2",
  admissionId: "adm-1",
  filedOn: "2026-11-08",
  windowTargetAt: "2026-11-06",
};

function setup() {
  const alerts: {
    alertCode: string;
    severity: string;
    organizationId: string;
    payload: Record<string, unknown>;
  }[] = [];
  const notices: {
    kind: string;
    summary: string;
    details: Record<string, unknown>;
    correlationId: string;
  }[] = [];
  const consumer = buildM23NoticeFiledLateConsumer({
    alerts: { dispatch: async (a) => void alerts.push(a) },
    opsNotice: (n) => void notices.push(n),
  });
  return { consumer, alerts, notices };
}

describe("the late external filing consumer", () => {
  it("raises a critical M36 alert to the tenant carrying ids and dates only, and an ops notice", async () => {
    const { consumer, alerts, notices } = setup();
    await consumer.handle(event("m23.noe.filed_externally_late", NOE));
    await consumer.handle(event("m23.notr.filed_externally_late", NOTR));
    expect(alerts).toEqual([
      {
        alertCode: "m23.noe.filed_externally_late",
        severity: "critical",
        organizationId: ORG,
        payload: NOE,
      },
      {
        alertCode: "m23.notr.filed_externally_late",
        severity: "critical",
        organizationId: ORG,
        payload: NOTR,
      },
    ]);
    expect(notices).toHaveLength(2);
    expect(notices[0]).toMatchObject({
      kind: "m23.notice_filed_late",
      correlationId: "evt-1",
      details: {
        organizationId: ORG,
        noticeKind: "noe",
        noticeId: "notice-1",
        filedOn: "2026-11-08",
        windowTargetAt: "2026-11-06",
      },
    });
    // ids and dates: no name, no free text, no patient
    expect(JSON.stringify([alerts, notices])).not.toMatch(/patient|name|mbi/i);
  });

  it("fails the delivery (so the relay retries) on a malformed payload or a failed alert", async () => {
    const { consumer } = setup();
    await expect(
      consumer.handle(event("m23.noe.filed_externally_late", { noeId: "n" })),
    ).rejects.toThrow();
    await expect(consumer.handle(event("m23.noe.filed_externally_late", "nope"))).rejects.toThrow();
    const failing = buildM23NoticeFiledLateConsumer({
      alerts: {
        dispatch: async () => {
          throw new Error("alert router down");
        },
      },
    });
    await expect(failing.handle(event("m23.noe.filed_externally_late", NOE))).rejects.toThrow(
      /alert router down/,
    );
  });

  it("works without an ops sink bound (the tenant still hears)", async () => {
    const alerts: unknown[] = [];
    const consumer = buildM23NoticeFiledLateConsumer({
      alerts: { dispatch: async (a) => void alerts.push(a) },
    });
    await consumer.handle(event("m23.noe.filed_externally_late", NOE));
    expect(alerts).toHaveLength(1);
  });
});

describe("the late external filing events are catalogued and bound", () => {
  const catalog = buildBootOutboxCatalog([M23_OUTBOX_EVENTS]);
  const consumer = buildM23NoticeFiledLateConsumer({
    alerts: { dispatch: async () => undefined },
  }) as unknown as OutboxConsumerBinding;

  it("both events are in the boot catalog, declare m23 as their consumer, and their payload schema accepts the real payload", () => {
    for (const [name, payload] of [
      ["m23.noe.filed_externally_late", NOE],
      ["m23.notr.filed_externally_late", NOTR],
    ] as const) {
      const entry = catalog.get(name);
      expect(entry?.declaredConsumers, name).toContain("m23");
      expect(Value.Check(entry?.payloadSchema as never, payload), name).toBe(true);
      // dates are dates: a timestamp or free text is refused
      expect(
        Value.Check(entry?.payloadSchema as never, { ...payload, filedOn: "yesterday evening" }),
      ).toBe(false);
    }
  });

  it("builds a routing plan from the real binding without throwing, and routes both events live", () => {
    expect([...M23_NOTICE_FILED_LATE_EVENTS]).toEqual(consumer.eventTypes);
    const plan = buildOutboxRoutingPlan(catalog, [consumer]);
    for (const name of M23_NOTICE_FILED_LATE_EVENTS) {
      expect(plan.live.get(name)).toContain(consumer);
    }
  });
});
