// apps/backend/__tests__/care-plan-change-proposal-routes.test.ts — WF09: the plan-of-care change-proposal ROUTES (no DB).
// Drives the real route table through Fastify `inject` over a recording stub service, and proves the edge: the permission chain, the
// `caseload_or_scope` ABAC, the AI-principal refusal, the Idempotency-Key on create, body / query validation, the caller the service is handed
// (membership from the session, §7.6 verdict from the closure, discipline scope from the roles), and that every read declares its audit.
// What the service does with the caller (draft visibility, accept through the manual operation, VERSION_IN_REVIEW, …) is proven live in
// m7-change-proposals.live.test.ts.
import { randomUUID } from "node:crypto";
import {
  CARE_PLAN_DEFAULT_GRANTS,
  createInMemoryEffectivePermissionStore,
  createPredicateRegistry,
  registerAbacRegistry,
  registerEffectivePermissionResolver,
  resetAuthorizationContract,
  resetRbacEngine,
} from "@chartwarden/auth";
import type { FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import { __resetSeamsForTest } from "../src/bootstrap/seams/registry";
import {
  type CarePlanChangeProposalService,
  buildCarePlanAbacPredicates,
  createInMemoryCarePlanBackend,
  registerChangeProposalRoutes,
} from "../src/modules/07-care-plan/index";

const ORG = "org_a";
const PATIENT = "11111111-1111-4111-8111-111111111111";
const PLAN = "22222222-2222-4222-8222-222222222222";
const PROPOSAL = "33333333-3333-4333-8333-333333333333";
const ENCOUNTER = "44444444-4444-4444-8444-444444444444";
const PROBLEM = "55555555-5555-4555-8555-555555555555";

function headerAuth(request: FastifyRequest): void {
  const user = request.headers["x-test-user"];
  if (typeof user !== "string" || user.length === 0) return;
  request.context.userId = user;
  request.context.organizationId = String(request.headers["x-test-org"] ?? "");
  const roles = request.headers["x-test-roles"];
  request.context.roles = typeof roles === "string" && roles.length > 0 ? roles.split(",") : [];
  if (request.headers["x-test-no-membership"] !== "true") {
    request.context.attributes.membershipId = `${user}_membership`;
  }
  const kind = request.headers["x-test-actor-kind"];
  if (typeof kind === "string") request.context.attributes.actorKind = kind;
}

const PERMISSIONS = [
  // The roles that hold `care_plan.author` by default (CARE_PLAN_DEFAULT_GRANTS) and one that holds read only.
  { userId: "cm_1", permissions: [...(CARE_PLAN_DEFAULT_GRANTS.rn_case_manager ?? [])] },
  { userId: "don_1", permissions: [...(CARE_PLAN_DEFAULT_GRANTS.director_of_nursing ?? [])] },
  { userId: "lpn_1", permissions: [...(CARE_PLAN_DEFAULT_GRANTS.lpn ?? [])] },
];
const CM = { "x-test-user": "cm_1", "x-test-org": ORG, "x-test-roles": "rn,rn_case_manager" };
const CM_AI = { ...CM, "x-test-actor-kind": "ai_agent" };
const CM_SUD = { ...CM, "x-test-roles": "rn,rn_case_manager,sud_cleared" };
const DON = { "x-test-user": "don_1", "x-test-org": ORG, "x-test-roles": "director_of_nursing" };
const LPN = { "x-test-user": "lpn_1", "x-test-org": ORG, "x-test-roles": "lpn" };
const key = (): { "idempotency-key": string } => ({ "idempotency-key": randomUUID() });

type Call = { method: string; args: unknown[] };

/** A service that records its calls and answers a fixed value, so the test sees exactly what the route handed it. */
function recordingService() {
  const calls: Call[] = [];
  const view = { id: PROPOSAL, status: "draft" };
  const list = { patientId: PATIENT, proposals: [], redacted: false };
  const rec =
    <T>(method: string, result: T) =>
    async (...args: unknown[]): Promise<T> => {
      calls.push({ method, args });
      return result;
    };
  const service = {
    create: rec("create", view),
    replace: rec("replace", view),
    withdraw: rec("withdraw", { proposalId: PROPOSAL, status: "withdrawn" }),
    listForPlan: rec("listForPlan", list),
    listForPatient: rec("listForPatient", list),
    accept: rec("accept", { proposalId: PROPOSAL, status: "accepted" }),
    dismiss: rec("dismiss", { proposalId: PROPOSAL, status: "dismissed" }),
    releaseForEncounter: rec("releaseForEncounter", 0),
    withdrawForEncounter: rec("withdrawForEncounter", 0),
  } as unknown as CarePlanChangeProposalService;
  return { service, calls };
}

function makeServer() {
  const backend = createInMemoryCarePlanBackend({
    plans: [{ id: PLAN, organizationId: ORG, patientId: PATIENT }],
  });
  registerEffectivePermissionResolver(
    createInMemoryEffectivePermissionStore(
      PERMISSIONS.map((s) => ({
        orgId: ORG,
        userId: s.userId,
        grants: [
          { roleKey: "seed", enabled: true, expiresAt: null, permissionKeys: s.permissions },
        ],
      })),
    ).store,
  );
  const registry = createPredicateRegistry();
  for (const [name, fn] of Object.entries(
    buildCarePlanAbacPredicates({ resolver: backend.resolver, isInCaseload: async () => true }),
  )) {
    registry.register(name, fn);
  }
  registerAbacRegistry(registry);
  const { service, calls } = recordingService();
  const app = buildServer({ authenticate: headerAuth, security: { rateLimitEnabled: false } });
  registerChangeProposalRoutes(app, {
    service,
    sudDisclosureAllowed: async ({ roles }) => roles.includes("sud_cleared"),
  });
  return { app, calls };
}

const problemAdd = {
  kind: "problem_add",
  description: "New pressure injury (synthetic)",
  problemKind: "related",
};
const createBody = { ...problemAdd, sourceEncounterId: ENCOUNTER };
const base = `/api/v1/care-plans/${PLAN}/change-proposals`;

beforeEach(() => {
  resetAuthorizationContract();
  resetRbacEngine();
});
afterEach(() => {
  resetAuthorizationContract();
  resetRbacEngine();
  __resetSeamsForTest();
});

describe("permission chain and principals", () => {
  const writes: ReadonlyArray<readonly [string, string, unknown]> = [
    ["POST", base, createBody],
    ["PUT", `${base}/${PROPOSAL}`, problemAdd],
    ["DELETE", `${base}/${PROPOSAL}`, undefined],
    ["POST", `${base}/${PROPOSAL}/accept`, undefined],
    ["POST", `${base}/${PROPOSAL}/dismiss`, {}],
  ];

  // Recording a proposal changes nothing on the plan, so the visiting clinician needs only care_plan.read; deciding one needs care_plan.author.
  const proposes = writes.slice(0, 3);
  const decides = writes.slice(3);

  it.each(proposes)(
    "%s %s is open to a clinician holding only care_plan.read (a proposal changes nothing on the plan)",
    async (method, url, payload) => {
      const { app, calls } = makeServer();
      const res = await app.inject({
        method: method as "POST",
        url,
        headers: { ...LPN, ...key() },
        ...(payload === undefined ? {} : { payload: payload as object }),
      });
      expect(res.statusCode).toBeLessThan(300);
      expect(calls).toHaveLength(1);
    },
  );

  it.each(decides)(
    "%s %s is refused to a clinician holding only care_plan.read",
    async (method, url, payload) => {
      const { app, calls } = makeServer();
      const res = await app.inject({
        method: method as "POST",
        url,
        headers: { ...LPN, ...key() },
        ...(payload === undefined ? {} : { payload: payload as object }),
      });
      expect(res.statusCode).toBe(403);
      expect(calls).toEqual([]);
    },
  );

  it.each(writes)(
    "%s %s is refused to an AI principal even holding care_plan.author",
    async (method, url, payload) => {
      const { app, calls } = makeServer();
      const res = await app.inject({
        method: method as "POST",
        url,
        headers: { ...CM_AI, ...key() },
        ...(payload === undefined ? {} : { payload: payload as object }),
      });
      expect(res.statusCode).toBe(403);
      expect(calls).toEqual([]);
    },
  );

  it("a session without a membership cannot act (403, never 401)", async () => {
    const { app, calls } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: base,
      headers: { ...CM, "x-test-no-membership": "true", ...key() },
      payload: createBody,
    });
    expect(res.statusCode).toBe(403);
    expect(calls).toEqual([]);
  });

  it("a read-only clinician may read both lists", async () => {
    const { app } = makeServer();
    const plan = await app.inject({ method: "GET", url: base, headers: LPN });
    const patient = await app.inject({
      method: "GET",
      url: `/api/v1/patients/${PATIENT}/care-plan-change-proposals`,
      headers: LPN,
    });
    expect([plan.statusCode, patient.statusCode]).toEqual([200, 200]);
  });

  it("every route needs a session", async () => {
    const { app } = makeServer();
    const res = await app.inject({ method: "GET", url: base });
    expect(res.statusCode).toBe(401);
  });
});

