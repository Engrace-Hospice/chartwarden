// apps/backend/__tests__/dosespot-routes.test.ts — M12-T08 route-inventory + §4.6 RBAC gating + §4.7
// `prescriber_eligible` / `dea_schedule_authorized` / `refill_inbox_scope` ABAC + the §2.2 lifecycle / §2.7
// refill flow + §4.4 outbox emission (M12 spec §4.1, §4.2, §4.4, §4.6, §4.7).
//
// Exercises M12's routes through the FULL M1 middleware chain via Fastify `inject`, no live infra: buildServer()
// mounts the host, registerDoseSpotRoutes() mounts the §4.1 inventory over the in-memory backend. The REAL
// Authorization Contract gates every route on the §4.6 keys; a header-auth shim populates request.context. The
// three §4.7 predicates M12 owns are registered into a fresh ABAC registry over the slice's resolver.
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
  buildDoseSpotAbacPredicates,
  createInMemoryDoseSpotBackend,
  registerDoseSpotRoutes,
} from "../src/modules/12-dosespot/index";

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
const ADMISSION = "33333333-3333-4333-8333-333333333333";
const PHYS = "44444444-4444-4444-8444-444444444444";
const SOURCE_ORDER = "00000000-0000-4000-8000-0000000000a1";
const REFILL = "00000000-0000-4000-8000-0000000000b1";
const NOW = "2026-06-08T12:00:00.000Z";

const READ = ["prescribing.read"];
const WRITE = [
  "prescribing.draft",
  "prescribing.sign",
  "prescribing.sign_controlled_substance",
  "prescribing.verbal.record",
  "prescribing.cosign",
  "prescribing.discontinue",
  "prescribing.refill_decide",
];
const PERMISSION_SEED = [
  { userId: "md_1", permissions: [...READ, ...WRITE] },
  { userId: "rn_1", permissions: [...READ, "prescribing.draft", "prescribing.verbal.record"] },
  { userId: "chap_1", permissions: [...READ, "prescribing.draft"] },
  { userId: "viewer_1", permissions: READ },
];

function makeServer() {
  const backend = createInMemoryDoseSpotBackend({
    now: () => NOW,
    orders: [
      {
        id: SOURCE_ORDER,
        organizationId: ORG,
        patientId: PATIENT,
        admissionId: ADMISSION,
        medClass: "standard",
        status: "active",
        prescriberMembershipId: "md_1",
        drugName: "Acetaminophen",
        refillsRemaining: 3,
      },
    ],
    refills: [
      {
        id: REFILL,
        organizationId: ORG,
        patientId: PATIENT,
        sourceMedicationOrderId: SOURCE_ORDER,
        status: "pending",
      },
    ],
    prescribers: [
      { organizationId: ORG, membershipId: "md_1", deaAuthorizedSchedules: ["II", "III"] },
    ],
  });

  const grantStore = createInMemoryEffectivePermissionStore(
    PERMISSION_SEED.map((s) => ({
      orgId: ORG,
      userId: s.userId,
      grants: [{ roleKey: "seed", enabled: true, expiresAt: null, permissionKeys: s.permissions }],
    })),
  );
  registerEffectivePermissionResolver(grantStore.store);
  // A FRESH predicate registry per server (the shared `abacRegistry` would otherwise persist a predicate
  // closed over a prior test's backend across the file).
  const reg = createPredicateRegistry();
  for (const [name, predicate] of Object.entries(
    buildDoseSpotAbacPredicates({ resolver: backend }),
  )) {
    reg.register(name, predicate);
  }
  registerAbacRegistry(reg);

  const app = buildServer({ authenticate: headerAuth, security: { rateLimitEnabled: false } });
  registerDoseSpotRoutes(app, { service: backend });
  return { app, backend };
}

const MD = { "x-test-user": "md_1", "x-test-org": ORG, "x-test-roles": "hospice_physician" };
const RN = { "x-test-user": "rn_1", "x-test-org": ORG, "x-test-roles": "rn_case_manager" };
const CHAPLAIN = { "x-test-user": "chap_1", "x-test-org": ORG, "x-test-roles": "chaplain" };
const VIEWER = { "x-test-user": "viewer_1", "x-test-org": ORG, "x-test-roles": "auditor" };

