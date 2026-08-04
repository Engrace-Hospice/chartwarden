// apps/backend/__tests__/emar-routes.test.ts — M13-T08 route-inventory + §4.6 RBAC gating + §4.7
// `administering_clinician_eligible` / `controlled_substance_witness_eligible` /
// `caregiver_attested_review_required` / `reconciliation_authoring_eligible` ABAC + §4.4 outbox emission
// (M13 spec §4.1, §4.2, §4.4, §4.6, §4.7).
//
// Exercises M13's routes through the FULL M1 middleware chain via Fastify `inject`, no live infra: buildServer()
// mounts the host, registerEmarRoutes() mounts the §4.1 inventory over the in-memory backend. The REAL
// Authorization Contract gates every route on the §4.6 keys; a header-auth shim populates request.context. The
// four §4.7 predicates M13 owns are registered into a fresh ABAC registry over the slice's resolver.
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
  buildEmarAbacPredicates,
  createInMemoryEmarBackend,
  registerEmarRoutes,
} from "../src/modules/13-emar/index";

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
const ORDER = "00000000-0000-4000-8000-0000000000a1";
const WORKSHEET = "22222222-2222-4222-8222-222222222222";
const CAREGIVER_ADMIN = "33333333-3333-4333-8333-333333333333";
const ADMIN_MEMBERSHIP = "00000000-0000-4000-8000-0000000000c1";
const NOW = "2026-06-08T12:00:00.000Z";

const READ = [
  "administration.read",
  "administration.read_missed",
  "reconciliation.read",
  "comfort_kit.read",
];
const ALL_WRITE = [
  "administration.record",
  "administration.record_refusal",
  "administration.record_missed",
  "administration.witness_attest",
  "administration.correct",
  "administration.void",
  "administration.caregiver_record",
  "administration.caregiver_acknowledge",
  "administration.caregiver_dispute",
  "administration.acknowledge_missed",
  "reconciliation.decide",
  "reconciliation.finalize",
  "reconciliation.void",
  "comfort_kit.acknowledge_return",
  "administration.admin.policy",
];
const PERMISSION_SEED = [
  { userId: "md_1", permissions: [...READ, ...ALL_WRITE] },
  {
    userId: "rn_1",
    permissions: [
      ...READ,
      "administration.record",
      "administration.caregiver_acknowledge",
      "reconciliation.decide",
      "reconciliation.finalize",
      "administration.witness_attest",
    ],
  },
  { userId: "chap_1", permissions: [...READ, "administration.record"] },
  { userId: "viewer_1", permissions: READ },
];

