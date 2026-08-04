// apps/backend/__tests__/evv-inject.test.ts — M18 (Electronic Visit Verification) §4.1 HTTP-layer smoke suite
// (TASK-050A / TEST-001). Closes the module's ZERO `.inject()` coverage: the existing M18 tests
// (evv-aggregator.test.ts, evv-event-lifecycle.test.ts, evv-geofence.test.ts, evv-missing-resolution.test.ts,
// evv-seams.test.ts, evv-workflow-acceptance.test.ts, m18-evv-*.live.test.ts) exercise pure domain logic or a
// real Postgres — none drive a request through the FULL M1 middleware chain (auth → RBAC → ABAC → TypeBox →
// handler), so a mis-wired guard/schema/service binding on a route is invisible to them.
//
// Cloned from `orders-routes.test.ts` (the M11-T06 reference): `buildServer()` mounts the host,
// `registerEvvRoutes()` mounts the §4.1 route inventory over the in-memory `EvvRouteService`. The REAL
// Authorization Contract gates every route on the §4.6 `M18_CONTRIBUTED_PERMISSIONS` keys; a header-auth shim
// populates `request.context`. The two §4.7 ABAC predicates M18 owns (`assigned_clinician_for_visit` /
// `evv_within_visit_window`) are built over the SAME in-memory backend via `buildEvvAbacPredicates` and
// registered into the shared ABAC registry, exactly as `buildOrderAbacPredicates` does for M11.
import {
  createInMemoryEffectivePermissionStore,
  createPredicateRegistry,
  registerAbacRegistry,
  registerEffectivePermissionResolver,
  resetAbacRegistry,
  resetAuthorizationContract,
  resetRbacEngine,
} from "@wardenx/auth";
import type { FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import {
  buildEvvAbacPredicates,
  EvvRouteService,
  registerEvvRoutes,
} from "../src/modules/18-evv/index";

function headerAuth(request: FastifyRequest): void {
  const user = request.headers["x-test-user"];
  if (typeof user !== "string" || user.length === 0) return;
  request.context.userId = user;
  const org = request.headers["x-test-org"];
  request.context.organizationId = typeof org === "string" ? org : "";
  const roles = request.headers["x-test-roles"];
  request.context.roles = typeof roles === "string" && roles.length > 0 ? roles.split(",") : [];
}

const ORG = "org_a";
const PATIENT = "11111111-1111-4111-8111-111111111111";
const VISIT_1 = "22222222-2222-4222-8222-222222222222";
const DEVICE_UUID = "33333333-3333-4333-8333-333333333333";
const ATTESTATION_UUID = "44444444-4444-4444-8444-444444444444";
const RESOLUTION_ATTEST = "55555555-5555-4555-8555-555555555555";
const RESOLUTION_OVERRIDE = "66666666-6666-4666-8666-666666666666";
const SUBMISSION_PENDING = "77777777-7777-4777-8777-777777777777";
const SUBMISSION_REJECTED = "88888888-8888-4888-8888-888888888888";
const PATIENT_ADDRESS = "99999999-9999-4999-8999-999999999999";
const STEP_UP_REF = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

// The visit's scheduled window (§4.7 `evv_within_visit_window`); capture instants below are chosen to fall
// inside the default 2h-before / 4h-after policy relative to these.
const VISIT_START = "2026-06-08T12:00:00.000Z";
const VISIT_END = "2026-06-08T13:00:00.000Z";
const CHECK_IN_AT = "2026-06-08T12:00:00.000Z";
const CHECK_OUT_AT = "2026-06-08T13:30:00.000Z";

// §7.3/§7.4 windows are wall-clock (`Date.now()`-relative, not the fixed VISIT_START/END above) — seed the two
// missing-resolution rows relative to the REAL current time so the 24h self-attest / 7d supervisor-override
// guards legitimately pass.
const CHECK_IN_RECENT = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // 1h ago
const VISIT_DATE_RECENT = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(); // 1 day ago

const CLINICIAN = { "x-test-user": "rn_1", "x-test-org": ORG, "x-test-roles": "rn_field" };
const SUPERVISOR = { "x-test-user": "sup_1", "x-test-org": ORG, "x-test-roles": "clinical_supervisor" };
const SUPERVISOR_STEPUP = { ...SUPERVISOR, "x-step-up": "fresh" };
const PORTAL = { "x-test-user": "portal_1", "x-test-org": ORG, "x-test-roles": "family_caregiver" };
const VIEWER = { "x-test-user": "viewer_1", "x-test-org": ORG, "x-test-roles": "auditor" };

const CLINICIAN_PERMS = ["evv.check_in", "evv.check_out", "evv.device.register_self", "evv.missing_resolution.attest_self"];
const SUPERVISOR_PERMS = [
  "evv.read",
  "evv.correct_record",
  "evv.device.read",
  "evv.device.approve",
  "evv.device.suspend",
  "evv.device.retire",
  "evv.policy.read",
  "evv.policy.edit",
  "evv.missing_resolution.read",
  "evv.missing_resolution.supervisor_override",
  "evv.aggregator.read",
  "evv.aggregator.resubmit",
  "evv.aggregator.cancel",
  "evv.read_metrics",
  "evv.location.read_team",
];
const PORTAL_PERMS = ["portal.evv.read_arrival"];

/**
 * The in-memory `EvvRouteService` mints friendly sequential ids (`"evvdev-00000001"`, `"evvevt-00000001"` —
 * see its private `idMinter` helper) for tests that only assert on the shape of the response. But the
 * device-lifecycle (`:id/approve|reject|suspend|retire`) and event-read (`:eventId`) route PARAMS declare
 * `format: "uuid"` (matching the production Drizzle backend, which mints real uuids) — so a self-registered
 * device / recorded event's own id can never round-trip through those routes' TypeBox param schema. Rebind
 * the two private id-minting closures to uuid-shaped output so this suite can drive a REAL create → read/act
 * round trip through those routes instead of skipping them; nothing about route or service LOGIC changes,
 * only the id-generator's output shape (a cast, not an `any`, since the private fields aren't nameable from
 * here). This is itself a real finding: the in-memory fixture's default id scheme cannot exercise these
 * routes at all out of the box (see the test-report deviation note).
 */
function withUuidIds(backend: EvvRouteService): EvvRouteService {
  let eventN = 0;
  let deviceN = 0;
  const mutable = backend as unknown as { nextEventId: () => string; nextDeviceId: () => string };
  mutable.nextEventId = () => `eeeeeeee-eeee-4eee-8eee-${(++eventN).toString().padStart(12, "0")}`;
  mutable.nextDeviceId = () => `dddddddd-dddd-4ddd-8ddd-${(++deviceN).toString().padStart(12, "0")}`;
  return backend;
}

function makeServer() {
  const backend = withUuidIds(new EvvRouteService({
    visits: [
      {
        organizationId: ORG,
        visitId: VISIT_1,
        patientId: PATIENT,
        assignedMembershipId: "rn_1",
        scheduledStartedAt: VISIT_START,
        scheduledEndedAt: VISIT_END,
      },
    ],
    submissions: [
      { organizationId: ORG, id: SUBMISSION_PENDING, visitId: VISIT_1, stateCode: "PA", aggregatorVendor: "sandata", status: "pending" },
      { organizationId: ORG, id: SUBMISSION_REJECTED, visitId: VISIT_1, stateCode: "PA", aggregatorVendor: "sandata", status: "rejected" },
    ],
    resolutions: [
      { organizationId: ORG, id: RESOLUTION_ATTEST, visitId: VISIT_1, kind: "missing_checkin", status: "open", checkInAt: CHECK_IN_RECENT },
      { organizationId: ORG, id: RESOLUTION_OVERRIDE, visitId: VISIT_1, kind: "missing_checkout", status: "open", visitDate: VISIT_DATE_RECENT },
    ],
  }));

  const grantStore = createInMemoryEffectivePermissionStore([
    { orgId: ORG, userId: "rn_1", grants: [{ roleKey: "seed", enabled: true, expiresAt: null, permissionKeys: CLINICIAN_PERMS }] },
    { orgId: ORG, userId: "sup_1", grants: [{ roleKey: "seed", enabled: true, expiresAt: null, permissionKeys: SUPERVISOR_PERMS }] },
    { orgId: ORG, userId: "portal_1", grants: [{ roleKey: "seed", enabled: true, expiresAt: null, permissionKeys: PORTAL_PERMS }] },
    { orgId: ORG, userId: "viewer_1", grants: [{ roleKey: "seed", enabled: true, expiresAt: null, permissionKeys: [] }] },
  ]);
  registerEffectivePermissionResolver(grantStore.store);

  // A FRESH predicate registry per server — the shared `abacRegistry` would otherwise persist a predicate
  // closed over a prior test's backend across the file (the boot path binds once via `registerEvvAbacPredicates`).
  const reg = createPredicateRegistry();
  for (const [name, predicate] of Object.entries(buildEvvAbacPredicates({ resolver: backend }))) {
    reg.register(name, predicate);
  }
  registerAbacRegistry(reg);

  const app = buildServer({ authenticate: headerAuth, security: { rateLimitEnabled: false } });
  registerEvvRoutes(app, { service: backend });
  return { app, backend };
}

const checkInBody = (over: Record<string, unknown> = {}) => ({
  visitId: VISIT_1,
  serviceTypeCode: "routine_visit",
  capturedAt: CHECK_IN_AT,
  coords: { lat: 40.0, lng: -75.0 },
  accuracyM: 10,
  evvDeviceId: DEVICE_UUID,
  expectedAttestationId: ATTESTATION_UUID,
  ...over,
});
const checkOutBody = (over: Record<string, unknown> = {}) => ({
  visitId: VISIT_1,
  capturedAt: CHECK_OUT_AT,
  coords: { lat: 40.0, lng: -75.0 },
  accuracyM: 10,
  evvDeviceId: DEVICE_UUID,
  expectedAttestationId: ATTESTATION_UUID,
  ...over,
});

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

describe("M18 EVV inject smoke — auth/RBAC/validation envelope", () => {
  it("401 — no auth headers at all", async () => {
    const { app } = makeServer();
    const res = await app.inject({ method: "GET", url: "/api/v1/evv/events" });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("403 — a permission-gated route with a user holding NO permissions", async () => {
    const { app } = makeServer();
    const res = await app.inject({ method: "GET", url: "/api/v1/evv/events", headers: VIEWER });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("422 — an invalid/empty payload from a correctly-permissioned caller", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "PATCH",
      url: "/api/v1/evv/geofence-policy/tenant",
      headers: SUPERVISOR,
      payload: {},
    });
    expect(res.statusCode).toBe(422);
    await app.close();
  });
});

describe("§4.1 routes 1-7 — capture + event reads", () => {
  it("1: POST /evv/check-in — 201 (§4.7 predicates pass: assigned clinician, within window)", async () => {
    const { app } = makeServer();
    const res = await app.inject({ method: "POST", url: "/api/v1/evv/check-in", headers: CLINICIAN, payload: checkInBody() });
    expect(res.statusCode).toBe(201);
    expect(res.json().kind).toBe("check_in");
    await app.close();
  });

  it("2: POST /evv/check-out — 201", async () => {
    const { app } = makeServer();
    const res = await app.inject({ method: "POST", url: "/api/v1/evv/check-out", headers: CLINICIAN, payload: checkOutBody() });
    expect(res.statusCode).toBe(201);
    expect(res.json().kind).toBe("check_out");
    await app.close();
  });

  it("3: POST /evv/offline-sync — 200, one recorded event per batch item", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/evv/offline-sync",
      headers: CLINICIAN,
      payload: { evvDeviceId: DEVICE_UUID, events: [{ kind: "check_in", ...checkInBody() }] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveLength(1);
    await app.close();
  });

  it("4: GET /evv/events/:eventId — 200", async () => {
    const { app } = makeServer();
    const ci = await app.inject({ method: "POST", url: "/api/v1/evv/check-in", headers: CLINICIAN, payload: checkInBody() });
    const eventId = ci.json().eventId as string;
    const res = await app.inject({ method: "GET", url: `/api/v1/evv/events/${eventId}`, headers: SUPERVISOR });
    expect(res.statusCode).toBe(200);
    expect(res.json().id).toBe(eventId);
    await app.close();
  });

  it("5: GET /evv/events — 200 list", async () => {
    const { app } = makeServer();
    await app.inject({ method: "POST", url: "/api/v1/evv/check-in", headers: CLINICIAN, payload: checkInBody() });
    const res = await app.inject({ method: "GET", url: "/api/v1/evv/events", headers: SUPERVISOR });
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.json())).toBe(true);
    await app.close();
  });

  it("6: POST /evv/events/:eventId/correct — 200 (Clinical Supervisor, fresh step-up)", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/evv/events/00000000-0000-4000-8000-000000000000/correct",
      headers: SUPERVISOR_STEPUP,
      payload: { newEvent: checkInBody(), correctionReason: "x".repeat(60) },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().kind).toBe("check_in");
    await app.close();
  });

  it("7: GET /evv/visits/:visitId/bracket — 200", async () => {
    const { app } = makeServer();
    const res = await app.inject({ method: "GET", url: `/api/v1/evv/visits/${VISIT_1}/bracket`, headers: SUPERVISOR });
    expect(res.statusCode).toBe(200);
    expect(res.json().visitId).toBe(VISIT_1);
    await app.close();
  });
});

