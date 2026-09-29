// apps/backend/__tests__/stuck-recovery.test.ts — F-191 (#248): the PURE rules for getting a stuck lab order out of that
// state without waiting for a human to notice (`orm-request/stuck-recovery.ts`), the seeded-rule guard for the two alert
// kinds the sweeps emit, and the HTTP contract of `GET /api/v1/orders/held-transmissions` through the full M1 middleware
// chain (Fastify `inject`, the real Authorization Contract). The DB behaviour — the sweeps, the bound, the worklist, RLS,
// single dispatch, the real emitter — is `m11-stuck-recovery.live`.
import {
  createInMemoryEffectivePermissionStore,
  registerEffectivePermissionResolver,
  resetAbacRegistry,
  resetAuthorizationContract,
  resetRbacEngine,
} from "@wardenx/auth";
import { PLATFORM_DEFAULT_ALERT_RULES } from "@wardenx/messaging";
import type { FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import {
  createInMemoryOrderBackend,
  registerHeldTransmissionRoutes,
  registerOrderRoutes,
  runStuckTransmissionFanout,
} from "../src/modules/11-orders/index";
import {
  AUTO_RETRY_BACKOFF_MS,
  AUTO_RETRY_MAX_ATTEMPTS,
  AUTO_RETRY_WINDOW_MS,
  type AutoRetryCandidate,
  BAA_REFUSAL_REASON,
  DEFAULT_HELD_THRESHOLDS,
  HELD_CRITICAL_AFTER_MS,
  HELD_WARN_AFTER_MS,
  M11_STUCK_ORDER_ALERT_KINDS,
  assertHeldThresholds,
  autoRetryExhaustedCorrelationId,
  classifyAutoRetry,
  heldAgingCorrelationId,
  heldStage,
  heldThresholdsFromEnv,
  isHeldReason,
} from "../src/modules/11-orders/orm-request/stuck-recovery";

const MIN = 60_000;
const HOUR = 60 * MIN;
const NOW = new Date("2026-06-08T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms);

const failed = (reason: string | null, over: Partial<AutoRetryCandidate> = {}): AutoRetryCandidate => ({
  kind: "lab",
  status: "active",
  transmissionStatus: "failed",
  transmissionFailureReason: reason,
  autoRetryCount: 0,
  autoRetryAt: null,
  autoRetryExhaustedAt: null,
  failedAt: ago(HOUR),
  ...over,
});

describe("F-191 — classifyAutoRetry: what the sweep may re-emit, and when", () => {
  it.each([
    "dispatch_refused:baa_inactive",
    "dispatch_refused:no_active_feed",
    "dispatch_refused:ambiguous_feed",
    "dispatch_refused:no_feed_for_destination",
    "dispatch_refused:feed_identity_incomplete",
    "orm_refused:physician_npi_unconfirmed",
    "orm_refused:patient_dob_missing",
    "orm_refused:no_active_feed",
    "orm_refused:dependency_unavailable",
  ])("%s — refused before any outbound row existed — is retried", (reason) => {
    expect(classifyAutoRetry(failed(reason), NOW)).toMatchObject({ action: "retry" });
  });

  it.each([
    ["a substance-use-disorder refusal (42 CFR Part 2 — a disclosure gate, not a data fix)", "orm_refused:sud_restricted"],
    ["a refusal that lives in the immutable signed order", "orm_refused:no_routing_lab"],
    ["a refusal that lives in the immutable signed order", "orm_refused:lab_test_codes_missing"],
    ["a refusal that lives in the immutable signed order", "orm_refused:multiple_test_codes_unsupported"],
    ["an M29 terminal failure (the lab MAY have the message)", "dlq_exhausted"],
    ["an M29 terminal failure (the lab MAY have the message)", "application_reject"],
    ["an attested re-dispatch the worker could not honour (a row owns the order)", "recovery_blocked:row_owns_order"],
    ["no reason at all", null],
  ])("%s (%s) is NEVER retried automatically", (_why, reason) => {
    expect(classifyAutoRetry(failed(reason), NOW)).toEqual({ action: "skip", why: "not_eligible" });
  });

  it("only a failed, active LAB order is a candidate", () => {
    const r = "dispatch_refused:baa_inactive";
    for (const over of [
      { kind: "medication" },
      { status: "discontinued" },
      { transmissionStatus: "pending" },
      { transmissionStatus: "transmitted" },
    ]) {
      expect(classifyAutoRetry(failed(r, over), NOW)).toEqual({ action: "skip", why: "not_eligible" });
    }
  });

  it("only the BAA refusal asks for the BAA pre-check — every other cause is verified by the producer itself", () => {
    expect(classifyAutoRetry(failed(BAA_REFUSAL_REASON), NOW)).toEqual({ action: "retry", needsBaaCheck: true });
    expect(classifyAutoRetry(failed("dispatch_refused:no_active_feed"), NOW)).toEqual({ action: "retry", needsBaaCheck: false });
    expect(classifyAutoRetry(failed("orm_refused:physician_npi_unconfirmed"), NOW)).toEqual({ action: "retry", needsBaaCheck: false });
  });

  it("the bound: a re-emission is refused once MAX attempts are spent — 'exhausted', not another retry", () => {
    const r = "dispatch_refused:baa_inactive";
    expect(AUTO_RETRY_MAX_ATTEMPTS).toBe(5);
    for (let n = 0; n < AUTO_RETRY_MAX_ATTEMPTS; n++) {
      expect(classifyAutoRetry(failed(r, { autoRetryCount: n, autoRetryAt: ago(48 * HOUR) }), NOW)).toMatchObject({
        action: "retry",
      });
    }
    expect(classifyAutoRetry(failed(r, { autoRetryCount: AUTO_RETRY_MAX_ATTEMPTS, autoRetryAt: ago(HOUR) }), NOW)).toEqual({
      action: "exhausted",
      why: "attempts",
    });
  });

  it("the window: an order that has been failed longer than 72 h is 'exhausted' — checked against the LATEST failure", () => {
    const r = "dispatch_refused:baa_inactive";
    expect(AUTO_RETRY_WINDOW_MS).toBe(72 * HOUR);
    expect(classifyAutoRetry(failed(r, { failedAt: ago(72 * HOUR) }), NOW)).toMatchObject({ action: "retry" });
    expect(classifyAutoRetry(failed(r, { failedAt: ago(72 * HOUR + 1) }), NOW)).toEqual({
      action: "exhausted",
      why: "window",
    });
  });

  it("the backoff: after the Nth re-emission the (N+1)th waits BACKOFF[N-1]; a count past the schedule reuses the last step", () => {
    const r = "dispatch_refused:baa_inactive";
    expect(AUTO_RETRY_BACKOFF_MS).toEqual([10 * MIN, 30 * MIN, 2 * HOUR, 6 * HOUR]);
    // Every step is REACHABLE and none is dead: one wait after each attempt short of the bound, since the bound (not a
    // further wait) is what ends the sweep at MAX.
    expect(AUTO_RETRY_BACKOFF_MS).toHaveLength(AUTO_RETRY_MAX_ATTEMPTS - 1);
    AUTO_RETRY_BACKOFF_MS.forEach((step, i) => {
      const count = i + 1;
      expect(classifyAutoRetry(failed(r, { autoRetryCount: count, autoRetryAt: ago(step - 1) }), NOW)).toEqual({
        action: "skip",
        why: "backoff",
      });
      expect(classifyAutoRetry(failed(r, { autoRetryCount: count, autoRetryAt: ago(step) }), NOW)).toMatchObject({
        action: "retry",
      });
    });
    // At the bound there is no wait at all — the sweep is DONE, whatever the clock says.
    expect(
      classifyAutoRetry(failed(r, { autoRetryCount: AUTO_RETRY_MAX_ATTEMPTS, autoRetryAt: ago(0) }), NOW),
    ).toEqual({ action: "exhausted", why: "attempts" });
    // Strictly increasing: a longer wait after every attempt.
    for (let i = 1; i < AUTO_RETRY_BACKOFF_MS.length; i++) {
      expect(AUTO_RETRY_BACKOFF_MS[i]).toBeGreaterThan(AUTO_RETRY_BACKOFF_MS[i - 1] as number);
    }
    // No backoff before the first attempt.
    expect(classifyAutoRetry(failed(r, { autoRetryCount: 0, autoRetryAt: null }), NOW)).toMatchObject({ action: "retry" });
  });

  it("an order the sweep already gave up on (its one alert raised) is skipped — never re-alerted", () => {
    const r = "dispatch_refused:baa_inactive";
    expect(classifyAutoRetry(failed(r, { autoRetryCount: 9, autoRetryExhaustedAt: ago(HOUR) }), NOW)).toEqual({
      action: "skip",
      why: "exhausted_already",
    });
  });
});

describe("F-191 — held orders: which failures need a human, and how they age", () => {
  it("held = M29-terminal failures and recovery_blocked:* — everything a message may already be at the lab for", () => {
    for (const r of ["dlq_exhausted", "application_reject", "recovery_blocked:row_owns_order"]) {
      expect(isHeldReason(r)).toBe(true);
    }
    for (const r of [null, "orm_refused:sud_restricted", "dispatch_refused:baa_inactive", "orm_refused:no_active_feed", "transmitted"]) {
      expect(isHeldReason(r)).toBe(false);
    }
  });

  it("held and auto-retryable are DISJOINT — no failure is both retried automatically and left for a human", () => {
    const reasons = [
      "dlq_exhausted",
      "application_reject",
      "recovery_blocked:row_owns_order",
      "dispatch_refused:baa_inactive",
      "dispatch_refused:no_active_feed",
      "orm_refused:sud_restricted",
      "orm_refused:physician_npi_unconfirmed",
      "orm_refused:no_routing_lab",
    ];
    for (const r of reasons) {
      const retryable = classifyAutoRetry(failed(r), NOW).action === "retry";
      expect(retryable && isHeldReason(r), r).toBe(false);
    }
  });

  it("the ladder: none inside 4 h, warn from 4 h, critical from 24 h (boundaries inclusive)", () => {
    expect(HELD_WARN_AFTER_MS).toBe(4 * HOUR);
    expect(HELD_CRITICAL_AFTER_MS).toBe(24 * HOUR);
    expect(heldStage(0)).toBe("none");
    expect(heldStage(4 * HOUR - 1)).toBe("none");
    expect(heldStage(4 * HOUR)).toBe("warn");
    expect(heldStage(24 * HOUR - 1)).toBe("warn");
    expect(heldStage(24 * HOUR)).toBe("critical");
    expect(heldStage(30 * 24 * HOUR)).toBe("critical");
  });

  it("custom thresholds are honoured, and nonsensical ones are refused loudly", () => {
    const t = { warnAfterMs: HOUR, criticalAfterMs: 2 * HOUR };
    expect(heldStage(90 * MIN, t)).toBe("warn");
    expect(heldStage(2 * HOUR, t)).toBe("critical");
    expect(() => assertHeldThresholds({ warnAfterMs: HOUR, criticalAfterMs: HOUR })).toThrow(/later than/);
    expect(() => assertHeldThresholds({ warnAfterMs: 2 * HOUR, criticalAfterMs: HOUR })).toThrow(/later than/);
    expect(() => assertHeldThresholds({ warnAfterMs: 0, criticalAfterMs: HOUR })).toThrow(/positive/);
    expect(() => assertHeldThresholds({ warnAfterMs: Number.NaN, criticalAfterMs: HOUR })).toThrow(/positive/);
  });

  it("thresholds from the environment: defaults, an override, and a misconfiguration that THROWS (never a silently disabled escalation)", () => {
    expect(heldThresholdsFromEnv({})).toEqual(DEFAULT_HELD_THRESHOLDS);
    expect(heldThresholdsFromEnv({ M11_HELD_WARN_AFTER_HOURS: "1", M11_HELD_CRITICAL_AFTER_HOURS: "6" })).toEqual({
      warnAfterMs: HOUR,
      criticalAfterMs: 6 * HOUR,
    });
    expect(heldThresholdsFromEnv({ M11_HELD_WARN_AFTER_HOURS: "0.5" })).toEqual({
      warnAfterMs: 30 * MIN,
      criticalAfterMs: HELD_CRITICAL_AFTER_MS,
    });
    expect(heldThresholdsFromEnv({ M11_HELD_WARN_AFTER_HOURS: "  " })).toEqual(DEFAULT_HELD_THRESHOLDS);
    for (const bad of ["abc", "-1", "0", "Infinity"]) {
      expect(() => heldThresholdsFromEnv({ M11_HELD_WARN_AFTER_HOURS: bad }), bad).toThrow(/M11_HELD_WARN_AFTER_HOURS/);
    }
    // a warn later than the default critical is caught by the ladder check, not silently accepted
    expect(() => heldThresholdsFromEnv({ M11_HELD_WARN_AFTER_HOURS: "48" })).toThrow(/later than/);
  });
});

describe("F-191 — alert identity and the seeded rules", () => {
  it("a held-aging alert id is stable within (order, hold episode, stage) and NEW for the next stage, order or episode", () => {
    const a = heldAgingCorrelationId("o1", "att1", "warn");
    expect(heldAgingCorrelationId("o1", "att1", "warn")).toBe(a);
    expect(new Set([a, heldAgingCorrelationId("o1", "att1", "critical"), heldAgingCorrelationId("o2", "att1", "warn"), heldAgingCorrelationId("o1", "att2", "warn")]).size).toBe(4);
    expect(heldAgingCorrelationId("o1", null, "warn")).toContain(":none:");
  });

  it("the exhausted alert id is stable per (order, episode) — the alert table's unique id is the de-duplication", () => {
    expect(autoRetryExhaustedCorrelationId("o1", "att1")).toBe(autoRetryExhaustedCorrelationId("o1", "att1"));
    expect(autoRetryExhaustedCorrelationId("o1", "att1")).not.toBe(autoRetryExhaustedCorrelationId("o1", "att2"));
    expect(autoRetryExhaustedCorrelationId("o1", "att1")).not.toBe(autoRetryExhaustedCorrelationId("o2", "att1"));
  });

  it("EVERY alert kind the sweeps emit has an enabled platform-default rule with a real audience (an unruled kind reaches nobody — F-188)", () => {
    expect([...M11_STUCK_ORDER_ALERT_KINDS].sort()).toEqual([
      "m11.order.transmission_auto_retry_exhausted",
      "m11.order.transmission_held_aging",
    ]);
    for (const kind of M11_STUCK_ORDER_ALERT_KINDS) {
      const rule = PLATFORM_DEFAULT_ALERT_RULES.find((r) => r.eventType === kind);
      expect(rule, `no seeded rule for ${kind}`).toBeDefined();
      expect(rule?.enabled).toBe(true);
      expect(rule?.recipientResolver).toBe("role_set");
      expect(rule?.resolverArgs).toEqual({ roleKeys: ["org_admin", "clinical_lead"] });
    }
  });
});

// ── HTTP contract: GET /api/v1/orders/held-transmissions ─────────────────────────────────────────────────────────

function headerAuth(request: FastifyRequest): void {
  const user = request.headers["x-test-user"];
  if (typeof user !== "string" || user.length === 0) return;
  request.context.userId = user;
  request.context.attributes.membershipId = user;
  const org = request.headers["x-test-org"];
  request.context.organizationId = typeof org === "string" ? org : "";
  request.context.roles = [];
}

const ORG = "org_a";
const PERMISSION_SEED = [
  { userId: "rn_1", permissions: ["orders.read", "orders.draft", "orders.sign", "orders.amend"] },
  { userId: "viewer_1", permissions: ["orders.read"] },
];
const RN = { "x-test-user": "rn_1", "x-test-org": ORG };
const VIEWER = { "x-test-user": "viewer_1", "x-test-org": ORG };
const URL = "/api/v1/orders/held-transmissions";

function makeServer() {
  const listHeld = vi.fn(async () => ({ items: [], nextCursor: null }));
  const grantStore = createInMemoryEffectivePermissionStore(
    PERMISSION_SEED.map((s) => ({
      orgId: ORG,
      userId: s.userId,
      grants: [{ roleKey: "seed", enabled: true, expiresAt: null, permissionKeys: s.permissions }],
    })),
  );
  registerEffectivePermissionResolver(grantStore.store);
  const app = buildServer({ authenticate: headerAuth, security: { rateLimitEnabled: false } });
  // The REAL order routes are registered too: `held-transmissions` must not be swallowed by `/api/v1/orders/:id`.
  registerOrderRoutes(app, { service: createInMemoryOrderBackend({ now: () => NOW.toISOString(), timeZone: "America/New_York" }) });
  registerHeldTransmissionRoutes(app, { recovery: { listHeld } });
  return { app, listHeld };
}

beforeEach(() => {
  resetAuthorizationContract();
  resetRbacEngine();
  resetAbacRegistry();
});
afterEach(() => {
  resetAuthorizationContract();
  resetRbacEngine();
  resetAbacRegistry();
});

describe("F-191 — GET /api/v1/orders/held-transmissions", () => {
  it("no session is 401 and reads nothing", async () => {
    const { app, listHeld } = makeServer();
    const res = await app.inject({ method: "GET", url: URL });
    expect(res.statusCode).toBe(401);
    expect(listHeld).not.toHaveBeenCalled();
  });

  it("`orders.read` alone is 403 — the worklist is for the people who can ACT on it (`orders.amend`)", async () => {
    const { app, listHeld } = makeServer();
    const res = await app.inject({ method: "GET", url: URL, headers: VIEWER });
    expect(res.statusCode).toBe(403);
    expect(listHeld).not.toHaveBeenCalled();
  });

  it("with `orders.amend` it returns the page for the CALLER's org, defaulting to 50 and forwarding the cursor", async () => {
    const { app, listHeld } = makeServer();
    const res = await app.inject({ method: "GET", url: URL, headers: RN });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ items: [], nextCursor: null });
    expect(listHeld).toHaveBeenCalledWith(ORG, { limit: 50, cursor: undefined });

    await app.inject({ method: "GET", url: `${URL}?limit=7&cursor=abc`, headers: RN });
    expect(listHeld).toHaveBeenLastCalledWith(ORG, { limit: 7, cursor: "abc" });
  });

  it("the org comes from the authenticated context, NEVER a query parameter", async () => {
    const { app, listHeld } = makeServer();
    await app.inject({ method: "GET", url: `${URL}?organizationId=org_b&orgId=org_b`, headers: RN });
    expect(listHeld).toHaveBeenLastCalledWith(ORG, expect.anything());
  });

  it("is a static route beside `/orders/:id` — never read as an order id (no uuid validation error)", async () => {
    const { app } = makeServer();
    const res = await app.inject({ method: "GET", url: URL, headers: RN });
    expect(res.statusCode).toBe(200);
    // ...while a real id still routes to the order route (which 404s an unknown order, it does not 405/200).
    const byId = await app.inject({ method: "GET", url: "/api/v1/orders/99999999-9999-4999-8999-999999999999", headers: RN });
    expect(byId.statusCode).toBe(404);
  });

  it.each([
    ["limit above the cap", "?limit=101"],
    ["limit zero", "?limit=0"],
    ["a non-numeric limit", "?limit=lots"],
    ["an over-long cursor", `?cursor=${"x".repeat(301)}`],
  ])("rejects %s with 422 and reads nothing", async (_label, qs) => {
    const { app, listHeld } = makeServer();
    const res = await app.inject({ method: "GET", url: `${URL}${qs}`, headers: RN });
    expect(res.statusCode).toBe(422);
    expect(listHeld).not.toHaveBeenCalled();
  });
});

