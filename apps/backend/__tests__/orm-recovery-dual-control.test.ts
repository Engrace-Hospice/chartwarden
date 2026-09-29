// F-194 (#248) — the PURE half of the two-person control on the attested lab-transmission recovery: who may co-sign,
// what counts as a repeat attester, and what the compliance alert says (and, as importantly, does not say). The live
// half (the requests table, the ledger CHECKs, the single-dispatch guards, destruction) is `m11-orm-recovery.live.test.ts`.
import { PLATFORM_DEFAULT_ALERT_RULES } from "@wardenx/messaging";
import { describe, expect, it } from "vitest";
import {
  RECOVERY_ALERT_KINDS,
  RECOVERY_ANOMALY_THRESHOLD,
  RECOVERY_ANOMALY_WINDOW_MS,
  RECOVERY_REQUEST_TTL_MS,
  buildRecoveryAlert,
  decideRecoveryCosign,
  isRepeatAttester,
} from "../src/modules/11-orders/orm-request/orm-recovery-dual-control";

const NOW = new Date("2026-06-01T12:00:00Z");
const LATER = new Date(NOW.getTime() + 60_000);
const EARLIER = new Date(NOW.getTime() - 60_000);
const REQUESTER = "33333333-3333-3333-3333-333333333333";
const OTHER = "44444444-4444-4444-4444-444444444444";
const pending = (over: Partial<{ status: string; requestedByUserId: string; expiresAt: Date }> = {}) => ({
  status: "pending_cosign",
  requestedByUserId: REQUESTER,
  expiresAt: LATER,
  ...over,
});

describe("F-194 — the documented defaults", () => {
  it("a request waits 24 h, and the repeat-attester window is 24 h with a threshold of 3", () => {
    expect(RECOVERY_REQUEST_TTL_MS).toBe(24 * 3_600_000);
    expect(RECOVERY_ANOMALY_WINDOW_MS).toBe(24 * 3_600_000);
    expect(RECOVERY_ANOMALY_THRESHOLD).toBe(3);
  });
});

describe("F-194 — decideRecoveryCosign: who may co-sign a pending recovery", () => {
  it("a DIFFERENT person may co-sign a pending, unexpired request", () => {
    expect(decideRecoveryCosign(pending(), OTHER, NOW)).toEqual({ ok: true });
  });

  it("the REQUESTER may not co-sign their own request", () => {
    expect(decideRecoveryCosign(pending(), REQUESTER, NOW)).toMatchObject({ ok: false, code: "self_cosign" });
  });

  it.each(["executed", "cancelled", "expired"])("a %s request is `not_pending`", (status) => {
    expect(decideRecoveryCosign(pending({ status }), OTHER, NOW)).toMatchObject({ ok: false, code: "not_pending" });
  });

  it("a request whose `expires_at` has passed (or is exactly now) is `expired`", () => {
    expect(decideRecoveryCosign(pending({ expiresAt: EARLIER }), OTHER, NOW)).toMatchObject({ ok: false, code: "expired" });
    expect(decideRecoveryCosign(pending({ expiresAt: NOW }), OTHER, NOW)).toMatchObject({ ok: false, code: "expired" });
  });

  it("no authenticated user cannot co-sign", () => {
    expect(decideRecoveryCosign(pending(), "", NOW)).toMatchObject({ ok: false, code: "no_actor" });
  });

  it("a SETTLED or lapsed request reports THAT — never whether the caller happens to be its requester (the break-glass order)", () => {
    expect(decideRecoveryCosign(pending({ status: "executed" }), REQUESTER, NOW)).toMatchObject({ code: "not_pending" });
    expect(decideRecoveryCosign(pending({ expiresAt: EARLIER }), REQUESTER, NOW)).toMatchObject({ code: "expired" });
  });
});

describe("F-194 — isRepeatAttester", () => {
  it("counts the request at hand: with the default threshold of 3, the third in the window is a repeat", () => {
    expect(isRepeatAttester(0)).toBe(false);
    expect(isRepeatAttester(1)).toBe(false);
    expect(isRepeatAttester(2)).toBe(true);
    expect(isRepeatAttester(7)).toBe(true);
  });
  it("the threshold is injectable", () => {
    expect(isRepeatAttester(1, 2)).toBe(true);
    expect(isRepeatAttester(0, 2)).toBe(false);
  });
});

