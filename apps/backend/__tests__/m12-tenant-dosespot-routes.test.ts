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
import type { PractitionerLinkService } from "../src/modules/12-dosespot/tenant-config/practitioner-link";
import type { PrescriberEnrollmentService } from "../src/modules/12-dosespot/tenant-config/prescriber-enrollment";
import { registerTenantDoseSpotRoutes } from "../src/modules/12-dosespot/tenant-config/routes";
import type {
  ClinicConfigView,
  PutClinicInput,
} from "../src/modules/12-dosespot/tenant-config/service";
import type { DoseSpotClinicRouteService } from "../src/modules/12-dosespot/tenant-config/tenant-service";
import type { TransmissionResolveService } from "../src/modules/12-dosespot/tenant-config/transmission-resolve";

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
  live: false,
  notLiveReason: null,
  registeredAt: "2026-11-06T00:00:00.000Z",
  verifiedAt: null,
  activatedAt: null,
  lastTest: null,
  prescribersEnrolled: 0,
  queuedTransmissions: 0,
  version: 1,
  updatedAt: "2026-11-06T00:00:00.000Z",
};

const LINK_VIEW = {
  membershipId: MEMBERSHIP,
  linked: true,
  externalPhysicianMdmId: "77777777-7777-4777-8777-777777777777",
  physician: { firstName: "Orrin", lastName: "Delacroix", npi: "1234567893" },
  confirmed: false,
};

interface Call {
  readonly method: string;
  readonly organizationId: string;
  readonly membershipId?: string;
  readonly body?: unknown;
  readonly expectedVersion?: number | undefined;
  readonly orderId?: string;
  readonly userId?: string;
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
      // a prescriber (may sign orders) confirms their OWN link; nobody else's key opens it
      grant("prescriber_1", ["prescribing.sign"]),
      grant("none_1", []),
    ]).store,
  );
  const reg = createPredicateRegistry();
  reg.register("step_up_recent", async (context) => context.attributes.stepUpRecent === true);
  registerAbacRegistry(reg);
  const app = buildServer({ authenticate: headerAuth, security: { rateLimitEnabled: false } });
  const enrollmentService: Pick<PrescriberEnrollmentService, "enroll"> = {
    async enroll(actor, membershipId) {
      calls.push({
        method: "enroll",
        organizationId: actor.organizationId,
        membershipId,
      });
      return { membershipId, enrolledWithDoseSpot: true };
    },
  };
  const linkService: PractitionerLinkService = {
    async view(actor) {
      calls.push({
        method: "link.view",
        organizationId: actor.organizationId,
        membershipId: actor.membershipId,
      });
      return LINK_VIEW;
    },
    async confirm(actor, input) {
      calls.push({
        method: "link.confirm",
        organizationId: actor.organizationId,
        membershipId: actor.membershipId,
        body: input,
      });
      return { ...LINK_VIEW, confirmed: true };
    },
  };
  const resolveService: TransmissionResolveService = {
    async resolve(actor, orderId, input) {
      calls.push({
        method: "resolve",
        organizationId: actor.organizationId,
        membershipId: actor.membershipId,
        userId: actor.userId,
        orderId,
        body: input,
      });
      return {
        orderId,
        outcome: input.outcome,
        status: input.outcome === "sent" ? "transmitted" : "transmission_failed",
      };
    },
  };
  registerTenantDoseSpotRoutes(app, {
    clinicService: service,
    enrollmentService,
    linkService,
    resolveService,
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

describe("prescriber DoseSpot enrolment route", () => {
  const MEMBER = "cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd";
  const ENROLL = `/api/v1/admin/dosespot-prescribers/${MEMBER}/dosespot-enrollment`;
  // enrolment takes NO identity: the NPI and legal name come from the physician record the roster links the member to
  const TYPED_IDENTITY = { npi: "1234567893", firstName: "Ada", lastName: "Lovelace" };
  const ROSTER_ADMIN = { "x-test-user": "roster_1", "x-test-step-up": "1" };

  it("needs the roster key (the clinic admin key does not open it), a fresh step-up, no AI actor and an Idempotency-Key", async () => {
    const { app, calls } = makeServer();
    const send = (headers: Record<string, string>) =>
      app.inject({ method: "POST", url: ENROLL, headers, payload: {} });
    expect((await send({ ...idem() })).statusCode).toBe(401);
    expect((await send({ ...ADMIN, ...idem() })).statusCode).toBe(403); // clinic admin, not roster admin
    expect((await send({ "x-test-user": "roster_1", ...idem() })).statusCode).toBe(403); // stale step-up
    expect(
      (await send({ ...ROSTER_ADMIN, "x-test-actor-kind": "ai_agent", ...idem() })).statusCode,
    ).toBe(403);
    expect((await send(ROSTER_ADMIN)).statusCode).toBe(400);
    expect(calls).toEqual([]);
    await app.close();
  });

  it("enrols with the session's org and membership, from an empty body or none at all", async () => {
    const { app, calls } = makeServer();
    const headers = { ...ROSTER_ADMIN, ...idem() };
    const ok = await app.inject({ method: "POST", url: ENROLL, headers, payload: {} });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ membershipId: MEMBER, enrolledWithDoseSpot: true });
    const bare = await app.inject({
      method: "POST",
      url: ENROLL,
      headers: { ...ROSTER_ADMIN, ...idem() },
    });
    expect(bare.statusCode).toBe(200);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ method: "enroll", organizationId: ORG, membershipId: MEMBER });
    await app.close();
  });

  it("refuses a typed NPI, first name or last name (422) before the service: identity is never taken from the caller", async () => {
    const { app, calls } = makeServer();
    const post = (url: string, payload: object) =>
      app.inject({ method: "POST", url, headers: { ...ROSTER_ADMIN, ...idem() }, payload });
    expect((await post(ENROLL, TYPED_IDENTITY)).statusCode).toBe(422);
    for (const field of Object.keys(TYPED_IDENTITY)) {
      const only = { [field]: TYPED_IDENTITY[field as keyof typeof TYPED_IDENTITY] };
      expect((await post(ENROLL, only)).statusCode, field).toBe(422);
    }
    expect((await post(ENROLL, { epcsRequested: true })).statusCode).toBe(422);
    expect((await post(ENROLL, { organizationId: "x" })).statusCode).toBe(422);
    expect(
      (await post("/api/v1/admin/dosespot-prescribers/not-a-uuid/dosespot-enrollment", {}))
        .statusCode,
    ).toBe(422);
    expect(calls).toEqual([]);
    await app.close();
  });
});

