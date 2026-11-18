// The visit-note closure gate's decision order (ADR-0113 D6), with a fake policy cache and a fake evaluator so every branch is
// reachable and every IO is countable: an allowlisted route does no IO; `off` / `warn` refuse nothing; `block` refuses a `blocked`
// verdict with 403 NOTE_CLOSURE_REQUIRED, caches only `clear` (5s, never past the block instant), never caches a block; and any
// failure on a non-allowlisted route is 503 NOTE_CLOSURE_UNAVAILABLE rather than a pass, except that a failed policy REFRESH for an
// organization whose last known mode was off / warn serves that policy for a bounded time. Concurrent evaluations share one call.
import {
  ChartWardenError,
  type DocumentationObligationMode,
  RateLimitedError,
} from "@chartwarden/types";
import { describe, expect, it, vi } from "vitest";
import {
  NOTE_CLOSURE_BUDGET_MAX_ENTRIES,
  NOTE_CLOSURE_BUDGET_RETRY_AFTER_SECONDS,
  NOTE_CLOSURE_CLEAR_CACHE_MAX_ENTRIES,
  NOTE_CLOSURE_CLEAR_TTL_MS,
  NOTE_CLOSURE_EVALUATION_BUDGET_PER_SECOND,
  NOTE_CLOSURE_EVALUATION_TIMEOUT_MS,
  NOTE_CLOSURE_FAILURE_LOG_INTERVAL_MS,
  NOTE_CLOSURE_POLICY_STALE_MS,
  NOTE_CLOSURE_REFUSAL_LOG_INTERVAL_MS,
  NOTE_CLOSURE_REQUIRED_CODE,
  NOTE_CLOSURE_UNAVAILABLE_CODE,
  type NoteClosureGateEvaluation,
  type NoteClosureGateRequest,
  createNoteClosureGate,
  noteClosureMayCall,
} from "../src/bootstrap/note-closure-gate";
import { CLOSURE_POLICY_CACHE_TTL_MS } from "../src/modules/08-encounters/closure/policy-service";

const ORG = "11111111-1111-4111-8111-111111111111";
const OTHER_ORG = "11111111-1111-4111-8111-222222222222";
const USER = "22222222-2222-4222-8222-222222222222";
const MEMBER = "33333333-3333-4333-8333-333333333333";
const OTHER_MEMBER = "33333333-3333-4333-8333-444444444444";
const ENCOUNTER = "44444444-4444-4444-8444-444444444444";
const NOW = new Date("2026-11-17T12:00:00.000Z");
const DEADLINE = new Date("2026-11-16T12:00:00.000Z");

const BLOCKED_ROUTE = { method: "GET", routeTemplate: "/api/v1/billing/claims" } as const;
const ALLOWED_ROUTE = {
  method: "POST",
  routeTemplate: "/api/v1/encounters/:encounterId/sign",
} as const;

const request = (overrides: Partial<NoteClosureGateRequest> = {}): NoteClosureGateRequest => ({
  ...BLOCKED_ROUTE,
  rawUrl: BLOCKED_ROUTE.routeTemplate,
  organizationId: ORG,
  userId: USER,
  membershipId: MEMBER,
  ...overrides,
});

const blocked: NoteClosureGateEvaluation = {
  verdict: "blocked",
  encounterId: ENCOUNTER,
  overdueCount: 3,
  decision: { deadlineAt: DEADLINE, blockFrom: DEADLINE },
};
const clear = (blockFrom: Date | null = null): NoteClosureGateEvaluation => ({
  verdict: "clear",
  encounterId: null,
  overdueCount: 0,
  decision: { deadlineAt: null, blockFrom },
});

function harness(options: {
  mode?: DocumentationObligationMode | "bogus";
  evaluation?: () => Promise<NoteClosureGateEvaluation>;
  policy?: () => Promise<{ mode: DocumentationObligationMode }>;
  timers?: { set: (callback: () => void, ms: number) => unknown; clear: (handle: unknown) => void };
}) {
  let nowMs = NOW.getTime();
  const get = vi.fn(
    options.policy ??
      (async () => ({ mode: (options.mode ?? "block") as DocumentationObligationMode })),
  );
  const evaluate = vi.fn(options.evaluation ?? (async () => blocked));
  const onFailure = vi.fn();
  const onRefusal = vi.fn();
  const gate = createNoteClosureGate({
    policyCache: { get },
    evaluate,
    now: () => new Date(nowMs),
    onFailure,
    onRefusal,
    ...(options.timers ? { timers: options.timers } : {}),
  });
  return {
    gate,
    get,
    evaluate,
    onFailure,
    onRefusal,
    advance: (ms: number) => {
      nowMs += ms;
    },
  };
}

function deferredEvaluation() {
  let resolve: (value: NoteClosureGateEvaluation) => void = () => {};
  let reject: (reason: unknown) => void = () => {};
  const promise = new Promise<NoteClosureGateEvaluation>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const refusalOf = async (promise: Promise<void>): Promise<ChartWardenError> => {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ChartWardenError);
  return error as ChartWardenError;
};

