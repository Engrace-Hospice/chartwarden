// apps/backend/__tests__/f238-problem-proposal-routes.test.ts — F-238 dx-writeback: the M7 problem-proposal
// routes through the FULL M1 middleware chain via Fastify `inject` (no live infra), behind the REAL
// Authorization Contract. Proves: `care_plan.read` lists, only `care_plan.author` decides; an AI principal is
// refused; `kind` and the explicit `acknowledgeExtracted: true` are required (a document's role label can
// never stand in for the clinician's kind); the acting membership and the §7.6 SUD verdict reach the
// service from the session, never the body. The DB half is `f238-doclens-dx-writeback.live.test.ts`.
import {
  createInMemoryEffectivePermissionStore,
  createPredicateRegistry,
  registerAbacRegistry,
  registerEffectivePermissionResolver,
  resetAuthorizationContract,
  resetRbacEngine,
} from "@wardenx/auth";
import type { FastifyRequest } from "fastify";
import { beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import {
  type ProblemProposalService,
  buildCarePlanAbacPredicates,
  createInMemoryCarePlanBackend,
  registerProblemProposalRoutes,
} from "../src/modules/07-care-plan/index";

const ORG = "org_a";
const PLAN = "cp_seed";
const PATIENT = "11111111-1111-4111-8111-111111111111";

function headerAuth(request: FastifyRequest): void {
  const user = request.headers["x-test-user"];
  if (typeof user !== "string" || user.length === 0) return;
  request.context.userId = user;
  request.context.organizationId = ORG;
  request.context.roles = ["rn_case_manager"];
  request.context.attributes.membershipId = `${user}_membership`;
  const kind = request.headers["x-test-actor-kind"];
  if (typeof kind === "string") request.context.attributes.actorKind = kind;
}

const calls: Array<{ op: string; args: unknown[] }> = [];
const fakeService: ProblemProposalService = {
  async list(...args) {
    calls.push({ op: "list", args });
    return { proposals: [], redacted: false };
  },
  async accept(...args) {
    calls.push({ op: "accept", args });
    return { proposalId: args[2], problemId: "prob_1", status: "accepted", version: 2 };
  },
  async dismiss(...args) {
    calls.push({ op: "dismiss", args });
    return { proposalId: args[2], status: "dismissed", version: 2 };
  },
};

function makeServer() {
  const backend = createInMemoryCarePlanBackend({
    plans: [{ id: PLAN, organizationId: ORG, patientId: PATIENT, status: "draft" }],
  });
  registerEffectivePermissionResolver(
    createInMemoryEffectivePermissionStore([
      {
        orgId: ORG,
        userId: "rn_1",
        grants: [
          {
            roleKey: "seed",
            enabled: true,
            expiresAt: null,
            permissionKeys: ["care_plan.read", "care_plan.author"],
          },
        ],
      },
      {
        orgId: ORG,
        userId: "viewer_1",
        grants: [
          { roleKey: "seed", enabled: true, expiresAt: null, permissionKeys: ["care_plan.read"] },
        ],
      },
    ]).store,
  );
  const registry = createPredicateRegistry();
  const predicates = buildCarePlanAbacPredicates({
    resolver: backend.resolver,
    isInCaseload: async () => true,
  });
  for (const [name, fn] of Object.entries(predicates)) registry.register(name, fn);
  registerAbacRegistry(registry);
  const app = buildServer({ authenticate: headerAuth, security: { rateLimitEnabled: false } });
  registerProblemProposalRoutes(app, {
    service: fakeService,
    sudDisclosureAllowed: async ({ membershipId }) => membershipId === "rn_1_membership",
  });
  return app;
}

const RN = { "x-test-user": "rn_1" };
const VIEWER = { "x-test-user": "viewer_1" };
const ACCEPT = `/api/v1/care-plans/${PLAN}/problem-proposals/pp_1/accept`;
const DISMISS = `/api/v1/care-plans/${PLAN}/problem-proposals/pp_1/dismiss`;
const goodAccept = { ifVersion: 1, kind: "terminal", acknowledgeExtracted: true };

beforeEach(() => {
  resetAuthorizationContract();
  resetRbacEngine();
  calls.length = 0;
});

describe("F-238 — problem-proposal routes", () => {
  it("lists with care_plan.read; the §7.6 verdict comes from the session", async () => {
    const app = makeServer();
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/care-plans/${PLAN}/problem-proposals?status=pending`,
      headers: VIEWER,
    });
    expect(res.statusCode).toBe(200);
    expect(calls[0]).toEqual({
      op: "list",
      args: [ORG, PLAN, { status: "pending", sudDisclosureAllowed: false }],
    });
  });

  it("accept needs care_plan.author; the membership and SUD verdict are the session's", async () => {
    const app = makeServer();
    const denied = await app.inject({
      method: "POST",
      url: ACCEPT,
      headers: VIEWER,
      payload: goodAccept,
    });
    expect(denied.statusCode).toBe(403);
    expect(calls).toEqual([]);
    const ok = await app.inject({ method: "POST", url: ACCEPT, headers: RN, payload: goodAccept });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({
      proposalId: "pp_1",
      problemId: "prob_1",
      status: "accepted",
      version: 2,
    });
    expect(calls[0]).toEqual({
      op: "accept",
      args: [
        ORG,
        PLAN,
        "pp_1",
        { ifVersion: 1, kind: "terminal" },
        { userId: "rn_1", membershipId: "rn_1_membership", sudDisclosureAllowed: true },
      ],
    });
  });

  it("refuses an AI principal (the human acknowledgment cannot be delegated)", async () => {
    const app = makeServer();
    for (const url of [ACCEPT, DISMISS]) {
      const res = await app.inject({
        method: "POST",
        url,
        headers: { ...RN, "x-test-actor-kind": "ai_agent" },
        payload: goodAccept,
      });
      expect(res.statusCode).toBe(403);
    }
    expect(calls).toEqual([]);
  });

  it("kind and acknowledgeExtracted:true are required; a role label is not a kind", async () => {
    const app = makeServer();
    for (const payload of [
      { ifVersion: 1, acknowledgeExtracted: true },
      { ifVersion: 1, kind: "principal", acknowledgeExtracted: true },
      { ifVersion: 1, kind: "terminal" },
      { ifVersion: 1, kind: "terminal", acknowledgeExtracted: false },
    ]) {
      const res = await app.inject({ method: "POST", url: ACCEPT, headers: RN, payload });
      expect(res.statusCode).toBe(422);
    }
    expect(calls).toEqual([]);
  });

  it("dismiss passes the reason through", async () => {
    const app = makeServer();
    const res = await app.inject({
      method: "POST",
      url: DISMISS,
      headers: RN,
      payload: { ifVersion: 3, reason: "duplicate of charted CHF" },
    });
    expect(res.statusCode).toBe(200);
    expect(calls[0]?.args.slice(3)).toEqual([
      { ifVersion: 3, reason: "duplicate of charted CHF" },
      { userId: "rn_1", membershipId: "rn_1_membership", sudDisclosureAllowed: true },
    ]);
  });
});
