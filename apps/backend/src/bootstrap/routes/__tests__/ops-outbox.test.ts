// apps/backend/src/bootstrap/routes/__tests__/ops-outbox.test.ts — WX-PR-020 (OPS-004) HTTP-layer
// smoke suite. `deps.db` is intentionally undefined here (no live Postgres) — this proves the guard/
// validation wiring (permission gate, status-filter validation, the no-db empty/404 fallback), not
// the query itself; that needs a real DB and belongs in a `.live.test.ts` alongside this module's
// siblings if/when this surface grows past a single read view.
import {
  createInMemoryEffectivePermissionStore,
  registerEffectivePermissionResolver,
  resetAuthorizationContract,
  resetRbacEngine,
} from "@wardenx/auth";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../../index";

const ORG_ID = "11111111-1111-1111-1111-111111111111";
const USER_ID = "22222222-2222-2222-2222-222222222222";

function buildApp(granted: readonly string[]) {
  const { store, put } = createInMemoryEffectivePermissionStore();
  put(ORG_ID, USER_ID, [
    { roleKey: "test-role", enabled: true, expiresAt: null, permissionKeys: granted },
  ]);
  registerEffectivePermissionResolver(store);
  return buildServer({
    authenticate: (request) => {
      request.context.userId = USER_ID;
      request.context.organizationId = ORG_ID;
    },
  });
}

describe("ops-outbox routes — GET /api/v1/ops/outbox", () => {
  beforeEach(() => {
    resetRbacEngine();
    resetAuthorizationContract();
  });
  afterEach(() => {
    resetRbacEngine();
    resetAuthorizationContract();
  });

  it("403s without member.manage", async () => {
    const app = buildApp([]);
    const res = await app.inject({ method: "GET", url: "/api/v1/ops/outbox" });
    expect(res.statusCode).toBe(403);
  });

  it("returns an empty list when no DB is wired (slice default), given the permission", async () => {
    const app = buildApp(["member.manage"]);
    const res = await app.inject({ method: "GET", url: "/api/v1/ops/outbox" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ data: [], nextCursor: null });
  });

  it("rejects an invalid status filter with 422", async () => {
    const app = buildApp(["member.manage"]);
    const res = await app.inject({ method: "GET", url: "/api/v1/ops/outbox?status=bogus" });
    expect(res.statusCode).toBe(422);
  });

  it("accepts every real status filter value", async () => {
    const app = buildApp(["member.manage"]);
    for (const status of ["pending", "dispatching", "dispatched", "failed"]) {
      const res = await app.inject({ method: "GET", url: `/api/v1/ops/outbox?status=${status}` });
      expect(res.statusCode).toBe(200);
    }
  });
});

describe("ops-outbox routes — GET /api/v1/ops/outbox/:id", () => {
  beforeEach(() => {
    resetRbacEngine();
    resetAuthorizationContract();
  });
  afterEach(() => {
    resetRbacEngine();
    resetAuthorizationContract();
  });

  it("403s without member.manage", async () => {
    const app = buildApp([]);
    const res = await app.inject({ method: "GET", url: "/api/v1/ops/outbox/some-id" });
    expect(res.statusCode).toBe(403);
  });

  it("404s when no DB is wired (slice default), given the permission", async () => {
    const app = buildApp(["member.manage"]);
    const res = await app.inject({ method: "GET", url: "/api/v1/ops/outbox/some-id" });
    expect(res.statusCode).toBe(404);
  });
});
