// apps/backend/__tests__/m12-tenant-dosespot-routes.test.ts — HTTP-layer proof of the tenant's own DoseSpot registration
// routes (`/api/v1/tenant/dosespot`, tenant onboarding slice 4) over the REAL Authorization Contract and a recording service:
// the ORG-LEVEL `prescribing.clinic.*` keys guard them (a holder of only the prescriber-roster key is refused), every write
// needs a fresh step-up, the AI-block and Idempotency-Key guards are composed, a malformed body is refused before the service
// runs, the org and acting membership come from the session never the body, no credential is echoed, and `verify` is rate limited.
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
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import { createInMemoryRateLimitStore } from "../src/bootstrap/plugins/rate-limit-store";
import {
  DOSESPOT_VERIFY_ROUTE_RATE_LIMIT,
  createRouteRateLimit,
} from "../src/bootstrap/plugins/route-rate-limit";
import { registerTenantDoseSpotRoutes } from "../src/modules/12-dosespot/tenant-config/routes";
import type {
  ClinicConfigView,
  PutClinicInput,
} from "../src/modules/12-dosespot/tenant-config/service";
import type { DoseSpotClinicRouteService } from "../src/modules/12-dosespot/tenant-config/tenant-service";

const ORG = "0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a";
const MEMBERSHIP = "abababab-abab-4bab-8bab-abababababab";
const SECRET = "fake-clinic-key-not-a-secret#1";

function headerAuth(request: FastifyRequest): void {
  const user = request.headers["x-test-user"];
  if (typeof user !== "string" || user.length === 0) return;
  request.context.userId = user;
  request.context.organizationId = ORG;
  request.context.attributes.membershipId = MEMBERSHIP;
  if (request.headers["x-test-step-up"] === "1") request.context.attributes.stepUpRecent = true;
  const actorKind = request.headers["x-test-actor-kind"];
  if (typeof actorKind === "string" && actorKind.length > 0) {
    request.context.attributes.actorKind = actorKind;
  }
}

const VIEW: ClinicConfigView = {
  source: "tenant",
  status: "registered",
  environment: "sandbox",
  clinicId: "clinic-1",
  serviceClinicianId: "900",
  hasSecret: true,
  registeredAt: "2026-11-06T00:00:00.000Z",
  verifiedAt: null,
  activatedAt: null,
  lastTest: null,
  prescribersEnrolled: 0,
  queuedTransmissions: 0,
  version: 1,
  updatedAt: "2026-11-06T00:00:00.000Z",
};

interface Call {
  readonly method: string;
  readonly organizationId: string;
  readonly membershipId?: string;
  readonly body?: unknown;
  readonly expectedVersion?: number | undefined;
}

function makeServer(opts: { verifyLimit?: number } = {}) {
  const calls: Call[] = [];
  const service: DoseSpotClinicRouteService = {
    async get(organizationId) {
      calls.push({ method: "get", organizationId });
      return VIEW;
    },
    async put(actor, body: PutClinicInput, expectedVersion) {
      calls.push({
        method: "put",
        organizationId: actor.organizationId,
        membershipId: actor.membershipId,
        body,
        expectedVersion,
      });
      return { created: expectedVersion === undefined, view: VIEW };
    },
    async verify(actor) {
      calls.push({ method: "verify", organizationId: actor.organizationId });
      return { view: { ...VIEW, status: "verified" }, test: { outcome: "ok" } };
    },
    async activate(actor) {
      calls.push({ method: "activate", organizationId: actor.organizationId });
      return { ...VIEW, status: "active" };
    },
    async deactivate(actor) {
      calls.push({ method: "deactivate", organizationId: actor.organizationId });
      return { ...VIEW, status: "verified" };
    },
  };
  const grant = (userId: string, keys: string[]) => ({
    orgId: ORG,
    userId,
    grants: [{ roleKey: "seed", enabled: true, expiresAt: null, permissionKeys: keys }],
  });
  registerEffectivePermissionResolver(
    createInMemoryEffectivePermissionStore([
      grant("admin_1", ["prescribing.clinic.read", "prescribing.clinic.admin"]),
      grant("reader_1", ["prescribing.clinic.read"]),
      // a roster admin holds the prescriber-roster key, never the registration keys
      grant("roster_1", ["prescribing.admin.roster"]),
      grant("none_1", []),
    ]).store,
  );
  const reg = createPredicateRegistry();
  reg.register("step_up_recent", async (context) => context.attributes.stepUpRecent === true);
  registerAbacRegistry(reg);
  const app = buildServer({ authenticate: headerAuth, security: { rateLimitEnabled: false } });
  registerTenantDoseSpotRoutes(app, {
    clinicService: service,
    ...(opts.verifyLimit
      ? {
          verifyRateLimit: createRouteRateLimit({
            store: createInMemoryRateLimitStore(),
            limit: { ...DOSESPOT_VERIFY_ROUTE_RATE_LIMIT, perUser: opts.verifyLimit },
            keyPrefix: "test-ds-verify",
          }) as never,
        }
      : {}),
  });
  return { app, calls };
}

