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
  DEVICE_ATTESTATION_ATTRIBUTE,
  createInMemoryEffectivePermissionStore,
  createInMemorySessionContextStore,
  createPredicateRegistry,
  createSessionContextResolver,
  registerAbacRegistry,
  registerEffectivePermissionResolver,
  resetAbacRegistry,
  resetAuthorizationContract,
  resetRbacEngine,
} from "@wardenx/auth";
import type { FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import { __resetSeamsForTest, registerSeam } from "../src/bootstrap/seams/registry";
import {
  type EvvRoutePort,
  EvvRouteService,
  buildEvvAbacPredicates,
  registerEvvRoutes,
} from "../src/modules/18-evv/index";

function headerAuth(request: FastifyRequest): void {
  const user = request.headers["x-test-user"];
  if (typeof user !== "string" || user.length === 0) return;
  request.context.userId = user;
  // evv-routes.ts's actorOf() reads the acting MEMBERSHIP id from here (not ctx.userId).
  request.context.attributes.membershipId = user;
  const org = request.headers["x-test-org"];
  request.context.organizationId = typeof org === "string" ? org : "";
  const roles = request.headers["x-test-roles"];
  request.context.roles = typeof roles === "string" && roles.length > 0 ? roles.split(",") : [];
  const pinnedPatient = request.headers["x-test-session-patient"];
  if (typeof pinnedPatient === "string" && pinnedPatient.length > 0)
    request.context.attributes.sessionPatientId = pinnedPatient;
  // F-028 — the §2.3 correction and the D6 supervisor override used to take their step-up from
  // `request.headers["x-step-up"]`, a string the gated caller supplies. They resolve the REAL session
  // through M2's `SessionContextResolver` seam now, so the shim stamps a session id the way the
  // production authenticate hook does and the seam stub decides freshness.
  // GAP-055 — the production authenticate hook stamps the session-bound attestation verdict; the shim does
  // so only when the test asks (`x-test-attested: valid`), so an un-attested caller is the default shape.
  if (request.headers["x-test-attested"] === "valid")
    request.context.attributes[DEVICE_ATTESTATION_ATTRIBUTE] = {
      valid: true,
      attestationId: `att-${user}`,
    };
  const session = request.headers["x-test-session"];
  if (typeof session === "string" && session.length > 0)
    request.context.attributes.sessionId = session;
}

const ORG = "org_a";
const PATIENT = "11111111-1111-4111-8111-111111111111";
const VISIT_1 = "22222222-2222-4222-8222-222222222222";
const VISIT_OTHER = "22222222-2222-4222-8222-222222222299"; // assigned to rn_2, not rn_1
const DEVICE_UUID = "33333333-3333-4333-8333-333333333333";
const DEVICE_UUID_NEWER = "33333333-3333-4333-8333-333333333344";
const DEVICE_UUID_IN_ONLY = "33333333-3333-4333-8333-333333333399";
const RESOLUTION_ATTEST = "55555555-5555-4555-8555-555555555555";
const RESOLUTION_OVERRIDE = "66666666-6666-4666-8666-666666666666";
const SUBMISSION_PENDING = "77777777-7777-4777-8777-777777777777";
const SUBMISSION_REJECTED = "88888888-8888-4888-8888-888888888888";
const PATIENT_ADDRESS = "99999999-9999-4999-8999-999999999999";

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

const CLINICIAN_UNATTESTED = {
  "x-test-user": "rn_1",
  "x-test-org": ORG,
  "x-test-roles": "rn_field",
};
const CLINICIAN = { ...CLINICIAN_UNATTESTED, "x-test-attested": "valid" };
// Holds `evv.check_in` only (no `evv.check_out`), on an attested device.
const CHECKIN_ONLY = {
  "x-test-user": "rn_in_only",
  "x-test-org": ORG,
  "x-test-roles": "rn_field",
  "x-test-attested": "valid",
};
const SUPERVISOR = {
  "x-test-user": "sup_1",
  "x-test-org": ORG,
  "x-test-roles": "clinical_supervisor",
};
// A supervisor whose REAL session stepped up 30s ago (inside the `STEP_UP_POLICY` 300s window), and
// one whose last step-up was a day ago. Nothing but the session distinguishes them.
const SESSION_FRESH = "sess_fresh";
const SESSION_STALE = "sess_stale";
const SUPERVISOR_STEPUP = { ...SUPERVISOR, "x-test-session": SESSION_FRESH };
const SUPERVISOR_STALE = { ...SUPERVISOR, "x-test-session": SESSION_STALE };

/** Register the real `SessionContextResolver` seam over an in-memory store holding both sessions. */
function registerStepUpSeam(): void {
  const base = {
    userId: "sup_1",
    membershipId: "sup_1",
    organizationId: ORG,
    roles: ["clinical_supervisor"],
    providerEntityIds: [] as string[],
    locationIds: [] as string[],
  };
  registerSeam(
    "SessionContextResolver",
    createSessionContextResolver(
      createInMemorySessionContextStore([
        {
          sessionClass: "staff",
          portalAccountId: null,
          sessionPatientId: null,
          ...base,
          sessionId: SESSION_FRESH,
          lastStepUpAt: new Date(Date.now() - 30_000),
          lastStepUpFactor: "totp",
        },
        {
          sessionClass: "staff",
          portalAccountId: null,
          sessionPatientId: null,
          ...base,
          sessionId: SESSION_STALE,
          lastStepUpAt: new Date(Date.now() - 86_400_000),
          lastStepUpFactor: "totp",
        },
      ]).store,
    ),
  );
}
const PORTAL = { "x-test-user": "portal_1", "x-test-org": ORG, "x-test-roles": "family_caregiver" };
const VIEWER = { "x-test-user": "viewer_1", "x-test-org": ORG, "x-test-roles": "auditor" };

const CLINICIAN_PERMS = [
  "evv.check_in",
  "evv.check_out",
  "evv.device.register_self",
  "evv.missing_resolution.attest_self",
];
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
  mutable.nextDeviceId = () =>
    `dddddddd-dddd-4ddd-8ddd-${(++deviceN).toString().padStart(12, "0")}`;
  return backend;
}

