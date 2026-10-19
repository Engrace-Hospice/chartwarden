// WP 4.2 - the acknowledgment-request routes over the route stack and the REAL Authorization Contract, with a fake service (the
// policy is proven in ack-requests/ack-service.test.ts, the DB half by the live suite).
//
//   guards:  create = messaging.send + messaging.urgent.send + Idempotency-Key + rate limit; acknowledge / resolve = messaging.urgent.receive
//            (an aide - urgent.send only - is refused before the service: receipt only); reassign = messaging.read + rate limit
//   answers: 201 first create, 200 replay; one 404 for a malformed id; closed request schemas
//   audit:   every route declares auditRead
import { readFileSync } from "node:fs";
import {
  createInMemoryEffectivePermissionStore,
  createPredicateRegistry,
  registerAbacRegistry,
  registerEffectivePermissionResolver,
  requireAbac,
  requirePermission,
  resetAbacRegistry,
  resetAuthorizationContract,
  resetRbacEngine,
} from "@wardenx/auth";
import { NotFoundError, RateLimitedError, WardenXError } from "@wardenx/types";
import type { FastifyReply, FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import type { AckService } from "../src/modules/36-messaging/ack-requests/ack-service";
import { CHANNEL_VISIBILITY_PREDICATE } from "../src/modules/36-messaging/index";
import { registerAckRoutes } from "../src/modules/36-messaging/routes/ack-routes";
import { DISABLED_ACK } from "../src/modules/36-messaging/routes/ack-routes";
import { REQUIRE_IDEMPOTENCY_KEY } from "../src/modules/36-messaging/routes/messaging-routes";

type Handler = (r: FastifyRequest, p: FastifyReply) => Promise<void>;

const ORG = "org_a";
const CH = "aaaaaaaa-aaaa-4aaa-8aaa-000000000001";
const MSG = "bbbbbbbb-bbbb-4bbb-8bbb-000000000001";
const REQ = "cccccccc-cccc-4ccc-8ccc-000000000001";
const PAT = "eeeeeeee-eeee-4eee-8eee-000000000001";
const NURSE2 = "dddddddd-dddd-4ddd-8ddd-000000000001";

const KEYS: Record<string, string[]> = {
  nurse: ["messaging.read", "messaging.send", "messaging.urgent.send", "messaging.urgent.receive"],
  aide: ["messaging.read", "messaging.send", "messaging.urgent.send"],
  plainSender: ["messaging.read", "messaging.send"],
  reader: ["messaging.read"],
  supervisor: ["messaging.read", "messaging.review"],
  reviewOnly: ["messaging.review"],
  outsider: [
    "messaging.read",
    "messaging.send",
    "messaging.urgent.send",
    "messaging.urgent.receive",
  ],
  nobody: [],
};

const dto = (status = "pending") => ({
  id: REQ,
  message_id: MSG,
  channel_id: CH,
  patient_id: PAT,
  ack_class: "important",
  status,
  requester_user_id: "nurse",
  assigned_user_id: NURSE2,
  requested_at: "2026-10-15T12:00:00.000Z",
  window_started_at: "2026-10-15T12:00:00.000Z",
  deadline_at: "2026-10-15T13:00:00.000Z",
  current_tier: 0,
  acknowledged_at: null,
  acknowledged_by_user_id: null,
  resolved_at: null,
  cancelled_at: null,
  version: 0,
  viewer_actions: { can_acknowledge: false, can_reassign: true, can_resolve: false },
});

interface Call {
  readonly method: string;
  readonly args: unknown[];
}
let calls: Call[] = [];
let created = true;
let failWith: Error | null = null;

const record =
  (method: string, result: () => unknown) =>
  async (...args: unknown[]) => {
    calls.push({ method, args });
    if (failWith) throw failWith;
    return result();
  };

const service: AckService = {
  create: record("create", () => ({ request: dto(), changed: created, created })) as never,
  createForUrgentSend: record("createForUrgentSend", () => undefined) as never,
  get: record("get", () => ({ request: dto(), events: [] })) as never,
  listForChannel: record("listForChannel", () => ({ requests: [dto()] })) as never,
  acknowledge: record("acknowledge", () => ({
    request: dto("acknowledged"),
    changed: true,
  })) as never,
  reassign: record("reassign", () => ({ request: dto(), changed: true })) as never,
  resolve: record("resolve", () => ({ request: dto("resolved"), changed: true })) as never,
  reassignCandidates: record("reassignCandidates", () => ({
    candidates: [{ user_id: NURSE2, display_name: "Ben Nurse" }],
  })) as never,
  supervisorReassignCandidates: record("supervisorReassignCandidates", () => ({
    candidates: [{ user_id: NURSE2, display_name: "Ben Nurse" }],
  })) as never,
  supervisorReassign: record("supervisorReassign", () => ({
    request_ref: REQ,
    status: "pending",
    assigned_user_id: NURSE2,
    deadline_at: "2026-10-15T13:00:00.000Z",
    changed: true,
  })) as never,
};

function headerAuth(request: FastifyRequest): void {
  const user = request.headers["x-test-user"];
  if (typeof user !== "string" || user.length === 0) return;
  request.context.userId = user;
  request.context.organizationId = ORG;
  request.context.roles = [];
  request.context.locationIds = [];
}

function makeServer(deps: { service: AckService; rateLimit?: Handler } = { service }) {
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
  registry.register(CHANNEL_VISIBILITY_PREDICATE, async (ctx, target) =>
    ctx.userId !== "outsider" ? target.id === CH : false,
  );
  registerAbacRegistry(registry);
  const app = buildServer({ authenticate: headerAuth, security: { rateLimitEnabled: false } });
  registerAckRoutes(app, deps, {
    read: requirePermission("messaging.read") as Handler,
    send: requirePermission("messaging.send") as Handler,
    viewChannel: requireAbac("messaging.read", CHANNEL_VISIBILITY_PREDICATE) as Handler,
    requireIdempotencyKey: REQUIRE_IDEMPOTENCY_KEY,
  });
  return app;
}
type App = ReturnType<typeof makeServer>;

let keySeq = 0;
const post = (
  app: App,
  user: string | null,
  url: string,
  payload: Record<string, unknown> = {},
  idempotencyKey: string | null = `key-${++keySeq}`,
) =>
  app.inject({
    method: "POST",
    url,
    headers: {
      ...(user ? { "x-test-user": user } : {}),
      ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
    },
    payload,
  });
const get = (app: App, user: string | null, url: string) =>
  app.inject({ method: "GET", url, headers: user ? { "x-test-user": user } : {} });
const code = (res: { json(): { error?: { code?: string }; code?: string } }) =>
  res.json().error?.code ?? res.json().code;

const BASE = "/api/v1/messaging/escalations";
const createBody = (over: Record<string, unknown> = {}) => ({
  message_id: MSG,
  assigned_user_id: NURSE2,
  ...over,
});

beforeEach(() => {
  calls = [];
  created = true;
  failWith = null;
  resetAuthorizationContract();
  resetRbacEngine();
  resetAbacRegistry();
});
afterEach(() => {
  resetAuthorizationContract();
  resetRbacEngine();
  resetAbacRegistry();
});

describe("POST /escalations", () => {
  it("answers 201 for a first request and hands the service the server-derived actor and the closed body", async () => {
    const app = makeServer();

    const res = await post(app, "nurse", BASE, createBody());

    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ created: true, request: { status: "pending" } });
    expect(calls[0]?.args[0]).toEqual({ orgId: ORG, userId: "nurse" });
    expect(calls[0]?.args[1]).toEqual({ messageId: MSG, assigneeUserId: NURSE2 });
    await app.close();
  });

  it("answers a replay with 200", async () => {
    created = false;
    const app = makeServer();

    expect((await post(app, "nurse", BASE, createBody())).statusCode).toBe(200);
    await app.close();
  });

  it("lets an aide who holds messaging.urgent.send raise one (05 matrix) and refuses a plain sender before the service", async () => {
    const app = makeServer();

    expect((await post(app, "aide", BASE, createBody())).statusCode).toBe(201);
    calls = [];
    expect((await post(app, "plainSender", BASE, createBody())).statusCode).toBe(403);
    expect(calls).toEqual([]);
    await app.close();
  });

  it("requires an Idempotency-Key header", async () => {
    const app = makeServer();

    const res = await post(app, "nurse", BASE, createBody(), null);

    expect(res.statusCode).toBe(400);
    expect(code(res)).toBe("IDEMPOTENCY_KEY_REQUIRED");
    expect(calls).toEqual([]);
    await app.close();
  });

  it("rejects every attempt to choose the class, status, deadline or role", async () => {
    const app = makeServer();

    for (const bad of [
      createBody({ ack_class: "urgent" }),
      createBody({ status: "acknowledged" }),
      createBody({ deadline_at: "2026-10-15T12:00:00Z" }),
      createBody({ required_role: "rn" }),
      createBody({ urgency: "urgent" }),
      { assigned_user_id: NURSE2 },
      { message_id: MSG },
      createBody({ assigned_user_id: "nope" }),
    ]) {
      expect((await post(app, "nurse", BASE, bad)).statusCode).toBe(422);
    }
    expect(calls).toEqual([]);
    await app.close();
  });

  it("maps the service's typed errors onto the envelope", async () => {
    const app = makeServer();

    for (const [errorCode, status] of [
      ["ACK_ASSIGNEE_INVALID", 422],
      ["ACK_NOT_PATIENT_CHANNEL", 422],
      ["ACK_NOT_REQUESTER", 403],
      ["ACK_ALREADY_REQUESTED", 409],
    ] as const) {
      failWith = new WardenXError(errorCode, "x", status);
      const res = await post(app, "nurse", BASE, createBody());
      expect(res.statusCode).toBe(status);
      expect(code(res)).toBe(errorCode);
    }
    await app.close();
  });

  it("denies a reader and anonymous before the service", async () => {
    const app = makeServer();

    expect((await post(app, "reader", BASE, createBody())).statusCode).toBe(403);
    expect((await post(app, null, BASE, createBody())).statusCode).toBe(401);
    expect(calls).toEqual([]);
    await app.close();
  });

  it("runs the limiter after authorisation and before the service, and a refusal creates nothing", async () => {
    let limited = 0;
    const app = makeServer({
      service,
      rateLimit: async () => {
        limited += 1;
        throw new RateLimitedError();
      },
    });

    expect((await post(app, "nurse", BASE, createBody())).statusCode).toBe(429);
    expect(limited).toBe(1);
    expect(calls).toEqual([]);
    expect((await post(app, "plainSender", BASE, createBody())).statusCode).toBe(403);
    expect(limited).toBe(1);
    await app.close();
  });

  it("is the uniform 404 for the unbound default", async () => {
    const app = makeServer(DISABLED_ACK as never);

    expect((await post(app, "nurse", BASE, createBody())).statusCode).toBe(404);
    await app.close();
  });
});

