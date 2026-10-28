// WP 3.5 - clinical-handoff routes over the route stack and the REAL Authorization Contract, with a fake handoff service
// (the policy is proven in handoffs/handoff-service.test.ts, the DB half by m36-handoffs.live.test.ts).
//
//   flag off: every route 404s except the list, which answers 200 {enabled:false,handoffs:[]}
//   guards:   messaging.read for reads, messaging.send (+ patient.read for caseload/prefill/offer), template.manage for policy
//   answers:  201 created vs 200 replay, typed 422/409, ONE byte-identical 404, static paths not shadowed by :handoffId
//   audit:    reads declare auditRead; the single read names resourceIdParam and attributes EVERY patient
import { readFileSync } from "node:fs";
import {
  createInMemoryEffectivePermissionStore,
  registerEffectivePermissionResolver,
  requirePermission,
  resetAbacRegistry,
  resetAuthorizationContract,
  resetRbacEngine,
} from "@chartwarden/auth";
import {
  ChartWardenError,
  ForbiddenError,
  type HandoffDto,
  type HandoffPolicyView,
  NotFoundError,
} from "@chartwarden/types";
import type { FastifyReply, FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import type { HandoffService } from "../src/modules/36-messaging/handoffs/handoff-service";
import {
  DISABLED_HANDOFFS,
  type HandoffRouteDeps,
  registerHandoffRoutes,
} from "../src/modules/36-messaging/routes/handoff-routes";

type Handler = (r: FastifyRequest, p: FastifyReply) => Promise<void>;

const ORG = "org_a";
const H = "cccccccc-cccc-4ccc-8ccc-000000000001";
const MISSING = "cccccccc-cccc-4ccc-8ccc-0000000000ff";
const RECIPIENT = "dddddddd-dddd-4ddd-8ddd-000000000001";
const PATIENT = "eeeeeeee-eeee-4eee-8eee-000000000001";
const ITEM = "ffffffff-ffff-4fff-8fff-000000000001";

const KEYS: Record<string, string[]> = {
  nurse: ["messaging.read", "messaging.send", "patient.read"],
  nopatient: ["messaging.read", "messaging.send"],
  reader: ["messaging.read", "patient.read"],
  admin: ["messaging.read", "messaging.send", "messaging.template.manage"],
  nobody: [],
};

const dto = (over: Partial<HandoffDto> = {}): HandoffDto => ({
  id: H,
  from_user_id: RECIPIENT,
  from_display_name: "Sender",
  to_user_id: RECIPIENT,
  to_display_name: "Receiver",
  state: "offered",
  offered_at: "2026-10-14T12:00:00.000Z",
  expires_at: "2026-10-14T16:00:00.000Z",
  accepted_at: null,
  closed_at: null,
  closed_reason: null,
  needs_attention: false,
  patient_count: 1,
  item_counts: { pending: 1, accepted: 0, declined: 0, expired: 0, cancelled: 0 },
  allowed_actions: ["accept", "decline"],
  ...over,
});

const policyView: HandoffPolicyView = {
  expiry_minutes: 240,
  platform_max_minutes: 240,
  customised: false,
};

interface Call {
  readonly method: string;
  readonly args: unknown[];
}
let calls: Call[] = [];
let flag = true;
let offerCreated = true;
let failWith: Error | null = null;

const record =
  <T>(method: string, result: () => T) =>
  async (...args: unknown[]): Promise<T> => {
    calls.push({ method, args });
    if (failWith) throw failWith;
    return result();
  };

const service: HandoffService = {
  caseload: record("caseload", () => [
    { patient_id: PATIENT, display_name: "Ann B.", mrn_suffix: "1234" },
  ]),
  prefill: record("prefill", () => ({
    patients: [{ patient_id: PATIENT, items: [], unavailable_sources: [] }],
  })),
  offer: record("offer", () => ({ handoff: dto(), created: offerCreated })),
  get: record("get", () => dto()),
  list: record("list", () => [dto()]),
  accept: record("accept", () => dto({ state: "accepted" })),
  decline: record("decline", () => dto({ state: "declined" })),
  cancel: record("cancel", () => dto({ state: "cancelled" })),
  policy: record("policy", () => policyView),
  setPolicy: record("setPolicy", () => ({ ...policyView, expiry_minutes: 60, customised: true })),
  clearPolicy: record("clearPolicy", () => policyView),
} as HandoffService;

function headerAuth(request: FastifyRequest): void {
  const user = request.headers["x-test-user"];
  if (typeof user !== "string" || user.length === 0) return;
  request.context.userId = user;
  request.context.organizationId = ORG;
  request.context.roles = [];
  request.context.locationIds = [];
}

function makeServer(deps: HandoffRouteDeps = { isEnabled: async () => flag, service }) {
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
  registerHandoffRoutes(app, deps, {
    read: requirePermission("messaging.read") as Handler,
    send: requirePermission("messaging.send") as Handler,
  });
  return app;
}
type App = ReturnType<typeof makeServer>;

const send = (
  app: App,
  user: string | null,
  method: "GET" | "POST" | "PUT" | "DELETE",
  url: string,
  payload?: Record<string, unknown>,
) =>
  app.inject({
    method,
    url,
    headers: user ? { "x-test-user": user } : {},
    ...(payload ? { payload } : {}),
  });
const BASE = "/api/v1/messaging/handoffs";
const code = (res: { json(): { error?: { code?: string }; code?: string } }) =>
  res.json().error?.code ?? res.json().code;
const strip = (b: string) => b.replace(/"(requestId|correlationId)":"[^"]*"/g, "");
const offerBody = {
  to_user_id: RECIPIENT,
  items: [{ kind: "patient", ref_id: PATIENT, patient_id: PATIENT }],
};

beforeEach(() => {
  calls = [];
  flag = true;
  offerCreated = true;
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

describe("GET /handoffs", () => {
  it("lists with the documented defaults and wraps the rows with enabled:true", async () => {
    const app = makeServer();
    const res = await send(app, "nurse", "GET", BASE);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ enabled: true, handoffs: [{ id: H }] });
    expect(calls[0]?.args[1]).toEqual({ scope: "incoming", state: "active", limit: 50 });
    await app.close();
  });

  it("passes scope, state and limit through and rejects bad values", async () => {
    const app = makeServer();
    await send(app, "nurse", "GET", `${BASE}?scope=outgoing&state=closed&limit=7`);
    expect(calls[0]?.args[1]).toEqual({ scope: "outgoing", state: "closed", limit: 7 });
    expect((await send(app, "nurse", "GET", `${BASE}?scope=all`)).statusCode).toBe(422);
    expect((await send(app, "nurse", "GET", `${BASE}?limit=101`)).statusCode).toBe(422);
    await app.close();
  });

  it("answers 200 {enabled:false,handoffs:[]} when the flag is off or its read throws, without the service", async () => {
    flag = false;
    const off = makeServer();
    const res = await send(off, "nurse", "GET", BASE);
    expect(res.json()).toEqual({ enabled: false, handoffs: [] });
    const throwing = makeServer({
      isEnabled: async () => {
        throw new Error("flag store down");
      },
      service,
    });
    expect((await send(throwing, "nurse", "GET", BASE)).json()).toEqual({
      enabled: false,
      handoffs: [],
    });
    expect(calls).toEqual([]);
    await off.close();
    await throwing.close();
  });

  it("is 403 without messaging.read and 401 anonymous", async () => {
    const app = makeServer();
    expect((await send(app, "nobody", "GET", BASE)).statusCode).toBe(403);
    expect((await send(app, null, "GET", BASE)).statusCode).toBe(401);
    await app.close();
  });
});

describe("static paths are not shadowed by :handoffId", () => {
  it("caseload, policy and prefill reach their own handlers", async () => {
    const app = makeServer();
    expect((await send(app, "nurse", "GET", `${BASE}/caseload`)).json()).toMatchObject({
      patients: [{ patient_id: PATIENT }],
    });
    expect((await send(app, "nurse", "GET", `${BASE}/policy`)).json()).toEqual(policyView);
    const prefill = await send(app, "nurse", "POST", `${BASE}/prefill`, { patient_ids: [PATIENT] });
    expect(prefill.statusCode).toBe(200);
    expect(calls.map((c) => c.method)).toEqual(["caseload", "policy", "prefill"]);
    expect(calls[2]?.args).toEqual([{ orgId: ORG, userId: "nurse" }, [PATIENT]]);
    await app.close();
  });

  it("prefill is 422 for zero or more than 50 patients and for a non-uuid", async () => {
    const app = makeServer();
    const many = Array.from({ length: 51 }, () => PATIENT);
    for (const patient_ids of [[], many, ["nope"]]) {
      expect(
        (await send(app, "nurse", "POST", `${BASE}/prefill`, { patient_ids })).statusCode,
      ).toBe(422);
    }
    expect(calls).toEqual([]);
    await app.close();
  });

  it("caseload, prefill and offer also need patient.read; policy needs only messaging.send", async () => {
    const app = makeServer();
    expect((await send(app, "nopatient", "GET", `${BASE}/caseload`)).statusCode).toBe(403);
    expect(
      (await send(app, "nopatient", "POST", `${BASE}/prefill`, { patient_ids: [PATIENT] }))
        .statusCode,
    ).toBe(403);
    expect((await send(app, "nopatient", "POST", BASE, offerBody)).statusCode).toBe(403);
    expect((await send(app, "nopatient", "GET", `${BASE}/policy`)).statusCode).toBe(200);
    expect((await send(app, "reader", "GET", `${BASE}/policy`)).statusCode).toBe(403);
    await app.close();
  });

  it("the detail read and accept/decline/cancel re-check patient.read (403 without it, service never reached)", async () => {
    const app = makeServer();
    expect((await send(app, "nopatient", "GET", `${BASE}/${H}`)).statusCode).toBe(403);
    for (const action of ["accept", "decline", "cancel"])
      expect(
        (await send(app, "nopatient", "POST", `${BASE}/${H}/${action}`, { item_ids: [ITEM] }))
          .statusCode,
      ).toBe(403);
    expect(calls).toEqual([]);
    await app.close();
  });
});

describe("POST /handoffs", () => {
  it("answers 201 created:true and passes the actor from the context plus the body", async () => {
    const app = makeServer();
    const res = await send(app, "nurse", "POST", BASE, offerBody);
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ created: true, handoff: { id: H } });
    expect(calls[0]?.args).toEqual([
      { orgId: ORG, userId: "nurse" },
      { toUserId: RECIPIENT, items: offerBody.items },
    ]);
    await app.close();
  });

  it("answers an idempotent replay with 200 and created:false, needing no Idempotency-Key", async () => {
    offerCreated = false;
    const app = makeServer();
    const res = await send(app, "nurse", "POST", BASE, offerBody);
    expect(res.statusCode).toBe(200);
    expect(res.json().created).toBe(false);
    await app.close();
  });

  it("rejects a closed-schema violation (free text, unknown kind) before the service", async () => {
    const app = makeServer();
    for (const body of [
      { ...offerBody, note: "free text" },
      { to_user_id: RECIPIENT, items: [{ kind: "memo", ref_id: PATIENT, patient_id: PATIENT }] },
      { to_user_id: "nope", items: [] },
    ]) {
      expect((await send(app, "nurse", "POST", BASE, body)).statusCode).toBe(422);
    }
    expect(calls).toEqual([]);
    await app.close();
  });

  it("maps every service code onto the envelope without echoing data", async () => {
    const app = makeServer();
    for (const [status, errCode] of [
      [422, "HANDOFF_RECIPIENT_INVALID"],
      [422, "HANDOFF_ITEM_INVALID"],
      [422, "HANDOFF_ITEMS_REQUIRED"],
      [422, "HANDOFF_TOO_MANY_ITEMS"],
      [409, "HANDOFF_ITEM_CONFLICT"],
    ] as const) {
      failWith = new ChartWardenError(errCode, "x", status);
      const res = await send(app, "nurse", "POST", BASE, offerBody);
      expect({ s: res.statusCode, c: code(res) }).toEqual({ s: status, c: errCode });
      expect(res.json().handoff).toBeUndefined();
    }
    await app.close();
  });

  it("is 404 with the flag off, 403 for a reader, 401 anonymous", async () => {
    const app = makeServer();
    expect((await send(app, "reader", "POST", BASE, offerBody)).statusCode).toBe(403);
    expect((await send(app, null, "POST", BASE, offerBody)).statusCode).toBe(401);
    flag = false;
    expect((await send(app, "nurse", "POST", BASE, offerBody)).statusCode).toBe(404);
    expect(calls).toEqual([]);
    await app.close();
  });
});