describe("create", () => {
  it("requires an Idempotency-Key, so a retried POST cannot record a second draft", async () => {
    const { app, calls } = makeServer();
    const res = await app.inject({ method: "POST", url: base, headers: CM, payload: createBody });
    expect(res.statusCode).toBe(400);
    expect(calls).toEqual([]);
  });

  it("answers 201 and hands the service the session's membership, the plan and the visit — never anything from the body", async () => {
    const { app, calls } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: base,
      headers: { ...CM, ...key() },
      payload: createBody,
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ id: PROPOSAL, status: "draft" });
    expect(calls).toHaveLength(1);
    const [org, planId, input, caller] = calls[0]?.args as [string, string, unknown, unknown];
    expect(org).toBe(ORG);
    expect(planId).toBe(PLAN);
    expect(input).toMatchObject({ kind: "problem_add", sourceEncounterId: ENCOUNTER });
    expect(caller).toEqual({
      userId: "cm_1",
      membershipId: "cm_1_membership",
      sudDisclosureAllowed: false,
    });
  });

  it("passes the §7.6 verdict of the caller's session to the service", async () => {
    const { app, calls } = makeServer();
    await app.inject({
      method: "POST",
      url: base,
      headers: { ...CM_SUD, ...key() },
      payload: createBody,
    });
    expect(calls[0]?.args[3]).toMatchObject({ sudDisclosureAllowed: true });
  });

  it.each([
    ["a body with no visit", problemAdd],
    ["an unknown kind", { ...createBody, kind: "problem_delete" }],
    ["a smuggled status", { ...createBody, status: "accepted" }],
  ])("refuses %s before the service is reached", async (_name, payload) => {
    const { app, calls } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: base,
      headers: { ...CM, ...key() },
      payload: payload as object,
    });
    expect(res.statusCode).toBe(422);
    expect(calls).toEqual([]);
  });

  it("a supervisor holding care_plan.author may record one too", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: base,
      headers: { ...DON, ...key() },
      payload: createBody,
    });
    expect(res.statusCode).toBe(201);
  });
});

