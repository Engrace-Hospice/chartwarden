// WP 4.1 - the urgent routes over the route stack and the REAL Authorization Contract, with a fake service (the policy is
// proven in urgent/urgent-service.test.ts, the DB half by the live suite).
//
//   flag off: POST is the uniform 404 (byte-identical to a hidden channel); options answers 200 {enabled:false}
//   guards:   messaging.send + messaging.urgent.send + channel_visibility + Idempotency-Key for the send; messaging.read + visibility for options
//   answers:  201 first send, 200 replay; an aide persona with the two send keys may raise (05 matrix), a plain sender may not
//   audit:    both routes declare auditRead with a resource id and the patient path
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
import {
  NotFoundError,
  type UrgentMessageOptions,
  type UrgentMessageResponse,
  WardenXError,
} from "@wardenx/types";
import type { FastifyReply, FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import { CHANNEL_VISIBILITY_PREDICATE } from "../src/modules/36-messaging/index";
import { REQUIRE_IDEMPOTENCY_KEY } from "../src/modules/36-messaging/routes/messaging-routes";
import {
  DISABLED_URGENT,
  registerUrgentRoutes,
} from "../src/modules/36-messaging/routes/urgent-routes";
import type { UrgentService } from "../src/modules/36-messaging/urgent/urgent-service";

type Handler = (r: FastifyRequest, p: FastifyReply) => Promise<void>;

const ORG = "org_a";
const CH = "aaaaaaaa-aaaa-4aaa-8aaa-000000000001";
const HIDDEN_CH = "aaaaaaaa-aaaa-4aaa-8aaa-000000000002";
const MSG = "bbbbbbbb-bbbb-4bbb-8bbb-000000000001";
const PAT = "eeeeeeee-eeee-4eee-8eee-000000000001";
const CLIENT_ID = "cccccccc-cccc-4ccc-8ccc-000000000001";
const RECIPIENT = "dddddddd-dddd-4ddd-8ddd-000000000001";

const KEYS: Record<string, string[]> = {
  nurse: ["messaging.read", "messaging.send", "messaging.urgent.send"],
  aide: ["messaging.read", "messaging.send", "messaging.urgent.send"],
  plainSender: ["messaging.read", "messaging.send"], // e.g. org admin or compliance by default
  reader: ["messaging.read"],
  outsider: ["messaging.read", "messaging.send", "messaging.urgent.send"], // keys, but not in the channel
  nobody: [],
};

const sbarDoc = {
  schemaVersion: 1,
  doc: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "x" }] }] },
};
const response = (over: Partial<UrgentMessageResponse> = {}): UrgentMessageResponse => ({
  message_id: MSG,
  channel_id: CH,
  patient_id: PAT,
  recipient_user_id: RECIPIENT,
  created: true,
  ...over,
});

interface Call {
  readonly method: string;
  readonly args: unknown[];
}
let calls: Call[] = [];
let created = true;
let flag = true;
let failWith: Error | null = null;
let linkCalls = 0;

const service: UrgentService = {
  async send(actor, input, validateLinks) {
    calls.push({ method: "send", args: [actor, input] });
    if (!flag) throw new NotFoundError("channel");
    if (failWith) throw failWith;
    await validateLinks({ type: "doc", content: [] } as never);
    return response({ created });
  },
  async options(actor, channelId) {
    calls.push({ method: "options", args: [actor, channelId] });
    if (!flag) return { enabled: false } as UrgentMessageOptions;
    return {
      enabled: true,
      patient_linked: true,
      patient_id: PAT,
      recipients: [{ user_id: RECIPIENT, display_name: "Rita" }],
    };
  },
};

function headerAuth(request: FastifyRequest): void {
  const user = request.headers["x-test-user"];
  if (typeof user !== "string" || user.length === 0) return;
  request.context.userId = user;
  request.context.organizationId = ORG;
  request.context.roles = [];
  request.context.locationIds = [];
}

