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
  type EmarAbacResolver,
  type RecordAdministrationArgs,
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
  // A portal session pinned to one patient (M31) — what `emar.scope` reads as `sessionPatientId`.
  const sessionPatient = request.headers["x-test-session-patient"];
  if (typeof sessionPatient === "string")
    request.context.attributes.sessionPatientId = sessionPatient;
  // GAP-041 — stand-in for M3's step-up recency (what `step_up_recent` reads).
  request.context.attributes.stepUpRecent = request.headers["x-test-stepup"] === "fresh";
}

const ORG = "org_a";
const PATIENT = "11111111-1111-4111-8111-111111111111";
const ORDER = "00000000-0000-4000-8000-0000000000a1";
const CONTROLLED_ORDER = "00000000-0000-4000-8000-0000000000a2";
const WORKSHEET = "22222222-2222-4222-8222-222222222222";
const COMMITTED_ADMIN = "77777777-7777-4777-8777-777777777777";
const CAREGIVER_ADMIN = "33333333-3333-4333-8333-333333333333";
const ADMIN_MEMBERSHIP = "00000000-0000-4000-8000-0000000000c1";
/** GAP-004 — a second patient nobody here has on caseload, and that patient's comfort kit. */
const OTHER_PATIENT = "44444444-4444-4444-8444-444444444444";
const OTHER_KIT = "55555555-5555-4555-8555-555555555555";
/** GAP-004 — OTHER_PATIENT's own order and scheduled dose (for the patient-consistency refusals). */
const OTHER_ORDER = "00000000-0000-4000-8000-0000000000a3";
const OTHER_DOSE = "66666666-6666-4666-8666-666666666666";
/** An order seeded for ANOTHER tenant: the slice must not resolve it for ORG (fail-closed, like M12). */
const FOREIGN_ORDER = "00000000-0000-4000-8000-0000000000a4";
/** Membership ids the witness flow names on the wire (uuid-validated there). */
const MEM_MD = "00000000-0000-4000-8000-0000000000c3";
const MEM_RN_OFF = "00000000-0000-4000-8000-0000000000c4";
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
  // GAP-041 — a clinical supervisor: holds the void key (and the read keys the void response needs).
  { userId: "sup_1", permissions: [...READ, "administration.void"] },
  // GAP-004 — a caregiver portal session: may attest, holds no caseload.
  { userId: "cg_1", permissions: ["administration.caregiver_record"] },
  // GAP-004 — an RN with the full RN key set who is NOT on PATIENT's caseload.
  {
    userId: "rn_off",
    permissions: [
      ...READ,
      "administration.record",
      "administration.correct",
      "reconciliation.decide",
      "administration.witness_attest",
    ],
  },
];

/** GAP-004 — who is on PATIENT's caseload (stands in for M5's CaseloadProvider). */
const CASELOAD = new Set(["md_1", "rn_1", "chap_1", "viewer_1", "sup_1"]);

/** How many times the §4.7 predicates asked the resolver for an order fact (offline-sync batching). */
interface ResolverCalls {
  loadOrderMedClass: number;
  loadScopePatientId: number;
}

