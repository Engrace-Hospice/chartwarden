// ADR-0049 D1/D2/D3 — the tenant-host guard. The host is a consistency signal checked against the session's
// org, never an authorization source: a forged or misrouted Host can only cause a refusal.
import Fastify, { type FastifyInstance } from "fastify";
import { describe, expect, it, vi } from "vitest";
import { applyErrorHandler } from "../plugins/error-handler";
import {
  type TenantHostResolution,
  type TenantHostResolver,
  classifyTenantHost,
  createCachingTenantHostResolver,
  createTenantHostGuard,
  parseTenantBaseDomain,
} from "../tenant-host";

const BASE = "chartwarden.com";
const ORG_SUNRISE = "11111111-1111-1111-1111-111111111111";
const ORG_EAGLE = "22222222-2222-2222-2222-222222222222";

describe("parseTenantBaseDomain", () => {
  it("is null when unset or blank (single-host mode)", () => {
    expect(parseTenantBaseDomain({})).toBeNull();
    expect(parseTenantBaseDomain({ TENANT_BASE_DOMAIN: "  " })).toBeNull();
  });
  it("normalises case and surrounding space", () => {
    expect(parseTenantBaseDomain({ TENANT_BASE_DOMAIN: " ChartWarden.COM " })).toBe(BASE);
  });
  it.each(["https://chartwarden.com", "chartwarden.com/", ".chartwarden.com", "*.chartwarden.com", "localhost", "a_b.com"])(
    "rejects %s",
    (value) => {
      expect(() => parseTenantBaseDomain({ TENANT_BASE_DOMAIN: value })).toThrow(/TENANT_BASE_DOMAIN/);
    },
  );
});

describe("classifyTenantHost", () => {
  it.each([
    ["sunrise.chartwarden.com", { kind: "tenant", label: "sunrise" }],
    ["Sunrise.ChartWarden.com:443", { kind: "tenant", label: "sunrise" }],
    ["sunrise.chartwarden.com.", { kind: "tenant", label: "sunrise" }],
    ["chartwarden.com", { kind: "apex" }],
    ["admin.chartwarden.com", { kind: "reserved" }],
    ["app.chartwarden.com", { kind: "reserved" }],
    ["a.b.chartwarden.com", { kind: "invalid" }],
    ["xn--bcher-kva.chartwarden.com", { kind: "invalid" }],
    ["-x.chartwarden.com", { kind: "invalid" }],
    ["chartwarden.com.evil.test", { kind: "outside" }],
    ["evilchartwarden.com", { kind: "outside" }],
    ["localhost:3000", { kind: "outside" }],
    ["other.chartwarden.cloud", { kind: "outside" }],
    ["", { kind: "outside" }],
  ])("%s", (host, expected) => {
    expect(classifyTenantHost(host, BASE)).toEqual(expected);
  });
});

function resolverOf(table: Record<string, TenantHostResolution>): TenantHostResolver {
  return { resolve: async (label) => table[label] ?? null };
}

const TABLE: Record<string, TenantHostResolution> = {
  sunrise: { organizationId: ORG_SUNRISE, slug: "sunrise", status: "active", viaAlias: false },
  eagle: { organizationId: ORG_EAGLE, slug: "eagle", status: "active", viaAlias: false },
  oldname: { organizationId: ORG_SUNRISE, slug: "sunrise", status: "active", viaAlias: true },
  paused: { organizationId: ORG_EAGLE, slug: "paused", status: "suspended", viaAlias: false },
  gone: { organizationId: ORG_EAGLE, slug: "gone", status: "closed", viaAlias: false },
};

function buildApp(opts: { sessionOrg?: string; resolver?: TenantHostResolver; base?: string | null } = {}): FastifyInstance {
  const app = Fastify();
  applyErrorHandler(app);
  app.decorateRequest("context", null as never);
  app.addHook("onRequest", async (request) => {
    (request as { context: unknown }).context = { attributes: {}, organizationId: opts.sessionOrg };
  });
  const guard = createTenantHostGuard({
    baseDomain: opts.base === undefined ? BASE : opts.base,
    resolver: opts.resolver ?? resolverOf(TABLE),
  });
  if (guard) app.addHook("onRequest", guard);
  app.get("/api/v1/ping", async (request) => ({
    ok: true,
    hostOrg: (request as unknown as { context: { attributes: Record<string, unknown> } }).context.attributes.tenantHostOrgId ?? null,
  }));
  return app;
}

const get = (app: FastifyInstance, host: string, url = "/api/v1/ping") => app.inject({ method: "GET", url, headers: { host } });

