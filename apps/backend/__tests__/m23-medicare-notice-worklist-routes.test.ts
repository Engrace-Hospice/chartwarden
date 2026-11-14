import {
  createInMemoryEffectivePermissionStore,
  createPredicateRegistry,
  registerAbacRegistry,
  registerEffectivePermissionResolver,
  resetAbacRegistry,
  resetAuthorizationContract,
  resetRbacEngine,
} from "@chartwarden/auth";
import type { FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import type { MedicareNoticeWorklistService } from "../src/modules/23-billing-medicare/routes/medicare-notice-worklist";
import { registerMedicareNoticeWorklistRoutes } from "../src/modules/23-billing-medicare/routes/medicare-notice-worklist.routes";

const ORG = "0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a";
const PE = "77777777-7777-4777-8777-777777777777";
const OTHER_PE = "99999999-9999-4999-8999-999999999999";
const USER = "11111111-1111-4111-8111-111111111111";

function authenticate(request: FastifyRequest): void {
  if (request.headers["x-test-user"] !== USER) return;
  request.context.userId = USER;
  request.context.organizationId = ORG;
  request.context.roles = ["billing_manager"];
  request.context.providerEntityIds = [PE];
}

const emptyResult = {
  items: [],
  nextCursor: null,
  hasMore: false,
  counts: {
    scope: "returned_page" as const,
    total: 0,
    requiresAttention: 0,
    deadlineApproaching: 0,
    overdue: 0,
    sourceValidationRequired: 0,
    heldByTransportCapability: 0,
    inDoubt: 0,
    awaitingMacEvidence: 0,
    verifiedMacAccepted: 0,
    exceptionReviewsPending: 0,
    dimensionsOverlap: true as const,
  },
};

function makeServer() {
  const list = vi.fn<MedicareNoticeWorklistService["list"]>(async () => emptyResult);
  registerEffectivePermissionResolver(
    createInMemoryEffectivePermissionStore([
      {
        orgId: ORG,
        userId: USER,
        grants: [
          {
            roleKey: "billing_manager",
            enabled: true,
            expiresAt: null,
            permissionKeys: ["billing.noe.read", "billing.notr.read"],
          },
        ],
      },
    ]).store,
  );
  const predicates = createPredicateRegistry();
  predicates.register(
    "provider_entity_billing_scope",
    async (_context, target) => (target as { providerEntityId?: string }).providerEntityId === PE,
  );
  registerAbacRegistry(predicates);
  const app = buildServer({ authenticate, security: { rateLimitEnabled: false } });
  registerMedicareNoticeWorklistRoutes(app, { list });
  return { app, list };
}

beforeEach(() => {
  resetAuthorizationContract();
  resetRbacEngine();
  resetAbacRegistry();
});

afterEach(() => {
  resetAuthorizationContract();
  resetRbacEngine();
  resetAbacRegistry();
});

describe("M23 Medicare notice worklist provider scope", () => {
  it("requires a provider target and denies a different provider before the service runs", async () => {
    const { app, list } = makeServer();
    const headers = { "x-test-user": USER };

    const missing = await app.inject({
      method: "GET",
      url: "/api/v1/billing/medicare-notice-worklist",
      headers,
    });
    expect(missing.statusCode).toBe(400);

    const denied = await app.inject({
      method: "GET",
      url: `/api/v1/billing/medicare-notice-worklist?providerEntityId=${OTHER_PE}`,
      headers,
    });
    expect(denied.statusCode).toBe(404);
    expect(list).not.toHaveBeenCalled();

    const allowed = await app.inject({
      method: "GET",
      url: `/api/v1/billing/medicare-notice-worklist?providerEntityId=${PE}`,
      headers,
    });
    expect(allowed.statusCode).toBe(200);
    expect(list).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: ORG, userId: USER }),
      expect.objectContaining({ providerEntityId: PE }),
      expect.arrayContaining(["noe", "notr"]),
      undefined,
      50,
    );
    await app.close();
  });
});
