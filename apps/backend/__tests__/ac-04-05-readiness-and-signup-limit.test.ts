// apps/backend/__tests__/ac-04-05-readiness-and-signup-limit.test.ts
//
// AC-04 — `/ready` advertised `minio` as a checked dependency (`routes/health.ts` types it into
// `ReadinessChecks` and folds it into `allOk`) while `buildReadinessProbe` hard-coded it "ok", so
// the probe stayed green through a total object-storage outage. DR/BCP §6.3's storage-failover
// detection reads exactly this signal.
//
// AC-05 — two independent gaps on the credential surface:
//   • SECURITY_HARDENING §22.1's 5/IP/hour on public signup: the route always composed its
//     `requireUnderRateLimit` preHandler, and the composition root never injected a limiter, so
//     `createAllowAllRateLimiter()` stood and the budget was unlimited.
//   • §5.3.1's per-username / per-IP FAILED-attempt budgets on login: absent entirely. The global
//     SD-055 tier does reach /api/auth/* (no path exemption, unlike CSRF), but it counts ALL
//     requests by IP — nothing bounded guesses against one named account.
import {
  CREDENTIAL_THROTTLE_POLICY,
  CredentialThrottleError,
  createCredentialThrottle,
  createInMemoryFailedLoginStore,
  credentialKey,
  isGuardedSignInPath,
  outcomeOfStatus,
  registerIdentityAuth,
  usernameFromBody,
} from "@wardenx/auth";
import { describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import {
  createBudgetedRateLimiter,
  createInMemoryRateLimitStore,
} from "../src/bootstrap/plugins/rate-limit-store";
import { buildReadinessProbe } from "../src/bootstrap/readiness-probe";

describe("AC-04 — /ready reaches the object store it advertises", () => {
  it("reports minio 'ok' when no object store is configured (optional infra)", async () => {
    const probe = buildReadinessProbe({});
    expect((await probe()).minio).toBe("ok");
  });

  it("reports minio 'fail' when a CONFIGURED store is unreachable — and /ready 503s", async () => {
    const probe = buildReadinessProbe({
      pingObjectStore: async () => {
        throw new Error("connect ECONNREFUSED 10.0.0.5:9000");
      },
      log: () => {},
    });
    expect((await probe()).minio).toBe("fail");

    // The whole point: the advertised dependency now moves `/ready` off 200.
    const app = buildServer({ readinessProbe: probe, security: { rateLimitEnabled: false } });
    const res = await app.inject({ method: "GET", url: "/ready" });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ status: "not_ready", checks: { minio: "fail" } });
    await app.close();
  });

  it("a HUNG object store fails rather than hanging /ready", async () => {
    const probe = buildReadinessProbe({
      pingObjectStore: () => new Promise(() => {}), // never settles
      timeoutMs: 25,
      log: () => {},
    });
    expect((await probe()).minio).toBe("fail");
  });

  it("a reachable store keeps /ready green", async () => {
    const probe = buildReadinessProbe({ pingObjectStore: async () => {} });
    const app = buildServer({ readinessProbe: probe, security: { rateLimitEnabled: false } });
    const res = await app.inject({ method: "GET", url: "/ready" });
    expect(res.statusCode).toBe(200);
    expect(res.json().checks.minio).toBe("ok");
    await app.close();
  });
});

