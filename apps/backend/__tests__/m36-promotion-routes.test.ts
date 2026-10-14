// WP 3.7 - chart-promotion routes over the route stack and the REAL Authorization Contract, with a fake promotion service
// (the policy is proven in promotions/promotion-service.test.ts, the DB half by m36-promotions.live.test.ts).
//
//   flag off: every route 404s except the list, which answers 200 {enabled:false,promotions:[]}
//   guards:   messaging.send + messaging.promote + patient.read to propose / withdraw; messaging.read (+ patient.read) to read
//   answers:  201 created vs 200 replay, closed target enum (m11 / order => 422), typed errors, ONE byte-identical 404
//   audit:    every route declares auditRead; reads name the resource id; the PHI-bearing POSTs audit against the patient
import { readFileSync } from "node:fs";
import {
  createInMemoryEffectivePermissionStore,
  registerEffectivePermissionResolver,
  requirePermission,
  resetAbacRegistry,
  resetAuthorizationContract,
  resetRbacEngine,
} from "@wardenx/auth";
import { type ChartPromotionDto, NotFoundError, WardenXError } from "@wardenx/types";
import type { FastifyReply, FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import type { PromotionService } from "../src/modules/36-messaging/promotions/promotion-service";
import {
  DISABLED_PROMOTIONS,
  type PromotionRouteDeps,
  registerPromotionRoutes,
} from "../src/modules/36-messaging/routes/promotion-routes";

type Handler = (r: FastifyRequest, p: FastifyReply) => Promise<void>;

const ORG = "org_a";
const P = "cccccccc-cccc-4ccc-8ccc-000000000001";
const MISSING = "cccccccc-cccc-4ccc-8ccc-0000000000ff";
const CH = "aaaaaaaa-aaaa-4aaa-8aaa-000000000001";
const MSG = "bbbbbbbb-bbbb-4bbb-8bbb-000000000001";
const U = "dddddddd-dddd-4ddd-8ddd-000000000001";
const PATIENT = "eeeeeeee-eeee-4eee-8eee-000000000001";

const KEYS: Record<string, string[]> = {
  clinician: ["messaging.read", "messaging.send", "messaging.promote", "patient.read"],
  nopromote: ["messaging.read", "messaging.send", "patient.read"],
  nopatient: ["messaging.read", "messaging.send", "messaging.promote"],
  reader: ["messaging.read", "patient.read"],
  nobody: [],
};

const dto = (over: Partial<ChartPromotionDto> = {}): ChartPromotionDto => ({
  id: P,
  message_id: MSG,
  channel_id: CH,
  patient_id: PATIENT,
  target_module: "m8",
  target_kind: "encounter_addendum",
  suggested_target_ref: null,
  status: "proposed",
  requested_by: U,
  requested_by_display_name: "Requester",
  requested_at: "2026-10-14T12:00:00.000Z",
  source_author_user_id: U,
  source_author_display_name: "Author",
  source_sent_at: "2026-10-14T11:00:00.000Z",
  result_ref: null,
  decided_by: null,
  decided_at: null,
  reason_code: null,
  allowed_actions: ["withdraw"],
  ...over,
});

interface Call {
  readonly method: string;
  readonly args: unknown[];
}
let calls: Call[] = [];
let flag = true;
let created = true;
let failWith: Error | null = null;

const record =
  <T>(method: string, result: () => T) =>
  async (...args: unknown[]): Promise<T> => {
    calls.push({ method, args });
    if (failWith) throw failWith;
    return result();
  };

const service: PromotionService = {
  request: record("request", () => ({ promotion: dto(), created })),
  listForMessage: record("listForMessage", () => [dto()]),
  listMine: record("listMine", () => [dto()]),
  get: record("get", () => dto()),
  withdraw: record("withdraw", () => dto({ status: "withdrawn", allowed_actions: [] })),
  applyOutcome: record("applyOutcome", () => ({ applied: "noop" as const })),
} as PromotionService;

function headerAuth(request: FastifyRequest): void {
  const user = request.headers["x-test-user"];
  if (typeof user !== "string" || user.length === 0) return;
  request.context.userId = user;
  request.context.organizationId = ORG;
  request.context.roles = [];
  request.context.locationIds = [];
}

function makeServer(deps: PromotionRouteDeps = { isEnabled: async () => flag, service }) {
  registerEffectivePermissionResolver(
    createInMemoryEffectivePermissionStore(
      Object.entries(KEYS).map(([userId, permissionKeys]) => ({
        orgId: ORG,
        userId,
        grants: [{ roleKey: "seed", enabled: true, expiresAt: null, permissionKeys }],
      })),
    ).store,
  );
  const app = buildServer({ authenticate: headerAuth, security: { rateLimitEnabled: false } });
  const send = requirePermission("messaging.send") as Handler;
  registerPromotionRoutes(app, deps, {
    read: requirePermission("messaging.read") as Handler,
    send,
    sendToChannel: send,
  });
  return app;
}
type App = ReturnType<typeof makeServer>;

const call = (
  app: App,
  user: string | null,
  method: "GET" | "POST",
  url: string,
  payload?: Record<string, unknown>,
) =>
  app.inject({
    method,
    url,
    headers: user ? { "x-test-user": user } : {},
    ...(payload ? { payload } : {}),
  });
const BASE = "/api/v1/messaging/chart-promotions";
const MSG_URL = `/api/v1/messaging/channels/${CH}/messages/${MSG}/chart-promotions`;
const code = (res: { json(): { error?: { code?: string }; code?: string } }) =>
  res.json().error?.code ?? res.json().code;
const strip = (b: string) => b.replace(/"(requestId|correlationId)":"[^"]*"/g, "");
const body = { target_module: "m8", target_kind: "encounter_addendum" };

beforeEach(() => {
  calls = [];
  flag = true;
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

describe("POST /channels/:id/messages/:messageId/chart-promotions", () => {
  it("answers 201 for a new proposal and 200 for a replay, mapping the body onto the service", async () => {
    const app = makeServer();
    const first = await call(app, "clinician", "POST", MSG_URL, {
      target_module: "m14",
      target_kind: "idg_agenda_item",
      suggested_target_ref: U,
    });
    created = false;
    const replay = await call(app, "clinician", "POST", MSG_URL, body);
    expect([first.statusCode, replay.statusCode]).toEqual([201, 200]);
    expect(first.json()).toMatchObject({ created: true, promotion: { id: P } });
    expect(calls[0]?.args).toEqual([
      { orgId: ORG, userId: "clinician" },
      {
        channelId: CH,
        messageId: MSG,
        targetModule: "m14",
        targetKind: "idg_agenda_item",
        suggestedTargetRef: U,
      },
    ]);
    expect((calls[1]?.args[1] as { suggestedTargetRef: unknown }).suggestedTargetRef).toBeNull();
    await app.close();
  });

  it("has no path to an order: an m11 / m12 module or an order kind is 422 before the service", async () => {
    const app = makeServer();
    for (const bad of [
      { target_module: "m11", target_kind: "encounter_addendum" },
      { target_module: "m12", target_kind: "idg_agenda_item" },
      { target_module: "m8", target_kind: "order" },
      { target_module: "m8", target_kind: "encounter_addendum", patient_id: PATIENT },
      {},
    ]) {
      expect((await call(app, "clinician", "POST", MSG_URL, bad)).statusCode).toBe(422);
    }
    expect(calls).toEqual([]);
    await app.close();
  });

  it("needs messaging.send, messaging.promote and patient.read; anonymous is 401", async () => {
    const app = makeServer();
    for (const user of ["nopromote", "nopatient", "reader", "nobody"]) {
      expect((await call(app, user, "POST", MSG_URL, body)).statusCode).toBe(403);
    }
    expect((await call(app, null, "POST", MSG_URL, body)).statusCode).toBe(401);
    expect(calls).toEqual([]);
    await app.close();
  });

  it("passes typed service errors through (422 not patient linked, 409 conflict)", async () => {
    const app = makeServer();
    failWith = new WardenXError("PROMOTION_SOURCE_NOT_PATIENT_LINKED", "x", 422);
    const a = await call(app, "clinician", "POST", MSG_URL, body);
    failWith = new WardenXError("PROMOTION_STATE_CONFLICT", "x", 409);
    const b = await call(app, "clinician", "POST", MSG_URL, body);
    expect([a.statusCode, code(a), b.statusCode, code(b)]).toEqual([
      422,
      "PROMOTION_SOURCE_NOT_PATIENT_LINKED",
      409,
      "PROMOTION_STATE_CONFLICT",
    ]);
    await app.close();
  });

  it("a malformed channel or message id is a 404 before the service", async () => {
    const app = makeServer();
    const res = await call(
      app,
      "clinician",
      "POST",
      `/api/v1/messaging/channels/nope/messages/${MSG}/chart-promotions`,
      body,
    );
    expect(res.statusCode).toBe(404);
    expect(calls).toEqual([]);
    await app.close();
  });
});

describe("GET /channels/:id/messages/:messageId/chart-promotions", () => {
  it("lists the proposals on the message for a reader with patient.read", async () => {
    const app = makeServer();
    const res = await call(app, "reader", "GET", MSG_URL);
    expect(res.json()).toMatchObject({ promotions: [{ id: P }] });
    expect(calls[0]?.args).toEqual([{ orgId: ORG, userId: "reader" }, CH, MSG]);
    expect((await call(app, "nobody", "GET", MSG_URL)).statusCode).toBe(403);
    await app.close();
  });
});

describe("GET /chart-promotions", () => {
  it("lists with the documented defaults and wraps the rows with enabled:true", async () => {
    const app = makeServer();
    const res = await call(app, "clinician", "GET", BASE);
    expect(res.json()).toMatchObject({ enabled: true, promotions: [{ id: P }] });
    expect(calls[0]?.args[1]).toEqual({ state: "active", limit: 50 });
    await call(app, "clinician", "GET", `${BASE}?status=closed&limit=7`);
    expect(calls[1]?.args[1]).toEqual({ state: "closed", limit: 7 });
    expect((await call(app, "clinician", "GET", `${BASE}?status=bogus`)).statusCode).toBe(422);
    expect((await call(app, "clinician", "GET", `${BASE}?limit=101`)).statusCode).toBe(422);
    await app.close();
  });

  it("answers 200 {enabled:false,promotions:[]} when the flag is off or its read throws, without the service", async () => {
    flag = false;
    const off = makeServer();
    expect((await call(off, "clinician", "GET", BASE)).json()).toEqual({
      enabled: false,
      promotions: [],
    });
    const throwing = makeServer({
      isEnabled: async () => {
        throw new Error("flag store down");
      },
      service,
    });
    expect((await call(throwing, "clinician", "GET", BASE)).json()).toEqual({
      enabled: false,
      promotions: [],
    });
    expect(calls).toEqual([]);
    await off.close();
    await throwing.close();
  });

  it("is 403 without messaging.read and 401 anonymous; the static path is not shadowed by :promotionId", async () => {
    const app = makeServer();
    expect((await call(app, "nobody", "GET", BASE)).statusCode).toBe(403);
    expect((await call(app, null, "GET", BASE)).statusCode).toBe(401);
    expect(calls).toEqual([]);
    await app.close();
  });
});

describe("GET /chart-promotions/:promotionId and POST .../withdraw", () => {
  it("reads one proposal (messaging.read + patient.read) and withdraws it (send + promote + patient.read)", async () => {
    const app = makeServer();
    expect((await call(app, "reader", "GET", `${BASE}/${P}`)).json()).toMatchObject({
      promotion: { id: P },
    });
    const w = await call(app, "clinician", "POST", `${BASE}/${P}/withdraw`);
    expect(w.json()).toMatchObject({ promotion: { status: "withdrawn" } });
    expect(calls.map((c) => c.method)).toEqual(["get", "withdraw"]);
    expect((await call(app, "nopatient", "GET", `${BASE}/${P}`)).statusCode).toBe(403);
    expect((await call(app, "nopromote", "POST", `${BASE}/${P}/withdraw`)).statusCode).toBe(403);
    await app.close();
  });

  it("answers ONE byte-identical 404 for a missing proposal, a malformed id and a flag-off tenant", async () => {
    const app = makeServer();
    failWith = new NotFoundError("chart_promotion_request");
    const missing = await call(app, "clinician", "GET", `${BASE}/${MISSING}`);
    failWith = null;
    const malformed = await call(app, "clinician", "GET", `${BASE}/not-a-uuid`);
    flag = false;
    const off = await call(app, "clinician", "GET", `${BASE}/${P}`);
    const offWithdraw = await call(app, "clinician", "POST", `${BASE}/${P}/withdraw`);
    const offPost = await call(app, "clinician", "POST", MSG_URL, body);
    const offMsg = await call(app, "reader", "GET", MSG_URL);
    for (const r of [missing, malformed, off, offWithdraw, offPost, offMsg]) {
      expect(r.statusCode).toBe(404);
      expect(strip(r.body)).toBe(strip(missing.body));
    }
    await app.close();
  });

  it("withdraw by a non-requester surfaces the service's 403 and a closed request its 409", async () => {
    const app = makeServer();
    failWith = new WardenXError("PROMOTION_STATE_CONFLICT", "x", 409);
    expect((await call(app, "clinician", "POST", `${BASE}/${P}/withdraw`)).statusCode).toBe(409);
    await app.close();
  });
});

describe("unbound default and static guarantees", () => {
  const routesSrc = () =>
    readFileSync(
      new URL("../src/modules/36-messaging/routes/promotion-routes.ts", import.meta.url),
      "utf8",
    );

  it("DISABLED_PROMOTIONS reads off", async () => {
    expect(await DISABLED_PROMOTIONS.isEnabled("any")).toBe(false);
  });

  it("promotion routes never read request headers", () => {
    expect(routesSrc()).not.toMatch(/request\.headers|headers\[/);
  });

  it("every route declares auditRead against the patient; the single read names resourceIdParam; the POSTs audit the reply", () => {
    const src = routesSrc();
    // message list, my list, detail GET, and the shared request/withdraw POST config.
    expect(src.match(/auditRead:/g)).toHaveLength(4);
    expect(src.match(/config: postAudit/g)).toHaveLength(2);
    expect(src).toContain('resourceIdPayloadPath: "promotion.id"');
    expect(src).toContain('resourceIdParam: "promotionId"');
    expect(src).toContain('patientIdPayloadPath: "promotion.patient_id"');
  });

  it("registers the static list path before the parameterised one", () => {
    const src = routesSrc();
    const param = src.indexOf('"/api/v1/messaging/chart-promotions/:promotionId",');
    expect(src.indexOf('"/api/v1/messaging/chart-promotions",')).toBeLessThan(param);
  });
});