describe("the prescriber's own link confirmation routes", () => {
  const VIEW_URL = "/api/v1/me/dosespot-prescriber-link";
  const CONFIRM_URL = `${VIEW_URL}/confirm`;
  const SEEN = { externalPhysicianMdmId: LINK_VIEW.externalPhysicianMdmId, npi: "1234567893" };
  const PRESCRIBER = { "x-test-user": "prescriber_1", "x-test-step-up": "1" };

  it("shows the signed-in member's OWN link (their session's membership selects the roster row) to a member who may sign", async () => {
    const { app, calls } = makeServer();
    const ok = await app.inject({
      method: "GET",
      url: VIEW_URL,
      headers: { "x-test-user": "prescriber_1" },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({
      linked: true,
      physician: { npi: "1234567893" },
      confirmed: false,
    });
    expect(calls).toEqual([{ method: "link.view", organizationId: ORG, membershipId: MEMBERSHIP }]);
    for (const user of ["admin_1", "roster_1", "none_1"]) {
      // neither a clinic admin nor a roster admin holds it: it is the prescriber's, not an administrator's
      const denied = await app.inject({
        method: "GET",
        url: VIEW_URL,
        headers: { "x-test-user": user },
      });
      expect(denied.statusCode, user).toBe(403);
    }
    expect((await app.inject({ method: "GET", url: VIEW_URL })).statusCode).toBe(401);
    await app.close();
  });

  it("confirming needs the signing permission, a fresh step-up, no AI actor and an Idempotency-Key, and the roster/clinic admins' keys do not open it", async () => {
    const { app, calls } = makeServer();
    const send = (headers: Record<string, string>) =>
      app.inject({ method: "POST", url: CONFIRM_URL, headers, payload: SEEN });
    expect((await send({ ...idem() })).statusCode).toBe(401);
    expect((await send({ ...ADMIN, ...idem() })).statusCode).toBe(403);
    expect(
      (await send({ "x-test-user": "roster_1", "x-test-step-up": "1", ...idem() })).statusCode,
    ).toBe(403);
    expect((await send({ "x-test-user": "prescriber_1", ...idem() })).statusCode).toBe(403); // stale step-up
    expect(
      (await send({ ...PRESCRIBER, "x-test-actor-kind": "ai_agent", ...idem() })).statusCode,
    ).toBe(403);
    expect((await send(PRESCRIBER)).statusCode).toBe(400); // no Idempotency-Key
    expect(calls).toEqual([]);
    await app.close();
  });

  it("confirms with the session's own membership and the link and NPI they were shown; a body naming anyone else, or anything else, is a 422", async () => {
    const { app, calls } = makeServer();
    const post = (payload: object) =>
      app.inject({
        method: "POST",
        url: CONFIRM_URL,
        headers: { ...PRESCRIBER, ...idem() },
        payload,
      });
    const ok = await post(SEEN);
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ confirmed: true });
    expect(calls).toEqual([
      { method: "link.confirm", organizationId: ORG, membershipId: MEMBERSHIP, body: SEEN },
    ]);
    for (const bad of [
      { ...SEEN, membershipId: "99999999-9999-4999-8999-999999999999" }, // whose? the session's: the field does not exist
      { ...SEEN, organizationId: "x" },
      { ...SEEN, npi: "12345" },
      { ...SEEN, externalPhysicianMdmId: "not-a-uuid" },
      { externalPhysicianMdmId: SEEN.externalPhysicianMdmId },
      {},
    ]) {
      expect((await post(bad)).statusCode).toBe(422);
    }
    expect(calls).toHaveLength(1);
    await app.close();
  });
});

