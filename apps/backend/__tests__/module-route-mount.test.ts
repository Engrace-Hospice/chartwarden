// apps/backend/__tests__/module-route-mount.test.ts — the buildServer `registerModuleRoutes` hook.
// Proves the composition-root mount mechanism: module REST routes mount behind the same auth/security
// chain as the foundation routes, and the hook is opt-in (absent → only foundation routes are served).
import { requireRequestContext } from "@wardenx/tenancy";
import { buildServer } from "../src/bootstrap/index";
import { afterEach, describe, expect, it } from "vitest";

describe("buildServer registerModuleRoutes hook", () => {
  let app: Awaited<ReturnType<typeof buildServer>> | null = null;
  afterEach(async () => {
    await app?.close();
    app = null;
  });

  it("mounts module routes supplied by the composition root", async () => {
    app = buildServer({
      security: { rateLimitEnabled: false },
      registerModuleRoutes: (a) => {
        a.get("/api/v1/_probe", async () => ({ mounted: true }));
      },
    });
    const res = await app.inject({ method: "GET", url: "/api/v1/_probe" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ mounted: true });
  });

  it("serves only foundation routes when the hook is omitted (route is 404)", async () => {
    app = buildServer({ security: { rateLimitEnabled: false } });
    const probe = await app.inject({ method: "GET", url: "/api/v1/_probe" });
    expect(probe.statusCode).toBe(404);
    const health = await app.inject({ method: "GET", url: "/healthz" });
    expect(health.statusCode).toBe(200); // foundation routes still served
  });

  it("exposes the live (post-authenticate) tenant scope via the ambient request context", async () => {
    app = buildServer({
      security: { rateLimitEnabled: false },
      // authenticate mutates request.context AFTER the context-creation hook — store reads must see
      // this org via requireRequestContext()/withOrgContextFromRequest, not the empty initial value.
      authenticate: async (request) => {
        request.context.organizationId = "org-live";
        request.context.userId = "user-live";
      },
      registerModuleRoutes: (a) => {
        a.get("/api/v1/_ctx", async () => requireRequestContext());
      },
    });
    const res = await app.inject({ method: "GET", url: "/api/v1/_ctx" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ organizationId: "org-live", userId: "user-live" });
  });
});
