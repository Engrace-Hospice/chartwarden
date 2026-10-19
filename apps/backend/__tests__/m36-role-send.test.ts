// ADR-0081 (PROPOSED) - role-based send over the REAL Authorization Contract: every key is required, the tenant flag off is the uniform 404,
// the patient gate (patient.read + the real caseload_or_scope + the org-scoped existence check) refuses with one identical 404 before the
// router is asked, a gap / unconnected roster is an explicit refusal (nothing sent), a changed resolution is a 409 (nothing sent), the
// audit row lands against the patient, and the Idempotency-Key is required.
import { randomUUID } from "node:crypto";
import {
  createInMemoryEffectivePermissionStore,
  createPredicateRegistry,
  registerAbacRegistry,
  registerEffectivePermissionResolver,
  requirePermission,
  resetAbacRegistry,
  resetAuthorizationContract,
  resetRbacEngine,
} from "@wardenx/auth";
import type { DbClient } from "@wardenx/db";
import { NotFoundError } from "@wardenx/types";
import type { EscalationRouteAnswer, EscalationRouter } from "@wardenx/types";
import type { FastifyReply, FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import { escalationRouterDenyStub } from "../src/bootstrap/seams/providers";
import { buildCarePlanAbacPredicates } from "../src/modules/07-care-plan/abac-predicates";
import { guardEscalationRouter } from "../src/modules/36-messaging/ack-escalation/escalation-router-guard";
import { createRoleSendService } from "../src/modules/36-messaging/oncall-directory/role-send-service";
import { REQUIRE_IDEMPOTENCY_KEY } from "../src/modules/36-messaging/routes/messaging-routes";
import { registerRoleSendRoutes } from "../src/modules/36-messaging/routes/role-send-routes";

type Handler = (r: FastifyRequest, p: FastifyReply) => Promise<void>;

const ORG = "00000000-0000-4000-8000-00000000000a";
const CHANNEL = "cccccccc-cccc-4ccc-8ccc-000000000001";
const PATIENT = "99999999-9999-4999-8999-000000000001";
const UNASSIGNED_PATIENT = "88888888-8888-4888-8888-000000000002";
const GHOST_PATIENT = "66666666-6666-4666-8666-000000000004";
const OTHER_CHANNEL_PATIENT = "55555555-5555-4555-8555-000000000005";
const PATIENTS_IN_ORG = new Set([PATIENT, UNASSIGNED_PATIENT, OTHER_CHANNEL_PATIENT]);
const COVERING = "dddddddd-dddd-4ddd-8ddd-000000000001";
const OTHER = "dddddddd-dddd-4ddd-8ddd-000000000002";
const para = (text: string) => ({ type: "paragraph", content: [{ type: "text", text }] });
const SBAR = {
  schemaVersion: 1,
  doc: {
    type: "doc",
    content: [
      {
        type: "sbar",
        urgencyHint: "routine",
        situation: [para("s")],
        background: [para("b")],
        assessment: [para("a")],
        recommendation: [para("r")],
      },
    ],
  },
};

const inserted: unknown[] = [];
const fakeTx = {
  execute: async () => undefined,
  insert: () => ({
    values: async (row: unknown) => {
      inserted.push(row);
    },
  }),
};
const fakeDb = {
  transaction: async (fn: (tx: typeof fakeTx) => Promise<unknown>) => fn(fakeTx),
} as unknown as DbClient;

let enabled = true;
let routerCalls = 0;
let router: EscalationRouter = escalationRouterDenyStub;
const sends: Record<string, unknown>[] = [];

const covering = (...ids: string[]): EscalationRouter => ({
  resolveTier: async (_org, request): Promise<EscalationRouteAnswer> => ({
    kind: "resolved",
    userIds: ids as [string, ...string[]],
    nextTier: null,
    timeZone: "America/Los_Angeles",
    tier: request.tier,
    asOf: request.asOf,
    source: "m19",
  }),
});

const service = createRoleSendService({
  isEnabled: async () => enabled,
  router: guardEscalationRouter({
    resolveTier: (org, request) => {
      routerCalls += 1;
      return router.resolveTier(org, request);
    },
  }),
  displayName: async () => "Dana K.",
  // Care-team channel of PATIENT; any other channel id is not a patient conversation.
  channelPatient: async (_org, channelId) => (channelId === CHANNEL ? PATIENT : null),
  urgent: {
    send: async (_actor, input) => {
      sends.push(input as unknown as Record<string, unknown>);
      return {
        message_id: "11111111-1111-4111-8111-111111111111",
        channel_id: input.channelId,
        patient_id: PATIENT,
        recipient_user_id: input.recipientUserId,
        created: true,
      };
    },
  },
  log: () => undefined,
});

function headerAuth(request: FastifyRequest): void {
  const user = request.headers["x-test-user"];
  if (typeof user !== "string" || user.length === 0) return;
  request.context.userId = user;
  request.context.organizationId = ORG;
  request.context.roles = user === "supervisor" ? ["medical_director"] : [];
  request.context.locationIds = [];
}

const FULL = [
  "messaging.read",
  "messaging.send",
  "messaging.urgent.send",
  "messaging.oncall.send",
  "patient.read",
];
const grants = (permissionKeys: string[]) => [
  { roleKey: "seed", enabled: true, expiresAt: null, permissionKeys },
];
const without = (key: string) => FULL.filter((k) => k !== key);

function makeServer() {
  registerEffectivePermissionResolver(
    createInMemoryEffectivePermissionStore([
      { orgId: ORG, userId: "nurse", grants: grants(FULL) },
      { orgId: ORG, userId: "scopeless", grants: grants(FULL) },
      { orgId: ORG, userId: "supervisor", grants: grants(FULL) },
      { orgId: ORG, userId: "no-role-key", grants: grants(without("messaging.oncall.send")) },
      { orgId: ORG, userId: "no-urgent", grants: grants(without("messaging.urgent.send")) },
      { orgId: ORG, userId: "no-chart", grants: grants(without("patient.read")) },
      { orgId: ORG, userId: "no-send", grants: grants(without("messaging.send")) },
    ]).store,
  );
  const registry = createPredicateRegistry();
  const predicates = buildCarePlanAbacPredicates({
    resolver: { loadPlan: async () => null } as never,
    isInCaseload: async (q) => q.userId === "nurse" && q.patientId === PATIENT,
  });
  registry.register("caseload_or_scope", predicates.caseload_or_scope as never);
  registerAbacRegistry(registry);
  const app = buildServer({
    db: fakeDb,
    authenticate: headerAuth,
    security: { rateLimitEnabled: false },
  });
  // The channel guards stand in for channel_visibility (covered elsewhere): the known channel is visible, any other is the 404.
  const channelVisible: Handler = async (request) => {
    if ((request.params as { id?: string }).id !== CHANNEL) throw new NotFoundError("channel");
  };
  registerRoleSendRoutes(
    app,
    { service, patientExists: async (_org, id) => PATIENTS_IN_ORG.has(id) },
    {
      read: requirePermission("messaging.read") as Handler,
      send: requirePermission("messaging.send") as Handler,
      viewChannel: channelVisible,
      sendToChannel: channelVisible,
      requireIdempotencyKey: REQUIRE_IDEMPOTENCY_KEY,
      validateLinks: async () => [],
    },
  );
  return app;
}
type App = ReturnType<typeof makeServer>;

const RES = (channel = CHANNEL) => `/api/v1/messaging/channels/${channel}/role-send/resolution`;
const SEND = (channel = CHANNEL) => `/api/v1/messaging/channels/${channel}/role-send`;
const QS = `?role=rn&patient_id=${PATIENT}`;
const get = (app: App, user: string | null, qs = QS, channel = CHANNEL) =>
  app.inject({
    method: "GET",
    url: `${RES(channel)}${qs}`,
    headers: user ? { "x-test-user": user } : {},
  });
const post = (
  app: App,
  user: string | null,
  body: Record<string, unknown> = {},
  opts: { key?: string | null; channel?: string } = {},
) =>
  app.inject({
    method: "POST",
    url: SEND(opts.channel),
    headers: {
      ...(user ? { "x-test-user": user } : {}),
      ...(opts.key === null ? {} : { "idempotency-key": opts.key ?? randomUUID() }),
    },
    payload: {
      role: "rn",
      patient_id: PATIENT,
      recipient_user_id: COVERING,
      body_doc: SBAR,
      client_message_id: "aaaaaaaa-aaaa-4aaa-8aaa-000000000001",
      ...body,
    },
  });

beforeEach(() => {
  enabled = true;
  routerCalls = 0;
  inserted.length = 0;
  sends.length = 0;
  router = covering(COVERING);
});
afterEach(() => {
  resetAuthorizationContract();
  resetRbacEngine();
  resetAbacRegistry();
});

describe("GET /messaging/channels/:id/role-send/resolution", () => {
  it("names who covers the role, with the roster zone, and is never cached", async () => {
    const res = await get(makeServer(), "nurse");
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.json()).toMatchObject({
      role: "rn",
      status: "covered",
      time_zone: "America/Los_Angeles",
      people: [{ user_id: COVERING, display_name: "Dana K.", rank: "primary" }],
    });
  });

  it("answers roster_not_connected (unknown, nobody to confirm) over the real deny-stub", async () => {
    router = escalationRouterDenyStub;
    const res = await get(makeServer(), "nurse");
    expect(res.json()).toMatchObject({ status: "roster_not_connected", people: [] });
  });

  it("is the uniform 404 when the tenant flag is off, with no router call", async () => {
    enabled = false;
    expect((await get(makeServer(), "nurse")).statusCode).toBe(404);
    expect(routerCalls).toBe(0);
  });

  it("needs every key (messaging.read, urgent.send, oncall.send, patient.read) and a signed-in caller", async () => {
    const app = makeServer();
    for (const user of ["no-role-key", "no-urgent", "no-chart"]) {
      expect((await get(app, user)).statusCode).toBe(403);
    }
    expect((await get(app, null)).statusCode).toBe(401);
    expect(routerCalls).toBe(0);
  });

  it("refuses a role outside the closed list, a malformed patient id and an unknown key (422)", async () => {
    const app = makeServer();
    for (const qs of [
      `?role=admin&patient_id=${PATIENT}`,
      "?role=rn&patient_id=nope",
      "?role=rn",
      `${QS}&org_id=x`,
    ]) {
      expect((await get(app, "nurse", qs)).statusCode).toBe(422);
    }
  });

  it("answers the identical 404 with no router call and no audit row for an invisible, nonexistent, or another channel's patient", async () => {
    const app = makeServer();
    const refused = [
      await get(app, "scopeless"), // real patient, no caseload
      await get(app, "nurse", `?role=rn&patient_id=${UNASSIGNED_PATIENT}`),
      await get(app, "supervisor", `?role=rn&patient_id=${GHOST_PATIENT}`), // org-wide scope: only the existence check refuses
      await get(app, "supervisor", `?role=rn&patient_id=${OTHER_CHANNEL_PATIENT}`), // exists, but is not THIS channel's patient
      await get(app, "nurse", QS, "cccccccc-cccc-4ccc-8ccc-0000000000ff"), // not a visible channel
    ];
    for (const res of refused) expect(res.statusCode).toBe(404);
    expect(routerCalls).toBe(0);
    expect(inserted).toEqual([]);
  });

  it("audits the resolution against the patient", async () => {
    expect((await get(makeServer(), "nurse")).statusCode).toBe(200);
    expect(JSON.stringify(inserted)).toContain(PATIENT);
    expect(JSON.stringify(inserted)).toContain("oncall_role_resolution");
  });
});