function makeServer(deps = { service }) {
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
  registerUrgentRoutes(app, deps, {
    read: requirePermission("messaging.read") as Handler,
    send: requirePermission("messaging.send") as Handler,
    viewChannel: requireAbac("messaging.read", CHANNEL_VISIBILITY_PREDICATE) as Handler,
    sendToChannel: requireAbac("messaging.send", CHANNEL_VISIBILITY_PREDICATE) as Handler,
    requireIdempotencyKey: REQUIRE_IDEMPOTENCY_KEY,
    validateLinks: async () => {
      linkCalls += 1;
      return [];
    },
  });
  return app;
}
type App = ReturnType<typeof makeServer>;

const sendUrl = (channel = CH) => `/api/v1/messaging/channels/${channel}/urgent-messages`;
const optionsUrl = (channel = CH) => `${sendUrl(channel)}/options`;
const body = (over: Record<string, unknown> = {}) => ({
  body_doc: sbarDoc,
  recipient_user_id: RECIPIENT,
  client_message_id: CLIENT_ID,
  ...over,
});

let keySeq = 0;
const post = (
  app: App,
  user: string | null,
  url: string,
  payload: Record<string, unknown>,
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
const strip = (b: string) => b.replace(/"(requestId|correlationId)":"[^"]*"/g, "");

beforeEach(() => {
  calls = [];
  created = true;
  flag = true;
  failWith = null;
  linkCalls = 0;
  resetAuthorizationContract();
  resetRbacEngine();
  resetAbacRegistry();
});
afterEach(() => {
  resetAuthorizationContract();
  resetRbacEngine();
  resetAbacRegistry();
});

describe("POST /channels/:id/urgent-messages", () => {
  it("answers 201 for a first send and hands the service the server-derived actor plus the closed body", async () => {
    const app = makeServer();
    const res = await post(app, "nurse", sendUrl(), body());
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      created: true,
      patient_id: PAT,
      recipient_user_id: RECIPIENT,
    });
    expect(calls[0]?.args[0]).toEqual({ orgId: ORG, userId: "nurse" });
    expect(calls[0]?.args[1]).toMatchObject({
      channelId: CH,
      recipientUserId: RECIPIENT,
      clientMessageId: CLIENT_ID,
    });
    await app.close();
  });

  it("lets an aide who holds messaging.urgent.send raise one (05 matrix: aides may raise, never receive)", async () => {
    const app = makeServer();
    expect((await post(app, "aide", sendUrl(), body())).statusCode).toBe(201);
    await app.close();
  });

  it("denies a sender without messaging.urgent.send before the service", async () => {
    const app = makeServer();
    expect((await post(app, "plainSender", sendUrl(), body())).statusCode).toBe(403);
    expect(calls).toEqual([]);
    await app.close();
  });

  it("answers a replay with 200 and runs the request-scoped link validator the service calls", async () => {
    created = false;
    const app = makeServer();
    const res = await post(app, "nurse", sendUrl(), body());
    expect(res.statusCode).toBe(200);
    expect(res.json().created).toBe(false);
    expect(linkCalls).toBe(1);
    await app.close();
  });

  it("requires an Idempotency-Key header", async () => {
    const app = makeServer();
    const res = await post(app, "nurse", sendUrl(), body(), null);
    expect(res.statusCode).toBe(400);
    expect(res.json().error?.code ?? res.json().code).toBe("IDEMPOTENCY_KEY_REQUIRED");
    expect(calls).toEqual([]);
    await app.close();
  });

  it("rejects a closed-schema violation: urgency, role or deadline fields, missing recipient, missing body", async () => {
    const app = makeServer();
    for (const bad of [
      body({ urgency: "urgent" }),
      body({ recipient_role: "rn" }),
      body({ deadline_minutes: 1 }),
      body({ patient_id: PAT }),
      { body_doc: sbarDoc, client_message_id: CLIENT_ID },
      { recipient_user_id: RECIPIENT, client_message_id: CLIENT_ID },
      body({ recipient_user_id: "nope" }),
    ]) {
      expect((await post(app, "nurse", sendUrl(), bad)).statusCode).toBe(422);
    }
    expect(calls).toEqual([]);
    await app.close();
  });

  it("maps the service's typed 422 errors onto the envelope", async () => {
    const app = makeServer();
    for (const code of [
      "URGENT_NOT_PATIENT_CHANNEL",
      "URGENT_SBAR_REQUIRED",
      "URGENT_RECIPIENT_INVALID",
      "CLINICAL_LINK_NOT_AVAILABLE",
    ]) {
      failWith = new WardenXError(code, "x", 422);
      const res = await post(app, "nurse", sendUrl(), body());
      expect(res.statusCode).toBe(422);
      expect(res.json().error?.code ?? res.json().code).toBe(code);
    }
    await app.close();
  });

  it("denies a reader, an outsider and anonymous before the service", async () => {
    const app = makeServer();
    expect((await post(app, "reader", sendUrl(), body())).statusCode).toBe(403);
    expect((await post(app, "outsider", sendUrl(), body())).statusCode).not.toBe(201);
    expect((await post(app, "nurse", sendUrl(HIDDEN_CH), body())).statusCode).not.toBe(201);
    expect((await post(app, null, sendUrl(), body())).statusCode).toBe(401);
    expect(calls).toEqual([]);
    await app.close();
  });

  it("answers flag-off, and a hidden channel with ONE identical 404 body (a malformed id is also a 404)", async () => {
    const app = makeServer();
    flag = false;
    const flagOff = await post(app, "nurse", sendUrl(), body());
    flag = true;
    failWith = new NotFoundError("channel");
    const hidden = await post(app, "nurse", sendUrl(), body());
    failWith = null;
    const malformed = await post(app, "nurse", sendUrl("not-a-uuid"), body());
    expect(flagOff.statusCode).toBe(404);
    expect(strip(hidden.body)).toBe(strip(flagOff.body));
    expect(malformed.statusCode).toBe(404);
    await app.close();
  });

  it("is the uniform 404 for the unbound default", async () => {
    const app = makeServer(DISABLED_URGENT as never);
    expect((await post(app, "nurse", sendUrl(), body())).statusCode).toBe(404);
    await app.close();
  });
});