function makeServer() {
  const backend = createInMemoryEmarBackend({
    now: () => NOW,
    memberships: [
      { userId: "md_1", membershipId: "mem_md", organizationId: ORG, discipline: "md" },
      { userId: "rn_1", membershipId: "mem_rn", organizationId: ORG, discipline: "rn" },
      { userId: "chap_1", membershipId: "mem_chap", organizationId: ORG, discipline: "chaplain" },
      { userId: "viewer_1", membershipId: "mem_view", organizationId: ORG, discipline: "auditor" },
    ],
    caseManagers: { [PATIENT]: "rn_1" },
    administrations: [
      {
        id: CAREGIVER_ADMIN,
        organizationId: ORG,
        patientId: PATIENT,
        admissionId: "adm-1",
        medicationOrderId: ORDER,
        actorKind: "caregiver_attested",
        requiresRnReview: true,
      },
    ],
    worksheets: [
      {
        id: WORKSHEET,
        organizationId: ORG,
        patientId: PATIENT,
        admissionId: "adm-1",
        triggerKind: "admission",
        lineCount: 1,
      },
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
  for (const [name, predicate] of Object.entries(buildEmarAbacPredicates({ resolver: backend }))) {
    reg.register(name, predicate);
  }
  registerAbacRegistry(reg);

  const app = buildServer({ authenticate: headerAuth, security: { rateLimitEnabled: false } });
  registerEmarRoutes(app, { service: backend });
  return { app, backend };
}

const MD = { "x-test-user": "md_1", "x-test-org": ORG, "x-test-roles": "md" };
const RN = { "x-test-user": "rn_1", "x-test-org": ORG, "x-test-roles": "rn" };
const CHAPLAIN = { "x-test-user": "chap_1", "x-test-org": ORG, "x-test-roles": "chaplain" };
const VIEWER = { "x-test-user": "viewer_1", "x-test-org": ORG, "x-test-roles": "auditor" };

const recordBody = (over: Record<string, unknown> = {}) => ({
  medicationOrderId: ORDER,
  medClass: "standard",
  mode: "single_dose",
  administeredAt: NOW,
  data: {},
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

describe("M13-T08 — §4.6 RBAC gating", () => {
  it("a viewer with administration.read lists administrations but cannot record (403)", async () => {
    const { app } = makeServer();
    const ok = await app.inject({
      method: "GET",
      url: `/api/v1/administrations?patient=${PATIENT}`,
      headers: VIEWER,
    });
    expect(ok.statusCode).toBe(200);
    const denied = await app.inject({
      method: "POST",
      url: "/api/v1/administrations",
      headers: VIEWER,
      payload: recordBody(),
    });
    expect(denied.statusCode).toBe(403);
    await app.close();
  });
});

describe("M13-T08 — §4.7 administering_clinician_eligible floor", () => {
  it("a chaplain holding administration.record is blocked by the discipline ABAC floor (403)", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/administrations",
      headers: CHAPLAIN,
      payload: recordBody(),
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("an MD records a standard administration (201) and the §4.4 recorded event fires", async () => {
    const { app, backend } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/administrations",
      headers: MD,
      payload: recordBody(),
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().status).toBe("committed");
    expect(backend.drainEvents().map((e) => e.eventName)).toContain("m13.administration.recorded");
    await app.close();
  });
});

describe("M13-T08 — §4.7 controlled_substance_witness_eligible", () => {
  it("an eligible RN witness mints a 60-second attestation token (201)", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/administrations/witness-attest",
      headers: RN,
      payload: {
        patientId: PATIENT,
        medicationOrderId: ORDER,
        administeringClinicianMembershipId: ADMIN_MEMBERSHIP,
        attestationText: "I witnessed the dose",
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().expiresInSeconds).toBe(60);
    await app.close();
  });
});

describe("M13-T08 — §4.7 reconciliation_authoring_eligible + §4.4 draft-order event", () => {
  it("an RN records a carry_forward decision (201) → m13.reconciliation.draft_order_requested fires", async () => {
    const { app, backend } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/reconciliation/worksheets/${WORKSHEET}/decisions`,
      headers: RN,
      payload: { lineKind: "active_medication", sourceId: ORDER, decision: "carry_forward" },
    });
    expect(res.statusCode).toBe(201);
    expect(backend.drainEvents().map((e) => e.eventName)).toContain(
      "m13.reconciliation.draft_order_requested",
    );
    await app.close();
  });
});

describe("M13-T08 — §4.7 caregiver_attested_review_required", () => {
  it("the patient's RN case manager acknowledges the caregiver-attested row (200)", async () => {
    const { app, backend } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/administrations/${CAREGIVER_ADMIN}/acknowledge-caregiver`,
      headers: RN,
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(backend.drainEvents().map((e) => e.eventName)).toContain(
      "m13.caregiver_administration.acknowledged",
    );
    await app.close();
  });

  it("a clinician who is NOT the patient's RN case manager is denied the acknowledge (403)", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/administrations/${CAREGIVER_ADMIN}/acknowledge-caregiver`,
      headers: MD,
      payload: {},
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });
});

describe("M13-T08 — §2.8 reconciliation finalize gate", () => {
  it("finalizing a worksheet with an undecided line returns 422 RECONCILIATION_INCOMPLETE", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/reconciliation/worksheets/${WORKSHEET}/finalize`,
      headers: RN,
      payload: { attestation: "reviewed" },
    });
    expect(res.statusCode).toBe(422);
    await app.close();
  });
});
