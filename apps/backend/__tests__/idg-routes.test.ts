// apps/backend/__tests__/idg-routes.test.ts — M14-T05 route-auth handshake, GAP-091: the
// `idg.override_review_floor` + fresh-step-up audited escape valve wired end-to-end through Fastify.
//
// Exercises the cancel route through the FULL M1 middleware chain via Fastify `inject`, no live infra:
// buildServer() mounts the host, registerIdgRoutes() mounts the §4.1 slice over the in-memory IDG backend.
// The REAL Authorization Contract gates every route; a header-auth shim populates request.context, extended
// with `x-test-session` (M14-specific — `per_patient_review_floor_clear`'s override branch reads
// `context.attributes.sessionId` to resolve step-up freshness through M2's REAL SessionContextResolver
// seam, never a client-supplied header). A FRESH ABAC registry per test binds M14's three real predicates
// over the in-memory resolver (the GAP-011 pattern — reusing the shared module-level registry would pin
// every test after the first to whichever backend registered first).
import {
  createInMemoryEffectivePermissionStore,
  createInMemorySessionContextStore,
  createPredicateRegistry,
  createSessionContextResolver,
  registerAbacRegistry,
  registerEffectivePermissionResolver,
  resetAuthorizationContract,
  resetRbacEngine,
} from "@wardenx/auth";
import type { FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import { __resetSeamsForTest, registerSeam } from "../src/bootstrap/seams/registry";
import {
  buildIdgAbacPredicates,
  createInMemoryIdgBackend,
  registerIdgRoutes,
} from "../src/modules/14-idg/index";

function headerAuth(request: FastifyRequest): void {
  const user = request.headers["x-test-user"];
  if (typeof user !== "string" || user.length === 0) return;
  request.context.userId = user;
  // idg-routes.ts's actorOf() reads the acting MEMBERSHIP id from here (not ctx.userId).
  request.context.attributes.membershipId = user;
  const org = request.headers["x-test-org"];
  request.context.organizationId = typeof org === "string" ? org : "";
  const roles = request.headers["x-test-roles"];
  request.context.roles = typeof roles === "string" && roles.length > 0 ? roles.split(",") : [];
  const locations = request.headers["x-test-locations"];
  request.context.locationIds =
    typeof locations === "string" && locations.length > 0 ? locations.split(",") : [];
  // GAP-091 — the session id `per_patient_review_floor_clear`'s override branch resolves step-up state
  // through (M2's real seam, not a header claim of freshness itself).
  const session = request.headers["x-test-session"];
  if (typeof session === "string" && session.length > 0) {
    request.context.attributes.sessionId = session;
  }
}

const ORG = "org_a";
const LOC = "44444444-4444-4444-8444-444444444444";
const MTG = "11111111-1111-4111-8111-111111111111";
const PATIENT = "22222222-2222-4222-8222-222222222222";
const SESSION_FRESH = "sess-fresh";
const SESSION_STALE = "sess-stale";

function h(user: string, opts: { session?: string } = {}) {
  return {
    "x-test-user": user,
    "x-test-org": ORG,
    "x-test-roles": "idg_coordinator",
    "x-test-locations": LOC,
    ...(opts.session ? { "x-test-session": opts.session } : {}),
  };
}

function makeServer() {
  const backend = createInMemoryIdgBackend({
    meetings: [
      {
        id: MTG,
        organizationId: ORG,
        locationId: LOC,
        status: "scheduled",
        scheduledStart: "2026-06-22T14:00:00.000Z",
        scheduledEnd: "2026-06-22T16:00:00.000Z",
        includedPatientIds: [PATIENT],
      },
    ],
    reviewFloorBreaches: { [MTG]: [{ patientId: PATIENT, floorAt: "2026-06-25T00:00:00.000Z" }] },
  });

  const grantStore = createInMemoryEffectivePermissionStore([
    {
      orgId: ORG,
      userId: "coordinator",
      grants: [
        { roleKey: "seed", enabled: true, expiresAt: null, permissionKeys: ["idg.schedule"] },
      ],
    },
    {
      orgId: ORG,
      userId: "supervisor",
      grants: [
        {
          roleKey: "seed",
          enabled: true,
          expiresAt: null,
          permissionKeys: ["idg.schedule", "idg.override_review_floor"],
        },
      ],
    },
  ]);
  registerEffectivePermissionResolver(grantStore.store);

  const { store: sessionStore } = createInMemorySessionContextStore([
    {
      providerEntityIds: [],
      locationIds: [],
      sessionClass: "staff",
      portalAccountId: null,
      sessionPatientId: null,
      sessionId: SESSION_FRESH,
      userId: "supervisor",
      membershipId: "supervisor",
      organizationId: ORG,
      roles: ["idg_coordinator"],
      lastStepUpAt: new Date(Date.now() - 60_000),
      lastStepUpFactor: "webauthn",
    },
    {
      providerEntityIds: [],
      locationIds: [],
      sessionClass: "staff",
      portalAccountId: null,
      sessionPatientId: null,
      sessionId: SESSION_STALE,
      userId: "supervisor",
      membershipId: "supervisor",
      organizationId: ORG,
      roles: ["idg_coordinator"],
      lastStepUpAt: new Date(Date.now() - 10 * 60_000), // 10 min ago, past the 300s floor
      lastStepUpFactor: "totp",
    },
  ]);
  registerSeam("SessionContextResolver", createSessionContextResolver(sessionStore));

  const registry = createPredicateRegistry();
  const predicates = buildIdgAbacPredicates({ resolver: backend });
  for (const [name, fn] of Object.entries(predicates)) registry.register(name, fn);
  registerAbacRegistry(registry);

  const app = buildServer({ authenticate: headerAuth, security: { rateLimitEnabled: false } });
  registerIdgRoutes(app, { service: backend });
  return { app, backend };
}

beforeEach(() => {
  resetAuthorizationContract();
  resetRbacEngine();
  __resetSeamsForTest();
});
afterEach(() => {
  resetAuthorizationContract();
  resetRbacEngine();
  __resetSeamsForTest();
});

describe("GAP-091 — idg.override_review_floor + step-up wired end-to-end on cancel", () => {
  it("denies a real breach for a coordinator with idg.schedule but no override permission (403)", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/idg/meetings/${MTG}/cancel`,
      headers: h("coordinator"),
      payload: { proposedTransition: "cancel", reason: "no longer needed" },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("denies the override-permission holder with no session at all (403)", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/idg/meetings/${MTG}/cancel`,
      headers: h("supervisor"),
      payload: { proposedTransition: "cancel", reason: "no longer needed" },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("denies the override-permission holder with a STALE step-up (403)", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/idg/meetings/${MTG}/cancel`,
      headers: h("supervisor", { session: SESSION_STALE }),
      payload: { proposedTransition: "cancel", reason: "no longer needed" },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("allows + records the audited override for the permission holder with a FRESH step-up (200)", async () => {
    const { app, backend } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/idg/meetings/${MTG}/cancel`,
      headers: h("supervisor", { session: SESSION_FRESH }),
      payload: { proposedTransition: "cancel", reason: "clinically necessary" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("cancelled");

    const override = backend
      .drainEvents()
      .find((e: { eventName: string }) => e.eventName === "m14.review_floor.override_recorded");
    expect(override?.payload).toMatchObject({
      meetingId: MTG,
      actorMembershipId: "supervisor",
      reason: "clinically necessary",
      breachingPatients: [{ patientId: PATIENT }],
    });
    await app.close();
  });
});
