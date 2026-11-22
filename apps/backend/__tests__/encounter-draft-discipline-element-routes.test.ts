// ADR-0114 S4b (VN-D60) - the per-element routes of a social-work or chaplain visit's drafted plan through the FULL M1 middleware chain (Fastify `inject`),
// no live infra: the REAL Authorization Contract (permission, caseload scope, the author's own rule) and the real error envelope; the service is faked, so
// this proves the ROUTE layer: who may call, what the viewer is, what is validated, how errors read. The switch, the read key, Part 2 and the writes are
// proven in encounter-draft-discipline-elements.test.ts and the live suite.
import {
  M3_INTRINSIC_PREDICATES,
  createInMemoryEffectivePermissionStore,
  createPredicateRegistry,
  registerAbacRegistry,
  registerEffectivePermissionResolver,
  resetAbacRegistry,
  resetAuthorizationContract,
  resetRbacEngine,
} from "@chartwarden/auth";
import type { FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import type { DraftService } from "../src/modules/08-encounters/drafting/draft-service";
import {
  buildEncounterAbacPredicates,
  createInMemoryEncounterBackend,
  registerEncounterRoutes,
} from "../src/modules/08-encounters/index";
import { EncounterStateError } from "../src/modules/08-encounters/lifecycle/errors";
import { registerDraftSectionRoutes } from "../src/modules/08-encounters/routes/draft-section-routes";
import { registerDraftingRoutes } from "../src/modules/08-encounters/routes/drafting-routes";

const ORG = "org_a";
const PATIENT = "11111111-1111-4111-8111-111111111111";
const ENCOUNTER = "a0000000-0000-4000-8000-000000000001";
const ELEMENT = "c0000000-0000-4000-8000-0000000000c1";
const VIEW = {
  patientId: PATIENT,
  elements: [{ elementId: ELEMENT, kind: "goal", text: "Name two ways to cope", kept: true }],
};

const PERMISSION_SEED = [
  { userId: "author_1", permissions: ["encounter.read", "encounter.author"] },
  { userId: "other_rn", permissions: ["encounter.read", "encounter.author"] },
  { userId: "sup_1", permissions: ["encounter.read", "encounter.author"] },
  { userId: "viewer_1", permissions: ["encounter.read"] },
  { userId: "nobody", permissions: [] },
];

function headerAuth(request: FastifyRequest): void {
  const user = request.headers["x-test-user"];
  if (typeof user !== "string" || user.length === 0) return;
  request.context.userId = user;
  request.context.organizationId = String(request.headers["x-test-org"] ?? "");
  const roles = request.headers["x-test-roles"];
  request.context.roles = typeof roles === "string" && roles.length > 0 ? roles.split(",") : [];
  request.context.attributes.membershipId = user;
  request.context.attributes.sessionId = user;
  const kind = request.headers["x-test-actor-kind"];
  request.context.attributes.actorKind = typeof kind === "string" ? kind : "user";
  if (request.headers["x-test-no-membership"] === "1")
    request.context.attributes.membershipId = undefined;
}

function fakeService() {
  return {
    getDisciplinePlanElements: vi.fn(async () => VIEW),
    setDisciplinePlanElement: vi.fn(async () => VIEW),
  } as unknown as { [K in keyof DraftService]: ReturnType<typeof vi.fn> };
}

function makeServer(options: { inCaseload?: boolean } = {}) {
  const backend = createInMemoryEncounterBackend({
    encounters: [
      {
        id: ENCOUNTER,
        organizationId: ORG,
        patientId: PATIENT,
        discipline: "msw",
        status: "draft",
        authoredByUserId: "author_1",
      },
    ],
  });
  registerEffectivePermissionResolver(
    createInMemoryEffectivePermissionStore(
      PERMISSION_SEED.map((s) => ({
        orgId: ORG,
        userId: s.userId,
        grants: [
          { roleKey: "seed", enabled: true, expiresAt: null, permissionKeys: s.permissions },
        ],
      })),
    ).store,
  );
  resetAbacRegistry();
  const registry = createPredicateRegistry({ ...M3_INTRINSIC_PREDICATES });
  const predicates = buildEncounterAbacPredicates({
    resolver: backend.resolver,
    isInCaseload: async () => options.inCaseload ?? true,
  });
  for (const [name, fn] of Object.entries(predicates)) registry.register(name, fn);
  registerAbacRegistry(registry);
  const service = fakeService();
  const app = buildServer({ authenticate: headerAuth, security: { rateLimitEnabled: false } });
  registerEncounterRoutes(app, {
    service: backend.service,
    caseloadPatientIds: async () => [PATIENT],
  });
  registerDraftingRoutes(app, {
    service: { getPolicy: vi.fn(), putPolicy: vi.fn() } as never,
  });
  registerDraftSectionRoutes(app, { service: service as unknown as DraftService });
  return { app, service };
}

const as = (user: string, roles: string, extra: Record<string, string> = {}) => ({
  "x-test-user": user,
  "x-test-org": ORG,
  "x-test-roles": roles,
  ...extra,
});
const AUTHOR = as("author_1", "msw");
const SUPERVISOR = as("sup_1", "clinical_supervisor");
const OTHER = as("other_rn", "msw");
const VIEWER = as("viewer_1", "auditor");

const listUrl = (id = ENCOUNTER) => `/api/v1/encounters/${id}/discipline-plan-elements`;
const elementUrl = (id = ENCOUNTER, element = ELEMENT) => `${listUrl(id)}/${element}`;

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

describe("GET /encounters/:encounterId/discipline-plan-elements", () => {
  it("answers the service's elements, for the SESSION viewer (roles, membership and permissions from the session)", async () => {
    const { app, service } = makeServer();
    const res = await app.inject({ method: "GET", url: listUrl(), headers: AUTHOR });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(VIEW);
    expect(service.getDisciplinePlanElements).toHaveBeenCalledWith(
      {
        organizationId: ORG,
        userId: "author_1",
        roles: ["msw"],
        membershipId: "author_1",
        permissions: expect.any(Set),
      },
      ENCOUNTER,
    );
  });

  it("lets a read-only reader open it (only the write is the author's act)", async () => {
    const { app, service } = makeServer();
    const res = await app.inject({ method: "GET", url: listUrl(), headers: VIEWER });
    expect(res.statusCode).toBe(200);
    expect(service.getDisciplinePlanElements).toHaveBeenCalledOnce();
  });

  it("needs encounter.read: a caller without it is refused 403 and nothing is read", async () => {
    const { app, service } = makeServer();
    const res = await app.inject({ method: "GET", url: listUrl(), headers: as("nobody", "msw") });
    expect(res.statusCode).toBe(403);
    expect(service.getDisciplinePlanElements).not.toHaveBeenCalled();
  });

  it("answers 404 for an encounter outside the caller's caseload, the same as an absent one", async () => {
    const { app, service } = makeServer({ inCaseload: false });
    const res = await app.inject({ method: "GET", url: listUrl(), headers: AUTHOR });
    expect(res.statusCode).toBe(404);
    expect(service.getDisciplinePlanElements).not.toHaveBeenCalled();
  });

  it("refuses a malformed encounter id with 422 before the scope predicate casts it", async () => {
    const { app, service } = makeServer();
    const res = await app.inject({ method: "GET", url: listUrl("not-a-uuid"), headers: AUTHOR });
    expect(res.statusCode).toBe(422);
    expect(service.getDisciplinePlanElements).not.toHaveBeenCalled();
  });

  it("carries a 422 UNKNOWN_TEMPLATE_SECTION from the service in the standard error envelope", async () => {
    const { app, service } = makeServer();
    service.getDisciplinePlanElements.mockRejectedValueOnce(
      new EncounterStateError(
        "UNKNOWN_TEMPLATE_SECTION",
        "this visit's note is not drafted from the discipline's plan",
      ),
    );
    const res = await app.inject({ method: "GET", url: listUrl(), headers: AUTHOR });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("UNKNOWN_TEMPLATE_SECTION");
  });

  it("declares a read audit against the encounter, attributed to the patient named in the response (names of fields only)", () => {
    const declared: Record<string, unknown>[] = [];
    const app = buildServer({ authenticate: headerAuth, security: { rateLimitEnabled: false } });
    app.addHook("onRoute", (route) => {
      if (
        route.url === "/api/v1/encounters/:encounterId/discipline-plan-elements" &&
        route.method === "GET"
      ) {
        declared.push(route.config?.auditRead as unknown as Record<string, unknown>);
      }
    });
    registerDraftSectionRoutes(app, { service: fakeService() as unknown as DraftService });
    expect(declared).toHaveLength(1);
    expect(declared[0]).toMatchObject({
      resourceKind: "encounter_discipline_plan_elements",
      resourceIdParam: "encounterId",
      patientIdPayloadPath: "patientId",
    });
    expect(declared[0]?.fields).toEqual(expect.arrayContaining(["elements", "kept", "text"]));
  });

  it("the PUT answers the same wording, so it declares the same read audit (a toggle that writes nothing leaves no row-trigger event)", () => {
    const declared: Record<string, unknown>[] = [];
    const app = buildServer({ authenticate: headerAuth, security: { rateLimitEnabled: false } });
    app.addHook("onRoute", (route) => {
      if (
        route.url === "/api/v1/encounters/:encounterId/discipline-plan-elements/:elementId" &&
        route.method === "PUT"
      ) {
        declared.push(route.config?.auditRead as unknown as Record<string, unknown>);
      }
    });
    registerDraftSectionRoutes(app, { service: fakeService() as unknown as DraftService });
    expect(declared).toHaveLength(1);
    expect(declared[0]).toMatchObject({
      resourceKind: "encounter_discipline_plan_elements",
      resourceIdParam: "encounterId",
      patientIdPayloadPath: "patientId",
    });
  });
});

describe("PUT /encounters/:encounterId/discipline-plan-elements/:elementId", () => {
  it("passes the session actor, the ids from the path, the body and an audit context to the service, and answers its view", async () => {
    const { app, service } = makeServer();
    const res = await app.inject({
      method: "PUT",
      url: elementUrl(),
      headers: AUTHOR,
      payload: { included: false },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(VIEW);
    expect(service.setDisciplinePlanElement).toHaveBeenCalledWith(
      {
        organizationId: ORG,
        userId: "author_1",
        roles: ["msw"],
        membershipId: "author_1",
        permissions: expect.any(Set),
      },
      ENCOUNTER,
      ELEMENT,
      { included: false },
      expect.objectContaining({ organizationId: ORG, userId: "author_1", actorKind: "user" }),
    );
  });

  it("never takes the viewer from the body: roles or a membership sent there are refused, not used", async () => {
    const { app, service } = makeServer();
    const res = await app.inject({
      method: "PUT",
      url: elementUrl(),
      headers: AUTHOR,
      payload: { included: true, roles: ["org_admin"], membershipId: "someone_else" },
    });
    expect(res.statusCode).toBe(422);
    expect(service.setDisciplinePlanElement).not.toHaveBeenCalled();
  });

  it.each([
    ["no body", undefined],
    ["an empty body", {}],
    ["a string for included", { included: "yes" }],
    ["a null included", { included: null }],
  ])("refuses %s with 422", async (_name, payload) => {
    const { app, service } = makeServer();
    const res = await app.inject({
      method: "PUT",
      url: elementUrl(),
      headers: AUTHOR,
      ...(payload === undefined ? {} : { payload }),
    });
    expect(res.statusCode).toBe(422);
    expect(service.setDisciplinePlanElement).not.toHaveBeenCalled();
  });

  it("refuses a malformed element id or encounter id with 422 before the scope predicate casts it", async () => {
    const { app, service } = makeServer();
    for (const url of [elementUrl(ENCOUNTER, "nope"), elementUrl("nope", ELEMENT)]) {
      const res = await app.inject({
        method: "PUT",
        url,
        headers: AUTHOR,
        payload: { included: true },
      });
      expect(res.statusCode, url).toBe(422);
    }
    expect(service.setDisciplinePlanElement).not.toHaveBeenCalled();
  });

  it("needs encounter.author: a read-only caller is refused 403", async () => {
    const { app, service } = makeServer();
    const res = await app.inject({
      method: "PUT",
      url: elementUrl(),
      headers: VIEWER,
      payload: { included: true },
    });
    expect(res.statusCode).toBe(403);
    expect(service.setDisciplinePlanElement).not.toHaveBeenCalled();
  });

  it("is the author's act (is_author): another clinician and a supervisor are refused, as for a section's confirmation", async () => {
    const { app, service } = makeServer();
    for (const headers of [OTHER, SUPERVISOR]) {
      const res = await app.inject({
        method: "PUT",
        url: elementUrl(),
        headers,
        payload: { included: true },
      });
      expect(res.statusCode).toBe(403);
    }
    expect(service.setDisciplinePlanElement).not.toHaveBeenCalled();
  });

  it("answers 404 for an encounter outside the caller's caseload", async () => {
    const { app, service } = makeServer({ inCaseload: false });
    const res = await app.inject({
      method: "PUT",
      url: elementUrl(),
      headers: AUTHOR,
      payload: { included: true },
    });
    expect(res.statusCode).toBe(404);
    expect(service.setDisciplinePlanElement).not.toHaveBeenCalled();
  });

  it("an AI principal cannot keep or leave out an element, even holding the key", async () => {
    const { app, service } = makeServer();
    const res = await app.inject({
      method: "PUT",
      url: elementUrl(),
      headers: as("author_1", "msw", { "x-test-actor-kind": "ai_agent" }),
      payload: { included: true },
    });
    expect(res.statusCode).toBe(403);
    expect(service.setDisciplinePlanElement).not.toHaveBeenCalled();
  });

  it("refuses a session with no membership (the removal is attributed to one)", async () => {
    const { app, service } = makeServer();
    const res = await app.inject({
      method: "PUT",
      url: elementUrl(),
      headers: as("author_1", "msw", { "x-test-no-membership": "1" }),
      payload: { included: true },
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(service.setDisciplinePlanElement).not.toHaveBeenCalled();
  });

  it("carries a 404 from the service (an element the viewer is not handed) in the standard error envelope", async () => {
    const { app, service } = makeServer();
    service.setDisciplinePlanElement.mockRejectedValueOnce(
      Object.assign(new Error("plan element not found"), { code: "NOT_FOUND", statusCode: 404 }),
    );
    const res = await app.inject({
      method: "PUT",
      url: elementUrl(),
      headers: AUTHOR,
      payload: { included: true },
    });
    expect(res.statusCode).toBe(404);
  });
});
