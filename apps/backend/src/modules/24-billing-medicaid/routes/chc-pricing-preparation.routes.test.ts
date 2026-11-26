// M24 local CHC pricing preparation routes — the HTTP boundary only. The real M1 server chain (auth, RBAC,
// ABAC, TypeBox, error envelope) runs over a fake service, so these tests prove what only a request can:
// which guard refuses what, with which stable code, before the service is ever reached. The pricing
// itself is covered by the pure pricing suites and the live Drizzle suite.
import {
  createInMemoryEffectivePermissionStore,
  createPredicateRegistry,
  registerAbacRegistry,
  registerEffectivePermissionResolver,
  resetAbacRegistry,
  resetAuthorizationContract,
  resetRbacEngine,
} from "@chartwarden/auth";
import { ValidationError } from "@chartwarden/types";
import type { FastifyRequest } from "fastify";
import { type Mock, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildServer } from "../../../bootstrap/index";
import { type ReadingM24AbacResolver, buildM24AbacPredicates } from "../abac-predicates";
import type {
  ChcPreparationView,
  ChcPricingPreparationInput,
  ChcPricingPreparationService,
} from "../pricing/chc-pricing-preparation";
import type { M24Actor } from "./actor";
import { registerChcPricingPreparationRoutes } from "./chc-pricing-preparation.routes";
import { ChcPricingPreparationBody, parse } from "./m24-typebox";

const ORG = "org_chc_a";
const USER = "biller_1";
const MEMBERSHIP = "99999999-9999-4999-8999-999999999999";
const PE = "33333333-3333-4333-8333-333333333333";
const OTHER_PE = "44444444-4444-4444-8444-444444444444";
const PATIENT = "11111111-1111-4111-8111-111111111111";
const OUT_OF_CASELOAD_PATIENT = "12121212-1212-4212-8212-121212121212";
const ADMISSION = "22222222-2222-4222-8222-222222222222";
const PREPARATION_RECORD = "55555555-5555-4555-8555-555555555555";
const UNKNOWN_RECORD = "66666666-6666-4666-8666-666666666666";
const PREPARATION_GROUP = "77777777-7777-4777-8777-777777777777";
const POST_URL = "/api/v1/medicaid-chc-pricing-preparations";

const VIEW: ChcPreparationView = {
  id: PREPARATION_RECORD,
  preparationId: PREPARATION_GROUP,
  version: 1,
  serviceDate: "2026-11-01",
  observedMinutes: 540,
  qualifiedMinutes: 540,
  reimbursementHours: 9,
  rateCentsPerHour: 5000,
  estimatedReimbursementCents: 45000,
  billedChargeCents: 45000,
  institutionalUnits: "unqualified",
  institutionalFormatQualified: false,
  verification: {
    status: "current",
    preparationId: PREPARATION_GROUP,
    version: 1,
    fingerprint: "a".repeat(64),
  },
};

const BODY: ChcPricingPreparationInput = {
  patientId: PATIENT,
  admissionId: ADMISSION,
  providerEntityId: PE,
  serviceDate: "2026-11-01",
};

const BILLER = {
  "x-test-user": USER,
  "x-test-org": ORG,
  "x-test-roles": "billing_manager",
  "x-test-pe": PE,
  "x-test-membership": MEMBERSHIP,
};
const WITH_KEY = { ...BILLER, "idempotency-key": "chc-key-1" };
const NO_GRANTS = { ...BILLER, "x-test-user": "none_1" };

/** Header auth shim (the M24 inject-suite precedent) plus the membership and actor kind these routes read. */
function headerAuth(request: FastifyRequest): void {
  const user = request.headers["x-test-user"];
  if (typeof user !== "string" || user.length === 0) return;
  request.context.userId = user;
  const org = request.headers["x-test-org"];
  request.context.organizationId = typeof org === "string" ? org : "";
  const roles = request.headers["x-test-roles"];
  request.context.roles = typeof roles === "string" && roles.length > 0 ? roles.split(",") : [];
  const pe = request.headers["x-test-pe"];
  request.context.providerEntityIds = typeof pe === "string" && pe.length > 0 ? pe.split(",") : [];
  const membership = request.headers["x-test-membership"];
  if (typeof membership === "string") request.context.attributes.membershipId = membership;
  const actorKind = request.headers["x-test-actor-kind"];
  if (typeof actorKind === "string") request.context.attributes.actorKind = actorKind;
  request.context.attributes.stepUpRecent = true;
}