describe("noteClosureMayCall - the allowlist match", () => {
  it("admits an exact METHOD + template pair and refuses a pair that differs in method", () => {
    expect(noteClosureMayCall({ ...ALLOWED_ROUTE, rawUrl: "/x" })).toBe(true);
    expect(
      noteClosureMayCall({
        method: "DELETE",
        routeTemplate: ALLOWED_ROUTE.routeTemplate,
        rawUrl: "/x",
      }),
    ).toBe(false);
  });

  it("refuses a request that matched no route (no template is never allowlisted)", () => {
    expect(
      noteClosureMayCall({ method: "GET", routeTemplate: undefined, rawUrl: "/api/v1/encounters" }),
    ).toBe(false);
  });

  it("matches on the template, not on a URL that merely looks allowed", () => {
    expect(
      noteClosureMayCall({
        method: "POST",
        routeTemplate: "/api/v1/billing/claims",
        rawUrl: "/api/v1/encounters/x/sign",
      }),
    ).toBe(false);
  });

  it("admits Better Auth's wildcard only for a path that decodes cleanly under /api/auth/", () => {
    const wildcard = (rawUrl: string) =>
      noteClosureMayCall({ method: "POST", routeTemplate: "/api/auth/*", rawUrl });
    expect(wildcard("/api/auth/sign-out")).toBe(true);
    expect(wildcard("/api/auth/get-session?x=1")).toBe(true);
    expect(wildcard("/api/auth/../v1/billing/claims")).toBe(false);
    expect(wildcard("/api/auth/%2e%2e/v1")).toBe(false);
    expect(wildcard("/api/auth/%E0%A4%A")).toBe(false);
    expect(wildcard("/api/auth\\x")).toBe(false);
    expect(wildcard("/api/v1/billing/claims")).toBe(false);
  });
});

describe("the gate - step 1: an allowlisted route does no IO", () => {
  it("passes without reading the policy or the evaluator, even when both would throw", async () => {
    const h = harness({
      policy: async () => {
        throw new Error("policy store down");
      },
      evaluation: async () => {
        throw new Error("evaluator down");
      },
    });
    await expect(
      h.gate.assertMayCall(request({ ...ALLOWED_ROUTE, rawUrl: ALLOWED_ROUTE.routeTemplate })),
    ).resolves.toBeUndefined();
    expect(h.get).not.toHaveBeenCalled();
    expect(h.evaluate).not.toHaveBeenCalled();
    expect(h.onFailure).not.toHaveBeenCalled();
  });
});

describe("the gate - step 2: the policy mode", () => {
  it.each(["off", "warn"] as const)(
    "%s refuses nothing and never runs the evaluator",
    async (mode) => {
      const h = harness({ mode });
      await expect(h.gate.assertMayCall(request())).resolves.toBeUndefined();
      expect(h.get).toHaveBeenCalledWith(ORG, "visit_note");
      expect(h.evaluate).not.toHaveBeenCalled();
    },
  );

  it("an unknown mode is not a pass: 503", async () => {
    const h = harness({ mode: "bogus" });
    const error = await refusalOf(h.gate.assertMayCall(request()));
    expect(error.code).toBe(NOTE_CLOSURE_UNAVAILABLE_CODE);
    expect(error.statusCode).toBe(503);
  });
});

