// M1-T10 — the liveness and version probes. `/ready` has its own coverage in readiness-probe.test.ts;
// these pin `/health` (what docker-compose's healthchecks call) and the `/version` shape.
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultReadinessProbe, registerHealthRoutes } from "../routes/health";

function buildApp() {
  const app = Fastify();
  registerHealthRoutes(app, defaultReadinessProbe);
  return app;
}

describe("GET /health", () => {
  it("answers 200 ok without consulting the readiness probe", async () => {
    const probe = vi.fn(defaultReadinessProbe);
    const app = Fastify();
    registerHealthRoutes(app, probe);

    const res = await app.inject({ method: "GET", url: "/health" });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
    expect(probe).not.toHaveBeenCalled();
    await app.close();
  });
});

describe("GET /version", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("reports the build metadata from the environment", async () => {
    vi.stubEnv("APP_VERSION", "1.2.3");
    vi.stubEnv("GIT_SHA", "b8f11cb52");
    vi.stubEnv("BUILD_TIME", "2026-10-04T21:00:00Z");
    const app = buildApp();

    const res = await app.inject({ method: "GET", url: "/version" });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      version: "1.2.3",
      gitSha: "b8f11cb52",
      buildTime: "2026-10-04T21:00:00Z",
    });
    await app.close();
  });

  it("falls back to placeholders when the build metadata is unset", async () => {
    vi.stubEnv("APP_VERSION", undefined);
    vi.stubEnv("GIT_SHA", undefined);
    vi.stubEnv("BUILD_TIME", undefined);
    const app = buildApp();

    const res = await app.inject({ method: "GET", url: "/version" });

    expect(res.json()).toEqual({ version: "dev", gitSha: "unknown", buildTime: "unknown" });
    await app.close();
  });
});
