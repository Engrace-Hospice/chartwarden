// apps/backend/__tests__/api.test.ts — M1-T10 foundation API integration tests (spec §4).
//
// Proves the slice's testable acceptance criteria with Fastify `inject` (no live infra):
//   • idempotent mutation (§4.6 / W-M1-10): same Idempotency-Key replays, never re-runs;
//     a different body under the same key is a 409 IDEMPOTENCY_CONFLICT.
//   • degraded mode (§4.2 / §5.2): GET /system/status surfaces a non-operational component
//     (the payload the degraded-mode banner renders); /ready reports 503 when a dep is down.
//   • the standard error envelope (§4.3–4.4) + deny-stub guards (§6) fail closed.
import type { FastifyRequest } from "fastify";
import { beforeEach, describe, expect, it } from "vitest";
import {
  type ServerDeps,
  type SystemStatusComponent,
  type SystemStatusReader,
  buildServer,
  createInMemorySystemStatusReader,
} from "../src/bootstrap/index";

/** Test-only auth shim: populate request.context from headers (M2 owns the real one). */
function headerAuth(request: FastifyRequest): void {
  const org = request.headers["x-test-org"];
  const roles = request.headers["x-test-roles"];
  if (typeof org === "string" && org.length > 0) {
    request.context.organizationId = org;
    request.context.userId = "user_test";
    request.context.roles = typeof roles === "string" ? roles.split(",").filter(Boolean) : [];
  }
}

const ORG = "org_a";
const ADMIN_HEADERS = { "x-test-org": ORG, "x-test-roles": "platform_ops" };

function makeServer(extra: ServerDeps = {}) {
  return buildServer({ authenticate: headerAuth, security: { rateLimitEnabled: false }, ...extra });
}