describe("POST /escalations/:id/acknowledge and /resolve", () => {
  it.each(["acknowledge", "resolve"] as const)(
    "%s reaches the service for a qualified user with the path id only",
    async (action) => {
      const app = makeServer();

      const res = await post(app, "nurse", `${BASE}/${REQ}/${action}`, {}, null);

      expect(res.statusCode).toBe(200);
      expect(calls[0]).toEqual({
        method: action,
        args: [{ orgId: ORG, userId: "nurse" }, REQ],
      });
      await app.close();
    },
  );

  it.each(["acknowledge", "resolve"] as const)(
    "%s is refused for an aide (receipt only) before the service",
    async (action) => {
      const app = makeServer();

      expect((await post(app, "aide", `${BASE}/${REQ}/${action}`, {}, null)).statusCode).toBe(403);
      expect((await post(app, "reader", `${BASE}/${REQ}/${action}`, {}, null)).statusCode).toBe(
        403,
      );
      expect((await post(app, null, `${BASE}/${REQ}/${action}`, {}, null)).statusCode).toBe(401);
      expect(calls).toEqual([]);
      await app.close();
    },
  );

  it.each(["acknowledge", "resolve"] as const)(
    "%s refuses a body that tries to name an actor or a status",
    async (action) => {
      const app = makeServer();

      for (const bad of [{ user_id: "x" }, { status: "acknowledged" }, { acknowledged_by: "x" }]) {
        expect((await post(app, "nurse", `${BASE}/${REQ}/${action}`, bad, null)).statusCode).toBe(
          422,
        );
      }
      expect(calls).toEqual([]);
      await app.close();
    },
  );

  it.each(["acknowledge", "resolve", "reassign"] as const)(
    "%s answers one 404 for a malformed id",
    async (action) => {
      const app = makeServer();

      const res = await post(
        app,
        "nurse",
        `${BASE}/not-a-uuid/${action}`,
        { assigned_user_id: NURSE2 },
        null,
      );

      expect(res.statusCode).toBe(404);
      expect(calls).toEqual([]);
      await app.close();
    },
  );

  it("does not rate limit acknowledge or resolve (they notify nobody)", async () => {
    let limited = 0;
    const app = makeServer({
      service,
      rateLimit: async () => {
        limited += 1;
      },
    });

    await post(app, "nurse", `${BASE}/${REQ}/acknowledge`, {}, null);
    await post(app, "nurse", `${BASE}/${REQ}/resolve`, {}, null);

    expect(limited).toBe(0);
    await app.close();
  });
});