type PatientScopeCheck = (context: unknown, target: Record<string, unknown>) => Promise<boolean>;

interface Harness {
  readonly app: ReturnType<typeof buildServer>;
  readonly prepare: Mock<ChcPricingPreparationService["prepare"]>;
  readonly read: Mock<ChcPricingPreparationService["read"]>;
  readonly loadScope: Mock<ReadingM24AbacResolver["loadChcPreparationScope"]>;
  readonly patientScope: Mock<PatientScopeCheck>;
}

function makeServer(
  options: { readonly bound?: boolean; readonly readResult?: ChcPreparationView | null } = {},
): Harness {
  const bound = options.bound ?? true;
  const readResult = options.readResult === undefined ? VIEW : options.readResult;
  const prepare = vi.fn<ChcPricingPreparationService["prepare"]>(async () => VIEW);
  const read = vi.fn<ChcPricingPreparationService["read"]>(async () => readResult);
  const service = { prepare, read } as unknown as ChcPricingPreparationService;

  const loadScope = vi.fn<ReadingM24AbacResolver["loadChcPreparationScope"]>(
    async (_ctx, preparationId) =>
      preparationId === PREPARATION_RECORD ? { providerEntityId: PE, patientId: PATIENT } : null,
  );
  const resolver: ReadingM24AbacResolver = {
    async loadClaim() {
      return null;
    },
    async loadArrangementPe() {
      return null;
    },
    async loadRbDayPe() {
      return null;
    },
    async loadResultRuleKey() {
      return null;
    },
    loadChcPreparationScope: loadScope,
  };

  const grants = (userId: string, permissionKeys: readonly string[]) => ({
    orgId: ORG,
    userId,
    grants: [
      { roleKey: "seed", enabled: true, expiresAt: null, permissionKeys: [...permissionKeys] },
    ],
  });
  registerEffectivePermissionResolver(
    createInMemoryEffectivePermissionStore([
      grants(USER, ["medicaid.claim.assemble", "medicaid.claim.read"]),
      grants("none_1", []),
    ]).store,
  );

  // A fresh registry: M24's real predicates over the fake resolver, and M5's `caseload_or_scope` stood in
  // by a stub that denies exactly one patient (the real one needs the patient module's caseload store).
  const patientScope = vi.fn<PatientScopeCheck>(
    async (_context, target) => target.patientId !== OUT_OF_CASELOAD_PATIENT,
  );
  const registry = createPredicateRegistry();
  for (const [name, predicate] of Object.entries(
    buildM24AbacPredicates({ resolver, isInCaseload: async () => true }),
  )) {
    registry.register(name, predicate);
  }
  registry.register("caseload_or_scope", patientScope);
  registerAbacRegistry(registry);

  const app = buildServer({ authenticate: headerAuth, security: { rateLimitEnabled: false } });
  registerChcPricingPreparationRoutes(app, bound ? service : undefined);
  return { app, prepare, read, loadScope, patientScope };
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
});