describe("§4.1 routes 8-13 — device lifecycle", () => {
  it("8: GET /evv/devices — 200", async () => {
    const { app } = makeServer();
    const res = await app.inject({ method: "GET", url: "/api/v1/evv/devices", headers: SUPERVISOR });
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.json())).toBe(true);
    await app.close();
  });

  it("9: POST /evv/devices/self-register — 201", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/evv/devices/self-register",
      headers: CLINICIAN,
      payload: { platform: "ios", modelDescription: "iPhone 14", attestationId: ATTESTATION_UUID },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().status).toBe("pending_approval");
    await app.close();
  });

  it("10: POST /evv/devices/:id/approve — 200", async () => {
    const { app } = makeServer();
    const reg = await app.inject({
      method: "POST",
      url: "/api/v1/evv/devices/self-register",
      headers: CLINICIAN,
      payload: { platform: "ios", modelDescription: "iPhone 14", attestationId: ATTESTATION_UUID },
    });
    const id = reg.json().id as string;
    const res = await app.inject({ method: "POST", url: `/api/v1/evv/devices/${id}/approve`, headers: SUPERVISOR });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("approved");
    await app.close();
  });

  it("11: POST /evv/devices/:id/reject — 200", async () => {
    const { app } = makeServer();
    const reg = await app.inject({
      method: "POST",
      url: "/api/v1/evv/devices/self-register",
      headers: CLINICIAN,
      payload: { platform: "android", modelDescription: "Pixel 8", attestationId: ATTESTATION_UUID },
    });
    const id = reg.json().id as string;
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/evv/devices/${id}/reject`,
      headers: SUPERVISOR,
      payload: { reason: "unrecognized device model" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("rejected");
    await app.close();
  });

  it("12: POST /evv/devices/:id/suspend — 200", async () => {
    const { app } = makeServer();
    const reg = await app.inject({
      method: "POST",
      url: "/api/v1/evv/devices/self-register",
      headers: CLINICIAN,
      payload: { platform: "ios", modelDescription: "iPhone 15", attestationId: ATTESTATION_UUID },
    });
    const id = reg.json().id as string;
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/evv/devices/${id}/suspend`,
      headers: SUPERVISOR,
      payload: { reason: "integrity check failed" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("suspended");
    await app.close();
  });

  it("13: POST /evv/devices/:id/retire — 200", async () => {
    const { app } = makeServer();
    const reg = await app.inject({
      method: "POST",
      url: "/api/v1/evv/devices/self-register",
      headers: CLINICIAN,
      payload: { platform: "android", modelDescription: "Pixel 7", attestationId: ATTESTATION_UUID },
    });
    const id = reg.json().id as string;
    const res = await app.inject({ method: "POST", url: `/api/v1/evv/devices/${id}/retire`, headers: SUPERVISOR, payload: {} });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("retired");
    await app.close();
  });
});