describe("the gate - step 3: block mode", () => {
  it("refuses a blocked verdict 403 NOTE_CLOSURE_REQUIRED with the encounter, the deadline and the count (ids and instants only)", async () => {
    const h = harness({});
    const error = await refusalOf(h.gate.assertMayCall(request()));
    expect(error.code).toBe(NOTE_CLOSURE_REQUIRED_CODE);
    expect(error.statusCode).toBe(403);
    expect(error.details).toEqual([
      { field: "encounterId", code: "OLDEST_OPEN_NOTE", message: ENCOUNTER },
      { field: "deadlineAt", code: "DEADLINE", message: DEADLINE.toISOString() },
      { field: "overdueCount", code: "OVERDUE_COUNT", message: "3" },
    ]);
    expect(JSON.stringify(error.details)).not.toMatch(/patient|name|dob|ssn/i);
  });

  it("hands the evaluator the caller's org, user, membership, the instant and the policy it read", async () => {
    const h = harness({});
    await refusalOf(h.gate.assertMayCall(request()));
    expect(h.evaluate).toHaveBeenCalledWith({
      organizationId: ORG,
      userId: USER,
      membershipId: MEMBER,
      now: NOW,
      policy: { mode: "block" },
    });
  });

  it("never caches a block: the next request evaluates again, so a signature or an override lifts it at once", async () => {
    let verdict = blocked;
    const h = harness({ evaluation: async () => verdict });
    await refusalOf(h.gate.assertMayCall(request()));
    verdict = clear();
    await expect(h.gate.assertMayCall(request())).resolves.toBeUndefined();
    expect(h.evaluate).toHaveBeenCalledTimes(2);
  });

  it("passes a warn verdict, but trusts it only on a proven bound: with no override and no block instant ahead it is asked again every time", async () => {
    const h = harness({ evaluation: async () => ({ ...blocked, verdict: "warn" }) });
    await h.gate.assertMayCall(request());
    await h.gate.assertMayCall(request());
    expect(h.evaluate).toHaveBeenCalledTimes(2);
  });

  it("caches an overridden warn until the earlier of the TTL and the end of the override, then asks again", async () => {
    const overrideExpiresAt = new Date(NOW.getTime() + 2_000);
    const h = harness({
      evaluation: async () => ({ ...blocked, verdict: "warn", overrideExpiresAt }),
    });
    await h.gate.assertMayCall(request());
    h.advance(1_999);
    await h.gate.assertMayCall(request());
    expect(h.evaluate).toHaveBeenCalledTimes(1);
    h.advance(1); // the override has ended: the cached pass must not outlive it
    await h.gate.assertMayCall(request());
    expect(h.evaluate).toHaveBeenCalledTimes(2);
  });

  it("caps an overridden warn at the TTL when the override runs for hours", async () => {
    const overrideExpiresAt = new Date(NOW.getTime() + 60 * 60 * 1000);
    const h = harness({
      evaluation: async () => ({ ...blocked, verdict: "warn", overrideExpiresAt }),
    });
    await h.gate.assertMayCall(request());
    h.advance(NOTE_CLOSURE_CLEAR_TTL_MS - 1);
    await h.gate.assertMayCall(request());
    expect(h.evaluate).toHaveBeenCalledTimes(1);
    h.advance(1);
    await h.gate.assertMayCall(request());
    expect(h.evaluate).toHaveBeenCalledTimes(2);
  });

  it("caches a warn in the grace window (a block instant still ahead) only until that instant", async () => {
    const blockFrom = new Date(NOW.getTime() + 2_000);
    const h = harness({
      evaluation: async () => ({
        ...blocked,
        verdict: "warn",
        decision: { deadlineAt: DEADLINE, blockFrom },
      }),
    });
    await h.gate.assertMayCall(request());
    h.advance(1_999);
    await h.gate.assertMayCall(request());
    expect(h.evaluate).toHaveBeenCalledTimes(1);
    h.advance(1);
    await h.gate.assertMayCall(request());
    expect(h.evaluate).toHaveBeenCalledTimes(2);
  });

  it("never caches a blocked verdict, even one that carries an override expiry", async () => {
    const overrideExpiresAt = new Date(NOW.getTime() + 60 * 60 * 1000);
    const h = harness({ evaluation: async () => ({ ...blocked, overrideExpiresAt }) });
    await refusalOf(h.gate.assertMayCall(request()));
    await refusalOf(h.gate.assertMayCall(request()));
    expect(h.evaluate).toHaveBeenCalledTimes(2);
  });

  it("an overridden member is not spent against the evaluation budget on every request", async () => {
    const overrideExpiresAt = new Date(NOW.getTime() + 60 * 60 * 1000);
    const h = harness({
      evaluation: async () => ({ ...blocked, verdict: "warn", overrideExpiresAt }),
    });
    for (let i = 0; i < NOTE_CLOSURE_EVALUATION_BUDGET_PER_SECOND * 3; i++) {
      await h.gate.assertMayCall(request());
    }
    expect(h.evaluate).toHaveBeenCalledTimes(1);
  });

  it("caches a clear verdict per organization + member for the TTL, then asks again", async () => {
    const h = harness({ evaluation: async () => clear() });
    await h.gate.assertMayCall(request());
    await h.gate.assertMayCall(request());
    expect(h.evaluate).toHaveBeenCalledTimes(1);
    h.advance(NOTE_CLOSURE_CLEAR_TTL_MS - 1);
    await h.gate.assertMayCall(request());
    expect(h.evaluate).toHaveBeenCalledTimes(1);
    h.advance(1);
    await h.gate.assertMayCall(request());
    expect(h.evaluate).toHaveBeenCalledTimes(2);
  });

  it("a cached clear is scoped to its member and its organization", async () => {
    const h = harness({ evaluation: async () => clear() });
    await h.gate.assertMayCall(request());
    await h.gate.assertMayCall(request({ membershipId: OTHER_MEMBER }));
    await h.gate.assertMayCall(request({ organizationId: OTHER_ORG }));
    expect(h.evaluate).toHaveBeenCalledTimes(3);
  });

  it("never trusts a cached clear past the instant the oldest note would start to block", async () => {
    const blockFrom = new Date(NOW.getTime() + 2_000);
    const h = harness({ evaluation: async () => clear(blockFrom) });
    await h.gate.assertMayCall(request());
    h.advance(1_999);
    await h.gate.assertMayCall(request());
    expect(h.evaluate).toHaveBeenCalledTimes(1);
    h.advance(1);
    await h.gate.assertMayCall(request());
    expect(h.evaluate).toHaveBeenCalledTimes(2);
  });

  it("a request that arrives AFTER the in-flight evaluation settled starts a NEW one (a joiner shares only a running call, never a settled result)", async () => {
    const first = deferredEvaluation();
    let calls = 0;
    const h = harness({
      evaluation: () => {
        calls += 1;
        return calls === 1 ? first.promise : Promise.resolve(clear());
      },
    });
    const running = refusalOf(h.gate.assertMayCall(request()));
    await vi.waitFor(() => expect(h.evaluate).toHaveBeenCalledTimes(1));
    const joiner = refusalOf(h.gate.assertMayCall(request()));
    first.resolve(blocked);
    await Promise.all([running, joiner]);
    expect(h.evaluate).toHaveBeenCalledTimes(1); // the joiner shared the running call
    await expect(h.gate.assertMayCall(request())).resolves.toBeUndefined(); // the next request is evaluated afresh (and now clear)
    expect(h.evaluate).toHaveBeenCalledTimes(2);
  });

  it("stays bounded: a full cache of live verdicts declines to remember one more, and still answers correctly", async () => {
    const h = harness({ evaluation: async () => clear() });
    for (let i = 0; i < NOTE_CLOSURE_CLEAR_CACHE_MAX_ENTRIES; i++) {
      await h.gate.assertMayCall(request({ membershipId: `member-${i}` }));
    }
    await h.gate.assertMayCall(request({ membershipId: "member-overflow" }));
    await h.gate.assertMayCall(request({ membershipId: "member-overflow" }));
    expect(h.evaluate).toHaveBeenCalledTimes(NOTE_CLOSURE_CLEAR_CACHE_MAX_ENTRIES + 2);
    await h.gate.assertMayCall(request({ membershipId: "member-0" }));
    expect(h.evaluate).toHaveBeenCalledTimes(NOTE_CLOSURE_CLEAR_CACHE_MAX_ENTRIES + 2);
    h.advance(NOTE_CLOSURE_CLEAR_TTL_MS);
    await h.gate.assertMayCall(request({ membershipId: "member-overflow" }));
    await h.gate.assertMayCall(request({ membershipId: "member-overflow" }));
    expect(h.evaluate).toHaveBeenCalledTimes(NOTE_CLOSURE_CLEAR_CACHE_MAX_ENTRIES + 3);
  });
});

