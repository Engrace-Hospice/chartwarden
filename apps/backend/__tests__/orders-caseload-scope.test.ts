// apps/backend/__tests__/orders-caseload-scope.test.ts — GAP-030 (M11): every patient-bearing order route
// is bound to the shared `caseload_or_scope` predicate, and the list / queue reads narrow to the caller's
// caseload. An off-caseload RN gets an empty list, a non-leaking 404 on every :id route; org-wide scope
// roles (medical_director) read across caseloads. Runs the real M3 authorization contract through the
// M1 middleware chain over the in-memory order backend (no live infra).
import {
  createInMemoryEffectivePermissionStore,
  createPredicateRegistry,
  registerAbacRegistry,
  registerEffectivePermissionResolver,
  resetAbacRegistry,
  resetAuthorizationContract,
  resetRbacEngine,
  setBreakGlassAuditHook,
  setBreakGlassChecker,
} from "@chartwarden/auth";
import type { FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import { buildCarePlanAbacPredicates } from "../src/modules/07-care-plan/abac-predicates";
import {
  buildOrderAbacPredicates,
  createInMemoryOrderBackend,
  registerOrderRoutes,
} from "../src/modules/11-orders/index";

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
const OTHER_PATIENT = "22222222-2222-4222-8222-222222222222";
const ADMISSION = "33333333-3333-4333-8333-333333333333";
const PHYS = "44444444-4444-4444-8444-444444444444";
const NOW = "2026-06-08T12:00:00.000Z";
const MISSING_ID = "99999999-9999-4999-8999-999999999999";

const ALL = [
  "orders.read",
  "orders.draft",
  "orders.sign",
  "orders.verbal.record",
  "orders.cosign",
  "orders.discontinue",
  "orders.amend",
  "orders.complete",
  "orders.sign_on_behalf",
  "orders.transmission.recover",
  "orders.standing.manage",
  "orders.standing.spawn",
];

/** userId → the patients on that user's caseload. rn_1 covers PATIENT; rn_2 covers nobody. */
const CASELOAD: Record<string, readonly string[]> = {
  rn_1: [PATIENT],
  rn_2: [],
  rn_3: [OTHER_PATIENT],
  md_1: [],
};

function makeServer() {
  const backend = createInMemoryOrderBackend({
    now: () => NOW,
    timeZone: "America/New_York",
    caseloadPatientIds: async ({ userId }) => CASELOAD[userId] ?? [],
  });
  const store = createInMemoryEffectivePermissionStore(
    Object.keys(CASELOAD).map((userId) => ({
      orgId: ORG,
      userId,
      grants: [
        {
          roleKey: "seed",
          enabled: true,
          expiresAt: null,
          permissionKeys: ALL,
        },
      ],
    })),
  );
  registerEffectivePermissionResolver(store.store);

  const isInCaseload = async (q: { userId: string; patientId: string }) =>
    (CASELOAD[q.userId] ?? []).includes(q.patientId);
  const reg = createPredicateRegistry();
  const m7 = buildCarePlanAbacPredicates({
    resolver: {
      loadPlan: async () => null,
      loadProblem: async () => null,
      loadVersion: async () => null,
    },
    isInCaseload,
  });
  reg.register("caseload_or_scope", m7.caseload_or_scope);
  for (const [name, fn] of Object.entries(buildOrderAbacPredicates({ resolver: backend }))) {
    reg.register(name, fn);
  }
  registerAbacRegistry(reg);

  const app = buildServer({
    authenticate: headerAuth,
    security: { rateLimitEnabled: false },
  });
  registerOrderRoutes(app, {
    service: backend,
    caseloadPatientIds: async ({ userId }) => CASELOAD[userId] ?? [],
  });
  return { app, backend };
}

const as = (user: string, roles = "rn_case_manager") => ({
  "x-test-user": user,
  "x-test-org": ORG,
  "x-test-roles": roles,
});
const RN1 = as("rn_1");
const RN2 = as("rn_2");
const RN3 = as("rn_3");
const MD = as("md_1", "medical_director");

const labBody = (patientId: string) => ({
  patientId,
  admissionId: ADMISSION,
  kind: "lab",
  drafterDiscipline: "rn_case_manager",
  data: {
    testCodes: [{ system: "http://loinc.org", code: "2160-0", display: "Creatinine" }],
    priority: "routine",
    fastingRequired: false,
  },
  orderingPhysicianMdmId: PHYS,
});

type Server = ReturnType<typeof makeServer>;
async function draftFor(s: Server, headers: Record<string, string>, patientId: string) {
  const res = await s.app.inject({
    method: "POST",
    url: "/api/v1/orders",
    headers,
    payload: labBody(patientId),
  });
  expect(res.statusCode).toBe(201);
  return res.json().id as string;
}

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

describe("GAP-030 — list and queue reads narrow to the caseload", () => {
  it("GET /orders returns an empty list to an RN with no caseload and only own patients otherwise", async () => {
    const s = makeServer();
    await draftFor(s, RN1, PATIENT);
    await draftFor(s, RN3, OTHER_PATIENT);

    const none = await s.app.inject({
      method: "GET",
      url: "/api/v1/orders",
      headers: RN2,
    });
    expect(none.statusCode).toBe(200);
    expect(none.json().orders).toEqual([]);

    const mine = await s.app.inject({
      method: "GET",
      url: "/api/v1/orders",
      headers: RN1,
    });
    expect(mine.json().orders.map((o: { patientId: string }) => o.patientId)).toEqual([PATIENT]);
    await s.app.close();
  });

  it("GET /orders?patientId=<off-caseload> is empty, not the patient's orders", async () => {
    const s = makeServer();
    await draftFor(s, RN3, OTHER_PATIENT);
    const res = await s.app.inject({
      method: "GET",
      url: `/api/v1/orders?patientId=${OTHER_PATIENT}`,
      headers: RN1,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().orders).toEqual([]);
    await s.app.close();
  });

  it("an org-wide scope role (medical_director) lists every patient's orders", async () => {
    const s = makeServer();
    await draftFor(s, RN1, PATIENT);
    await draftFor(s, RN3, OTHER_PATIENT);
    const res = await s.app.inject({
      method: "GET",
      url: "/api/v1/orders",
      headers: MD,
    });
    expect(res.json().orders).toHaveLength(2);
    await s.app.close();
  });

  it("the pending-signature queue is narrowed to the caseload", async () => {
    const s = makeServer();
    const mine = await draftFor(s, RN1, PATIENT);
    const theirs = await draftFor(s, RN3, OTHER_PATIENT);
    for (const [id, h] of [
      [mine, RN1],
      [theirs, RN3],
    ] as const) {
      const r = await s.app.inject({
        method: "POST",
        url: `/api/v1/orders/${id}/request-signature`,
        headers: h,
        payload: { signerDiscipline: "rn_case_manager" },
      });
      expect(r.statusCode).toBe(200);
    }
    const res = await s.app.inject({
      method: "GET",
      url: "/api/v1/orders/pending-signature",
      headers: RN1,
    });
    expect(res.json().orders.map((o: { id: string }) => o.id)).toEqual([mine]);
    await s.app.close();
  });

  it("GET /orders/suggestions/:patientId is a 404 off-caseload", async () => {
    const s = makeServer();
    const off = await s.app.inject({
      method: "GET",
      url: `/api/v1/orders/suggestions/${OTHER_PATIENT}`,
      headers: RN1,
    });
    expect(off.statusCode).toBe(404);
    const on = await s.app.inject({
      method: "GET",
      url: `/api/v1/orders/suggestions/${PATIENT}`,
      headers: RN1,
    });
    expect(on.statusCode).toBe(200);
    await s.app.close();
  });
});

describe("GAP-030 — :id routes are a non-leaking 404 off-caseload", () => {
  it("GET /orders/:id: 404 off-caseload, 200 on-caseload, 200 for an org-wide role", async () => {
    const s = makeServer();
    const id = await draftFor(s, RN1, PATIENT);
    expect(
      (
        await s.app.inject({
          method: "GET",
          url: `/api/v1/orders/${id}`,
          headers: RN2,
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await s.app.inject({
          method: "GET",
          url: `/api/v1/orders/${id}`,
          headers: RN1,
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await s.app.inject({
          method: "GET",
          url: `/api/v1/orders/${id}`,
          headers: MD,
        })
      ).statusCode,
    ).toBe(200);
    await s.app.close();
  });

  it("GET /orders/:id for an order that does not exist is a 404 (fail-closed, never an allow)", async () => {
    const s = makeServer();
    const res = await s.app.inject({
      method: "GET",
      url: `/api/v1/orders/${MISSING_ID}`,
      headers: RN1,
    });
    expect(res.statusCode).toBe(404);
    await s.app.close();
  });

  it("PATCH, request-signature, verbal, discontinue and complete are 404 off-caseload", async () => {
    const s = makeServer();
    const id = await draftFor(s, RN1, PATIENT);
    const attempts: Array<[string, string, unknown]> = [
      ["PATCH", `/api/v1/orders/${id}`, { data: labBody(PATIENT).data }],
      ["POST", `/api/v1/orders/${id}/request-signature`, { signerDiscipline: "rn_case_manager" }],
      [
        "POST",
        `/api/v1/orders/${id}/verbal`,
        {
          recorderDiscipline: "rn_case_manager",
          verbalAttestation: "x".repeat(120),
          readBackVerified: true,
          effectiveAt: NOW,
          receivedAt: NOW,
          orderingPhysicianMdmId: PHYS,
        },
      ],
      ["POST", `/api/v1/orders/${id}/discontinue`, { reason: "clinical_change", effectiveAt: NOW }],
      ["POST", `/api/v1/orders/${id}/complete`, { reason: "done" }],
    ];
    for (const [method, url, payload] of attempts) {
      const res = await s.app.inject({
        method: method as "PATCH" | "POST",
        url,
        headers: RN2,
        payload: payload as object,
      });
      expect(res.statusCode, `${method} ${url}`).toBe(404);
    }
    // the order is untouched — the on-caseload RN still sees it as a draft
    const after = await s.app.inject({
      method: "GET",
      url: `/api/v1/orders/${id}`,
      headers: RN1,
    });
    expect(after.json().status).toBe("draft");
    await s.app.close();
  });

  it("an on-caseload RN still edits and requests signature on their own patient's draft", async () => {
    const s = makeServer();
    const id = await draftFor(s, RN1, PATIENT);
    const res = await s.app.inject({
      method: "POST",
      url: `/api/v1/orders/${id}/request-signature`,
      headers: RN1,
      payload: { signerDiscipline: "rn_case_manager" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("pending_signature");
    await s.app.close();
  });
});

const STANDING_BODY = (patientId: string) => ({
  patientId,
  admissionId: ADMISSION,
  kind: "lab",
  signerDiscipline: "rn_case_manager",
  orderingPhysicianMdmId: PHYS,
  cadence: "prn",
  data: { testCodes: labBody(patientId).data.testCodes, fastingRequired: false },
});

const SIGN_PAYLOAD = { signerDiscipline: "rn_case_manager", signedAtClient: NOW };
const CORRECT_PAYLOAD = (patientId: string) => labBody(patientId);

/** Every remaining patient-bearing write route against one order id. */
function orderWrites(id: string): Array<[string, string, unknown]> {
  return [
    ["POST", `/api/v1/orders/${id}/sign`, SIGN_PAYLOAD],
    [
      "POST",
      `/api/v1/orders/${id}/sign-on-behalf`,
      { ...SIGN_PAYLOAD, onBehalfOf: PHYS, reason: "physician unavailable" },
    ],
    [
      "POST",
      `/api/v1/orders/${id}/cosign`,
      { cosignerRole: "rn_case_manager", attestationText: "x".repeat(40) },
    ],
    ["POST", `/api/v1/orders/${id}/correct`, CORRECT_PAYLOAD(PATIENT)],
    ["POST", `/api/v1/orders/${id}/resend-transmission`, {}],
    [
      "POST",
      `/api/v1/orders/${id}/recover-transmission`,
      { attestation: "not_received_by_lab", contactName: "Lab", labReference: "ref-1" },
    ],
    ["POST", `/api/v1/orders/${id}/recover-transmission/${MISSING_ID}/cosign`, {}],
    ["POST", `/api/v1/orders/${id}/recover-transmission/${MISSING_ID}/cancel`, {}],
  ];
}

describe("GAP-030 — sign / cosign / correct / transmission routes are scoped (404 off-caseload)", () => {
  it("is a 404 for an off-caseload actor on every remaining per-order write", async () => {
    const s = makeServer();
    const id = await draftFor(s, RN1, PATIENT);
    for (const [method, url, payload] of orderWrites(id)) {
      const res = await s.app.inject({
        method: method as "POST",
        url,
        headers: RN2,
        payload: payload as object,
      });
      expect(res.statusCode, `${method} ${url}`).toBe(404);
    }
    await s.app.close();
  });

  it("is a 404 for an unknown order id on every per-order write (never an allow)", async () => {
    const s = makeServer();
    for (const [method, url, payload] of orderWrites(MISSING_ID)) {
      const res = await s.app.inject({
        method: method as "POST",
        url,
        headers: RN1,
        payload: payload as object,
      });
      expect(res.statusCode, `${method} ${url}`).toBe(404);
    }
    await s.app.close();
  });

  it("is NOT a scope 404 for an on-caseload actor or an org-wide role (reaches the handler)", async () => {
    const s = makeServer();
    const id = await draftFor(s, RN1, PATIENT);
    const sign = await s.app.inject({
      method: "POST",
      url: `/api/v1/orders/${id}/sign`,
      headers: MD,
      payload: SIGN_PAYLOAD,
    });
    expect(sign.statusCode).not.toBe(404);
    const resend = await s.app.inject({
      method: "POST",
      url: `/api/v1/orders/${id}/resend-transmission`,
      headers: RN1,
      payload: {},
    });
    expect(resend.statusCode).not.toBe(404);
    await s.app.close();
  });

  it("POST /orders and /verbal-orders naming an off-caseload patient are 404", async () => {
    const s = makeServer();
    const create = await s.app.inject({
      method: "POST",
      url: "/api/v1/orders",
      headers: RN2,
      payload: labBody(PATIENT),
    });
    expect(create.statusCode).toBe(404);
    const verbal = await s.app.inject({
      method: "POST",
      url: "/api/v1/verbal-orders",
      headers: RN2,
      payload: {
        order: labBody(PATIENT),
        verbal: {
          recorderDiscipline: "rn_case_manager",
          verbalAttestation: "x".repeat(120),
          readBackVerified: true,
          effectiveAt: NOW,
          receivedAt: NOW,
          orderingPhysicianMdmId: PHYS,
        },
      },
    });
    expect(verbal.statusCode).toBe(404);
    // org-wide role and on-caseload RN still create
    expect(
      (
        await s.app.inject({
          method: "POST",
          url: "/api/v1/orders",
          headers: MD,
          payload: { ...labBody(PATIENT), drafterDiscipline: "medical_director" },
        })
      ).statusCode,
    ).toBe(201);
    await s.app.close();
  });

  it("a malformed create body is still a 400/422, not masked as a 404", async () => {
    const s = makeServer();
    const res = await s.app.inject({
      method: "POST",
      url: "/api/v1/orders",
      headers: RN2,
      payload: { kind: "lab" },
    });
    expect([400, 422]).toContain(res.statusCode);
    await s.app.close();
  });
});

describe("GAP-030 — standing orders are scoped", () => {
  it("create for an off-caseload patient is 404; :id routes are 404 off-caseload and for an unknown id", async () => {
    const s = makeServer();
    const created = await s.app.inject({
      method: "POST",
      url: "/api/v1/standing-orders",
      headers: RN1,
      payload: STANDING_BODY(PATIENT),
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().id as string;
    const offCreate = await s.app.inject({
      method: "POST",
      url: "/api/v1/standing-orders",
      headers: RN2,
      payload: STANDING_BODY(PATIENT),
    });
    expect(offCreate.statusCode).toBe(404);

    const attempts: Array<[string, string, unknown]> = [
      ["GET", `/api/v1/standing-orders/${id}`, undefined],
      ["PATCH", `/api/v1/standing-orders/${id}`, { maxSpawns: 3 }],
      ["POST", `/api/v1/standing-orders/${id}/pause`, undefined],
      ["POST", `/api/v1/standing-orders/${id}/resume`, undefined],
      ["POST", `/api/v1/standing-orders/${id}/discontinue`, {}],
      ["POST", `/api/v1/standing-orders/${id}/spawn`, {}],
    ];
    for (const target of [id, MISSING_ID]) {
      for (const [method, url, payload] of attempts) {
        const res = await s.app.inject({
          method: method as "GET" | "POST" | "PATCH",
          url: url.replace(id, target),
          headers: target === id ? RN2 : RN1,
          ...(payload === undefined ? {} : { payload: payload as object }),
        });
        expect(res.statusCode, `${method} ${url} (${target})`).toBe(404);
      }
    }
    expect(
      (await s.app.inject({ method: "GET", url: `/api/v1/standing-orders/${id}`, headers: RN1 }))
        .statusCode,
    ).toBe(200);
    expect(
      (await s.app.inject({ method: "GET", url: `/api/v1/standing-orders/${id}`, headers: MD }))
        .statusCode,
    ).toBe(200);
    await s.app.close();
  });

  it("the standing-order list narrows to the caseload", async () => {
    const s = makeServer();
    for (const [h, p] of [
      [RN1, PATIENT],
      [RN3, OTHER_PATIENT],
    ] as const) {
      const r = await s.app.inject({
        method: "POST",
        url: "/api/v1/standing-orders",
        headers: h,
        payload: STANDING_BODY(p),
      });
      expect(r.statusCode).toBe(201);
    }
    const mine = await s.app.inject({
      method: "GET",
      url: "/api/v1/standing-orders",
      headers: RN1,
    });
    expect(mine.json().standingOrders.map((t: { patientId: string }) => t.patientId)).toEqual([
      PATIENT,
    ]);
    const all = await s.app.inject({ method: "GET", url: "/api/v1/standing-orders", headers: MD });
    expect(all.json().standingOrders).toHaveLength(2);
    await s.app.close();
  });
});

describe("GAP-030 — break-glass is read-only on orders", () => {
  it("an active break-glass actor can READ an off-caseload order but every WRITE is still 404", async () => {
    const s = makeServer();
    const id = await draftFor(s, RN1, PATIENT);
    setBreakGlassChecker((ctx) => (ctx.userId === "rn_2" ? { eventId: "bg-1" } : null));
    setBreakGlassAuditHook(() => {});

    const read = await s.app.inject({
      method: "GET",
      url: `/api/v1/orders/${id}`,
      headers: RN2,
    });
    expect(read.statusCode).toBe(200);

    const writes: Array<[string, string, unknown]> = [
      ["PATCH", `/api/v1/orders/${id}`, { data: labBody(PATIENT).data }],
      ["POST", `/api/v1/orders/${id}/request-signature`, { signerDiscipline: "rn_case_manager" }],
      ["POST", `/api/v1/orders/${id}/discontinue`, { reason: "clinical_change", effectiveAt: NOW }],
      ["POST", `/api/v1/orders/${id}/complete`, { reason: "done" }],
      ...orderWrites(id),
    ];
    for (const [method, url, payload] of writes) {
      const res = await s.app.inject({
        method: method as "PATCH" | "POST",
        url,
        headers: RN2,
        payload: payload as object,
      });
      expect(res.statusCode, `${method} ${url}`).toBe(404);
    }
    const create = await s.app.inject({
      method: "POST",
      url: "/api/v1/orders",
      headers: RN2,
      payload: labBody(PATIENT),
    });
    expect(create.statusCode).toBe(404);
    await s.app.close();
  });
});