describe("GET /handoffs/:handoffId", () => {
  it("returns { handoff }", async () => {
    const app = makeServer();
    const res = await send(app, "nurse", "GET", `${BASE}/${H}`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ handoff: { id: H } });
    expect(calls[0]?.args).toEqual([{ orgId: ORG, userId: "nurse" }, H]);
    await app.close();
  });

  it("answers missing, non-participant, malformed and flag-off with ONE identical 404", async () => {
    const app = makeServer();
    failWith = new NotFoundError("clinical_handoff");
    const viaService = await send(app, "nurse", "GET", `${BASE}/${MISSING}`);
    failWith = null;
    const malformed = await send(app, "nurse", "GET", `${BASE}/not-a-uuid`);
    flag = false;
    const flagOff = await send(app, "nurse", "GET", `${BASE}/${H}`);
    expect(viaService.statusCode).toBe(404);
    expect(strip(malformed.body)).toBe(strip(viaService.body));
    expect(strip(flagOff.body)).toBe(strip(viaService.body));
    await app.close();
  });
});

describe("POST /handoffs/:handoffId/{accept,decline,cancel}", () => {
  it("accept passes exactly the chosen item ids and wraps the handoff", async () => {
    const app = makeServer();
    const res = await send(app, "nurse", "POST", `${BASE}/${H}/accept`, { item_ids: [ITEM] });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ handoff: { state: "accepted" } });
    expect(calls[0]?.args).toEqual([{ orgId: ORG, userId: "nurse" }, H, [ITEM]]);
    await app.close();
  });

  it("accept needs 1..250 ids; decline accepts none (all pending) or a subset; cancel takes no body", async () => {
    const app = makeServer();
    const tooMany = Array.from({ length: 251 }, () => ITEM);
    expect(
      (await send(app, "nurse", "POST", `${BASE}/${H}/accept`, { item_ids: [] })).statusCode,
    ).toBe(422);
    expect(
      (await send(app, "nurse", "POST", `${BASE}/${H}/accept`, { item_ids: tooMany })).statusCode,
    ).toBe(422);
    expect(calls).toEqual([]);
    await send(app, "nurse", "POST", `${BASE}/${H}/decline`);
    await send(app, "nurse", "POST", `${BASE}/${H}/decline`, { item_ids: [ITEM] });
    await send(app, "nurse", "POST", `${BASE}/${H}/cancel`);
    expect(calls.map((c) => [c.method, c.args[2]])).toEqual([
      ["decline", undefined],
      ["decline", [ITEM]],
      ["cancel", undefined],
    ]);
    await app.close();
  });

  it("surfaces the service's 403, 409 and 422 codes", async () => {
    const app = makeServer();
    failWith = new ForbiddenError("not permitted");
    expect((await send(app, "nurse", "POST", `${BASE}/${H}/cancel`)).statusCode).toBe(403);
    for (const [status, errCode, action] of [
      [409, "HANDOFF_STATE_CONFLICT", "accept"],
      [422, "HANDOFF_ITEM_NOT_TRANSFERABLE", "accept"],
      [422, "HANDOFF_ITEM_INVALID", "decline"],
    ] as const) {
      failWith = new ChartWardenError(errCode, "x", status);
      const res = await send(app, "nurse", "POST", `${BASE}/${H}/${action}`, { item_ids: [ITEM] });
      expect({ s: res.statusCode, c: code(res) }).toEqual({ s: status, c: errCode });
    }
    await app.close();
  });

  it("needs messaging.send (reader 403), a malformed id is the uniform 404, and the flag off is 404", async () => {
    const app = makeServer();
    expect((await send(app, "reader", "POST", `${BASE}/${H}/cancel`)).statusCode).toBe(403);
    expect((await send(app, "nurse", "POST", `${BASE}/zzz/cancel`)).statusCode).toBe(404);
    expect(calls).toEqual([]);
    flag = false;
    for (const action of ["accept", "decline", "cancel"]) {
      const res = await send(app, "nurse", "POST", `${BASE}/${H}/${action}`, { item_ids: [ITEM] });
      expect({ action, s: res.statusCode }).toEqual({ action, s: 404 });
    }
    expect(calls).toEqual([]);
    await app.close();
  });
});