describe("AC-05 — the §22.1 public-signup budget is a real limiter", () => {
  const limiterFor = (nowRef: { t: number }) =>
    createBudgetedRateLimiter(createInMemoryRateLimitStore(() => nowRef.t), {
      limit: 5,
      windowMs: 3_600_000,
      keyPrefix: "m34:signup:ip",
    });

  it("allows exactly 5 per IP per hour, then refuses with a Retry-After", async () => {
    const nowRef = { t: 0 };
    const limiter = limiterFor(nowRef);
    for (let i = 0; i < 5; i++) {
      expect((await limiter.consume("203.0.113.7")).allowed).toBe(true);
    }
    const sixth = await limiter.consume("203.0.113.7");
    expect(sixth.allowed).toBe(false);
    expect(sixth.retryAfterSeconds).toBe(3600);
  });

  it("budgets are PER IP — one exhausted caller does not block another", async () => {
    const nowRef = { t: 0 };
    const limiter = limiterFor(nowRef);
    for (let i = 0; i < 6; i++) await limiter.consume("203.0.113.7");
    expect((await limiter.consume("198.51.100.9")).allowed).toBe(true);
  });

  it("the window is fixed — the budget returns after it elapses", async () => {
    const nowRef = { t: 0 };
    const limiter = limiterFor(nowRef);
    for (let i = 0; i < 6; i++) await limiter.consume("203.0.113.7");
    expect((await limiter.consume("203.0.113.7")).allowed).toBe(false);
    nowRef.t += 3_600_001;
    expect((await limiter.consume("203.0.113.7")).allowed).toBe(true);
  });

  it("fails OPEN when the counter store is down (availability control, not an authz gate)", async () => {
    const limiter = createBudgetedRateLimiter(
      {
        increment: async () => {
          throw new Error("valkey unreachable");
        },
      },
      { limit: 5, windowMs: 3_600_000, keyPrefix: "m34:signup:ip" },
    );
    expect((await limiter.consume("203.0.113.7")).allowed).toBe(true);
  });
});

