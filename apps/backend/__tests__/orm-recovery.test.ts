// apps/backend/__tests__/orm-recovery.test.ts — F-184 (#248): the ATTESTED recovery of a lab order that failed after
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
  type OrmResendCandidate,
  classifyOrmResend,
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

describe("F-184 — classifyTransmissionRecovery: which failures an attestation may act on", () => {
  it("the recoverable set is exactly the two M29 terminal reasons", () => {
    expect([...RECOVERABLE_M29_FAILURE_REASONS].sort()).toEqual(["application_reject", "dlq_exhausted"]);
    expect([...RECOVERY_ATTESTATIONS]).toEqual(["not_received_by_lab", "received_by_lab"]);
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

describe("F-184 — classifyOrmResend over a worker refusal (dispatch_refused:*)", () => {
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

describe("F-184 — RecoverLabTransmissionRequest: the attestation is required, closed, and note-free", () => {
  it.each(["not_received_by_lab", "received_by_lab"])("accepts attestation %s", (attestation) => {
    expect(Value.Check(RecoverLabTransmissionRequest, { attestation })).toBe(true);
  });
  it.each([{}, { attestation: "maybe" }, { attestation: "" }, { attestation: null }, { attestation: "received_by_lab", note: "called Sam" }])(
    "rejects %j",
    (body) => {
      expect(Value.Check(RecoverLabTransmissionRequest, body)).toBe(false);
    },
  );
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
  registerAbacRegistry(reg);
  const app = buildServer({ authenticate: headerAuth, security: { rateLimitEnabled: false } });
  registerOrderRoutes(app, { service: backend });
  return { app, backend };
}

const RN = { "x-test-user": "rn_1", "x-test-org": ORG, "x-test-roles": "rn_case_manager" };
const RN_NO_AMEND = { "x-test-user": "rn_no_amend", "x-test-org": ORG, "x-test-roles": "rn_case_manager" };
const VIEWER = { "x-test-user": "viewer_1", "x-test-org": ORG, "x-test-roles": "auditor" };
const UNKNOWN_ORDER = "99999999-9999-4999-8999-999999999999";
const ATTEST = { attestation: "not_received_by_lab" };

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

describe("F-184 — POST /api/v1/orders/:id/recover-transmission", () => {
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
    ["an unknown attestation", { attestation: "probably" }],
    ["a free-text note (nothing PHI-shaped may enter the audit diff)", { attestation: "received_by_lab", note: "spoke with Sam" }],
  ])("%s is a 422 — the attestation is REQUIRED and closed, and nothing is emitted", async (_label, payload) => {
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