describe("/template-admin/handoff-policy", () => {
  const URL = "/api/v1/messaging/template-admin/handoff-policy";

  it("PUT and DELETE need messaging.template.manage and answer the effective view", async () => {
    const app = makeServer();
    expect((await send(app, "nurse", "PUT", URL, { expiry_minutes: 60 })).statusCode).toBe(403);
    expect((await send(app, "nurse", "DELETE", URL)).statusCode).toBe(403);
    const put = await send(app, "admin", "PUT", URL, { expiry_minutes: 60 });
    expect(put.json()).toMatchObject({ expiry_minutes: 60, customised: true });
    expect((await send(app, "admin", "DELETE", URL)).json()).toEqual(policyView);
    expect(calls.map((c) => c.method)).toEqual(["setPolicy", "clearPolicy"]);
    await app.close();
  });

  it("surfaces HANDOFF_POLICY_INVALID and rejects an unknown body key", async () => {
    const app = makeServer();
    failWith = new ChartWardenError("HANDOFF_POLICY_INVALID", "x", 422);
    const res = await send(app, "admin", "PUT", URL, { expiry_minutes: 9999 });
    expect({ s: res.statusCode, c: code(res) }).toEqual({ s: 422, c: "HANDOFF_POLICY_INVALID" });
    failWith = null;
    expect((await send(app, "admin", "PUT", URL, { expiry_minutes: 60, x: 1 })).statusCode).toBe(
      422,
    );
    await app.close();
  });
});