describe("AC-05 — the §5.3.1 credential throttle", () => {
  const USER = "clinician@example.test";
  const IP = "203.0.113.7";

  function throttleAt(nowRef: { t: number }) {
    return createCredentialThrottle(createInMemoryFailedLoginStore(() => nowRef.t));
  }

  it("refuses after the per-username budget is spent, BEFORE the credential is checked", async () => {
    const nowRef = { t: 0 };
    const throttle = throttleAt(nowRef);
    for (let i = 0; i < CREDENTIAL_THROTTLE_POLICY.perUsernameLimit; i++) {
      await throttle.assertUnderBudget({ username: USER, ip: IP });
      await throttle.record({ username: USER, ip: IP, outcome: "failure" });
    }
    await expect(throttle.assertUnderBudget({ username: USER, ip: IP })).rejects.toBeInstanceOf(
      CredentialThrottleError,
    );
  });

  it("is PER USERNAME — a spent account does not lock out a different one from the same IP", async () => {
    const nowRef = { t: 0 };
    const throttle = throttleAt(nowRef);
    for (let i = 0; i < CREDENTIAL_THROTTLE_POLICY.perUsernameLimit; i++) {
      await throttle.record({ username: USER, ip: IP, outcome: "failure" });
    }
    await expect(
      throttle.assertUnderBudget({ username: "other@example.test", ip: IP }),
    ).resolves.toBeUndefined();
  });

  it("the per-IP budget catches a spray across many usernames", async () => {
    const nowRef = { t: 0 };
    const throttle = throttleAt(nowRef);
    for (let i = 0; i < CREDENTIAL_THROTTLE_POLICY.perIpLimit; i++) {
      await throttle.record({ username: `victim${i}@example.test`, ip: IP, outcome: "failure" });
    }
    // Every individual username is well under its own budget; the IP is not.
    await expect(
      throttle.assertUnderBudget({ username: "victim0@example.test", ip: IP }),
    ).rejects.toBeInstanceOf(CredentialThrottleError);
  });

  it("a successful sign-in clears the USERNAME budget but not the IP's", async () => {
    const nowRef = { t: 0 };
    const throttle = throttleAt(nowRef);
    for (let i = 0; i < CREDENTIAL_THROTTLE_POLICY.perUsernameLimit - 1; i++) {
      await throttle.record({ username: USER, ip: IP, outcome: "failure" });
    }
    await throttle.record({ username: USER, ip: IP, outcome: "success" });
    // Cleared: the user can spend the whole budget again after typing it right once.
    for (let i = 0; i < CREDENTIAL_THROTTLE_POLICY.perUsernameLimit - 1; i++) {
      await throttle.assertUnderBudget({ username: USER, ip: IP });
      await throttle.record({ username: USER, ip: IP, outcome: "failure" });
    }
    await expect(throttle.assertUnderBudget({ username: USER, ip: IP })).resolves.toBeUndefined();
  });

  it("an IGNORED outcome neither spends a budget nor clears one", async () => {
    const nowRef = { t: 0 };
    const throttle = throttleAt(nowRef);
    for (let i = 0; i < CREDENTIAL_THROTTLE_POLICY.perUsernameLimit; i++) {
      await throttle.record({ username: USER, ip: IP, outcome: "failure" });
    }
    // A malformed request must NOT wipe a spent budget (that would be a one-request bypass)...
    await throttle.record({ username: USER, ip: IP, outcome: "ignored" });
    await expect(throttle.assertUnderBudget({ username: USER, ip: IP })).rejects.toBeInstanceOf(
      CredentialThrottleError,
    );
    // ...and it must not spend one either (that would let a client lock an account out with no
    // password attempt at all).
    const fresh = throttleAt({ t: 0 });
    for (let i = 0; i < CREDENTIAL_THROTTLE_POLICY.perUsernameLimit * 3; i++) {
      await fresh.record({ username: "bystander@example.test", ip: IP, outcome: "ignored" });
    }
    await expect(
      fresh.assertUnderBudget({ username: "bystander@example.test", ip: IP }),
    ).resolves.toBeUndefined();
  });

  it("the window is fixed — the budget returns after it elapses", async () => {
    const nowRef = { t: 0 };
    const throttle = throttleAt(nowRef);
    for (let i = 0; i < CREDENTIAL_THROTTLE_POLICY.perUsernameLimit; i++) {
      await throttle.record({ username: USER, ip: IP, outcome: "failure" });
    }
    await expect(throttle.assertUnderBudget({ username: USER, ip: IP })).rejects.toThrow();
    nowRef.t += CREDENTIAL_THROTTLE_POLICY.windowMs + 1;
    await expect(throttle.assertUnderBudget({ username: USER, ip: IP })).resolves.toBeUndefined();
  });

  it("fails OPEN on a store outage — a Valkey blip cannot lock everyone out of the product", async () => {
    const throttle = createCredentialThrottle({
      recordFailure: async () => {
        throw new Error("down");
      },
      failureCount: async () => {
        throw new Error("down");
      },
      clear: async () => {
        throw new Error("down");
      },
    });
    await expect(throttle.assertUnderBudget({ username: USER, ip: IP })).resolves.toBeUndefined();
    await expect(
      throttle.record({ username: USER, ip: IP, outcome: "failure" }),
    ).resolves.toBeUndefined();
  });

  it("stores no address — the key is a hash, and equal inputs normalize together", () => {
    const key = credentialKey(USER);
    expect(key).not.toContain("@");
    expect(key).not.toContain("clinician");
    expect(credentialKey("  CLINICIAN@Example.TEST ")).toBe(key);
  });

  it("classifies auth responses into three outcomes, not two", () => {
    expect(outcomeOfStatus(200)).toBe("success");
    expect(outcomeOfStatus(401)).toBe("failure");
    expect(outcomeOfStatus(403)).toBe("failure");
    expect(outcomeOfStatus(400)).toBe("ignored");
    expect(outcomeOfStatus(500)).toBe("ignored");
  });

  it("guards the credential paths only", () => {
    expect(isGuardedSignInPath("/api/auth/sign-in/email", "/api/auth")).toBe(true);
    expect(isGuardedSignInPath("/api/auth/sign-in/email?redirect=/", "/api/auth")).toBe(true);
    expect(isGuardedSignInPath("/api/auth/sign-out", "/api/auth")).toBe(false);
    expect(isGuardedSignInPath("/api/auth/get-session", "/api/auth")).toBe(false);
  });

  it("reads the username from either shape and tolerates a bodyless request", () => {
    expect(usernameFromBody({ email: "a@b.test" })).toBe("a@b.test");
    expect(usernameFromBody({ username: "alice" })).toBe("alice");
    expect(usernameFromBody({ email: "   " })).toBeNull();
    expect(usernameFromBody(null)).toBeNull();
    expect(usernameFromBody("nope")).toBeNull();
  });
});

