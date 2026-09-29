// apps/backend/__tests__/orm-recovery.test.ts — F-187 (#248): the ATTESTED recovery of a lab order that failed after
// its HL7 message was built, and the resendability of an order the M29 worker refused to persist. The PURE decisions
// (`classifyTransmissionRecovery`, `classifyOrmResend` over `dispatch_refused:*`), the request contract, and the HTTP
// contract of `POST /api/v1/orders/:id/recover-transmission` through the full M1 middleware chain (Fastify `inject`,
// real Authorization Contract, in-memory order backend). The DB behaviour — row lock, conditional update, the
// attestation in the audit diff, single dispatch, RLS — is `m11-orm-recovery.live`.
import {
  createInMemoryEffectivePermissionStore,
  createPredicateRegistry,
  registerAbacRegistry,
  registerEffectivePermissionResolver,
  resetAbacRegistry,
  resetAuthorizationContract,
  resetRbacEngine,
} from "@wardenx/auth";
import { Value } from "@sinclair/typebox/value";
import type { FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import {
  buildOrderAbacPredicates,
  createInMemoryOrderBackend,
  registerOrderRoutes,
} from "../src/modules/11-orders/index";
import {
  DISPATCH_REFUSED_PREFIX,
  ORM_REFUSAL_PREFIX,
  RECOVERABLE_M29_FAILURE_REASONS,
  RECOVERY_ATTESTATIONS,
  RECOVERY_BLOCKED_PREFIX,
  type OrmOutboundEvidence,
  type OrmResendCandidate,
  classifyOrmResend,
  classifyRecoveryContradiction,
  classifyTransmissionRecovery,
} from "../src/modules/11-orders/orm-request/orm-resend";
import { RecoverLabTransmissionRequest } from "../src/modules/11-orders/routes/orders-typebox";

const failed = (reason: string | null, over: Partial<OrmResendCandidate> = {}): OrmResendCandidate => ({
  kind: "lab",
  status: "active",
  transmissionStatus: "failed",
  transmissionFailureReason: reason,
  ...over,
});

describe("F-187 — classifyTransmissionRecovery: which failures an attestation may act on", () => {
  it("the recoverable set is exactly the two M29 terminal reasons (plus F-188's `recovery_blocked:*`, by prefix)", () => {
    expect([...RECOVERABLE_M29_FAILURE_REASONS].sort()).toEqual(["application_reject", "dlq_exhausted"]);
    expect([...RECOVERY_ATTESTATIONS]).toEqual(["not_received_by_lab", "received_by_lab"]);
  });

  it("F-188 — a `recovery_blocked:row_owns_order` order (an attested re-dispatch the worker could not honour) is recoverable AGAIN, but NEVER resendable", () => {
    const reason = `${RECOVERY_BLOCKED_PREFIX}row_owns_order`;
    for (const a of RECOVERY_ATTESTATIONS) {
      expect(classifyTransmissionRecovery(failed(reason), a)).toEqual({ ok: true, priorReason: reason });
    }
    // A row EXISTS for this order, so the plain resend must not act on it (it is neither `orm_refused:` nor `dispatch_refused:`).
    expect(classifyOrmResend(failed(reason))).toMatchObject({ ok: false, code: "not_an_orm_refusal" });
  });

  it.each(["dlq_exhausted", "application_reject"])("a %s failure is recoverable by `not_received_by_lab`", (reason) => {
    expect(classifyTransmissionRecovery(failed(reason), "not_received_by_lab")).toEqual({
      ok: true,
      priorReason: reason,
    });
  });

  it("`received_by_lab` is recoverable for a dlq_exhausted (held / exhausted) order", () => {
    expect(classifyTransmissionRecovery(failed("dlq_exhausted"), "received_by_lab")).toEqual({
      ok: true,
      priorReason: "dlq_exhausted",
    });
  });

  it("an AR-rejected order can NOT be marked received — the lab explicitly refused it", () => {
    expect(classifyTransmissionRecovery(failed("application_reject"), "received_by_lab")).toMatchObject({
      ok: false,
      code: "lab_rejected_order",
    });
  });

  it.each([`${ORM_REFUSAL_PREFIX}patient_dob_missing`, `${DISPATCH_REFUSED_PREFIX}baa_inactive`, "recovery_attested:x", null, ""])(
    "a non-M29-terminal failure (%s) is NOT attestable — those are fixed and re-sent, or already recovered",
    (reason) => {
      for (const a of RECOVERY_ATTESTATIONS) {
        expect(classifyTransmissionRecovery(failed(reason), a)).toMatchObject({
          ok: false,
          code: "not_an_m29_terminal_failure",
        });
      }
    },
  );

  it.each(["pending", "pending_retry", "transmitted", "not_required"])("a %s order is not recoverable (not_failed)", (s) => {
    expect(classifyTransmissionRecovery(failed("dlq_exhausted", { transmissionStatus: s }), "not_received_by_lab")).toMatchObject({
      ok: false,
      code: "not_failed",
    });
  });

  it("a non-lab or non-active order is not recoverable", () => {
    expect(classifyTransmissionRecovery(failed("dlq_exhausted", { kind: "dme" }), "not_received_by_lab")).toMatchObject({
      ok: false,
      code: "not_a_lab_order",
    });
    expect(
      classifyTransmissionRecovery(failed("dlq_exhausted", { status: "discontinued" }), "not_received_by_lab"),
    ).toMatchObject({ ok: false, code: "order_not_active" });
  });
});

describe("F-187 — classifyOrmResend over a worker refusal (dispatch_refused:*)", () => {
  it.each(["no_active_feed", "ambiguous_feed", "no_feed_for_destination", "feed_identity_incomplete", "baa_inactive"])(
    "a dispatch_refused:%s order is resendable — no outbound row exists, so a resend cannot duplicate",
    (reason) => {
      expect(classifyOrmResend(failed(`${DISPATCH_REFUSED_PREFIX}${reason}`))).toEqual({
        ok: true,
        priorReason: `${DISPATCH_REFUSED_PREFIX}${reason}`,
      });
    },
  );

  it("an M29 terminal failure is STILL not resendable — it needs the attested recovery, and the message says so", () => {
    const v = classifyOrmResend(failed("dlq_exhausted"));
    expect(v).toMatchObject({ ok: false, code: "not_an_orm_refusal" });
    expect((v as { message: string }).message).toContain("attested recovery");
  });

  it("a recovered order's attestation marker is not a resendable reason either", () => {
    expect(classifyOrmResend(failed("recovery_attested:not_received_by_lab:abc"))).toMatchObject({
      ok: false,
      code: "not_an_orm_refusal",
    });
  });
});

const EVIDENCE = { contactName: "Dana Reyes", labReference: "REF-2026-0041" };

describe("F-187/F-188 — RecoverLabTransmissionRequest: the attestation is required, closed, and carries STRUCTURED evidence", () => {
  it.each(["not_received_by_lab", "received_by_lab"])("accepts attestation %s with evidence", (attestation) => {
    expect(Value.Check(RecoverLabTransmissionRequest, { attestation, ...EVIDENCE })).toBe(true);
  });
  it.each([
    {},
    { ...EVIDENCE },
    { attestation: "maybe", ...EVIDENCE },
    { attestation: "", ...EVIDENCE },
    { attestation: null, ...EVIDENCE },
    { attestation: "received_by_lab", ...EVIDENCE, note: "called Sam" },
  ])("rejects %j", (body) => {
    expect(Value.Check(RecoverLabTransmissionRequest, body)).toBe(false);
  });

  // F-188 — the evidence is REQUIRED (an attestation with no evidence is just a click) and shaped so it cannot carry
  // a patient identifier: a contact NAME has no digits, a lab REFERENCE has no spaces.
  it.each([
    ["no contact name", { attestation: "not_received_by_lab", labReference: "REF-2026-0041" }],
    ["no lab reference", { attestation: "not_received_by_lab", contactName: "Dana Reyes" }],
    ["a blank contact name", { attestation: "not_received_by_lab", contactName: "", labReference: "REF-2026-0041" }],
    ["a one-letter contact name", { attestation: "not_received_by_lab", contactName: "D", labReference: "REF-2026-0041" }],
    ["digits in the contact name (an MRN / DOB / phone could ride in it)", { attestation: "not_received_by_lab", contactName: "Dana 555-0100", labReference: "REF-2026-0041" }],
    ["a contact name that starts with punctuation", { attestation: "not_received_by_lab", contactName: "-Dana", labReference: "REF-2026-0041" }],
    ["a contact name over 80 characters", { attestation: "not_received_by_lab", contactName: "D".repeat(81), labReference: "REF-2026-0041" }],
    ["a lab reference with spaces (free text — a name could ride in it)", { attestation: "not_received_by_lab", contactName: "Dana Reyes", labReference: "REF 2026 0041" }],
    ["a lab reference that is too short", { attestation: "not_received_by_lab", contactName: "Dana Reyes", labReference: "R1" }],
    ["a lab reference over 64 characters", { attestation: "not_received_by_lab", contactName: "Dana Reyes", labReference: "R".repeat(65) }],
    ["a lab reference with a comma / paren", { attestation: "not_received_by_lab", contactName: "Dana Reyes", labReference: "REF(2026),41" }],
  ])("rejects %s", (_label, body) => {
    expect(Value.Check(RecoverLabTransmissionRequest, body)).toBe(false);
  });
});

describe("F-188 — classifyRecoveryContradiction: inbound evidence that refutes `not_received_by_lab`", () => {
  const clean = { resultsStatus: "not_expected", resultsFirstReceivedAt: null };
  const noTraffic: OrmOutboundEvidence = { owningRowStatuses: [], labObservationCount: 0 };

  it("no contradiction when the lab has returned nothing and no row owns the order", () => {
    expect(classifyRecoveryContradiction("not_received_by_lab", clean, noTraffic)).toBeNull();
  });

  it.each([
    ["partial_results_received", null],
    ["results_received", null],
    ["awaiting_results", new Date("2026-06-01T00:00:00Z")],
  ])("a result already returned (results_status=%s, first_received=%s) refutes it — lab_result_received", (resultsStatus, at) => {
    expect(
      classifyRecoveryContradiction("not_received_by_lab", { resultsStatus, resultsFirstReceivedAt: at }, noTraffic),
    ).toMatchObject({ code: "lab_result_received" });
  });

  it("an M29 `lab_observation` matched to the order refutes it — lab_result_received", () => {
    expect(
      classifyRecoveryContradiction("not_received_by_lab", clean, { owningRowStatuses: [], labObservationCount: 1 }),
    ).toMatchObject({ code: "lab_result_received" });
  });

  it("an `acked` outbound row refutes it — lab_acknowledged", () => {
    expect(
      classifyRecoveryContradiction("not_received_by_lab", clean, { owningRowStatuses: ["acked"], labObservationCount: 0 }),
    ).toMatchObject({ code: "lab_acknowledged" });
  });

  it.each(["queued", "in_flight"])("a %s outbound row refutes it — send_in_progress (a second send would duplicate)", (s) => {
    expect(
      classifyRecoveryContradiction("not_received_by_lab", clean, { owningRowStatuses: [s], labObservationCount: 0 }),
    ).toMatchObject({ code: "send_in_progress" });
  });

  it("a result outranks an ack (the most conclusive evidence is reported)", () => {
    expect(
      classifyRecoveryContradiction("not_received_by_lab", clean, { owningRowStatuses: ["acked"], labObservationCount: 2 }),
    ).toMatchObject({ code: "lab_result_received" });
  });

  it("FAILS CLOSED when the evidence cannot be read: absent evidence is `evidence_unavailable`, never 'no contradiction'", () => {
    expect(classifyRecoveryContradiction("not_received_by_lab", clean, null)).toMatchObject({
      code: "evidence_unavailable",
    });
  });

  it("`received_by_lab` is never blocked — it sends nothing, and inbound evidence can only agree with it", () => {
    expect(classifyRecoveryContradiction("received_by_lab", { resultsStatus: "results_received", resultsFirstReceivedAt: new Date() }, { owningRowStatuses: ["acked", "queued"], labObservationCount: 3 })).toBeNull();
    expect(classifyRecoveryContradiction("received_by_lab", clean, null)).toBeNull();
  });
});

// ── HTTP contract ────────────────────────────────────────────────────────────────────────────────────────────

function headerAuth(request: FastifyRequest): void {
  const user = request.headers["x-test-user"];
  if (typeof user !== "string" || user.length === 0) return;
  request.context.userId = user;
  request.context.attributes.membershipId = user;
  const org = request.headers["x-test-org"];
  request.context.organizationId = typeof org === "string" ? org : "";
  const roles = request.headers["x-test-roles"];
  request.context.roles = typeof roles === "string" && roles.length > 0 ? roles.split(",") : [];
  // F-188 — the harness's stand-in for the server-verified step-up state the authenticate hook stamps
  // (`stepUpFreshFor`); the real predicate is M3's `step_up_recent`, exercised in `abac-step-up-boot.test.ts`.
  request.context.attributes.stepUpRecent = request.headers["x-test-stepup"] === "fresh";
}

const ORG = "org_a";
const PATIENT = "11111111-1111-4111-8111-111111111111";
const ADMISSION = "33333333-3333-4333-8333-333333333333";
const PHYS = "44444444-4444-4444-8444-444444444444";
const NOW = "2026-06-08T12:00:00.000Z";

const PERMISSION_SEED = [
  { userId: "rn_1", permissions: ["orders.read", "orders.draft", "orders.sign", "orders.amend"] },
  { userId: "rn_no_amend", permissions: ["orders.read", "orders.draft", "orders.sign"] },
  { userId: "viewer_1", permissions: ["orders.read"] },
];

function makeServer() {
  const backend = createInMemoryOrderBackend({ now: () => NOW, timeZone: "America/New_York" });
  const grantStore = createInMemoryEffectivePermissionStore(
    PERMISSION_SEED.map((s) => ({
      orgId: ORG,
      userId: s.userId,
      grants: [{ roleKey: "seed", enabled: true, expiresAt: null, permissionKeys: s.permissions }],
    })),
  );
  registerEffectivePermissionResolver(grantStore.store);
  const reg = createPredicateRegistry();
  for (const [name, predicate] of Object.entries(buildOrderAbacPredicates({ resolver: backend }))) {
    reg.register(name, predicate);
  }
  // F-188 — `requireStepUp("order.recover_transmission")` composes M3's `step_up_recent` (not an M11 predicate; the
  // `ai-platform-inject` precedent): the harness decides it from the stand-in attribute above.
  reg.register("step_up_recent", async (context) => context.attributes.stepUpRecent === true);
  registerAbacRegistry(reg);
  const app = buildServer({ authenticate: headerAuth, security: { rateLimitEnabled: false } });
  registerOrderRoutes(app, { service: backend });
  return { app, backend };
}

const RN = { "x-test-user": "rn_1", "x-test-org": ORG, "x-test-roles": "rn_case_manager", "x-test-stepup": "fresh" };
/** Holds `orders.amend` but has NOT completed a fresh step-up (F-188). */
const RN_NO_STEPUP = { "x-test-user": "rn_1", "x-test-org": ORG, "x-test-roles": "rn_case_manager" };
const RN_NO_AMEND = { "x-test-user": "rn_no_amend", "x-test-org": ORG, "x-test-roles": "rn_case_manager", "x-test-stepup": "fresh" };
const VIEWER = { "x-test-user": "viewer_1", "x-test-org": ORG, "x-test-roles": "auditor", "x-test-stepup": "fresh" };
const UNKNOWN_ORDER = "99999999-9999-4999-8999-999999999999";
const ATTEST = { attestation: "not_received_by_lab", ...EVIDENCE };

const labBody = {
  patientId: PATIENT,
  admissionId: ADMISSION,
  kind: "lab",
  drafterDiscipline: "rn_case_manager",
  data: {
    testCodes: [{ system: "http://loinc.org", code: "2160-0", display: "Creatinine" }],
    priority: "routine",
    fastingRequired: false,
  },
  orderingPhysicianMdmId: PHYS,
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

describe("F-187 — POST /api/v1/orders/:id/recover-transmission", () => {
  async function draft(app: ReturnType<typeof makeServer>["app"]): Promise<string> {
    const res = await app.inject({ method: "POST", url: "/api/v1/orders", headers: RN, payload: labBody });
    expect(res.statusCode).toBe(201);
    return res.json().id as string;
  }
  const url = (id: string) => `/api/v1/orders/${id}/recover-transmission`;

  it("is gated on orders.amend: read-only and clinician-without-amend are 403", async () => {
    const { app } = makeServer();
    const id = await draft(app);
    for (const headers of [VIEWER, RN_NO_AMEND]) {
      const res = await app.inject({ method: "POST", url: url(id), headers, payload: ATTEST });
      expect(res.statusCode).toBe(403);
    }
    await app.close();
  });

  // F-188 — BOTH attestations are step-up gated: a wrong `not_received_by_lab` orders the test twice, a wrong
  // `received_by_lab` hides an order the lab never got.
  it.each(["not_received_by_lab", "received_by_lab"])(
    "a caller who holds orders.amend but has NO fresh step-up is 403 for `%s` — and nothing is emitted",
    async (attestation) => {
      const { app, backend } = makeServer();
      const id = await draft(app);
      backend.drainEvents();
      const res = await app.inject({
        method: "POST",
        url: url(id),
        headers: RN_NO_STEPUP,
        payload: { attestation, ...EVIDENCE },
      });
      expect(res.statusCode).toBe(403);
      expect(backend.drainEvents()).toEqual([]);
      await app.close();
    },
  );

  it("with a fresh step-up the same caller passes the gate (it then reaches the service: a fresh draft is 409, not 403)", async () => {
    const { app } = makeServer();
    const id = await draft(app);
    const res = await app.inject({ method: "POST", url: url(id), headers: RN, payload: ATTEST });
    expect(res.statusCode).toBe(409);
    await app.close();
  });

  it("is unauthenticated-safe: no session is 401", async () => {
    const { app } = makeServer();
    const res = await app.inject({ method: "POST", url: url(UNKNOWN_ORDER), payload: ATTEST });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("an unknown order is 404", async () => {
    const { app } = makeServer();
    const res = await app.inject({ method: "POST", url: url(UNKNOWN_ORDER), headers: RN, payload: ATTEST });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("a malformed order id is a 422 VALIDATION_FAILED, not a 500", async () => {
    const { app } = makeServer();
    const res = await app.inject({ method: "POST", url: url("not-a-uuid"), headers: RN, payload: ATTEST });
    expect(res.statusCode).toBe(422);
    await app.close();
  });

  it.each([
    ["no body", undefined],
    ["an empty body", {}],
    ["an unknown attestation", { attestation: "probably", ...EVIDENCE }],
    ["a free-text note (nothing PHI-shaped may enter the audit diff)", { attestation: "received_by_lab", ...EVIDENCE, note: "spoke with Sam" }],
    ["an attestation with NO evidence (F-188)", { attestation: "received_by_lab" }],
    ["evidence with digits in the contact name (F-188)", { attestation: "received_by_lab", contactName: "Dana 5550100", labReference: "REF-2026-0041" }],
    ["evidence with a spaced (free-text) lab reference (F-188)", { attestation: "received_by_lab", contactName: "Dana Reyes", labReference: "called about Jane Doe" }],
  ])("%s is a 422 — the attestation and its evidence are REQUIRED and closed, and nothing is emitted", async (_label, payload) => {
    const { app, backend } = makeServer();
    const id = await draft(app);
    backend.drainEvents();
    const res = await app.inject({ method: "POST", url: url(id), headers: RN, payload: payload as never });
    expect(res.statusCode).toBe(422);
    expect(backend.drainEvents()).toEqual([]);
    await app.close();
  });

  it("an order that never failed (a fresh draft) is 409, and nothing is emitted", async () => {
    const { app, backend } = makeServer();
    const id = await draft(app);
    backend.drainEvents();
    const res = await app.inject({ method: "POST", url: url(id), headers: RN, payload: ATTEST });
    expect(res.statusCode).toBe(409);
    expect(res.json().error?.code ?? res.json().code).toBe("CONFLICT");
    expect(backend.drainEvents()).toEqual([]);
    await app.close();
  });
});

// ── F-194 — the two-person control's routes: co-sign (`orders.amend` + step-up) and cancel (`orders.amend`) ───────────
describe("F-194 — POST /api/v1/orders/:id/recover-transmission/:requestId/{cosign,cancel}", () => {
  async function draft(app: ReturnType<typeof makeServer>["app"]): Promise<string> {
    const res = await app.inject({ method: "POST", url: "/api/v1/orders", headers: RN, payload: labBody });
    expect(res.statusCode).toBe(201);
    return res.json().id as string;
  }
  const REQUEST = "88888888-8888-4888-8888-888888888888";
  const cosignUrl = (id: string, requestId = REQUEST) => `/api/v1/orders/${id}/recover-transmission/${requestId}/cosign`;
  const cancelUrl = (id: string, requestId = REQUEST) => `/api/v1/orders/${id}/recover-transmission/${requestId}/cancel`;

  it.each([
    ["cosign", cosignUrl],
    ["cancel", cancelUrl],
  ])("%s is gated on orders.amend: read-only and clinician-without-amend are 403", async (_name, urlOf) => {
    const { app } = makeServer();
    const id = await draft(app);
    for (const headers of [VIEWER, RN_NO_AMEND]) {
      const res = await app.inject({ method: "POST", url: urlOf(id), headers });
      expect(res.statusCode).toBe(403);
    }
    await app.close();
  });

  it("co-sign needs a FRESH step-up — a second person accepting the duplicate risk is gated at least as hard as the attestation — and nothing is emitted", async () => {
    const { app, backend } = makeServer();
    const id = await draft(app);
    backend.drainEvents();
    const res = await app.inject({ method: "POST", url: cosignUrl(id), headers: RN_NO_STEPUP });
    expect(res.statusCode).toBe(403);
    expect(backend.drainEvents()).toEqual([]);
    await app.close();
  });

  it("cancel does NOT need a step-up (it sends nothing and can only prevent a re-dispatch): the same caller passes the gate and reaches the service", async () => {
    const { app } = makeServer();
    const id = await draft(app);
    const res = await app.inject({ method: "POST", url: cancelUrl(id), headers: RN_NO_STEPUP });
    expect(res.statusCode).not.toBe(403);
    expect(res.statusCode).toBe(409); // the in-memory service has no recovery requests: refused, not a 5xx
    await app.close();
  });

  it("with a fresh step-up co-sign passes the gate and reaches the service (409 from the in-memory service, never 403/500)", async () => {
    const { app } = makeServer();
    const id = await draft(app);
    const res = await app.inject({ method: "POST", url: cosignUrl(id), headers: RN });
    expect(res.statusCode).toBe(409);
    await app.close();
  });

  it.each([
    ["cosign", cosignUrl],
    ["cancel", cancelUrl],
  ])("%s: no session is 401, an unknown order is 404, malformed ids are 422 (not 500)", async (_name, urlOf) => {
    const { app } = makeServer();
    expect((await app.inject({ method: "POST", url: urlOf(UNKNOWN_ORDER) })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: urlOf(UNKNOWN_ORDER), headers: RN })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: urlOf("not-a-uuid"), headers: RN })).statusCode).toBe(422);
    expect((await app.inject({ method: "POST", url: urlOf(UNKNOWN_ORDER, "not-a-uuid"), headers: RN })).statusCode).toBe(422);
    await app.close();
  });
});
