// WX-PR-017 — no test previously existed for `applySecurityBaseline` at all (a genuine coverage
// gap, not a refactor artifact). Covers the SD-055 tiers, the CORS allow-list, and — the reason for
// this pass — that the limiter reads through an INJECTABLE `RateLimitStore` rather than always
// owning its own `Map`, so a Redis-backed store enforces the same tiers cluster-wide (proved against
// a real store in rate-limit-store.live.test.ts).
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { applyErrorHandler } from "../error-handler";
import { applySecurityBaseline } from "../security";

function buildApp(opts: Parameters<typeof applySecurityBaseline>[1] = {}) {
  const app = Fastify();
  applyErrorHandler(app);
  app.addHook("onRequest", async (request) => {
    // A pre-org but signed-in session (mid sign-in → select-organization) has userId set and
    // organizationId empty — simulated here via a test-only header since app.inject has no other
    // hook into per-request context.
    const testUserId = request.headers["x-test-user-id"];
    (
      request as { context?: { organizationId?: string; userId?: string; correlationId?: string } }
    ).context = {
      correlationId: "cid-test",
      ...(typeof testUserId === "string" ? { userId: testUserId } : {}),
    };
  });
  applySecurityBaseline(app, opts);
  app.get("/ping", async () => ({ ok: true }));
  return app;
}

describe("applySecurityBaseline — rate limit tiers (SD-055)", () => {
  it("allows exactly the unauthenticated tier, then 429s with Retry-After", async () => {
    const app = buildApp({
      rateLimitTiers: { unauthenticatedPerMinute: 3, authenticatedPerMinute: 30 },
    });
    for (let i = 0; i < 3; i++) {
      const res = await app.inject({ method: "GET", url: "/ping", remoteAddress: "10.0.0.1" });
      expect(res.statusCode).toBe(200);
    }
    const blocked = await app.inject({ method: "GET", url: "/ping", remoteAddress: "10.0.0.1" });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.headers["retry-after"]).toBeDefined();
    expect(blocked.json()).toMatchObject({ error: { code: "RATE_LIMITED" } });
  });

  it("buckets by client ip, so a different caller is unaffected by another's exhausted tier", async () => {
    const app = buildApp({
      rateLimitTiers: { unauthenticatedPerMinute: 1, authenticatedPerMinute: 30 },
    });
    const a1 = await app.inject({ method: "GET", url: "/ping", remoteAddress: "10.0.0.1" });
    const a2 = await app.inject({ method: "GET", url: "/ping", remoteAddress: "10.0.0.1" });
    const b1 = await app.inject({ method: "GET", url: "/ping", remoteAddress: "10.0.0.2" });
    expect(a1.statusCode).toBe(200);
    expect(a2.statusCode).toBe(429);
    expect(b1.statusCode).toBe(200);
  });

  it("resets the window using the injected clock, not wall time", async () => {
    let clock = 0;
    const app = buildApp({
      rateLimitTiers: { unauthenticatedPerMinute: 1, authenticatedPerMinute: 30 },
      now: () => clock,
    });
    const first = await app.inject({ method: "GET", url: "/ping", remoteAddress: "10.0.0.1" });
    const second = await app.inject({ method: "GET", url: "/ping", remoteAddress: "10.0.0.1" });
    clock += 60_001; // past the 60s fixed window
    const third = await app.inject({ method: "GET", url: "/ping", remoteAddress: "10.0.0.1" });
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(429);
    expect(third.statusCode).toBe(200);
  });

  it("rateLimitEnabled: false disables the limiter entirely", async () => {
    const app = buildApp({
      rateLimitTiers: { unauthenticatedPerMinute: 1, authenticatedPerMinute: 30 },
      rateLimitEnabled: false,
    });
    for (let i = 0; i < 5; i++) {
      const res = await app.inject({ method: "GET", url: "/ping", remoteAddress: "10.0.0.1" });
      expect(res.statusCode).toBe(200);
    }
  });

  it("fails OPEN (allows the request) when the store throws, rather than 500ing every request", async () => {
    const app = buildApp({
      rateLimitTiers: { unauthenticatedPerMinute: 1, authenticatedPerMinute: 1 },
      rateLimitStore: {
        async increment() {
          throw new Error("ECONNREFUSED — store unreachable");
        },
      },
    });
    const res = await app.inject({ method: "GET", url: "/ping", remoteAddress: "10.0.0.1" });
    expect(res.statusCode).toBe(200);
  });

  it("WX-PR-018: a signed-in but pre-org session gets the authenticated tier, keyed by user not ip", async () => {
    const calls: Array<{ key: string }> = [];
    const app = buildApp({
      rateLimitTiers: { unauthenticatedPerMinute: 1, authenticatedPerMinute: 100 },
      rateLimitStore: {
        async increment(key) {
          calls.push({ key });
          return 1;
        },
      },
    });
    // Two DIFFERENT pre-org users behind the same NAT ip each still get their own bucket, and
    // neither shares the low unauthenticated tier a truly anonymous caller gets.
    const a = await app.inject({
      method: "GET",
      url: "/ping",
      remoteAddress: "10.0.0.1",
      headers: { "x-test-user-id": "user-a" },
    });
    const b = await app.inject({
      method: "GET",
      url: "/ping",
      remoteAddress: "10.0.0.1",
      headers: { "x-test-user-id": "user-b" },
    });
    expect(a.statusCode).toBe(200);
    expect(b.statusCode).toBe(200);
    expect(calls).toEqual([{ key: "user:user-a" }, { key: "user:user-b" }]);
  });

  it("reads through an injected RateLimitStore instead of the built-in Map", async () => {
    const calls: Array<{ key: string; windowMs: number }> = [];
    const app = buildApp({
      rateLimitTiers: { unauthenticatedPerMinute: 100, authenticatedPerMinute: 100 },
      rateLimitStore: {
        async increment(key, windowMs) {
          calls.push({ key, windowMs });
          return 1;
        },
      },
    });
    await app.inject({ method: "GET", url: "/ping", remoteAddress: "203.0.113.5" });
    expect(calls).toEqual([{ key: "ip:203.0.113.5", windowMs: 60_000 }]);
  });
});

