// apps/backend/__tests__/m11-recovery-mitigations.test.ts — F-203 (#248): the PURE half of the mitigations for the
// two-person lab-recovery control's residual risks. The database half (superseding on the order's transitions, the
// bound under real counts, durable alert delivery) is `m11-orm-recovery.live.test.ts`.
import { describe, expect, it, vi } from "vitest";
import {
  RECOVERY_ESCALATION_THRESHOLD,
  RECOVERY_ORG_RATE_THRESHOLD,
  buildRecoveryAlert,
  buildRecoveryAnomalyAlert,
  decideRecoveryCosign,
  decideRecoveryEscalation,
  parseRecoveryBound,
  recoveryAlertEventPayload,
} from "../src/modules/11-orders/orm-request/orm-recovery-dual-control";
import {
  M11_RECOVERY_ALERT_CONSUMER,
  M11_RECOVERY_ALERT_TYPES,
  buildM11RecoveryAlertConsumer,
} from "../src/modules/11-orders/outbox-consumers/recovery-alert";

const NOW = new Date("2026-06-08T12:00:00.000Z");
const HOUR = 3_600_000;

describe("F-203 — decideRecoveryEscalation: the collusion bound", () => {
  it("below the bound nothing is required; AT the bound a high-trust co-signer is", () => {
    expect(decideRecoveryEscalation({ requesterExecuted: 0, pairExecuted: 0 })).toEqual({
      required: false,
    });
    expect(
      decideRecoveryEscalation({
        requesterExecuted: RECOVERY_ESCALATION_THRESHOLD - 1,
        pairExecuted: 0,
      }),
    ).toEqual({
      required: false,
    });
    expect(
      decideRecoveryEscalation({
        requesterExecuted: RECOVERY_ESCALATION_THRESHOLD,
        pairExecuted: 0,
      }),
    ).toEqual({
      required: true,
      reason: "requester_bound",
    });
  });

  it("a repeated PAIR trips it even when neither person's own count would (and names the pair)", () => {
    expect(decideRecoveryEscalation({ requesterExecuted: 1, pairExecuted: 3 })).toEqual({
      required: true,
      reason: "pair_bound",
    });
  });

  it("the threshold is injectable and the default is three", () => {
    expect(RECOVERY_ESCALATION_THRESHOLD).toBe(3);
    expect(decideRecoveryEscalation({ requesterExecuted: 1, pairExecuted: 0 }, 1).required).toBe(
      true,
    );
    expect(decideRecoveryEscalation({ requesterExecuted: 4, pairExecuted: 0 }, 5).required).toBe(
      false,
    );
  });
});

describe("F-203 — parseRecoveryBound: an invalid env value falls back, it never disables the bound", () => {
  it.each([
    [undefined, 3],
    ["", 3],
    ["   ", 3],
    ["abc", 3],
    ["-1", 3],
    ["1", 3], // below the minimum of 2 — a bound of 1 would make EVERY repeat escalate
    ["0", 3],
    ["2.5", 3],
    ["1e3", 3],
    ["100001", 3],
    ["2", 2],
    ["5", 5],
    [" 7 ", 7],
    ["100000", 100000],
  ])("%j → %d", (raw, expected) => {
    expect(parseRecoveryBound(raw as string | undefined, 3)).toBe(expected);
  });
});

describe("F-203 — decideRecoveryCosign names a SUPERSEDED request and its reason", () => {
  const base = { requestedByUserId: "u-req", expiresAt: new Date(NOW.getTime() + HOUR) };

  it("a superseded request is refused as `superseded`, carrying the fixed reason token", () => {
    const v = decideRecoveryCosign(
      { ...base, status: "superseded", supersededReason: "order_discontinued" },
      "u-other",
      NOW,
    );
    expect(v).toMatchObject({ ok: false, code: "superseded" });
    if (!v.ok) expect(v.message).toContain("order_discontinued");
  });

  it("superseded outranks self-cosign and expiry (a settled request reports THAT, never who is asking)", () => {
    const stale = {
      ...base,
      expiresAt: new Date(NOW.getTime() - HOUR),
      status: "superseded",
      supersededReason: "x_y",
    };
    expect(decideRecoveryCosign(stale, "u-req", NOW)).toMatchObject({
      ok: false,
      code: "superseded",
    });
  });

  it("a pending, unexpired request from someone else still passes", () => {
    expect(decideRecoveryCosign({ ...base, status: "pending_cosign" }, "u-other", NOW)).toEqual({
      ok: true,
    });
  });
});