describe("POST /api/v1/medicaid-chc-pricing-preparations", () => {
  it("calls the service once with the session's organization and returns its view as a 201", async () => {
    const { app, prepare, patientScope } = makeServer();

    const res = await app.inject({
      method: "POST",
      url: POST_URL,
      headers: WITH_KEY,
      payload: BODY,
    });

    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual(VIEW);
    expect(prepare).toHaveBeenCalledTimes(1);
    const [actor, input] = prepare.mock.calls[0] as [M24Actor, ChcPricingPreparationInput];
    expect(actor).toMatchObject({
      organizationId: ORG,
      userId: USER,
      membershipId: MEMBERSHIP,
      providerEntityIds: [PE],
    });
    expect(input).toEqual(BODY);
    expect(patientScope).toHaveBeenCalledWith(expect.anything(), { patientId: PATIENT });
    await app.close();
  });

  // The route declares `schema.body`, so Fastify validates (and, per its Ajv default, strips unknown
  // properties) BEFORE the handler's `parse()` runs. Unknown properties therefore never reach the service
  // rather than being a 422; the next test pins that, and `ChcPricingPreparationBody` below pins the 422.
  it.each(["organizationId", "rateCentsPerHour"])(
    "drops a %s sent in the body, so the service sees only the four accepted fields and the session's organization",
    async (extra) => {
      const { app, prepare } = makeServer();

      const res = await app.inject({
        method: "POST",
        url: POST_URL,
        headers: WITH_KEY,
        payload: { ...BODY, [extra]: "org_other" },
      });

      expect(res.statusCode).toBe(201);
      expect(prepare).toHaveBeenCalledTimes(1);
      const [actor, input] = prepare.mock.calls[0] as [M24Actor, ChcPricingPreparationInput];
      expect(actor.organizationId).toBe(ORG);
      expect(input).toEqual(BODY);
      expect(input).not.toHaveProperty(extra);
      await app.close();
    },
  );

  it.each(["patientId", "admissionId", "providerEntityId"] as const)(
    "refuses a non-uuid %s with Fastify's 400 FST_ERR_VALIDATION naming the field",
    async (field) => {
      const { app, prepare } = makeServer();

      const res = await app.inject({
        method: "POST",
        url: POST_URL,
        headers: WITH_KEY,
        payload: { ...BODY, [field]: "not-a-uuid" },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe("FST_ERR_VALIDATION");
      expect(res.json().error.message).toContain(`body/${field} must match format "uuid"`);
      expect(prepare).not.toHaveBeenCalled();
      await app.close();
    },
  );

  it.each([
    ["a malformed service date", { serviceDate: "11/01/2026" }],
    ["a missing service date", { serviceDate: undefined }],
  ])("refuses %s with a 400 FST_ERR_VALIDATION naming serviceDate", async (_label, override) => {
    const { app, prepare } = makeServer();

    const res = await app.inject({
      method: "POST",
      url: POST_URL,
      headers: WITH_KEY,
      payload: { ...BODY, ...override },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("FST_ERR_VALIDATION");
    expect(res.json().error.message).toContain("serviceDate");
    expect(prepare).not.toHaveBeenCalled();
    await app.close();
  });

  it("refuses an AI principal with a 403 before the service is reached", async () => {
    const { app, prepare } = makeServer();

    const res = await app.inject({
      method: "POST",
      url: POST_URL,
      headers: { ...WITH_KEY, "x-test-actor-kind": "ai_assistant" },
      payload: BODY,
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("FORBIDDEN");
    expect(res.json().error.message).toContain("AI principals cannot prepare or change Medicaid");
    expect(prepare).not.toHaveBeenCalled();
    await app.close();
  });

  it("refuses a request with no Idempotency-Key as IDEMPOTENCY_KEY_REQUIRED", async () => {
    const { app, prepare } = makeServer();

    const res = await app.inject({ method: "POST", url: POST_URL, headers: BILLER, payload: BODY });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("IDEMPOTENCY_KEY_REQUIRED");
    expect(prepare).not.toHaveBeenCalled();
    await app.close();
  });

  it("refuses an Idempotency-Key longer than 128 characters", async () => {
    const { app, prepare } = makeServer();

    const res = await app.inject({
      method: "POST",
      url: POST_URL,
      headers: { ...BILLER, "idempotency-key": "k".repeat(129) },
      payload: BODY,
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("IDEMPOTENCY_KEY_REQUIRED");
    expect(prepare).not.toHaveBeenCalled();
    await app.close();
  });

  it("answers 503 DEGRADED when the service is not bound", async () => {
    const { app } = makeServer({ bound: false });

    const res = await app.inject({
      method: "POST",
      url: POST_URL,
      headers: WITH_KEY,
      payload: BODY,
    });

    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe("DEGRADED");
    expect(res.json().error.message).toContain("CHC_PRICING_PREPARATION_UNBOUND");
    await app.close();
  });

  it("answers 401 with no session and 403 for a session without the assemble grant", async () => {
    const { app, prepare } = makeServer();

    const anonymous = await app.inject({ method: "POST", url: POST_URL, payload: BODY });
    const ungranted = await app.inject({
      method: "POST",
      url: POST_URL,
      headers: { ...NO_GRANTS, "idempotency-key": "chc-key-2" },
      payload: BODY,
    });

    expect(anonymous.statusCode).toBe(401);
    expect(ungranted.statusCode).toBe(403);
    expect(prepare).not.toHaveBeenCalled();
    await app.close();
  });

  it("refuses a provider entity outside the actor's scope with a 403", async () => {
    const { app, prepare } = makeServer();

    const res = await app.inject({
      method: "POST",
      url: POST_URL,
      headers: WITH_KEY,
      payload: { ...BODY, providerEntityId: OTHER_PE },
    });

    expect(res.statusCode).toBe(403);
    expect(prepare).not.toHaveBeenCalled();
    await app.close();
  });

  it("answers a non-leaking 404 for a patient outside the actor's caseload", async () => {
    const { app, prepare } = makeServer();

    const res = await app.inject({
      method: "POST",
      url: POST_URL,
      headers: WITH_KEY,
      payload: { ...BODY, patientId: OUT_OF_CASELOAD_PATIENT },
    });

    expect(res.statusCode).toBe(404);
    expect(prepare).not.toHaveBeenCalled();
    await app.close();
  });
});

describe("GET /api/v1/medicaid-chc-pricing-preparations/:id", () => {
  const getUrl = (id: string) => `${POST_URL}/${id}`;

  it("returns the service's view for an in-scope preparation, read under the session's organization", async () => {
    const { app, read, loadScope } = makeServer();

    const res = await app.inject({
      method: "GET",
      url: getUrl(PREPARATION_RECORD),
      headers: BILLER,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(VIEW);
    expect(read).toHaveBeenCalledTimes(1);
    const [actor, id] = read.mock.calls[0] as [M24Actor, string];
    expect(actor).toMatchObject({ organizationId: ORG, providerEntityIds: [PE] });
    expect(id).toBe(PREPARATION_RECORD);
    expect(loadScope).toHaveBeenCalledWith(
      { organizationId: ORG, userId: USER },
      PREPARATION_RECORD,
    );
    await app.close();
  });

  it("answers 404, not 403, for an unknown id and never calls the service", async () => {
    const { app, read } = makeServer();

    const res = await app.inject({ method: "GET", url: getUrl(UNKNOWN_RECORD), headers: BILLER });

    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("NOT_FOUND");
    expect(read).not.toHaveBeenCalled();
    await app.close();
  });

  it("answers the same 404 for a preparation of a provider entity outside the actor's scope", async () => {
    const { app, read } = makeServer();

    const res = await app.inject({
      method: "GET",
      url: getUrl(PREPARATION_RECORD),
      headers: { ...BILLER, "x-test-pe": OTHER_PE },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("NOT_FOUND");
    expect(read).not.toHaveBeenCalled();
    await app.close();
  });

  it("answers 404 when the guards pass but the service finds no preparation", async () => {
    const { app, read } = makeServer({ readResult: null });

    const res = await app.inject({
      method: "GET",
      url: getUrl(PREPARATION_RECORD),
      headers: BILLER,
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("NOT_FOUND");
    expect(read).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it("answers 503 DEGRADED when the service is not bound", async () => {
    const { app } = makeServer({ bound: false });

    const res = await app.inject({
      method: "GET",
      url: getUrl(PREPARATION_RECORD),
      headers: BILLER,
    });

    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe("DEGRADED");
    expect(res.json().error.message).toContain("CHC_PRICING_PREPARATION_UNBOUND");
    await app.close();
  });

  it("answers 401 with no session and 403 for a session without the read grant", async () => {
    const { app, read } = makeServer();

    const anonymous = await app.inject({ method: "GET", url: getUrl(PREPARATION_RECORD) });
    const ungranted = await app.inject({
      method: "GET",
      url: getUrl(PREPARATION_RECORD),
      headers: NO_GRANTS,
    });

    expect(anonymous.statusCode).toBe(401);
    expect(ungranted.statusCode).toBe(403);
    expect(read).not.toHaveBeenCalled();
    await app.close();
  });
});

describe("ChcPricingPreparationBody (the handler's parse(), the 422 path)", () => {
  it("accepts exactly the four server-resolved fields", () => {
    expect(parse(ChcPricingPreparationBody, BODY)).toEqual(BODY);
  });

  it.each([
    ["an organization id", { ...BODY, organizationId: ORG }],
    ["an unknown property", { ...BODY, rateCentsPerHour: 1 }],
    ["a non-uuid patient id", { ...BODY, patientId: "not-a-uuid" }],
    ["a malformed service date", { ...BODY, serviceDate: "11/01/2026" }],
    ["a missing admission id", { ...BODY, admissionId: undefined }],
  ])("rejects a body with %s as a ValidationError", (_label, raw) => {
    expect(() => parse(ChcPricingPreparationBody, raw)).toThrow(ValidationError);
  });
});
