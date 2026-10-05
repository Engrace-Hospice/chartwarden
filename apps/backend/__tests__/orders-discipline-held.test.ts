// apps/backend/__tests__/orders-discipline-held.test.ts — GAP-031 (M11): signer / drafter / recorder
// discipline comes from the authenticated session roles, never from the request body. A body discipline
// the caller does not hold is refused 422 DISCIPLINE_NOT_HELD; the cosign requirement is computed from the
// STORED drafter discipline + the order's own level-of-care payload, not from body signerDiscipline /
// levelChange. Runs the real M3 contract over the in-memory order backend (no live infra).
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
const USERS = ["lpn_1", "rn_1", "md_1", "doc_1"];
const ALL = [
  "orders.read",
  "orders.draft",
  "orders.sign",
  "orders.verbal.record",
  "orders.cosign",
  "orders.sign_on_behalf",
];

function makeServer() {
  const backend = createInMemoryOrderBackend({
    now: () => NOW,
    timeZone: "America/New_York",
    // The service re-checks caseload itself (GAP-030): same single-patient caseload the route is given.
    caseloadPatientIds: async () => [PATIENT],
  });
  registerEffectivePermissionResolver(
    createInMemoryEffectivePermissionStore(
      USERS.map((userId) => ({
        orgId: ORG,
        userId,
        grants: [{ roleKey: "seed", enabled: true, expiresAt: null, permissionKeys: ALL }],
      })),
    ).store,
  );
  const reg = createPredicateRegistry();
  reg.register("caseload_or_scope", async () => true);
  for (const [name, fn] of Object.entries(buildOrderAbacPredicates({ resolver: backend })))
    reg.register(name, fn);
  registerAbacRegistry(reg);
  const app = buildServer({ authenticate: headerAuth, security: { rateLimitEnabled: false } });
  registerOrderRoutes(app, { service: backend, caseloadPatientIds: async () => [PATIENT] });
  return { app, backend };
}

const as = (user: string, roles: string) => ({
  "x-test-user": user,
  "x-test-org": ORG,
  "x-test-roles": roles,
});
const LPN = as("lpn_1", "lpn");
const RN = as("rn_1", "rn_case_manager");
const DOC = as("doc_1", "hospice_physician");

const dmeBody = (drafterDiscipline: string) => ({
  patientId: PATIENT,
  admissionId: ADMISSION,
  kind: "dme",
  drafterDiscipline,
  data: { hcpcs: "E0260" },
  orderingPhysicianMdmId: PHYS,
});
const locBody = (fromLevel: string, toLevel: string) => ({
  patientId: PATIENT,
  admissionId: ADMISSION,
  kind: "level_of_care_change",
  drafterDiscipline: "hospice_physician",
  data: {
    fromLevel,
    toLevel,
    effectiveAt: NOW,
    clinicalJustification: "Uncontrolled symptoms require inpatient symptom management.",
  },
  orderingPhysicianMdmId: PHYS,
});

type Server = ReturnType<typeof makeServer>;
const post = (s: Server, url: string, headers: Record<string, string>, payload: unknown) =>
  s.app.inject({ method: "POST", url, headers, payload: payload as object });

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

describe("GAP-031 — discipline is derived from the session, not the body", () => {
  it("refuses a draft whose claimed drafterDiscipline the caller does not hold (LPN claiming RN)", async () => {
    const s = makeServer();
    const res = await post(s, "/api/v1/orders", LPN, dmeBody("rn_case_manager"));
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("DISCIPLINE_NOT_HELD");
    await s.app.close();
  });

  it("an LPN drafting honestly as lpn still gets cosign_required, whatever signerDiscipline the body claims", async () => {
    const s = makeServer();
    const created = await post(s, "/api/v1/orders", LPN, dmeBody("lpn"));
    expect(created.statusCode).toBe(201);
    const res = await post(s, `/api/v1/orders/${created.json().id}/request-signature`, LPN, {
      signerDiscipline: "lpn",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().cosignRequired).toBe(true);
    await s.app.close();
  });

  it("refuses request-signature naming a signerDiscipline the caller does not hold", async () => {
    const s = makeServer();
    const created = await post(s, "/api/v1/orders", LPN, dmeBody("lpn"));
    const res = await post(s, `/api/v1/orders/${created.json().id}/request-signature`, LPN, {
      signerDiscipline: "medical_director",
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("DISCIPLINE_NOT_HELD");
    await s.app.close();
  });

  it("derives the escalation-jump cosign from the order's own fromLevel/toLevel, not a body levelChange", async () => {
    const s = makeServer();
    const created = await post(s, "/api/v1/orders", DOC, locBody("rhc", "gip"));
    expect(created.statusCode).toBe(201);
    const res = await post(s, `/api/v1/orders/${created.json().id}/request-signature`, DOC, {
      signerDiscipline: "hospice_physician",
      levelChange: { fromLevel: "rhc", toLevel: "chc" }, // a lie: the payload says rhc -> gip
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().cosignRequired).toBe(true);
    await s.app.close();
  });

  it("refuses sign and sign-on-behalf naming a signerDiscipline the caller does not hold", async () => {
    const s = makeServer();
    const created = await post(s, "/api/v1/orders", RN, dmeBody("rn_case_manager"));
    const id = created.json().id as string;
    await post(s, `/api/v1/orders/${id}/request-signature`, RN, {
      signerDiscipline: "rn_case_manager",
    });
    const sign = await post(s, `/api/v1/orders/${id}/sign`, RN, {
      signerDiscipline: "hospice_physician",
      signedAtClient: NOW,
    });
    expect(sign.statusCode).toBe(422);
    expect(sign.json().error.code).toBe("DISCIPLINE_NOT_HELD");
    const behalf = await post(s, `/api/v1/orders/${id}/sign-on-behalf`, RN, {
      signerDiscipline: "medical_director",
      signedAtClient: NOW,
      onBehalfOf: PHYS,
      reason: "Physician unavailable",
    });
    expect(behalf.statusCode).toBe(422);
    expect(behalf.json().error.code).toBe("DISCIPLINE_NOT_HELD");
    await s.app.close();
  });

  it("refuses a verbal recording naming a recorderDiscipline the caller does not hold", async () => {
    const s = makeServer();
    const created = await post(s, "/api/v1/orders", RN, dmeBody("rn_case_manager"));
    const id = created.json().id as string;
    await post(s, `/api/v1/orders/${id}/request-signature`, RN, {
      signerDiscipline: "rn_case_manager",
    });
    const res = await post(s, `/api/v1/orders/${id}/verbal`, LPN, {
      recorderDiscipline: "rn_case_manager",
      verbalAttestation: "x".repeat(120),
      readBackVerified: true,
      effectiveAt: NOW,
      receivedAt: NOW,
      orderingPhysicianMdmId: PHYS,
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("DISCIPLINE_NOT_HELD");
    await s.app.close();
  });
});
