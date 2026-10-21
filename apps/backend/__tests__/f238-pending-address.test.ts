// apps/backend/__tests__/f238-pending-address.test.ts — F-238 "an address is waiting in intake review":
// GET /api/v1/patients/:patientId/intake-pending-address through the full M1 middleware chain via Fastify
// `inject` behind the real Authorization Contract (no live infra). Proves the gate — `patient.read` +
// `caseload_or_scope` (404 outside scope) AND `intake.read` (403 without it, so the admission screen's hint
// degrades to nothing) — and that the route answers exactly what the service returns, scoped to the
// session's org. The query itself is proven live in f238-doclens-identity-relink.live.test.ts.
import {
  createInMemoryEffectivePermissionStore,
  createPredicateRegistry,
  registerAbacRegistry,
  registerEffectivePermissionResolver,
  resetAuthorizationContract,
  resetRbacEngine,
} from "@chartwarden/auth";
import type { FastifyRequest } from "fastify";
import { beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import {
  DOCLENS_ADDRESS_FIELD_PATHS,
  type PendingAddressService,
  registerDocLensPendingAddressRoutes,
} from "../src/modules/22-documents/index";

const ORG = "org_a";
const PATIENT = "22222222-2222-4222-8222-222222222222";
const OTHER_PATIENT = "33333333-3333-4333-8333-333333333333";
const BATCH = "11111111-1111-4111-8111-111111111111";

function headerAuth(request: FastifyRequest): void {
  const user = request.headers["x-test-user"];
  if (typeof user !== "string" || user.length === 0) return;
  request.context.userId = user;
  request.context.organizationId = ORG;
  request.context.roles = ["intake_coordinator"];
  request.context.attributes.membershipId = `${user}_membership`;
}

describe("F-238 — GET /api/v1/patients/:patientId/intake-pending-address", () => {
  const calls: unknown[][] = [];
  const service: PendingAddressService = {
    async pendingForPatient(...args) {
      calls.push(args);
      return {
        items: [
          {
            batchId: BATCH,
            batchStatus: "in_review",
            uploadedAt: "2026-10-04T10:00:00.000Z",
            reviewStatus: "in_progress",
            pendingCount: 2,
            approvedCount: 3,
          },
        ],
        totalBatches: 1,
      };
    },
  };

  function makeServer() {
    const grant = (userId: string, permissionKeys: string[]) => ({
      orgId: ORG,
      userId,
      grants: [{ roleKey: "seed", enabled: true, expiresAt: null, permissionKeys }],
    });
    registerEffectivePermissionResolver(
      createInMemoryEffectivePermissionStore([
        grant("coordinator", ["patient.read", "intake.read"]),
        grant("clinician", ["patient.read"]),
        grant("intake_only", ["intake.read", "intake.review"]),
      ]).store,
    );
    const registry = createPredicateRegistry();
    registry.register(
      "caseload_or_scope",
      async (_ctx: unknown, target: Record<string, unknown>) => target.patientId === PATIENT,
    );
    registerAbacRegistry(registry);
    const app = buildServer({ authenticate: headerAuth, security: { rateLimitEnabled: false } });
    registerDocLensPendingAddressRoutes(app, service);
    return app;
  }

  const get = (app: ReturnType<typeof makeServer>, patientId: string, user?: string) =>
    app.inject({
      method: "GET",
      url: `/api/v1/patients/${patientId}/intake-pending-address`,
      ...(user ? { headers: { "x-test-user": user } } : {}),
    });

  beforeEach(() => {
    resetAuthorizationContract();
    resetRbacEngine();
    calls.length = 0;
  });

  it("answers counts + batch ids to a patient.read + intake.read holder, scoped to the session's org", async () => {
    const app = makeServer();
    const res = await get(app, PATIENT, "coordinator");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      items: [
        {
          batchId: BATCH,
          batchStatus: "in_review",
          uploadedAt: "2026-10-04T10:00:00.000Z",
          reviewStatus: "in_progress",
          pendingCount: 2,
          approvedCount: 3,
        },
      ],
      totalBatches: 1,
    });
    expect(calls).toEqual([[ORG, PATIENT]]);
  });

  it("403 without intake.read or without patient.read; 404 outside the caseload; 401 anonymous; 422 bad id", async () => {
    const app = makeServer();
    expect((await get(app, PATIENT, "clinician")).statusCode).toBe(403);
    expect((await get(app, PATIENT, "intake_only")).statusCode).toBe(403);
    expect((await get(app, OTHER_PATIENT, "coordinator")).statusCode).toBe(404);
    expect((await get(app, PATIENT)).statusCode).toBe(401);
    expect((await get(app, "not-a-uuid", "coordinator")).statusCode).not.toBe(200);
    expect(calls).toEqual([]);
  });

  it("the address field set is exactly the M5 writeback allowlist's address slots", () => {
    expect([...DOCLENS_ADDRESS_FIELD_PATHS].sort()).toEqual(
      [
        "patient.address.city",
        "patient.address.line1",
        "patient.address.line2",
        "patient.address.postalCode",
        "patient.address.state",
      ].sort(),
    );
  });
});