describe("F-194 — buildRecoveryAlert: what compliance is told, and nothing else", () => {
  const facts = {
    orderId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    requestId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    requestedByMembershipId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    cosignedByMembershipId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  };

  it("an EXECUTED recovery warns; a repeat attester turns it `critical` (and says so with a flag and a count)", () => {
    const normal = buildRecoveryAlert("m11.order.recovery_executed", { ...facts, requesterCountInWindow: 1 });
    expect(normal.severity).toBe("warn");
    expect(normal.payload).toMatchObject({ repeatAttester: false, requesterRequestsInWindow: 1, repeatAttesterThreshold: 3 });
    const repeat = buildRecoveryAlert("m11.order.recovery_executed", { ...facts, requesterCountInWindow: 3 });
    expect(repeat.severity).toBe("critical");
    expect(repeat.payload).toMatchObject({ repeatAttester: true, requesterRequestsInWindow: 3 });
    // an injected threshold
    expect(
      buildRecoveryAlert("m11.order.recovery_executed", { ...facts, requesterCountInWindow: 2, anomalyThreshold: 2 }).severity,
    ).toBe("critical");
  });

  it("a LAPSED request warns, a CANCELLED one is info — and neither is ever a repeat-attester flag", () => {
    const expired = buildRecoveryAlert("m11.order.recovery_expired", { ...facts, requesterCountInWindow: 99 });
    expect(expired.severity).toBe("warn");
    expect(expired.payload.repeatAttester).toBe(false);
    const cancelled = buildRecoveryAlert("m11.order.recovery_cancelled", { ...facts, requesterCountInWindow: 99 });
    expect(cancelled.severity).toBe("info");
    expect(cancelled.payload.repeatAttester).toBe(false);
  });

  it("every severity is one the M36 emitter accepts (`info` | `warn` | `critical`)", () => {
    for (const kind of RECOVERY_ALERT_KINDS) {
      expect(["info", "warn", "critical"]).toContain(buildRecoveryAlert(kind, facts).severity);
    }
  });

  it("carries IDS AND COUNTS ONLY — the payload has no field that could hold a name, a reference or a patient", () => {
    const alert = buildRecoveryAlert("m11.order.recovery_executed", facts);
    expect(Object.keys(alert.payload).sort()).toEqual(
      [
        "cancelledByMembershipId",
        "cosignedByMembershipId",
        "deepLink",
        "orderId",
        "repeatAttester",
        "repeatAttesterThreshold",
        "requestId",
        "requestedByMembershipId",
        "requesterRequestsInWindow",
      ].sort(),
    );
    expect(JSON.stringify(alert)).not.toMatch(/contact|labReference|patient|Reyes|REF-/i);
  });

  it("the correlation id is per (kind, request) — `alert` dedupes on it, so it must differ for every request AND every kind", () => {
    const ids = new Set<string>();
    for (const kind of RECOVERY_ALERT_KINDS) {
      ids.add(buildRecoveryAlert(kind, facts).correlationId);
      ids.add(buildRecoveryAlert(kind, { ...facts, requestId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee" }).correlationId);
    }
    expect(ids.size).toBe(RECOVERY_ALERT_KINDS.length * 2);
    expect(buildRecoveryAlert("m11.order.recovery_executed", facts).correlationId).toBe(
      `m11-recovery:m11.order.recovery_executed:${facts.requestId}`,
    );
  });
});

describe("F-194 — every alert kind the recovery control can emit has an ENABLED platform-default rule (an alert with no rule reaches nobody — F-188's lesson)", () => {
  it.each([...RECOVERY_ALERT_KINDS])("%s", (kind) => {
    const rules = PLATFORM_DEFAULT_ALERT_RULES.filter((r) => r.eventType === kind);
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({ enabled: true, recipientResolver: "role_set" });
    const roleKeys = (rules[0]!.resolverArgs as { roleKeys: string[] }).roleKeys;
    // compliance is the audience; org_admin is the backstop for a tenant with no compliance-officer role assigned.
    expect(roleKeys).toEqual(["compliance_officer", "org_admin"]);
  });
});