/** `deviceAttestationEnforced` defaults to TRUE here so the GAP-055 suites below keep exercising the enforced
 * contract; the production default is OFF (see the "NOT enforced" suite at the bottom). */
function makeServer(service?: EvvRoutePort, deviceAttestationEnforced = true) {
  const backend = withUuidIds(
    new EvvRouteService(
      {
        visits: [
          {
            organizationId: ORG,
            visitId: VISIT_1,
            patientId: PATIENT,
            assignedMembershipId: "rn_1",
            scheduledStartedAt: VISIT_START,
            scheduledEndedAt: VISIT_END,
          },
          {
            organizationId: ORG,
            visitId: VISIT_OTHER,
            patientId: PATIENT,
            assignedMembershipId: "rn_2",
            scheduledStartedAt: VISIT_START,
            scheduledEndedAt: VISIT_END,
          },
        ],
        // The session-bound device (GAP-055 follow-up): each attested clinician's session attestation
        // (`att-<user>`, stamped by the shim) is bound to one approved device of theirs.
        devices: [
          {
            organizationId: ORG,
            id: DEVICE_UUID,
            membershipId: "rn_1",
            status: "approved",
            attestationId: "att-rn_1",
          },
          {
            // A NEWER approved device of rn_1 (no attestation): flag OFF resolves to it by default, while a
            // claim naming the older DEVICE_UUID must still be accepted.
            organizationId: ORG,
            id: DEVICE_UUID_NEWER,
            membershipId: "rn_1",
            status: "approved",
            attestationId: null,
          },
          {
            organizationId: ORG,
            id: DEVICE_UUID_IN_ONLY,
            membershipId: "rn_in_only",
            status: "approved",
            attestationId: "att-rn_in_only",
          },
        ],
        submissions: [
          {
            organizationId: ORG,
            id: SUBMISSION_PENDING,
            visitId: VISIT_1,
            stateCode: "PA",
            aggregatorVendor: "sandata",
            status: "pending",
          },
          {
            organizationId: ORG,
            id: SUBMISSION_REJECTED,
            visitId: VISIT_1,
            stateCode: "PA",
            aggregatorVendor: "sandata",
            status: "rejected",
          },
        ],
        resolutions: [
          {
            organizationId: ORG,
            id: RESOLUTION_ATTEST,
            visitId: VISIT_1,
            kind: "missing_checkin",
            status: "open",
            checkInAt: CHECK_IN_RECENT,
          },
          {
            organizationId: ORG,
            id: RESOLUTION_OVERRIDE,
            visitId: VISIT_1,
            kind: "missing_checkout",
            status: "open",
            visitDate: VISIT_DATE_RECENT,
          },
        ],
      },
      { deviceAttestationEnforced },
    ),
  );

  const grantStore = createInMemoryEffectivePermissionStore([
    {
      orgId: ORG,
      userId: "rn_1",
      grants: [
        { roleKey: "seed", enabled: true, expiresAt: null, permissionKeys: CLINICIAN_PERMS },
      ],
    },
    {
      orgId: ORG,
      userId: "rn_in_only",
      grants: [
        { roleKey: "seed", enabled: true, expiresAt: null, permissionKeys: ["evv.check_in"] },
      ],
    },
    {
      orgId: ORG,
      userId: "sup_1",
      grants: [
        { roleKey: "seed", enabled: true, expiresAt: null, permissionKeys: SUPERVISOR_PERMS },
      ],
    },
    {
      orgId: ORG,
      userId: "portal_1",
      grants: [{ roleKey: "seed", enabled: true, expiresAt: null, permissionKeys: PORTAL_PERMS }],
    },
    {
      orgId: ORG,
      userId: "viewer_1",
      grants: [{ roleKey: "seed", enabled: true, expiresAt: null, permissionKeys: [] }],
    },
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
  registerEvvRoutes(app, { service: service ?? backend, deviceAttestationEnforced });
  return { app, backend };
}

const checkInBody = (over: Record<string, unknown> = {}) => ({
  visitId: VISIT_1,
  serviceTypeCode: "routine_visit",
  capturedAt: CHECK_IN_AT,
  coords: { lat: 40.0, lng: -75.0 },
  accuracyM: 10,
  evvDeviceId: DEVICE_UUID,
  ...over,
});
const checkOutBody = (over: Record<string, unknown> = {}) => ({
  visitId: VISIT_1,
  capturedAt: CHECK_OUT_AT,
  coords: { lat: 40.0, lng: -75.0 },
  accuracyM: 10,
  evvDeviceId: DEVICE_UUID,
  ...over,
});

beforeEach(() => {
  resetAuthorizationContract();
  resetRbacEngine();
  resetAbacRegistry();
  __resetSeamsForTest();
  registerStepUpSeam();
});
afterEach(() => {
  resetAuthorizationContract();
  resetRbacEngine();
  resetAbacRegistry();
  __resetSeamsForTest();
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
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/evv/check-in",
      headers: CLINICIAN,
      payload: checkInBody(),
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().kind).toBe("check_in");
    await app.close();
  });

  it("2: POST /evv/check-out — 201", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/evv/check-out",
      headers: CLINICIAN,
      payload: checkOutBody(),
    });
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
    const ci = await app.inject({
      method: "POST",
      url: "/api/v1/evv/check-in",
      headers: CLINICIAN,
      payload: checkInBody(),
    });
    const eventId = ci.json().eventId as string;
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/evv/events/${eventId}`,
      headers: SUPERVISOR,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().id).toBe(eventId);
    await app.close();
  });

  it("5: GET /evv/events — 200 list", async () => {
    const { app } = makeServer();
    await app.inject({
      method: "POST",
      url: "/api/v1/evv/check-in",
      headers: CLINICIAN,
      payload: checkInBody(),
    });
    const res = await app.inject({ method: "GET", url: "/api/v1/evv/events", headers: SUPERVISOR });
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.json())).toBe(true);
    await app.close();
  });

  it("6: POST /evv/events/:eventId/correct — 200 (Clinical Supervisor, fresh step-up)", async () => {
    const { app } = makeServer();
    // This used to target `00000000-…-000000000000` — an event that has never existed — and assert 200,
    // which was true only because the route recorded an unrelated new capture and ignored the id
    // entirely (F-068 §1). A correction now needs something to correct.
    const original = await app.inject({
      method: "POST",
      url: "/api/v1/evv/check-in",
      headers: CLINICIAN,
      payload: checkInBody(),
    });
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/evv/events/${original.json().eventId}/correct`,
      headers: SUPERVISOR_STEPUP,
      payload: { newEvent: checkInBody(), correctionReason: "x".repeat(60) },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().kind).toBe("check_in");
    await app.close();
  });

  it("7: GET /evv/visits/:visitId/bracket — 200", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/evv/visits/${VISIT_1}/bracket`,
      headers: SUPERVISOR,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().visitId).toBe(VISIT_1);
    await app.close();
  });
});

describe("§4.1 routes 8-13 — device lifecycle", () => {
  it("8: GET /evv/devices — 200", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/evv/devices",
      headers: SUPERVISOR,
    });
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
      payload: { platform: "ios", modelDescription: "iPhone 14" },
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
      payload: { platform: "ios", modelDescription: "iPhone 14" },
    });
    const id = reg.json().id as string;
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/evv/devices/${id}/approve`,
      headers: SUPERVISOR,
    });
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
      payload: {
        platform: "android",
        modelDescription: "Pixel 8",
      },
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
      payload: { platform: "ios", modelDescription: "iPhone 15" },
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
      payload: {
        platform: "android",
        modelDescription: "Pixel 7",
      },
    });
    const id = reg.json().id as string;
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/evv/devices/${id}/retire`,
      headers: SUPERVISOR,
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("retired");
    await app.close();
  });
});

describe("§4.1 routes 14-16 — geofence policy", () => {
  it("14: GET /evv/geofence-policy — 200", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/evv/geofence-policy",
      headers: SUPERVISOR,
    });
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
      payload: {
        patientAddressId: PATIENT_ADDRESS,
        radiusM: 100,
        maxAccuracyM: 20,
        overrideReason: "x".repeat(30),
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().perAddress).toHaveLength(1);
    await app.close();
  });
});

describe("§4.1 routes 17-19 — missing-EVV resolution (§2.2.4 D6)", () => {
  it("17: GET /evv/missing-resolutions — 200 list", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/evv/missing-resolutions",
      headers: SUPERVISOR,
    });
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
      payload: { reason: "x".repeat(60) },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("closed_supervisor_override");
    await app.close();
  });
});

describe("§4.1 routes 20-22 — aggregator submissions (§2.2.5 D7)", () => {
  it("20: GET /evv/aggregator-submissions — 200 list", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/evv/aggregator-submissions",
      headers: SUPERVISOR,
    });
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
    await app.inject({
      method: "POST",
      url: "/api/v1/evv/check-in",
      headers: CLINICIAN,
      payload: checkInBody(),
    });
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/evv/clinician-current-location",
      headers: SUPERVISOR,
    });
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.json())).toBe(true);
    await app.close();
  });

  it("25: GET /portal/visits/:visitId/arrival — 200 (portal session class)", async () => {
    const { app } = makeServer();
    await app.inject({
      method: "POST",
      url: "/api/v1/evv/check-in",
      headers: CLINICIAN,
      payload: checkInBody(),
    });
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/portal/visits/${VISIT_1}/arrival`,
      headers: { ...PORTAL, "x-test-session-patient": PATIENT },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().visitId).toBe(VISIT_1);
    expect(res.json().arrivedAt).not.toBeNull();

    // GAP-132 — another patient's portal session must not learn this visit's arrival; an unpinned one is a 404.
    const other = await app.inject({
      method: "GET",
      url: `/api/v1/portal/visits/${VISIT_1}/arrival`,
      headers: { ...PORTAL, "x-test-session-patient": "99999999-9999-4999-8999-999999999999" },
    });
    expect(other.statusCode).toBe(200);
    expect(other.json().arrivedAt).toBeNull();
    const unpinned = await app.inject({
      method: "GET",
      url: `/api/v1/portal/visits/${VISIT_1}/arrival`,
      headers: PORTAL,
    });
    expect(unpinned.statusCode).toBe(404);
    await app.close();
  });
});

