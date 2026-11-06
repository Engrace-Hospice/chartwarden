// WP 2.14 / ADR-0058 P2 — the per-route rate limit preHandler, proved on a real Fastify instance
// over a fake store (the Valkey path is proved in rate-limit-store.live.test.ts).
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { applyErrorHandler } from "../error-handler";
import { type RateLimitStore, createInMemoryRateLimitStore } from "../rate-limit-store";
import {
  GLOBAL_SEARCH_ROUTE_RATE_LIMIT,
  type RouteRateLimit,
  createRouteRateLimit,
} from "../route-rate-limit";

const ORG_A = "00000000-0000-0000-0000-00000000000a";
const ORG_B = "00000000-0000-0000-0000-00000000000b";

const LIMIT: RouteRateLimit = { perUser: 3, perOrg: 5, windowMs: 60_000, failMode: "closed" };

function buildApp(
  limit: RouteRateLimit,
  store: RateLimitStore,
  onStoreError: (err: unknown) => void = () => {},
) {
  const app = Fastify();
  applyErrorHandler(app);
  app.addHook("onRequest", async (request) => {
    const org = request.headers["x-test-org"];
    const user = request.headers["x-test-user"];
    (request as { context?: unknown }).context = {
      correlationId: "cid-test",
      ...(typeof org === "string" ? { organizationId: org } : {}),
      ...(typeof user === "string" ? { userId: user } : {}),
    };
  });
  const limited = createRouteRateLimit({ store, limit, keyPrefix: "test", onStoreError });
  app.get("/limited", { preHandler: [limited] }, async () => ({ ok: true }));
  app.get("/free", async () => ({ ok: true }));
  return app;
}

const hit = (app: ReturnType<typeof buildApp>, org: string, user: string, url = "/limited") =>
  app.inject({ method: "GET", url, headers: { "x-test-org": org, "x-test-user": user } });

describe("createRouteRateLimit scopeOf (a platform operator acts on a tenant: count per TARGET org)", () => {
  const PLATFORM_ORG = "00000000-0000-0000-0000-0000000000ff";
  function buildScopedApp(store: RateLimitStore) {
    const app = Fastify();
    applyErrorHandler(app);
    app.addHook("onRequest", async (request) => {
      const user = request.headers["x-test-user"];
      (request as { context?: unknown }).context = {
        correlationId: "cid-test",
        organizationId: PLATFORM_ORG, // every operator belongs to the platform org
        ...(typeof user === "string" ? { userId: user } : {}),
      };
    });
    const limited = createRouteRateLimit({
      store,
      limit: LIMIT,
      keyPrefix: "scoped",
      scopeOf: (request) => (request.params as { orgSlug?: string }).orgSlug,
    });
    app.post("/tenants/:orgSlug/verify", { preHandler: [limited] }, async () => ({ ok: true }));
    return app;
  }
  const verify = (app: ReturnType<typeof buildScopedApp>, slug: string, user: string) =>
    app.inject({
      method: "POST",
      url: `/tenants/${slug}/verify`,
      headers: { "x-test-user": user },
    });

  it("one tenant's budget is its own: exhausting it by several operators does not block another tenant", async () => {
    const app = buildScopedApp(createInMemoryRateLimitStore());
    for (let i = 0; i < 5; i++)
      expect((await verify(app, "tenant-a", `op${i}`)).statusCode).toBe(200);
    expect((await verify(app, "tenant-a", "op9")).statusCode).toBe(429); // tenant-a: 5/5 across five operators
    expect((await verify(app, "tenant-b", "op9")).statusCode).toBe(200); // tenant-b is untouched
  });

  it("the same operator has a budget per tenant, not one across every tenant", async () => {
    const app = buildScopedApp(createInMemoryRateLimitStore());
    for (let i = 0; i < 3; i++) expect((await verify(app, "tenant-a", "op1")).statusCode).toBe(200);
    expect((await verify(app, "tenant-a", "op1")).statusCode).toBe(429);
    expect((await verify(app, "tenant-b", "op1")).statusCode).toBe(200);
  });

  it("keys name the target tenant, never the operator's own org", async () => {
    const seen: string[] = [];
    const store: RateLimitStore = {
      increment: async (key) => {
        seen.push(key);
        return 1;
      },
    };
    await verify(buildScopedApp(store), "tenant-a", "op1");
    expect(seen).toEqual(["scoped:user:tenant-a:op1", "scoped:org:tenant-a"]);
  });
});

