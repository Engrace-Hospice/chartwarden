import { resetAuthorizationContract, setAbacEvaluator } from "@chartwarden/auth";
import {
  resetEffectivePermissionResolver,
  setEffectivePermissionResolver,
} from "@chartwarden/auth";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerOpsClaimMdObservabilityRoute } from "../ops-claimmd-observability";

const ACTOR = "40000000-0000-4000-8000-000000000001";

function setup(authorized: boolean, roles = authorized ? ["platform_ops"] : ["org_admin"]) {
  const app = Fastify();
  app.addHook("onRequest", async (request) => {
    request.context = {
      correlationId: "synthetic-correlation",
      userId: ACTOR,
      organizationId: "10000000-0000-4000-8000-000000000001",
      providerEntityIds: [],
      locationIds: [],
      roles,
      attributes: {},
      ip: "127.0.0.1",
      userAgent: "test",
      startTime: Date.now(),
    };
  });
  setEffectivePermissionResolver(() =>
    authorized ? new Set(["billing.rule_config.platform_admin"]) : new Set(),
  );
  setAbacEvaluator(() => authorized);
  const responseSnapshot = vi.fn(async () => ({
    cursorPresent: true,
    lastAttemptAt: Date.parse("2026-11-11T10:00:00Z"),
    lastSuccessAt: Date.parse("2026-11-11T09:59:00Z"),
    streamFailed: false,
    unresolvedCount: 2,
    delivery: { pending: 1 },
    sampledAt: Date.parse("2026-11-11T10:01:00Z"),
  }));
  const eraSnapshot = vi.fn(async () => ({
    cursorPresent: true,
    lastAttemptAt: Date.parse("2026-11-11T10:00:30Z"),
    lastSuccessAt: Date.parse("2026-11-11T09:58:00Z"),
    streamFailed: true,
    capture: { discovered: 3, retryable_failure: 1 },
    resolution: { pending: 2 },
    delivery: { held: 1 },
    sampledAt: Date.parse("2026-11-11T10:01:00Z"),
  }));
  registerOpsClaimMdObservabilityRoute(app, {
    usage: "test",
    responseSnapshot,
    eraSnapshot,
  });
  return { app, responseSnapshot, eraSnapshot };
}

afterEach(() => resetAuthorizationContract());

describe("platform Claim.MD observability", () => {
  it("returns only bounded durable evidence to a platform operator", async () => {
    const { app } = setup(true);
    const response = await app.inject({ method: "GET", url: "/api/v1/ops/claimmd/observability" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      scope: "central_claimmd_account",
      accountReferenceExposed: false,
      responses: { cursor: { present: true, valueExposed: false }, backlog: { unresolved: 2 } },
      eras: { outcome: "failure_recorded", backlog: { discovered: 3, heldDelivery: 1 } },
      requestBudget: { status: "unavailable" },
      workerHeartbeat: { status: "unavailable" },
    });
    expect(JSON.stringify(response.json())).not.toContain("synthetic-claimmd-account");
    await app.close();
  });

  it("rejects tenant roles without invoking central readers", async () => {
    const { app, responseSnapshot, eraSnapshot } = setup(false);
    const response = await app.inject({ method: "GET", url: "/api/v1/ops/claimmd/observability" });
    expect(response.statusCode).toBe(403);
    expect(responseSnapshot).not.toHaveBeenCalled();
    expect(eraSnapshot).not.toHaveBeenCalled();
    await app.close();
  });
});
