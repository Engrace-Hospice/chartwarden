import {
  resetEffectivePermissionResolver,
  setEffectivePermissionResolver,
} from "@chartwarden/auth";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerMedicaidEraReviewRoutes } from "../medicaid-era-review.routes";

const ORG = "10000000-0000-4000-8000-000000000001";
const PROVIDER = "20000000-0000-4000-8000-000000000001";

afterEach(() => {
  resetEffectivePermissionResolver();
});

function setup(permissions: string[]) {
  const app = Fastify();
  app.addHook("onRequest", async (request) => {
    request.context = {
      correlationId: "synthetic-correlation",
      userId: "synthetic-user",
      organizationId: ORG,
      providerEntityIds: [PROVIDER],
      locationIds: [],
      roles: [],
      attributes: { membershipId: "50000000-0000-4000-8000-000000000005" },
      ip: "127.0.0.1",
      userAgent: "test",
      startTime: Date.now(),
    };
  });
  setEffectivePermissionResolver(() => new Set(permissions));
  const service = {
    list: vi.fn(async () => ({ items: [], nextCursor: null })),
    detail: vi.fn(async () => {
      throw new Error("not found");
    }),
    history: vi.fn(async () => []),
    evaluate: vi.fn(async () => ({
      status: "held" as const,
      reasonCode: "SOURCE_ACCOUNT_UNVERIFIED",
    })),
    transition: vi.fn(async () => ({
      id: "30000000-0000-4000-8000-000000000001",
      version: 2,
      workflowState: "investigating",
      replay: false,
    })),
  };
  registerMedicaidEraReviewRoutes(app, service as never);
  return { app, service };
}

describe("Medicaid ERA nonposting review API", () => {
  it("serves an empty tenant worklist without creating synthetic rows", async () => {
    const { app, service } = setup(["remittance.read"]);
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/remittance/medicaid-era-reviews",
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ items: [], nextCursor: null });
    expect(service.list).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: ORG, providerEntityScope: [PROVIDER] }),
      50,
      undefined,
    );
    await app.close();
  });

  it("requires review permission and idempotency for a source evaluation", async () => {
    const denied = setup([]);
    const noPermission = await denied.app.inject({
      method: "POST",
      url: "/api/v1/remittance/medicaid-era-artifacts/30000000-0000-4000-8000-000000000001/evaluate",
      headers: { "idempotency-key": "synthetic-review-key-0001" },
    });
    expect(noPermission.statusCode).toBe(403);
    await denied.app.close();

    const allowed = setup(["remittance.match_review"]);
    const response = await allowed.app.inject({
      method: "POST",
      url: "/api/v1/remittance/medicaid-era-artifacts/30000000-0000-4000-8000-000000000001/evaluate",
      headers: { "idempotency-key": "synthetic-review-key-0002" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "held", reasonCode: "SOURCE_ACCOUNT_UNVERIFIED" });
    expect(allowed.service.evaluate).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: ORG }),
      "30000000-0000-4000-8000-000000000001",
      "synthetic-review-key-0002",
    );
    await allowed.app.close();
  });

  it("requires financial-review permission before exposing a review detail", async () => {
    const denied = setup(["remittance.read"]);
    const response = await denied.app.inject({
      method: "GET",
      url: "/api/v1/remittance/medicaid-era-reviews/30000000-0000-4000-8000-000000000001",
    });
    expect(response.statusCode).toBe(403);
    expect(denied.service.detail).not.toHaveBeenCalled();
    await denied.app.close();
  });

  it("does not register any payment-posting operation", async () => {
    const { app } = setup(["remittance.read", "remittance.financial_review"]);
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/remittance/medicaid-era-reviews/30000000-0000-4000-8000-000000000001/post",
    });
    expect(response.statusCode).toBe(404);
    await app.close();
  });
});
