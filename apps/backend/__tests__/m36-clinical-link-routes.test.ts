// WP 3.2 - clinical links over the route stack and the REAL Authorization Contract, in-memory fakes for the sources and
// the link store (the DB half is proven by m36-clinical-link.live.test.ts).
//
//   resolve: authorised / wrong permission / out of scope / outsider (cannot view the channel) / anonymous; a missing,
//            forbidden, erased, failing and other-channel link are the IDENTICAL answer; flag off is 404.
//   write:   the send/edit routes validate every clinicalLink node with the caller's own guards and refuse with the same
//            generic 422; the service receives only validated (kind, source, patient).
import {
  createInMemoryEffectivePermissionStore,
  createPredicateRegistry,
  registerAbacRegistry,
  registerEffectivePermissionResolver,
  requirePermission,
  resetAbacRegistry,
  resetAuthorizationContract,
  resetRbacEngine,
} from "@chartwarden/auth";
import { createInMemoryMessagingService } from "@chartwarden/messaging";
import type { ClinicalLinkKind, ClinicalLinkSummary } from "@chartwarden/types";
import type { FastifyReply, FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import type { ClinicalLinkSourcePorts } from "../src/modules/36-messaging/clinical-link/clinical-link-service";
import type { StoredClinicalLink } from "../src/modules/36-messaging/clinical-link/clinical-link-store-db";
import {
  CHANNEL_VISIBILITY_PREDICATE,
  registerMessagingRoutes,
} from "../src/modules/36-messaging/index";
import {
  type ClinicalLinkRouteDeps,
  registerClinicalLinkRoutes,
} from "../src/modules/36-messaging/routes/clinical-link-routes";

const ORG = "org_a";
const CH = "ch_unit";
const PATIENT = "aaaaaaaa-aaaa-4aaa-8aaa-00000000d1d1";
const OTHER_PATIENT = "cccccccc-cccc-4ccc-8ccc-00000000d1d1";
const ORDER = "11111111-1111-4111-8111-000000000001";
const ERASED = "11111111-1111-4111-8111-000000000002";
const BOOM = "11111111-1111-4111-8111-000000000003";
const FOREIGN = "11111111-1111-4111-8111-000000000004"; // belongs to a patient nobody is scoped to
const MEETING = "11111111-1111-4111-8111-000000000005";
const RANDOM = "99999999-9999-4999-8999-999999999999";
const L = (n: number) => `dddddddd-dddd-4ddd-8ddd-00000000000${n}`;
const LINK_OK = L(1);
const LINK_ERASED = L(2);
const LINK_BOOM = L(3);
const LINK_FOREIGN = L(4);
const LINK_OTHER_CHANNEL = L(5);
const LINK_MEETING = L(6);
const LINK_DELETED = L(7);

const KEYS: Record<string, string[]> = {
  clin: [
    "messaging.read",
    "messaging.send",
    "orders.read",
    "prescribing.read",
    "idg.read",
    "documents.read",
  ],
  prescriber: ["messaging.read", "messaging.send", "prescribing.read"], // no orders.read
  scopeless: ["messaging.read", "messaging.send", "orders.read"], // keys but out of scope (see predicate)
  outsider: ["messaging.read", "messaging.send", "orders.read"], // keys, scope, but not in the channel
};

const summaries = new Map<string, ClinicalLinkSummary>([
  [
    ORDER,
    { id: ORDER, patientId: PATIENT, status: "active", occurredAt: "2026-10-01T00:00:00.000Z" },
  ],
  [
    FOREIGN,
    {
      id: FOREIGN,
      patientId: OTHER_PATIENT,
      status: "active",
      occurredAt: "2026-10-01T00:00:00.000Z",
    },
  ],
  [MEETING, { id: MEETING, patientId: null, status: "scheduled", occurredAt: null }],
] as never);
let sourceCalls = 0;
const sources: ClinicalLinkSourcePorts = {
  summary: async (_kind: ClinicalLinkKind, _org: string, id: string) => {
    sourceCalls += 1;
    if (id === BOOM) throw new Error("Jane Doe, morphine 5 mg");
    return summaries.get(id) ?? null; // ERASED and RANDOM are absent
  },
};

const stored = (
  id: string,
  kind: ClinicalLinkKind,
  sourceId: string,
  over = {},
): StoredClinicalLink => ({
  linkId: id,
  kind,
  sourceId,
  messageId: `m_${id}`,
  channelId: CH,
  messageDeleted: false,
  ...over,
});
const links = new Map<string, StoredClinicalLink>([
  [LINK_OK, stored(LINK_OK, "order", ORDER)],
  [LINK_ERASED, stored(LINK_ERASED, "order", ERASED)],
  [LINK_BOOM, stored(LINK_BOOM, "order", BOOM)],
  [LINK_FOREIGN, stored(LINK_FOREIGN, "order", FOREIGN)],
  [LINK_OTHER_CHANNEL, stored(LINK_OTHER_CHANNEL, "order", ORDER, { channelId: "ch_hidden" })],
  [LINK_MEETING, stored(LINK_MEETING, "idg_meeting", MEETING)],
  [LINK_DELETED, stored(LINK_DELETED, "order", ORDER, { messageDeleted: true })],
]);

let flag = true;
const baseDeps = (canView: ClinicalLinkRouteDeps["canViewChannel"]): ClinicalLinkRouteDeps => ({
  isEnabled: async () => flag,
  sources,
  store: { findLink: async (_o, _u, id) => links.get(id) ?? null },
  canViewChannel: canView,
  now: () => new Date("2026-10-14T12:00:00.000Z"),
});

function headerAuth(request: FastifyRequest): void {
  const user = request.headers["x-test-user"];
  if (typeof user !== "string" || user.length === 0) return;
  request.context.userId = user;
  request.context.organizationId = ORG;
  request.context.roles = [];
  request.context.locationIds = [];
}

function registerContract(): void {
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
  registry.register(
    "caseload_or_scope",
    async (ctx, target) => ctx.userId !== "scopeless" && target.patientId === PATIENT,
  );
  registry.register("idg_meeting_scope", async (_ctx, target) => target.id === MEETING);
  registry.register(CHANNEL_VISIBILITY_PREDICATE, async (ctx, target) =>
    ctx.userId !== "outsider" ? target.id === CH : false,
  );
  registerAbacRegistry(registry);
}

const canView = async (_o: string, userId: string, channelId: string) =>
  userId !== "outsider" && channelId === CH;

function resolveServer() {
  registerContract();
  const app = buildServer({ authenticate: headerAuth, security: { rateLimitEnabled: false } });
  registerClinicalLinkRoutes(
    app,
    {
      read: requirePermission("messaging.read") as (
        r: FastifyRequest,
        p: FastifyReply,
      ) => Promise<void>,
    },
    baseDeps(canView),
  );
  return app;
}
const open = (app: ReturnType<typeof resolveServer>, user: string | null, id: string) =>
  app.inject({
    method: "GET",
    url: `/api/v1/messaging/clinical-links/${id}/resolve`,
    headers: user ? { "x-test-user": user } : {},
  });

beforeEach(() => {
  sourceCalls = 0;
  flag = true;
  resetAuthorizationContract();
  resetRbacEngine();
  resetAbacRegistry();
});
afterEach(() => {
  resetAuthorizationContract();
  resetRbacEngine();
  resetAbacRegistry();
});

describe("GET /clinical-links/:linkId/resolve", () => {
  it("returns the live state, deep link and as_of to a caller who holds the permission and scope", async () => {
    const app = resolveServer();
    const res = await open(app, "clin", LINK_OK);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      state: "ok",
      kind: "order",
      status: "active",
      occurred_at: "2026-10-01T00:00:00.000Z",
      as_of: "2026-10-14T12:00:00.000Z",
      link: `/orders/${ORDER}`,
      patient_id: PATIENT,
    });
    await app.close();
  });

  it("opens an idg_meeting link through idg.read + idg_meeting_scope, with no patient", async () => {
    const app = resolveServer();
    const res = await open(app, "clin", LINK_MEETING);
    expect(res.json()).toMatchObject({
      state: "ok",
      link: `/idg/meetings/${MEETING}`,
      patient_id: null,
    });
    expect((await open(app, "prescriber", LINK_MEETING)).json()).toEqual({ state: "unavailable" });
    await app.close();
  });

  it("answers wrong-permission, out-of-scope and outsider callers exactly as it answers a random id", async () => {
    const app = resolveServer();
    const random = await open(app, "clin", RANDOM);
    expect(random.statusCode).toBe(200);
    expect(random.json()).toEqual({ state: "unavailable" });
    for (const user of ["prescriber", "scopeless", "outsider"]) {
      const res = await open(app, user, LINK_OK);
      expect({ user, status: res.statusCode, body: res.json() }).toEqual({
        user,
        status: 200,
        body: { state: "unavailable" },
      });
    }
    await app.close();
  });

  it("never calls the source seam for a caller who cannot view the channel", async () => {
    const app = resolveServer();
    await open(app, "outsider", LINK_OK);
    await open(app, "clin", LINK_OTHER_CHANNEL);
    expect(sourceCalls).toBe(0);
    await app.close();
  });

  it("is the identical unavailable for forbidden-source, erased, failing-seam, deleted-message and missing links", async () => {
    const app = resolveServer();
    const bodies = [];
    for (const id of [LINK_FOREIGN, LINK_ERASED, LINK_BOOM, LINK_DELETED, RANDOM]) {
      const res = await open(app, "clin", id);
      bodies.push({ status: res.statusCode, text: res.body });
    }
    for (const b of bodies) expect(b).toEqual({ status: 200, text: '{"state":"unavailable"}' });
    await app.close();
  });

  it("is 401 anonymous and 404 for a malformed id or when the tenant flag is off", async () => {
    const app = resolveServer();
    expect((await open(app, null, LINK_OK)).statusCode).toBe(401);
    expect((await open(app, "clin", "nope")).statusCode).toBe(404);
    flag = false;
    expect((await open(app, "clin", LINK_OK)).statusCode).toBe(404);
    expect(sourceCalls).toBe(0);
    await app.close();
  });

  it("treats an unreadable flag as off", async () => {
    registerContract();
    const app = buildServer({ authenticate: headerAuth, security: { rateLimitEnabled: false } });
    registerClinicalLinkRoutes(
      app,
      {
        read: requirePermission("messaging.read") as (
          r: FastifyRequest,
          p: FastifyReply,
        ) => Promise<void>,
      },
      { ...baseDeps(canView), isEnabled: async () => Promise.reject(new Error("db down")) },
    );
    expect((await open(app as never, "clin", LINK_OK)).statusCode).toBe(404);
    await app.close();
  });
});

