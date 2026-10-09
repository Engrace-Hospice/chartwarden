// apps/backend/__tests__/m23-dde-queue-routes.test.ts — HTTP-layer proof of the DDE work-queue routes
// (`/api/v1/billing/dde-items`, ADR-0052) over the REAL Authorization Contract (RBAC + the real
// `provider_entity_billing_scope` predicate + step-up) and an in-memory `DdeQueueService`. What this proves that the
// live suite (which drives the service over real Postgres) cannot: the right permission key guards each route,
// record-submission needs the step-up, assigning needs the admin key, an out-of-scope provider entity is a 404, the
// AI-block and Idempotency-Key guards are composed, and malformed bodies are refused before the service runs.
import {
  createInMemoryEffectivePermissionStore,
  createPredicateRegistry,
  registerAbacRegistry,
  registerEffectivePermissionResolver,
  resetAbacRegistry,
  resetAuthorizationContract,
  resetRbacEngine,
} from "@wardenx/auth";
import type { FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import { buildM23AbacPredicates } from "../src/modules/23-billing-medicare/abac-predicates";
import type { ReadingM23AbacResolver } from "../src/modules/23-billing-medicare/abac-resolver-drizzle";
import { registerDdeQueueRoutes } from "../src/modules/23-billing-medicare/routes/dde-queue.routes";
import type { DdeItemView } from "../src/modules/23-billing-medicare/services/dde-queue-service";
import type { DdeQueueService } from "../src/modules/23-billing-medicare/services/dde-queue-service";

const ORG = "0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a";
const ITEM = "12121212-1212-4212-8212-121212121212";
const NOE = "34343434-3434-4434-8434-343434343434";
const PE_IN = "77777777-7777-4777-8777-777777777777";
const PE_OUT = "88888888-8888-4888-8888-888888888888";
const PATIENT = "99999999-9999-4999-8999-999999999999";
const MEMBERSHIP = "abababab-abab-4bab-8bab-abababababab";

function headerAuth(request: FastifyRequest): void {
  const user = request.headers["x-test-user"];
  if (typeof user !== "string" || user.length === 0) return;
  request.context.userId = user;
  request.context.organizationId = ORG;
  const roles = request.headers["x-test-roles"];
  request.context.roles = typeof roles === "string" && roles.length > 0 ? roles.split(",") : [];
  request.context.attributes.membershipId = MEMBERSHIP;
  if (request.headers["x-test-step-up"] === "1") request.context.attributes.stepUpRecent = true;
  const pe = request.headers["x-test-pe"];
  if (typeof pe === "string" && pe.length > 0) request.context.providerEntityIds = [pe];
  const actorKind = request.headers["x-test-actor-kind"];
  if (typeof actorKind === "string" && actorKind.length > 0) {
    request.context.attributes.actorKind = actorKind;
  }
}

const VIEW: DdeItemView = {
  ddeWorkItemId: ITEM,
  organizationId: ORG,
  providerEntityId: PE_IN,
  patientId: PATIENT,
  itemType: "noe",
  subjectKind: "noe_record",
  subjectId: NOE,
  state: "queued",
  attemptNumber: 1,
  assigneeMembershipId: null,
  priority: 2,
  source: "manual",
  deadlineAt: "2026-10-10",
  deadlineStatus: "on_track",
  submittedAt: null,
  macAcceptedOn: null,
  dcn: null,
  rtpReasonCode: null,
  outcomeCode: null,
  notes: null,
  allowedActions: ["claim", "assign", "cancel"],
  version: 0,
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
};

const resolver: ReadingM23AbacResolver = {
  async loadClaim() {
    return null;
  },
  async loadNoe(_ctx, id) {
    return id === NOE
      ? {
          entityId: NOE,
          organizationId: ORG,
          providerEntityId: PE_IN,
          patientId: PATIENT,
          state: null,
        }
      : null;
  },
  async loadNotr() {
    return null;
  },
  async loadDdeWorkItem(_ctx, id) {
    return id === ITEM
      ? {
          entityId: ITEM,
          organizationId: ORG,
          providerEntityId: PE_IN,
          patientId: PATIENT,
          state: null,
        }
      : null;
  },
  async loadValidationResult() {
    return null;
  },
  async loadRuleConfig() {
    return null;
  },
};

function makeServer() {
  const calls: string[] = [];
  const view = async (tag: string): Promise<DdeItemView> => {
    calls.push(tag);
    return VIEW;
  };
  const service: DdeQueueService = {
    async list(_a, filter) {
      calls.push(`list:${JSON.stringify(filter)}`);
      return { items: [VIEW], nextCursor: null, hasMore: false };
    },
    async get() {
      calls.push("get");
      return { ...VIEW, events: [] };
    },
    create: (_a, body) => view(`create:${body.itemType}`),
    claim: () => view("claim"),
    assign: (_a, _id, body) => view(`assign:${body.assigneeMembershipId}`),
    start: () => view("start"),
    recordSubmission: () => view("record-submission"),
    recordOutcome: (_a, _id, body) => view(`record-outcome:${body.outcome}`),
    recordAcceptance: () => view("record-acceptance"),
    retry: () => view("retry"),
    cancel: () => view("cancel"),
    close: () => view("close"),
  };
  const grant = (userId: string, keys: string[]) => ({
    orgId: ORG,
    userId,
    grants: [{ roleKey: "seed", enabled: true, expiresAt: null, permissionKeys: keys }],
  });
  registerEffectivePermissionResolver(
    createInMemoryEffectivePermissionStore([
      grant("admin_1", [
        "billing.dde.read",
        "billing.dde.work",
        "billing.dde.mark_submitted",
        "billing.dde.admin",
      ]),
      grant("worker_1", ["billing.dde.read", "billing.dde.work"]),
      grant("reader_1", ["billing.dde.read"]),
      grant("biller_1", ["billing.dde.read", "billing.dde.work", "billing.dde.mark_submitted"]),
      grant("none_1", []),
    ]).store,
  );
  const reg = createPredicateRegistry();
  for (const [name, predicate] of Object.entries(
    buildM23AbacPredicates({ resolver, isInCaseload: async () => true }),
  )) {
    reg.register(name, predicate);
  }
  reg.register("step_up_recent", async (context) => context.attributes.stepUpRecent === true);
  registerAbacRegistry(reg);
  const app = buildServer({ authenticate: headerAuth, security: { rateLimitEnabled: false } });
  registerDdeQueueRoutes(app, { ddeQueueService: service });
  return { app, calls };
}

const ADMIN = { "x-test-user": "admin_1", "x-test-roles": "org_admin" };
const WORKER = { "x-test-user": "worker_1", "x-test-roles": "billing_manager", "x-test-pe": PE_IN };
const READER = { "x-test-user": "reader_1", "x-test-roles": "billing_manager", "x-test-pe": PE_IN };
const BILLER = { "x-test-user": "biller_1", "x-test-roles": "billing_manager", "x-test-pe": PE_IN };
const NONE = { "x-test-user": "none_1", "x-test-roles": "" };
let idemCounter = 0;
const idem = () => ({ "idempotency-key": `dde-${++idemCounter}` });
const BASE = "/api/v1/billing/dde-items";

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

describe("M23 DDE work-queue routes (ADR-0052)", () => {
  it("401s without a session and 403s a session with no DDE grant", async () => {
    const { app } = makeServer();
    expect((await app.inject({ method: "GET", url: BASE })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: BASE, headers: NONE })).statusCode).toBe(403);
    await app.close();
  });

  it("lists with the typed filters (overdue / atRisk booleans, state, type)", async () => {
    const { app, calls } = makeServer();
    const res = await app.inject({
      method: "GET",
      url: `${BASE}?overdue=true&state=submitted&itemType=noe`,
      headers: READER,
    });
    expect(res.statusCode).toBe(200);
    expect(calls[0]).toContain('"overdue":true');
    expect(calls[0]).toContain('"state":"submitted"');
    const bad = await app.inject({ method: "GET", url: `${BASE}?state=bogus`, headers: READER });
    expect(bad.statusCode).toBeGreaterThanOrEqual(400);
    await app.close();
  });

  it("gets an item in scope and 404s one outside the actor's provider entities", async () => {
    const { app } = makeServer();
    expect(
      (await app.inject({ method: "GET", url: `${BASE}/${ITEM}`, headers: READER })).statusCode,
    ).toBe(200);
    const outside = await app.inject({
      method: "GET",
      url: `${BASE}/${ITEM}`,
      headers: { ...READER, "x-test-pe": PE_OUT },
    });
    expect(outside.statusCode).toBe(404);
    await app.close();
  });

  it("a read-only holder cannot work an item (403); a worker can claim, start and record an outcome", async () => {
    const { app, calls } = makeServer();
    const post = (
      headers: Record<string, string>,
      path: string,
      payload: Record<string, unknown>,
    ) =>
      app.inject({
        method: "POST",
        url: `${BASE}/${ITEM}/${path}`,
        headers: { ...headers, ...idem() },
        payload,
      });
    expect((await post(READER, "claim", { expectedVersion: 0 })).statusCode).toBe(403);
    expect((await post(WORKER, "claim", { expectedVersion: 0 })).statusCode).toBe(200);
    expect((await post(WORKER, "start", { expectedVersion: 1 })).statusCode).toBe(200);
    const outcome = await post(WORKER, "record-outcome", {
      expectedVersion: 3,
      outcome: "returned",
      rtpReasonCode: "37001",
    });
    expect(outcome.statusCode).toBe(200);
    expect(calls).toEqual(["claim", "start", "record-outcome:returned"]);
    await app.close();
  });

  it("record-submission needs mark_submitted AND a recent step-up", async () => {
    const { app, calls } = makeServer();
    const url = `${BASE}/${ITEM}/record-submission`;
    const payload = { expectedVersion: 2, dcn: "22123456789012345" };
    const noKey = await app.inject({
      method: "POST",
      url,
      headers: { ...WORKER, ...idem(), "x-test-step-up": "1" },
      payload,
    });
    expect(noKey.statusCode).toBe(403); // worker lacks billing.dde.mark_submitted
    const noStepUp = await app.inject({
      method: "POST",
      url,
      headers: { ...BILLER, ...idem() },
      payload,
    });
    expect(noStepUp.statusCode).toBe(403);
    expect(calls).toEqual([]);
    const ok = await app.inject({
      method: "POST",
      url,
      headers: { ...BILLER, ...idem(), "x-test-step-up": "1" },
      payload,
    });
    expect(ok.statusCode).toBe(200);
    expect(calls).toEqual(["record-submission"]);
    await app.close();
  });

  it("an ACCEPTED outcome needs mark_submitted AND a recent step-up, never plain work", async () => {
    const { app, calls } = makeServer();
    const url = `${BASE}/${ITEM}/record-acceptance`;
    const payload = { expectedVersion: 3, macAcceptedOn: "2026-10-08" };
    // a work-only user is refused, step-up or not
    const workOnly = await app.inject({
      method: "POST",
      url,
      headers: { ...WORKER, ...idem(), "x-test-step-up": "1" },
      payload,
    });
    expect(workOnly.statusCode).toBe(403);
    // mark_submitted without step-up is refused
    const noStepUp = await app.inject({
      method: "POST",
      url,
      headers: { ...BILLER, ...idem() },
      payload,
    });
    expect(noStepUp.statusCode).toBe(403);
    expect(calls).toEqual([]);
    const ok = await app.inject({
      method: "POST",
      url,
      headers: { ...BILLER, ...idem(), "x-test-step-up": "1" },
      payload,
    });
    expect(ok.statusCode).toBe(200);
    // the returned-outcome route no longer accepts an accepted outcome
    const viaOutcome = await app.inject({
      method: "POST",
      url: `${BASE}/${ITEM}/record-outcome`,
      headers: { ...WORKER, ...idem() },
      payload: { expectedVersion: 3, outcome: "accepted", macAcceptedOn: "2026-10-08" },
    });
    expect(viaOutcome.statusCode).toBeGreaterThanOrEqual(400);
    expect(calls).toEqual(["record-acceptance"]);
    await app.close();
  });

  it.each([
    ["an 11-character DCN", { dcn: "1EG4TE5MK73" }],
    ["a free-form outcome code", { outcomeCode: "1EG4TE5MK73" }],
  ])("rejects %s on an acceptance before the service runs", async (_n, over) => {
    const { app, calls } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: `${BASE}/${ITEM}/record-acceptance`,
      headers: { ...BILLER, ...idem(), "x-test-step-up": "1" },
      payload: { expectedVersion: 3, macAcceptedOn: "2026-10-08", ...over },
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).toBeLessThan(500);
    expect(calls).toEqual([]);
    await app.close();
  });

  it("fails closed (4xx, never 500) on a non-uuid subject or item id", async () => {
    const { app } = makeServer();
    const create = await app.inject({
      method: "POST",
      url: BASE,
      headers: { ...WORKER, ...idem() },
      payload: { itemType: "noe", subjectId: "not-a-uuid" },
    });
    expect(create.statusCode).toBeGreaterThanOrEqual(400);
    expect(create.statusCode).toBeLessThan(500);
    const get = await app.inject({ method: "GET", url: `${BASE}/not-a-uuid`, headers: READER });
    expect(get.statusCode).toBeGreaterThanOrEqual(400);
    expect(get.statusCode).toBeLessThan(500);
    await app.close();
  });

  it("assigning to someone else needs the admin key", async () => {
    const { app, calls } = makeServer();
    const url = `${BASE}/${ITEM}/assign`;
    const payload = { expectedVersion: 0, assigneeMembershipId: MEMBERSHIP };
    expect(
      (await app.inject({ method: "POST", url, headers: { ...WORKER, ...idem() }, payload }))
        .statusCode,
    ).toBe(403);
    expect(
      (await app.inject({ method: "POST", url, headers: { ...ADMIN, ...idem() }, payload }))
        .statusCode,
    ).toBe(200);
    expect(calls).toEqual([`assign:${MEMBERSHIP}`]);
    await app.close();
  });

  it("creates an item scoped by the SUBJECT's provider entity (201), 404 when the subject is out of scope", async () => {
    const { app, calls } = makeServer();
    const payload = { itemType: "noe", subjectId: NOE };
    const ok = await app.inject({
      method: "POST",
      url: BASE,
      headers: { ...WORKER, ...idem() },
      payload,
    });
    expect(ok.statusCode).toBe(201);
    const outside = await app.inject({
      method: "POST",
      url: BASE,
      headers: { ...WORKER, ...idem(), "x-test-pe": PE_OUT },
      payload,
    });
    expect(outside.statusCode).toBe(404);
    expect(calls).toEqual(["create:noe"]);
    await app.close();
  });

  it("requires an Idempotency-Key and refuses an AI principal on every mutation", async () => {
    const { app, calls } = makeServer();
    const url = `${BASE}/${ITEM}/cancel`;
    const payload = { expectedVersion: 0 };
    expect(
      (await app.inject({ method: "POST", url, headers: WORKER, payload })).statusCode,
    ).toBeGreaterThanOrEqual(400);
    const ai = await app.inject({
      method: "POST",
      url,
      headers: { ...WORKER, ...idem(), "x-test-actor-kind": "ai_agent" },
      payload,
    });
    expect(ai.statusCode).toBe(403);
    expect(calls).toEqual([]);
    await app.close();
  });

  it.each([
    [
      "a note over the cap",
      `${BASE}/${ITEM}/record-submission`,
      { expectedVersion: 0, notes: "x".repeat(501) },
    ],
    [
      "a malformed DCN",
      `${BASE}/${ITEM}/record-submission`,
      { expectedVersion: 0, dcn: "not a dcn!" },
    ],
    ["a missing version", `${BASE}/${ITEM}/start`, {}],
    [
      "an unknown outcome",
      `${BASE}/${ITEM}/record-outcome`,
      { expectedVersion: 0, outcome: "paid" },
    ],
    ["an unknown item type", BASE, { itemType: "fax", subjectId: NOE }],
  ])("rejects %s before the service runs", async (_name, url, payload) => {
    const { app, calls } = makeServer();
    const res = await app.inject({
      method: "POST",
      url,
      headers: { ...ADMIN, ...idem(), "x-test-step-up": "1" },
      payload,
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).toBeLessThan(500);
    expect(calls).toEqual([]);
    await app.close();
  });
});