describe("POST /escalations/:id/reassign", () => {
  it("needs only messaging.read (the service decides who is a party), rate limits and passes the closed body", async () => {
    let limited = 0;
    const app = makeServer({
      service,
      rateLimit: async () => {
        limited += 1;
      },
    });

    const res = await post(
      app,
      "aide",
      `${BASE}/${REQ}/reassign`,
      { assigned_user_id: NURSE2 },
      null,
    );

    expect(res.statusCode).toBe(200);
    expect(limited).toBe(1);
    expect(calls[0]?.args).toEqual([{ orgId: ORG, userId: "aide" }, REQ, NURSE2]);
    await app.close();
  });

  it("rejects a missing, malformed or extended body", async () => {
    const app = makeServer();

    for (const bad of [
      {},
      { assigned_user_id: "nope" },
      { assigned_user_id: NURSE2, status: "pending" },
    ]) {
      expect((await post(app, "nurse", `${BASE}/${REQ}/reassign`, bad, null)).statusCode).toBe(422);
    }
    expect(calls).toEqual([]);
    await app.close();
  });

  it("refuses a user without messaging.read", async () => {
    const app = makeServer();

    expect(
      (await post(app, "nobody", `${BASE}/${REQ}/reassign`, { assigned_user_id: NURSE2 }, null))
        .statusCode,
    ).toBe(403);
    await app.close();
  });
});