describe("unbound default and static guarantees", () => {
  const routesSrc = () =>
    readFileSync(
      new URL("../src/modules/36-messaging/routes/handoff-routes.ts", import.meta.url),
      "utf8",
    );

  it("DISABLED_HANDOFFS reads off", async () => {
    expect(await DISABLED_HANDOFFS.isEnabled("any")).toBe(false);
  });

  it("handoff routes never read request headers", () => {
    expect(routesSrc()).not.toMatch(/request\.headers|headers\[/);
  });

  it("every read route declares auditRead; the single read names resourceIdParam and attributes every patient; the PHI-bearing POSTs audit too", () => {
    const src = routesSrc();
    // list, caseload, policy waiver, detail GET, prefill POST, and the shared offer/accept/decline/cancel POST config.
    expect(src.match(/auditRead:/g)).toHaveLength(6);
    expect(src.match(/config: postAudit/g)).toHaveLength(4);
    expect(src).toContain('resourceIdPayloadPath: "handoff.id"');
    expect(src).toContain('resourceKind: "clinical_handoff_prefill"');
    expect(src).toContain('resourceIdParam: "handoffId"');
    expect(src).toContain('patientIdsPayload: { path: "handoff.items", key: "patient_id" }');
  });

  it("registers the static paths before the parameterised one", () => {
    const src = routesSrc();
    const param = src.indexOf('"/api/v1/messaging/handoffs/:handoffId",');
    for (const p of ["/handoffs/caseload", "/handoffs/prefill", "/handoffs/policy"]) {
      expect(src.indexOf(`"/api/v1/messaging${p}"`)).toBeLessThan(param);
    }
  });
});
