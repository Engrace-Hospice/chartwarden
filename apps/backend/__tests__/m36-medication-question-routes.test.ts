// WP 3.10 - medication-question routes over the route stack and the REAL Authorization Contract, with a fake service (the
// policy is proven in medication-questions/medication-question-service.test.ts, the DB half by the live suite).
//
//   flag off: POST is the uniform 404 (byte-identical to a hidden channel); options answers 200 {enabled:false}
//   guards:   messaging.send + channel_visibility + Idempotency-Key for the ask; messaging.read + visibility for options
//   answers:  201 first send, 200 replay; an aide persona {messaging.read, messaging.send} is enough (no order key anywhere)
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
  type MedicationQuestionOptions,
  type MedicationQuestionResponse,
  NotFoundError,
  WardenXError,
} from "@wardenx/types";
import type { FastifyReply, FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import { CHANNEL_VISIBILITY_PREDICATE } from "../src/modules/36-messaging/index";
import type { MedicationQuestionService } from "../src/modules/36-messaging/medication-questions/medication-question-service";
import {
  DISABLED_MEDICATION_QUESTIONS,
  registerMedicationQuestionRoutes,
} from "../src/modules/36-messaging/routes/medication-question-routes";
import { REQUIRE_IDEMPOTENCY_KEY } from "../src/modules/36-messaging/routes/messaging-routes";

type Handler = (r: FastifyRequest, p: FastifyReply) => Promise<void>;

const ORG = "org_a";
const CH = "aaaaaaaa-aaaa-4aaa-8aaa-000000000001";
const HIDDEN_CH = "aaaaaaaa-aaaa-4aaa-8aaa-000000000002";
const MSG = "bbbbbbbb-bbbb-4bbb-8bbb-000000000001";
const PAT = "eeeeeeee-eeee-4eee-8eee-000000000001";
const CLIENT_ID = "cccccccc-cccc-4ccc-8ccc-000000000001";
const NURSE = "dddddddd-dddd-4ddd-8ddd-000000000001";
const MED = "ffffffff-ffff-4fff-8fff-000000000001";

const KEYS: Record<string, string[]> = {
  aide: ["messaging.read", "messaging.send"],
  reader: ["messaging.read"],
  outsider: ["messaging.read", "messaging.send"], // keys, but not in the channel
  nobody: [],
};

const response = (over: Partial<MedicationQuestionResponse> = {}): MedicationQuestionResponse => ({
  message_id: MSG,
  channel_id: CH,
  patient_id: PAT,
  routed: true,
  task: null,
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

const service: MedicationQuestionService = {
  async ask(actor, a, validateLinks) {
    calls.push({ method: "ask", args: [actor, a] });
    if (!flag) throw new NotFoundError("channel");
    if (failWith) throw failWith;
    await validateLinks({ type: "doc", content: [] } as never);
    return response({ created });
  },
  async options(actor, channelId) {
    calls.push({ method: "options", args: [actor, channelId] });
    if (!flag) return { enabled: false } as MedicationQuestionOptions;
    return {
      enabled: true,
      patient_linked: true,
      patient_id: PAT,
      nurse: { user_id: NURSE, display_name: "Nina" },
      colleagues: [],
      links_enabled: true,
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
  registerMedicationQuestionRoutes(app, deps, {
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

const askUrl = (channel = CH) => `/api/v1/messaging/channels/${channel}/medication-questions`;
const optionsUrl = (channel = CH) => `${askUrl(channel)}/options`;
const body = (over: Record<string, unknown> = {}) => ({
  text: "increase morphine to 10 mg q2h?",
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

describe("POST /channels/:id/medication-questions", () => {
  it("answers 201 for a first send and hands the service the server-derived actor plus the closed body", async () => {
    const app = makeServer();
    const res = await post(
      app,
      "aide",
      askUrl(),
      body({ medication_id: MED, assignee_user_id: NURSE }),
    );
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ routed: true, created: true, patient_id: PAT });
    expect(calls[0]?.args[0]).toEqual({ orgId: ORG, userId: "aide" });
    expect(calls[0]?.args[1]).toMatchObject({
      channelId: CH,
      text: "increase morphine to 10 mg q2h?",
      medicationId: MED,
      assigneeUserId: NURSE,
      allowUnrouted: false,
      clientMessageId: CLIENT_ID,
    });
    await app.close();
  });

  it("lets an aide persona with only messaging.read and messaging.send ask (no patient.read, no order key)", async () => {
    const app = makeServer();
    expect((await post(app, "aide", askUrl(), body())).statusCode).toBe(201);
    await app.close();
  });

  it("answers a replay with 200 and runs the request-scoped link validator the service calls", async () => {
    created = false;
    const app = makeServer();
    const res = await post(app, "aide", askUrl(), body());
    expect(res.statusCode).toBe(200);
    expect(res.json().created).toBe(false);
    expect(linkCalls).toBe(1);
    await app.close();
  });

  it("requires an Idempotency-Key header", async () => {
    const app = makeServer();
    const res = await post(app, "aide", askUrl(), body(), null);
    expect(res.statusCode).toBe(400);
    expect(res.json().error?.code ?? res.json().code).toBe("IDEMPOTENCY_KEY_REQUIRED");
    expect(calls).toEqual([]);
    await app.close();
  });

  it("rejects a closed-schema violation: extra order-shaped field, missing client_message_id, blank text", async () => {
    const app = makeServer();
    for (const bad of [
      body({ order: { drug: "morphine" } }),
      body({ patient_id: PAT }),
      { text: "q" },
      body({ text: "" }),
      body({ medication_id: "nope" }),
    ]) {
      expect((await post(app, "aide", askUrl(), bad)).statusCode).toBe(422);
    }
    expect(calls).toEqual([]);
    await app.close();
  });

  it("maps the service's typed 422 errors onto the envelope", async () => {
    const app = makeServer();
    for (const code of [
      "MEDICATION_QUESTION_NOT_PATIENT_CHANNEL",
      "MEDICATION_QUESTION_ASSIGNEE_INVALID",
      "MEDICATION_QUESTION_NO_NURSE",
      "CLINICAL_LINK_NOT_AVAILABLE",
    ]) {
      failWith = new WardenXError(code, "x", 422);
      const res = await post(app, "aide", askUrl(), body());
      expect(res.statusCode).toBe(422);
      expect(res.json().error?.code ?? res.json().code).toBe(code);
    }
    await app.close();
  });

  it("denies a reader, an outsider and anonymous before the service", async () => {
    const app = makeServer();
    expect((await post(app, "reader", askUrl(), body())).statusCode).toBe(403);
    expect((await post(app, "outsider", askUrl(), body())).statusCode).not.toBe(201);
    expect((await post(app, "aide", askUrl(HIDDEN_CH), body())).statusCode).not.toBe(201);
    expect((await post(app, null, askUrl(), body())).statusCode).toBe(401);
    expect(calls).toEqual([]);
    await app.close();
  });

  it("answers flag-off, and a hidden channel with ONE identical 404 body (a malformed id is also a 404)", async () => {
    const app = makeServer();
    flag = false;
    const flagOff = await post(app, "aide", askUrl(), body());
    flag = true;
    failWith = new NotFoundError("channel");
    const hidden = await post(app, "aide", askUrl(), body());
    failWith = null;
    const malformed = await post(app, "aide", askUrl("not-a-uuid"), body());
    expect(flagOff.statusCode).toBe(404);
    expect(strip(hidden.body)).toBe(strip(flagOff.body));
    expect(malformed.statusCode).toBe(404);
    await app.close();
  });

  it("is the uniform 404 for the unbound default", async () => {
    const app = makeServer(DISABLED_MEDICATION_QUESTIONS as never);
    expect((await post(app, "aide", askUrl(), body())).statusCode).toBe(404);
    await app.close();
  });
});

describe("GET /channels/:id/medication-questions/options", () => {
  it("returns the nurse and chooser facts", async () => {
    const app = makeServer();
    const res = await get(app, "aide", optionsUrl());
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      enabled: true,
      patient_linked: true,
      nurse: { user_id: NURSE },
    });
    await app.close();
  });

  it("answers 200 {enabled:false} when the flag is off", async () => {
    flag = false;
    const app = makeServer();
    const res = await get(app, "aide", optionsUrl());
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ enabled: false });
    await app.close();
  });

  it("is 403 without messaging.read, denies an outsider, 401 anonymous and 404 on a malformed id", async () => {
    const app = makeServer();
    expect((await get(app, "nobody", optionsUrl())).statusCode).toBe(403);
    expect((await get(app, "outsider", optionsUrl())).statusCode).not.toBe(200);
    expect((await get(app, null, optionsUrl())).statusCode).toBe(401);
    expect((await get(app, "aide", optionsUrl("zzz"))).statusCode).toBe(404);
    await app.close();
  });
});

describe("source pins", () => {
  const src = readFileSync(
    new URL("../src/modules/36-messaging/routes/medication-question-routes.ts", import.meta.url),
    "utf8",
  );

  it("never reads request headers (the shared guard owns Idempotency-Key)", () => {
    expect(src).not.toMatch(/request\.headers|headers\[/);
  });

  it("declares auditRead on both routes with resource ids and the patient path", () => {
    expect(src.match(/auditRead:/g)).toHaveLength(2);
    expect(src).toContain('resourceIdPayloadPath: "message_id"');
    expect(src).toContain('resourceIdParam: "id"');
    expect(src.match(/patientIdPayloadPath: "patient_id"/g)).toHaveLength(2);
  });

  it("routes the link authorisation through the injected validateLinks and names no order key", () => {
    expect(src).toContain("guards.validateLinks(request, richBody)");
    expect(src).not.toMatch(/orders\.|prescribing\./);
  });

  it("wires the real send-route link validator in registerMessagingRoutes", () => {
    const wiring = readFileSync(
      new URL("../src/modules/36-messaging/routes/messaging-routes.ts", import.meta.url),
      "utf8",
    );
    expect(wiring.replace(/\s+/g, " ")).toContain(
      "validateLinks: (request, richBody) => validateRichBodyLinks(request, clinicalLinkDeps, richBody)",
    );
  });
});