describe("§4.1 routes 14-16 — geofence policy", () => {
  it("14: GET /evv/geofence-policy — 200", async () => {
    const { app } = makeServer();
    const res = await app.inject({ method: "GET", url: "/api/v1/evv/geofence-policy", headers: SUPERVISOR });
    expect(res.statusCode).toBe(200);
    expect(res.json().tenant.radiusM).toBe(200);
    await app.close();
  });

  it("15: PATCH /evv/geofence-policy/tenant — 200 (tighten-only, within the platform floor)", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "PATCH",
      url: "/api/v1/evv/geofence-policy/tenant",
      headers: SUPERVISOR,
      payload: { radiusM: 100, maxAccuracyM: 30 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().tenant.radiusM).toBe(100);
    await app.close();
  });

  it("16: POST /evv/geofence-policy/per-address — 201", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/evv/geofence-policy/per-address",
      headers: SUPERVISOR,
      payload: { patientAddressId: PATIENT_ADDRESS, radiusM: 100, maxAccuracyM: 20, overrideReason: "x".repeat(30) },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().perAddress).toHaveLength(1);
    await app.close();
  });
});

describe("§4.1 routes 17-19 — missing-EVV resolution (§2.2.4 D6)", () => {
  it("17: GET /evv/missing-resolutions — 200 list", async () => {
    const { app } = makeServer();
    const res = await app.inject({ method: "GET", url: "/api/v1/evv/missing-resolutions", headers: SUPERVISOR });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveLength(2);
    await app.close();
  });

  it("18: POST /evv/missing-resolutions/:id/clinician-attest — 200 (assigned clinician, ≤24h, reason ≥40)", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/evv/missing-resolutions/${RESOLUTION_ATTEST}/clinician-attest`,
      headers: CLINICIAN,
      payload: { reason: "x".repeat(40) },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("closed_clinician_attested");
    await app.close();
  });

  it("19: POST /evv/missing-resolutions/:id/supervisor-override — 200 (step-up, ≤7d, reason ≥60)", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/evv/missing-resolutions/${RESOLUTION_OVERRIDE}/supervisor-override`,
      headers: SUPERVISOR_STEPUP,
      payload: { reason: "x".repeat(60), stepUpAuthRefId: STEP_UP_REF },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("closed_supervisor_override");
    await app.close();
  });
});

