// ADR-0114 S5b (VN-D64 to VN-D67) - the IDG action item routes of an IDG follow-up visit through the FULL M1 middleware chain (Fastify `inject`), no live
// infra: the REAL Authorization Contract (permission, caseload scope, the author's own rule) and the real error envelope; the service is faked, so this proves
// the ROUTE layer: who may call, what the viewer is, what is validated, how errors read. The switch, the `idg.act` key, Part 2 and the writes are proven in
// encounter-draft-idg-action-items.test.ts and the live suite.
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
const ITEM = "c0000000-0000-4000-8000-0000000000c1";
const VIEW = {
  patientId: PATIENT,
  items: [
    {
      actionItemId: ITEM,
      meetingDate: "2026-11-02",
      decisionKind: "referral",
      decisionLabel: "a referral",
      dueDate: "2026-11-20",
      status: "open",
      linked: true,
    },
  ],
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
    getIdgActionItems: vi.fn(async () => VIEW),
    setIdgActionItem: vi.fn(async () => VIEW),
  } as unknown as { [K in keyof DraftService]: ReturnType<typeof vi.fn> };
}

function makeServer(options: { inCaseload?: boolean } = {}) {
  const backend = createInMemoryEncounterBackend({
    encounters: [
      {
        id: ENCOUNTER,
        organizationId: ORG,
        patientId: PATIENT,
        discipline: "rn",
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
const AUTHOR = as("author_1", "rn");
const SUPERVISOR = as("sup_1", "clinical_supervisor");
const OTHER = as("other_rn", "rn");
const VIEWER = as("viewer_1", "auditor");

const listUrl = (id = ENCOUNTER) => `/api/v1/encounters/${id}/idg-action-items`;
const linkUrl = (id = ENCOUNTER) => `/api/v1/encounters/${id}/idg-action-item`;

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

const declaredAudit = (method: "GET" | "PUT", url: string): Record<string, unknown>[] => {
  const declared: Record<string, unknown>[] = [];
  const app = buildServer({ authenticate: headerAuth, security: { rateLimitEnabled: false } });
  app.addHook("onRoute", (route) => {
    if (route.url === url && route.method === method) {
      declared.push(route.config?.auditRead as unknown as Record<string, unknown>);
    }
  });
  registerDraftSectionRoutes(app, { service: fakeService() as unknown as DraftService });
  return declared;
};

describe("GET /encounters/:encounterId/idg-action-items", () => {
  it("answers the service's candidates, for the SESSION viewer (roles, membership and permissions from the session)", async () => {
    const { app, service } = makeServer();
    const res = await app.inject({ method: "GET", url: listUrl(), headers: AUTHOR });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(VIEW);
    expect(service.getIdgActionItems).toHaveBeenCalledWith(
      {
        organizationId: ORG,
        userId: "author_1",
        roles: ["rn"],
        membershipId: "author_1",
        permissions: expect.any(Set),
      },
      ENCOUNTER,
    );
  });

  it("lets a read-only reader open it (only the write is the author's act); the service asks the idg.act key itself", async () => {
    const { app, service } = makeServer();
    const res = await app.inject({ method: "GET", url: listUrl(), headers: VIEWER });
    expect(res.statusCode).toBe(200);
    expect(service.getIdgActionItems).toHaveBeenCalledOnce();
  });

  it("needs encounter.read: a caller without it is refused 403 and nothing is read", async () => {
    const { app, service } = makeServer();
    const res = await app.inject({ method: "GET", url: listUrl(), headers: as("nobody", "rn") });
    expect(res.statusCode).toBe(403);
    expect(service.getIdgActionItems).not.toHaveBeenCalled();
  });

  it("answers 404 for an encounter outside the caller's caseload, the same as an absent one", async () => {
    const { app, service } = makeServer({ inCaseload: false });
    const res = await app.inject({ method: "GET", url: listUrl(), headers: AUTHOR });
    expect(res.statusCode).toBe(404);
    expect(service.getIdgActionItems).not.toHaveBeenCalled();
  });

  it("refuses a malformed encounter id with 422 before the scope predicate casts it", async () => {
    const { app, service } = makeServer();
    const res = await app.inject({ method: "GET", url: listUrl("not-a-uuid"), headers: AUTHOR });
    expect(res.statusCode).toBe(422);
    expect(service.getIdgActionItems).not.toHaveBeenCalled();
  });

  it("carries a 422 UNKNOWN_TEMPLATE_SECTION and a 403 naming idg.act from the service in the standard error envelope", async () => {
    const { app, service } = makeServer();
    service.getIdgActionItems.mockRejectedValueOnce(
      new EncounterStateError(
        "UNKNOWN_TEMPLATE_SECTION",
        "this visit's note is not drafted from an IDG action item",
      ),
    );
    const refused = await app.inject({ method: "GET", url: listUrl(), headers: AUTHOR });
    expect(refused.statusCode).toBe(422);
    expect(refused.json().error.code).toBe("UNKNOWN_TEMPLATE_SECTION");

    service.getIdgActionItems.mockRejectedValueOnce(
      Object.assign(new Error("requires permission 'idg.act'"), {
        code: "FORBIDDEN",
        statusCode: 403,
      }),
    );
    const forbidden = await app.inject({ method: "GET", url: listUrl(), headers: AUTHOR });
    expect(forbidden.statusCode).toBe(403);
  });

  it("declares a read audit against the encounter, attributed to the patient named in the response (names of fields only, no title or body)", () => {
    const declared = declaredAudit("GET", "/api/v1/encounters/:encounterId/idg-action-items");
    expect(declared).toHaveLength(1);
    expect(declared[0]).toMatchObject({
      resourceKind: "encounter_idg_action_items",
      resourceIdParam: "encounterId",
      patientIdPayloadPath: "patientId",
    });
    expect(declared[0]?.fields).toEqual(
      expect.arrayContaining(["items", "meetingDate", "decisionKind", "dueDate", "linked"]),
    );
    expect(declared[0]?.fields).not.toEqual(expect.arrayContaining(["title"]));
    expect(declared[0]?.fields).not.toEqual(expect.arrayContaining(["bodyText"]));
  });

  it("the PUT answers the same list, so it declares the same read audit (clearing a link that was never made leaves no row-trigger event)", () => {
    const declared = declaredAudit("PUT", "/api/v1/encounters/:encounterId/idg-action-item");
    expect(declared).toHaveLength(1);
    expect(declared[0]).toMatchObject({
      resourceKind: "encounter_idg_action_items",
      resourceIdParam: "encounterId",
      patientIdPayloadPath: "patientId",
    });
  });
});

describe("PUT /encounters/:encounterId/idg-action-item", () => {
  it("passes the session actor, the encounter id, the body and an audit context to the service, and answers its view", async () => {
    const { app, service } = makeServer();
    const res = await app.inject({
      method: "PUT",
      url: linkUrl(),
      headers: AUTHOR,
      payload: { actionItemId: ITEM },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(VIEW);
    expect(service.setIdgActionItem).toHaveBeenCalledWith(
      {
        organizationId: ORG,
        userId: "author_1",
        roles: ["rn"],
        membershipId: "author_1",
        permissions: expect.any(Set),
      },
      ENCOUNTER,
      { actionItemId: ITEM },
      expect.objectContaining({ organizationId: ORG, userId: "author_1", actorKind: "user" }),
    );
  });

  it("clears the link with a null item", async () => {
    const { app, service } = makeServer();
    const res = await app.inject({
      method: "PUT",
      url: linkUrl(),
      headers: AUTHOR,
      payload: { actionItemId: null },
    });
    expect(res.statusCode).toBe(200);
    expect(service.setIdgActionItem).toHaveBeenCalledWith(
      expect.anything(),
      ENCOUNTER,
      { actionItemId: null },
      expect.anything(),
    );
  });

  it("never takes the viewer from the body: roles or a membership sent there are refused, not used", async () => {
    const { app, service } = makeServer();
    const res = await app.inject({
      method: "PUT",
      url: linkUrl(),
      headers: AUTHOR,
      payload: { actionItemId: ITEM, roles: ["org_admin"], membershipId: "someone_else" },
    });
    expect(res.statusCode).toBe(422);
    expect(service.setIdgActionItem).not.toHaveBeenCalled();
  });

  it.each([
    ["no body", undefined],
    ["an empty body", {}],
    ["a number for the item", { actionItemId: 7 }],
    ["an item that is not a uuid", { actionItemId: "not-a-uuid" }],
    ["a list of items (one item per visit)", { actionItemId: [ITEM] }],
  ])("refuses %s with 422", async (_name, payload) => {
    const { app, service } = makeServer();
    const res = await app.inject({
      method: "PUT",
      url: linkUrl(),
      headers: AUTHOR,
      ...(payload === undefined ? {} : { payload }),
    });
    expect(res.statusCode).toBe(422);
    expect(service.setIdgActionItem).not.toHaveBeenCalled();
  });

  it("refuses a malformed encounter id with 422 before the scope predicate casts it", async () => {
    const { app, service } = makeServer();
    const res = await app.inject({
      method: "PUT",
      url: linkUrl("nope"),
      headers: AUTHOR,
      payload: { actionItemId: ITEM },
    });
    expect(res.statusCode).toBe(422);
    expect(service.setIdgActionItem).not.toHaveBeenCalled();
  });

  it("needs encounter.author: a read-only caller is refused 403", async () => {
    const { app, service } = makeServer();
    const res = await app.inject({
      method: "PUT",
      url: linkUrl(),
      headers: VIEWER,
      payload: { actionItemId: ITEM },
    });
    expect(res.statusCode).toBe(403);
    expect(service.setIdgActionItem).not.toHaveBeenCalled();
  });

  it("is the author's act (is_author): another clinician and a supervisor are refused, as for a section's confirmation", async () => {
    const { app, service } = makeServer();
    for (const headers of [OTHER, SUPERVISOR]) {
      const res = await app.inject({
        method: "PUT",
        url: linkUrl(),
        headers,
        payload: { actionItemId: ITEM },
      });
      expect(res.statusCode).toBe(403);
    }
    expect(service.setIdgActionItem).not.toHaveBeenCalled();
  });

  it("answers 404 for an encounter outside the caller's caseload", async () => {
    const { app, service } = makeServer({ inCaseload: false });
    const res = await app.inject({
      method: "PUT",
      url: linkUrl(),
      headers: AUTHOR,
      payload: { actionItemId: ITEM },
    });
    expect(res.statusCode).toBe(404);
    expect(service.setIdgActionItem).not.toHaveBeenCalled();
  });

  it("an AI principal cannot link a visit to an action item, even holding the key", async () => {
    const { app, service } = makeServer();
    const res = await app.inject({
      method: "PUT",
      url: linkUrl(),
      headers: as("author_1", "rn", { "x-test-actor-kind": "ai_agent" }),
      payload: { actionItemId: ITEM },
    });
    expect(res.statusCode).toBe(403);
    expect(service.setIdgActionItem).not.toHaveBeenCalled();
  });

  it("refuses a session with no membership (the link is attributed to one)", async () => {
    const { app, service } = makeServer();
    const res = await app.inject({
      method: "PUT",
      url: linkUrl(),
      headers: as("author_1", "rn", { "x-test-no-membership": "1" }),
      payload: { actionItemId: ITEM },
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(service.setIdgActionItem).not.toHaveBeenCalled();
  });

  it("carries a 404 and a 409 IDG_ACTION_ITEM_LINK_LIMIT from the service in the standard error envelope", async () => {
    const { app, service } = makeServer();
    service.setIdgActionItem.mockRejectedValueOnce(
      Object.assign(new Error("action item not found"), { code: "NOT_FOUND", statusCode: 404 }),
    );
    const missing = await app.inject({
      method: "PUT",
      url: linkUrl(),
      headers: AUTHOR,
      payload: { actionItemId: ITEM },
    });
    expect(missing.statusCode).toBe(404);

    service.setIdgActionItem.mockRejectedValueOnce(
      new EncounterStateError("IDG_ACTION_ITEM_LINK_LIMIT", "nothing was changed"),
    );
    const full = await app.inject({
      method: "PUT",
      url: linkUrl(),
      headers: AUTHOR,
      payload: { actionItemId: ITEM },
    });
    expect(full.statusCode).toBe(409);
    expect(full.json().error.code).toBe("IDG_ACTION_ITEM_LINK_LIMIT");
  });
});