describe("POST /messaging/channels/:id/role-send", () => {
  it("sends the urgent message to the confirmed person with the role, 201, audited against the patient", async () => {
    const res = await post(makeServer(), "nurse");
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ recipient_user_id: COVERING, role: "rn", created: true });
    expect(sends).toEqual([
      expect.objectContaining({ recipientUserId: COVERING, roleAddressed: "rn" }),
    ]);
    expect(JSON.stringify(inserted)).toContain(PATIENT);
  });

  it("is a 409 and sends nothing when the confirmed person no longer covers (never re-routed)", async () => {
    router = covering(OTHER);
    const res = await post(makeServer(), "nurse");
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("ROLE_SEND_RESOLUTION_CHANGED");
    expect(sends).toEqual([]);
  });

  it("refuses a gap or an unconnected roster with the telephone procedure and sends nothing", async () => {
    router = escalationRouterDenyStub;
    const res = await post(makeServer(), "nurse");
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("ROLE_SEND_NO_COVERAGE");
    expect(res.json().error.message).toContain("telephone procedure");
    expect(sends).toEqual([]);
  });

  it("is the uniform 404 when the tenant flag is off, with no router call", async () => {
    enabled = false;
    expect((await post(makeServer(), "nurse")).statusCode).toBe(404);
    expect(routerCalls).toBe(0);
    expect(sends).toEqual([]);
  });

  it("needs messaging.send, urgent.send, oncall.send and patient.read (403), and a signed-in caller (401)", async () => {
    const app = makeServer();
    for (const user of ["no-send", "no-urgent", "no-role-key", "no-chart"]) {
      expect((await post(app, user)).statusCode).toBe(403);
    }
    expect((await post(app, null)).statusCode).toBe(401);
    expect(sends).toEqual([]);
  });

  it("the idempotency middleware caches a REFUSAL: the same key replays it after coverage returns, a fresh key re-resolves (so the web rotates the key)", async () => {
    const app = makeServer();
    const body = { client_message_id: "aaaaaaaa-aaaa-4aaa-8aaa-0000000000f1" };
    router = escalationRouterDenyStub;
    expect((await post(app, "nurse", body, { key: "k-refused" })).statusCode).toBe(422);
    router = covering(COVERING);
    const replayed = await post(app, "nurse", body, { key: "k-refused" });
    expect(replayed.statusCode).toBe(422);
    expect(replayed.json().error.code).toBe("ROLE_SEND_NO_COVERAGE");
    expect(sends).toEqual([]);
    const fresh = await post(app, "nurse", body, { key: "k-fresh" });
    expect(fresh.statusCode).toBe(201);
    expect(sends).toHaveLength(1);
  });

  it("requires an Idempotency-Key", async () => {
    const res = await post(makeServer(), "nurse", {}, { key: null });
    expect(res.statusCode).toBe(400);
    expect(sends).toEqual([]);
  });

  it("refuses a malformed body (422) before the patient gate and the router", async () => {
    const app = makeServer();
    for (const body of [
      { role: "admin" },
      { patient_id: "nope" },
      { recipient_user_id: "nope" },
      { extra: true },
    ]) {
      expect((await post(app, "nurse", body)).statusCode).toBe(422);
    }
    expect(routerCalls).toBe(0);
  });

  it("answers the identical 404 for an invisible, nonexistent or other-channel patient, before the router", async () => {
    const app = makeServer();
    const refused = [
      await post(app, "scopeless"),
      await post(app, "nurse", { patient_id: UNASSIGNED_PATIENT }),
      await post(app, "supervisor", { patient_id: GHOST_PATIENT }),
      await post(app, "supervisor", { patient_id: OTHER_CHANNEL_PATIENT }),
      await post(app, "nurse", {}, { channel: "cccccccc-cccc-4ccc-8ccc-0000000000ff" }),
    ];
    for (const res of refused) expect(res.statusCode).toBe(404);
    expect(routerCalls).toBe(0);
    expect(sends).toEqual([]);
  });
});
