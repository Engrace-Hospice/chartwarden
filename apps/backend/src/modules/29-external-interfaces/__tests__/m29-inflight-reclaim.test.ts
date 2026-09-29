// apps/backend/src/modules/29-external-interfaces/__tests__ — F-179 (#248): the PURE `in_flight` lease-reclaim
// decision. A reclaim is a state transition (never a send): back to `queued` with the shared backoff, or
// terminal `dlq` once the shared attempt budget is spent, and it ALWAYS raises an operator alert.
import { describe, expect, it } from "vitest";
import { buildM29OutboundDispatchConsumer } from "../outbound/dispatch-worker";
import {
  IN_FLIGHT_RECLAIM_LABEL,
  OUTBOUND_BACKOFF_MS,
  OUTBOUND_IN_FLIGHT_LEASE_MS,
  OUTBOUND_MAX_ATTEMPTS,
  decideInFlightReclaim,
} from "../outbound/retry-policy";

const NOW = new Date("2026-09-29T12:00:00.000Z");
const outbound = (retryCount: number) => ({
  id: "out-1",
  feedId: "feed-1",
  organizationId: "org-1",
  sourceAggregateId: "order-1",
  retryCount,
});

describe("F-179 decideInFlightReclaim", () => {
  it("the default lease sits far above the worst-case attempt (10s connect + 30s ack wait)", () => {
    expect(OUTBOUND_IN_FLIGHT_LEASE_MS).toBeGreaterThanOrEqual(5 * (10_000 + 30_000));
  });

  it("requeues with the shared backoff, counts the reclaim as an attempt, and alerts (NORMAL, no PHI)", () => {
    const d = decideInFlightReclaim({ outbound: outbound(0), now: NOW });
    expect(d.kind).toBe("retry");
    expect(d.statusUpdate).toEqual({
      status: "queued",
      retryCount: 1,
      nextRetryAt: new Date(NOW.getTime() + OUTBOUND_BACKOFF_MS[0]),
    });
    expect(d.alert).toMatchObject({
      kind: "hl7_outbound.transmission_failed",
      severity: "NORMAL",
      channel: "operator-on-call",
      feedId: "feed-1",
    });
    expect(d.alert.detail).toContain("same message control id");
    expect(d.alert.detail).not.toMatch(/order-1|org-1/);
    // The audit intent is the dispatched shape decideRetry already defines — no new audit kind was invented.
    expect(d.audit.kind).toBe("hl7.outbound.dispatched");
  });

  it("walks the same backoff ladder as an ordinary failure", () => {
    for (let n = 0; n < OUTBOUND_MAX_ATTEMPTS - 1; n++) {
      const d = decideInFlightReclaim({ outbound: outbound(n), now: NOW });
      expect(d.kind).toBe("retry");
      expect(d.statusUpdate.nextRetryAt).toEqual(new Date(NOW.getTime() + OUTBOUND_BACKOFF_MS[n]!));
    }
  });

  it("once the shared budget is spent the row goes terminal DLQ, emits transmission_failed, and alerts HIGH — it never loops", () => {
    const d = decideInFlightReclaim({ outbound: outbound(OUTBOUND_MAX_ATTEMPTS - 1), now: NOW });
    expect(d.kind).toBe("dlq");
    if (d.kind !== "dlq") throw new Error("unreachable");
    expect(d.statusUpdate).toEqual({ status: "dlq", retryCount: OUTBOUND_MAX_ATTEMPTS, nextRetryAt: null });
    expect(d.event).toEqual({
      name: "m29.lab_order.transmission_failed",
      payload: {
        orderId: "order-1",
        organizationId: "org-1",
        feedId: "feed-1",
        outboundMessageId: "out-1",
        reason: "dlq_exhausted",
        detail: IN_FLIGHT_RECLAIM_LABEL,
        attemptCount: OUTBOUND_MAX_ATTEMPTS,
      },
    });
    expect(d.alert.severity).toBe("HIGH");
    expect(d.alert.detail).toMatch(/verify with the lab/);
  });
});

describe("F-179 inFlightLeaseMs configuration", () => {
  const base = { db: {} as never, outbox: {} as never, keys: {} as never };

  it("defaults when unset and accepts a positive number", () => {
    expect(() => buildM29OutboundDispatchConsumer(base)).not.toThrow();
    expect(() => buildM29OutboundDispatchConsumer({ ...base, inFlightLeaseMs: 120_000 })).not.toThrow();
  });

  it("refuses a zero, negative or non-finite lease (a zero lease would reclaim every live send)", () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => buildM29OutboundDispatchConsumer({ ...base, inFlightLeaseMs: bad })).toThrow(/positive/);
    }
  });
});
