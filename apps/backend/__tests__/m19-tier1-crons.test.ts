import type { AlertEmitter } from "@chartwarden/messaging";
import { describe, expect, it, vi } from "vitest";
import type { DispatchableOutboxEvent } from "../src/bootstrap/outbox-dispatcher";
import {
  M19_JOB_SCHEDULES,
  M19_OUTBOX_EVENTS,
  M19_QUEUES,
  M19_QUEUE_PARAMS,
} from "../src/modules/19-oncall/index";
import { firstRnCoverageGap } from "../src/modules/19-oncall/roster/coverage-gap";
import {
  M19_COVERAGE_GAP_ALERT_TYPE,
  buildM36OncallAlertConsumer,
} from "../src/modules/36-messaging/outbox-consumers/oncall-alerts";

type Iso = Parameters<typeof firstRnCoverageGap>[1];
const t = (h: number, m = 0): Iso =>
  new Date(Date.UTC(2026, 9, 5, h, m)).toISOString() as unknown as Iso;
const w = (a: Iso, b: Iso) => ({ shiftStartsAt: a, shiftEndsAt: b });

describe("firstRnCoverageGap (§4.8 coverage-gap watchdog predicate)", () => {
  it("returns the whole lookahead when there are no shifts", () => {
    expect(firstRnCoverageGap([], t(0), t(24))).toEqual({ gapStartsAt: t(0), gapEndsAt: t(24) });
  });

  it("returns null when one shift covers the whole lookahead", () => {
    expect(firstRnCoverageGap([w(t(0), t(23, 59))], t(1), t(23))).toBeNull();
  });

  it("returns null for back-to-back shifts that touch (zero-length sliver is not a gap)", () => {
    expect(firstRnCoverageGap([w(t(0), t(12)), w(t(12), t(24))], t(0), t(24))).toBeNull();
  });

  it("reports the earliest hole between shifts, bounded by the next shift start", () => {
    expect(firstRnCoverageGap([w(t(0), t(8)), w(t(10), t(24))], t(0), t(24))).toEqual({
      gapStartsAt: t(8),
      gapEndsAt: t(10),
    });
  });

  it("reports a gap that starts now when the first shift starts later", () => {
    expect(firstRnCoverageGap([w(t(6), t(24))], t(2), t(24))).toEqual({
      gapStartsAt: t(2),
      gapEndsAt: t(6),
    });
  });

  it("reports the tail gap when coverage ends before the lookahead does", () => {
    expect(firstRnCoverageGap([w(t(0), t(12))], t(0), t(24))).toEqual({
      gapStartsAt: t(12),
      gapEndsAt: t(24),
    });
  });

  it("is order-independent and handles overlapping shifts", () => {
    expect(
      firstRnCoverageGap([w(t(10), t(24)), w(t(0), t(11)), w(t(4), t(9))], t(0), t(24)),
    ).toBeNull();
  });

  it("clips a gap's end to the lookahead when the next shift starts beyond it", () => {
    expect(firstRnCoverageGap([w(t(30), t(40))], t(0), t(24))).toEqual({
      gapStartsAt: t(0),
      gapEndsAt: t(24),
    });
  });
});

describe("§4.8 Tier-1 queue catalog", () => {
  it("declares the three Tier-1 queues with the spec's parameters and no ':' in any name", () => {
    expect(M19_QUEUES.shiftOpen).toBe("oncall.shift-open.cron");
    expect(M19_QUEUES.shiftClose).toBe("oncall.shift-close.cron");
    expect(M19_QUEUES.coverageGapWatchdog).toBe("oncall.coverage-gap-watchdog.cron");
    for (const q of Object.values(M19_QUEUES)) expect(q).not.toContain(":");
    expect(M19_JOB_SCHEDULES.shiftOpenEveryMs).toBe(5 * 60_000);
    expect(M19_JOB_SCHEDULES.shiftCloseEveryMs).toBe(5 * 60_000);
    expect(M19_JOB_SCHEDULES.coverageGapWatchdogEveryMs).toBe(30 * 60_000);
    for (const p of [
      M19_QUEUE_PARAMS.shiftOpen,
      M19_QUEUE_PARAMS.shiftClose,
      M19_QUEUE_PARAMS.coverageGapWatchdog,
    ]) {
      expect(p.priority).toBe(1);
      expect(p.attempts).toBe(3);
      expect(p.concurrency).toBe(1);
    }
  });

  it("the catalog names M36 as the declared consumer of the coverage-gap event", () => {
    const entry = M19_OUTBOX_EVENTS.find((e) => e.eventName === "m19.oncall_shift.coverage_gap");
    expect(entry?.declaredConsumers).toContain("m36");
  });
});

describe("M36 oncall-alerts consumer (m19.oncall_shift.coverage_gap)", () => {
  const ENVELOPE_ORG = "11111111-1111-4111-8111-111111111111";
  const PAYLOAD_ORG = "99999999-9999-4999-8999-999999999999";
  const PE = "22222222-2222-4222-8222-222222222222";
  const gap = {
    organizationId: PAYLOAD_ORG,
    providerEntityId: PE,
    gapStartsAt: "2026-10-05T02:00:00.000Z",
    gapEndsAt: "2026-10-05T10:00:00.000Z",
    discipline: "clinical_rn",
  };
  const event = (payload: unknown, createdAt = "2026-10-05T02:10:00.000Z") =>
    ({
      id: "55555555-5555-4555-8555-555555555555",
      organizationId: ENVELOPE_ORG,
      eventType: "m19.oncall_shift.coverage_gap",
      aggregateKind: "on_call_shift",
      aggregateId: PE,
      payload,
      attemptCount: 0,
      createdAt: new Date(createdAt),
    }) satisfies DispatchableOutboxEvent;
  const harness = () => {
    const emit = vi.fn(async () => ({}) as never);
    return { emit, consumer: buildM36OncallAlertConsumer({ emit } as unknown as AlertEmitter) };
  };

  it("raises one critical alert under the ENVELOPE org, never the payload org", async () => {
    const { emit, consumer } = harness();
    await consumer.handle(event(gap));
    expect(emit).toHaveBeenCalledTimes(1);
    const [org, input] = emit.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(org).toBe(ENVELOPE_ORG);
    expect(input).toMatchObject({
      eventType: M19_COVERAGE_GAP_ALERT_TYPE,
      severity: "critical",
      correlationId: `outbox:${M19_COVERAGE_GAP_ALERT_TYPE}:${PE}:2026-10-05T02`,
    });
  });

  it("keys the page on ProviderEntity + hour so a 30-min re-detect collapses and a new hour re-pages", async () => {
    const { emit, consumer } = harness();
    await consumer.handle(event(gap, "2026-10-05T02:10:00.000Z"));
    await consumer.handle(event(gap, "2026-10-05T02:40:00.000Z"));
    await consumer.handle(event(gap, "2026-10-05T03:10:00.000Z"));
    const ids = emit.mock.calls.map(
      (c) => (c as unknown as [string, { correlationId: string }])[1].correlationId,
    );
    expect(ids[0]).toBe(ids[1]);
    expect(ids[2]).not.toBe(ids[0]);
  });

  it("throws on a malformed payload (relay retry -> DLQ), never a silently dropped page", async () => {
    const { emit, consumer } = harness();
    await expect(consumer.handle(event({ ...gap, providerEntityId: undefined }))).rejects.toThrow(
      /providerEntityId/,
    );
    expect(emit).not.toHaveBeenCalled();
  });
});