describe("the gate - step 4: failures close", () => {
  it("a policy read that throws is 503 NOTE_CLOSURE_UNAVAILABLE and is reported with the organization id only", async () => {
    const cause = new Error("connection refused");
    const h = harness({
      policy: async () => {
        throw cause;
      },
    });
    const error = await refusalOf(h.gate.assertMayCall(request()));
    expect(error.code).toBe(NOTE_CLOSURE_UNAVAILABLE_CODE);
    expect(error.statusCode).toBe(503);
    expect(h.onFailure).toHaveBeenCalledWith({
      organizationId: ORG,
      error: cause,
      servedStale: false,
      suppressed: 0,
    });
  });

  it("an evaluator that throws is 503, a RangeError from the pure clock included", async () => {
    for (const failure of [
      new Error("db down"),
      new RangeError("thresholdHours must be positive"),
    ]) {
      const h = harness({
        evaluation: async () => {
          throw failure;
        },
      });
      const error = await refusalOf(h.gate.assertMayCall(request()));
      expect(error.code).toBe(NOTE_CLOSURE_UNAVAILABLE_CODE);
      expect(error.statusCode).toBe(503);
    }
  });

  it("an unknown verdict is not a pass: 503", async () => {
    const h = harness({
      evaluation: async () => ({ ...blocked, verdict: "maybe" as unknown as "clear" }),
    });
    const error = await refusalOf(h.gate.assertMayCall(request()));
    expect(error.code).toBe(NOTE_CLOSURE_UNAVAILABLE_CODE);
  });

  it("a failed read is never cached: the next request retries", async () => {
    let fail = true;
    const h = harness({
      evaluation: async () => {
        if (fail) throw new Error("db down");
        return clear();
      },
    });
    await refusalOf(h.gate.assertMayCall(request()));
    fail = false;
    await expect(h.gate.assertMayCall(request())).resolves.toBeUndefined();
  });
});

describe("the gate - a failed policy refresh (stale-if-error)", () => {
  /** A policy source that answers `mode` until `fail()` is called, then throws. */
  function flakyPolicy(mode: DocumentationObligationMode | "bogus") {
    const state = { failing: false, mode };
    return {
      state,
      read: async () => {
        if (state.failing) throw new Error("policy store down");
        return { mode: state.mode as DocumentationObligationMode };
      },
    };
  }

  it.each(["warn", "off"] as const)(
    "serves the last known %s policy when the refresh fails (no 503), and reports it as served stale",
    async (mode) => {
      const source = flakyPolicy(mode);
      const h = harness({ policy: source.read });
      await h.gate.assertMayCall(request());
      source.state.failing = true;
      h.advance(NOTE_CLOSURE_POLICY_STALE_MS);
      await expect(h.gate.assertMayCall(request())).resolves.toBeUndefined();
      expect(h.evaluate).not.toHaveBeenCalled();
      expect(h.onFailure).toHaveBeenCalledTimes(1);
      expect(h.onFailure).toHaveBeenCalledWith(
        expect.objectContaining({ organizationId: ORG, servedStale: true, suppressed: 0 }),
      );
    },
  );

  it("fails closed (503) when the last known mode was block, even a moment after it was read", async () => {
    const source = flakyPolicy("block");
    const h = harness({ policy: source.read, evaluation: async () => clear() });
    await h.gate.assertMayCall(request());
    source.state.failing = true;
    h.advance(1);
    const error = await refusalOf(h.gate.assertMayCall(request()));
    expect(error.code).toBe(NOTE_CLOSURE_UNAVAILABLE_CODE);
    expect(error.statusCode).toBe(503);
    expect(h.onFailure).toHaveBeenCalledWith(expect.objectContaining({ servedStale: false }));
  });

  it("fails closed (503) when nothing is known for the organization, even if another organization is known", async () => {
    const source = flakyPolicy("warn");
    const h = harness({ policy: source.read });
    await h.gate.assertMayCall(request({ organizationId: OTHER_ORG }));
    source.state.failing = true;
    const error = await refusalOf(h.gate.assertMayCall(request()));
    expect(error.code).toBe(NOTE_CLOSURE_UNAVAILABLE_CODE);
    await expect(
      h.gate.assertMayCall(request({ organizationId: OTHER_ORG })),
    ).resolves.toBeUndefined();
  });

  it("stops serving the stale policy once it is older than the bound (503 from there on)", async () => {
    const source = flakyPolicy("warn");
    const h = harness({ policy: source.read });
    await h.gate.assertMayCall(request());
    source.state.failing = true;
    h.advance(NOTE_CLOSURE_POLICY_STALE_MS);
    await expect(h.gate.assertMayCall(request())).resolves.toBeUndefined();
    h.advance(1);
    const error = await refusalOf(h.gate.assertMayCall(request()));
    expect(error.code).toBe(NOTE_CLOSURE_UNAVAILABLE_CODE);
  });

  it("a successful read refreshes the bound, and a recovered store is believed over the stale copy", async () => {
    const source = flakyPolicy("warn");
    const h = harness({ policy: source.read, evaluation: async () => blocked });
    await h.gate.assertMayCall(request());
    h.advance(NOTE_CLOSURE_POLICY_STALE_MS - 1);
    await h.gate.assertMayCall(request()); // a successful read at +59.999s resets the bound
    source.state.failing = true;
    h.advance(NOTE_CLOSURE_POLICY_STALE_MS - 1);
    await expect(h.gate.assertMayCall(request())).resolves.toBeUndefined();
    source.state.failing = false;
    source.state.mode = "block"; // the tenant moved to block while the store was down: the fresh read wins
    const error = await refusalOf(h.gate.assertMayCall(request()));
    expect(error.code).toBe(NOTE_CLOSURE_REQUIRED_CODE);
  });

  it("an allowlisted route still does no IO while the store is down", async () => {
    const source = flakyPolicy("warn");
    const h = harness({ policy: source.read });
    source.state.failing = true;
    await h.gate.assertMayCall(request({ ...ALLOWED_ROUTE, rawUrl: ALLOWED_ROUTE.routeTemplate }));
    expect(h.get).not.toHaveBeenCalled();
  });
});