describe("an administrator's resolution of a held transmission", () => {
  const ORDER = "5c5c5c5c-5c5c-4c5c-8c5c-5c5c5c5c5c5c";
  const URL_OF = (id: string) => `/api/v1/medication-orders/${id}/resolve-held-transmission`;
  const REASON = "Checked the prescriber's DoseSpot account with the clinic lead.";
  const SENT = { outcome: "sent", reason: REASON, dosespotPrescriptionId: "9001" };
  const NOT_SENT = { outcome: "not_sent", reason: REASON };

  it("needs the org-level clinic admin key, a fresh step-up, no AI actor and an Idempotency-Key; no other key opens it", async () => {
    const { app, calls } = makeServer();
    const send = (headers: Record<string, string>) =>
      app.inject({ method: "POST", url: URL_OF(ORDER), headers, payload: NOT_SENT });
    expect((await send({ ...idem() })).statusCode).toBe(401);
    for (const user of ["reader_1", "roster_1", "prescriber_1", "none_1"]) {
      // neither the clinic READ key, the roster key nor the prescriber's signing key is an administrator's
      expect(
        (await send({ "x-test-user": user, "x-test-step-up": "1", ...idem() })).statusCode,
        user,
      ).toBe(403);
    }
    expect((await send({ "x-test-user": "admin_1", ...idem() })).statusCode).toBe(403); // stale step-up
    expect((await send({ ...ADMIN, "x-test-actor-kind": "ai_agent", ...idem() })).statusCode).toBe(
      403,
    );
    expect((await send(ADMIN)).statusCode).toBe(400); // no Idempotency-Key
    expect(calls).toEqual([]);
    await app.close();
  });

  it("resolves with the order from the path and the acting administrator from the session; both outcomes reach the service", async () => {
    const { app, calls } = makeServer();
    const post = (payload: object) =>
      app.inject({ method: "POST", url: URL_OF(ORDER), headers: { ...ADMIN, ...idem() }, payload });
    const sent = await post(SENT);
    expect(sent.statusCode).toBe(200);
    expect(sent.json()).toEqual({ orderId: ORDER, outcome: "sent", status: "transmitted" });
    const notSent = await post(NOT_SENT);
    expect(notSent.json()).toEqual({
      orderId: ORDER,
      outcome: "not_sent",
      status: "transmission_failed",
    });
    expect(calls).toEqual([
      {
        method: "resolve",
        organizationId: ORG,
        membershipId: MEMBERSHIP,
        userId: "admin_1",
        orderId: ORDER,
        body: SENT,
      },
      {
        method: "resolve",
        organizationId: ORG,
        membershipId: MEMBERSHIP,
        userId: "admin_1",
        orderId: ORDER,
        body: NOT_SENT,
      },
    ]);
    await app.close();
  });

  it("refuses a malformed request before the service runs: a bad order id, an unknown outcome, a short or missing reason, a bad prescription id, an extra field", async () => {
    const { app, calls } = makeServer();
    const post = (url: string, payload: object) =>
      app.inject({ method: "POST", url, headers: { ...ADMIN, ...idem() }, payload });
    expect((await post(URL_OF("not-a-uuid"), SENT)).statusCode).toBe(422);
    for (const bad of [
      { ...SENT, outcome: "maybe" },
      { ...SENT, reason: "too short" },
      { ...SENT, reason: "          " }, // ten spaces: long enough, says nothing
      { ...SENT, reason: "\n\t \n\t \n\t \n\t " },
      { outcome: "sent", dosespotPrescriptionId: "9001" },
      { ...SENT, dosespotPrescriptionId: "has spaces" },
      { ...SENT, dosespotPrescriptionId: "x".repeat(65) },
      { ...NOT_SENT, organizationId: "someone-else" },
      { ...NOT_SENT, membershipId: "99999999-9999-4999-8999-999999999999" },
      {},
    ]) {
      expect((await post(URL_OF(ORDER), bad)).statusCode, JSON.stringify(bad)).toBe(422);
    }
    expect(calls).toEqual([]);
    await app.close();
  });
});