describe("AC-05 — the throttle bound to the real /api/auth mount", () => {
  /** A Better-Auth stand-in: 401 unless the password is right (the bridge is what's under test). */
  function mountWith(nowRef: { t: number }) {
    const app = buildServer({ security: { rateLimitEnabled: false } });
    const seen: string[] = [];
    registerIdentityAuth(
      app,
      {
        handler: async (request: Request) => {
          const body = (await request.json()) as { email?: string; password?: string };
          seen.push(body.email ?? "");
          return body.password === "correct-horse-battery"
            ? new Response(JSON.stringify({ ok: true }), { status: 200 })
            : new Response(JSON.stringify({ message: "invalid" }), { status: 401 });
        },
      },
      {
        credentialThrottle: createCredentialThrottle(
          createInMemoryFailedLoginStore(() => nowRef.t),
        ),
      },
    );
    return { app, seen };
  }

  const signIn = (app: ReturnType<typeof buildServer>, email: string, password: string) =>
    app.inject({
      method: "POST",
      url: "/api/auth/sign-in/email",
      headers: { "content-type": "application/json" },
      payload: { email, password },
    });

  it("locks a username out after the budget, in the CANONICAL error envelope with Retry-After", async () => {
    const nowRef = { t: 0 };
    const { app, seen } = mountWith(nowRef);
    for (let i = 0; i < CREDENTIAL_THROTTLE_POLICY.perUsernameLimit; i++) {
      expect((await signIn(app, "victim@example.test", "wrong")).statusCode).toBe(401);
    }
    const blocked = await signIn(app, "victim@example.test", "wrong");
    expect(blocked.statusCode).toBe(429);
    // GAP-090: `{ error: { code, ... } }`, not a hand-rolled flat `{ error: "..." }`.
    expect(blocked.json().error.code).toBe("TOO_MANY_FAILED_ATTEMPTS");
    expect(blocked.headers["retry-after"]).toBe(String(CREDENTIAL_THROTTLE_POLICY.windowMs / 1000));
    // The refusal happened BEFORE the credential was checked — the handler never saw the 6th.
    expect(seen).toHaveLength(CREDENTIAL_THROTTLE_POLICY.perUsernameLimit);
    await app.close();
  });

  it("the CORRECT password still works while the budget is unspent, and clears it", async () => {
    const nowRef = { t: 0 };
    const { app } = mountWith(nowRef);
    for (let i = 0; i < CREDENTIAL_THROTTLE_POLICY.perUsernameLimit - 1; i++) {
      await signIn(app, "clinician@example.test", "wrong");
    }
    expect(
      (await signIn(app, "clinician@example.test", "correct-horse-battery")).statusCode,
    ).toBe(200);
    // Budget cleared by the success: a fresh run of failures is available again.
    for (let i = 0; i < CREDENTIAL_THROTTLE_POLICY.perUsernameLimit - 1; i++) {
      expect((await signIn(app, "clinician@example.test", "wrong")).statusCode).toBe(401);
    }
    await app.close();
  });

  it("does not throttle non-credential auth paths", async () => {
    const nowRef = { t: 0 };
    const { app } = mountWith(nowRef);
    for (let i = 0; i < CREDENTIAL_THROTTLE_POLICY.perIpLimit + 5; i++) {
      const res = await app.inject({ method: "GET", url: "/api/auth/get-session" });
      expect(res.statusCode).not.toBe(429);
    }
    await app.close();
  });
});