describe("createTenantHostGuard", () => {
  it("is absent in single-host mode (no base domain)", () => {
    expect(createTenantHostGuard({ baseDomain: null, resolver: resolverOf(TABLE) })).toBeNull();
  });

  it("passes a session whose org matches the host and exposes the host's org", async () => {
    const res = await get(buildApp({ sessionOrg: ORG_SUNRISE }), "sunrise.chartwarden.com");
    expect(res.statusCode).toBe(200);
    expect(res.json().hostOrg).toBe(ORG_SUNRISE);
  });

  it("refuses a session bound to another org: 403 TENANT_HOST_MISMATCH", async () => {
    const res = await get(buildApp({ sessionOrg: ORG_SUNRISE }), "eagle.chartwarden.com");
    expect(res.statusCode).toBe(403);
    expect(res.json().error?.code ?? res.json().code).toBe("TENANT_HOST_MISMATCH");
  });

  it("serves an anonymous request on a known tenant host (sign-in has no org yet)", async () => {
    const res = await get(buildApp(), "sunrise.chartwarden.com");
    expect(res.statusCode).toBe(200);
  });

  it("answers 404 TENANT_HOST_UNKNOWN for an unprovisioned or malformed tenant host", async () => {
    for (const host of ["nobody.chartwarden.com", "a.b.chartwarden.com", "xn--bcher-kva.chartwarden.com"]) {
      const res = await get(buildApp(), host);
      expect(res.statusCode).toBe(404);
      expect(res.json().error?.code ?? res.json().code).toBe("TENANT_HOST_UNKNOWN");
    }
  });

  it("redirects an alias host to the current slug, keeping path and query (308)", async () => {
    const res = await get(buildApp(), "oldname.chartwarden.com", "/api/v1/ping?x=1");
    expect(res.statusCode).toBe(308);
    expect(res.headers.location).toBe("https://sunrise.chartwarden.com/api/v1/ping?x=1");
  });

  it("refuses a suspended org (403 TENANT_SUSPENDED) and a closed org (410 TENANT_CLOSED)", async () => {
    const paused = await get(buildApp(), "paused.chartwarden.com");
    expect([paused.statusCode, paused.json().error?.code ?? paused.json().code]).toEqual([403, "TENANT_SUSPENDED"]);
    const gone = await get(buildApp(), "gone.chartwarden.com");
    expect([gone.statusCode, gone.json().error?.code ?? gone.json().code]).toEqual([410, "TENANT_CLOSED"]);
  });

  it.each(["chartwarden.com", "admin.chartwarden.com", "localhost:3000", "other.chartwarden.cloud"])(
    "does nothing on %s (not a tenant host)",
    async (host) => {
      const res = await get(buildApp({ sessionOrg: ORG_SUNRISE }), host);
      expect(res.statusCode).toBe(200);
      expect(res.json().hostOrg).toBeNull();
    },
  );

  it("ignores X-Forwarded-Host and tenant-identifying headers from an untrusted peer", async () => {
    const res = await buildApp({ sessionOrg: ORG_SUNRISE }).inject({
      method: "GET",
      url: "/api/v1/ping",
      headers: { host: "sunrise.chartwarden.com", "x-forwarded-host": "eagle.chartwarden.com", "x-tenant-slug": "eagle" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().hostOrg).toBe(ORG_SUNRISE);
  });
});

describe("createCachingTenantHostResolver", () => {
  const sunrise = TABLE.sunrise as TenantHostResolution;
  it("serves a hit from cache within the TTL and re-reads after it", async () => {
    let t = 0;
    const inner = { resolve: vi.fn(async () => sunrise) };
    const cached = createCachingTenantHostResolver(inner, { ttlMs: 60_000, now: () => t });
    await cached.resolve("sunrise");
    await cached.resolve("sunrise");
    expect(inner.resolve).toHaveBeenCalledTimes(1);
    t = 60_001;
    await cached.resolve("sunrise");
    expect(inner.resolve).toHaveBeenCalledTimes(2);
  });

  it("caches a miss briefly so random hosts cannot hammer the database", async () => {
    let t = 0;
    const inner = { resolve: vi.fn(async () => null) };
    const cached = createCachingTenantHostResolver(inner, { ttlMs: 60_000, missTtlMs: 5_000, now: () => t });
    await cached.resolve("nobody");
    await cached.resolve("nobody");
    expect(inner.resolve).toHaveBeenCalledTimes(1);
    t = 5_001;
    await cached.resolve("nobody");
    expect(inner.resolve).toHaveBeenCalledTimes(2);
  });

  it("evicts every entry of an organization when its status changes", async () => {
    const inner = { resolve: vi.fn(async () => sunrise) };
    const cached = createCachingTenantHostResolver(inner, { ttlMs: 60_000, now: () => 0 });
    await cached.resolve("sunrise");
    cached.invalidateOrganization(ORG_SUNRISE);
    await cached.resolve("sunrise");
    expect(inner.resolve).toHaveBeenCalledTimes(2);
  });

  it("stays bounded", async () => {
    const inner = { resolve: vi.fn(async () => null) };
    const cached = createCachingTenantHostResolver(inner, { ttlMs: 1, maxEntries: 3, now: () => 0 });
    for (const l of ["a1", "a2", "a3", "a4", "a5"]) await cached.resolve(l);
    expect(cached.size()).toBeLessThanOrEqual(3);
  });

  it("never lets a flood of unknown hosts evict a real tenant", async () => {
    const inner = { resolve: vi.fn(async (l: string) => (l === "sunrise" ? sunrise : null)) };
    const cached = createCachingTenantHostResolver(inner, { ttlMs: 60_000, maxEntries: 3, now: () => 0 });
    await cached.resolve("sunrise");
    for (const l of ["x1", "x2", "x3", "x4", "x5", "x6"]) await cached.resolve(l);
    inner.resolve.mockClear();
    await cached.resolve("sunrise");
    expect(inner.resolve).not.toHaveBeenCalled();
  });

  it("drops the answer of a lookup that was in flight when its organization was invalidated", async () => {
    let release!: (v: TenantHostResolution | null) => void;
    const inner = { resolve: vi.fn(() => new Promise<TenantHostResolution | null>((r) => (release = r))) };
    const cached = createCachingTenantHostResolver(inner, { ttlMs: 60_000, now: () => 0 });
    const pending = cached.resolve("sunrise");
    cached.invalidateOrganization(ORG_SUNRISE);
    release(sunrise);
    await pending;
    expect(cached.size()).toBe(0);
  });
});