function makeServer(opts: { calls?: ResolverCalls; withCommittedAdmin?: boolean } = {}) {
  const backend = createInMemoryEmarBackend({
    now: () => NOW,
    memberships: [
      { userId: "md_1", membershipId: MEM_MD, organizationId: ORG, discipline: "md" },
      { userId: "rn_1", membershipId: "mem_rn", organizationId: ORG, discipline: "rn" },
      { userId: "chap_1", membershipId: "mem_chap", organizationId: ORG, discipline: "chaplain" },
      { userId: "viewer_1", membershipId: "mem_view", organizationId: ORG, discipline: "auditor" },
      { userId: "rn_off", membershipId: MEM_RN_OFF, organizationId: ORG, discipline: "rn" },
    ],
    orders: [
      {
        medicationOrderId: ORDER,
        organizationId: ORG,
        patientId: PATIENT,
        route: "oral",
        medClass: "standard",
      },
      {
        medicationOrderId: CONTROLLED_ORDER,
        organizationId: ORG,
        patientId: PATIENT,
        route: "oral",
        medClass: "controlled_substance",
      },
      {
        medicationOrderId: OTHER_ORDER,
        organizationId: ORG,
        patientId: OTHER_PATIENT,
        route: "oral",
        medClass: "standard",
      },
      {
        medicationOrderId: FOREIGN_ORDER,
        organizationId: "org_b",
        patientId: PATIENT,
        route: "oral",
        medClass: "standard",
      },
    ],
    scheduledDoses: [
      {
        id: OTHER_DOSE,
        organizationId: ORG,
        patientId: OTHER_PATIENT,
        medicationOrderId: OTHER_ORDER,
        dueAt: NOW,
      },
    ],
    caseManagers: { [PATIENT]: "rn_1" },
    deployments: [
      { id: OTHER_KIT, organizationId: ORG, patientId: OTHER_PATIENT, admissionId: "adm-2" },
    ],
    administrations: [
      ...(opts.withCommittedAdmin
        ? [
            {
              id: COMMITTED_ADMIN,
              organizationId: ORG,
              patientId: PATIENT,
              admissionId: "adm-1",
              medicationOrderId: ORDER,
            },
          ]
        : []),
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
  const { calls } = opts;
  const resolver: EmarAbacResolver = calls
    ? {
        loadWitnessFacts: (...a) => backend.loadWitnessFacts(...a),
        loadCaregiverReviewFacts: (...a) => backend.loadCaregiverReviewFacts(...a),
        loadWorksheetTriggerKind: (...a) => backend.loadWorksheetTriggerKind(...a),
        loadScopePatientId: (...a) => {
          calls.loadScopePatientId++;
          return backend.loadScopePatientId(...a);
        },
        loadOrderMedClass: (...a) => {
          calls.loadOrderMedClass++;
          return backend.loadOrderMedClass(...a);
        },
      }
    : backend;
  for (const [name, predicate] of Object.entries(
    buildEmarAbacPredicates({ resolver, isInCaseload }),
  )) {
    reg.register(name, predicate);
  }
  // GAP-041 — `requireStepUp` composes M3's `step_up_recent`; decide it from the stand-in attribute.
  reg.register("step_up_recent", async (context) => context.attributes.stepUpRecent === true);
  registerAbacRegistry(reg);

  const app = buildServer({ authenticate: headerAuth, security: { rateLimitEnabled: false } });
  registerEmarRoutes(app, { service: backend });
  return { app, backend };
}

const MD = { "x-test-user": "md_1", "x-test-org": ORG, "x-test-roles": "md" };
const RN = { "x-test-user": "rn_1", "x-test-org": ORG, "x-test-roles": "rn" };
const CHAPLAIN = { "x-test-user": "chap_1", "x-test-org": ORG, "x-test-roles": "chaplain" };
const VIEWER = { "x-test-user": "viewer_1", "x-test-org": ORG, "x-test-roles": "auditor" };
const SUPERVISOR = {
  "x-test-user": "sup_1",
  "x-test-org": ORG,
  "x-test-roles": "clinical_supervisor",
  "x-test-stepup": "fresh",
};
const RN_OFF = { "x-test-user": "rn_off", "x-test-org": ORG, "x-test-roles": "rn" };
/** A caregiver whose portal session is pinned to PATIENT. */
const CAREGIVER = {
  "x-test-user": "cg_1",
  "x-test-org": ORG,
  "x-test-roles": "caregiver",
  "x-test-session-patient": PATIENT,
};

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

  it("an on-caseload RN cannot draw down another patient's comfort kit against their own order (404)", async () => {
    const { app, backend } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/administrations",
      headers: RN,
      payload: recordBody({ comfortKitDeploymentId: OTHER_KIT }),
    });
    expect(res.statusCode).toBe(404);
    expect(await backend.listAdministrations(ORG, { patient: OTHER_PATIENT })).toEqual([]);
    await app.close();
  });

  it("a caregiver session pinned to one patient cannot attest for another (404); its own patient → 201", async () => {
    const { app } = makeServer();
    const attest = (patientId: string) =>
      app.inject({
        method: "POST",
        url: "/api/v1/administrations/caregiver-attested",
        headers: CAREGIVER,
        payload: {
          patientId,
          medicationOrderId: ORDER,
          administeredAt: NOW,
          administeredAmount: 5,
          administeredUnit: "mg",
          route: "oral",
          caregiverAttestationText: "gave the evening dose",
        },
      });
    expect((await attest(OTHER_PATIENT)).statusCode).toBe(404);
    expect((await attest(PATIENT)).statusCode).toBe(201);
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

describe("GAP-004 — witness-attest is unscoped by design; the token is bound to the order's patient", () => {
  const attest = (over: Record<string, unknown> = {}) => ({
    patientId: PATIENT,
    medicationOrderId: CONTROLLED_ORDER,
    administeringClinicianMembershipId: MEM_MD,
    attestationText: "I witnessed the dose",
    ...over,
  });

  it("a witness naming a patient the order is not for is refused (422 PATIENT_ORDER_MISMATCH); an unknown order 422", async () => {
    const { app } = makeServer();
    const wrongPatient = await app.inject({
      method: "POST",
      url: "/api/v1/administrations/witness-attest",
      headers: RN,
      payload: attest({ patientId: OTHER_PATIENT }),
    });
    expect(wrongPatient.statusCode).toBe(422);
    expect(JSON.stringify(wrongPatient.json())).toContain("PATIENT_ORDER_MISMATCH");
    const unknownOrder = await app.inject({
      method: "POST",
      url: "/api/v1/administrations/witness-attest",
      headers: RN,
      payload: attest({ medicationOrderId: FOREIGN_ORDER }),
    });
    expect(unknownOrder.statusCode).toBe(422);
    expect(JSON.stringify(unknownOrder.json())).toContain("MEDICATION_ORDER_UNRESOLVED");
    await app.close();
  });

  it("an off-caseload witness may mint, but the token is honoured only for the named clinician on that order", async () => {
    const { app } = makeServer();
    // rn_off is NOT on PATIENT's caseload and still mints: witnessing is not caseload work.
    const grant = await app.inject({
      method: "POST",
      url: "/api/v1/administrations/witness-attest",
      headers: RN_OFF,
      payload: attest(),
    });
    expect(grant.statusCode).toBe(201);
    // A token minted for a DIFFERENT administering clinician is refused when MD presents it.
    const forSomeoneElse = await app.inject({
      method: "POST",
      url: "/api/v1/administrations/witness-attest",
      headers: RN_OFF,
      payload: attest({ administeringClinicianMembershipId: ADMIN_MEMBERSHIP }),
    });
    expect(forSomeoneElse.statusCode).toBe(201);
    const record = (token: string) =>
      app.inject({
        method: "POST",
        url: "/api/v1/administrations",
        headers: { ...MD, "x-witness-attestation": token },
        payload: recordBody({
          medicationOrderId: CONTROLLED_ORDER,
          medClass: "controlled_substance",
        }),
      });
    const refused = await record(forSomeoneElse.json().token);
    expect(refused.statusCode).toBe(422);
    expect(JSON.stringify(refused.json())).toContain("WITNESS_TOKEN_SCOPE_MISMATCH");
    const ok = await record(grant.json().token);
    expect(ok.statusCode).toBe(201);
    expect(ok.json().witnessMembershipId).toBe(MEM_RN_OFF);
    await app.close();
  });
});

describe("in-memory slice parity — fails closed and refuses cross-patient ids like the DB backend", () => {
  /** The service-level args the record route would hand the slice. */
  const serviceArgs = (over: Partial<RecordAdministrationArgs> = {}): RecordAdministrationArgs => ({
    medicationOrderId: ORDER,
    medClass: "standard",
    mode: "single_dose",
    administeredAt: NOW,
    data: {},
    ...over,
  });

  it("an unseeded or other-tenant order resolves to nothing (the §4.7 resolvers deny)", async () => {
    const { backend } = makeServer();
    const unseeded = "00000000-0000-4000-8000-0000000000ff";
    expect(await backend.loadOrderMedClass(ORG, unseeded)).toBeNull();
    expect(await backend.loadScopePatientId(ORG, "medicationOrderId", unseeded)).toBeNull();
    expect(await backend.loadOrderMedClass(ORG, FOREIGN_ORDER)).toBeNull();
    expect(await backend.loadScopePatientId(ORG, "medicationOrderId", FOREIGN_ORDER)).toBeNull();
    expect(await backend.loadOrderMedClass("org_b", FOREIGN_ORDER)).toBe("standard");
  });

  it("recording against an unresolvable order is refused at the route (403) and in the service (422)", async () => {
    const { app, backend } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/administrations",
      headers: MD,
      payload: recordBody({ medicationOrderId: FOREIGN_ORDER }),
    });
    expect(res.statusCode).toBe(403);
    await expect(
      backend.recordAdministration(ORG, "md_1", serviceArgs({ medicationOrderId: FOREIGN_ORDER })),
    ).rejects.toMatchObject({
      statusCode: 422,
      details: [{ code: "MEDICATION_ORDER_UNRESOLVED" }],
    });
  });

  it("a dose, IV session or comfort kit of another patient is refused against this order (422 PATIENT_ORDER_MISMATCH)", async () => {
    const { backend } = makeServer();
    const mismatch = { statusCode: 422, details: [{ code: "PATIENT_ORDER_MISMATCH" }] };
    const record = (over: Partial<RecordAdministrationArgs>) =>
      backend.recordAdministration(ORG, "md_1", serviceArgs(over));
    await expect(record({ scheduledDoseId: OTHER_DOSE })).rejects.toMatchObject(mismatch);
    await expect(record({ comfortKitDeploymentId: OTHER_KIT })).rejects.toMatchObject(mismatch);
    const otherStart = await record({
      medicationOrderId: OTHER_ORDER,
      mode: "iv_continuous_start",
      data: { infusionRate: 4, rateUnit: "mg/hr" },
    });
    expect(otherStart.patientId).toBe(OTHER_PATIENT);
    await expect(
      record({ mode: "iv_continuous_pause", ivSessionId: otherStart.ivSessionId ?? undefined }),
    ).rejects.toMatchObject(mismatch);
    expect(await backend.listAdministrations(ORG, { patient: PATIENT })).toHaveLength(1); // the seed
  });

  it("a caregiver attestation or a refusal naming another patient than the order's is refused", async () => {
    const { backend } = makeServer();
    const mismatch = { statusCode: 422, details: [{ code: "PATIENT_ORDER_MISMATCH" }] };
    await expect(
      backend.recordCaregiverAttested(ORG, {
        patientId: OTHER_PATIENT,
        medicationOrderId: ORDER,
        administeredAt: NOW,
        caregiverSessionId: "cg-session-1",
        route: "oral",
        doseAmount: 5,
        doseUnit: "mg",
      }),
    ).rejects.toMatchObject(mismatch);
    await expect(
      backend.recordRefusal(ORG, "md_1", {
        patientId: OTHER_PATIENT,
        medicationOrderId: ORDER,
        medClass: "standard",
        refusedAt: NOW,
      }),
    ).rejects.toMatchObject(mismatch);
    expect(await backend.listAdministrations(ORG, { patient: OTHER_PATIENT })).toEqual([]);
  });
});

describe("offline-sync — per-row ABAC evaluated once per distinct target, batch still refused whole", () => {
  const ROWS = 50;
  const row = (over: Record<string, unknown> = {}) =>
    recordBody({
      offlineCapture: {
        deviceId: "77777777-7777-4777-8777-777777777777",
        localId: "88888888-8888-4888-8888-888888888888",
        capturedAt: NOW,
      },
      ...over,
    });

  it(`${ROWS} rows on one order ask the resolver once per predicate, not once per row`, async () => {
    const calls: ResolverCalls = { loadOrderMedClass: 0, loadScopePatientId: 0 };
    const { app } = makeServer({ calls });
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/administrations/offline-sync",
      headers: MD,
      payload: { rows: Array.from({ length: ROWS }, () => row()) },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().synced).toBe(ROWS);
    expect(calls).toEqual({ loadOrderMedClass: 1, loadScopePatientId: 1 });
    await app.close();
  });

  it("one off-scope row among many refuses the whole batch (404) and writes nothing", async () => {
    const calls: ResolverCalls = { loadOrderMedClass: 0, loadScopePatientId: 0 };
    const { app, backend } = makeServer({ calls });
    const rows = Array.from({ length: ROWS }, () => row());
    rows.splice(30, 0, row({ comfortKitDeploymentId: OTHER_KIT }));
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/administrations/offline-sync",
      headers: MD,
      payload: { rows },
    });
    expect(res.statusCode).toBe(404);
    // Only the seeded caregiver row: none of the 50 good rows was written.
    expect(await backend.listAdministrations(ORG, { patient: PATIENT })).toHaveLength(1);
    // Two distinct scope targets (order alone; order + kit), one distinct order.
    expect(calls.loadOrderMedClass).toBe(1);
    await app.close();
  });

  it("one row whose order the caller's discipline may not administer refuses the batch (403)", async () => {
    const { app, backend } = makeServer();
    const rows = Array.from({ length: 5 }, () => row());
    rows.push(row({ medicationOrderId: FOREIGN_ORDER }));
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/administrations/offline-sync",
      headers: MD,
      payload: { rows },
    });
    expect(res.statusCode).toBe(403);
    expect(await backend.listAdministrations(ORG, { patient: PATIENT })).toHaveLength(1);
    await app.close();
  });
});

