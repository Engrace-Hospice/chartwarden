// M41 commercial eligibility and enrollment over the route stack and the REAL Authorization Contract, with the REAL services over
// in-memory fakes (the rules are proven in the module's unit tests, the SQL by m41-commercial-eligibility.live.test.ts).
//
//   permission (403), Idempotency-Key required (400), AI actors refused (403), strict bodies (a memberId is refused, 422),
//   enrollment step-up (403 STEP_UP_REQUIRED), the standard error envelope on every refusal, no member id in any response or log.
import {
  createInMemoryEffectivePermissionStore,
  createPredicateRegistry,
  registerAbacRegistry,
  registerEffectivePermissionResolver,
  resetAbacRegistry,
  resetAuthorizationContract,
  resetRbacEngine,
} from "@chartwarden/auth";
import type { PatientCoverage } from "@chartwarden/types";
import type { FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import { createCommercialAdminService } from "../src/modules/41-billing-commercial/eligibility/admin-service";
import { createEligibilityService } from "../src/modules/41-billing-commercial/eligibility/service";
import type {
  EligibilityStore,
  NewEligibilityCheck,
  StoredEligibilityCheck,
  StoredEnrollment,
} from "../src/modules/41-billing-commercial/eligibility/store";
import { mountM41Routes } from "../src/modules/41-billing-commercial/routes/mount";

const ORG = "11111111-1111-4111-8111-111111111111";
const PE = "22222222-2222-4222-8222-222222222222";
const PATIENT = "33333333-3333-4333-8333-333333333333";
const PLAN = "44444444-4444-4444-8444-444444444444";
const PAYER = "55555555-5555-4555-8555-555555555555";
const MEMBER_ID = "SYNTH-MEMBER-4242";
const KEYS: Record<string, string[]> = {
  biller: ["commercial_billing.read", "commercial_billing.write"],
  admin: ["commercial_billing.read", "commercial_billing.write", "commercial_billing.manage_enrollment"],
  nobody: [],
};

class Store implements EligibilityStore {
  checks: StoredEligibilityCheck[] = [];
  enrollments: StoredEnrollment[] = [];
  async loadPlan() {
    return { id: PLAN, payerId: PAYER, eligibilityStalenessPolicy: "warn" as const, eligibilityMaxAgeDays: 30 };
  }
  async routesFor() {
    return [{ clearinghousePayerId: "CH-9", effectiveFrom: "2026-01-01", effectiveTo: null }];
  }
  requireEnrollment = false;
  async enrollmentsFor() {
    if (!this.requireEnrollment) {
      return [{ status: "enrolled" as const, effectiveFrom: "2026-01-01", effectiveTo: null }];
    }
    return this.enrollments.map((e) => ({ status: e.status, effectiveFrom: e.effectiveFrom, effectiveTo: e.effectiveTo }));
  }
  async findCheckByIdempotencyKey() {
    return null;
  }
  async insertCheck(scope: { organizationId: string }, row: NewEligibilityCheck) {
    const stored = { ...row, organizationId: scope.organizationId, id: "66666666-6666-4666-8666-666666666666", checkedAt: new Date().toISOString() };
    this.checks.push(stored);
    return { row: stored, replayed: false };
  }
  async listChecks() {
    return this.checks;
  }
  async setPlanEligibilityPolicy(_s: unknown, _id: string, policy: "warn" | "block", maxAge: number) {
    return { id: PLAN, payerId: PAYER, eligibilityStalenessPolicy: policy, eligibilityMaxAgeDays: maxAge };
  }
  async listEnrollments() {
    return this.enrollments;
  }
  async createEnrollment(_s: unknown, row: Omit<StoredEnrollment, "id" | "organizationId" | "createdAt" | "updatedAt">) {
    const e = { ...row, id: "77777777-7777-4777-8777-777777777777", organizationId: ORG, createdAt: "2026-10-25T00:00:00.000Z", updatedAt: "2026-10-25T00:00:00.000Z" };
    this.enrollments.push(e);
    return e;
  }
  async patchEnrollment() {
    return null;
  }
}

const coverage: PatientCoverage = {
  id: "88888888-8888-4888-8888-888888888888",
  patientId: PATIENT,
  payerId: PAYER,
  rank: 1,
  coverageKind: "commercial",
  subscriberId: MEMBER_ID,
  groupNumber: null,
  current: true,
  effectiveFrom: "2026-01-01",
  effectiveTo: null,
};

let bound = true;
let logs: unknown[] = [];

function headerAuth(request: FastifyRequest): void {
  const user = request.headers["x-test-user"];
  if (typeof user !== "string" || user.length === 0) return;
  request.context.userId = user;
  request.context.organizationId = ORG;
  request.context.roles = [];
  request.context.locationIds = [];
  if (request.headers["x-fresh"] === "1") request.context.attributes.stepUpRecent = true;
  if (request.headers["x-ai"] === "1") request.context.attributes.actorKind = "ai_assistant";
}

function makeServer() {
  registerEffectivePermissionResolver(
    createInMemoryEffectivePermissionStore(
      Object.entries(KEYS).map(([userId, permissionKeys]) => ({
        orgId: ORG,
        userId,
        grants: [{ roleKey: "seed", enabled: true, expiresAt: null, permissionKeys }],
      })),
    ).store,
  );
  const registry = createPredicateRegistry();
  registry.register("step_up_recent", async (ctx) => ctx.attributes.stepUpRecent === true);
  registry.register("provider_entity_billing_scope", async (_ctx, target) => (target as { providerEntityId?: string }).providerEntityId === PE);
  registry.register("caseload_or_scope", async () => true);
  registerAbacRegistry(registry);
  const store = new Store();
  const transport = {
    async checkEligibility() {
      return { ok: true as const, data: { outcome: "active" as const, asOfDate: "2026-10-25" } };
    },
  };
  const app = buildServer({ authenticate: headerAuth, security: { rateLimitEnabled: false } });
  mountM41Routes(app, {
    eligibility: createEligibilityService({
      store,
      coverage: { coveragesForPatient: async () => [coverage] },
      binding: { vendor: bound ? "in_memory" : null, transport },
      contexts: {
        contextFor: async (organizationId, providerEntityId, payerId) => ({
          organizationId,
          providerEntityId,
          payerId,
          correlationId: "99999999-9999-4999-8999-999999999999",
          usage: "test",
          billingNpi: "1234567893",
        }),
      },
      now: () => new Date(),
      newRequestId: () => "99999999-9999-4999-8999-999999999999",
      log: (e) => logs.push(e),
    }),
    admin: createCommercialAdminService(store),
  });
  return { app, store };
}

beforeEach(() => {
  bound = true;
  logs = [];
  resetAuthorizationContract();
  resetRbacEngine();
  resetAbacRegistry();
});
afterEach(() => {
  resetAuthorizationContract();
  resetRbacEngine();
  resetAbacRegistry();
});

const CHECK = "/api/v1/billing/commercial/eligibility/check";
const body = { providerEntityId: PE, patientId: PATIENT, planId: PLAN, serviceDate: "2026-10-25" };
let keySeq = 0;
// A fresh key per request: the M1 idempotency middleware (rightly) answers 409 when a key is reused with a different body.
const as = (user: string, extra: Record<string, string> = {}) => ({
  "x-test-user": user,
  "idempotency-key": `idem-${(keySeq += 1)}`,
  ...extra,
});
const code = (res: { json(): { error?: { code?: string } } }) => res.json().error?.code;

describe("POST /billing/commercial/eligibility/check", () => {
  it("runs the check, answers 200 uncached and never contains the member id", async () => {
    const { app } = makeServer();
    const res = await app.inject({ method: "POST", url: CHECK, headers: as("biller"), payload: body });
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.json()).toMatchObject({ outcome: "active", replayed: false, planId: PLAN });
    expect(res.body).not.toContain(MEMBER_ID);
    expect(JSON.stringify(logs)).not.toContain(MEMBER_ID);
  });

  it("is 403 without the permission and 401 without a session", async () => {
    const { app } = makeServer();
    expect((await app.inject({ method: "POST", url: CHECK, headers: as("nobody"), payload: body })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: CHECK, payload: body })).statusCode).toBe(401);
  });

  it("requires an Idempotency-Key", async () => {
    const { app } = makeServer();
    const res = await app.inject({ method: "POST", url: CHECK, headers: { "x-test-user": "biller" }, payload: body });
    expect(res.statusCode).toBe(400);
    expect(code(res)).toBe("IDEMPOTENCY_KEY_REQUIRED");
  });

  it("refuses an AI actor", async () => {
    const { app } = makeServer();
    const res = await app.inject({ method: "POST", url: CHECK, headers: as("biller", { "x-ai": "1" }), payload: body });
    expect(res.statusCode).toBe(403);
  });

  it("refuses a body that carries a member id, with the standard envelope and without echoing it", async () => {
    const { app } = makeServer();
    const res = await app.inject({ method: "POST", url: CHECK, headers: as("biller"), payload: { ...body, memberId: MEMBER_ID } });
    expect(res.statusCode).toBe(422);
    expect(code(res)).toBe("VALIDATION_FAILED");
    expect(res.body).not.toContain(MEMBER_ID);
  });

  it("answers CH_NOT_WIRED (503) in the envelope when no clearinghouse is bound", async () => {
    bound = false;
    const { app, store } = makeServer();
    const res = await app.inject({ method: "POST", url: CHECK, headers: as("biller"), payload: body });
    expect(res.statusCode).toBe(503);
    expect(code(res)).toBe("CH_NOT_WIRED");
    expect(store.checks).toHaveLength(0);
  });

  it("answers COMMERCIAL_PROVIDER_NOT_ENROLLED (409) when the provider entity is not enrolled", async () => {
    const { app, store } = makeServer();
    store.requireEnrollment = true;
    const res = await app.inject({ method: "POST", url: CHECK, headers: as("biller"), payload: body });
    expect(res.statusCode).toBe(409);
    expect(code(res)).toBe("COMMERCIAL_PROVIDER_NOT_ENROLLED");
    expect(store.checks).toHaveLength(0);
  });
});