describe("the gate - failure reporting is throttled per organization", () => {
  const failingPolicy = async (): Promise<{ mode: DocumentationObligationMode }> => {
    throw new Error("connection refused");
  };

  it("reports the first failure, counts the ones inside the interval, and reports the count on the next line", async () => {
    const h = harness({ policy: failingPolicy });
    for (let i = 0; i < 5; i++) await refusalOf(h.gate.assertMayCall(request()));
    expect(h.onFailure).toHaveBeenCalledTimes(1);
    expect(h.onFailure).toHaveBeenLastCalledWith(
      expect.objectContaining({ organizationId: ORG, suppressed: 0 }),
    );
    h.advance(NOTE_CLOSURE_FAILURE_LOG_INTERVAL_MS);
    await refusalOf(h.gate.assertMayCall(request()));
    expect(h.onFailure).toHaveBeenCalledTimes(2);
    expect(h.onFailure).toHaveBeenLastCalledWith(
      expect.objectContaining({ organizationId: ORG, suppressed: 4 }),
    );
  });

  it("throttles per organization: another organization's first failure is still reported", async () => {
    const h = harness({ policy: failingPolicy });
    await refusalOf(h.gate.assertMayCall(request()));
    await refusalOf(h.gate.assertMayCall(request({ organizationId: OTHER_ORG })));
    expect(h.onFailure).toHaveBeenCalledTimes(2);
  });

  it("still refuses every request with 503 while the log line is suppressed", async () => {
    const h = harness({ policy: failingPolicy });
    for (let i = 0; i < 3; i++) {
      const error = await refusalOf(h.gate.assertMayCall(request()));
      expect(error.code).toBe(NOTE_CLOSURE_UNAVAILABLE_CODE);
    }
  });
});

describe("the gate - concurrent evaluations are single-flight", () => {
  it("N concurrent requests for one member share ONE evaluator call, and every one of them is refused", async () => {
    const pending = deferredEvaluation();
    const h = harness({ evaluation: () => pending.promise });
    const calls = Array.from({ length: 25 }, () => refusalOf(h.gate.assertMayCall(request())));
    await vi.waitFor(() => expect(h.evaluate).toHaveBeenCalledTimes(1));
    pending.resolve(blocked);
    const errors = await Promise.all(calls);
    expect(h.evaluate).toHaveBeenCalledTimes(1);
    expect(errors.map((e) => e.code)).toEqual(Array(25).fill(NOTE_CLOSURE_REQUIRED_CODE));
  });

  it("does not reuse a SETTLED result: the next request evaluates again (a block is never cached)", async () => {
    const h = harness({});
    await refusalOf(h.gate.assertMayCall(request()));
    await refusalOf(h.gate.assertMayCall(request()));
    expect(h.evaluate).toHaveBeenCalledTimes(2);
  });

  it("coalesces per organization + member only: another member, or another organization, evaluates on its own", async () => {
    const pending = deferredEvaluation();
    const h = harness({ evaluation: () => pending.promise });
    const calls = [
      request(),
      request({ membershipId: OTHER_MEMBER }),
      request({ organizationId: OTHER_ORG }),
    ].map((r) => refusalOf(h.gate.assertMayCall(r)));
    await vi.waitFor(() => expect(h.evaluate).toHaveBeenCalledTimes(3));
    pending.resolve(blocked);
    await Promise.all(calls);
  });

  it("a failing shared evaluation answers 503 to every waiter and the next request retries it", async () => {
    const pending = deferredEvaluation();
    let first = true;
    const h = harness({
      evaluation: () => {
        if (!first) return Promise.resolve(clear());
        first = false;
        return pending.promise;
      },
    });
    const calls = Array.from({ length: 4 }, () => refusalOf(h.gate.assertMayCall(request())));
    await vi.waitFor(() => expect(h.evaluate).toHaveBeenCalledTimes(1));
    pending.reject(new Error("db down"));
    const errors = await Promise.all(calls);
    expect(errors.map((e) => e.code)).toEqual(Array(4).fill(NOTE_CLOSURE_UNAVAILABLE_CODE));
    await expect(h.gate.assertMayCall(request())).resolves.toBeUndefined();
    expect(h.evaluate).toHaveBeenCalledTimes(2);
  });
});

