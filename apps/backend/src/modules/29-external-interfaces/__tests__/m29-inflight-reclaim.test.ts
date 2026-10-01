// apps/backend/src/modules/29-external-interfaces/__tests__ — F-182/F-183 (#248): the PURE `in_flight` lease-reclaim
// decision. Whether the lab already got the message is unknown, so a reclaim is a state transition (never a send)
// and what it does depends on the feed's operator-declared `receiver_dedupes_control_id` (F-183):
//   true  → back to `queued` with the shared backoff (same wire, same MSH-10), or terminal `dlq` once the shared
//           attempt budget is spent;
//   false → HELD: terminal `dlq` immediately (never an automatic re-send), for human verification with the lab.
// Either way it ALWAYS raises an operator alert.
import { describe, expect, it } from "vitest";
import { buildM29OutboundDispatchConsumer } from "../outbound/dispatch-worker";
import {
  IN_FLIGHT_HELD_LABEL,
  IN_FLIGHT_LEASE_MAX_SECONDS,
  IN_FLIGHT_LEASE_MIN_SECONDS,
  IN_FLIGHT_RECLAIM_LABEL,
  OUTBOUND_BACKOFF_MS,
  OUTBOUND_IN_FLIGHT_LEASE_MS,
  OUTBOUND_MAX_ATTEMPTS,
  decideInFlightReclaim,
  inFlightLeaseMsFor,
} from "../outbound/retry-policy";

const NOW = new Date("2026-09-29T12:00:00.000Z");
const outbound = (retryCount: number) => ({
  id: "out-1",
  feedId: "feed-1",
  organizationId: "org-1",
  sourceAggregateId: "order-1",
  retryCount,
});

describe("F-182 decideInFlightReclaim — receiver dedupes MSH-10 (requeue)", () => {
  const dedupes = { receiverDedupesControlId: true } as const;

  it("the default lease sits far above the worst-case attempt (10s connect + 30s ack wait)", () => {
    expect(OUTBOUND_IN_FLIGHT_LEASE_MS).toBeGreaterThanOrEqual(5 * (10_000 + 30_000));
  });

  it("requeues with the shared backoff, counts the reclaim as an attempt, and alerts (NORMAL, no PHI)", () => {
    const d = decideInFlightReclaim({ outbound: outbound(0), now: NOW, ...dedupes });
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
    // F-183 — a reclaim requeue has its OWN audit kind; it is no longer disguised as an ordinary dispatch.
    expect(d.audit.kind).toBe("hl7.outbound.reclaimed");
  });

  it("walks the same backoff ladder as an ordinary failure", () => {
    for (let n = 0; n < OUTBOUND_MAX_ATTEMPTS - 1; n++) {
      const d = decideInFlightReclaim({ outbound: outbound(n), now: NOW, ...dedupes });
      expect(d.kind).toBe("retry");
      expect(d.statusUpdate.nextRetryAt).toEqual(new Date(NOW.getTime() + OUTBOUND_BACKOFF_MS[n]!));
    }
  });

  it("once the shared budget is spent the row goes terminal DLQ, emits transmission_failed, and alerts HIGH — it never loops", () => {
    const d = decideInFlightReclaim({
      outbound: outbound(OUTBOUND_MAX_ATTEMPTS - 1),
      now: NOW,
      ...dedupes,
    });
    expect(d.kind).toBe("dlq");
    if (d.kind !== "dlq") throw new Error("unreachable");
    expect(d.statusUpdate).toEqual({
      status: "dlq",
      retryCount: OUTBOUND_MAX_ATTEMPTS,
      nextRetryAt: null,
    });
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

describe("F-183 decideInFlightReclaim — receiver NOT marked as deduping (HELD)", () => {
  const held = { receiverDedupesControlId: false } as const;

  it("HOLDS on the very first lost attempt: terminal dlq, no next_retry_at, never re-queued", () => {
    const d = decideInFlightReclaim({ outbound: outbound(0), now: NOW, ...held });
    expect(d.kind).toBe("dlq");
    if (d.kind !== "dlq") throw new Error("unreachable");
    expect(d.statusUpdate).toEqual({ status: "dlq", retryCount: 1, nextRetryAt: null });
  });

  it("emits the catalogued transmission_failed (dlq_exhausted) with the held label and the TRUE attempt count", () => {
    const d = decideInFlightReclaim({ outbound: outbound(2), now: NOW, ...held });
    if (d.kind !== "dlq") throw new Error("unreachable");
    expect(d.event).toEqual({
      name: "m29.lab_order.transmission_failed",
      payload: {
        orderId: "order-1",
        organizationId: "org-1",
        feedId: "feed-1",
        outboundMessageId: "out-1",
        reason: "dlq_exhausted",
        detail: IN_FLIGHT_HELD_LABEL,
        attemptCount: 3,
      },
    });
  });

  it("alerts HIGH to a human, says it was NOT re-sent, and carries no ids or PHI in the text", () => {
    const d = decideInFlightReclaim({ outbound: outbound(0), now: NOW, ...held });
    if (d.kind !== "dlq") throw new Error("unreachable");
    expect(d.alert).toMatchObject({
      severity: "HIGH",
      channel: "operator-on-call",
      feedId: "feed-1",
    });
    expect(d.alert.detail).toMatch(/NOT re-sent/);
    expect(d.alert.detail).toMatch(/verify with the lab/);
    expect(d.alert.detail).not.toMatch(/order-1|org-1|out-1/);
  });

  it("records the dedicated `hl7.outbound.held` audit kind", () => {
    const d = decideInFlightReclaim({ outbound: outbound(0), now: NOW, ...held });
    if (d.kind !== "dlq") throw new Error("unreachable");
    expect(d.audit).toMatchObject({
      kind: "hl7.outbound.held",
      feedId: "feed-1",
      orderRecordId: "order-1",
      outboundMessageId: "out-1",
    });
  });

  it("holds at every retry count — the flag, not the budget, decides", () => {
    for (let n = 0; n < OUTBOUND_MAX_ATTEMPTS; n++) {
      expect(decideInFlightReclaim({ outbound: outbound(n), now: NOW, ...held }).kind).toBe("dlq");
    }
  });
});

describe("F-183 inFlightLeaseMsFor — the per-feed lease", () => {
  it("uses the feed's own seconds, else the injected platform default", () => {
    expect(inFlightLeaseMsFor(120, 300_000)).toBe(120_000);
    expect(inFlightLeaseMsFor(null, 300_000)).toBe(300_000);
    expect(inFlightLeaseMsFor(undefined, 300_000)).toBe(300_000);
  });

  it("the CHECK bounds sit above the worst-case send and below an operator shift", () => {
    expect(IN_FLIGHT_LEASE_MIN_SECONDS * 1000).toBeGreaterThan(10_000 + 30_000);
    expect(IN_FLIGHT_LEASE_MAX_SECONDS).toBeLessThanOrEqual(3600);
  });
});

describe("F-182 inFlightLeaseMs configuration", () => {
  const base = { db: {} as never, outbox: {} as never, keys: {} as never };

  it("defaults when unset and accepts a positive number", () => {
    expect(() => buildM29OutboundDispatchConsumer(base)).not.toThrow();
    expect(() =>
      buildM29OutboundDispatchConsumer({ ...base, inFlightLeaseMs: 120_000 }),
    ).not.toThrow();
  });

  it("refuses a zero, negative or non-finite lease (a zero lease would reclaim every live send)", () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => buildM29OutboundDispatchConsumer({ ...base, inFlightLeaseMs: bad })).toThrow(
        /positive/,
      );
    }
  });
});