describe("createRouteRateLimit", () => {
  it("allows exactly perUser requests, then 429s with the envelope and Retry-After", async () => {
    const app = buildApp(LIMIT, createInMemoryRateLimitStore());
    for (let i = 0; i < 3; i++) expect((await hit(app, ORG_A, "u1")).statusCode).toBe(200);
    const blocked = await hit(app, ORG_A, "u1");
    expect(blocked.statusCode).toBe(429);
    expect(blocked.headers["retry-after"]).toBe("60");
    expect(blocked.json()).toMatchObject({
      error: { code: "RATE_LIMITED", correlationId: "cid-test" },
    });
  });

  it("resets after the window", async () => {
    let clock = 0;
    const app = buildApp(
      LIMIT,
      createInMemoryRateLimitStore(() => clock),
    );
    for (let i = 0; i < 4; i++) await hit(app, ORG_A, "u1");
    clock += 60_001;
    expect((await hit(app, ORG_A, "u1")).statusCode).toBe(200);
  });

  it("per-user and per-org buckets are independent: a second user is fine until the org cap", async () => {
    const app = buildApp(LIMIT, createInMemoryRateLimitStore());
    for (let i = 0; i < 3; i++) await hit(app, ORG_A, "u1"); // org used 3/5
    for (let i = 0; i < 4; i++) await hit(app, ORG_A, "u1"); // rejected by user cap
    expect((await hit(app, ORG_A, "u2")).statusCode).toBe(200); // org 4/5: rejected hits did not drain it
    expect((await hit(app, ORG_A, "u2")).statusCode).toBe(200); // org 5/5
    const orgBlocked = await hit(app, ORG_A, "u3");
    expect(orgBlocked.statusCode).toBe(429);
    expect(orgBlocked.headers["retry-after"]).toBe("60");
  });

  it("two orgs never share buckets; one org exhausting its cap does not affect another", async () => {
    const app = buildApp(LIMIT, createInMemoryRateLimitStore());
    for (let i = 0; i < 5; i++) await hit(app, ORG_A, `a${i}`);
    expect((await hit(app, ORG_A, "a9")).statusCode).toBe(429);
    expect((await hit(app, ORG_B, "b1")).statusCode).toBe(200);
  });

  it("the same user id under another org is a different bucket", async () => {
    const app = buildApp(LIMIT, createInMemoryRateLimitStore());
    for (let i = 0; i < 3; i++) await hit(app, ORG_A, "u1");
    expect((await hit(app, ORG_A, "u1")).statusCode).toBe(429);
    expect((await hit(app, ORG_B, "u1")).statusCode).toBe(200);
  });

  it("keys carry ids only, domain-separated per scope", async () => {
    const keys: string[] = [];
    const app = buildApp(LIMIT, {
      async increment(key) {
        keys.push(key);
        return 1;
      },
    });
    await hit(app, ORG_A, "u1");
    expect(keys).toEqual([`test:user:${ORG_A}:u1`, `test:org:${ORG_A}`]);
  });

  const throwing: RateLimitStore = {
    async increment() {
      throw new Error("ECONNREFUSED");
    },
  };

  it("failMode closed: a store outage is a 503 DEGRADED envelope, never an allow", async () => {
    const errors: unknown[] = [];
    const app = buildApp(LIMIT, throwing, (e) => errors.push(e));
    const res = await hit(app, ORG_A, "u1");
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ error: { code: "DEGRADED", correlationId: "cid-test" } });
    expect(errors).toHaveLength(1);
  });

  it("failMode closed: a non-numeric store count is treated as an outage", async () => {
    const app = buildApp(LIMIT, { increment: async () => Number.NaN });
    expect((await hit(app, ORG_A, "u1")).statusCode).toBe(503);
  });

  it("failMode closed: a zero or negative store count is treated as an outage", async () => {
    for (const bad of [0, -1, 1.5]) {
      const app = buildApp(LIMIT, { increment: async () => bad });
      expect((await hit(app, ORG_A, "u1")).statusCode).toBe(503);
    }
  });

  it("failMode closed: a partial outage (user counter ok, org counter throws) is a 503", async () => {
    let calls = 0;
    const app = buildApp(LIMIT, {
      increment: async () => {
        if (++calls === 2) throw new Error("ECONNRESET");
        return 1;
      },
    });
    expect((await hit(app, ORG_A, "u1")).statusCode).toBe(503);
  });

  it("failMode open: a store outage allows the request and reports it", async () => {
    const errors: unknown[] = [];
    const app = buildApp({ ...LIMIT, failMode: "open" }, throwing, (e) => errors.push(e));
    expect((await hit(app, ORG_A, "u1")).statusCode).toBe(200);
    expect(errors).toHaveLength(1);
  });

  it("an unauthenticated request is refused (401), never silently unlimited", async () => {
    const app = buildApp(LIMIT, createInMemoryRateLimitStore());
    const res = await app.inject({ method: "GET", url: "/limited" });
    expect(res.statusCode).toBe(401);
  });

  it("does not touch routes that do not opt in", async () => {
    const app = buildApp(LIMIT, throwing);
    expect((await hit(app, ORG_A, "u1", "/free")).statusCode).toBe(200);
  });

  it("rejects an invalid configuration at registration time", () => {
    const store = createInMemoryRateLimitStore();
    for (const bad of [
      { perUser: 0 },
      { perOrg: 1.5 },
      { windowMs: -1 },
      { failMode: "x" as never },
    ]) {
      expect(() =>
        createRouteRateLimit({ store, limit: { ...LIMIT, ...bad }, keyPrefix: "t" }),
      ).toThrow();
    }
  });

  it("rejects an empty keyPrefix", () => {
    expect(() =>
      createRouteRateLimit({ store: createInMemoryRateLimitStore(), limit: LIMIT, keyPrefix: "" }),
    ).toThrow();
  });

  it("exposes the ADR-0058 P2 decided defaults as named constants", () => {
    expect(GLOBAL_SEARCH_ROUTE_RATE_LIMIT).toEqual({
      perUser: 30,
      perOrg: 300,
      windowMs: 60_000,
      failMode: "closed",
    });
  });
});
