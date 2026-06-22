// apps/backend/__tests__/care-plan-routes.test.ts — M7-T05 route-inventory + §7.7 optimistic-concurrency
// + §4.1.1 (M07-F09) Idempotency-Key tests (M7 spec §4.1, §4.1.1, §4.5, §7.7).
//
// Exercises M7's routes through the FULL M1 middleware chain via Fastify `inject`, no live infra:
// buildServer() mounts the host (incl. the platform `applyIdempotency` middleware), registerCarePlanRoutes()
// mounts the §4.1 inventory over the in-memory care-plan backend. The REAL Authorization Contract gates
// every route on the §4.5 keys; a header-auth shim populates request.context. Covers: RBAC gating
// (2xx with key, 403 without), the §7.7 two-writer optimistic-concurrency race (412 on the stale write),
// and §4.1.1 PATCH header enforcement (400 missing Idempotency-Key, 428 missing If-Match, replay, 409 body mismatch).
import {
  createInMemoryEffectivePermissionStore,
  registerAbacRegistry,
  registerEffectivePermissionResolver,
  resetAuthorizationContract,
  resetRbacEngine,
} from "@wardenx/auth";
import type { FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import {
  createInMemoryCarePlanBackend,
  registerCarePlanRoutes,
} from "../src/modules/07-care-plan/index";

function headerAuth(request: FastifyRequest): void {
  const user = request.headers["x-test-user"];
  if (typeof user !== "string" || user.length === 0) return;
  request.context.userId = user;
  const org = request.headers["x-test-org"];
  request.context.organizationId = typeof org === "string" ? org : "";
  const roles = request.headers["x-test-roles"];
  request.context.roles = typeof roles === "string" && roles.length > 0 ? roles.split(",") : [];
}

const ORG = "org_a";
const ORG_B = "org_b";
const PLAN = "cp_seed";
const PLAN_B = "cp_seed_b";
const PATIENT = "11111111-1111-4111-8111-111111111111";
const PATIENT_NEW = "22222222-2222-4222-8222-222222222222";
const ADMISSION = "33333333-3333-4333-8333-333333333333";

const PERMISSION_SEED = [
  {
    userId: "rn_1",
    permissions: [
      "care_plan.read",
      "care_plan.read_summary",
      "care_plan.bootstrap",
      "care_plan.author",
      "care_plan.finalize",
      "care_plan.sign",
    ],
  },
  { userId: "viewer_1", permissions: ["care_plan.read"] },
];

function makeServer() {
  const backend = createInMemoryCarePlanBackend({
    plans: [
      { id: PLAN, organizationId: ORG, patientId: PATIENT, status: "draft" },
      { id: PLAN_B, organizationId: ORG_B, patientId: PATIENT, status: "draft" },
    ],
  });

  const grantStore = createInMemoryEffectivePermissionStore(
    PERMISSION_SEED.flatMap((s) =>
      [ORG, ORG_B].map((org) => ({
        orgId: org,
        userId: s.userId,
        grants: [
          { roleKey: "seed", enabled: true, expiresAt: null, permissionKeys: s.permissions },
        ],
      })),
    ),
  );
  registerEffectivePermissionResolver(grantStore.store);
  registerAbacRegistry();

  const app = buildServer({ authenticate: headerAuth, security: { rateLimitEnabled: false } });
  registerCarePlanRoutes(app, { service: backend.service });
  return { app, backend };
}

const RN = { "x-test-user": "rn_1", "x-test-org": ORG, "x-test-roles": "rn_case_manager" };
const VIEWER = { "x-test-user": "viewer_1", "x-test-org": ORG, "x-test-roles": "auditor" };

beforeEach(() => {
  resetAuthorizationContract();
  resetRbacEngine();
});
afterEach(() => {
  resetAuthorizationContract();
  resetRbacEngine();
});

describe("M7-T05 — care-plan routes (§4.1, §4.5 gating)", () => {
  it("POST /patients/:id/care-plan bootstraps a plan for an authorized author (201)", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/patients/${PATIENT_NEW}/care-plan`,
      headers: RN,
      payload: { admissionId: ADMISSION },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().id).toMatch(/^cp_/);
  });

  it("403 when the caller lacks care_plan.author", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/care-plans/${PLAN}/problems`,
      headers: VIEWER,
      payload: { description: "Terminal CA", kind: "terminal", source: "clinical" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("GET reads are visible to a read-only viewer (200)", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/patients/${PATIENT}/care-plan`,
      headers: VIEWER,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().id).toBe(PLAN);
  });

  it("§6.6 cross-tenant plan is a non-leaking 404", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/care-plans/${PLAN_B}/versions`,
      headers: RN,
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("M7-T05 — §7.7 optimistic concurrency (two-writer race → 412)", () => {
  async function seedGoal(app: ReturnType<typeof makeServer>["app"]) {
    const problem = await app.inject({
      method: "POST",
      url: `/api/v1/care-plans/${PLAN}/problems`,
      headers: RN,
      payload: { description: "Pain", kind: "terminal", source: "clinical" },
    });
    const problemId = problem.json().id as string;
    const goal = await app.inject({
      method: "POST",
      url: `/api/v1/care-plans/${PLAN}/goals`,
      headers: RN,
      payload: { problemId, originalText: "Comfort at home", source: "clinical" },
    });
    return goal.json().id as string;
  }

  it("RN A wins; RN B's stale If-Match is refused with 412; B reloads and succeeds", async () => {
    const { app } = makeServer();
    const goalId = await seedGoal(app);

    // Both read v=1. RN A patches first (If-Match: 1 → v=2).
    const a = await app.inject({
      method: "PATCH",
      url: `/api/v1/care-plans/${PLAN}/goals/${goalId}`,
      headers: { ...RN, "if-match": "1", "idempotency-key": "k-a" },
      payload: { status: "in_progress" },
    });
    expect(a.statusCode).toBe(200);
    expect(a.json().version).toBe(2);

    // RN B patches with the stale version it read (If-Match: 1) → 412 STALE_VERSION, no overwrite.
    const bStale = await app.inject({
      method: "PATCH",
      url: `/api/v1/care-plans/${PLAN}/goals/${goalId}`,
      headers: { ...RN, "if-match": "1", "idempotency-key": "k-b1" },
      payload: { revisedText: "Comfort with family" },
    });
    expect(bStale.statusCode).toBe(412);
    expect(bStale.json().error.code).toBe("STALE_VERSION");

    // RN B reloads (v=2) and succeeds → v=3. No data silently overwritten.
    const bRetry = await app.inject({
      method: "PATCH",
      url: `/api/v1/care-plans/${PLAN}/goals/${goalId}`,
      headers: { ...RN, "if-match": "2", "idempotency-key": "k-b2" },
      payload: { revisedText: "Comfort with family" },
    });
    expect(bRetry.statusCode).toBe(200);
    expect(bRetry.json().version).toBe(3);
  });
});

describe("M7-T05 — §4.1.1 (M07-F09) Idempotency-Key + If-Match enforcement", () => {
  async function seedProblem(app: ReturnType<typeof makeServer>["app"]) {
    const problem = await app.inject({
      method: "POST",
      url: `/api/v1/care-plans/${PLAN}/problems`,
      headers: RN,
      payload: { description: "Dyspnea", kind: "related", source: "clinical" },
    });
    return problem.json().id as string;
  }

  it("400 when a PATCH omits the Idempotency-Key header", async () => {
    const { app } = makeServer();
    const problemId = await seedProblem(app);
    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/care-plans/${PLAN}/problems/${problemId}`,
      headers: { ...RN, "if-match": "1" },
      payload: { description: "Dyspnea on exertion" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("IDEMPOTENCY_KEY_REQUIRED");
  });

  it("428 when a PATCH omits the If-Match header", async () => {
    const { app } = makeServer();
    const problemId = await seedProblem(app);
    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/care-plans/${PLAN}/problems/${problemId}`,
      headers: { ...RN, "idempotency-key": "k-nomatch" },
      payload: { description: "Dyspnea on exertion" },
    });
    expect(res.statusCode).toBe(428);
    expect(res.json().error.code).toBe("PRECONDITION_REQUIRED");
  });

  it("replays the cached response on retry with the same key + body (no re-execute)", async () => {
    const { app } = makeServer();
    const problemId = await seedProblem(app);
    const first = await app.inject({
      method: "PATCH",
      url: `/api/v1/care-plans/${PLAN}/problems/${problemId}`,
      headers: { ...RN, "if-match": "1", "idempotency-key": "k-replay" },
      payload: { description: "Dyspnea on exertion" },
    });
    expect(first.statusCode).toBe(200);
    expect(first.json().version).toBe(2);

    // Same key + same body: the M1 idempotency middleware returns the cached response (version stays 2,
    // not 412 — the handler did NOT re-run the stale If-Match check against the now-advanced row).
    const replay = await app.inject({
      method: "PATCH",
      url: `/api/v1/care-plans/${PLAN}/problems/${problemId}`,
      headers: { ...RN, "if-match": "1", "idempotency-key": "k-replay" },
      payload: { description: "Dyspnea on exertion" },
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json().version).toBe(2);
  });

  it("409 on retry with the same key but a different body", async () => {
    const { app } = makeServer();
    const problemId = await seedProblem(app);
    await app.inject({
      method: "PATCH",
      url: `/api/v1/care-plans/${PLAN}/problems/${problemId}`,
      headers: { ...RN, "if-match": "1", "idempotency-key": "k-mismatch" },
      payload: { description: "Dyspnea on exertion" },
    });
    const mismatch = await app.inject({
      method: "PATCH",
      url: `/api/v1/care-plans/${PLAN}/problems/${problemId}`,
      headers: { ...RN, "if-match": "1", "idempotency-key": "k-mismatch" },
      payload: { description: "A DIFFERENT description" },
    });
    expect(mismatch.statusCode).toBe(409);
  });
});

describe("M7-T05 — version sign-off quorum (§2.3 / D5)", () => {
  it("two required signatures flip an initial version to signed and activate the plan", async () => {
    const { app, backend } = makeServer();
    // bootstrap a fresh plan (opens an initial draft version) + add a problem to it.
    const boot = await app.inject({
      method: "POST",
      url: `/api/v1/patients/${PATIENT_NEW}/care-plan`,
      headers: RN,
      payload: { admissionId: ADMISSION },
    });
    const planId = boot.json().id as string;
    const versionId = boot.json().initialVersionId as string;
    await app.inject({
      method: "POST",
      url: `/api/v1/care-plans/${planId}/problems`,
      headers: RN,
      payload: { description: "Terminal CA", kind: "terminal", source: "clinical" },
    });
    // finalize draft → in_review (v=1 → v=2).
    const finalize = await app.inject({
      method: "POST",
      url: `/api/v1/care-plans/${planId}/versions/${versionId}/finalize`,
      headers: RN,
      payload: { ifVersion: 1 },
    });
    expect(finalize.statusCode).toBe(200);
    expect(finalize.json().status).toBe("in_review");

    // first signer (physician|NP slot).
    const sig1 = await app.inject({
      method: "POST",
      url: `/api/v1/care-plans/${planId}/versions/${versionId}/signatures`,
      headers: RN,
      payload: { ifVersion: 2, signerRole: "hospice_physician" },
    });
    expect(sig1.statusCode).toBe(201);
    expect(sig1.json().status).toBe("in_review"); // quorum not yet met

    // second signer (RN case manager) completes the quorum → signed.
    const sig2 = await app.inject({
      method: "POST",
      url: `/api/v1/care-plans/${planId}/versions/${versionId}/signatures`,
      headers: RN,
      payload: { ifVersion: 3, signerRole: "rn_case_manager" },
    });
    expect(sig2.statusCode).toBe(201);
    expect(sig2.json().status).toBe("signed");

    const plan = (await backend.service.getCarePlanForPatient(ORG, PATIENT_NEW)) as {
      status: string;
    };
    expect(plan.status).toBe("active");
  });
});