describe("F-203 — buildRecoveryAnomalyAlert: critical, deduplicated per window, ids and counts only", () => {
  const facts = {
    orderId: "0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a",
    at: NOW,
    windowMs: 24 * HOUR,
    executionsInWindow: 3,
    threshold: 3,
  };

  it("is always critical and names the signal", () => {
    const a = buildRecoveryAnomalyAlert("repeat_pair", { ...facts, pairUserIds: ["b", "a"] });
    expect(a.severity).toBe("critical");
    expect(a.eventType).toBe("m11.order.recovery_anomaly");
    expect(a.payload).toMatchObject({
      signal: "repeat_pair",
      executionsInWindow: 3,
      threshold: 3,
      windowHours: 24,
    });
  });

  it("the pair's correlation id is SYMMETRIC (A/B and B/A are one pair) and identical within a window", () => {
    const ab = buildRecoveryAnomalyAlert("repeat_pair", { ...facts, pairUserIds: ["a", "b"] });
    const ba = buildRecoveryAnomalyAlert("repeat_pair", { ...facts, pairUserIds: ["b", "a"] });
    const later = buildRecoveryAnomalyAlert("repeat_pair", {
      ...facts,
      at: new Date(NOW.getTime() + HOUR),
      executionsInWindow: 9,
      pairUserIds: ["a", "b"],
    });
    expect(ab.correlationId).toBe(ba.correlationId);
    // the same wall-clock window ⇒ the same id ⇒ M36's unique (organization_id, correlation_id) absorbs the repeat
    expect(later.correlationId).toBe(ab.correlationId);
  });

  it("a NEW window, another pair and the org-rate signal each get their own correlation id", () => {
    const ab = buildRecoveryAnomalyAlert("repeat_pair", { ...facts, pairUserIds: ["a", "b"] });
    const nextDay = buildRecoveryAnomalyAlert("repeat_pair", {
      ...facts,
      at: new Date(NOW.getTime() + 25 * HOUR),
      pairUserIds: ["a", "b"],
    });
    const other = buildRecoveryAnomalyAlert("repeat_pair", { ...facts, pairUserIds: ["a", "c"] });
    const rate = buildRecoveryAnomalyAlert("org_rate", {
      ...facts,
      threshold: RECOVERY_ORG_RATE_THRESHOLD,
    });
    expect(new Set([ab, nextDay, other, rate].map((x) => x.correlationId)).size).toBe(4);
  });

  it("carries no field that could hold a name, a lab reference or a patient", () => {
    const a = buildRecoveryAnomalyAlert("repeat_pair", { ...facts, pairUserIds: ["a", "b"] });
    expect(Object.keys(a.payload).sort()).toEqual(
      [
        "deepLink",
        "executionsInWindow",
        "orderId",
        "pairUserIds",
        "signal",
        "threshold",
        "windowHours",
      ].sort(),
    );
    expect(JSON.stringify(a)).not.toMatch(/contact|labReference|patient|Reyes|REF-/i);
  });
});

describe("F-203 — the executed alert turns critical for a repeated PAIR and says when the bound forced a high-trust co-signer", () => {
  const facts = {
    orderId: "0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a",
    requestId: "1b1b1b1b-1b1b-4b1b-8b1b-1b1b1b1b1b1b",
    requestedByMembershipId: "m-req",
    cosignedByMembershipId: "m-co",
  };

  it("a lone execution warns; a repeated pair is critical and flagged; the escalation flag is carried", () => {
    const calm = buildRecoveryAlert("m11.order.recovery_executed", {
      ...facts,
      requesterCountInWindow: 1,
      pairExecutionsInWindow: 1,
    });
    expect(calm.severity).toBe("warn");
    expect(calm.payload).toMatchObject({ repeatPair: false, escalatedCosign: false });

    const pair = buildRecoveryAlert("m11.order.recovery_executed", {
      ...facts,
      requesterCountInWindow: 1,
      pairExecutionsInWindow: 3,
      escalatedCosign: true,
    });
    expect(pair.severity).toBe("critical");
    expect(pair.payload).toMatchObject({
      repeatPair: true,
      repeatAttester: false,
      escalatedCosign: true,
    });
  });
});