// ── the worker fan-out ─────────────────────────────────────────────────────────────────────────────────────────────

describe("F-191 — runStuckTransmissionFanout: one tick, every active org, failures surfaced not swallowed", () => {
  const orgs = (...ids: string[]) => ({ listActiveOrgs: async () => ids.map((organizationId) => ({ organizationId })) });

  it("runs BOTH sweeps for every active org, in order", async () => {
    const calls: string[] = [];
    await runStuckTransmissionFanout({
      activeOrgs: orgs("a", "b"),
      service: {
        sweepAutoRetries: async (o) => {
          calls.push(`retry:${o}`);
          return {} as never;
        },
        sweepHeldAging: async (o) => {
          calls.push(`aging:${o}`);
          return {} as never;
        },
      },
    });
    expect(calls).toEqual(["retry:a", "aging:a", "retry:b", "aging:b"]);
  });

  it("a failing auto-retry does NOT silence the held-order escalation, nor stop the next org — and every failure is re-raised together", async () => {
    const calls: string[] = [];
    const boom = new Error("retry exploded for a");
    await expect(
      runStuckTransmissionFanout({
        activeOrgs: orgs("a", "b"),
        service: {
          sweepAutoRetries: async (o) => {
            calls.push(`retry:${o}`);
            if (o === "a") throw boom;
            return {} as never;
          },
          sweepHeldAging: async (o) => {
            calls.push(`aging:${o}`);
            return {} as never;
          },
        },
      }),
    ).rejects.toMatchObject({ name: "AggregateError", errors: [boom] });
    // the escalation for `a` still ran, and `b` was fully processed
    expect(calls).toEqual(["retry:a", "aging:a", "retry:b", "aging:b"]);
  });

  it("with no active orgs it does nothing and does not throw", async () => {
    await expect(
      runStuckTransmissionFanout({
        activeOrgs: orgs(),
        service: { sweepAutoRetries: async () => ({}) as never, sweepHeldAging: async () => ({}) as never },
      }),
    ).resolves.toBeUndefined();
  });
});