describe("the gate - assertNotBlocked (the policy + evaluator half, no allowlist)", () => {
  const actor = { organizationId: ORG, userId: USER, membershipId: MEMBER };

  it("refuses a blocked member with the same 403 NOTE_CLOSURE_REQUIRED, whatever route the caller is on (there is no allowlist here)", async () => {
    const h = harness({});
    const error = await refusalOf(h.gate.assertNotBlocked(actor));
    expect(error.code).toBe(NOTE_CLOSURE_REQUIRED_CODE);
    expect(error.statusCode).toBe(403);
  });

  it("resolves for a clear member, and for `off` / `warn` without asking the evaluator", async () => {
    await expect(
      harness({ evaluation: async () => clear() }).gate.assertNotBlocked(actor),
    ).resolves.toBeUndefined();
    for (const mode of ["off", "warn"] as const) {
      const h = harness({ mode });
      await expect(h.gate.assertNotBlocked(actor)).resolves.toBeUndefined();
      expect(h.evaluate).not.toHaveBeenCalled();
    }
  });

  it("fails closed: a policy or evaluator failure is 503 NOTE_CLOSURE_UNAVAILABLE, never a pass", async () => {
    const h = harness({
      evaluation: async () => {
        throw new Error("db down");
      },
    });
    const error = await refusalOf(h.gate.assertNotBlocked(actor));
    expect(error.code).toBe(NOTE_CLOSURE_UNAVAILABLE_CODE);
    expect(error.statusCode).toBe(503);
  });

  it("shares the gate's single-flight, clear cache and budget with assertMayCall (one evaluation for both)", async () => {
    const h = harness({ evaluation: async () => clear() });
    await h.gate.assertNotBlocked(actor);
    await h.gate.assertMayCall(request());
    expect(h.evaluate).toHaveBeenCalledTimes(1);
  });
});

describe("the gate - the evaluation budget (a blocked verdict is never cached, so the START of an evaluation is rate-limited)", () => {
  const BUDGET = NOTE_CLOSURE_EVALUATION_BUDGET_PER_SECOND;

  it("names the budget: 20 evaluator calls a second, Retry-After 1", () => {
    expect(BUDGET).toBe(20);
    expect(NOTE_CLOSURE_BUDGET_RETRY_AFTER_SECONDS).toBe(1);
  });

  it("refuses the call over the budget 429 RATE_LIMITED with a 1s Retry-After hint, and never passes it", async () => {
    const h = harness({});
    for (let i = 0; i < BUDGET; i++) {
      expect((await refusalOf(h.gate.assertMayCall(request()))).code).toBe(
        NOTE_CLOSURE_REQUIRED_CODE,
      );
    }
    const over = await refusalOf(h.gate.assertMayCall(request()));
    expect(over).toBeInstanceOf(RateLimitedError);
    expect(over.code).toBe("RATE_LIMITED");
    expect(over.statusCode).toBe(429);
    expect((over as RateLimitedError).retryAfterSeconds).toBe(1);
    expect(h.evaluate).toHaveBeenCalledTimes(BUDGET); // the refused call never reached the evaluator
    expect(h.onFailure).not.toHaveBeenCalled(); // not a failure of the control, and not a 503
  });

  it("a clear member over the budget is still refused 429, never waved through", async () => {
    const h = harness({ evaluation: async () => ({ ...blocked, verdict: "warn" }) }); // warn is not cached either
    for (let i = 0; i < BUDGET; i++) await h.gate.assertMayCall(request());
    await expect(h.gate.assertMayCall(request())).rejects.toBeInstanceOf(RateLimitedError);
  });

  it("the window is one second: the budget is fresh again after it", async () => {
    const h = harness({});
    for (let i = 0; i < BUDGET; i++) await refusalOf(h.gate.assertMayCall(request()));
    await expect(h.gate.assertMayCall(request())).rejects.toBeInstanceOf(RateLimitedError);
    h.advance(999);
    await expect(h.gate.assertMayCall(request())).rejects.toBeInstanceOf(RateLimitedError);
    h.advance(1);
    expect((await refusalOf(h.gate.assertMayCall(request()))).code).toBe(
      NOTE_CLOSURE_REQUIRED_CODE,
    );
  });

  it("is per organization + member: one member's loop does not spend another's budget", async () => {
    const h = harness({});
    for (let i = 0; i < BUDGET; i++) await refusalOf(h.gate.assertMayCall(request()));
    await expect(h.gate.assertMayCall(request())).rejects.toBeInstanceOf(RateLimitedError);
    expect(
      (await refusalOf(h.gate.assertMayCall(request({ membershipId: OTHER_MEMBER })))).code,
    ).toBe(NOTE_CLOSURE_REQUIRED_CODE);
    expect(
      (await refusalOf(h.gate.assertMayCall(request({ organizationId: OTHER_ORG })))).code,
    ).toBe(NOTE_CLOSURE_REQUIRED_CODE);
  });

  it("counts only evaluator calls that are actually STARTED: cache hits and single-flight joiners spend nothing", async () => {
    // joiners: 60 concurrent requests share one call
    const pending = deferredEvaluation();
    const joined = harness({ evaluation: () => pending.promise });
    const calls = Array.from({ length: 60 }, () => refusalOf(joined.gate.assertMayCall(request())));
    await vi.waitFor(() => expect(joined.evaluate).toHaveBeenCalledTimes(1));
    pending.resolve(blocked);
    const codes = (await Promise.all(calls)).map((e) => e.code);
    expect(codes).toEqual(Array(60).fill(NOTE_CLOSURE_REQUIRED_CODE));
    // cache hits: a clear verdict answers 100 requests from the cache, one evaluator call
    const cached = harness({ evaluation: async () => clear() });
    for (let i = 0; i < 100; i++) await cached.gate.assertMayCall(request());
    expect(cached.evaluate).toHaveBeenCalledTimes(1);
  });

  it("is bounded: a full map of live windows tracks no new key, which still gets its verdict (the budget is skipped, never the check)", async () => {
    const h = harness({ evaluation: async () => ({ ...blocked, verdict: "warn" }) });
    for (let i = 0; i < NOTE_CLOSURE_BUDGET_MAX_ENTRIES; i++) {
      await h.gate.assertMayCall(request({ membershipId: `member-${i}` }));
    }
    const overflow = request({ membershipId: "member-overflow" });
    for (let i = 0; i < BUDGET + 5; i++) await h.gate.assertMayCall(overflow); // untracked: no 429, and the evaluator still decides each time
    expect(h.evaluate).toHaveBeenCalledTimes(NOTE_CLOSURE_BUDGET_MAX_ENTRIES + BUDGET + 5);
    h.advance(1_000); // the windows expire and the map can track again
    for (let i = 0; i < BUDGET; i++) await h.gate.assertMayCall(overflow);
    await expect(h.gate.assertMayCall(overflow)).rejects.toBeInstanceOf(RateLimitedError);
  });
});