describe("F-203 — buildM11RecoveryAlertConsumer: durable delivery of the alert intent", () => {
  const alert = buildRecoveryAlert("m11.order.recovery_executed", {
    orderId: "0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a",
    requestId: "1b1b1b1b-1b1b-4b1b-8b1b-1b1b1b1b1b1b",
    requestedByMembershipId: "m-req",
    cosignedByMembershipId: "m-co",
    requesterCountInWindow: 1,
  });
  const event = (payload: unknown) => ({
    eventType: "m11.order.recovery_alert_requested",
    organizationId: "org-a",
    payload,
  });

  it("forwards the intent to the emitter verbatim, for the event's own organization", async () => {
    const emit = vi.fn(async () => ({}));
    const consumer = buildM11RecoveryAlertConsumer({ alerts: { emit } });
    await consumer.handle(event(recoveryAlertEventPayload(alert)));
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith("org-a", {
      eventType: alert.eventType,
      payload: alert.payload,
      severity: alert.severity,
      correlationId: alert.correlationId,
    });
  });

  it("an emitter failure THROWS, so the relay retries — the F-202 swallow is gone", async () => {
    const emit = vi.fn(async () => {
      throw new Error("emitter down");
    });
    const consumer = buildM11RecoveryAlertConsumer({ alerts: { emit } });
    await expect(consumer.handle(event(recoveryAlertEventPayload(alert)))).rejects.toThrow(
      "emitter down",
    );
  });

  it("a redelivery after a failure re-sends the SAME correlation id (so M36 dedupes it), never a new one", async () => {
    const ids: string[] = [];
    let calls = 0;
    const emit = vi.fn(async (_org: string, input: { correlationId: string }) => {
      ids.push(input.correlationId);
      if (++calls === 1) throw new Error("transient");
      return {};
    });
    const consumer = buildM11RecoveryAlertConsumer({ alerts: { emit } });
    await expect(consumer.handle(event(recoveryAlertEventPayload(alert)))).rejects.toThrow(
      "transient",
    );
    await consumer.handle(event(recoveryAlertEventPayload(alert)));
    expect(ids).toEqual([alert.correlationId, alert.correlationId]);
  });

  it.each([
    [
      "an unknown alert type",
      { ...recoveryAlertEventPayload(alert), alertType: "m11.order.something_else" },
    ],
    ["no correlation id", { ...recoveryAlertEventPayload(alert), correlationId: "" }],
    ["no payload object", { ...recoveryAlertEventPayload(alert), alertPayload: null }],
    ["no payload at all", undefined],
  ])("%s is a poison event (throws a named error, emits nothing)", async (_name, payload) => {
    const emit = vi.fn(async () => ({}));
    const consumer = buildM11RecoveryAlertConsumer({ alerts: { emit } });
    await expect(consumer.handle(event(payload))).rejects.toThrow(/m11\.recovery-alert/);
    expect(emit).not.toHaveBeenCalled();
  });

  it("subscribes to exactly the one event, under its registered name, and delivers every alert kind the service builds", () => {
    const consumer = buildM11RecoveryAlertConsumer({ alerts: { emit: async () => ({}) } });
    expect(consumer.eventTypes).toEqual(["m11.order.recovery_alert_requested"]);
    expect(consumer.consumerName).toBe(M11_RECOVERY_ALERT_CONSUMER.consumerName);
    expect(consumer.consumerModule).toBe("m11");
    for (const kind of [
      "m11.order.recovery_executed",
      "m11.order.recovery_cancelled",
      "m11.order.recovery_expired",
      "m11.order.recovery_anomaly",
    ]) {
      expect(M11_RECOVERY_ALERT_TYPES).toContain(kind);
    }
  });
});