describe("GET /escalations/:id and /channels/:id/escalations", () => {
  it("returns the request with its history", async () => {
    const app = makeServer();

    const res = await get(app, "nurse", `${BASE}/${REQ}`);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ request: { id: REQ }, events: [] });
    await app.close();
  });

  it("lists the channel's requests behind the channel_visibility predicate", async () => {
    const app = makeServer();

    const ok = await get(app, "nurse", `/api/v1/messaging/channels/${CH}/escalations`);

    expect(ok.statusCode).toBe(200);
    expect(ok.json().requests).toHaveLength(1);
    expect(
      (await get(app, "outsider", `/api/v1/messaging/channels/${CH}/escalations`)).statusCode,
    ).not.toBe(200);
    expect((await get(app, "nurse", "/api/v1/messaging/channels/zzz/escalations")).statusCode).toBe(
      404,
    );
    await app.close();
  });

  it("is 403 without messaging.read, 401 anonymous, and the service's 404 passes through", async () => {
    const app = makeServer();

    expect((await get(app, "nobody", `${BASE}/${REQ}`)).statusCode).toBe(403);
    expect((await get(app, null, `${BASE}/${REQ}`)).statusCode).toBe(401);
    failWith = new NotFoundError("escalation");
    expect((await get(app, "nurse", `${BASE}/${REQ}`)).statusCode).toBe(404);
    expect((await get(app, "nurse", `${BASE}/not-a-uuid`)).statusCode).toBe(404);
    await app.close();
  });
});

