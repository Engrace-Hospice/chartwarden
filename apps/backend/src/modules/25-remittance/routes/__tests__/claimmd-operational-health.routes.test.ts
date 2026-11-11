import { resetAuthorizationContract, setEffectivePermissionResolver } from "@chartwarden/auth";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerRemittanceRoutes } from "../remittance.routes";

const ORG = "10000000-0000-4000-8000-000000000001";
const USER = "20000000-0000-4000-8000-000000000001";
const PROVIDER = "30000000-0000-4000-8000-000000000001";

afterEach(() => resetAuthorizationContract());

describe("tenant Claim.MD operational health route", () => {
  it("uses the server actor scope and returns no central account metadata", async () => {
    const app = Fastify();
    app.addHook("onRequest", async (request) => {
      request.context = {
        correlationId: "synthetic-correlation",
        userId: USER,
        organizationId: ORG,
        providerEntityIds: [PROVIDER],
        locationIds: [],
        roles: ["billing_specialist"],
        attributes: {},
        ip: "127.0.0.1",
        userAgent: "test",
        startTime: Date.now(),
      };
    });
    setEffectivePermissionResolver(() => new Set(["remittance.read"]));
    const claimMdTenantOperationalHealth = vi.fn(async () => ({
      scope: "tenant_attributed_m25_stages" as const,
      providerEntityId: PROVIDER,
      completeness: "exact_for_authorized_provider_stages" as const,
      stageCount: 2,
      states: { staged: 1, held: 1 },
      exceptionCount: 1,
      oldestExceptionAt: "2026-11-10T00:00:00.000Z",
      latestStageAt: "2026-11-11T00:00:00.000Z",
      centralCapture: {
        status: "restricted" as const,
        reasonCode: "CENTRAL_ACCOUNT_METADATA_NOT_TENANT_VISIBLE" as const,
      },
      requestBudget: {
        status: "unavailable" as const,
        reasonCode: "NO_DURABLE_REQUEST_BUDGET_OBSERVATION" as const,
      },
      sampledAt: "2026-11-11T01:00:00.000Z",
    }));
    registerRemittanceRoutes(app, {
      readService: { claimMdTenantOperationalHealth } as never,
      writeService: {} as never,
    });
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/remittance/claimmd-operational-health?providerEntityId=${PROVIDER}`,
    });
    expect(response.statusCode).toBe(200);
    expect(claimMdTenantOperationalHealth).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: ORG, providerEntityScope: [PROVIDER] }),
      PROVIDER,
    );
    expect(response.json()).toMatchObject({
      centralCapture: { status: "restricted" },
      requestBudget: { status: "unavailable" },
    });
    expect(JSON.stringify(response.json())).not.toContain("accountReference");
    await app.close();
  });
});
