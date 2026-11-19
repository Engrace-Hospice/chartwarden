// ADR-0114 PR C2b1 - the visit-note draft routes through the FULL M1 middleware chain (Fastify `inject`), no live infra: the REAL
// Authorization Contract (permission, caseload scope, author-or-supervisor) and the real error envelope; the service is faked, so this
// proves the ROUTE layer: who may call, what the viewer is, what is validated, how errors read. The per-tenant 404 and the writes are
// proven in encounter-draft-service.test.ts and the live suite.
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
const HASH = "a".repeat(64);
const BODY = { resolution: "confirmed", contentHash: HASH, corpusVersion: "2026.11.0" };
const DRAFT = {
  encounterId: ENCOUNTER,
  patientId: PATIENT,
  templateKey: "routine_visit:rn",
  asOf: "2026-11-18T20:00:00.000Z",
  sections: [],
};
const SECTION = {
  sectionId: "plan",
  state: "confirmed",
  text: "Goal text.",
  contentHash: HASH,
  corpusVersion: "2026.11.0",
  part2Derived: false,
  origins: ["care_plan_goal"],
};

// The draft is computed from the care plan (M7), medication orders (M12) and scored scales (M9) through seams that apply no permission
// check of their own, so both draft routes ask for each source domain's read key on top of the encounter's (the keys of the sibling routes).
const DOMAIN_READS = ["care_plan.read", "prescribing.read", "assessment.read_trend"];
const without = (key: string) => DOMAIN_READS.filter((k) => k !== key);
const PERMISSION_SEED = [
  { userId: "author_1", permissions: ["encounter.read", "encounter.author", ...DOMAIN_READS] },
  { userId: "other_rn", permissions: ["encounter.read", "encounter.author", ...DOMAIN_READS] },
  { userId: "sup_1", permissions: ["encounter.read", "encounter.author", ...DOMAIN_READS] },
  { userId: "viewer_1", permissions: ["encounter.read", ...DOMAIN_READS] },
  // holds encounter.read / encounter.author but misses ONE source domain's read key
  ...DOMAIN_READS.map((missing) => ({
    userId: `no_${missing}`,
    permissions: ["encounter.read", "encounter.author", ...without(missing)],
  })),
  { userId: "encounter_only", permissions: ["encounter.read", "encounter.author"] },
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
    getDraft: vi.fn(async () => DRAFT),
    resolveSection: vi.fn(async () => SECTION),
  } as { [K in keyof DraftService]: ReturnType<typeof vi.fn> };
}

