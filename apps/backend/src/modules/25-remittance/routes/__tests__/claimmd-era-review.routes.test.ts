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
  input: {
    permission?: boolean;
    matchPermission?: boolean;
    financialPermission?: boolean;
    organizationId?: string;
    providerEntityIds?: string[];
  } = {},
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
      attributes: { membershipId: "50000000-0000-4000-8000-000000000005" },
      ip: "127.0.0.1",
      userAgent: "test",
      startTime: Date.now(),
    };
  });
  setEffectivePermissionResolver(
    () =>
      new Set([
        ...(input.permission ? ["remittance.read"] : []),
        ...(input.matchPermission ? ["remittance.match_review"] : []),
        ...(input.financialPermission ? ["remittance.financial_review"] : []),
      ]),
  );
  const service = {
    list: vi.fn(async () => ({ items: [], nextCursor: null, searchWindowLimited: false })),
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
        return {
          id: STAGE,
          providerEntityId: PROVIDER_A,
          locationId: null,
          eraId: "synthetic-era",
          fileIndex: 0,
          transactionSetControlNumber: "0001",
          state: "held",
          holdReason: "DELIVERY_PREPARED",
          possibleDuplicate: false,
          duplicateClassification: "none",
          existingAdviceId: null,
          createdAt: "2026-10-01T00:00:00.000Z",
          detailsAvailable: false,
          payer: { name: null, identifier: null },
          payee: { name: null, npi: null },
          payment: { trace: null, method: null, amount: null, date: null },
          claims: [],
          providerAdjustments: [],
          claimOutcomes: [],
          reconciliationEligible: false,
          history: { availability: "unavailable", events: [] },
        };
      },
    ),
    matching: vi.fn(async () => ({
      stageId: STAGE,
      totalClaims: 0,
      verifiedSourceIdentities: 0,
      unresolvedSourceIdentities: 0,
      claims: [],
      decisionHistory: [],
      serviceLineMatching: "not_available_without_original_line_reference",
      financialReview: {
        reportedPaymentCents: 0,
        claimCount: 0,
        chargeCents: 0,
        claimPaymentCents: 0,
        patientResponsibilityCents: 0,
        claimAdjustmentCents: 0,
        serviceLineAdjustmentCents: 0,
        providerAdjustmentCents: 0,
        balance: {
          status: "balanced",
          claimPaymentsCents: 0,
          providerAdjustmentsCents: 0,
          reportedPaymentCents: 0,
          expectedPaymentCents: 0,
          differenceCents: 0,
        },
        claims: [],
        adjustments: [],
        providerAdjustments: [],
        exceptions: [],
        canCompleteNonpostingReview: true,
        financialPostingAuthorized: false,
      },
      financialReviewHistory: [],
      readOnlyBalance: {
        status: "balanced",
        claimPaymentsCents: 0,
        providerAdjustmentsCents: 0,
        reportedPaymentCents: 0,
        expectedPaymentCents: 0,
        differenceCents: 0,
      },
      postingAuthorized: false,
    })),
    candidates: vi.fn(async (_actor: unknown, id: string) =>
      id === STAGE ? { candidates: [], complete: true } : null,
    ),
    recordMatchDecision: vi.fn(async () => ({
      decisionVersion: 1,
      decision: "confirmed_identity",
    })),
    recordFinancialReviewDecision: vi.fn(
      async (
        _actor: unknown,
        id: string,
        value: {
          itemType: "era";
          itemIndex: -1;
          disposition: "note";
          expectedVersion: 0;
          reason: string;
          idempotencyKey: string;
        },
      ) => ({
        id,
        itemType: value.itemType,
        itemIndex: value.itemIndex,
        decisionVersion: 1,
        disposition: value.disposition,
      }),
    ),
  } as never;
  registerClaimMdEraReviewRoutes(app, service);
  return {
    app,
    service: service as {
      list: ReturnType<typeof vi.fn>;
      get: ReturnType<typeof vi.fn>;
      matching: ReturnType<typeof vi.fn>;
      candidates: ReturnType<typeof vi.fn>;
      recordMatchDecision: ReturnType<typeof vi.fn>;
      recordFinancialReviewDecision: ReturnType<typeof vi.fn>;
    },
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

  it("does not treat ordinary review access as financial posting approval or execution", async () => {
    const { app } = setup({ permission: true, financialPermission: true });
    const body = {
      planId: STAGE,
      planDigest: "a".repeat(64),
      reason: "Synthetic authorization boundary test",
    };
    const headers = { "idempotency-key": "posting-auth-test-0001" };
    const approval = await app.inject({
      method: "POST",
      url: `/api/v1/remittance/claimmd-era/${STAGE}/posting-plans/${STAGE}/approval`,
      headers,
      payload: body,
    });
    const execution = await app.inject({
      method: "POST",
      url: `/api/v1/remittance/claimmd-era/${STAGE}/posting-plans/${STAGE}/execution`,
      headers,
      payload: body,
    });
    expect(approval.statusCode).toBe(403);
    expect(execution.statusCode).toBe(403);
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

  it("passes supported payer/date filters without accepting tenant scope from query parameters", async () => {
    const { app, service } = setup({ permission: true });
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/remittance/claimmd-era?payer=synthetic&fromDate=2026-10-01&toDate=2026-10-31&organizationId=${OTHER_ORG}`,
    });
    expect(response.statusCode).toBe(200);
    expect(service.list.mock.calls[0]?.[0]).toMatchObject({ organizationId: ORG });
    expect(service.list.mock.calls[0]?.[1]).not.toHaveProperty("organizationId");
    const valid = await app.inject({
      method: "GET",
      url: "/api/v1/remittance/claimmd-era?payer=synthetic&fromDate=2026-10-01&toDate=2026-10-31",
    });
    expect(valid.statusCode).toBe(200);
    expect(service.list).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: ORG, providerEntityScope: [PROVIDER_A] }),
      expect.objectContaining({ payer: "synthetic", fromDate: "2026-10-01", toDate: "2026-10-31" }),
      undefined,
      expect.any(Number),
    );
    await app.close();
  });

  it("exposes only scoped review and controlled posting routes, never the account-wide inbox", async () => {
    const { app } = setup({ permission: true });
    const routes = app.printRoutes();
    expect(routes).toContain("api/v1/remittance/claimmd-era");
    expect(routes).toContain(":id (GET, HEAD)");
    expect(routes).not.toContain("inbox");
    expect(routes).not.toContain("requeue");
    expect(routes).toContain("plan (POST)");
    expect(routes).toContain("approval (POST)");
    expect(routes).toContain("execution (POST)");
    expect(routes).not.toContain("/inbox");
    await app.close();
  });

  it("allows a scoped read-only matching view under remittance.read", async () => {
    const { app, service } = setup({ permission: true });
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/remittance/claimmd-era/${STAGE}/matching`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      postingAuthorized: false,
      serviceLineMatching: "not_available_without_original_line_reference",
    });
    expect(service.matching).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: ORG, providerEntityScope: [PROVIDER_A] }),
      STAGE,
    );
    await app.close();
  });

  it("keeps historical candidate discovery tenant-scoped and nonposting", async () => {
    const { app, service } = setup({ permission: true });
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/remittance/claimmd-era/${STAGE}/matching/claims/0/candidates`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      candidates: [],
      complete: true,
      postingAuthorized: false,
    });
    expect(service.candidates).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: ORG, providerEntityScope: [PROVIDER_A] }),
      STAGE,
      0,
    );
    const denied = setup();
    const deniedResponse = await denied.app.inject({
      method: "GET",
      url: `/api/v1/remittance/claimmd-era/${STAGE}/matching/claims/0/candidates`,
    });
    expect(deniedResponse.statusCode).toBe(403);
    expect(denied.service.candidates).not.toHaveBeenCalled();
    await Promise.all([app.close(), denied.app.close()]);
  });

  it("requires the separate match-review permission and invokes only the nonposting decision service", async () => {
    const denied = setup({ permission: true });
    const deniedResponse = await denied.app.inject({
      method: "POST",
      url: `/api/v1/remittance/claimmd-era/${STAGE}/matching/claims/0/decision`,
      headers: { "idempotency-key": "synthetic-decision-1" },
      body: {
        action: "confirm_identity",
        expectedVersion: 0,
        reason: "Verified original submission",
      },
    });
    expect(deniedResponse.statusCode).toBe(403);
    expect(denied.service.recordMatchDecision).not.toHaveBeenCalled();
    await denied.app.close();

    const allowed = setup({ matchPermission: true });
    const response = await allowed.app.inject({
      method: "POST",
      url: `/api/v1/remittance/claimmd-era/${STAGE}/matching/claims/0/decision`,
      headers: { "idempotency-key": "synthetic-decision-2" },
      body: {
        action: "confirm_identity",
        expectedVersion: 0,
        reason: "Verified original submission",
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      decision: "confirmed_identity",
      postingAuthorized: false,
    });
    expect(allowed.service.recordMatchDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: ORG,
        membershipId: "50000000-0000-4000-8000-000000000005",
      }),
      STAGE,
      0,
      expect.objectContaining({ action: "confirm_identity" }),
    );
    await allowed.app.close();
  });

  it("requires separate financial-review permission and records only a nonposting decision", async () => {
    const denied = setup({ permission: true });
    const deniedResponse = await denied.app.inject({
      method: "POST",
      url: `/api/v1/remittance/claimmd-era/${STAGE}/financial-review/decision`,
      headers: { "idempotency-key": "financial-review-denied-1" },
      body: {
        itemType: "era",
        itemIndex: -1,
        disposition: "reviewed",
        expectedVersion: 0,
        reason: "Reviewed source totals",
      },
    });
    expect(deniedResponse.statusCode).toBe(403);
    expect(denied.service.recordFinancialReviewDecision).not.toHaveBeenCalled();
    await denied.app.close();

    const allowed = setup({ financialPermission: true });
    const response = await allowed.app.inject({
      method: "POST",
      url: `/api/v1/remittance/claimmd-era/${STAGE}/financial-review/decision`,
      headers: { "idempotency-key": "financial-review-allowed-1" },
      body: {
        itemType: "era",
        itemIndex: -1,
        disposition: "reviewed",
        expectedVersion: 0,
        reason: "Reviewed source totals",
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      financialPostingAuthorized: false,
      itemType: "era",
      itemIndex: -1,
    });
    expect(allowed.service.recordFinancialReviewDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: ORG,
        membershipId: "50000000-0000-4000-8000-000000000005",
      }),
      STAGE,
      expect.objectContaining({
        disposition: "reviewed",
        idempotencyKey: "financial-review-allowed-1",
      }),
    );
    await allowed.app.close();
  });
});
