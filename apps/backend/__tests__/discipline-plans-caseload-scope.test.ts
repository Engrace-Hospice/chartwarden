// apps/backend/__tests__/discipline-plans-caseload-scope.test.ts — GAP-046 (M15): every plan-bearing M15
// WRITE route (goals, interventions, assessments, finalize, sign, amend, supervisory, volunteer assignment)
// composes the shared `caseload_or_scope` predicate over the plan's PATIENT, with `notFoundOnDeny`, so an
// off-caseload key holder gets a non-leaking 404 and the write service is never reached. Org-wide scope roles
// are exempt, break-glass is read-only (a break-glass actor's write is still 404), and an unknown plan id is
// 404 before any other guard. Real M3 contract + M1 middleware over a stub write service (no live infra).
import {
  createInMemoryEffectivePermissionStore,
  createPredicateRegistry,
  registerAbacRegistry,
  registerEffectivePermissionResolver,
  resetAbacRegistry,
  resetAuthorizationContract,
  resetRbacEngine,
  setBreakGlassAuditHook,
  setBreakGlassChecker,
} from "@chartwarden/auth";
import type { FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import { buildCarePlanAbacPredicates } from "../src/modules/07-care-plan/abac-predicates";
import {
  M15_PERMISSION_KEY_LIST,
  mountM15Routes,
} from "../src/modules/15-discipline-care-plans/index";
import type {
  M15ReadService,
  M15WriteService,
} from "../src/modules/15-discipline-care-plans/routes/index";

function headerAuth(request: FastifyRequest): void {
  const user = request.headers["x-test-user"];
  if (typeof user !== "string" || user.length === 0) return;
  request.context.userId = user;
  request.context.attributes.membershipId = user;
  const org = request.headers["x-test-org"];
  request.context.organizationId = typeof org === "string" ? org : "";
  const roles = request.headers["x-test-roles"];
  request.context.roles = typeof roles === "string" && roles.length > 0 ? roles.split(",") : [];
}

const ORG = "org_a";
const PLAN = "11111111-1111-4111-8111-111111111111";
const MISSING_PLAN = "99999999-9999-4999-8999-999999999999";
const VERSION = "22222222-2222-4222-8222-222222222222";
const GOAL = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const INTERVENTION = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const ASSESSMENT = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const VISIT = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const ASSIGNMENT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PATIENT = "33333333-3333-4333-8333-333333333333";

/** userId → the patients on that user's caseload. rn_1 covers PATIENT; rn_2 covers nobody. */
const CASELOAD: Record<string, readonly string[]> = { rn_1: [PATIENT], rn_2: [], md_1: [] };

function makeServer() {
  const writeCalls: string[] = [];
  const planPatient = async (_org: string, planId: string) => (planId === PLAN ? PATIENT : null);
  // Every write method records itself and answers `{}`; only `planPatientId` is a real resolver.
  const writeService = new Proxy({} as Record<string, unknown>, {
    get: (_t, name: string) =>
      name === "planPatientId"
        ? planPatient
        : async () => {
            writeCalls.push(name);
            return {};
          },
  }) as unknown as M15WriteService;
  const readService = new Proxy({} as Record<string, unknown>, {
    get: () => async () => null,
  }) as unknown as M15ReadService;

  const store = createInMemoryEffectivePermissionStore(
    Object.keys(CASELOAD).map((userId) => ({
      orgId: ORG,
      userId,
      grants: [
        {
          roleKey: "seed",
          enabled: true,
          expiresAt: null,
          permissionKeys: [...M15_PERMISSION_KEY_LIST],
        },
      ],
    })),
  );
  registerEffectivePermissionResolver(store.store);

  const reg = createPredicateRegistry();
  const m7 = buildCarePlanAbacPredicates({
    resolver: {
      loadPlan: async () => null,
      loadProblem: async () => null,
      loadVersion: async () => null,
    },
    isInCaseload: async (q) => (CASELOAD[q.userId] ?? []).includes(q.patientId),
  });
  reg.register("caseload_or_scope", m7.caseload_or_scope);
  // The M15-owned predicates and step-up are permissive here: this file isolates the caseload gate.
  for (const name of [
    "aide_supervisor_eligible",
    "volunteer_compliance_active",
    "volunteer_coordinator_role",
    "step_up_recent",
  ]) {
    reg.register(name, async () => true);
  }
  registerAbacRegistry(reg);

  const app = buildServer({ authenticate: headerAuth, security: { rateLimitEnabled: false } });
  mountM15Routes(app, { readService, writeService });
  return { app, writeCalls };
}

const as = (user: string, roles = "rn_case_manager") => ({
  "x-test-user": user,
  "x-test-org": ORG,
  "x-test-roles": roles,
  "if-match": '"1"',
});
const RN1 = as("rn_1");
const RN2 = as("rn_2");
const MD = as("md_1", "medical_director");

const base = (planId: string) => `/api/v1/discipline-plans/${planId}`;
const WRITES = (planId: string): Array<[string, string, object]> => [
  ["POST", `${base(planId)}/versions/${VERSION}/finalize`, {}],
  ["POST", `${base(planId)}/versions/${VERSION}/sign`, { signerRole: "rn", attestationText: "x" }],
  ["POST", `${base(planId)}/goals`, {}],
  ["PATCH", `${base(planId)}/goals/${GOAL}`, {}],
  ["POST", `${base(planId)}/interventions`, {}],
  ["PATCH", `${base(planId)}/interventions/${INTERVENTION}`, {}],
  ["POST", `${base(planId)}/assessments`, {}],
  ["POST", `${base(planId)}/assessments/${ASSESSMENT}/sign`, {}],
  ["POST", `${base(planId)}/assessments/${ASSESSMENT}/amend`, {}],
  ["POST", `${base(planId)}/aide-supervisory-visits`, {}],
  ["POST", `${base(planId)}/aide-supervisory-visits/${VISIT}/sign`, {}],
  ["POST", `${base(planId)}/volunteer-assignments`, {}],
  ["PATCH", `${base(planId)}/volunteer-assignments/${ASSIGNMENT}`, {}],
];

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

let keySeq = 0;
async function fire(
  s: ReturnType<typeof makeServer>,
  method: string,
  url: string,
  headers: Record<string, string>,
  payload: object,
) {
  // A fresh Idempotency-Key per request: the M1 idempotency layer 409s a key reused across routes.
  const key = `k-${++keySeq}`;
  return s.app.inject({
    method: method as "POST" | "PATCH",
    url,
    headers: { ...headers, "idempotency-key": key },
    payload,
  });
}

describe("GAP-046 — M15 plan writes are caseload-scoped", () => {
  it("an off-caseload RN gets 404 on every plan write and the write service is never reached", async () => {
    const s = makeServer();
    for (const [method, url, payload] of WRITES(PLAN)) {
      const res = await fire(s, method, url, RN2, payload);
      expect(res.statusCode, `${method} ${url}`).toBe(404);
    }
    expect(s.writeCalls).toEqual([]);
    await s.app.close();
  });

  it("an unknown plan id is 404 (before the body is even validated)", async () => {
    const s = makeServer();
    for (const [method, url, payload] of WRITES(MISSING_PLAN)) {
      const res = await fire(s, method, url, RN1, payload);
      expect(res.statusCode, `${method} ${url}`).toBe(404);
    }
    expect(s.writeCalls).toEqual([]);
    await s.app.close();
  });

  it("an on-caseload RN passes the scope gate (never 404) on every plan write", async () => {
    const s = makeServer();
    for (const [method, url, payload] of WRITES(PLAN)) {
      const res = await fire(s, method, url, RN1, payload);
      expect(res.statusCode, `${method} ${url}`).not.toBe(404);
    }
    await s.app.close();
  });

  it("an org-wide scope role (medical_director) is exempt from the caseload gate", async () => {
    const s = makeServer();
    for (const [method, url, payload] of WRITES(PLAN)) {
      const res = await fire(s, method, url, MD, payload);
      expect(res.statusCode, `${method} ${url}`).not.toBe(404);
    }
    await s.app.close();
  });

  it("break-glass is read-only: an active break-glass actor's every plan write is still 404", async () => {
    const s = makeServer();
    setBreakGlassChecker((ctx) => (ctx.userId === "rn_2" ? { eventId: "bg-1" } : null));
    setBreakGlassAuditHook(() => {});
    for (const [method, url, payload] of WRITES(PLAN)) {
      const res = await fire(s, method, url, RN2, payload);
      expect(res.statusCode, `${method} ${url}`).toBe(404);
    }
    expect(s.writeCalls).toEqual([]);
    await s.app.close();
  });
});