describe("enrollment routes", () => {
  const ENR = "/api/v1/billing/commercial/enrollments";
  const enrollBody = { providerEntityId: PE, payerId: PAYER, clearinghouseKey: "in_memory", status: "enrolled", effectiveFrom: "2026-01-01" };

  it("create needs manage_enrollment, a fresh step-up and an Idempotency-Key", async () => {
    const { app } = makeServer();
    expect((await app.inject({ method: "POST", url: ENR, headers: as("biller", { "x-fresh": "1" }), payload: enrollBody })).statusCode).toBe(403);
    const stale = await app.inject({ method: "POST", url: ENR, headers: as("admin"), payload: enrollBody });
    expect(stale.statusCode).toBe(403);
    expect(code(stale)).toBe("STEP_UP_REQUIRED");
    const noKey = await app.inject({ method: "POST", url: ENR, headers: { "x-test-user": "admin", "x-fresh": "1" }, payload: enrollBody });
    expect(noKey.statusCode).toBe(400);
    const ok = await app.inject({ method: "POST", url: ENR, headers: as("admin", { "x-fresh": "1" }), payload: enrollBody });
    expect(ok.statusCode).toBe(201);
    expect(ok.json()).toMatchObject({ status: "enrolled", clearinghouseKey: "in_memory" });
  });

  it("an enrolled provider entity then passes the gate on the next check", async () => {
    const { app, store } = makeServer();
    store.requireEnrollment = true;
    await app.inject({ method: "POST", url: ENR, headers: as("admin", { "x-fresh": "1" }), payload: enrollBody });
    const res = await app.inject({ method: "POST", url: CHECK, headers: as("biller"), payload: body });
    expect(res.statusCode).toBe(200);
  });

  it("lists enrollments for a provider entity", async () => {
    const { app } = makeServer();
    const res = await app.inject({ method: "GET", url: `${ENR}?providerEntityId=${PE}`, headers: { "x-test-user": "biller" } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ items: [] });
  });

  it("patching an enrollment that is not the provider entity's is a 404", async () => {
    const { app } = makeServer();
    const res = await app.inject({ method: "PATCH", url: `${ENR}/77777777-7777-4777-8777-777777777777`, headers: as("admin", { "x-fresh": "1" }), payload: { providerEntityId: PE, status: "suspended" } });
    expect(res.statusCode).toBe(404);
  });
});