describe("the gate - a hung evaluation cannot poison a member (deadline)", () => {
  function fakeTimers() {
    const scheduled: { callback: () => void; ms: number; cleared: boolean }[] = [];
    return {
      scheduled,
      timers: {
        set: (callback: () => void, ms: number) => {
          const entry = { callback, ms, cleared: false };
          scheduled.push(entry);
          return entry;
        },
        clear: (handle: unknown) => {
          (handle as { cleared: boolean }).cleared = true;
        },
      },
    };
  }

  it("names the deadline as five seconds", () => {
    expect(NOTE_CLOSURE_EVALUATION_TIMEOUT_MS).toBe(5_000);
  });

  it("a hung evaluator answers 503 NOTE_CLOSURE_UNAVAILABLE when the deadline fires, and frees the key so the next request evaluates afresh", async () => {
    const { scheduled, timers } = fakeTimers();
    const never = deferredEvaluation();
    let calls = 0;
    const h = harness({
      timers,
      evaluation: () => {
        calls += 1;
        return calls === 1 ? never.promise : Promise.resolve(clear());
      },
    });
    const hung = refusalOf(h.gate.assertMayCall(request()));
    await vi.waitFor(() => expect(scheduled).toHaveLength(1));
    expect(scheduled[0]?.ms).toBe(NOTE_CLOSURE_EVALUATION_TIMEOUT_MS);
    scheduled[0]?.callback(); // the deadline fires
    const error = await hung;
    expect(error.code).toBe(NOTE_CLOSURE_UNAVAILABLE_CODE);
    expect(error.statusCode).toBe(503);
    // not poisoned: the next request starts a NEW evaluation instead of joining the hung one
    await expect(h.gate.assertMayCall(request())).resolves.toBeUndefined();
    expect(h.evaluate).toHaveBeenCalledTimes(2);
  });

  it("a joiner of a hung call gets the same 503 when the deadline fires", async () => {
    const { scheduled, timers } = fakeTimers();
    const never = deferredEvaluation();
    const h = harness({ timers, evaluation: () => never.promise });
    const first = refusalOf(h.gate.assertMayCall(request()));
    await vi.waitFor(() => expect(scheduled).toHaveLength(1));
    const joiner = refusalOf(h.gate.assertMayCall(request()));
    // let the joiner finish its (async) policy read and join the running call before the deadline fires
    await vi.waitFor(() => expect(h.get).toHaveBeenCalledTimes(2));
    await new Promise((resolve) => setTimeout(resolve, 0));
    scheduled[0]?.callback();
    expect((await Promise.all([first, joiner])).map((e) => e.code)).toEqual([
      NOTE_CLOSURE_UNAVAILABLE_CODE,
      NOTE_CLOSURE_UNAVAILABLE_CODE,
    ]);
    expect(h.evaluate).toHaveBeenCalledTimes(1);
  });

  it("clears the timer when the evaluation settles, answer or failure, so no timer outlives the call", async () => {
    const { scheduled, timers } = fakeTimers();
    const h = harness({ timers });
    await refusalOf(h.gate.assertMayCall(request())); // resolves blocked
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]?.cleared).toBe(true);
    const failing = fakeTimers();
    const f = harness({
      timers: failing.timers,
      evaluation: async () => {
        throw new Error("db down");
      },
    });
    await refusalOf(f.gate.assertMayCall(request()));
    expect(failing.scheduled[0]?.cleared).toBe(true);
  });

  it("a late answer from a call that already timed out is ignored (no throw, no effect on the next request)", async () => {
    const { scheduled, timers } = fakeTimers();
    const slow = deferredEvaluation();
    let calls = 0;
    const h = harness({
      timers,
      evaluation: () => {
        calls += 1;
        return calls === 1 ? slow.promise : Promise.resolve(clear());
      },
    });
    const hung = refusalOf(h.gate.assertMayCall(request()));
    await vi.waitFor(() => expect(scheduled).toHaveLength(1));
    scheduled[0]?.callback();
    await hung;
    slow.resolve(blocked); // arrives too late
    await expect(h.gate.assertMayCall(request())).resolves.toBeUndefined();
  });
});