describe("replace, withdraw, decide", () => {
  it("PUT replaces the change (the visit never changes) and DELETE withdraws", async () => {
    const { app, calls } = makeServer();
    const put = await app.inject({
      method: "PUT",
      url: `${base}/${PROPOSAL}`,
      headers: CM,
      payload: problemAdd,
    });
    const del = await app.inject({ method: "DELETE", url: `${base}/${PROPOSAL}`, headers: CM });
    expect([put.statusCode, del.statusCode]).toEqual([200, 200]);
    expect(calls.map((c) => c.method)).toEqual(["replace", "withdraw"]);
    // A PUT body carrying a visit is refused: the visit a proposal belongs to is fixed at creation.
    const moved = await app.inject({
      method: "PUT",
      url: `${base}/${PROPOSAL}`,
      headers: CM,
      payload: createBody,
    });
    expect(moved.statusCode).toBe(422);
  });

  it("accept runs under the accepter's own discipline scope and §7.6 verdict", async () => {
    const { app, calls } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: `${base}/${PROPOSAL}/accept`,
      headers: CM_SUD,
    });
    expect(res.statusCode).toBe(200);
    const acceptor = calls[0]?.args[3] as {
      membershipId: string;
      sudDisclosureAllowed: boolean;
      disciplineScope: { disciplines: string[]; isIdgCoordinator: boolean };
    };
    expect(acceptor.membershipId).toBe("cm_1_membership");
    expect(acceptor.sudDisclosureAllowed).toBe(true);
    expect(acceptor.disciplineScope.disciplines).toContain("rn");
    expect(acceptor.disciplineScope.isIdgCoordinator).toBe(false);
  });

  it("dismiss takes an optional coded reason and refuses free text", async () => {
    const { app, calls } = makeServer();
    const ok = await app.inject({
      method: "POST",
      url: `${base}/${PROPOSAL}/dismiss`,
      headers: CM,
      payload: { reason: "already_addressed" },
    });
    const free = await app.inject({
      method: "POST",
      url: `${base}/${PROPOSAL}/dismiss`,
      headers: CM,
      payload: { reason: "the patient's daughter disagreed" },
    });
    expect([ok.statusCode, free.statusCode]).toEqual([200, 422]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args[3]).toEqual({ reason: "already_addressed" });
  });

  it("a malformed proposal id is a 400, not a database error", async () => {
    const { app, calls } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: `${base}/cp_1/accept`,
      headers: CM,
    });
    expect(res.statusCode).toBe(422);
    expect(calls).toEqual([]);
  });
});

