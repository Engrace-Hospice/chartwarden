// TASK-040B (OPS-004) — the real `/ready` probe. Pure unit coverage of buildReadinessProbe's
// aggregation/timeout/threshold logic (never a live DB/Redis) plus an end-to-end Fastify `inject()`
// proving the task's own acceptance line: "/ready flips to 503 on a dead DB".
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { buildReadinessProbe } from "../readiness-probe";
import { registerHealthRoutes } from "../routes/health";

describe("buildReadinessProbe", () => {
  it("reports ok on every check when no dependency is configured (slice/test boot)", async () => {
    const probe = buildReadinessProbe({});
    await expect(probe()).resolves.toEqual({ db: "ok", valkey: "ok", minio: "ok", outbox: "ok" });
  });

  it("reports fail for a rejecting dependency ping without affecting the others", async () => {
    const probe = buildReadinessProbe({
      pingDb: () => Promise.reject(new Error("connection refused")),
      pingRedis: () => Promise.resolve(),
    });
    await expect(probe()).resolves.toEqual({ db: "fail", valkey: "ok", minio: "ok", outbox: "ok" });
  });

  it("reports fail for a ping that hangs past the timeout", async () => {
    const probe = buildReadinessProbe({
      pingDb: () => new Promise(() => {}), // never resolves — a wedged pool
      timeoutMs: 20,
    });
    await expect(probe()).resolves.toEqual({ db: "fail", valkey: "ok", minio: "ok", outbox: "ok" });
  });

  it("reports outbox ok below the depth threshold and fail at/above it", async () => {
    const belowProbe = buildReadinessProbe({
      outboxPendingDepth: () => Promise.resolve(499),
      outboxDepthThreshold: 500,
    });
    await expect(belowProbe()).resolves.toMatchObject({ outbox: "ok" });

    const atProbe = buildReadinessProbe({
      outboxPendingDepth: () => Promise.resolve(500),
      outboxDepthThreshold: 500,
    });
    await expect(atProbe()).resolves.toMatchObject({ outbox: "fail" });
  });

  it("reports outbox fail when the depth query itself rejects", async () => {
    const probe = buildReadinessProbe({
      outboxPendingDepth: () => Promise.reject(new Error("db down")),
    });
    await expect(probe()).resolves.toMatchObject({ outbox: "fail" });
  });

  it("logs a message naming the failing check", async () => {
    const log = vi.fn();
    const probe = buildReadinessProbe({
      pingRedis: () => Promise.reject(new Error("ECONNREFUSED")),
      log,
    });
    await probe();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("valkey"));
  });
});

describe("/ready route with the real probe wired in", () => {
  it("returns 200 ready when every dependency is healthy", async () => {
    const app = Fastify();
    registerHealthRoutes(
      app,
      buildReadinessProbe({
        pingDb: () => Promise.resolve(),
        pingRedis: () => Promise.resolve(),
        outboxPendingDepth: () => Promise.resolve(0),
      }),
    );
    const res = await app.inject({ method: "GET", url: "/ready" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      status: "ready",
      checks: { db: "ok", valkey: "ok", minio: "ok", outbox: "ok" },
    });
  });

  it("flips to 503 on a dead DB — the task's own acceptance criterion", async () => {
    const app = Fastify();
    registerHealthRoutes(
      app,
      buildReadinessProbe({
        pingDb: () => Promise.reject(new Error("ECONNREFUSED")),
        pingRedis: () => Promise.resolve(),
      }),
    );
    const res = await app.inject({ method: "GET", url: "/ready" });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ status: "not_ready", checks: { db: "fail" } });
  });
});
