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
} from "@wardenx/auth";
import type { FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import {
  MEDICATION_ORDER_LIST_LIMIT,
  buildDoseSpotAbacPredicates,
  createInMemoryDoseSpotBackend,
  registerDoseSpotRoutes,
} from "../src/modules/12-dosespot/index";

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
    ["sign", { signerDiscipline: "hospice_physician" }],
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
