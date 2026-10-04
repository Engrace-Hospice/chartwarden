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
  // emar-routes.ts's actorOf() reads the acting MEMBERSHIP id from here (not ctx.userId).
  request.context.attributes.membershipId = user;
  const org = request.headers["x-test-org"];
  request.context.organizationId = typeof org === "string" ? org : "";
  const roles = request.headers["x-test-roles"];
  request.context.roles = typeof roles === "string" && roles.length > 0 ? roles.split(",") : [];
}

const ORG = "org_a";
const PATIENT = "11111111-1111-4111-8111-111111111111";
const ORDER = "00000000-0000-4000-8000-0000000000a1";
const CONTROLLED_ORDER = "00000000-0000-4000-8000-0000000000a2";
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
  // GAP-004 — an RN with the full RN key set who is NOT on PATIENT's caseload.
  {
    userId: "rn_off",
    permissions: [
      ...READ,
      "administration.record",
      "administration.correct",
      "reconciliation.decide",
    ],
  },
];

/** GAP-004 — who is on PATIENT's caseload (stands in for M5's CaseloadProvider). */
const CASELOAD = new Set(["md_1", "rn_1", "chap_1", "viewer_1"]);

function makeServer() {
  const backend = createInMemoryEmarBackend({
    now: () => NOW,
    memberships: [
      { userId: "md_1", membershipId: "mem_md", organizationId: ORG, discipline: "md" },
      { userId: "rn_1", membershipId: "mem_rn", organizationId: ORG, discipline: "rn" },
      { userId: "chap_1", membershipId: "mem_chap", organizationId: ORG, discipline: "chaplain" },
      { userId: "viewer_1", membershipId: "mem_view", organizationId: ORG, discipline: "auditor" },
      { userId: "rn_off", membershipId: "mem_rn_off", organizationId: ORG, discipline: "rn" },
    ],
    orders: [
      { medicationOrderId: ORDER, patientId: PATIENT, route: "oral", medClass: "standard" },
      {
        medicationOrderId: CONTROLLED_ORDER,
        patientId: PATIENT,
        route: "oral",
        medClass: "controlled_substance",
      },
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
  const isInCaseload = async (q: { userId: string; patientId: string }) =>
    q.patientId === PATIENT && CASELOAD.has(q.userId);
  for (const [name, predicate] of Object.entries(
    buildEmarAbacPredicates({ resolver: backend, isInCaseload }),
  )) {
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
const RN_OFF = { "x-test-user": "rn_off", "x-test-org": ORG, "x-test-roles": "rn" };

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
  it("an RN records a carry_forward decision on a caregiver-reported line, with explicit drug content (201) → m13.reconciliation.draft_order_requested fires", async () => {
    const { app, backend } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/reconciliation/worksheets/${WORKSHEET}/decisions`,
      headers: RN,
      payload: {
        lineKind: "caregiver_reported",
        sourceId: ORDER,
        decision: "carry_forward",
        medicationDetails: {
          drugName: "Lisinopril",
          strength: "10mg",
          doseForm: "tablet",
          route: "oral",
          medClass: "standard",
        },
      },
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

describe("GAP-004 — §4.1 caseload_or_scope (emar.scope) on M13 PHI routes", () => {
  it.each([
    ["GET", `/api/v1/administrations/${CAREGIVER_ADMIN}`],
    ["GET", `/api/v1/administrations?patient=${PATIENT}`],
    ["GET", `/api/v1/scheduled-doses?patient=${PATIENT}`],
    ["GET", `/api/v1/missed-doses?patient=${PATIENT}`],
    ["GET", `/api/v1/reconciliation/worksheets?patient=${PATIENT}`],
    ["GET", `/api/v1/reconciliation/worksheets/${WORKSHEET}`],
    ["GET", `/api/v1/comfort-kits/deployments?patient=${PATIENT}`],
  ] as const)("an off-caseload RN gets 404 on %s %s", async (method, url) => {
    const { app } = makeServer();
    const res = await app.inject({ method, url, headers: RN_OFF });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("an off-caseload RN cannot record, correct or decide for the patient (404)", async () => {
    const { app } = makeServer();
    const record = await app.inject({
      method: "POST",
      url: "/api/v1/administrations",
      headers: RN_OFF,
      payload: recordBody(),
    });
    expect(record.statusCode).toBe(404);
    const correct = await app.inject({
      method: "POST",
      url: `/api/v1/administrations/${CAREGIVER_ADMIN}/correct`,
      headers: RN_OFF,
      payload: { reason: "wrong dose entered" },
    });
    expect(correct.statusCode).toBe(404);
    await app.close();
  });

  it("an on-caseload RN reads the same administration (200)", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/administrations/${CAREGIVER_ADMIN}`,
      headers: RN,
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it("an org-wide role (medical_director) passes without a caseload assignment", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/administrations?patient=${PATIENT}`,
      headers: { ...RN_OFF, "x-test-roles": "medical_director" },
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it("a list with no patient named is refused rather than org-wide", async () => {
    const { app } = makeServer();
    const res = await app.inject({ method: "GET", url: "/api/v1/administrations", headers: RN });
    expect([400, 404]).toContain(res.statusCode);
    await app.close();
  });
});

describe("GAP-005 — the controlled-substance witness keys on the ORDER, not the body", () => {
  it("a Schedule II order sent as medClass 'standard' with no witness is refused (422 MED_CLASS_MISMATCH)", async () => {
    const { app, backend } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/administrations",
      headers: MD,
      payload: recordBody({ medicationOrderId: CONTROLLED_ORDER, medClass: "standard" }),
    });
    expect(res.statusCode).toBe(422);
    expect(JSON.stringify(res.json())).toContain("MED_CLASS_MISMATCH");
    const list = await backend.listAdministrations(ORG, { patient: PATIENT });
    expect(list.some((a) => a.medicationOrderId === CONTROLLED_ORDER)).toBe(false);
    await app.close();
  });

  it("the same order declared honestly still demands the witness token", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/administrations",
      headers: MD,
      payload: recordBody({
        medicationOrderId: CONTROLLED_ORDER,
        medClass: "controlled_substance",
      }),
    });
    expect(res.statusCode).toBe(422);
    expect(JSON.stringify(res.json())).not.toContain("MED_CLASS_MISMATCH");
    await app.close();
  });
});