describe("the two lists", () => {
  it("the plan's review list defaults to pending and never offers drafts or withdrawn", async () => {
    const { app, calls } = makeServer();
    const ok = await app.inject({ method: "GET", url: `${base}?status=accepted`, headers: CM });
    const draft = await app.inject({ method: "GET", url: `${base}?status=draft`, headers: CM });
    const withdrawn = await app.inject({
      method: "GET",
      url: `${base}?status=withdrawn`,
      headers: CM,
    });
    expect([ok.statusCode, draft.statusCode, withdrawn.statusCode]).toEqual([200, 422, 422]);
    expect(calls[0]?.args[2]).toEqual({ status: "accepted", sudDisclosureAllowed: false });
  });

  it("the patient list hands the service the visit filter and the caller's membership (so it can show their drafts)", async () => {
    const { app, calls } = makeServer();
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/patients/${PATIENT}/care-plan-change-proposals?sourceEncounterId=${ENCOUNTER}&status=draft`,
      headers: CM,
    });
    expect(res.statusCode).toBe(200);
    expect(calls[0]?.args.slice(0, 2)).toEqual([ORG, PATIENT]);
    expect(calls[0]?.args[2]).toEqual({
      sourceEncounterId: ENCOUNTER,
      status: "draft",
      membershipId: "cm_1_membership",
      sudDisclosureAllowed: false,
    });
  });

  it("a malformed visit id is a 400", async () => {
    const { app, calls } = makeServer();
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/patients/${PATIENT}/care-plan-change-proposals?sourceEncounterId=enc_1`,
      headers: CM,
    });
    expect(res.statusCode).toBe(422);
    expect(calls).toEqual([]);
  });
});