describe("applySecurityBaseline — CORS allow-list (ARCH-025)", () => {
  it("echoes Access-Control-Allow-Origin only for an allow-listed origin", async () => {
    const app = buildApp({ corsAllowOrigins: ["https://app.example.test"] });
    const allowed = await app.inject({
      method: "GET",
      url: "/ping",
      headers: { origin: "https://app.example.test" },
    });
    const denied = await app.inject({
      method: "GET",
      url: "/ping",
      headers: { origin: "https://evil.test" },
    });
    expect(allowed.headers["access-control-allow-origin"]).toBe("https://app.example.test");
    expect(denied.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("answers an OPTIONS preflight with 204 and the CORS headers", async () => {
    const app = buildApp({ corsAllowOrigins: ["https://app.example.test"] });
    const res = await app.inject({
      method: "OPTIONS",
      url: "/ping",
      headers: { origin: "https://app.example.test" },
    });
    expect(res.statusCode).toBe(204);
    expect(res.headers["access-control-allow-methods"]).toContain("POST");
    // GAP-009: the invite page's sign-up carries the invitation token in this header cross-origin.
    expect(res.headers["access-control-allow-headers"]).toContain("x-invite-token");
  });
});

describe("applySecurityBaseline — response headers", () => {
  it("sets the helmet-equivalent headers on every response", async () => {
    const app = buildApp();
    const res = await app.inject({ method: "GET", url: "/ping" });
    expect(res.headers["x-frame-options"]).toBe("DENY");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["content-security-policy"]).toContain("default-src 'self'");
  });
});