describe("ADR-0078 reassign candidates and the supervisor reassign", () => {
  const SUP = `${BASE}/${REQ}/supervisor-reassign`;
  const body = (over: Record<string, unknown> = {}) => ({
    assigned_user_id: NURSE2,
    reason_code: "assignee_unreachable",
    ...over,
  });

  it("serves the party picker to messaging.read with the path id only", async () => {
    const app = makeServer();

    const res = await get(app, "nurse", `${BASE}/${REQ}/reassign-candidates`);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ candidates: [{ user_id: NURSE2, display_name: "Ben Nurse" }] });
    expect(calls[0]).toEqual({
      method: "reassignCandidates",
      args: [{ orgId: ORG, userId: "nurse" }, REQ],
    });
    expect((await get(app, "nobody", `${BASE}/${REQ}/reassign-candidates`)).statusCode).toBe(403);
    expect((await get(app, "nurse", `${BASE}/not-a-uuid/reassign-candidates`)).statusCode).toBe(
      404,
    );
    await app.close();
  });

  it.each([
    ["reader", 403],
    ["nobody", 403],
    ["reviewOnly", 403],
    [null, 401],
  ] as const)(
    "refuses %s (%s) the supervisor reads and writes before the service",
    async (user, status) => {
      const app = makeServer();

      expect((await get(app, user, `${SUP}-candidates`)).statusCode).toBe(status);
      expect((await post(app, user, SUP, body())).statusCode).toBe(status);
      expect(calls).toEqual([]);
      await app.close();
    },
  );

  it("lets a supervisor (messaging.read + messaging.review) reach the service with the closed body", async () => {
    const app = makeServer();

    const res = await post(app, "supervisor", SUP, body());

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      request_ref: REQ,
      status: "pending",
      assigned_user_id: NURSE2,
      deadline_at: "2026-10-15T13:00:00.000Z",
      changed: true,
    });
    expect(calls[0]).toEqual({
      method: "supervisorReassign",
      args: [{ orgId: ORG, userId: "supervisor" }, REQ, NURSE2, "assignee_unreachable"],
    });
    expect((await get(app, "supervisor", `${SUP}-candidates`)).statusCode).toBe(200);
    await app.close();
  });

  it("never leaks a channel, message or patient id even if the service returned one (closed response schema)", async () => {
    const leaky: AckService = {
      ...service,
      supervisorReassign: (async () => ({
        request_ref: REQ,
        status: "pending",
        assigned_user_id: NURSE2,
        deadline_at: "2026-10-15T13:00:00.000Z",
        changed: true,
        channel_id: CH,
        message_id: MSG,
        patient_id: PAT,
      })) as never,
    };
    const app = makeServer({ service: leaky });

    const text = (await post(app, "supervisor", SUP, body())).body;

    for (const forbidden of [CH, MSG, PAT]) expect(text).not.toContain(forbidden);
    await app.close();
  });

  it("requires an Idempotency-Key", async () => {
    const app = makeServer();

    const res = await post(app, "supervisor", SUP, body(), null);

    expect(res.statusCode).toBe(400);
    expect(code(res)).toBe("IDEMPOTENCY_KEY_REQUIRED");
    expect(calls).toEqual([]);
    await app.close();
  });

  it("requires a reason from the fixed set and rejects free text and extra keys", async () => {
    const app = makeServer();

    for (const bad of [
      { assigned_user_id: NURSE2 },
      body({ reason_code: undefined }),
      body({ reason_code: "patient is dying" }),
      body({ reason_code: "" }),
      body({ note: "free text" }),
      body({ status: "acknowledged" }),
      body({ acknowledge: true }),
      { reason_code: "workload" },
      body({ assigned_user_id: "nope" }),
    ]) {
      expect((await post(app, "supervisor", SUP, bad)).statusCode).toBe(422);
    }
    expect(calls).toEqual([]);
    await app.close();
  });

  it("answers one 404 for a malformed id and maps the service's typed errors onto the envelope", async () => {
    const app = makeServer();

    expect(
      (await post(app, "supervisor", `${BASE}/not-a-uuid/supervisor-reassign`, body())).statusCode,
    ).toBe(404);
    for (const [errorCode, status] of [
      ["ACK_ASSIGNEE_INVALID", 422],
      ["ACK_STATE_INVALID", 409],
    ] as const) {
      failWith = new WardenXError(errorCode, "x", status);
      const res = await post(app, "supervisor", SUP, body());
      expect(res.statusCode).toBe(status);
      expect(code(res)).toBe(errorCode);
    }
    await app.close();
  });

  it("runs the limiter after authorisation and before the service", async () => {
    let limited = 0;
    const app = makeServer({
      service,
      rateLimit: async () => {
        limited += 1;
        throw new RateLimitedError();
      },
    });

    expect((await post(app, "supervisor", SUP, body())).statusCode).toBe(429);
    expect(limited).toBe(1);
    expect((await post(app, "reader", SUP, body())).statusCode).toBe(403);
    expect(limited).toBe(1);
    expect(calls).toEqual([]);
    await app.close();
  });

  it("is the uniform 404 for the unbound default", async () => {
    const app = makeServer(DISABLED_ACK as never);

    expect((await post(app, "supervisor", SUP, body())).statusCode).toBe(404);
    await app.close();
  });
});