describe("GAP-041 — POST /api/v1/administrations/:id/void", () => {
  const REASON = "Recorded against the wrong patient chart by mistake; verified with the RN.";
  const committedAdmin = async (_app: unknown): Promise<string> => COMMITTED_ADMIN;
  const voidReq = (
    app: ReturnType<typeof makeServer>["app"],
    id: string,
    headers: Record<string, string>,
    voidReason: string = REASON,
  ) =>
    app.inject({
      method: "POST",
      url: `/api/v1/administrations/${id}/void`,
      headers,
      payload: { voidReason },
    });

  it("refuses a void without a fresh step-up (403 STEP_UP_REQUIRED)", async () => {
    const { app } = makeServer({ withCommittedAdmin: true });
    const id = await committedAdmin(app);
    const res = await voidReq(app, id, { ...SUPERVISOR, "x-test-stepup": "stale" });
    expect(res.statusCode).toBe(403);
    expect(res.json().error?.code ?? res.json().code).toBe("STEP_UP_REQUIRED");
    await app.close();
  });

  it("refuses a holder of administration.void who is below the supervisor floor (403)", async () => {
    const { app } = makeServer({ withCommittedAdmin: true });
    const id = await committedAdmin(app);
    const res = await voidReq(app, id, { ...MD, "x-test-stepup": "fresh" });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("rejects a reason shorter than 40 characters at the schema (400)", async () => {
    const { app } = makeServer({ withCommittedAdmin: true });
    const id = await committedAdmin(app);
    const res = await voidReq(app, id, SUPERVISOR, "x");
    expect(res.statusCode).toBe(422);
    await app.close();
  });

  it("voids a committed row once, and a repeat void is 409 with no second event", async () => {
    const { app, backend } = makeServer({ withCommittedAdmin: true });
    const id = await committedAdmin(app);
    backend.drainEvents();
    const first = await voidReq(app, id, SUPERVISOR);
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json().status).toBe("voided");
    const again = await voidReq(app, id, SUPERVISOR);
    expect(again.statusCode).toBe(409);
    const voidedEvents = backend
      .drainEvents()
      .filter((e) => e.eventName === "m13.administration.voided");
    expect(voidedEvents).toHaveLength(1);
    await app.close();
  });
});

describe("PUT /api/v1/admin/administration-policy — step-up (spec §4.1 route 28 / §4.6)", () => {
  const policyReq = (app: ReturnType<typeof makeServer>["app"], headers: Record<string, string>) =>
    app.inject({
      method: "PUT",
      url: "/api/v1/admin/administration-policy",
      headers,
      payload: { graceWindowMinutes: 45, prnMinimumIntervalMinutes: 120, emarPdfOnCommit: false },
    });

  it("refuses a policy update without a fresh step-up (403 STEP_UP_REQUIRED)", async () => {
    const { app } = makeServer({});
    const res = await policyReq(app, { ...MD, "x-test-stepup": "stale" });
    expect(res.statusCode).toBe(403);
    expect(res.json().error?.code ?? res.json().code).toBe("STEP_UP_REQUIRED");
    await app.close();
  });

  it("accepts a policy update with a fresh step-up", async () => {
    const { app } = makeServer({});
    const res = await policyReq(app, { ...MD, "x-test-stepup": "fresh" });
    expect(res.statusCode, res.body).toBe(200);
    await app.close();
  });
});
