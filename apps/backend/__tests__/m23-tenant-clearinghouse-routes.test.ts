// apps/backend/__tests__/m23-tenant-clearinghouse-routes.test.ts — HTTP-layer proof of the tenant's own clearinghouse routes
// (`/api/v1/tenant/clearinghouse`, ADR-0053 amendment 2026-11-06) over the REAL Authorization Contract and a recording
// service: the MAC-credential permission keys guard them, every write needs a fresh step-up, the AI-block and
// Idempotency-Key guards are composed, a malformed body is refused before the service runs, the org and acting membership
// come from the session never the body, and the credential is never echoed.
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
import { registerTenantClearinghouseRoutes } from "../src/modules/23-billing-medicare/tenant-clearinghouse/routes";
import type {
  ClearinghouseConfigView,
  PutClearinghouseInput,
} from "../src/modules/23-billing-medicare/tenant-clearinghouse/service";
import type { TenantClearinghouseRouteService } from "../src/modules/23-billing-medicare/tenant-clearinghouse/tenant-service";

const ORG = "0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a";
const MEMBERSHIP = "abababab-abab-4bab-8bab-abababababab";
const SECRET = "fake-key-not-a-secret#1";

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

const VIEW: ClearinghouseConfigView = {
  vendor: "claimmd",
  mode: "test",
  status: "draft",
  source: "tenant",
  hasSecret: true,
  verifiableBy: "connection_test",
  verification: null,
  lastTest: null,
  activatedAt: null,
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

function makeServer() {
  const calls: Call[] = [];
  const service: TenantClearinghouseRouteService = {
    async get(actor) {
      calls.push({ method: "get", organizationId: actor.organizationId });
      return VIEW;
    },
    async put(actor, body: PutClearinghouseInput, expectedVersion) {
      calls.push({
        method: "put",
        organizationId: actor.organizationId,
        membershipId: actor.membershipId,
        body,
        expectedVersion,
      });
      return { created: expectedVersion === undefined, view: VIEW };
    },
    async verify(actor, body) {
      calls.push({ method: "verify", organizationId: actor.organizationId, body });
      return { view: { ...VIEW, status: "verified" }, test: { outcome: "ok" } };
    },
    async activate(actor) {
      calls.push({ method: "activate", organizationId: actor.organizationId });
      return { ...VIEW, status: "active" };
    },
  };
  const grant = (userId: string, keys: string[]) => ({
    orgId: ORG,
    userId,
    grants: [{ roleKey: "seed", enabled: true, expiresAt: null, permissionKeys: keys }],
  });
  registerEffectivePermissionResolver(
    createInMemoryEffectivePermissionStore([
      grant("admin_1", ["billing.mac_credential.read", "billing.mac_credential.admin"]),
      grant("reader_1", ["billing.mac_credential.read"]),
      grant("none_1", []),
    ]).store,
  );
  const reg = createPredicateRegistry();
  reg.register("step_up_recent", async (context) => context.attributes.stepUpRecent === true);
  registerAbacRegistry(reg);
  const app = buildServer({ authenticate: headerAuth, security: { rateLimitEnabled: false } });
  registerTenantClearinghouseRoutes(app, { tenantClearinghouseService: service });
  return { app, calls };
}

const ADMIN = { "x-test-user": "admin_1", "x-test-step-up": "1" };
let seq = 0;
const idem = () => ({ "idempotency-key": `tc-${++seq}` });
const URL = "/api/v1/tenant/clearinghouse";
const BODY = { vendor: "claimmd", mode: "test", secret: SECRET };

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

describe("tenant clearinghouse routes", () => {
  const WRITES = [
    { method: "PUT", url: URL, payload: BODY },
    { method: "POST", url: `${URL}/verify`, payload: {} },
    { method: "POST", url: `${URL}/activate`, payload: {} },
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
    const res = await app.inject({
      method: "GET",
      url: URL,
      headers: { "x-test-user": "reader_1" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ vendor: "claimmd", hasSecret: true });
    expect(res.body).not.toContain('secret":"');
    expect(calls.map((c) => c.method)).toEqual(["get"]);
    await app.close();
  });

  it("PUT answers 201 on a first choice and 200 on a version-checked change; the org and membership are the session's", async () => {
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
    expect(bad.statusCode).toBe(400); // M23's parseIfMatch refuses a malformed version
    expect(calls.map((c) => c.expectedVersion)).toEqual([undefined, 4]);
    expect(calls[0]).toMatchObject({ organizationId: ORG, membershipId: MEMBERSHIP, body: BODY });
    expect(first.body).not.toContain(SECRET);
    await app.close();
  });

  it("refuses an unknown vendor, an unknown field (an organization id in the body), and a short credential before the service runs", async () => {
    const { app, calls } = makeServer();
    const put = (payload: object) =>
      app.inject({ method: "PUT", url: URL, headers: { ...ADMIN, ...idem() }, payload });
    expect((await put({ ...BODY, vendor: "acme" })).statusCode).toBe(422);
    expect((await put({ ...BODY, organizationId: "someone-else" })).statusCode).toBe(422);
    expect((await put({ ...BODY, secret: "short" })).statusCode).toBe(422);
    expect(calls).toEqual([]);
    await app.close();
  });

  it("verify returns the config and the test outcome; activate returns the config", async () => {
    const { app, calls } = makeServer();
    const verify = await app.inject({
      method: "POST",
      url: `${URL}/verify`,
      headers: { ...ADMIN, ...idem() },
      payload: { evidenceNote: "Sandbox claim accepted by the vendor, ticket OPS-9" },
    });
    expect(verify.statusCode).toBe(200);
    expect(verify.json()).toMatchObject({
      config: { status: "verified" },
      test: { outcome: "ok" },
    });
    const activate = await app.inject({
      method: "POST",
      url: `${URL}/activate`,
      headers: { ...ADMIN, ...idem() },
      payload: {},
    });
    expect(activate.statusCode).toBe(200);
    expect(activate.json()).toMatchObject({ status: "active" });
    expect(calls.map((c) => c.method)).toEqual(["verify", "activate"]);
    await app.close();
  });
});