describe("F-028 — the §2.3 / D6 step-up is server-verified, not client-asserted", () => {
  // Both routes used to decide step-up from `request.headers["x-step-up"]`. Each case sends exactly
  // that header — the request that USED to succeed — from a session whose real last step-up is a day
  // old, and asserts the route now refuses. Then the same request with a fresh real session succeeds,
  // so the tests pin the gate to the session rather than merely proving the routes deny.

  it("correction-of-record: a stale session sending `x-step-up: fresh` is refused (403)", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/evv/events/00000000-0000-4000-8000-000000000000/correct",
      headers: { ...SUPERVISOR_STALE, "x-step-up": "fresh" },
      payload: { newEvent: checkInBody(), correctionReason: "x".repeat(60) },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("correction-of-record: a session with no step-up at all is refused, header or not", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/evv/events/00000000-0000-4000-8000-000000000000/correct",
      headers: { ...SUPERVISOR, "x-step-up": "fresh" }, // no `x-test-session` ⇒ no session id
      payload: { newEvent: checkInBody(), correctionReason: "x".repeat(60) },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("supervisor override: a stale session sending `x-step-up: fresh` is refused", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/evv/missing-resolutions/${RESOLUTION_OVERRIDE}/supervisor-override`,
      headers: { ...SUPERVISOR_STALE, "x-step-up": "fresh" },
      payload: { reason: "x".repeat(60) },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("EVV_SUPERVISOR_OVERRIDE_STEP_UP_REQUIRED");
    await app.close();
  });

  it("supervisor override: the same request with a fresh real session succeeds (no header sent)", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/evv/missing-resolutions/${RESOLUTION_OVERRIDE}/supervisor-override`,
      headers: SUPERVISOR_STEPUP,
      payload: { reason: "x".repeat(60) },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("closed_supervisor_override");
    await app.close();
  });
});

// ── F-068 · the write paths validate a justification and drop it ────────────────────────────────────
//
// Four of these assert on a PARAMETER being passed, not on a type. That is deliberate: `EvvRoutePort`
// replaced the `as unknown as EvvRouteService` cast in `createDbEvvBackend` and now catches a missing or
// renamed method and a wrong return shape — but TypeScript accepts a function of FEWER parameters
// wherever one of more is expected, so an implementation that quietly ignores a trailing `reason` is
// still legal. That is the exact shape six of this module's writes were in, so it needs a test.
describe("M18 EVV — write fidelity (F-068)", () => {
  /**
   * The routes, driven over an implementation whose every method returns a PROMISE — which is what
   * production is. The in-memory slice is synchronous, so `POST /evv/offline-sync`'s `b.events.map(...)`
   * serialized correctly in every test and returned `[{}, {}, …]` in production.
   */
  function asAsync(backend: EvvRouteService): EvvRoutePort {
    return new Proxy(backend, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => Promise.resolve(value.apply(target, args));
      },
    }) as unknown as EvvRoutePort;
  }

  /** Records every call so a test can assert what actually reached the service. */
  function recording(backend: EvvRouteService): {
    service: EvvRoutePort;
    calls: Array<{ method: string; args: unknown[] }>;
  } {
    const calls: Array<{ method: string; args: unknown[] }> = [];
    const service = new Proxy(backend, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          calls.push({ method: String(prop), args });
          return value.apply(target, args);
        };
      },
    }) as unknown as EvvRoutePort;
    return { service, calls };
  }

  const last = (calls: Array<{ method: string; args: unknown[] }>, method: string): unknown[] => {
    const hit = [...calls].reverse().find((c) => c.method === method);
    if (!hit) throw new Error(`no call to ${method}`);
    return hit.args;
  };

  async function capture(app: ReturnType<typeof makeServer>["app"]): Promise<string> {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/evv/check-in",
      headers: CLINICIAN,
      payload: checkInBody(),
    });
    expect(res.statusCode).toBe(201);
    return res.json().eventId as string;
  }

  const correct = (app: ReturnType<typeof makeServer>["app"], id: string, over = {}) =>
    app.inject({
      method: "POST",
      url: `/api/v1/evv/events/${id}/correct`,
      headers: SUPERVISOR_STEPUP,
      payload: { newEvent: checkInBody(), correctionReason: "x".repeat(60), ...over },
    });

  // §1 — the correction-of-record bypassed its own machine.
  it("a correction SUPERSEDES the original and links back to it", async () => {
    const { app } = makeServer();
    const originalId = await capture(app);
    const res = await correct(app, originalId);
    expect(res.statusCode).toBe(200);
    const newId = res.json().eventId as string;
    expect(newId).not.toBe(originalId);

    const before = await app.inject({
      method: "GET",
      url: `/api/v1/evv/events/${originalId}`,
      headers: SUPERVISOR,
    });
    const after = await app.inject({
      method: "GET",
      url: `/api/v1/evv/events/${newId}`,
      headers: SUPERVISOR,
    });
    // Both were hardcoded `null` on the read path and written by nothing on the write path.
    expect(before.json().supersededByEventId).toBe(newId);
    expect(after.json().replacesEventId).toBe(originalId);
    await app.close();
  });

  it("correcting an event that does not exist is 404, not a silent new capture", async () => {
    const { app } = makeServer();
    const res = await correct(app, "00000000-0000-4000-8000-000000000000");
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("correcting an ALREADY-corrected event is refused — correct the live head of the chain", async () => {
    const { app } = makeServer();
    const originalId = await capture(app);
    expect((await correct(app, originalId)).statusCode).toBe(200);
    const second = await correct(app, originalId);
    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe("EVV_EVENT_ALREADY_SUPERSEDED");
    await app.close();
  });

  it("a check-OUT offered as the correction of a check-in is refused", async () => {
    const { app } = makeServer();
    const originalId = await capture(app);
    // The two request shapes differ only by `serviceTypeCode`, which is how the route tells them apart;
    // it used to derive the kind from the body and write whichever leg the body implied.
    const res = await correct(app, originalId, {
      newEvent: {
        visitId: VISIT_1,
        capturedAt: CHECK_OUT_AT,
        coords: { lat: 40.0, lng: -75.0 },
        accuracyM: 10,
        evvDeviceId: DEVICE_UUID,
      },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("EVV_CORRECTION_KIND_MISMATCH");
    await app.close();
  });

  it("a correction with too short a reason is refused (the reason is USED, not just measured)", async () => {
    const { app } = makeServer();
    const originalId = await capture(app);
    const res = await correct(app, originalId, { correctionReason: "too short" });
    // Refused by TypeBox at the edge (422); the machine's own ≥60 guard —
    // EVV_CORRECTION_REASON_TOO_SHORT, also 422 — is the second line behind it.
    expect(res.statusCode).toBe(422);
    await app.close();
  });

  it("the visit bracket takes the LIVE leg, not the one that was corrected away", async () => {
    const { app } = makeServer();
    const originalId = await capture(app);
    const newId = (await correct(app, originalId)).json().eventId as string;
    const bracket = await app.inject({
      method: "GET",
      url: `/api/v1/evv/visits/${VISIT_1}/bracket`,
      headers: SUPERVISOR,
    });
    expect(bracket.json().checkInEvent.id).toBe(newId);
    await app.close();
  });

  // §2 — offline-sync returned an array of un-awaited promises.
  it("offline-sync returns the recorded events, not `[{}]`, against an ASYNC service", async () => {
    const { backend } = makeServer();
    const { app } = makeServer(asAsync(backend));
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/evv/offline-sync",
      headers: CLINICIAN,
      payload: {
        evvDeviceId: DEVICE_UUID,
        events: [
          { kind: "check_in", ...checkInBody() },
          { kind: "check_out", ...checkOutBody() },
        ],
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Array<{ eventId?: string; kind?: string }>;
    expect(body).toHaveLength(2);
    for (const item of body) {
      expect(typeof item.eventId).toBe("string");
      expect(item.kind).toBeDefined();
    }
    await app.close();
  });

  // §3/§4 — the reasons and the acting membership reach the service.
  it("device reject / suspend / retire pass the reason AND the acting membership", async () => {
    const { backend } = makeServer();
    const { service, calls } = recording(backend);
    const { app } = makeServer(service);
    const reg = await app.inject({
      method: "POST",
      url: "/api/v1/evv/devices/self-register",
      headers: CLINICIAN,
      payload: { platform: "ios", modelDescription: "iPhone 14" },
    });
    const deviceId = reg.json().id as string;

    for (const [action, reason] of [
      ["reject", "enrolled on a personal handset"],
      ["suspend", "reported lost at the Tuesday standup"],
      ["retire", "returned to IT"],
    ] as const) {
      const res = await app.inject({
        method: "POST",
        url: `/api/v1/evv/devices/${deviceId}/${action}`,
        headers: SUPERVISOR,
        payload: { reason },
      });
      expect(res.statusCode).toBe(200);
      const args = last(calls, `${action}Device`);
      expect(args[1]).toBe("sup_1"); // the CALLER, not an arbitrary membership in the org
      expect(args[3]).toBe(reason);
    }
    await app.close();
  });

  it("device approve passes the acting membership", async () => {
    const { backend } = makeServer();
    const { service, calls } = recording(backend);
    const { app } = makeServer(service);
    const reg = await app.inject({
      method: "POST",
      url: "/api/v1/evv/devices/self-register",
      headers: CLINICIAN,
      payload: { platform: "ios", modelDescription: "iPhone 14" },
    });
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/evv/devices/${reg.json().id}/approve`,
      headers: SUPERVISOR,
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(last(calls, "approveDevice")[1]).toBe("sup_1");
    await app.close();
  });

  it("the per-address geofence override passes its ≥30-char reason and the setter", async () => {
    const { backend } = makeServer();
    const { service, calls } = recording(backend);
    const { app } = makeServer(service);
    const overrideReason = "the driveway sits 180m from the road-network centroid";
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/evv/geofence-policy/per-address",
      headers: SUPERVISOR,
      payload: {
        patientAddressId: PATIENT_ADDRESS,
        radiusM: 120,
        maxAccuracyM: 30,
        overrideReason,
      },
    });
    expect(res.statusCode).toBe(201);
    const args = last(calls, "createPerAddressOverride");
    expect(args[1]).toBe("sup_1");
    expect((args[2] as { overrideReason: string }).overrideReason).toBe(overrideReason);
    await app.close();
  });

  it("the tenant geofence edit passes the setter", async () => {
    const { backend } = makeServer();
    const { service, calls } = recording(backend);
    const { app } = makeServer(service);
    const res = await app.inject({
      method: "PATCH",
      url: "/api/v1/evv/geofence-policy/tenant",
      headers: SUPERVISOR,
      payload: { radiusM: 150, maxAccuracyM: 40 },
    });
    expect(res.statusCode).toBe(200);
    expect(last(calls, "editTenantPolicy")[1]).toBe("sup_1");
    await app.close();
  });

  it("an aggregator cancel passes its reason", async () => {
    const { backend } = makeServer();
    const { service, calls } = recording(backend);
    const { app } = makeServer(service);
    const reason = "the visit was voided; the state should not see this claim line";
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/evv/aggregator-submissions/${SUBMISSION_PENDING}/cancel`,
      headers: SUPERVISOR,
      payload: { reason },
    });
    expect(res.statusCode).toBe(200);
    expect(last(calls, "cancelSubmission")[3]).toBe(reason);
    await app.close();
  });

  // §3 — the two required uuids no caller could obtain are gone from the contracts.
  it("supervisor-override no longer demands a step-up ref no route can mint", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/evv/missing-resolutions/${RESOLUTION_OVERRIDE}/supervisor-override`,
      headers: SUPERVISOR_STEPUP,
      payload: { reason: "x".repeat(60) }, // no stepUpAuthRefId
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("closed_supervisor_override");
    await app.close();
  });

  it("device self-register no longer demands an attestation id no caller holds", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/evv/devices/self-register",
      headers: CLINICIAN,
      payload: { platform: "ios", modelDescription: "iPhone 14" }, // no attestationId
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().status).toBe("pending_approval");
    await app.close();
  });
});

// ── GAP-055 — offline-sync + device attestation capture guards ─────────────────────────────────────────
describe("GAP-055 — capture guards: device attestation + offline-sync per-event checks", () => {
  const sync = (
    app: ReturnType<typeof makeServer>["app"],
    headers: Record<string, string>,
    events: Array<Record<string, unknown>>,
  ) =>
    app.inject({
      method: "POST",
      url: "/api/v1/evv/offline-sync",
      headers,
      payload: { evvDeviceId: DEVICE_UUID, events },
    });
  const written = async (backend: EvvRouteService) => (await backend.listEvents(ORG, {})).length;

  const OTHER_DEVICE = "33333333-3333-4333-8333-333333333388";

  it("check-in refuses an evvDeviceId that is not the session-bound device (403, nothing written)", async () => {
    const { app, backend } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/evv/check-in",
      headers: CLINICIAN,
      payload: checkInBody({ evvDeviceId: OTHER_DEVICE }),
    });
    expect(res.statusCode).toBe(403);
    expect(await written(backend)).toBe(0);
    await app.close();
  });

  it("offline-sync refuses a batch evvDeviceId that is not the session-bound device (403, nothing written)", async () => {
    const { app, backend } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/evv/offline-sync",
      headers: CLINICIAN,
      payload: {
        evvDeviceId: OTHER_DEVICE,
        events: [{ kind: "check_in", ...checkInBody({ evvDeviceId: OTHER_DEVICE }) }],
      },
    });
    expect(res.statusCode).toBe(403);
    expect(await written(backend)).toBe(0);
    await app.close();
  });

  it("offline-sync refuses an event naming a different device than the batch, even when one is bound (403)", async () => {
    const { app, backend } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/evv/offline-sync",
      headers: CLINICIAN,
      payload: {
        evvDeviceId: DEVICE_UUID,
        events: [{ kind: "check_in", ...checkInBody({ evvDeviceId: OTHER_DEVICE }) }],
      },
    });
    expect(res.statusCode).toBe(403);
    expect(await written(backend)).toBe(0);
    await app.close();
  });

  it("check-in / check-out refuse a caller whose session has no valid attestation (403)", async () => {
    const { app, backend } = makeServer();
    const ci = await app.inject({
      method: "POST",
      url: "/api/v1/evv/check-in",
      headers: CLINICIAN_UNATTESTED,
      payload: checkInBody(),
    });
    const co = await app.inject({
      method: "POST",
      url: "/api/v1/evv/check-out",
      headers: CLINICIAN_UNATTESTED,
      payload: checkOutBody(),
    });
    expect([ci.statusCode, co.statusCode]).toEqual([403, 403]);
    expect(await written(backend)).toBe(0);
    await app.close();
  });

  it("a client-supplied attestation flag in the body never satisfies the guard", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/evv/check-in",
      headers: CLINICIAN_UNATTESTED,
      payload: checkInBody({ deviceAttestationValid: true, attested: true }),
    });
    expect([403, 422]).toContain(res.statusCode);
    await app.close();
  });

  it("offline-sync refuses an un-attested session (403) and writes nothing", async () => {
    const { app, backend } = makeServer();
    const res = await sync(app, CLINICIAN_UNATTESTED, [{ kind: "check_in", ...checkInBody() }]);
    expect(res.statusCode).toBe(403);
    expect(await written(backend)).toBe(0);
    await app.close();
  });

  it("offline-sync refuses an event on a visit assigned to someone else (403), writes nothing", async () => {
    const { app, backend } = makeServer();
    const res = await sync(app, CLINICIAN, [
      { kind: "check_in", ...checkInBody() },
      { kind: "check_in", ...checkInBody({ visitId: VISIT_OTHER }) },
    ]);
    expect(res.statusCode).toBe(403);
    expect(await written(backend)).toBe(0);
    await app.close();
  });

  it("offline-sync refuses an event outside the visit window (403), writes nothing", async () => {
    const { app, backend } = makeServer();
    const res = await sync(app, CLINICIAN, [
      { kind: "check_in", ...checkInBody() },
      { kind: "check_out", ...checkOutBody({ capturedAt: "2026-06-09T13:00:00.000Z" }) },
    ]);
    expect(res.statusCode).toBe(403);
    expect(await written(backend)).toBe(0);
    await app.close();
  });

  it("offline-sync needs evv.check_out for a check_out event (403 for a check_in-only caller)", async () => {
    const { app, backend } = makeServer();
    const res = await sync(app, { ...CHECKIN_ONLY, "x-test-user": "rn_in_only" }, [
      { kind: "check_out", ...checkOutBody() },
    ]);
    expect(res.statusCode).toBe(403);
    expect(await written(backend)).toBe(0);
    await app.close();
  });

  it("offline-sync with all-valid events records every one", async () => {
    const { app, backend } = makeServer();
    const res = await sync(app, CLINICIAN, [
      { kind: "check_in", ...checkInBody() },
      { kind: "check_out", ...checkOutBody() },
    ]);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveLength(2);
    expect(await written(backend)).toBe(2);
    await app.close();
  });
});

// ── GAP-055 follow-up — device attestation + session-device binding NOT enforced (the production default) ──
// ADR-0035: no attested client exists yet, so `EVV_DEVICE_ATTESTATION_ENFORCED` defaults to false. Only the
// attestation verdict and the session-device binding are relaxed; every other §8.2 guard still holds.
describe("GAP-055 — capture guards with device attestation NOT enforced", () => {
  const off = () => makeServer(undefined, false);
  const post = (
    app: ReturnType<typeof makeServer>["app"],
    url: string,
    headers: Record<string, string>,
    payload: unknown,
  ) => app.inject({ method: "POST", url, headers, payload: payload as Record<string, unknown> });
  const written = async (backend: EvvRouteService) => (await backend.listEvents(ORG, {})).length;

  it("check-in / check-out succeed for an un-attested session on the resolved (most-recent approved) device", async () => {
    const { app, backend } = off();
    const ci = await post(app, "/api/v1/evv/check-in", CLINICIAN_UNATTESTED, checkInBody());
    const co = await post(app, "/api/v1/evv/check-out", CLINICIAN_UNATTESTED, checkOutBody());
    expect([ci.statusCode, co.statusCode]).toEqual([201, 201]);
    expect(await written(backend)).toBe(2);
    await app.close();
  });

  it("offline-sync succeeds for an un-attested session", async () => {
    const { app, backend } = off();
    const res = await post(app, "/api/v1/evv/offline-sync", CLINICIAN_UNATTESTED, {
      evvDeviceId: DEVICE_UUID,
      events: [
        { kind: "check_in", ...checkInBody() },
        { kind: "check_out", ...checkOutBody() },
      ],
    });
    expect(res.statusCode).toBe(200);
    expect(await written(backend)).toBe(2);
    await app.close();
  });

  it("an evvDeviceId that is not an approved device of the clinician is still refused (403, nothing written)", async () => {
    const { app, backend } = off();
    const res = await post(
      app,
      "/api/v1/evv/check-in",
      CLINICIAN_UNATTESTED,
      checkInBody({ evvDeviceId: "33333333-3333-4333-8333-333333333388" }),
    );
    expect(res.statusCode).toBe(403);
    expect(await written(backend)).toBe(0);
    await app.close();
  });

  it("a claim naming the clinician's OLDER approved device is accepted; another member's device is refused", async () => {
    const { app, backend } = off();
    const older = await post(
      app,
      "/api/v1/evv/check-in",
      CLINICIAN_UNATTESTED,
      checkInBody({ evvDeviceId: DEVICE_UUID }),
    );
    expect(older.statusCode).toBe(201);
    const foreign = await post(
      app,
      "/api/v1/evv/check-out",
      CLINICIAN_UNATTESTED,
      checkOutBody({ evvDeviceId: DEVICE_UUID_IN_ONLY }),
    );
    expect(foreign.statusCode).toBe(403);
    expect(await written(backend)).toBe(1);
    await app.close();
  });

  it("offline-sync accepts a batch claiming the older approved device", async () => {
    const { app, backend } = off();
    const res = await post(app, "/api/v1/evv/offline-sync", CLINICIAN_UNATTESTED, {
      evvDeviceId: DEVICE_UUID,
      events: [{ kind: "check_in", ...checkInBody({ evvDeviceId: DEVICE_UUID }) }],
    });
    expect(res.statusCode).toBe(200);
    expect(await written(backend)).toBe(1);
    await app.close();
  });

  it("offline-sync still refuses a batch whose device claim is not the resolved device (whole batch, nothing written)", async () => {
    const { app, backend } = off();
    const res = await post(app, "/api/v1/evv/offline-sync", CLINICIAN_UNATTESTED, {
      evvDeviceId: "33333333-3333-4333-8333-333333333388",
      events: [
        {
          kind: "check_in",
          ...checkInBody({ evvDeviceId: "33333333-3333-4333-8333-333333333388" }),
        },
      ],
    });
    expect(res.statusCode).toBe(403);
    expect(await written(backend)).toBe(0);
    await app.close();
  });

  it("the assigned-clinician guard still holds (403) on a visit assigned to someone else", async () => {
    const { app, backend } = off();
    const res = await post(
      app,
      "/api/v1/evv/check-in",
      CLINICIAN_UNATTESTED,
      checkInBody({ visitId: VISIT_OTHER }),
    );
    expect(res.statusCode).toBe(403);
    expect(await written(backend)).toBe(0);
    await app.close();
  });

  it("the visit-window guard still holds (403) outside the window", async () => {
    const { app, backend } = off();
    const res = await post(
      app,
      "/api/v1/evv/check-out",
      CLINICIAN_UNATTESTED,
      checkOutBody({ capturedAt: "2026-06-09T13:00:00.000Z" }),
    );
    expect(res.statusCode).toBe(403);
    expect(await written(backend)).toBe(0);
    await app.close();
  });

  it("offline-sync is still whole-batch-before-write: one bad event writes nothing", async () => {
    const { app, backend } = off();
    const res = await post(app, "/api/v1/evv/offline-sync", CLINICIAN_UNATTESTED, {
      evvDeviceId: DEVICE_UUID,
      events: [
        { kind: "check_in", ...checkInBody() },
        { kind: "check_in", ...checkInBody({ visitId: VISIT_OTHER }) },
      ],
    });
    expect(res.statusCode).toBe(403);
    expect(await written(backend)).toBe(0);
    await app.close();
  });

  it("offline-sync still needs evv.check_out for a check_out event", async () => {
    const { app, backend } = off();
    const res = await post(
      app,
      "/api/v1/evv/offline-sync",
      { ...CHECKIN_ONLY, "x-test-attested": "" },
      { evvDeviceId: DEVICE_UUID_IN_ONLY, events: [{ kind: "check_out", ...checkOutBody() }] },
    );
    expect(res.statusCode).toBe(403);
    expect(await written(backend)).toBe(0);
    await app.close();
  });

  it("a body attestation flag still grants nothing (the caller needs no attestation, but still the other guards)", async () => {
    const { app, backend } = off();
    const res = await post(
      app,
      "/api/v1/evv/check-in",
      CLINICIAN_UNATTESTED,
      checkInBody({ deviceAttestationValid: true, visitId: VISIT_OTHER }),
    );
    expect([403, 422]).toContain(res.statusCode);
    expect(await written(backend)).toBe(0);
    await app.close();
  });
});