describe("the gate - refusals leave evidence that the control enforces (throttled, organization id and count only)", () => {
  it("reports the first refusal at once and batches the rest into the next report after the interval", async () => {
    const h = harness({});
    for (let i = 0; i < 5; i++) await refusalOf(h.gate.assertMayCall(request()));
    expect(h.onRefusal).toHaveBeenCalledTimes(1);
    expect(h.onRefusal).toHaveBeenLastCalledWith({ organizationId: ORG, refused: 1 });
    h.advance(NOTE_CLOSURE_REFUSAL_LOG_INTERVAL_MS);
    await refusalOf(h.gate.assertMayCall(request()));
    expect(h.onRefusal).toHaveBeenCalledTimes(2);
    expect(h.onRefusal).toHaveBeenLastCalledWith({ organizationId: ORG, refused: 5 }); // the 4 held back + this one
  });

  it("carries nothing but the organization id and the count: no member, no note, no patient, no route", async () => {
    const h = harness({});
    await refusalOf(h.gate.assertMayCall(request()));
    const [report] = h.onRefusal.mock.calls[0] ?? [];
    expect(Object.keys(report).sort()).toEqual(["organizationId", "refused"]);
    expect(JSON.stringify(report)).not.toContain(MEMBER);
    expect(JSON.stringify(report)).not.toContain(ENCOUNTER);
  });

  it("throttles per organization", async () => {
    const h = harness({});
    await refusalOf(h.gate.assertMayCall(request()));
    await refusalOf(h.gate.assertMayCall(request({ organizationId: OTHER_ORG })));
    expect(h.onRefusal).toHaveBeenCalledTimes(2);
  });

  it("reports only REFUSALS: a pass, an allowlisted route, a 503 and a 429 are not counted", async () => {
    const pass = harness({ evaluation: async () => clear() });
    await pass.gate.assertMayCall(request());
    await pass.gate.assertMayCall(
      request({ ...ALLOWED_ROUTE, rawUrl: ALLOWED_ROUTE.routeTemplate }),
    );
    expect(pass.onRefusal).not.toHaveBeenCalled();
    const down = harness({
      evaluation: async () => {
        throw new Error("db down");
      },
    });
    await refusalOf(down.gate.assertMayCall(request()));
    expect(down.onRefusal).not.toHaveBeenCalled();
  });
});

describe("the gate - the policy remembered for a failed refresh is the one whose read STARTED latest", () => {
  it("an older read that resolves late never overwrites a newer one", async () => {
    // read 1 starts first and resolves LAST with `block`; read 2 starts later and resolves first with `warn`
    const resolvers: ((mode: DocumentationObligationMode) => void)[] = [];
    let failing = false;
    const h = harness({
      policy: () => {
        if (failing) return Promise.reject(new Error("policy store down"));
        return new Promise<{ mode: DocumentationObligationMode }>((resolve) => {
          resolvers.push((mode) => resolve({ mode }));
        });
      },
    });
    const first = h.gate.assertMayCall(request());
    await vi.waitFor(() => expect(resolvers).toHaveLength(1));
    h.advance(1_000);
    const second = h.gate.assertMayCall(request({ membershipId: OTHER_MEMBER }));
    await vi.waitFor(() => expect(resolvers).toHaveLength(2));
    resolvers[1]?.("warn"); // the newer read resolves first
    await second;
    resolvers[0]?.("block"); // the older read resolves late
    await first.catch(() => undefined);
    failing = true;
    h.advance(1_000);
    // the store is down: the remembered policy must be the NEWER `warn` (served), not the older `block` (which would fail closed)
    await expect(
      h.gate.assertMayCall(request({ membershipId: OTHER_MEMBER })),
    ).resolves.toBeUndefined();
  });

  it("the stale bound plus the shared cache's 5s lag is the 60s the ADR states", () => {
    expect(NOTE_CLOSURE_POLICY_STALE_MS).toBe(55_000);
    expect(NOTE_CLOSURE_POLICY_STALE_MS + CLOSURE_POLICY_CACHE_TTL_MS).toBe(60_000);
  });
});