// --- write path: send / edit validate each link with the caller's own guards -------------------------------------------

const para = (...content: unknown[]) => ({ type: "paragraph", content });
const node = (kind: string, entityId: string) => ({ type: "clinicalLink", kind, entityId });
const doc = (...content: unknown[]) => ({ schemaVersion: 1, doc: { type: "doc", content } });

function writeServer() {
  registerContract();
  const real = createInMemoryMessagingService({
    now: () => new Date("2026-06-15T12:00:00Z"),
    seed: {
      eligibleStaff: Object.keys(KEYS).map((userId) => ({
        orgId: ORG,
        userId,
        displayName: userId,
        roles: ["Registered Nurse"],
      })),
      careTeamPatients: [],
      channels: [
        {
          channelId: CH,
          orgId: ORG,
          kind: "location",
          title: "Unit",
          subjectId: null,
          members: Object.keys(KEYS).map((userId) => ({ userId, role: "member" as const })),
        },
      ],
      alerts: [],
    },
  });
  const sent: Array<Record<string, unknown>> = [];
  const edited: Array<Record<string, unknown>> = [];
  const service = {
    ...real,
    sendMessage: async (org: string, input: Record<string, unknown>) => {
      sent.push(input);
      return real.sendMessage(org, input as never);
    },
    editMessage: async (org: string, input: Record<string, unknown>) => {
      edited.push(input);
      return { messageId: String(input.messageId), editedAt: "2026-06-15T12:00:00.000Z" };
    },
  };
  const app = buildServer({ authenticate: headerAuth, security: { rateLimitEnabled: false } });
  const { canViewChannel: _omit, ...deps } = baseDeps(canView);
  registerMessagingRoutes(app, {
    service: service as never,
    announcements: service as never,
    clinicalLinks: deps,
  });
  return { app, sent, edited };
}
const post = (app: ReturnType<typeof writeServer>["app"], user: string, bodyDoc: unknown) =>
  app.inject({
    method: "POST",
    url: `/api/v1/messaging/channels/${CH}/messages`,
    headers: { "x-test-user": user, "idempotency-key": crypto.randomUUID() },
    payload: { bodyDoc } as object,
  });