describe("M1-T10 foundation API", () => {
  describe("health / readiness / version", () => {
    it("GET /health → 200 ok", async () => {
      const app = makeServer();
      const res = await app.inject({ method: "GET", url: "/health" });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ status: "ok" });
      await app.close();
    });

    it("GET /ready → 200 ready by default, 503 when a dependency is down (degraded)", async () => {
      const ok = makeServer();
      const okRes = await ok.inject({ method: "GET", url: "/ready" });
      expect(okRes.statusCode).toBe(200);
      expect(okRes.json().status).toBe("ready");
      await ok.close();

      const down = makeServer({
        readinessProbe: async () => ({ db: "ok", valkey: "fail", minio: "ok", outbox: "ok" }),
      });
      const downRes = await down.inject({ method: "GET", url: "/ready" });
      expect(downRes.statusCode).toBe(503);
      expect(downRes.json().status).toBe("not_ready");
      expect(downRes.json().checks.valkey).toBe("fail");
      await down.close();
    });

    it("GET /version → build metadata", async () => {
      const app = makeServer();
      const res = await app.inject({ method: "GET", url: "/version" });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toHaveProperty("version");
      await app.close();
    });
  });

  describe("error envelope + deny-stub guards (§4.3, §6)", () => {
    it("unauthenticated GET /system/status → 401 envelope with correlationId", async () => {
      const app = makeServer();
      const res = await app.inject({ method: "GET", url: "/api/v1/system/status" });
      expect(res.statusCode).toBe(401);
      const body = res.json();
      expect(body.error.code).toBe("UNAUTHORIZED");
      expect(typeof body.error.correlationId).toBe("string");
      expect(body.error.documentationUrl).toContain("/errors/UNAUTHORIZED");
      await app.close();
    });

    it("echoes the provided x-correlation-id into the envelope", async () => {
      const app = makeServer();
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/system/status",
        headers: { "x-correlation-id": "corr-123" },
      });
      expect(res.json().error.correlationId).toBe("corr-123");
      await app.close();
    });

    it("admin status mutation without platform_ops role → 403 FORBIDDEN", async () => {
      const app = makeServer();
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/admin/system/status",
        headers: { "x-test-org": ORG, "x-test-roles": "clinician" },
        payload: { id: "system", status: "operational" },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe("FORBIDDEN");
      await app.close();
    });

    it("admin status mutation with an invalid body → 422 VALIDATION_FAILED", async () => {
      const app = makeServer();
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/admin/system/status",
        headers: ADMIN_HEADERS,
        payload: { id: "system", status: "not-a-level" },
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().error.code).toBe("VALIDATION_FAILED");
      expect(res.json().error.details?.[0]?.field).toBe("status");
      await app.close();
    });
  });

  describe("degraded mode (§4.2 / §5.2)", () => {
    it("GET /system/feature-flags returns the org's flag map", async () => {
      const app = makeServer({
        featureFlagReader: {
          async forOrg() {
            return { "ui.show_ipu_features": false };
          },
        },
      });
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/system/feature-flags",
        headers: { "x-test-org": ORG },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().flags["ui.show_ipu_features"]).toBe(false);
      await app.close();
    });

    it("GET /system/status surfaces a non-operational component (banner payload)", async () => {
      const degraded: SystemStatusComponent = {
        id: "dosespot",
        status: "degraded",
        headline: "Slow response times",
        details: "Upstream latency elevated",
        updatedAt: "2026-06-14T00:00:00.000Z",
      };
      const reader: SystemStatusReader = {
        async list() {
          return [
            {
              id: "system",
              status: "operational",
              headline: null,
              details: null,
              updatedAt: "2026-06-14T00:00:00.000Z",
            },
            degraded,
          ];
        },
        async upsert() {},
      };
      const app = makeServer({ systemStatusReader: reader });
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/system/status",
        headers: { "x-test-org": ORG },
      });
      expect(res.statusCode).toBe(200);
      const components = res.json().components as SystemStatusComponent[];
      const nonOperational = components.filter((c) => c.status !== "operational");
      expect(nonOperational).toHaveLength(1);
      expect(nonOperational[0]).toMatchObject({ id: "dosespot", status: "degraded" });
      await app.close();
    });
  });

  describe("idempotent mutation (§4.6 / W-M1-10)", () => {
    let upsertCalls = 0;
    let reader: SystemStatusReader;

    beforeEach(() => {
      upsertCalls = 0;
      const inner = createInMemorySystemStatusReader();
      reader = {
        list: (orgId) => inner.list(orgId),
        upsert: (orgId, component) => {
          upsertCalls += 1;
          return inner.upsert(orgId, component);
        },
      };
    });

    it("replays the cached response for a repeated Idempotency-Key without re-running", async () => {
      const app = makeServer({ systemStatusReader: reader });
      const headers = { ...ADMIN_HEADERS, "idempotency-key": "key-1" };
      const payload = { id: "system", status: "degraded", headline: "maintenance" };

      const first = await app.inject({
        method: "POST",
        url: "/api/v1/admin/system/status",
        headers,
        payload,
      });
      const second = await app.inject({
        method: "POST",
        url: "/api/v1/admin/system/status",
        headers,
        payload,
      });

      expect(first.statusCode).toBe(200);
      expect(second.statusCode).toBe(200);
      // Identical replayed body (same updatedAt) proves the handler did NOT run twice.
      expect(second.json()).toEqual(first.json());
      expect(upsertCalls).toBe(1);
      await app.close();
    });

    it("same key + different body → 409 IDEMPOTENCY_CONFLICT", async () => {
      const app = makeServer({ systemStatusReader: reader });
      const headers = { ...ADMIN_HEADERS, "idempotency-key": "key-2" };

      const first = await app.inject({
        method: "POST",
        url: "/api/v1/admin/system/status",
        headers,
        payload: { id: "system", status: "operational" },
      });
      const conflict = await app.inject({
        method: "POST",
        url: "/api/v1/admin/system/status",
        headers,
        payload: { id: "system", status: "outage" },
      });

      expect(first.statusCode).toBe(200);
      expect(conflict.statusCode).toBe(409);
      expect(conflict.json().error.code).toBe("IDEMPOTENCY_CONFLICT");
      expect(upsertCalls).toBe(1);
      await app.close();
    });
  });

  describe("security baseline (§4.6.1)", () => {
    it("sets the helmet-equivalent response headers", async () => {
      const app = makeServer();
      const res = await app.inject({ method: "GET", url: "/health" });
      expect(res.headers["x-content-type-options"]).toBe("nosniff");
      expect(res.headers["x-frame-options"]).toBe("DENY");
      expect(res.headers["strict-transport-security"]).toContain("max-age=");
      expect(res.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
      await app.close();
    });

    it("enforces the SD-055 unauthenticated rate-limit tier", async () => {
      const clock = 0;
      const app = buildServer({
        authenticate: headerAuth,
        security: {
          now: () => clock,
          rateLimitTiers: { unauthenticatedPerMinute: 2, authenticatedPerMinute: 600 },
        },
      });
      const hit = () => app.inject({ method: "GET", url: "/health" });
      expect((await hit()).statusCode).toBe(200);
      expect((await hit()).statusCode).toBe(200);
      const limited = await hit();
      expect(limited.statusCode).toBe(429);
      expect(limited.json().error.code).toBe("RATE_LIMITED");
      expect(limited.headers["retry-after"]).toBeDefined();
      await app.close();
    });
  });
});
