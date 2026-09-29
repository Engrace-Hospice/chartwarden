// apps/backend/__tests__/orm-resend.test.ts — F-182 (#248): the RESEND of a refused lab ORM. The PURE eligibility
// decision (`classifyOrmResend`) plus the HTTP contract of `POST /api/v1/orders/:id/resend-transmission` through the
// full M1 middleware chain (Fastify `inject`, real Authorization Contract, in-memory order backend). The DB behaviour
// — row lock, conditional update, publish + state in one transaction, audit actor, RLS — is `m11-orm-resend.live`.
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
  buildOrderAbacPredicates,
  createInMemoryOrderBackend,
  registerOrderRoutes,
} from "../src/modules/11-orders/index";
import {
  ORM_REFUSALS_NEEDING_CORRECTED_ORDER,
  type OrmResendCandidate,
  classifyOrmResend,
} from "../src/modules/11-orders/orm-request/orm-resend";

const refused = (reason: string, over: Partial<OrmResendCandidate> = {}): OrmResendCandidate => ({
  kind: "lab",
  status: "active",
  transmissionStatus: "failed",
  transmissionFailureReason: `orm_refused:${reason}`,
  ...over,
});

describe("F-182 — classifyOrmResend: which failures a resend may act on", () => {
  it.each([
    "patient_not_found",
    "patient_merged",
    "patient_mrn_missing",
    "patient_name_missing",
    "patient_dob_missing",
    "patient_sex_unrecorded",
    "patient_sex_unmappable",
    "physician_unresolved",
    "physician_not_active",
    "physician_npi_unconfirmed",
    "physician_name_missing",
    "lab_facility_unresolved",
    "no_active_feed",
    "ambiguous_feed",
    "no_feed_for_destination",
    "feed_identity_incomplete",
    "payload_invalid",
    "dependency_unavailable",
  ])("an orm_refused:%s failure is resendable (the fact lives outside the signed order)", (reason) => {
    const v = classifyOrmResend(refused(reason));
    expect(v).toEqual({ ok: true, priorReason: `orm_refused:${reason}` });
  });

  it("a SUD refusal is never resendable — a compliance decision, not a data fix", () => {
    const v = classifyOrmResend(refused("sud_restricted"));
    expect(v).toMatchObject({ ok: false, code: "sud_restricted" });
  });

  it.each([...ORM_REFUSALS_NEEDING_CORRECTED_ORDER])(
    "%s comes from the immutable signed order — not resendable, needs a corrected order",
    (reason) => {
      expect(classifyOrmResend(refused(reason))).toMatchObject({ ok: false, code: "needs_corrected_order" });
    },
  );

  it("the immutable-order set is exactly the three order-data refusals", () => {
    expect([...ORM_REFUSALS_NEEDING_CORRECTED_ORDER].sort()).toEqual([
      "lab_test_codes_missing",
      "multiple_test_codes_unsupported",
      "no_routing_lab",
    ]);
  });

  it("an M29 terminal failure (dlq_exhausted / application_reject) is not an ORM refusal — no duplicate message", () => {
    for (const reason of ["dlq_exhausted", "application_reject"]) {
      expect(classifyOrmResend(refused("x", { transmissionFailureReason: reason }))).toMatchObject({
        ok: false,
        code: "not_an_orm_refusal",
      });
    }
  });

  it("a failed order with no recorded reason is not resendable", () => {
    expect(classifyOrmResend(refused("x", { transmissionFailureReason: null }))).toMatchObject({
      ok: false,
      code: "not_an_orm_refusal",
    });
  });

  it.each(["pending", "pending_retry", "transmitted", "not_required"])(
    "a %s order is not resendable (not_failed)",
    (transmissionStatus) => {
      expect(classifyOrmResend(refused("patient_sex_unrecorded", { transmissionStatus }))).toMatchObject({
        ok: false,
        code: "not_failed",
      });
    },
  );

  it("a non-lab or non-active order is not resendable", () => {
    expect(classifyOrmResend(refused("no_active_feed", { kind: "dme" }))).toMatchObject({
      ok: false,
      code: "not_a_lab_order",
    });
    expect(classifyOrmResend(refused("no_active_feed", { status: "discontinued" }))).toMatchObject({
      ok: false,
      code: "order_not_active",
    });
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
}

const ORG = "org_a";
const PATIENT = "11111111-1111-4111-8111-111111111111";
const ADMISSION = "33333333-3333-4333-8333-333333333333";
const PHYS = "44444444-4444-4444-8444-444444444444";
const NOW = "2026-06-08T12:00:00.000Z";

const PERMISSION_SEED = [
  {
    userId: "rn_1",
    permissions: ["orders.read", "orders.draft", "orders.sign", "orders.amend", "orders.transmission.recover"],
  },
  // Holds everything a clinician does EXCEPT the amend key.
  { userId: "rn_no_amend", permissions: ["orders.read", "orders.draft", "orders.sign"] },
  // F-200 — holds `orders.amend` (the key the resend USED to be gated on) but NOT the recovery authority the resend is now gated on.
  { userId: "amend_only", permissions: ["orders.read", "orders.draft", "orders.sign", "orders.amend"] },
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
const AMEND_ONLY = { "x-test-user": "amend_only", "x-test-org": ORG, "x-test-roles": "rn_case_manager" };
const VIEWER = { "x-test-user": "viewer_1", "x-test-org": ORG, "x-test-roles": "auditor" };
const UNKNOWN_ORDER = "99999999-9999-4999-8999-999999999999";

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

describe("F-182 — POST /api/v1/orders/:id/resend-transmission", () => {
  async function draft(app: ReturnType<typeof makeServer>["app"]): Promise<string> {
    const res = await app.inject({ method: "POST", url: "/api/v1/orders", headers: RN, payload: labBody });
    expect(res.statusCode).toBe(201);
    return res.json().id as string;
  }

  it("is gated on orders.transmission.recover: read-only, clinician-without-amend and a holder of `orders.amend` ALONE are 403 (F-200)", async () => {
    const { app } = makeServer();
    const id = await draft(app);
    for (const headers of [VIEWER, RN_NO_AMEND, AMEND_ONLY]) {
      const res = await app.inject({
        method: "POST",
        url: `/api/v1/orders/${id}/resend-transmission`,
        headers,
      });
      expect(res.statusCode).toBe(403);
    }
    await app.close();
  });

  it("is unauthenticated-safe: no session is 401", async () => {
    const { app } = makeServer();
    const res = await app.inject({ method: "POST", url: `/api/v1/orders/${UNKNOWN_ORDER}/resend-transmission` });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("an unknown order is 404", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/orders/${UNKNOWN_ORDER}/resend-transmission`,
      headers: RN,
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("a malformed order id is a 422 VALIDATION_FAILED, not a 500", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/orders/not-a-uuid/resend-transmission",
      headers: RN,
    });
    expect(res.statusCode).toBe(422);
    await app.close();
  });

  it("an order that never failed (a fresh draft) is 409, and nothing is emitted", async () => {
    const { app, backend } = makeServer();
    const id = await draft(app);
    backend.drainEvents();
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/orders/${id}/resend-transmission`,
      headers: RN,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error?.code ?? res.json().code).toBe("CONFLICT");
    expect(backend.drainEvents()).toEqual([]);
    await app.close();
  });
});
