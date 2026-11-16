// apps/backend/__tests__/care-plan-hardening-routes.test.ts — M7 route/service hardening (no DB).
//
// Drives the REAL route table + the in-memory CarePlanRouteService through Fastify `inject` and proves the
// fixes the Drizzle service mirrors (those parts are in m7-care-plan-write.live.test.ts):
//   • every write route requires an Idempotency-Key, and a retried POST replays instead of duplicating;
//   • bootstrap binds the body admissionId to :patientId (and an active admission);
//   • body ids are uuids; a count>1 signer slot is refused at the edge;
//   • §2.2.3 terminal element rows are read-only (409 ILLEGAL_TRANSITION) and status moves follow the graph;
//   • §7.4 discipline_scope applies to PATCH / discontinue against the row's own discipline;
//   • §7.6 SUD content is redacted from every version projection (list, get, patient aggregate, finalize);
//   • a re-admitted patient reads the live plan, not the discharged plan 1;
//   • overdue-status binds :planId to ?patientId; CP-15 a stale ifVersion sign attaches nothing.
// Synthetic data only: the SUD problem text below is an invented string, not a patient value.
import { randomUUID } from "node:crypto";
import {
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
import { carePlanReaderDenyStub } from "../src/bootstrap/seams/providers";
import { __resetSeamsForTest, registerSeam } from "../src/bootstrap/seams/registry";
import {
  buildCarePlanAbacPredicates,
  createInMemoryCarePlanBackend,
  registerCarePlanRoutes,
} from "../src/modules/07-care-plan/index";
import {
  guardGoalStatusChange,
  guardProblemStatusChange,
} from "../src/modules/07-care-plan/routes/element-transitions";
import { redactStateSnapshot } from "../src/modules/07-care-plan/routes/snapshot-redaction";

const ORG = "org_a";
const PATIENT = "11111111-1111-4111-8111-111111111111";
const PATIENT_OTHER = "22222222-2222-4222-8222-222222222222";
const ADMISSION = "33333333-3333-4333-8333-333333333333";
const ADMISSION_2 = "44444444-4444-4444-8444-444444444444";
const ADMISSION_OF_OTHER = "55555555-5555-4555-8555-555555555555";
const ADMISSION_PENDING = "66666666-6666-4666-8666-666666666666";
const SUD_TEXT = "Opioid use disorder in remission (synthetic)";
const SUD_GOAL_TEXT = "Attend weekly recovery group (synthetic)";

function headerAuth(request: FastifyRequest): void {
  const user = request.headers["x-test-user"];
  if (typeof user !== "string" || user.length === 0) return;
  request.context.userId = user;
  request.context.organizationId = String(request.headers["x-test-org"] ?? "");
  const roles = request.headers["x-test-roles"];
  request.context.roles = typeof roles === "string" && roles.length > 0 ? roles.split(",") : [];
  request.context.attributes.membershipId = `${user}_membership`;
  request.context.attributes.stepUpRecent = request.headers["x-test-step-up"] === "true";
}

const PERMISSIONS = [
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
  { userId: "md_1", permissions: ["care_plan.read", "care_plan.sign"] },
  { userId: "msw_1", permissions: ["care_plan.read", "care_plan.author"] },
];

const RN = {
  "x-test-user": "rn_1",
  "x-test-org": ORG,
  "x-test-roles": "rn,rn_case_manager",
  "x-test-step-up": "true",
};
const RN_SUD_CLEARED = { ...RN, "x-test-roles": "rn,rn_case_manager,sud_cleared" };
const PHYSICIAN = {
  "x-test-user": "md_1",
  "x-test-org": ORG,
  "x-test-roles": "hospice_physician",
  "x-test-step-up": "true",
};
const MSW = { "x-test-user": "msw_1", "x-test-org": ORG, "x-test-roles": "msw" };

const key = (): { "idempotency-key": string } => ({ "idempotency-key": randomUUID() });

function makeServer(
  // The §7.6 closure: only a session carrying the (test) `sud_cleared` role may see SUD content.
  sudDisclosureAllowed: (input: { roles: readonly string[] }) => Promise<boolean> = async ({
    roles,
  }) => roles.includes("sud_cleared"),
) {
  const backend = createInMemoryCarePlanBackend();
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
  const predicates = buildCarePlanAbacPredicates({
    resolver: backend.resolver,
    isInCaseload: async () => true,
  });
  for (const [name, fn] of Object.entries(predicates)) registry.register(name, fn);
  registry.register("step_up_recent", async (context) => context.attributes.stepUpRecent === true);
  registerAbacRegistry(registry);

  const admissions = new Map<string, { patientId: string; status: string }>([
    [ADMISSION, { patientId: PATIENT, status: "active" }],
    [ADMISSION_2, { patientId: PATIENT, status: "active" }],
    [ADMISSION_OF_OTHER, { patientId: PATIENT_OTHER, status: "active" }],
    [ADMISSION_PENDING, { patientId: PATIENT, status: "pending" }],
  ]);
  const app = buildServer({ authenticate: headerAuth, security: { rateLimitEnabled: false } });
  registerCarePlanRoutes(app, {
    service: backend.service,
    sudDisclosureAllowed,
    admissionPatientCare: async (_org, admissionId) => admissions.get(admissionId) ?? null,
  });
  return { app, svc: backend.service };
}

/** Plan + initial draft version via the service (no HTTP), plus one terminal problem. */
async function seedPlan(svc: ReturnType<typeof makeServer>["svc"], patientId = PATIENT) {
  const boot = (await svc.bootstrapCarePlan(ORG, patientId, ADMISSION)) as {
    id: string;
    initialVersionId: string;
  };
  const problem = await svc.addProblem(ORG, boot.id, {
    description: "Terminal CA (synthetic)",
    kind: "terminal",
    source: "clinical",
  });
  return { planId: boot.id, versionId: boot.initialVersionId, problemId: problem.id };
}

beforeEach(() => {
  resetAuthorizationContract();
  resetRbacEngine();
});
afterEach(() => {
  resetAuthorizationContract();
  resetRbacEngine();
  __resetSeamsForTest();
});

describe("every M7 write route requires an Idempotency-Key (#13)", () => {
  it("answers 400 IDEMPOTENCY_KEY_REQUIRED on each POST write route when the key is absent", async () => {
    const { app, svc } = makeServer();
    const { planId, versionId, problemId } = await seedPlan(svc);
    const goal = await svc.addGoal(
      ORG,
      planId,
      { problemId, originalText: "Comfort at home", source: "clinical" },
      false,
    );
    const intervention = await svc.addIntervention(ORG, planId, {
      problemId,
      scopeText: "Pain reassessment",
      frequencyText: "weekly",
      frequencyValue: "1/week",
      discipline: "rn",
    });
    const base = `/api/v1/care-plans/${planId}`;
    const routes: ReadonlyArray<readonly [string, unknown, Record<string, string>]> = [
      [`/api/v1/patients/${PATIENT_OTHER}/care-plan`, { admissionId: ADMISSION_OF_OTHER }, RN],
      [`${base}/versions`, { kind: "interim_revision" }, RN],
      [`${base}/versions/${versionId}/finalize`, { ifVersion: 1 }, RN],
      [
        `${base}/versions/${versionId}/signatures`,
        { ifVersion: 2, signerRole: "rn_case_manager" },
        RN,
      ],
      [`${base}/versions/${versionId}/return-to-draft`, { ifVersion: 1 }, RN],
      [`${base}/problems`, { description: "x", kind: "related", source: "clinical" }, RN],
      [`${base}/problems/${problemId}/resolve`, { ifVersion: 1, resolutionNote: "done" }, RN],
      [`${base}/goals`, { problemId, originalText: "g", source: "clinical" }, RN],
      [
        `${base}/interventions`,
        {
          problemId,
          scopeText: "s",
          frequencyText: "weekly",
          frequencyValue: "1/week",
          discipline: "rn",
        },
        RN,
      ],
      [`${base}/interventions/${intervention.id}/discontinue`, { ifVersion: 1, reason: "r" }, RN],
    ];
    expect(goal.id).toBeTruthy();
    for (const [url, payload, headers] of routes) {
      const res = await app.inject({ method: "POST", url, headers, payload: payload as object });
      expect(res.statusCode, `${url}: ${res.body}`).toBe(400);
      expect(res.json().error.code).toBe("IDEMPOTENCY_KEY_REQUIRED");
    }
  });

  it("a retried POST under the same key replays the first answer: one problem, not two", async () => {
    const { app, svc } = makeServer();
    const { planId } = await seedPlan(svc);
    const headers = { ...RN, ...key() };
    const payload = { description: "Dyspnea (synthetic)", kind: "related", source: "clinical" };
    const first = await app.inject({
      method: "POST",
      url: `/api/v1/care-plans/${planId}/problems`,
      headers,
      payload,
    });
    const retry = await app.inject({
      method: "POST",
      url: `/api/v1/care-plans/${planId}/problems`,
      headers,
      payload,
    });
    expect(first.statusCode).toBe(201);
    expect(retry.statusCode).toBe(201);
    expect(retry.json().id).toBe(first.json().id);
    const aggregate = (await svc.getCarePlanForPatient(ORG, PATIENT)) as { problems: unknown[] };
    expect(aggregate.problems).toHaveLength(2); // the seeded terminal problem + exactly one new one
  });
});

describe("bootstrap binds the body admissionId to :patientId (#9)", () => {
  const boot = (
    app: ReturnType<typeof makeServer>["app"],
    patientId: string,
    admissionId: string,
  ) =>
    app.inject({
      method: "POST",
      url: `/api/v1/patients/${patientId}/care-plan`,
      headers: { ...RN, ...key() },
      payload: { admissionId },
    });

  it("404 when the admission belongs to ANOTHER patient (no plan is created)", async () => {
    const { app, svc } = makeServer();
    const res = await boot(app, PATIENT, ADMISSION_OF_OTHER);
    expect(res.statusCode).toBe(404);
    expect(await svc.getCarePlanForPatient(ORG, PATIENT)).toBeNull();
  });

  it("404 for an unknown admission", async () => {
    const { app } = makeServer();
    expect((await boot(app, PATIENT, randomUUID())).statusCode).toBe(404);
  });

  it("422 CARE_PLAN_NOT_READY when the admission is not active", async () => {
    const { app } = makeServer();
    const res = await boot(app, PATIENT, ADMISSION_PENDING);
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("CARE_PLAN_NOT_READY");
  });

  it("201 for the patient's own active admission", async () => {
    const { app } = makeServer();
    expect((await boot(app, PATIENT, ADMISSION)).statusCode).toBe(201);
  });
});

describe("edge validation (#10, #11a)", () => {
  it("422 VALIDATION_FAILED for a non-uuid goal problemId, a non-uuid intervention problemId and non-uuid goalRefs", async () => {
    const { app, svc } = makeServer();
    const { planId, problemId } = await seedPlan(svc);
    const goal = await app.inject({
      method: "POST",
      url: `/api/v1/care-plans/${planId}/goals`,
      headers: { ...RN, ...key() },
      payload: { problemId: "prob_1", originalText: "g", source: "clinical" },
    });
    const intervention = await app.inject({
      method: "POST",
      url: `/api/v1/care-plans/${planId}/interventions`,
      headers: { ...RN, ...key() },
      payload: {
        problemId: "not-a-uuid",
        scopeText: "s",
        frequencyText: "weekly",
        frequencyValue: "1/week",
        discipline: "rn",
      },
    });
    const goalRefs = await app.inject({
      method: "POST",
      url: `/api/v1/care-plans/${planId}/interventions`,
      headers: { ...RN, ...key() },
      payload: {
        problemId,
        goalRefs: ["goal_1"],
        scopeText: "s",
        frequencyText: "weekly",
        frequencyValue: "1/week",
        discipline: "rn",
      },
    });
    expect([goal.statusCode, intervention.statusCode, goalRefs.statusCode]).toEqual([
      422, 422, 422,
    ]);
    for (const res of [goal, intervention, goalRefs]) {
      expect(res.json().error.code).toBe("VALIDATION_FAILED");
    }
  });

  it("422 VALIDATION_FAILED for a requiredSignerSet slot with count 2 (one live signature per role would deadlock it)", async () => {
    const { app, svc } = makeServer();
    const { planId, versionId } = await seedPlan(svc);
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/care-plans/${planId}/versions/${versionId}/finalize`,
      headers: { ...RN, ...key() },
      payload: { ifVersion: 1, requiredSignerSet: [{ role: "rn_case_manager", count: 2 }] },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("VALIDATION_FAILED");
  });
});

describe("§2.2.3 terminal element rows are read-only (#5)", () => {
  it("re-POST /resolve is 409 ILLEGAL_TRANSITION and does not overwrite the first resolution", async () => {
    const { app, svc } = makeServer();
    const { planId, problemId } = await seedPlan(svc);
    const url = `/api/v1/care-plans/${planId}/problems/${problemId}/resolve`;
    const first = await app.inject({
      method: "POST",
      url,
      headers: { ...RN, ...key() },
      payload: { ifVersion: 1, resolutionNote: "first note" },
    });
    expect(first.statusCode).toBe(200);
    const again = await app.inject({
      method: "POST",
      url,
      headers: { ...RN, ...key() },
      payload: { ifVersion: 2, resolutionNote: "overwrite attempt" },
    });
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe("ILLEGAL_TRANSITION");
    const aggregate = (await svc.getCarePlanForPatient(ORG, PATIENT)) as {
      problems: { resolutionNote: string }[];
    };
    expect(aggregate.problems[0]?.resolutionNote).toBe("first note");
  });

  it("PATCH on a resolved problem is 409", async () => {
    const { app, svc } = makeServer();
    const { planId, problemId } = await seedPlan(svc);
    await svc.resolveProblem(ORG, planId, problemId, 1, "done");
    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/care-plans/${planId}/problems/${problemId}`,
      headers: { ...RN, ...key(), "if-match": "2" },
      payload: { description: "edited after resolve" },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("ILLEGAL_TRANSITION");
  });

  it("a goal cannot jump not_started → met, can walk the graph, and a met goal is read-only", async () => {
    const { app, svc } = makeServer();
    const { planId, problemId } = await seedPlan(svc);
    const goal = await svc.addGoal(
      ORG,
      planId,
      { problemId, originalText: "Walk to the mailbox", source: "clinical" },
      false,
    );
    const patch = (version: number, payload: object) =>
      app.inject({
        method: "PATCH",
        url: `/api/v1/care-plans/${planId}/goals/${goal.id}`,
        headers: { ...RN, ...key(), "if-match": String(version) },
        payload,
      });
    expect((await patch(1, { status: "met" })).statusCode).toBe(409);
    expect((await patch(1, { status: "in_progress" })).statusCode).toBe(200);
    expect((await patch(2, { status: "met" })).statusCode).toBe(200);
    const edit = await patch(3, { revisedText: "edit after met" });
    expect(edit.statusCode).toBe(409);
    expect(edit.json().error.code).toBe("ILLEGAL_TRANSITION");
  });

  it("an intervention discontinued once cannot be discontinued or edited again", async () => {
    const { app, svc } = makeServer();
    const { planId, problemId } = await seedPlan(svc);
    const intervention = await svc.addIntervention(ORG, planId, {
      problemId,
      scopeText: "Pain reassessment",
      frequencyText: "weekly",
      frequencyValue: "1/week",
      discipline: "rn",
    });
    const base = `/api/v1/care-plans/${planId}/interventions/${intervention.id}`;
    const first = await app.inject({
      method: "POST",
      url: `${base}/discontinue`,
      headers: { ...RN, ...key() },
      payload: { ifVersion: 1, reason: "patient declined" },
    });
    expect(first.statusCode).toBe(200);
    const again = await app.inject({
      method: "POST",
      url: `${base}/discontinue`,
      headers: { ...RN, ...key() },
      payload: { ifVersion: 2, reason: "again" },
    });
    const edit = await app.inject({
      method: "PATCH",
      url: base,
      headers: { ...RN, ...key(), "if-match": "2" },
      payload: { scopeText: "edited after discontinue" },
    });
    expect([again.statusCode, edit.statusCode]).toEqual([409, 409]);
  });
});

describe("element lifecycle guards (pure)", () => {
  it("refuses re-opening a resolved problem and any edit to a terminal problem", () => {
    expect(guardProblemStatusChange("active", "resolved", "n")).toBe("resolved");
    expect(guardProblemStatusChange("active", "inactive", "n")).toBe("inactive");
    expect(guardProblemStatusChange("active", undefined, "n")).toBe("active");
    expect(() => guardProblemStatusChange("resolved", "active", "n")).toThrowError(/terminal/);
    expect(() => guardProblemStatusChange("resolved", "resolved", "n")).toThrowError(/terminal/);
  });

  it("walks the goal graph and refuses everything else", () => {
    expect(guardGoalStatusChange("not_started", "in_progress")).toBe("in_progress");
    expect(guardGoalStatusChange("in_progress", "revised")).toBe("revised");
    expect(guardGoalStatusChange("revised", "in_progress")).toBe("in_progress");
    expect(guardGoalStatusChange("in_progress", "in_progress")).toBe("in_progress"); // unchanged = no-op
    expect(() => guardGoalStatusChange("not_started", "met")).toThrowError(/goal cannot/);
    expect(() => guardGoalStatusChange("in_progress", "not_started")).toThrowError(/goal cannot/);
    expect(() => guardGoalStatusChange("met", "in_progress")).toThrowError(/terminal/);
    expect(() => guardGoalStatusChange("in_progress", "bogus")).toThrowError(/goal cannot/);
  });
});

describe("§7.4 discipline_scope on PATCH / discontinue (#12)", () => {
  it("an MSW author cannot edit or discontinue an RN intervention (403)", async () => {
    const { app, svc } = makeServer();
    const { planId, problemId } = await seedPlan(svc);
    const intervention = await svc.addIntervention(ORG, planId, {
      problemId,
      scopeText: "Pain reassessment",
      frequencyText: "weekly",
      frequencyValue: "1/week",
      discipline: "rn",
    });
    const base = `/api/v1/care-plans/${planId}/interventions/${intervention.id}`;
    const patch = await app.inject({
      method: "PATCH",
      url: base,
      headers: { ...MSW, ...key(), "if-match": "1" },
      payload: { scopeText: "hijacked" },
    });
    const discontinue = await app.inject({
      method: "POST",
      url: `${base}/discontinue`,
      headers: { ...MSW, ...key() },
      payload: { ifVersion: 1, reason: "hijack" },
    });
    expect([patch.statusCode, discontinue.statusCode]).toEqual([403, 403]);
    expect(patch.json().error.code).toBe("DISCIPLINE_SCOPE_VIOLATION");
    // …and the RN who owns the discipline still can.
    const ok = await app.inject({
      method: "PATCH",
      url: base,
      headers: { ...RN, ...key(), "if-match": "1" },
      payload: { scopeText: "Pain reassessment twice weekly" },
    });
    expect(ok.statusCode).toBe(200);
  });
});

describe("§7.6 SUD content is redacted from every version projection (#2)", () => {
  async function planWithFinalizedSudSnapshot() {
    const { app, svc } = makeServer();
    const { planId, versionId, problemId } = await seedPlan(svc);
    const sud = await svc.addProblem(ORG, planId, {
      description: SUD_TEXT,
      kind: "related",
      source: "clinical",
      sudRelated: true,
    });
    await svc.addGoal(
      ORG,
      planId,
      { problemId: sud.id, originalText: SUD_GOAL_TEXT, source: "clinical" },
      false,
    );
    await svc.addGoal(
      ORG,
      planId,
      { problemId, originalText: "Comfort at home", source: "clinical" },
      false,
    );
    return { app, svc, planId, versionId };
  }

  const finalize = (
    app: ReturnType<typeof makeServer>["app"],
    planId: string,
    versionId: string,
    headers: Record<string, string>,
  ) =>
    app.inject({
      method: "POST",
      url: `/api/v1/care-plans/${planId}/versions/${versionId}/finalize`,
      headers: { ...headers, ...key() },
      payload: { ifVersion: 1 },
    });

  it("a caller without Part 2 disclosure gets no SUD text from finalize, versions, version, or the aggregate", async () => {
    const { app, planId, versionId } = await planWithFinalizedSudSnapshot();
    const responses = [
      await finalize(app, planId, versionId, RN),
      await app.inject({
        method: "GET",
        url: `/api/v1/care-plans/${planId}/versions`,
        headers: RN,
      }),
      await app.inject({
        method: "GET",
        url: `/api/v1/care-plans/${planId}/versions/${versionId}`,
        headers: RN,
      }),
      await app.inject({
        method: "GET",
        url: `/api/v1/patients/${PATIENT}/care-plan`,
        headers: RN,
      }),
    ];
    for (const res of responses) {
      expect(res.statusCode).toBeLessThan(300);
      expect(res.body).not.toContain(SUD_TEXT);
      expect(res.body).not.toContain(SUD_GOAL_TEXT);
    }
    // The non-SUD content is still there, so the redaction is a filter and not a blanket null.
    expect(responses[2]?.body).toContain("Comfort at home");
    expect(responses[2]?.body).toContain("Terminal CA (synthetic)");
  });

  it("a failing disclosure lookup does not fail a committed finalize and leaks no SUD text", async () => {
    // The lookup runs before the write, so an outage there must degrade to the redacted view, not a 500.
    const { app, svc } = makeServer(async () => {
      throw new Error("consent store unavailable");
    });
    const { planId, versionId } = await seedPlan(svc);
    await svc.addProblem(ORG, planId, {
      description: SUD_TEXT,
      kind: "related",
      source: "clinical",
      sudRelated: true,
    });
    const res = await finalize(app, planId, versionId, RN_SUD_CLEARED);
    expect(res.statusCode).toBeLessThan(300);
    expect(res.body).not.toContain(SUD_TEXT);
    expect(res.body).toContain("Terminal CA (synthetic)");
  });

  it("the service redacts a finalize result for a caller that names no viewer", async () => {
    const { svc } = makeServer();
    const { planId, versionId } = await seedPlan(svc);
    await svc.addProblem(ORG, planId, {
      description: SUD_TEXT,
      kind: "related",
      source: "clinical",
      sudRelated: true,
    });
    const result = await svc.finalizeVersion(ORG, planId, versionId, 1, null);
    expect(JSON.stringify(result)).not.toContain(SUD_TEXT);
  });

  it("a caller WITH disclosure sees the full snapshot on each projection", async () => {
    const { app, planId, versionId } = await planWithFinalizedSudSnapshot();
    const fin = await finalize(app, planId, versionId, RN_SUD_CLEARED);
    const list = await app.inject({
      method: "GET",
      url: `/api/v1/care-plans/${planId}/versions`,
      headers: RN_SUD_CLEARED,
    });
    const one = await app.inject({
      method: "GET",
      url: `/api/v1/care-plans/${planId}/versions/${versionId}`,
      headers: RN_SUD_CLEARED,
    });
    for (const res of [fin, list, one]) {
      expect(res.body).toContain(SUD_TEXT);
      expect(res.body).toContain(SUD_GOAL_TEXT);
    }
  });

  it("redactStateSnapshot fails closed on a malformed snapshot and keeps non-SUD rows", () => {
    expect(redactStateSnapshot({ unexpected: true }, false)).toBeNull();
    expect(redactStateSnapshot("not-an-object", false)).toBeNull();
    expect(redactStateSnapshot(null, false)).toBeNull();
    expect(redactStateSnapshot({ unexpected: true }, true)).toEqual({ unexpected: true });
    const redacted = redactStateSnapshot(
      {
        problems: [
          { id: "p1", sudRelated: false, description: "keep" },
          { id: "p2", sudRelated: true, description: "drop" },
        ],
        goals: [
          { id: "g1", problemId: "p1" },
          { id: "g2", problemId: "p2" },
        ],
        interventions: [{ id: "i2", problemId: "p2" }],
      },
      false,
    ) as { problems: { id: string }[]; goals: { id: string }[]; interventions: unknown[] };
    expect(redacted.problems.map((p) => p.id)).toEqual(["p1"]);
    expect(redacted.goals.map((g) => g.id)).toEqual(["g1"]);
    expect(redacted.interventions).toEqual([]);
  });

  it("redactStateSnapshot treats a problem whose sudRelated is not the literal false as Part 2 (fail closed per problem)", () => {
    const redacted = redactStateSnapshot(
      {
        problems: [
          { id: "p1", sudRelated: false, description: "keep" },
          { id: "p-missing", description: "no flag at all" },
          { id: "p-string", sudRelated: "false", description: "mangled flag" },
          "not-an-object",
        ],
        goals: [
          { id: "g1", problemId: "p1" },
          { id: "g-missing", problemId: "p-missing" },
        ],
        interventions: [{ id: "i-missing", problemId: "p-missing" }],
      },
      false,
    ) as { problems: { id: string }[]; goals: { id: string }[]; interventions: unknown[] };
    expect(redacted.problems.map((p) => p.id)).toEqual(["p1"]);
    expect(redacted.goals.map((g) => g.id)).toEqual(["g1"]);
    expect(redacted.interventions).toEqual([]);
  });
});

describe("a re-admitted patient reads the live plan, not discharged plan 1 (#3)", () => {
  it("returns plan 2 after discharge + readmission, and plan 1 only while plan 2 does not exist", async () => {
    const { app, svc } = makeServer();
    const plan1 = (await svc.bootstrapCarePlan(ORG, PATIENT, ADMISSION)) as { id: string };
    await svc.closeCarePlanForAdmission(ORG, ADMISSION, "discharged", "2026-07-01T00:00:00.000Z");
    const afterDischarge = await app.inject({
      method: "GET",
      url: `/api/v1/patients/${PATIENT}/care-plan`,
      headers: RN,
    });
    expect(afterDischarge.json().id).toBe(plan1.id); // every plan discharged → the newest still reads

    const plan2 = (await svc.bootstrapCarePlan(ORG, PATIENT, ADMISSION_2)) as { id: string };
    const afterReadmit = await app.inject({
      method: "GET",
      url: `/api/v1/patients/${PATIENT}/care-plan`,
      headers: RN,
    });
    expect(afterReadmit.json().id).toBe(plan2.id);
    expect(afterReadmit.json().status).toBe("draft");
    expect(afterReadmit.json().admissionId).toBe(ADMISSION_2);

    // …and plan 2 accepts writes (they were all CARE_PLAN_CLOSED while plan 1 was the one the UI held).
    const write = await app.inject({
      method: "POST",
      url: `/api/v1/care-plans/${plan2.id}/problems`,
      headers: { ...RN, ...key() },
      payload: { description: "Terminal CA (synthetic)", kind: "terminal", source: "clinical" },
    });
    expect(write.statusCode).toBe(201);
  });
});

describe("overdue-status binds :planId to ?patientId (#20 ii)", () => {
  it("404 when the plan is another patient's; the guard admits the patient's own plan", async () => {
    // The default reader is a deny-stub (501); answer for real so "let through" is asserted as 200, not "not 404".
    registerSeam("CarePlanReader", {
      ...carePlanReaderDenyStub,
      isReviewOverdue: async () => ({ patientId: PATIENT, isReviewOverdue: false }) as never,
    });
    const { app, svc } = makeServer();
    const mine = (await svc.bootstrapCarePlan(ORG, PATIENT, ADMISSION)) as { id: string };
    const theirs = (await svc.bootstrapCarePlan(ORG, PATIENT_OTHER, ADMISSION_OF_OTHER)) as {
      id: string;
    };
    const foreign = await app.inject({
      method: "GET",
      url: `/api/v1/care-plans/${theirs.id}/overdue-status?patientId=${PATIENT}`,
      headers: RN,
    });
    const unknown = await app.inject({
      method: "GET",
      url: `/api/v1/care-plans/cp_does_not_exist/overdue-status?patientId=${PATIENT}`,
      headers: RN,
    });
    const own = await app.inject({
      method: "GET",
      url: `/api/v1/care-plans/${mine.id}/overdue-status?patientId=${PATIENT}`,
      headers: RN,
    });
    expect([foreign.statusCode, unknown.statusCode]).toEqual([404, 404]);
    const malformed = await app.inject({
      method: "GET",
      url: `/api/v1/care-plans/not-a-uuid/overdue-status?patientId=${PATIENT}`,
      headers: RN,
    });
    expect(malformed.statusCode).toBe(404);
    expect(own.statusCode).toBe(200);
  });
});

describe("CP-15 — a stale ifVersion sign is rejected and attaches nothing", () => {
  it("409 STALE_VERSION, no signature on the version, and the current version still signs", async () => {
    const { app, svc } = makeServer();
    const { planId, versionId } = await seedPlan(svc);
    await svc.finalizeVersion(ORG, planId, versionId, 1, null); // version is now 2
    const sign = (ifVersion: number) =>
      app.inject({
        method: "POST",
        url: `/api/v1/care-plans/${planId}/versions/${versionId}/signatures`,
        headers: { ...PHYSICIAN, ...key() },
        payload: { ifVersion, signerRole: "hospice_physician" },
      });

    const stale = await sign(1);
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe("STALE_VERSION");
    const after = await app.inject({
      method: "GET",
      url: `/api/v1/care-plans/${planId}/versions/${versionId}`,
      headers: RN,
    });
    expect(after.json().signatures).toEqual([]);
    expect(after.json().version).toBe(2); // untouched

    expect((await sign(2)).statusCode).toBe(201);
  });
});