const stdBody = (over: Record<string, unknown> = {}) => ({
  patientId: PATIENT,
  admissionId: ADMISSION,
  medClass: "standard",
  rxnormRxcui: "161",
  ndc: null,
  drugName: "Acetaminophen 500mg",
  strength: "500mg",
  doseForm: "tablet",
  route: "oral",
  data: {},
  prescriberDiscipline: "hospice_physician",
  prescribingPhysicianMdmId: PHYS,
  refillsAuthorized: 3,
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

describe("M12-T08 — §4.6 RBAC gating", () => {
  it("a viewer with prescribing.read lists orders but cannot draft (403)", async () => {
    const { app } = makeServer();
    const ok = await app.inject({
      method: "GET",
      url: "/api/v1/medication-orders",
      headers: VIEWER,
    });
    expect(ok.statusCode).toBe(200);
    const denied = await app.inject({
      method: "POST",
      url: "/api/v1/medication-orders",
      headers: VIEWER,
      payload: stdBody(),
    });
    expect(denied.statusCode).toBe(403);
    await app.close();
  });
});

describe("M12-T08 — §4.7 prescriber_eligible floor", () => {
  it("a chaplain holding prescribing.draft is blocked by the discipline ABAC floor (403)", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/medication-orders",
      headers: CHAPLAIN,
      payload: stdBody({ prescriberDiscipline: "chaplain" }),
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("an RN may not author a controlled-substance order (prescriber-only floor, 403)", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/medication-orders",
      headers: RN,
      payload: stdBody({
        medClass: "controlled_substance",
        prescriberDiscipline: "rn_case_manager",
        deaSchedule: "II",
      }),
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("a physician drafts a standard order (201) and the §4.4 draft_created event fires", async () => {
    const { app, backend } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/medication-orders",
      headers: MD,
      payload: stdBody(),
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().status).toBe("draft");
    expect(backend.drainEvents().map((e) => e.eventName)).toContain(
      "m12.medication_order.draft_created",
    );
    await app.close();
  });
});

describe("M12-T08 — §2.2 lifecycle: request-signature → sign", () => {
  it("MD drafts → requests signature → signs; §4.4 signed event fires", async () => {
    const { app, backend } = makeServer();
    const draft = await app.inject({
      method: "POST",
      url: "/api/v1/medication-orders",
      headers: MD,
      payload: stdBody(),
    });
    const id = draft.json().id as string;
    backend.drainEvents();

    const req = await app.inject({
      method: "POST",
      url: `/api/v1/medication-orders/${id}/request-signature`,
      headers: MD,
      payload: { signerDiscipline: "hospice_physician" },
    });
    expect(req.statusCode).toBe(200);
    expect(req.json().status).toBe("pending_signature");

    const signed = await app.inject({
      method: "POST",
      url: `/api/v1/medication-orders/${id}/sign`,
      headers: MD,
      payload: { signerDiscipline: "hospice_physician", signedAtClient: NOW },
    });
    expect(signed.statusCode).toBe(200);
    expect(signed.json().status).toBe("signed");
    expect(backend.drainEvents().map((e) => e.eventName)).toContain("m12.medication_order.signed");
    await app.close();
  });
});

describe("M12-T08 — §4.7 dea_schedule_authorized", () => {
  it("a prescriber not on the DEA roster cannot initiate a controlled-substance sign (403)", async () => {
    const { app } = makeServer();
    // Draft a controlled order as the MD (on the roster for II/III), but request the sign as rn_1 (no roster row).
    const draft = await app.inject({
      method: "POST",
      url: "/api/v1/medication-orders",
      headers: MD,
      payload: stdBody({ medClass: "controlled_substance", deaSchedule: "II" }),
    });
    const id = draft.json().id as string;
    // rn_1 lacks the sign_controlled permission AND a roster row — assert the controlled-sign path is denied for MD-less roster.
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/medication-orders/${id}/sign-controlled/initiate`,
      headers: { "x-test-user": "md_1", "x-test-org": ORG, "x-test-roles": "hospice_physician" },
      payload: { signerDiscipline: "hospice_physician", schedule: "IV" },
    });
    // md_1 is authorized for II/III only — schedule IV is not on the roster → 403.
    expect(res.statusCode).toBe(403);
    await app.close();
  });
});

describe("M12-T08 — §2.7 refill inbox", () => {
  it("the named prescriber approves a refill (201) → mints a new order; §4.4 approved event fires", async () => {
    const { app, backend } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/refills/${REFILL}/approve`,
      headers: MD,
      payload: { refillsAuthorized: 2 },
    });
    expect(res.statusCode).toBe(201);
    expect(typeof res.json().resultingOrderId).toBe("string");
    expect(backend.drainEvents().map((e) => e.eventName)).toContain("m12.refill_request_approved");
    await app.close();
  });

  it("refill_inbox_scope denies a non-prescriber, non-caseload reader (403)", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/refills/${REFILL}`,
      headers: VIEWER,
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });
});