describe("GET /channels/:id/urgent-messages/options", () => {
  it("returns the recipients the caller may choose", async () => {
    const app = makeServer();
    const res = await get(app, "nurse", optionsUrl());
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      enabled: true,
      patient_linked: true,
      recipients: [{ user_id: RECIPIENT }],
    });
    await app.close();
  });

  it("answers 200 {enabled:false} when the flag is off", async () => {
    flag = false;
    const app = makeServer();
    const res = await get(app, "nurse", optionsUrl());
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ enabled: false });
    await app.close();
  });

  it("is 403 without messaging.read, denies an outsider, 401 anonymous and 404 on a malformed id", async () => {
    const app = makeServer();
    expect((await get(app, "nobody", optionsUrl())).statusCode).toBe(403);
    expect((await get(app, "outsider", optionsUrl())).statusCode).not.toBe(200);
    expect((await get(app, null, optionsUrl())).statusCode).toBe(401);
    expect((await get(app, "nurse", optionsUrl("zzz"))).statusCode).toBe(404);
    await app.close();
  });
});

describe("source pins", () => {
  const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");
  const src = read("../src/modules/36-messaging/routes/urgent-routes.ts");

  it("never reads request headers (the shared guard owns Idempotency-Key)", () => {
    expect(src).not.toMatch(/request\.headers|headers\[/);
  });

  it("declares auditRead on both routes with resource ids and the patient path", () => {
    expect(src.match(/auditRead:/g)).toHaveLength(2);
    expect(src).toContain('resourceIdPayloadPath: "message_id"');
    expect(src).toContain('resourceIdParam: "id"');
    expect(src.match(/patientIdPayloadPath: "patient_id"/g)).toHaveLength(2);
  });

  it("guards the POST with the urgent-send permission", () => {
    expect(src).toContain("requirePermission(URGENT_SEND_PERMISSION)");
  });

  it("wires the real send-route link validator in registerMessagingRoutes", () => {
    const wiring = read("../src/modules/36-messaging/routes/messaging-routes.ts");
    expect(wiring.replace(/\s+/g, " ")).toContain(
      "registerUrgentRoutes(app, deps.urgent ?? DISABLED_URGENT, {",
    );
    expect(wiring.replace(/\s+/g, " ")).toContain(
      "validateLinks: (request, richBody) => validateRichBodyLinks(request, clinicalLinkDeps, richBody)",
    );
  });
});
