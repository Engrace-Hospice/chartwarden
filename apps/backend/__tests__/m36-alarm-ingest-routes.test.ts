// WP 6.10 (ADR-0102) - alarm ingest over the route stack and the REAL Authorization Contract, with the REAL service over an in-memory store (the rules
// are proven in alarm-ingest-service.test.ts, the SQL by m36-alarm-ingest.live.test.ts).
//
//   inbound: NO session; the HMAC is the credential; ONE 401 body for everything up to a wrong signature; the raw bytes are what is signed; a body over
//            the cap is refused by the framework before the handler runs; a replay is a 202 duplicate
//   staff:   messaging.alarm_ingest.manage (403), the tenant flag (404, before the step-up), a fresh step-up on create / rotate / disable (403 STEP_UP_REQUIRED)
//   mounted: `inboundRoute: false` (no trusted proxy list) removes ONLY the inbound route
import {
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
import { signAlarmRequest } from "../src/modules/36-messaging/alarm-ingest/alarm-ingest-core";
import {
  fakeAlarmCipher,
  makeFakeAlarmIngestStore,
} from "../src/modules/36-messaging/alarm-ingest/alarm-ingest-fake-store";
import { createAlarmIngestService } from "../src/modules/36-messaging/alarm-ingest/alarm-ingest-service";
import { registerAlarmIngestRoutes } from "../src/modules/36-messaging/routes/alarm-ingest-routes";

const ORG = "11111111-1111-4111-8111-111111111111";
const KEYS: Record<string, string[]> = {
  officer: ["messaging.alarm_ingest.manage"],
  nurse: ["messaging.read", "messaging.review"],
};
const MAPPINGS = [
  { alarmKind: "bed_exit", alertType: "alarm_ingest.patient_sensor", severityCeiling: "warn" },
];

let flagOn = true;
let stepUpAsked: string[] = [];
const emit = vi.fn(async () => ({ alertId: "alert-1", resolvedRecipientCount: 1 }));

function headerAuth(request: FastifyRequest): void {
  const user = request.headers["x-test-user"];
  if (typeof user !== "string" || user.length === 0) return;
  request.context.userId = user;
  request.context.organizationId = ORG;
  request.context.roles = [];
  request.context.locationIds = [];
  if (request.headers["x-fresh"] === "1") request.context.attributes.stepUpRecent = true;
}

function makeServer(opts: { inboundRoute?: boolean } = {}) {
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
  registry.register("step_up_recent", async (ctx, target) => {
    stepUpAsked.push(String((target as { operationKey?: unknown }).operationKey));
    return ctx.attributes.stepUpRecent === true;
  });
  registerAbacRegistry(registry);
  const { store } = makeFakeAlarmIngestStore();
  const service = createAlarmIngestService({
    store,
    cipher: fakeAlarmCipher,
    alerts: () => ({ emit }) as never,
    flags: { forOrg: async () => ({ "messaging.alarm_ingest": flagOn }) },
  });
  const app = buildServer({ authenticate: headerAuth, security: { rateLimitEnabled: false } });
  registerAlarmIngestRoutes(app, { service, ...opts });
  return { app, service };
}

const INGEST = "/api/v1/messaging/alarm-ingest/events";
const SOURCES = "/api/v1/messaging/alarm-sources";
const code = (res: { json(): { error?: { code?: string } } }) => res.json().error?.code;
const nowTs = () => String(Math.floor(Date.now() / 1000));

async function signedPost(
  app: ReturnType<typeof makeServer>["app"],
  cred: { keyId: string; secret: string },
  rawBody: string,
  over: { timestamp?: string; headers?: Record<string, string>; contentType?: string } = {},
) {
  const timestamp = over.timestamp ?? nowTs();
  return app.inject({
    method: "POST",
    url: INGEST,
    headers: {
      "content-type": over.contentType ?? "application/json",
      "x-wx-key-id": cred.keyId,
      "x-wx-timestamp": timestamp,
      "x-wx-signature": signAlarmRequest({ ...cred, timestamp, rawBody }),
      ...over.headers,
    },
    payload: rawBody,
  });
}

beforeEach(() => {
  flagOn = true;
  stepUpAsked = [];
  emit.mockClear();
  resetAuthorizationContract();
  resetRbacEngine();
  resetAbacRegistry();
});
afterEach(() => {
  resetAuthorizationContract();
  resetRbacEngine();
  resetAbacRegistry();
});

describe("POST /alarm-ingest/events (no session)", () => {
  it("a correctly signed alarm is a 202, uncached, with no session at all", async () => {
    const { app, service } = makeServer();
    const cred = await service.create({ organizationId: ORG, userId: "officer" }, { name: "n", mappings: MAPPINGS });
    const res = await signedPost(app, cred, '{"eventId":"e1","alarmKind":"bed_exit"}');
    expect(res.statusCode).toBe(202);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.json()).toEqual({ status: "accepted", outcome: "alerted" });
    expect(emit).toHaveBeenCalledTimes(1);
    const replay = await signedPost(app, cred, '{"eventId":"e1","alarmKind":"bed_exit"}');
    expect(replay.json()).toEqual({ status: "duplicate", outcome: "alerted" });
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it("the exact bytes are signed: whitespace changes the HMAC", async () => {
    const { app, service } = makeServer();
    const cred = await service.create({ organizationId: ORG, userId: "officer" }, { name: "n", mappings: MAPPINGS });
    const timestamp = nowTs();
    const signed = signAlarmRequest({ ...cred, timestamp, rawBody: '{"eventId":"e1","alarmKind":"bed_exit"}' });
    const res = await app.inject({
      method: "POST",
      url: INGEST,
      headers: {
        "content-type": "application/json",
        "x-wx-key-id": cred.keyId,
        "x-wx-timestamp": timestamp,
        "x-wx-signature": signed,
      },
      payload: '{"eventId": "e1", "alarmKind": "bed_exit"}',
    });
    expect(res.statusCode).toBe(401);
  });

  it("every pre-signature failure is the SAME byte-identical 401", async () => {
    const { app, service } = makeServer();
    const cred = await service.create({ organizationId: ORG, userId: "officer" }, { name: "n", mappings: MAPPINGS });
    const body = '{"eventId":"e1","alarmKind":"bed_exit"}';
    const strip = (b: string) => b.replace(/"(requestId|correlationId)":"[^"]*"/g, "");
    const responses = [
      await signedPost(app, { ...cred, secret: "wxas_wrong" }, body),
      await signedPost(app, cred, body, { timestamp: String(Number(nowTs()) - 4000) }),
      await signedPost(app, cred, body, { headers: { "x-wx-key-id": "nope" } }),
      await signedPost(app, cred, body, { headers: { "x-wx-signature": "v1=00" } }),
      await app.inject({ method: "POST", url: INGEST, headers: { "content-type": "application/json" }, payload: body }),
    ];
    for (const r of responses) expect(r.statusCode).toBe(401);
    expect(new Set(responses.map((r) => strip(r.body))).size).toBe(1);
  });

  it("a flag-off tenant gets the same 401, never a hint that the feature exists", async () => {
    const { app, service } = makeServer();
    const cred = await service.create({ organizationId: ORG, userId: "officer" }, { name: "n", mappings: MAPPINGS });
    flagOn = false;
    const res = await signedPost(app, cred, '{"eventId":"e1","alarmKind":"bed_exit"}');
    expect(res.statusCode).toBe(401);
    expect(emit).not.toHaveBeenCalled();
  });

  it("a body over the cap is refused before the handler", async () => {
    const { app, service } = makeServer();
    const cred = await service.create({ organizationId: ORG, userId: "officer" }, { name: "n", mappings: MAPPINGS });
    const big = JSON.stringify({ eventId: "e1", alarmKind: "bed_exit", pad: "x".repeat(2000) });
    const tooBig = await signedPost(app, cred, big);
    expect(tooBig.statusCode).toBe(413);
    expect(emit).not.toHaveBeenCalled();
  });

  it("a stolen staff session cookie header proves nothing: only the HMAC counts", async () => {
    const { app, service } = makeServer();
    const cred = await service.create({ organizationId: ORG, userId: "officer" }, { name: "n", mappings: MAPPINGS });
    const res = await app.inject({
      method: "POST",
      url: INGEST,
      headers: { "content-type": "application/json", "x-test-user": "officer", "x-fresh": "1" },
      payload: JSON.stringify({ eventId: "e1", alarmKind: "bed_exit" }),
    });
    expect(res.statusCode).toBe(401);
    expect(cred.secret).toBeTruthy();
  });

  it("is not mounted when the trusted-proxy gate says no, and staff routes still are", async () => {
    const { app } = makeServer({ inboundRoute: false });
    const gone = await app.inject({ method: "POST", url: INGEST, payload: "{}" });
    expect(gone.statusCode).toBe(404);
    const list = await app.inject({ method: "GET", url: SOURCES, headers: { "x-test-user": "officer" } });
    expect(list.statusCode).toBe(200);
  });
});

describe("staff routes", () => {
  const post = (app: ReturnType<typeof makeServer>["app"], user: string | null, url: string, opts: { fresh?: boolean; payload?: unknown } = {}) =>
    app.inject({
      method: "POST",
      url,
      headers: {
        ...(user ? { "x-test-user": user } : {}),
        ...(opts.fresh === false ? {} : { "x-fresh": "1" }),
      },
      payload: (opts.payload ?? {}) as Record<string, unknown>,
    });
  const body = { name: "Ward 2", mappings: MAPPINGS };

  it("needs a session (401) and the manage permission (403) on every staff route", async () => {
    const { app } = makeServer();
    for (const [method, url] of [
      ["GET", SOURCES],
      ["POST", SOURCES],
      ["POST", `${SOURCES}/22222222-2222-4222-8222-222222222222/rotate-secret`],
      ["POST", `${SOURCES}/22222222-2222-4222-8222-222222222222/disable`],
    ] as const) {
      const anon = await app.inject({ method, url });
      expect(anon.statusCode, `${method} ${url}`).toBe(401);
      const nurse = await app.inject({ method, url, headers: { "x-test-user": "nurse", "x-fresh": "1" }, ...(method === "POST" ? { payload: body } : {}) });
      expect(nurse.statusCode, `${method} ${url}`).toBe(403);
    }
  });

  it("create returns 201 with the secret ONCE, uncached; list never carries a secret", async () => {
    const { app } = makeServer();
    const res = await post(app, "officer", SOURCES, { payload: body });
    expect(res.statusCode).toBe(201);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.json().secret).toMatch(/^wxas_/);
    expect(stepUpAsked).toEqual(["messaging.alarm_ingest.manage"]);
    const list = await app.inject({ method: "GET", url: SOURCES, headers: { "x-test-user": "officer" } });
    expect(list.statusCode).toBe(200);
    expect(list.body).not.toContain(res.json().secret);
    expect(list.json().sources).toHaveLength(1);
  });

  it("flag off: create and rotate are the uniform 404 before the step-up is asked; list and disable still work", async () => {
    const { app } = makeServer();
    const made = await post(app, "officer", SOURCES, { payload: body });
    const id = made.json().id as string;
    flagOn = false;
    stepUpAsked = [];
    expect((await post(app, "officer", SOURCES, { payload: body })).statusCode).toBe(404);
    expect((await post(app, "officer", `${SOURCES}/${id}/rotate-secret`)).statusCode).toBe(404);
    expect(stepUpAsked).toEqual([]);
    expect((await app.inject({ method: "GET", url: SOURCES, headers: { "x-test-user": "officer" } })).statusCode).toBe(200);
    const off = await post(app, "officer", `${SOURCES}/${id}/disable`);
    expect(off.statusCode).toBe(200);
    expect(off.json().enabled).toBe(false);
  });

  it("a stale session cannot create, rotate or disable: 403 STEP_UP_REQUIRED", async () => {
    const { app } = makeServer();
    const made = await post(app, "officer", SOURCES, { payload: body });
    const id = made.json().id as string;
    for (const url of [SOURCES, `${SOURCES}/${id}/rotate-secret`, `${SOURCES}/${id}/disable`]) {
      const res = await post(app, "officer", url, { fresh: false, payload: url === SOURCES ? body : {} });
      expect(res.statusCode, url).toBe(403);
      expect(code(res), url).toBe("STEP_UP_REQUIRED");
    }
  });

  it("a malformed id is a 4xx before the service, and a mapping that is not a catalog type is 422", async () => {
    const { app } = makeServer();
    expect((await post(app, "officer", `${SOURCES}/not-a-uuid/disable`)).statusCode).toBeGreaterThanOrEqual(400);
    const bad = await post(app, "officer", SOURCES, {
      payload: { name: "x", mappings: [{ ...MAPPINGS[0], alertType: "m36.ack.requested" }] },
    });
    expect(bad.statusCode).toBe(422);
    const critical = await post(app, "officer", SOURCES, {
      payload: { name: "x", mappings: [{ ...MAPPINGS[0], severityCeiling: "critical" }] },
    });
    expect(critical.statusCode).toBe(422);
  });
});
