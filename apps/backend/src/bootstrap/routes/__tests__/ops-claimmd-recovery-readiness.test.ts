import {
  resetAuthorizationContract,
  setAbacEvaluator,
  setEffectivePermissionResolver,
} from "@chartwarden/auth";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerOpsClaimMdRecoveryReadinessRoutes } from "../ops-claimmd-recovery-readiness";

const INBOX = "20000000-0000-4000-8000-000000005501";
const ACTOR = "10000000-0000-4000-8000-000000005501";

function setup(authorized: boolean) {
  const app = Fastify();
  app.addHook("onRequest", async (request) => {
    request.context = {
      correlationId: "synthetic-bil55",
      userId: ACTOR,
      organizationId: "30000000-0000-4000-8000-000000005501",
      providerEntityIds: [],
      locationIds: [],
      roles: authorized ? ["platform_ops"] : ["org_admin"],
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
  const preflight = vi.fn(async () => ({
    inboxId: INBOX,
    usage: "test" as const,
    stage: "capture" as const,
    currentState: "retryable_failure",
    currentVersion: 5,
    sourceDigestPresent: false,
    tenantAttribution: "unattributed" as const,
    leaseActive: false,
    priorRecoveryAttempts: 0,
    disposition: "eligible_for_simulation" as const,
    blockers: [],
    financialEffects: {
      status: "not_evaluated" as const,
      reasonCode: "PREFLIGHT_DOES_NOT_AUTHORIZE_FINANCIAL_REPROCESSING" as const,
    },
    simulation: {
      available: true,
      mutatesSource: false as const,
      callsVendor: false as const,
      authorizesExecution: false as const,
    },
    assessedAt: "2026-11-11T10:00:00Z",
  }));
  registerOpsClaimMdRecoveryReadinessRoutes(app, {
    accountReference: "server-owned-account",
    usage: "test",
    preflight,
  });
  return { app, preflight };
}

afterEach(() => resetAuthorizationContract());

describe("Claim.MD recovery readiness routes", () => {
  it("uses the server account binding and exposes only nonmutating simulation", async () => {
    const { app, preflight } = setup(true);
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/ops/claimmd/eras/${INBOX}/recovery-dry-run?usage=test&stage=capture`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().simulation).toEqual({
      available: true,
      mutatesSource: false,
      callsVendor: false,
      authorizesExecution: false,
    });
    expect(preflight).toHaveBeenCalledWith(
      expect.objectContaining({ accountReference: "server-owned-account", inboxId: INBOX }),
    );
    await app.close();
  });

  it("rejects tenant admins and environment mismatch before reading central state", async () => {
    const denied = setup(false);
    expect(
      (
        await denied.app.inject({
          method: "GET",
          url: `/api/v1/ops/claimmd/eras/${INBOX}/recovery-preflight?usage=test&stage=capture`,
        })
      ).statusCode,
    ).toBe(403);
    expect(denied.preflight).not.toHaveBeenCalled();
    await denied.app.close();

    const mismatch = setup(true);
    expect(
      (
        await mismatch.app.inject({
          method: "GET",
          url: `/api/v1/ops/claimmd/eras/${INBOX}/recovery-preflight?usage=production&stage=capture`,
        })
      ).statusCode,
    ).toBe(422);
    expect(mismatch.preflight).not.toHaveBeenCalled();
    await mismatch.app.close();
  });
});
