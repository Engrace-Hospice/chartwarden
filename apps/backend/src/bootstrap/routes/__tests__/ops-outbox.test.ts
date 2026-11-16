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
} from "@chartwarden/auth";
import type { DbClient } from "@chartwarden/db";
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

  it("accounts the read against the event id: the detail returns the full payload, which can carry PHI", async () => {
    const eventId = "44444444-4444-4444-8444-444444444444";
    const stored = {
      id: eventId,
      eventType: "m15.plan.version_signed",
      aggregateKind: "discipline_care_plan",
      aggregateId: "55555555-5555-4555-8555-555555555555",
      status: "dispatched",
      attemptCount: 1,
      lastError: null,
      payload: { synthetic: true },
      createdAt: new Date("2026-11-15T12:00:00.000Z"),
      dispatchedAt: null,
      nextAttemptAt: null,
    };
    const audited: { eventType?: string; resourceKind?: string; resourceId?: string }[] = [];
    const tx = {
      execute: async () => undefined,
      select: () => ({ from: () => ({ where: () => ({ limit: async () => [stored] }) }) }),
      insert: () => ({
        values: async (row: (typeof audited)[number]) => {
          audited.push(row);
        },
      }),
    };
    const db = {
      transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
    } as unknown as DbClient;
    const { store, put } = createInMemoryEffectivePermissionStore();
    put(ORG_ID, USER_ID, [
      { roleKey: "test-role", enabled: true, expiresAt: null, permissionKeys: ["member.manage"] },
    ]);
    registerEffectivePermissionResolver(store);
    const app = buildServer({
      db,
      authenticate: (request) => {
        request.context.userId = USER_ID;
        request.context.organizationId = ORG_ID;
      },
      security: { rateLimitEnabled: false },
    });

    const res = await app.inject({ method: "GET", url: `/api/v1/ops/outbox/${eventId}` });

    expect(res.statusCode).toBe(200);
    expect(res.json().payload).toEqual({ synthetic: true });
    expect(audited).toContainEqual(
      expect.objectContaining({ resourceKind: "outbox_event", resourceId: eventId }),
    );
  });
});