function makeServer(options: { inCaseload?: boolean; author?: string } = {}) {
  const backend = createInMemoryEncounterBackend({
    encounters: [
      {
        id: ENCOUNTER,
        organizationId: ORG,
        patientId: PATIENT,
        discipline: "rn",
        status: "draft",
        authoredByUserId: options.author ?? "author_1",
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
const AUTHOR = as("author_1", "rn");
const SUPERVISOR = as("sup_1", "clinical_supervisor");
const OTHER_RN = as("other_rn", "rn");
const VIEWER = as("viewer_1", "auditor");

const draftUrl = (id = ENCOUNTER) => `/api/v1/encounters/${id}/draft`;
const sectionUrl = (id = ENCOUNTER, section = "plan") => `${draftUrl(id)}/sections/${section}`;

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

describe("GET /encounters/:encounterId/draft", () => {
  it("answers the draft the service computed, for the SESSION viewer (roles and membership from the session, org from the session)", async () => {
    const { app, service } = makeServer();
    const res = await app.inject({
      method: "GET",
      url: draftUrl(),
      headers: as("author_1", "rn,rn_case_manager"),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(DRAFT);
    expect(service.getDraft).toHaveBeenCalledWith(
      {
        organizationId: ORG,
        userId: "author_1",
        roles: ["rn", "rn_case_manager"],
        membershipId: "author_1",
      },
      ENCOUNTER,
    );
  });

  it("lets a read-only reader open it, and passes a session with no membership as null (a read fails closed, it is not refused)", async () => {
    const { app, service } = makeServer();
    const res = await app.inject({
      method: "GET",
      url: draftUrl(),
      headers: as("viewer_1", "auditor", { "x-test-no-membership": "1" }),
    });
    expect(res.statusCode).toBe(200);
    expect(service.getDraft).toHaveBeenCalledWith(
      expect.objectContaining({ membershipId: null }),
      ENCOUNTER,
    );
  });

  it.each(DOMAIN_READS)(
    "needs %s as well: a role with encounter.read that misses it is refused 403 and nothing is computed or read",
    async (missing) => {
      const { app, service } = makeServer();
      const res = await app.inject({
        method: "GET",
        url: draftUrl(),
        headers: as(`no_${missing}`, "rn"),
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.message).toContain(missing);
      expect(service.getDraft).not.toHaveBeenCalled();
    },
  );

  it("refuses a role holding encounter.read and none of the source domains' read keys", async () => {
    const { app, service } = makeServer();
    const res = await app.inject({
      method: "GET",
      url: draftUrl(),
      headers: as("encounter_only", "chaplain"),
    });
    expect(res.statusCode).toBe(403);
    expect(service.getDraft).not.toHaveBeenCalled();
  });

  it("needs encounter.read: a caller without it is refused 403 and nothing is computed", async () => {
    const { app, service } = makeServer();
    const res = await app.inject({ method: "GET", url: draftUrl(), headers: as("nobody", "rn") });
    expect(res.statusCode).toBe(403);
    expect(service.getDraft).not.toHaveBeenCalled();
  });

  it("answers 404 for an encounter outside the caller's caseload, the same as an absent one", async () => {
    const { app, service } = makeServer({ inCaseload: false });
    const res = await app.inject({ method: "GET", url: draftUrl(), headers: AUTHOR });
    expect(res.statusCode).toBe(404);
    expect(service.getDraft).not.toHaveBeenCalled();
  });

  it("refuses a malformed encounter id with 422 before the scope predicate casts it", async () => {
    const { app, service } = makeServer();
    const res = await app.inject({ method: "GET", url: draftUrl("not-a-uuid"), headers: AUTHOR });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("VALIDATION_FAILED");
    expect(service.getDraft).not.toHaveBeenCalled();
  });

  it("is not swallowed by, and does not swallow, the neighbouring encounter routes", async () => {
    const { app, service } = makeServer();
    const byId = await app.inject({
      method: "GET",
      url: `/api/v1/encounters/${ENCOUNTER}`,
      headers: AUTHOR,
    });
    expect(byId.statusCode).toBe(200);
    expect(service.getDraft).not.toHaveBeenCalled();
    const policy = await app.inject({
      method: "GET",
      url: "/api/v1/encounters/draft-policy",
      headers: AUTHOR,
    });
    expect(policy.statusCode).toBe(403); // reached the policy route (needs draft_policy_admin), not the :encounterId route
  });

  it("carries a 503 DRAFT_UNAVAILABLE from the service in the standard error envelope", async () => {
    const { app, service } = makeServer();
    service.getDraft.mockRejectedValueOnce(
      new EncounterStateError(
        "DRAFT_UNAVAILABLE",
        "the visit-note draft could not be computed: the care plan is unavailable",
      ),
    );
    const res = await app.inject({ method: "GET", url: draftUrl(), headers: AUTHOR });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe("DRAFT_UNAVAILABLE");
  });

  it("declares a read audit against the encounter, attributed to the patient named in the response (names of fields only)", () => {
    const declared: Record<string, unknown>[] = [];
    const app = buildServer({ authenticate: headerAuth, security: { rateLimitEnabled: false } });
    app.addHook("onRoute", (route) => {
      if (route.url === "/api/v1/encounters/:encounterId/draft" && route.method === "GET") {
        declared.push(route.config?.auditRead as unknown as Record<string, unknown>);
      }
    });
    registerDraftSectionRoutes(app, { service: fakeService() as unknown as DraftService });
    expect(declared).toHaveLength(1);
    expect(declared[0]).toMatchObject({
      resourceKind: "encounter_draft",
      resourceIdParam: "encounterId",
      patientIdPayloadPath: "patientId",
    });
    expect(declared[0]?.fields).toEqual(expect.arrayContaining(["text", "contentHash", "state"]));
  });

  it("the amendment draft read (VN-D30) declares its own read audit, against the addendum and attributed to the patient (names of fields only)", () => {
    const declared: Record<string, unknown>[] = [];
    const app = buildServer({ authenticate: headerAuth, security: { rateLimitEnabled: false } });
    app.addHook("onRoute", (route) => {
      if (route.url.endsWith("/addenda/:addendumId/draft") && route.method === "GET") {
        declared.push(route.config?.auditRead as unknown as Record<string, unknown>);
      }
    });
    registerDraftSectionRoutes(app, { service: fakeService() as unknown as DraftService });
    expect(declared).toHaveLength(1);
    expect(declared[0]).toMatchObject({
      resourceKind: "encounter_amendment_draft",
      resourceIdParam: "addendumId",
      patientIdPayloadPath: "patientId",
    });
    expect(declared[0]?.fields).toEqual(expect.arrayContaining(["text", "contentHash", "state"]));
  });
});

describe("PUT /encounters/:encounterId/draft/sections/:sectionId", () => {
  it("passes the session actor, the ids from the path, the body and an audit context to the service, and answers its section", async () => {
    const { app, service } = makeServer();
    const res = await app.inject({
      method: "PUT",
      url: sectionUrl(),
      headers: AUTHOR,
      payload: BODY,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(SECTION);
    expect(service.resolveSection).toHaveBeenCalledWith(
      { organizationId: ORG, userId: "author_1", roles: ["rn"], membershipId: "author_1" },
      ENCOUNTER,
      "plan",
      BODY,
      expect.objectContaining({ organizationId: ORG, userId: "author_1", actorKind: "user" }),
    );
  });

  it("never takes the viewer from the body: roles or a membership sent there change nothing", async () => {
    const { app, service } = makeServer();
    await app.inject({
      method: "PUT",
      url: sectionUrl(),
      headers: AUTHOR,
      payload: {
        ...BODY,
        roles: ["hospice_physician"],
        membershipId: "someone_else",
        organizationId: "org_b",
      },
    });
    expect(service.resolveSection.mock.calls[0]?.[0]).toEqual({
      organizationId: ORG,
      userId: "author_1",
      roles: ["rn"],
      membershipId: "author_1",
    });
  });

  it.each(DOMAIN_READS)(
    "needs %s as well: the section it answers carries source text, so an author missing it is refused 403 and nothing is written",
    async (missing) => {
      // The caller IS the encounter's author, so only the missing source-domain key can refuse this call.
      const { app, service } = makeServer({ author: `no_${missing}` });
      const res = await app.inject({
        method: "PUT",
        url: sectionUrl(),
        headers: as(`no_${missing}`, "rn"),
        payload: BODY,
      });
      expect(res.statusCode).toBe(403);
      expect(service.resolveSection).not.toHaveBeenCalled();
    },
  );

  it("needs encounter.author: a read-only caller is refused 403", async () => {
    const { app, service } = makeServer();
    const res = await app.inject({
      method: "PUT",
      url: sectionUrl(),
      headers: VIEWER,
      payload: BODY,
    });
    expect(res.statusCode).toBe(403);
    expect(service.resolveSection).not.toHaveBeenCalled();
  });

  it("is the author's act (is_author): an RN who did not author the encounter is refused, and so is a supervisor, so the signer is who confirmed the draft (C2)", async () => {
    const { app, service } = makeServer();
    for (const headers of [OTHER_RN, SUPERVISOR]) {
      const res = await app.inject({ method: "PUT", url: sectionUrl(), headers, payload: BODY });
      expect(res.statusCode).toBe(403);
    }
    expect(service.resolveSection).not.toHaveBeenCalled();
    const author = await app.inject({
      method: "PUT",
      url: sectionUrl(),
      headers: AUTHOR,
      payload: BODY,
    });
    expect(author.statusCode).toBe(200);
    expect(service.resolveSection).toHaveBeenCalledTimes(1);
  });

  it("the draft READ is unchanged: a supervisor still opens the draft (only the write became the author's act)", async () => {
    const { app, service } = makeServer();
    const res = await app.inject({ method: "GET", url: draftUrl(), headers: SUPERVISOR });
    expect(res.statusCode).toBe(200);
    expect(service.getDraft).toHaveBeenCalledTimes(1);
  });

  it("answers 404 for an encounter outside the caller's caseload", async () => {
    const { app, service } = makeServer({ inCaseload: false });
    const res = await app.inject({
      method: "PUT",
      url: sectionUrl(),
      headers: AUTHOR,
      payload: BODY,
    });
    expect(res.statusCode).toBe(404);
    expect(service.resolveSection).not.toHaveBeenCalled();
  });

  it("an AI principal cannot confirm or deselect, even holding the key", async () => {
    const { app, service } = makeServer();
    const res = await app.inject({
      method: "PUT",
      url: sectionUrl(),
      headers: as("author_1", "rn", { "x-test-actor-kind": "ai_agent" }),
      payload: BODY,
    });
    expect(res.statusCode).toBe(403);
    expect(service.resolveSection).not.toHaveBeenCalled();
  });

  it("refuses a session with no membership (the confirmation is attributed to one)", async () => {
    const { app, service } = makeServer();
    const res = await app.inject({
      method: "PUT",
      url: sectionUrl(),
      headers: as("author_1", "rn", { "x-test-no-membership": "1" }),
      payload: BODY,
    });
    expect(res.statusCode).toBe(403);
    expect(service.resolveSection).not.toHaveBeenCalled();
  });

  it.each([
    ["a missing resolution", { contentHash: HASH, corpusVersion: "x" }],
    ["a resolution that is neither confirmed nor deselected", { ...BODY, resolution: "edited" }],
    ["a missing content hash", { resolution: "confirmed", corpusVersion: "x" }],
    ["a hash that is not 64 lowercase hex characters", { ...BODY, contentHash: "ABC" }],
    ["a missing corpus version", { resolution: "confirmed", contentHash: HASH }],
    ["an empty corpus version", { ...BODY, corpusVersion: "" }],
  ])("refuses %s with 422 and writes nothing", async (_label, payload) => {
    const { app, service } = makeServer();
    const res = await app.inject({ method: "PUT", url: sectionUrl(), headers: AUTHOR, payload });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("VALIDATION_FAILED");
    expect(service.resolveSection).not.toHaveBeenCalled();
  });

  it.each([
    ["a malformed encounter id", sectionUrl("nope")],
    ["a section id that is not snake case", sectionUrl(ENCOUNTER, "Plan-1")],
  ])("refuses %s with 422", async (_label, url) => {
    const { app, service } = makeServer();
    const res = await app.inject({ method: "PUT", url, headers: AUTHOR, payload: BODY });
    expect(res.statusCode).toBe(422);
    expect(service.resolveSection).not.toHaveBeenCalled();
  });

  it("carries a 409 DRAFT_SECTION_STALE from the service in the standard error envelope", async () => {
    const { app, service } = makeServer();
    service.resolveSection.mockRejectedValueOnce(
      new EncounterStateError(
        "DRAFT_SECTION_STALE",
        "section 'plan' no longer matches the draft you resolved",
      ),
    );
    const res = await app.inject({
      method: "PUT",
      url: sectionUrl(),
      headers: AUTHOR,
      payload: BODY,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("DRAFT_SECTION_STALE");
  });

  it("carries a deselect through unchanged", async () => {
    const { app, service } = makeServer();
    await app.inject({
      method: "PUT",
      url: sectionUrl(),
      headers: AUTHOR,
      payload: { ...BODY, resolution: "deselected" },
    });
    expect(service.resolveSection.mock.calls[0]?.[3]).toMatchObject({ resolution: "deselected" });
  });
});