const ADMIN = { "x-test-user": "admin_1", "x-test-step-up": "1" };
let seq = 0;
const idem = () => ({ "idempotency-key": `ds-${++seq}` });
const URL = "/api/v1/tenant/dosespot";
const BODY = {
  environment: "sandbox",
  clinicId: "clinic-1",
  serviceClinicianId: "900",
  clinicKey: SECRET,
};

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

describe("tenant DoseSpot routes", () => {
  const WRITES = [
    { method: "PUT", url: URL, payload: BODY },
    { method: "POST", url: `${URL}/verify`, payload: {} },
    { method: "POST", url: `${URL}/activate`, payload: {} },
    { method: "POST", url: `${URL}/deactivate`, payload: {} },
  ] as const;

  for (const w of WRITES) {
    it(`${w.method} ${w.url}: refuses no session, no key, a read-only role, a stale step-up, an AI actor and a missing Idempotency-Key`, async () => {
      const { app, calls } = makeServer();
      const send = (headers: Record<string, string>) =>
        app.inject({ method: w.method, url: w.url, headers, payload: w.payload });
      expect((await send({ ...idem() })).statusCode).toBe(401);
      expect(
        (await send({ "x-test-user": "none_1", "x-test-step-up": "1", ...idem() })).statusCode,
      ).toBe(403);
      expect(
        (await send({ "x-test-user": "reader_1", "x-test-step-up": "1", ...idem() })).statusCode,
      ).toBe(403);
      // the prescriber-roster key does not open the org-level registration surface
      expect(
        (await send({ "x-test-user": "roster_1", "x-test-step-up": "1", ...idem() })).statusCode,
      ).toBe(403);
      const stale = await send({ "x-test-user": "admin_1", ...idem() });
      expect(stale.statusCode).toBe(403);
      expect(stale.json().error?.code ?? stale.json().code).toBe("STEP_UP_REQUIRED");
      expect(
        (await send({ ...ADMIN, "x-test-actor-kind": "ai_agent", ...idem() })).statusCode,
      ).toBe(403);
      const missingKey = await send(ADMIN);
      expect(missingKey.statusCode).toBe(400);
      expect(missingKey.json().error?.code ?? missingKey.json().code).toBe(
        "IDEMPOTENCY_KEY_REQUIRED",
      );
      expect(calls).toEqual([]);
      await app.close();
    });
  }

  it("GET needs only the read key and never echoes a credential", async () => {
    const { app, calls } = makeServer();
    expect(
      (await app.inject({ method: "GET", url: URL, headers: { "x-test-user": "none_1" } }))
        .statusCode,
    ).toBe(403);
    expect(
      (await app.inject({ method: "GET", url: URL, headers: { "x-test-user": "roster_1" } }))
        .statusCode,
    ).toBe(403);
    const res = await app.inject({
      method: "GET",
      url: URL,
      headers: { "x-test-user": "reader_1" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "registered", hasSecret: true });
    expect(res.body).not.toContain("clinicKey");
    expect(calls.map((c) => c.method)).toEqual(["get"]);
    await app.close();
  });

  it("PUT answers 201 on a first save and 200 on a version-checked change; the org and membership are the session's", async () => {
    const { app, calls } = makeServer();
    const first = await app.inject({
      method: "PUT",
      url: URL,
      headers: { ...ADMIN, ...idem() },
      payload: BODY,
    });
    expect(first.statusCode).toBe(201);
    const change = await app.inject({
      method: "PUT",
      url: URL,
      headers: { ...ADMIN, ...idem(), "if-match": '"4"' },
      payload: BODY,
    });
    expect(change.statusCode).toBe(200);
    const bad = await app.inject({
      method: "PUT",
      url: URL,
      headers: { ...ADMIN, ...idem(), "if-match": "four" },
      payload: BODY,
    });
    expect(bad.statusCode).toBe(422);
    expect(calls.map((c) => c.expectedVersion)).toEqual([undefined, 4]);
    expect(calls[0]).toMatchObject({ organizationId: ORG, membershipId: MEMBERSHIP, body: BODY });
    expect(first.body).not.toContain(SECRET);
    await app.close();
  });

  it("refuses an unknown environment, a URL field, an organization id in the body and a short key before the service runs", async () => {
    const { app, calls } = makeServer();
    const put = (payload: object) =>
      app.inject({ method: "PUT", url: URL, headers: { ...ADMIN, ...idem() }, payload });
    expect((await put({ ...BODY, environment: "staging" })).statusCode).toBe(422);
    expect((await put({ ...BODY, baseUrl: "https://evil.example.com" })).statusCode).toBe(422);
    expect((await put({ ...BODY, organizationId: "someone-else" })).statusCode).toBe(422);
    expect((await put({ ...BODY, epcsCertified: true })).statusCode).toBe(422);
    expect((await put({ ...BODY, clinicKey: "short" })).statusCode).toBe(422);
    expect((await put({ clinicId: "clinic-1" })).statusCode).toBe(422); // environment is required
    expect(calls).toEqual([]);
    await app.close();
  });

  it("verify, activate and deactivate return the config (and the test outcome)", async () => {
    const { app, calls } = makeServer();
    const post = (path: string) =>
      app.inject({
        method: "POST",
        url: `${URL}/${path}`,
        headers: { ...ADMIN, ...idem() },
        payload: {},
      });
    const verify = await post("verify");
    expect(verify.statusCode).toBe(200);
    expect(verify.json()).toMatchObject({
      config: { status: "verified" },
      test: { outcome: "ok" },
    });
    expect((await post("activate")).json()).toMatchObject({ status: "active" });
    expect((await post("deactivate")).json()).toMatchObject({ status: "verified" });
    expect(calls.map((c) => c.method)).toEqual(["verify", "activate", "deactivate"]);
    await app.close();
  });

  it("rate limits verify per user (a vendor call per request), after the permission and step-up guards", async () => {
    const { app, calls } = makeServer({ verifyLimit: 2 });
    const verify = (headers: Record<string, string>) =>
      app.inject({
        method: "POST",
        url: `${URL}/verify`,
        headers: { ...headers, ...idem() },
        payload: {},
      });
    for (let i = 0; i < 5; i += 1) {
      expect((await verify({ "x-test-user": "reader_1", "x-test-step-up": "1" })).statusCode).toBe(
        403,
      );
    }
    expect((await verify(ADMIN)).statusCode).toBe(200);
    expect((await verify(ADMIN)).statusCode).toBe(200);
    expect((await verify(ADMIN)).statusCode).toBe(429);
    expect(calls.filter((c) => c.method === "verify")).toHaveLength(2);
    await app.close();
  });
});