describe("source pins", () => {
  const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");
  const src = read("../src/modules/36-messaging/routes/ack-routes.ts");

  it("never reads request headers (the shared guard owns Idempotency-Key)", () => {
    expect(src).not.toMatch(/request\.headers|headers\[/);
  });

  it("declares auditRead on all six routes, with a patient path wherever the payload carries the request", () => {
    expect(src.match(/auditRead:/g)).toHaveLength(2 + 4 + 2); // two GETs + the PATIENT_AUDIT users + the two candidate reads (ADR-0078)
    expect(src.match(/config: \{ auditRead: PATIENT_AUDIT \}/g)).toHaveLength(4);
    expect(src).toContain('patientIdPayloadPath: "request.patient_id"');
    expect(src).toContain('resourceIdParam: "id"');
  });

  it("guards the supervisor routes with messaging.review and never with the urgent keys (a supervisor cannot acknowledge)", () => {
    expect(src).toContain('const REVIEW_PERMISSION = "messaging.review"');
    expect(src).toMatch(
      /supervisor-reassign",\s*\{\s*preHandler: \[idParam, guards\.read, review, guards\.requireIdempotencyKey/,
    );
  });

  it("guards create with urgent-send and acknowledge/resolve with urgent-receive", () => {
    expect(src).toContain("requirePermission(URGENT_SEND_PERMISSION)");
    expect(src).toContain("requirePermission(URGENT_RECEIVE_PERMISSION)");
  });

  it("wires the routes in registerMessagingRoutes", () => {
    const wiring = read("../src/modules/36-messaging/routes/messaging-routes.ts").replace(
      /\s+/g,
      " ",
    );
    expect(wiring).toContain("registerAckRoutes(app, deps.ackRequests ?? DISABLED_ACK, {");
  });
});