describe("eligibility policy and reads", () => {
  it("sets a plan's policy and validates the range", async () => {
    const { app } = makeServer();
    const url = `/api/v1/billing/commercial/payer-plans/${PLAN}/eligibility-policy`;
    expect((await app.inject({ method: "PATCH", url, headers: as("biller", { "x-fresh": "1" }), payload: { policy: "block", maxAgeDays: 14 } })).statusCode).toBe(403);
    const stale = await app.inject({ method: "PATCH", url, headers: as("admin"), payload: { policy: "warn", maxAgeDays: 90 } });
    expect(code(stale)).toBe("STEP_UP_REQUIRED");
    const ok = await app.inject({ method: "PATCH", url, headers: as("admin", { "x-fresh": "1" }), payload: { policy: "block", maxAgeDays: 14 } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ eligibilityStalenessPolicy: "block", eligibilityMaxAgeDays: 14 });
    const bad = await app.inject({ method: "PATCH", url, headers: as("admin", { "x-fresh": "1" }), payload: { policy: "block", maxAgeDays: 400 } });
    expect(bad.statusCode).toBe(422);
  });

  it("a read without the provider entity is refused (404, fail closed) and are scope-checked", async () => {
    const { app } = makeServer();
    const res = await app.inject({ method: "GET", url: `/api/v1/billing/commercial/eligibility?patientId=${PATIENT}`, headers: { "x-test-user": "biller" } });
    expect(res.statusCode).toBe(404);
  });

  it("an actor scoped to another provider entity is refused (404) on both reads and on the check", async () => {
    const { app } = makeServer();
    const other = "99999999-0000-4000-8000-000000000001";
    const q = `patientId=${PATIENT}&planId=${PLAN}&providerEntityId=${other}`;
    for (const url of [`/api/v1/billing/commercial/eligibility?${q}`, `/api/v1/billing/commercial/eligibility/latest?${q}`]) {
      expect((await app.inject({ method: "GET", url, headers: { "x-test-user": "biller" } })).statusCode).toBe(404);
    }
    const res = await app.inject({ method: "POST", url: CHECK, headers: as("biller"), payload: { ...body, providerEntityId: other } });
    expect(res.statusCode).toBe(404);
  });

  it("a GET cannot smuggle its own ids in a JSON body to pass the scope check (the target is read from the query only)", async () => {
    const { app } = makeServer();
    const other = "99999999-0000-4000-8000-000000000001";
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/billing/commercial/eligibility?providerEntityId=${other}&patientId=${PATIENT}`,
      headers: { "x-test-user": "biller", "content-type": "application/json" },
      payload: { providerEntityId: PE, patientId: PATIENT },
    });
    expect(res.statusCode).toBe(404);
  });

  it("latest reports a missing check as a warning under the default policy", async () => {
    const { app } = makeServer();
    const res = await app.inject({ method: "GET", url: `/api/v1/billing/commercial/eligibility/latest?providerEntityId=${PE}&patientId=${PATIENT}&planId=${PLAN}`, headers: { "x-test-user": "biller" } });
    expect(res.statusCode).toBe(200);
    expect(res.json().freshness).toMatchObject({ status: "missing", severity: "warning" });
  });
});
