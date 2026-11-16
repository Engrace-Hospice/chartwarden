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
import { __resetSeamsForTest, buildServer } from "../src/bootstrap/index";
import { registerHopeRoutes } from "../src/modules/10-hope/index";
import type { HopeRouteService } from "../src/modules/10-hope/routes/service";

// GET workspace / review may write draft answers (chart refresh, SFV self-heal), so only a caller holding
// `hope.timepoint.write` triggers them: the route hands the service `mayWrite` from the same permission resolver the
// guards use. The service is a stub here (its `{}` answer ends in the route's own 422 response check, which is fine): what
// is under test is the flag the route derives from the caller's grants, read off the service call.
const ORG = "org_a";
const ASSESSMENT = "90000000-0000-4000-8000-000000000010";

const grants = (userId: string, permissionKeys: string[]) => ({
  orgId: ORG,
  userId,
  grants: [{ roleKey: "seed", enabled: true, expiresAt: null, permissionKeys }],
});

function headerAuth(request: FastifyRequest): void {
  const user = request.headers["x-test-user"];
  if (typeof user !== "string") return;
  request.context.userId = user;
  request.context.attributes.membershipId = user;
  request.context.organizationId = ORG;
  request.context.roles = [];
}

function server() {
  registerEffectivePermissionResolver(
    createInMemoryEffectivePermissionStore([
      grants("reader", ["hope.timepoint.read"]),
      grants("writer", ["hope.timepoint.read", "hope.timepoint.write"]),
    ]).store,
  );
  const registry = createPredicateRegistry();
  registry.register("hope.scope", async () => true);
  registerAbacRegistry(registry);
  const getAssessmentWorkspace = vi.fn(async () => ({}));
  const getAssessmentReview = vi.fn(async () => ({}));
  const app = buildServer({ authenticate: headerAuth, security: { rateLimitEnabled: false } });
  registerHopeRoutes(app, {
    service: { getAssessmentWorkspace, getAssessmentReview } as unknown as HopeRouteService,
  });
  return { app, getAssessmentWorkspace, getAssessmentReview };
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
  __resetSeamsForTest();
});

describe("workspace / review reads — only a writer's open may refresh the draft", () => {
  const cases = [
    { path: "workspace", spy: "getAssessmentWorkspace" },
    { path: "review", spy: "getAssessmentReview" },
  ] as const;

  for (const { path, spy } of cases) {
    it(`${path}: a caller holding hope.timepoint.write is served with mayWrite: true`, async () => {
      const harness = server();

      await harness.app.inject({
        method: "GET",
        url: `/api/v1/hope/assessments/${ASSESSMENT}/${path}`,
        headers: { "x-test-user": "writer" },
      });

      expect(harness[spy]).toHaveBeenCalledWith(ORG, ASSESSMENT, { mayWrite: true });
      await harness.app.close();
    });

    it(`${path}: a read-only caller is served with mayWrite: false`, async () => {
      const harness = server();

      await harness.app.inject({
        method: "GET",
        url: `/api/v1/hope/assessments/${ASSESSMENT}/${path}`,
        headers: { "x-test-user": "reader" },
      });

      expect(harness[spy]).toHaveBeenCalledWith(ORG, ASSESSMENT, { mayWrite: false });
      await harness.app.close();
    });
  }
});
