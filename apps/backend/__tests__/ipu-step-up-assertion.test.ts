// apps/backend/__tests__/ipu-step-up-assertion.test.ts — M37 follow-up to GAP-106: reassessGip and
// applyRestraint stored the MEMBERSHIP id as the step-up assertion id. They now bind the real, server-derived
// session assertion (the attestation's source), and the reassess route composes step-up when the
// criterion is no longer met (§7.4), failing closed on a missing/malformed `criterionStillMet`.
//
// No database: the pure resolver, the machine's error vocabulary, and the real route table over `.inject()`.
import { randomUUID } from "node:crypto";
import {
  createInMemoryEffectivePermissionStore,
  createPredicateRegistry,
  registerAbacRegistry,
  registerEffectivePermissionResolver,
  resetAbacRegistry,
  resetAuthorizationContract,
  resetRbacEngine,
} from "@chartwarden/auth";
import { M37_ERROR_STATUS } from "@chartwarden/inpatient";
import type { FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import { buildM37AbacPredicates } from "../src/modules/37-ipu/abac/predicates";
import { M37_CONTRIBUTED_PERMISSIONS, mountM37Routes } from "../src/modules/37-ipu/index";
import { sessionStepUpAssertionId } from "../src/modules/37-ipu/routes/ipu-trust-gates";
import type { IpuRouteService } from "../src/modules/37-ipu/routes/service";

const ORG = "00000000-0000-4000-8000-0000000000a1";
const MEMBERSHIP = "11111111-1111-4111-8111-111111111111";
const SESSION = "22222222-2222-4222-8222-222222222222";

describe("sessionStepUpAssertionId — the real assertion, or nothing", () => {
  it("returns the session assertion id when step-up is fresh", () => {
    expect(sessionStepUpAssertionId({ stepUpRecent: true, stepUpAssertionId: SESSION })).toBe(
      SESSION,
    );
  });
  it("never falls back to the membership id", () => {
    expect(
      sessionStepUpAssertionId({
        stepUpRecent: true,
        stepUpAssertionId: null,
        membershipId: MEMBERSHIP,
      } as never),
    ).toBeNull();
  });
  it("is null without a fresh step-up, even when the session carries an id", () => {
    expect(
      sessionStepUpAssertionId({ stepUpRecent: false, stepUpAssertionId: SESSION }),
    ).toBeNull();
  });
  it("is null for a non-uuid session id (the column is uuid)", () => {
    expect(
      sessionStepUpAssertionId({ stepUpRecent: true, stepUpAssertionId: "sess_abc" }),
    ).toBeNull();
  });
});

describe("restraint step-up assertion error vocabulary", () => {
  it("has a distinct 403 for 'no assertion id to bind the application to'", () => {
    expect(M37_ERROR_STATUS.RESTRAINT_STEP_UP_ASSERTION_MISSING).toBe(403);
  });
});

function headerAuth(request: FastifyRequest): void {
  const user = request.headers["x-test-user"];
  if (typeof user !== "string" || user.length === 0) return;
  request.context.userId = user;
  request.context.organizationId = ORG;
  request.context.roles = ["rn"];
  request.context.attributes.membershipId = MEMBERSHIP;
  if (request.headers["x-test-step-up"] === "1") {
    request.context.attributes.stepUpRecent = true;
    request.context.attributes.sessionId = SESSION;
  }
}

describe("reassess route — step-up composes when the criterion is no longer met (§7.4)", () => {
  const service = { reassessGip: vi.fn(async () => ({ id: randomUUID() })) };
  beforeEach(() => {
    resetAuthorizationContract();
    resetRbacEngine();
    resetAbacRegistry();
    service.reassessGip.mockClear();
    const store = createInMemoryEffectivePermissionStore([
      {
        orgId: ORG,
        userId: "u1",
        grants: [
          {
            roleKey: "seed",
            enabled: true,
            expiresAt: null,
            permissionKeys: Object.keys(M37_CONTRIBUTED_PERMISSIONS),
          },
        ],
      },
    ]);
    registerEffectivePermissionResolver(store.store);
    const registry = createPredicateRegistry();
    for (const [name, predicate] of Object.entries(buildM37AbacPredicates())) {
      registry.register(name, predicate);
    }
    registry.register("step_up_recent", async (c) => c.attributes.stepUpRecent === true);
    registerAbacRegistry(registry);
  });
  afterEach(() => {
    resetAuthorizationContract();
    resetRbacEngine();
    resetAbacRegistry();
  });

  const rationale = "r".repeat(60);
  async function post(payload: unknown, stepUp: boolean) {
    const server = buildServer({ authenticate: headerAuth, security: { rateLimitEnabled: false } });
    mountM37Routes(server, { service: service as unknown as IpuRouteService });
    const res = await server.inject({
      method: "POST",
      url: `/api/v1/ipu-admissions/${randomUUID()}/gip-criteria/reassess`,
      headers: { "x-test-user": "u1", ...(stepUp ? { "x-test-step-up": "1" } : {}) },
      payload: payload as never,
    });
    await server.close();
    return res.statusCode;
  }

  it("criterionStillMet=false without a fresh step-up is refused before the service", async () => {
    const status = await post({ criterionStillMet: false, rationale }, false);
    expect(status).toBeGreaterThanOrEqual(400);
    expect(service.reassessGip).not.toHaveBeenCalled();
  });
  it("criterionStillMet=false WITH step-up reaches the service", async () => {
    const status = await post({ criterionStillMet: false, rationale }, true);
    expect(status).toBe(200);
    expect(service.reassessGip).toHaveBeenCalledTimes(1);
  });
  it("criterionStillMet=true needs no step-up (a routine reassessment)", async () => {
    const status = await post({ criterionStillMet: true, rationale }, false);
    expect(status).toBe(200);
    expect(service.reassessGip).toHaveBeenCalledTimes(1);
  });
  it("a missing or non-boolean criterionStillMet fails closed (no step-up skip)", async () => {
    expect(await post({ rationale }, false)).toBeGreaterThanOrEqual(400);
    expect(await post({ criterionStillMet: "true", rationale }, false)).toBeGreaterThanOrEqual(400);
    expect(service.reassessGip).not.toHaveBeenCalled();
  });
});
