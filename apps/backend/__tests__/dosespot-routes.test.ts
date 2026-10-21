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
  hasOrgWideScope,
  registerAbacRegistry,
  registerEffectivePermissionResolver,
  resetAbacRegistry,
  resetAuthorizationContract,
  resetRbacEngine,
  setBreakGlassChecker,
} from "@chartwarden/auth";
import type { FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import {
  type DoseSpotRouteSeed,
  MEDICATION_ORDER_LIST_LIMIT,
  buildDoseSpotAbacPredicates,
  createInMemoryDoseSpotBackend,
  registerDoseSpotRoutes,
} from "../src/modules/12-dosespot/index";
import { cosignDraftingDiscipline } from "../src/modules/12-dosespot/prescriber-eligibility";

function headerAuth(request: FastifyRequest): void {
  const user = request.headers["x-test-user"];
  if (typeof user !== "string" || user.length === 0) return;
  request.context.userId = user;
  // dosespot-routes.ts's actorOf() reads the acting MEMBERSHIP id from here (not ctx.userId).
  //
  // GAP-026 — `x-test-membership` lets a case set the two APART. They default to the same string,
  // which is what every pre-existing case here does and is exactly why the id-space bug in
  // `refill_inbox_scope` / `dea_schedule_authorized` was invisible to this suite: the ABAC layer
  // passed `ctx.userId` where a membership id was expected, and with one value for both the
  // comparison still matched. In production they are different values and it never did.
  const membership = request.headers["x-test-membership"];
  request.context.attributes.membershipId =
    typeof membership === "string" && membership.length > 0 ? membership : user;
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
const COSIGN_NAMED_MDM = "44444444-4444-4444-8444-4444444444c0";

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
const HISTORY_RECORD = "00000000-0000-4000-8000-0000000000c1";
// GAP-033 — the caseload axis is keyed by USER id (`patient_assignment.clinician_user_id` in prod).
// `md_1` and `rn_1_user` are assigned PATIENT; `md_off` is not.
const CASELOAD = [
  { organizationId: ORG, userId: "md_1", patientId: PATIENT },
  { organizationId: ORG, userId: "rn_1_user", patientId: PATIENT },
  { organizationId: ORG, userId: "md_2", patientId: PATIENT },
  { organizationId: ORG, userId: "rn_signer", patientId: PATIENT },
  { organizationId: ORG, userId: "rn_verbal", patientId: PATIENT },
  { organizationId: ORG, userId: "lpn_verbal", patientId: PATIENT },
  // GAP-034 — cosign actors.
  { organizationId: ORG, userId: "sup_1", patientId: PATIENT },
  { organizationId: ORG, userId: "sup_2", patientId: PATIENT },
  { organizationId: ORG, userId: "md_named", patientId: PATIENT },
  { organizationId: ORG, userId: "rn_2", patientId: PATIENT },
];
const PERMISSION_SEED = [
  {
    userId: "md_off",
    permissions: [
      ...READ,
      ...WRITE,
      "prescribing.history.read",
      "prescribing.history.reconcile",
      "prescribing.rx_benefit.lookup",
    ],
  },
  // GAP-035 — a second physician, a non-prescriber who holds prescribing.sign, and a verbal recorder.
  { userId: "md_2", permissions: [...READ, ...WRITE] },
  { userId: "rn_signer", permissions: [...READ, "prescribing.sign"] },
  { userId: "rn_verbal", permissions: [...READ, "prescribing.draft", "prescribing.verbal.record"] },
  {
    userId: "lpn_verbal",
    permissions: [...READ, "prescribing.draft", "prescribing.verbal.record"],
  },
  // GAP-034 — cosign actors (a supervisor drafter, a second supervisor, the named physician, a peer RN).
  { userId: "sup_1", permissions: [...READ, "prescribing.draft", "prescribing.cosign"] },
  { userId: "sup_2", permissions: [...READ, "prescribing.cosign"] },
  { userId: "md_named", permissions: [...READ, ...WRITE] },
  { userId: "rn_2", permissions: [...READ, "prescribing.draft", "prescribing.cosign"] },
  { userId: "md_1_hist", permissions: [...READ, "prescribing.history.read"] },
  { userId: "md_1", permissions: [...READ, ...WRITE] },
  { userId: "rn_1", permissions: [...READ, "prescribing.draft", "prescribing.verbal.record"] },
  { userId: "chap_1", permissions: [...READ, "prescribing.draft"] },
  { userId: "viewer_1", permissions: READ },
  // GAP-026 — the same three actors with a USER id distinct from their membership id. The RBAC
  // grant store keys on `context.userId`, so these need their own rows; without them a split-id case
  // 403s at the PERMISSION gate and never reaches the ABAC predicate it means to exercise.
  { userId: "md_1_user", permissions: [...READ, ...WRITE] },
  { userId: "rn_1_user", permissions: [...READ, "prescribing.refill_decide"] },
  { userId: "viewer_1_user", permissions: READ },
];

function makeServer(
  extraOrders: NonNullable<DoseSpotRouteSeed["orders"]> = [],
  extraPrescribers: NonNullable<DoseSpotRouteSeed["prescribers"]> = [],
) {
  const backend = createInMemoryDoseSpotBackend({
    now: () => NOW,
    orders: [
      ...extraOrders,
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
      ...extraPrescribers,
    ],
    // GAP-026 — the caseload axis is keyed by USER id (`patient_assignment.clinician_user_id` in
    // prod), never by membership id. `rn_1` covers this patient while `md_1` is the named prescriber.
    caseloadPatientIds: CASELOAD,
    historyRecords: [{ id: HISTORY_RECORD, organizationId: ORG, patientId: PATIENT }],
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
  // GAP-033 — the shared `caseload_or_scope` (M7 registers it in prod): org-wide role OR caseload on the
  // named patient. Stubbed over the same caseload seed so the route binding is what is under test.
  reg.register("caseload_or_scope", async (context, target) => {
    const patientId = target.patientId;
    if (typeof patientId !== "string") return true;
    if (hasOrgWideScope(context.roles)) return true;
    return CASELOAD.some((c) => c.userId === context.userId && c.patientId === patientId);
  });
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
  // A complete standard.v1 payload (packages/dosespot/src/classes/contracts.ts): request-signature
  // enforces the full clinical shape, so an empty `{}` is (correctly) 422 "not ready for signature".
  data: {
    sigStructured: {
      doseQuantity: 1,
      doseUnit: "tablet",
      route: "oral",
      frequencyCode: "Q6H",
      asNeeded: true,
      asNeededReasonCode: "pain",
    },
    sigFreeText: "1 tablet by mouth every 6 hours as needed for pain",
    refillsAuthorized: 3,
    dispenseQuantity: { value: 28, unit: "tablet" },
    daysSupply: 7,
    daw: false,
  },
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

describe("GAP-035 — sign decides signer eligibility and the named prescriber server-side", () => {
  const MD2 = { "x-test-user": "md_2", "x-test-org": ORG, "x-test-roles": "hospice_physician" };
  const RN_SIGNER = {
    "x-test-user": "rn_signer",
    "x-test-org": ORG,
    "x-test-roles": "rn_case_manager",
  };
  const RN_VERBAL = {
    "x-test-user": "rn_verbal",
    "x-test-org": ORG,
    "x-test-roles": "rn_case_manager",
  };
  const ATTESTATION =
    "Read back and verbally confirmed the complete medication order with the named prescriber at the bedside per section 2.3.";

  async function pendingOrder(app: Awaited<ReturnType<typeof makeServer>>["app"]) {
    const draft = await app.inject({
      method: "POST",
      url: "/api/v1/medication-orders",
      headers: MD,
      payload: stdBody(),
    });
    const id = draft.json().id as string;
    await app.inject({
      method: "POST",
      url: `/api/v1/medication-orders/${id}/request-signature`,
      headers: MD,
      payload: { signerDiscipline: "hospice_physician" },
    });
    return id;
  }
  const sign = (
    app: Awaited<ReturnType<typeof makeServer>>["app"],
    id: string,
    headers: Record<string, string>,
    extra: Record<string, unknown> = {},
  ) =>
    app.inject({
      method: "POST",
      url: `/api/v1/medication-orders/${id}/sign`,
      headers,
      payload: { signedAtClient: NOW, ...extra },
    });

  const recordVerbal = (
    app: Awaited<ReturnType<typeof makeServer>>["app"],
    id: string,
    headers: Record<string, string>,
    namedPrescriberMdmId: string,
  ) =>
    app.inject({
      method: "POST",
      url: `/api/v1/medication-orders/${id}/verbal`,
      headers,
      payload: {
        recorderDiscipline: "rn_case_manager",
        verbalAttestation: ATTESTATION,
        receivedAt: NOW,
        namedPrescriberMdmId,
      },
    });

  it("a non-prescriber role cannot sign by claiming signerDiscipline='hospice_physician' in the body", async () => {
    const { app, backend } = makeServer();
    const id = await pendingOrder(app);
    const res = await sign(app, id, RN_SIGNER, { signerDiscipline: "hospice_physician" });
    expect(res.statusCode).toBe(403);
    expect((await backend.getOrder(ORG, id)).status).toBe("pending_signature");
    await app.close();
  });

  it("a second prescriber cannot sign another prescriber's pending order (SIGNER_NOT_ORDERING_PHYSICIAN)", async () => {
    const { app, backend } = makeServer();
    const id = await pendingOrder(app);
    const res = await sign(app, id, MD2);
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("SIGNER_NOT_ORDERING_PHYSICIAN");
    expect((await backend.getOrder(ORG, id)).status).toBe("pending_signature");
    await app.close();
  });

  it("the client-supplied signerIsOrderingPhysician / signerDiscipline fields are ignored, not honoured", async () => {
    const { app, backend } = makeServer();
    const id = await pendingOrder(app);
    const res = await sign(app, id, MD2, {
      signerIsOrderingPhysician: true,
      signerDiscipline: "hospice_physician",
    });
    expect(res.statusCode).toBe(403);
    expect((await backend.getOrder(ORG, id)).status).toBe("pending_signature");
    await app.close();
  });

  it("verbal follow-up: only the named prescriber signs", async () => {
    const { app, backend } = makeServer();
    const id = await pendingOrder(app);
    // The roster maps md_2 to the named prescriber's MDM id BEFORE the record step (NAMED_PRESCRIBER_NOT_ENROLLED otherwise).
    await backend.enrollPrescriber(ORG, "md_2", ["II", "III"], PHYS);
    const verbal = await recordVerbal(app, id, RN_VERBAL, PHYS);
    expect(verbal.statusCode).toBe(200);
    // The drafter (md_1) is a physician but their roster row does not map to the named prescriber.
    const unmapped = await sign(app, id, MD);
    expect(unmapped.statusCode).toBe(403);
    expect(unmapped.json().error.code).toBe("VERBAL_SIGNER_NOT_NAMED_PRESCRIBER");
    expect((await backend.getOrder(ORG, id)).status).toBe("verbal_pending");
    const ok = await sign(app, id, MD2);
    expect(ok.statusCode).toBe(200);
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
      payload: { signedAtClient: NOW },
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

// ── GAP-026 — `refill_inbox_scope`'s two axes, with the two id spaces held APART ─────────────────
//
// In production the ABAC layer handed the resolver `ctx.userId` (an M2 user id) where the
// named-prescriber comparison expects a `*_membership_id`, and the caseload axis was the literal
// `patientInCaseload: false`. Both disjuncts were therefore false for every real caller: nobody could
// open a refill detail, while the LIST route — whose predicate resolves to allow because there is no
// per-row target — returned every refill in the tenant. These cases give each actor a membership id
// that differs from their user id, which is the only configuration where either bug is visible.
const RN_SPLIT = {
  "x-test-user": "rn_1_user",
  "x-test-membership": "rn_1",
  "x-test-org": ORG,
  "x-test-roles": "rn_case_manager",
};
const MD_SPLIT = {
  "x-test-user": "md_1_user",
  "x-test-membership": "md_1",
  "x-test-org": ORG,
  "x-test-roles": "hospice_physician",
};
const VIEWER_SPLIT = {
  "x-test-user": "viewer_1_user",
  "x-test-membership": "viewer_1",
  "x-test-org": ORG,
  "x-test-roles": "auditor",
};

describe("M12 GAP-026 — refill_inbox_scope resolves each axis in its own id space", () => {
  it("the named prescriber reaches a refill detail when userId ≠ membershipId", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/refills/${REFILL}`,
      headers: MD_SPLIT,
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it("a covering caseload clinician reaches the same detail — the axis that was hardcoded false", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/refills/${REFILL}`,
      headers: RN_SPLIT,
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it("an actor on neither axis is still denied (403) — the gate did not become permissive", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/refills/${REFILL}`,
      headers: VIEWER_SPLIT,
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("the inbox LIST is narrowed to the caller's scope, not the whole tenant", async () => {
    const { app } = makeServer();
    const mine = await app.inject({ method: "GET", url: "/api/v1/refills", headers: RN_SPLIT });
    expect(mine.statusCode).toBe(200);
    expect(mine.json().refills.map((r: { id: string }) => r.id)).toEqual([REFILL]);

    // A reader on neither axis sees an EMPTY inbox. Their permission (`prescribing.read`) and the
    // list predicate both pass — the service is the only control on this path, and it applied none.
    const theirs = await app.inject({
      method: "GET",
      url: "/api/v1/refills",
      headers: VIEWER_SPLIT,
    });
    expect(theirs.statusCode).toBe(200);
    expect(theirs.json().refills).toEqual([]);
    await app.close();
  });
});

describe("GAP-033 — M12 order + history routes bind caseload_or_scope", () => {
  const OFF = { "x-test-user": "md_off", "x-test-org": ORG, "x-test-roles": "hospice_physician" };
  const get = async (url: string, headers: Record<string, string>) => {
    const { app } = makeServer();
    const res = await app.inject({ method: "GET", url, headers });
    await app.close();
    return res;
  };

  it("an off-caseload prescriber gets 404 on order detail and transmission", async () => {
    expect((await get(`/api/v1/medication-orders/${SOURCE_ORDER}`, OFF)).statusCode).toBe(404);
    expect(
      (await get(`/api/v1/medication-orders/${SOURCE_ORDER}/transmission`, OFF)).statusCode,
    ).toBe(404);
  });

  it("an on-caseload prescriber reads the same order (200)", async () => {
    expect((await get(`/api/v1/medication-orders/${SOURCE_ORDER}`, MD)).statusCode).toBe(200);
  });

  it("an unknown order id is 404 for everyone (no existence oracle)", async () => {
    const missing = "00000000-0000-4000-8000-0000000000ff";
    expect((await get(`/api/v1/medication-orders/${missing}`, MD)).statusCode).toBe(404);
  });

  it("an off-caseload prescriber gets 404 on active medications and history", async () => {
    expect((await get(`/api/v1/patients/${PATIENT}/medications/active`, OFF)).statusCode).toBe(404);
    expect((await get(`/api/v1/patients/${PATIENT}/medications/history`, OFF)).statusCode).toBe(
      404,
    );
    expect((await get(`/api/v1/patients/${PATIENT}/medications/active`, MD)).statusCode).toBe(200);
  });

  it("an off-caseload prescriber cannot discontinue, edit, refresh history or reconcile (404)", async () => {
    const { app } = makeServer();
    const calls = [
      ["POST", `/api/v1/medication-orders/${SOURCE_ORDER}/discontinue`, { reason: "x" }],
      ["PATCH", `/api/v1/medication-orders/${SOURCE_ORDER}`, { drugName: "x" }],
      ["POST", `/api/v1/patients/${PATIENT}/medications/history/refresh`, {}],
      [
        "POST",
        `/api/v1/medication-history-records/${HISTORY_RECORD}/reconcile`,
        { decision: "document_only" },
      ],
      ["POST", "/api/v1/medication-orders", stdBody()],
    ] as const;
    for (const [method, url, payload] of calls) {
      const res = await app.inject({ method, url, headers: OFF, payload });
      expect(res.statusCode, `${method} ${url}`).toBe(404);
    }
    await app.close();
  });

  it("listOrders is narrowed to the caseload: off-caseload sees none, on-caseload sees the order", async () => {
    const off = await get("/api/v1/medication-orders", OFF);
    expect(off.statusCode).toBe(200);
    expect(off.json().orders).toEqual([]);
    const on = await get("/api/v1/medication-orders", MD);
    expect(on.json().orders.map((o: { id: string }) => o.id)).toEqual([SOURCE_ORDER]);
  });

  it("an org-wide oversight role lists every order without a caseload row", async () => {
    const director = {
      "x-test-user": "md_off",
      "x-test-org": ORG,
      "x-test-roles": "medical_director",
    };
    const res = await get("/api/v1/medication-orders", director);
    expect(res.json().orders).toHaveLength(1);
  });

  it("listOrders never returns more than MEDICATION_ORDER_LIST_LIMIT rows", async () => {
    const many = Array.from({ length: MEDICATION_ORDER_LIST_LIMIT + 5 }, (_, i) => ({
      id: `00000000-0000-4000-8000-${(0x5000 + i).toString(16).padStart(12, "0")}`,
      organizationId: ORG,
      patientId: PATIENT,
      admissionId: ADMISSION,
      medClass: "standard" as const,
    }));
    const backend = createInMemoryDoseSpotBackend({ now: () => NOW, orders: many });
    const { orders } = await backend.listOrders(ORG, { scope: { orgWide: true, userId: "" } });
    expect(orders).toHaveLength(MEDICATION_ORDER_LIST_LIMIT);
  });
});

describe("GAP-033 (round 2) — sign / cosign / complete / retransmit scope + mutating routes refuse break-glass", () => {
  const OFF = { "x-test-user": "md_off", "x-test-org": ORG, "x-test-roles": "hospice_physician" };
  const DIRECTOR = {
    "x-test-user": "md_off",
    "x-test-org": ORG,
    "x-test-roles": "medical_director",
  };
  const MISSING = "00000000-0000-4000-8000-0000000000ff";
  const o = (suffix: string, id = SOURCE_ORDER) => `/api/v1/medication-orders/${id}/${suffix}`;
  const previously_unscoped = [
    ["sign", { signedAtClient: NOW }],
    ["sign-controlled/initiate", { schedule: "II" }],
    ["sign-controlled/complete", { nonce: "123456" }],
    ["cosign", { cosignerRole: "hospice_physician", attestationText: "x" }],
    ["complete", { reason: "x" }],
    ["retransmit", {}],
  ] as const;

  it("an off-caseload actor with the permission gets 404 on every previously-unscoped route", async () => {
    const { app } = makeServer();
    for (const [suffix, payload] of previously_unscoped) {
      const res = await app.inject({ method: "POST", url: o(suffix), headers: OFF, payload });
      expect(res.statusCode, suffix).toBe(404);
    }
    await app.close();
  });

  it("an unknown order id is 404 on every previously-unscoped route, even for an org-wide role", async () => {
    const { app } = makeServer();
    for (const [suffix, payload] of previously_unscoped) {
      const res = await app.inject({
        method: "POST",
        url: o(suffix, MISSING),
        headers: DIRECTOR,
        payload,
      });
      expect(res.statusCode, suffix).toBe(404);
    }
    await app.close();
  });

  it("on-caseload and org-wide actors pass the scope gate (any non-404 from the service layer)", async () => {
    const { app } = makeServer();
    for (const headers of [MD, DIRECTOR]) {
      // retransmit is excluded: the service itself 404s an order that is not transmission_failed.
      for (const [suffix, payload] of previously_unscoped.filter(([s]) => s !== "retransmit")) {
        const res = await app.inject({ method: "POST", url: o(suffix), headers, payload });
        expect(res.statusCode, suffix).not.toBe(404);
      }
    }
    await app.close();
  });

  it("an active break-glass grant does NOT open a mutating route to an off-caseload actor", async () => {
    setBreakGlassChecker(() => ({ eventId: "bg_1" }));
    const { app } = makeServer();
    const calls = [
      ...previously_unscoped.map(([s, p]) => ["POST", o(s), p] as const),
      ["POST", o("discontinue"), { reason: "x" }],
      ["PATCH", `/api/v1/medication-orders/${SOURCE_ORDER}`, { drugName: "x" }],
      ["POST", `/api/v1/patients/${PATIENT}/medications/history/refresh`, {}],
      ["POST", "/api/v1/medication-orders", stdBody()],
      ["POST", "/api/v1/rx-benefit/lookup", { patientId: PATIENT, rxnormRxcui: "161" }],
    ] as const;
    for (const [method, url, payload] of calls) {
      const res = await app.inject({ method, url, headers: OFF, payload });
      expect(res.statusCode, `${method} ${url}`).toBe(404);
    }
    await app.close();
  });

  it("an active break-glass grant still opens READS for an off-caseload actor", async () => {
    setBreakGlassChecker(() => ({ eventId: "bg_1" }));
    const { app } = makeServer();
    const res = await app.inject({
      method: "GET",
      url: o("transmission").replace(/\/transmission$/, ""),
      headers: OFF,
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });
});

describe("GAP-035 follow-up — request-signature derives the discipline from the session", () => {
  const RN_VERBAL = {
    "x-test-user": "rn_verbal",
    "x-test-org": ORG,
    "x-test-roles": "rn_case_manager",
  };
  async function draftId(app: Awaited<ReturnType<typeof makeServer>>["app"]) {
    const draft = await app.inject({
      method: "POST",
      url: "/api/v1/medication-orders",
      headers: MD,
      payload: stdBody(),
    });
    return draft.json().id as string;
  }
  const requestSignature = (
    app: Awaited<ReturnType<typeof makeServer>>["app"],
    id: string,
    headers: Record<string, string>,
    signerDiscipline: string,
  ) =>
    app.inject({
      method: "POST",
      url: `/api/v1/medication-orders/${id}/request-signature`,
      headers,
      payload: { signerDiscipline },
    });

  it("refuses a claimed discipline the caller does not hold (422 DISCIPLINE_NOT_HELD) and leaves the order a draft", async () => {
    const { app, backend } = makeServer();
    const id = await draftId(app);
    const res = await requestSignature(app, id, RN_VERBAL, "hospice_physician");
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("DISCIPLINE_NOT_HELD");
    expect((await backend.getOrder(ORG, id)).status).toBe("draft");
    await app.close();
  });

  it("accepts a claimed discipline the caller holds (RN drafting on behalf of the prescriber)", async () => {
    const { app } = makeServer();
    const id = await draftId(app);
    const res = await requestSignature(app, id, RN_VERBAL, "rn_case_manager");
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("pending_signature");
    await app.close();
  });
});

describe("GAP-035 follow-up — retransmit applies the sign standing rule", () => {
  const FAILED = "00000000-0000-4000-8000-0000000000d1";
  const failedOrder = {
    id: FAILED,
    organizationId: ORG,
    patientId: PATIENT,
    admissionId: ADMISSION,
    medClass: "standard" as const,
    status: "transmission_failed" as const,
    prescriberMembershipId: "md_1",
    prescribingPhysicianMdmId: PHYS,
    drugName: "Acetaminophen",
    refillsRemaining: 3,
  };
  const MD2 = { "x-test-user": "md_2", "x-test-org": ORG, "x-test-roles": "hospice_physician" };
  const RN_SIGNER = {
    "x-test-user": "rn_signer",
    "x-test-org": ORG,
    "x-test-roles": "rn_case_manager",
  };
  const retransmit = (
    app: Awaited<ReturnType<typeof makeServer>>["app"],
    headers: Record<string, string>,
  ) =>
    app.inject({
      method: "POST",
      url: `/api/v1/medication-orders/${FAILED}/retransmit`,
      headers,
      payload: {},
    });

  it("a non-prescriber role holding prescribing.sign is refused by the signer ABAC", async () => {
    const { app } = makeServer([failedOrder]);
    const res = await retransmit(app, RN_SIGNER);
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("a physician who is neither the author nor the mapped named physician is refused", async () => {
    const { app } = makeServer([failedOrder]);
    const res = await retransmit(app, MD2);
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("SIGNER_NOT_ORDERING_PHYSICIAN");
    await app.close();
  });

  it("the authoring prescriber may retransmit (mints a corrected draft)", async () => {
    const { app } = makeServer([failedOrder]);
    const res = await retransmit(app, MD);
    expect(res.statusCode).toBe(201);
    expect(typeof res.json().newOrderId).toBe("string");
    await app.close();
  });

  it("a physician whose roster row maps to the order's named physician may retransmit", async () => {
    const { app, backend } = makeServer([failedOrder]);
    await backend.enrollPrescriber(ORG, "md_2", [], PHYS);
    const res = await retransmit(app, MD2);
    expect(res.statusCode).toBe(201);
    await app.close();
  });

  it("an active break-glass grant does not let an off-roster physician retransmit", async () => {
    setBreakGlassChecker(() => ({ eventId: "bg_1" }));
    const { app } = makeServer([failedOrder]);
    const res = await retransmit(app, MD2);
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  describe("the detail read's viewerMayRetransmit mirrors the same standing rule", () => {
    const detail = (
      app: Awaited<ReturnType<typeof makeServer>>["app"],
      headers: Record<string, string>,
      id = FAILED,
    ) => app.inject({ method: "GET", url: `/api/v1/medication-orders/${id}`, headers });

    it("is true for the order's authoring prescriber", async () => {
      const { app } = makeServer([failedOrder]);
      const res = await detail(app, MD);
      expect(res.statusCode).toBe(200);
      expect(res.json().viewerMayRetransmit).toBe(true);
      await app.close();
    });

    it("is true for a physician whose roster row maps to the order's named physician", async () => {
      const { app, backend } = makeServer([failedOrder]);
      await backend.enrollPrescriber(ORG, "md_2", [], PHYS);
      const res = await detail(app, MD2);
      expect(res.statusCode).toBe(200);
      expect(res.json().viewerMayRetransmit).toBe(true);
      await app.close();
    });

    it("is false for another signer-eligible physician (the write would 403)", async () => {
      const { app } = makeServer([failedOrder]);
      const res = await detail(app, MD2);
      expect(res.statusCode).toBe(200);
      expect(res.json().viewerMayRetransmit).toBe(false);
      expect((await retransmit(app, MD2)).statusCode).toBe(403);
      await app.close();
    });

    it("is false for a non-prescriber discipline holding prescribing.sign", async () => {
      const { app } = makeServer([failedOrder]);
      const res = await detail(app, RN_SIGNER);
      expect(res.statusCode).toBe(200);
      expect(res.json().viewerMayRetransmit).toBe(false);
      await app.close();
    });

    it("is false on an order that is not transmission_failed, even for its prescriber", async () => {
      const { app } = makeServer([failedOrder]);
      const res = await detail(app, MD, SOURCE_ORDER);
      expect(res.statusCode).toBe(200);
      expect(res.json().status).toBe("active");
      expect(res.json().viewerMayRetransmit).toBe(false);
      await app.close();
    });

    it("is never carried on list rows", async () => {
      const { app } = makeServer([failedOrder]);
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/medication-orders?patientId=${PATIENT}`,
        headers: MD,
      });
      expect(res.statusCode).toBe(200);
      const rows = res.json().orders as Array<Record<string, unknown>>;
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) expect(row).not.toHaveProperty("viewerMayRetransmit");
      await app.close();
    });
  });
});

describe("GAP-035 follow-up — verbal record needs an enrolled named prescriber", () => {
  const RN_VERBAL = {
    "x-test-user": "rn_verbal",
    "x-test-org": ORG,
    "x-test-roles": "rn_case_manager",
  };
  const ATTESTATION =
    "Read back and verbally confirmed the complete medication order with the named prescriber at the bedside per section 2.3.";
  async function pendingOrder(app: Awaited<ReturnType<typeof makeServer>>["app"]) {
    const draft = await app.inject({
      method: "POST",
      url: "/api/v1/medication-orders",
      headers: MD,
      payload: stdBody(),
    });
    const id = draft.json().id as string;
    await app.inject({
      method: "POST",
      url: `/api/v1/medication-orders/${id}/request-signature`,
      headers: MD,
      payload: { signerDiscipline: "hospice_physician" },
    });
    return id;
  }
  const record = (
    app: Awaited<ReturnType<typeof makeServer>>["app"],
    id: string,
    namedPrescriberMdmId: string,
  ) =>
    app.inject({
      method: "POST",
      url: `/api/v1/medication-orders/${id}/verbal`,
      headers: RN_VERBAL,
      payload: {
        recorderDiscipline: "rn_case_manager",
        verbalAttestation: ATTESTATION,
        receivedAt: NOW,
        namedPrescriberMdmId,
      },
    });

  it("refuses 422 NAMED_PRESCRIBER_NOT_ENROLLED when no active roster row maps to the named MDM id", async () => {
    const { app, backend } = makeServer();
    const id = await pendingOrder(app);
    backend.drainEvents();
    const res = await record(app, id, PHYS);
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("NAMED_PRESCRIBER_NOT_ENROLLED");
    expect((await backend.getOrder(ORG, id)).status).toBe("pending_signature");
    expect(backend.drainEvents().map((e) => e.eventName)).not.toContain(
      "m12.medication_order.verbal_received",
    );
    await app.close();
  });

  it("a revoked roster row does not count as enrolled", async () => {
    const { app, backend } = makeServer();
    const id = await pendingOrder(app);
    await backend.enrollPrescriber(ORG, "md_2", [], PHYS);
    await backend.revokePrescriber(ORG, "md_2", "left the practice");
    const res = await record(app, id, PHYS);
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("NAMED_PRESCRIBER_NOT_ENROLLED");
    await app.close();
  });

  it("records the verbal order once an active roster row maps to the named MDM id", async () => {
    const { app, backend } = makeServer();
    const id = await pendingOrder(app);
    await backend.enrollPrescriber(ORG, "md_2", [], PHYS);
    const res = await record(app, id, PHYS);
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("verbal_pending");
    await app.close();
  });
});

describe("GAP-035 follow-up — the named-prescriber directory and roster expose the MDM link", () => {
  const RN_VERBAL = {
    "x-test-user": "rn_verbal",
    "x-test-org": ORG,
    "x-test-roles": "rn_case_manager",
  };

  it("lists only ACTIVE prescribers that carry an MDM id, to a caller who may record verbal orders", async () => {
    const { app, backend } = makeServer();
    await backend.enrollPrescriber(ORG, "md_2", [], PHYS);
    await backend.enrollPrescriber(ORG, "md_off", [], "55555555-5555-4555-8555-555555555555");
    await backend.revokePrescriber(ORG, "md_off", "left");
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/prescribing/named-prescribers",
      headers: RN_VERBAL,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().prescribers).toEqual([
      { membershipId: "md_2", externalPhysicianMdmId: PHYS },
    ]);
    await app.close();
  });

  it("is denied to a caller without prescribing.verbal.record", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/prescribing/named-prescribers",
      headers: VIEWER,
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("the admin roster returns each row's externalPhysicianMdmId", async () => {
    const { backend } = makeServer();
    await backend.enrollPrescriber(ORG, "md_2", [], PHYS);
    const { prescribers } = await backend.listPrescribers(ORG);
    expect(prescribers.find((p) => p.membershipId === "md_2")?.externalPhysicianMdmId).toBe(PHYS);
  });
});

describe("GAP-031 parity — verbal / sign-controlled-initiate discipline claims and the RN+ recorder floor", () => {
  const RN_VERBAL = {
    "x-test-user": "rn_verbal",
    "x-test-org": ORG,
    "x-test-roles": "rn_case_manager",
  };
  const LPN_VERBAL = { "x-test-user": "lpn_verbal", "x-test-org": ORG, "x-test-roles": "lpn" };
  const ATTESTATION =
    "Read back and verbally confirmed the complete medication order with the named prescriber at the bedside per section 2.3.";

  async function pendingOrder(app: Awaited<ReturnType<typeof makeServer>>["app"]) {
    const draft = await app.inject({
      method: "POST",
      url: "/api/v1/medication-orders",
      headers: MD,
      payload: stdBody(),
    });
    const id = draft.json().id as string;
    await app.inject({
      method: "POST",
      url: `/api/v1/medication-orders/${id}/request-signature`,
      headers: MD,
      payload: { signerDiscipline: "hospice_physician" },
    });
    return id;
  }
  const verbal = (
    app: Awaited<ReturnType<typeof makeServer>>["app"],
    id: string,
    headers: Record<string, string>,
    recorderDiscipline: string,
  ) =>
    app.inject({
      method: "POST",
      url: `/api/v1/medication-orders/${id}/verbal`,
      headers,
      payload: {
        recorderDiscipline,
        verbalAttestation: ATTESTATION,
        receivedAt: NOW,
        namedPrescriberMdmId: PHYS,
      },
    });

  it("verbal: refuses a recorderDiscipline the caller does not hold (422 DISCIPLINE_NOT_HELD)", async () => {
    const { app, backend } = makeServer();
    const id = await pendingOrder(app);
    await backend.enrollPrescriber(ORG, "md_2", [], PHYS);
    const res = await verbal(app, id, RN_VERBAL, "hospice_physician");
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("DISCIPLINE_NOT_HELD");
    expect((await backend.getOrder(ORG, id)).status).toBe("pending_signature");
    await app.close();
  });

  it("verbal: an LPN (below the RN+ floor) is refused with VERBAL_RECORDER_NOT_ELIGIBLE even claiming its own discipline", async () => {
    const { app, backend } = makeServer();
    const id = await pendingOrder(app);
    await backend.enrollPrescriber(ORG, "md_2", [], PHYS);
    const res = await verbal(app, id, LPN_VERBAL, "lpn");
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.json().error.code).toBe("VERBAL_RECORDER_NOT_ELIGIBLE");
    expect((await backend.getOrder(ORG, id)).status).toBe("pending_signature");
    await app.close();
  });

  it("verbal: an RN-equivalent recorder who holds the claimed discipline succeeds", async () => {
    const { app, backend } = makeServer();
    const id = await pendingOrder(app);
    await backend.enrollPrescriber(ORG, "md_2", [], PHYS);
    const res = await verbal(app, id, RN_VERBAL, "rn_case_manager");
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("verbal_pending");
    await app.close();
  });

  it("sign-controlled initiate: refuses a signerDiscipline the caller does not hold (422 DISCIPLINE_NOT_HELD)", async () => {
    const { app } = makeServer();
    const id = await pendingOrder(app);
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/medication-orders/${id}/sign-controlled/initiate`,
      headers: MD,
      payload: { signerDiscipline: "medical_director", schedule: "II" },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("DISCIPLINE_NOT_HELD");
    await app.close();
  });

  it("the service layer enforces the same guards for a caller that bypasses the route", async () => {
    const { backend, app } = makeServer();
    await expect(
      backend.recordVerbal(ORG, "rn_verbal", "any", {
        recorderDiscipline: "hospice_physician",
        recorderDisciplines: ["rn_case_manager"],
        verbalAttestation: ATTESTATION,
        receivedAt: NOW,
        namedPrescriberMdmId: PHYS,
      }),
    ).rejects.toMatchObject({ code: "DISCIPLINE_NOT_HELD" });
    await expect(
      backend.requestSignature(ORG, "any", "hospice_physician", ["rn_case_manager"]),
    ).rejects.toMatchObject({ code: "DISCIPLINE_NOT_HELD" });
    await expect(
      backend.signControlledInitiate(ORG, "md_1", "any", "II", {
        signerDiscipline: "medical_director",
        signerDisciplines: ["hospice_physician"],
      }),
    ).rejects.toMatchObject({ code: "DISCIPLINE_NOT_HELD" });
    await app.close();
  });
});

describe("MDM-id uniqueness — enrollPrescriber", () => {
  it("the service refuses a second active roster row for the same MDM id (409 MDM_ID_ALREADY_ENROLLED)", async () => {
    const { backend, app } = makeServer();
    await backend.enrollPrescriber(ORG, "md_2", [], PHYS);
    await expect(backend.enrollPrescriber(ORG, "md_3", [], PHYS)).rejects.toMatchObject({
      code: "MDM_ID_ALREADY_ENROLLED",
      statusCode: 409,
    });
    await app.close();
  });

  it("re-enrolling the same membership with its own MDM id is idempotent", async () => {
    const { backend, app } = makeServer();
    await backend.enrollPrescriber(ORG, "md_2", [], PHYS);
    await expect(backend.enrollPrescriber(ORG, "md_2", ["III"], PHYS)).resolves.toMatchObject({
      externalPhysicianMdmId: PHYS,
    });
    await app.close();
  });

  it("a revoked row frees the MDM id for another membership", async () => {
    const { backend, app } = makeServer();
    await backend.enrollPrescriber(ORG, "md_2", [], PHYS);
    await backend.revokePrescriber(ORG, "md_2", "left");
    await expect(backend.enrollPrescriber(ORG, "md_3", [], PHYS)).resolves.toBeDefined();
    await app.close();
  });
});

describe("GAP-034 — cosign is guarded by status, session role, separation of duties, and a real requirement", () => {
  const COSIGN_ORDER = "00000000-0000-4000-8000-0000000000d1";
  const ATTEST =
    "I have reviewed this medication order drafted on behalf of the prescriber and concur.";
  const asUser = (user: string, roles: string) => ({
    "x-test-user": user,
    "x-test-org": ORG,
    "x-test-roles": roles,
  });
  const SUPERVISOR = asUser("sup_2", "clinical_supervisor");
  const MEDICAL_DIRECTOR = asUser("md_off", "medical_director");
  const url = (id = COSIGN_ORDER) => `/api/v1/medication-orders/${id}/cosign`;
  const body = (role: string) => ({ cosignerRole: role, attestationText: ATTEST });
  const rnDrafted = (over: Record<string, unknown> = {}) => ({
    id: COSIGN_ORDER,
    organizationId: ORG,
    patientId: PATIENT,
    admissionId: ADMISSION,
    medClass: "standard" as const,
    status: "pending_signature" as const,
    prescriberMembershipId: "rn_1",
    prescriberDiscipline: "rn_case_manager",
    prescribingPhysicianMdmId: COSIGN_NAMED_MDM,
    cosignRequired: true,
    cosignStatus: "pending" as const,
    ...over,
  });
  const NAMED_PHYSICIAN = [
    { organizationId: ORG, membershipId: "md_named", externalPhysicianMdmId: COSIGN_NAMED_MDM },
  ];
  const makeCosignServer = (orders: Parameters<typeof makeServer>[0]) =>
    makeServer(orders, NAMED_PHYSICIAN);
  const code = (res: { json: () => unknown }) =>
    (res.json() as { error?: { code?: string } }).error?.code;

  it("attaches the cosignature on a pending_signature order that requires one", async () => {
    const { app } = makeCosignServer([rnDrafted()]);
    const res = await app.inject({
      method: "POST",
      url: url(),
      headers: SUPERVISOR,
      payload: body("clinical_supervisor"),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().cosignStatus).toBe("attached");
    await app.close();
  });

  it("refuses a cosign on an order that is not awaiting signature (409), leaving it untouched", async () => {
    for (const status of ["draft", "active", "signed", "discontinued"] as const) {
      const { app, backend } = makeCosignServer([rnDrafted({ status })]);
      const res = await app.inject({
        method: "POST",
        url: url(),
        headers: SUPERVISOR,
        payload: body("clinical_supervisor"),
      });
      expect(res.statusCode, status).toBe(409);
      expect((await backend.getOrder(ORG, COSIGN_ORDER)).cosignStatus).toBe("pending");
      await app.close();
    }
  });

  it("refuses a cosign on an order that requires none, and a second cosign (409)", async () => {
    const none = makeCosignServer([rnDrafted({ cosignRequired: false, cosignStatus: null })]);
    const r1 = await none.app.inject({
      method: "POST",
      url: url(),
      headers: SUPERVISOR,
      payload: body("clinical_supervisor"),
    });
    expect(r1.statusCode).toBe(409);
    expect(code(r1)).toBe("COSIGN_NOT_REQUIRED");
    await none.app.close();
    const done = makeCosignServer([rnDrafted({ cosignStatus: "attached" })]);
    const r2 = await done.app.inject({
      method: "POST",
      url: url(),
      headers: SUPERVISOR,
      payload: body("clinical_supervisor"),
    });
    expect(r2.statusCode).toBe(409);
    expect(code(r2)).toBe("ALREADY_COSIGNED");
    await done.app.close();
  });

  it("sign-controlled/complete refuses 409 COSIGN_REQUIRED while the owed cosign is unattached (EPCS cannot reopen the hole)", async () => {
    const MD_SIGNER = {
      "x-test-user": "md_1",
      "x-test-org": ORG,
      "x-test-roles": "hospice_physician",
    };
    const complete = {
      method: "POST" as const,
      url: `/api/v1/medication-orders/${COSIGN_ORDER}/sign-controlled/complete`,
      headers: MD_SIGNER,
      payload: { nonce: "n1", proof: { factorType: "totp", totpCode: "123456" } },
    };
    const owed = makeCosignServer([rnDrafted({ status: "epcs_identity_pending" })]);
    const res = await owed.app.inject(complete);
    expect(res.statusCode).toBe(409);
    expect(code(res)).toBe("COSIGN_REQUIRED");
    expect((await owed.backend.getOrder(ORG, COSIGN_ORDER)).status).toBe("epcs_identity_pending");
    await owed.app.close();
    // Control: once the cosign is attached the guard no longer fires (the order completes).
    const attached = makeCosignServer([
      rnDrafted({ status: "epcs_identity_pending", cosignStatus: "attached" }),
    ]);
    const ok = await attached.app.inject(complete);
    expect(code(ok)).not.toBe("COSIGN_REQUIRED");
    await attached.app.close();
  });

  it("422 DISCIPLINE_NOT_HELD when the body claims a role the session does not hold", async () => {
    const { app, backend } = makeCosignServer([rnDrafted()]);
    const rn = asUser("rn_2", "rn_case_manager");
    const res = await app.inject({
      method: "POST",
      url: url(),
      headers: rn,
      payload: body("medical_director"),
    });
    expect(res.statusCode).toBe(422);
    expect(code(res)).toBe("DISCIPLINE_NOT_HELD");
    expect((await backend.getOrder(ORG, COSIGN_ORDER)).cosignStatus).toBe("pending");
    await app.close();
  });

  it("403 COSIGNER_ROLE_MISMATCH when the held role is below the one the order demands (peer RN)", async () => {
    const { app } = makeCosignServer([rnDrafted()]);
    const rn = asUser("rn_2", "rn_case_manager");
    const res = await app.inject({
      method: "POST",
      url: url(),
      headers: rn,
      payload: body("rn_case_manager"),
    });
    expect(res.statusCode).toBe(403);
    expect(code(res)).toBe("COSIGNER_ROLE_MISMATCH");
    await app.close();
  });

  it("403 COSIGN_SELF when the cosigner is the drafter", async () => {
    const { app } = makeCosignServer([
      rnDrafted({ prescriberMembershipId: "sup_1", prescriberDiscipline: "clinical_supervisor" }),
    ]);
    const res = await app.inject({
      method: "POST",
      url: url(),
      headers: asUser("sup_1", "clinical_supervisor"),
      payload: body("clinical_supervisor"),
    });
    expect(res.statusCode).toBe(403);
    expect(code(res)).toBe("COSIGN_SELF");
    await app.close();
  });

  it("403 COSIGN_SELF when the cosigner is the named physician who will sign (signer separation)", async () => {
    const { app } = makeCosignServer([rnDrafted()]);
    const res = await app.inject({
      method: "POST",
      url: url(),
      headers: asUser("md_named", "medical_director"),
      payload: body("medical_director"),
    });
    expect(res.statusCode).toBe(403);
    expect(code(res)).toBe("COSIGN_SELF");
    await app.close();
  });

  it("a medical_director who is neither drafter nor signer satisfies the supervisor demand", async () => {
    const { app } = makeCosignServer([rnDrafted()]);
    const res = await app.inject({
      method: "POST",
      url: url(),
      headers: MEDICAL_DIRECTOR,
      payload: body("medical_director"),
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it("request-signature by an RN drafter sets cosign_required + 'pending'; by a physician it does not", async () => {
    const rn = makeCosignServer([
      rnDrafted({
        status: "draft",
        cosignRequired: false,
        cosignStatus: null,
        data: stdBody().data,
      }),
    ]);
    const r1 = await rn.app.inject({
      method: "POST",
      url: `/api/v1/medication-orders/${COSIGN_ORDER}/request-signature`,
      headers: asUser("rn_2", "rn_case_manager"),
      payload: { signerDiscipline: "rn_case_manager" },
    });
    expect(r1.statusCode, r1.body).toBe(200);
    expect(r1.json()).toMatchObject({
      status: "pending_signature",
      cosignRequired: true,
      cosignStatus: "pending",
    });
    await rn.app.close();
    const md = makeCosignServer([
      rnDrafted({
        status: "draft",
        cosignRequired: false,
        cosignStatus: null,
        prescriberMembershipId: "md_1",
        prescriberDiscipline: "hospice_physician",
        data: stdBody().data,
      }),
    ]);
    const r2 = await md.app.inject({
      method: "POST",
      url: `/api/v1/medication-orders/${COSIGN_ORDER}/request-signature`,
      headers: MD,
      payload: { signerDiscipline: "hospice_physician" },
    });
    expect(r2.statusCode).toBe(200);
    expect(r2.json()).toMatchObject({
      status: "pending_signature",
      cosignRequired: false,
      cosignStatus: null,
    });
    await md.app.close();
  });

  it("sign is blocked (409 COSIGN_REQUIRED) until the cosignature is attached", async () => {
    const { app } = makeCosignServer([rnDrafted()]);
    const named = asUser("md_named", "hospice_physician");
    const blocked = await app.inject({
      method: "POST",
      url: `/api/v1/medication-orders/${COSIGN_ORDER}/sign`,
      headers: named,
      payload: { signedAtClient: NOW },
    });
    expect(blocked.statusCode).toBe(409);
    expect(code(blocked)).toBe("COSIGN_REQUIRED");
    await app.inject({
      method: "POST",
      url: url(),
      headers: SUPERVISOR,
      payload: body("clinical_supervisor"),
    });
    const ok = await app.inject({
      method: "POST",
      url: `/api/v1/medication-orders/${COSIGN_ORDER}/sign`,
      headers: named,
      payload: { signedAtClient: NOW },
    });
    expect(ok.statusCode).toBe(200);
    await app.close();
  });
});

describe("GAP-034 follow-up — the drafter discipline is session-derived, stored, and drives the cosign axis", () => {
  // rn_2 is on the PATIENT caseload and holds prescribing.draft (rn_1 is not on it).
  const RN_DRAFTER = {
    "x-test-user": "rn_2",
    "x-test-org": ORG,
    "x-test-roles": "rn_case_manager",
  };
  const draft = (headers: Record<string, string>, over: Record<string, unknown> = {}) =>
    makeServer().app.inject({
      method: "POST",
      url: "/api/v1/medication-orders",
      headers,
      payload: stdBody(over),
    });

  it("a claimed prescriberDiscipline the session does not hold is NOT trusted: the draft is recorded under a held discipline, so claiming physician cannot dodge the cosign", async () => {
    const { app, backend } = makeServer();
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/medication-orders",
      headers: RN_DRAFTER,
      payload: stdBody({ prescriberDiscipline: "hospice_physician" }),
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().id as string;
    expect((await backend.getOrder(ORG, id)).prescriberDiscipline).toBe("rn_case_manager");
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/medication-orders/${id}/request-signature`,
      headers: MD,
      payload: { signerDiscipline: "hospice_physician" },
    });
    expect(res.statusCode).toBe(200);
    expect((await backend.getOrder(ORG, id)).cosignRequired).toBe(true);
  });

  it("a session that holds no discipline at all cannot draft (422)", async () => {
    const res = await draft(
      { ...RN_DRAFTER, "x-test-roles": "" },
      { prescriberDiscipline: "hospice_physician" },
    );
    expect([403, 422]).toContain(res.statusCode);
  });

  it("an RN draft followed by a PHYSICIAN request-signature still requires the cosign", async () => {
    const { app, backend } = makeServer();
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/medication-orders",
      headers: RN_DRAFTER,
      payload: stdBody({ prescriberDiscipline: "rn_case_manager" }),
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().id as string;
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/medication-orders/${id}/request-signature`,
      headers: MD,
      payload: { signerDiscipline: "hospice_physician" },
    });
    expect(res.statusCode).toBe(200);
    const stored = await backend.getOrder(ORG, id);
    expect(stored.cosignRequired).toBe(true);
    expect(stored.cosignStatus).toBe("pending");
    await app.close();
  });

  it("cosignDraftingDiscipline prefers the stored drafter discipline and falls back to the requester only when NULL/blank", () => {
    expect(cosignDraftingDiscipline("rn_case_manager", "hospice_physician")).toBe(
      "rn_case_manager",
    );
    expect(cosignDraftingDiscipline(null, "rn_case_manager")).toBe("rn_case_manager");
    expect(cosignDraftingDiscipline(undefined, "hospice_physician")).toBe("hospice_physician");
    expect(cosignDraftingDiscipline("  ", "rn_case_manager")).toBe("rn_case_manager");
  });
});