describe("§4.1 routes 20-22 — aggregator submissions (§2.2.5 D7)", () => {
  it("20: GET /evv/aggregator-submissions — 200 list", async () => {
    const { app } = makeServer();
    const res = await app.inject({ method: "GET", url: "/api/v1/evv/aggregator-submissions", headers: SUPERVISOR });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveLength(2);
    await app.close();
  });

  it("21: POST /evv/aggregator-submissions/:id/resubmit — 200 (valid from 'rejected')", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/evv/aggregator-submissions/${SUBMISSION_REJECTED}/resubmit`,
      headers: SUPERVISOR,
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("queued");
    await app.close();
  });

  it("22: POST /evv/aggregator-submissions/:id/cancel — 200 (valid from a non-terminal status)", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/evv/aggregator-submissions/${SUBMISSION_PENDING}/cancel`,
      headers: SUPERVISOR,
      payload: { reason: "duplicate submission" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("cancelled");
    await app.close();
  });
});

describe("§4.1 routes 23-25 — metrics, team location, portal arrival", () => {
  it("23: GET /evv/metrics — 200", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/evv/metrics?from=2026-06-01T00:00:00.000Z&to=2026-06-30T00:00:00.000Z",
      headers: SUPERVISOR,
    });
    expect(res.statusCode).toBe(200);
    expect(typeof res.json().complianceRate).toBe("number");
    await app.close();
  });

  it("24: GET /evv/clinician-current-location — 200", async () => {
    const { app } = makeServer();
    await app.inject({ method: "POST", url: "/api/v1/evv/check-in", headers: CLINICIAN, payload: checkInBody() });
    const res = await app.inject({ method: "GET", url: "/api/v1/evv/clinician-current-location", headers: SUPERVISOR });
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.json())).toBe(true);
    await app.close();
  });

  it("25: GET /portal/visits/:visitId/arrival — 200 (portal session class)", async () => {
    const { app } = makeServer();
    await app.inject({ method: "POST", url: "/api/v1/evv/check-in", headers: CLINICIAN, payload: checkInBody() });
    const res = await app.inject({ method: "GET", url: `/api/v1/portal/visits/${VISIT_1}/arrival`, headers: PORTAL });
    expect(res.statusCode).toBe(200);
    expect(res.json().visitId).toBe(VISIT_1);
    expect(res.json().arrivedAt).not.toBeNull();
    await app.close();
  });
});
