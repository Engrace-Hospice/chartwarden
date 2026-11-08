import {
  resetEffectivePermissionResolver,
  setEffectivePermissionResolver,
} from "@chartwarden/auth";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerClaimMdEraReviewRoutes } from "../claimmd-era-review.routes";

const ORG = "10000000-0000-4000-8000-000000000001";
const OTHER_ORG = "10000000-0000-4000-8000-000000000002";
const PROVIDER_A = "20000000-0000-4000-8000-000000000001";
const PROVIDER_B = "20000000-0000-4000-8000-000000000002";
const STAGE = "30000000-0000-4000-8000-000000000001";

function setup(
  input: { permission?: boolean; organizationId?: string; providerEntityIds?: string[] } = {},
) {
  const app = Fastify();
  app.addHook("onRequest", async (request) => {
    request.context = {
      correlationId: "synthetic-correlation",
      userId: "synthetic-user",
      organizationId: input.organizationId ?? ORG,
      providerEntityIds: input.providerEntityIds ?? [PROVIDER_A],
      locationIds: [],
      roles: [],
      attributes: {},
      ip: "127.0.0.1",
      userAgent: "test",
      startTime: Date.now(),
    };
  });
  setEffectivePermissionResolver(() =>
    input.permission ? new Set(["remittance.read"]) : new Set(),
  );
  const service = {
    list: vi.fn(async () => ({ items: [], nextCursor: null })),
    get: vi.fn(
      async (
        actor: { organizationId: string; providerEntityScope?: readonly string[] },
        id: string,
      ) => {
        if (
          actor.organizationId !== ORG ||
          !actor.providerEntityScope?.includes(PROVIDER_A) ||
          id !== STAGE
        )
          return null;
        return { id: STAGE, providerEntityId: PROVIDER_A, reconciliationEligible: false };
      },
    ),
  } as never;
  registerClaimMdEraReviewRoutes(app, service);
  return {
    app,
    service: service as { list: ReturnType<typeof vi.fn>; get: ReturnType<typeof vi.fn> },
  };
}

afterEach(() => resetEffectivePermissionResolver());

describe("Claim.MD ERA review route authorization", () => {
  it("permits remittance.read and passes only server-derived organization/provider scope", async () => {
    const { app, service } = setup({ permission: true });
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/remittance/claimmd-era/${STAGE}`,
    });
    expect(response.statusCode).toBe(200);
    expect(service.get).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: ORG, providerEntityScope: [PROVIDER_A] }),
      STAGE,
    );
    expect(response.body).not.toContain("inbox");
    await app.close();
  });

  it("denies missing remittance.read permission", async () => {
    const { app, service } = setup();
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/remittance/claimmd-era/${STAGE}`,
    });
    expect(response.statusCode).toBe(403);
    expect(service.get).not.toHaveBeenCalled();
    await app.close();
  });

  it("does not disclose a guessed stage id from another organization", async () => {
    const { app, service } = setup({ permission: true, organizationId: OTHER_ORG });
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/remittance/claimmd-era/${STAGE}`,
    });
    expect(response.statusCode).toBe(404);
    expect(service.get).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: OTHER_ORG }),
      STAGE,
    );
    await app.close();
  });

  it("rejects invalid IDs and provider filters outside the actor scope", async () => {
    const { app, service } = setup({ permission: true });
    const invalid = await app.inject({
      method: "GET",
      url: "/api/v1/remittance/claimmd-era/not-a-uuid",
    });
    expect(invalid.statusCode).toBe(400);
    const list = await app.inject({
      method: "GET",
      url: `/api/v1/remittance/claimmd-era?providerEntityId=${PROVIDER_B}`,
    });
    expect(list.statusCode).toBe(200);
    expect(service.list).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: ORG, providerEntityScope: [PROVIDER_A] }),
      expect.objectContaining({ providerEntityId: PROVIDER_B }),
      undefined,
      expect.any(Number),
    );
    await app.close();
  });

  it("exposes no account-wide inbox route or mutation/posting route", async () => {
    const { app } = setup({ permission: true });
    const routes = app.printRoutes();
    expect(routes).toContain("api/v1/remittance/claimmd-era");
    expect(routes).toContain(":id (GET, HEAD)");
    expect(routes).not.toContain("inbox");
    expect(routes).not.toContain("requeue");
    expect(routes).not.toContain("post");
    await app.close();
  });
});