const patch = (app: ReturnType<typeof writeServer>["app"], user: string, bodyDoc: unknown) =>
  app.inject({
    method: "PATCH",
    url: "/api/v1/messaging/messages/mmm",
    headers: { "x-test-user": user },
    payload: { bodyDoc } as object,
  });

describe("send / edit validate clinical links", () => {
  it("passes only the validated (kind, source, patient) to the service", async () => {
    const { app, sent } = writeServer();
    const res = await post(
      app,
      "clin",
      doc(para(node("order", ORDER), node("idg_meeting", MEETING))),
    );
    expect(res.statusCode).toBe(201);
    expect(sent[0]?.clinicalLinks).toEqual([
      { kind: "order", sourceId: ORDER, patientId: PATIENT },
      { kind: "idg_meeting", sourceId: MEETING, patientId: null },
    ]);
    await app.close();
  });

  it("refuses with the same generic 422 for wrong permission, scope, missing, erased and failing sources", async () => {
    const { app, sent } = writeServer();
    const cases: Array<[string, string, string]> = [
      ["prescriber", "order", ORDER],
      ["scopeless", "order", ORDER],
      ["clin", "order", FOREIGN],
      ["clin", "order", ERASED],
      ["clin", "order", BOOM],
      ["clin", "order", RANDOM],
      ["clin", "visit", ORDER], // visit.read not held
      ["clin", "order", MEETING], // a patient kind with a null-patient summary
    ];
    const answers = [];
    for (const [user, kind, id] of cases) {
      const res = await post(app, user, doc(para(node(kind, id))));
      answers.push({
        status: res.statusCode,
        code: res.json().error?.code ?? res.json().code,
        body: res.body,
      });
    }
    expect(new Set(answers.map((a) => a.status))).toEqual(new Set([422]));
    expect(new Set(answers.map((a) => a.code))).toEqual(new Set(["CLINICAL_LINK_NOT_AVAILABLE"]));
    expect(
      new Set(answers.map((a) => a.body.replace(/"(requestId|correlationId)":"[^"]*"/g, ""))).size,
    ).toBe(1);
    expect(answers[0]?.body).not.toContain("Jane");
    expect(sent).toHaveLength(0);
    await app.close();
  });

  it("refuses a link while the tenant flag is off, but still sends a body with no link", async () => {
    const { app, sent } = writeServer();
    flag = false;
    expect((await post(app, "clin", doc(para(node("order", ORDER))))).statusCode).toBe(422);
    expect(sourceCalls).toBe(0);
    const plain = await post(app, "clin", doc(para({ type: "text", text: "hello" })));
    expect(plain.statusCode).toBe(201);
    expect(sent[0]?.clinicalLinks).toEqual([]);
    await app.close();
  });

  it("caps a message at 10 links", async () => {
    const { app } = writeServer();
    const res = await post(
      app,
      "clin",
      doc(para(...Array.from({ length: 11 }, () => node("order", ORDER)))),
    );
    expect(res.statusCode).toBe(422);
    await app.close();
  });

  it("validates on edit too and hands the service the reconciled list", async () => {
    const { app, edited } = writeServer();
    expect((await patch(app, "prescriber", doc(para(node("order", ORDER))))).statusCode).toBe(422);
    const res = await patch(app, "clin", doc(para(node("order", ORDER))));
    expect(res.statusCode).toBe(200);
    expect(edited[0]?.clinicalLinks).toEqual([
      { kind: "order", sourceId: ORDER, patientId: PATIENT },
    ]);
    await app.close();
  });
});
