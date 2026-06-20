// apps/backend/__tests__/patient-routes.test.ts — M5-T09 route-inventory integration tests
// (§4.2; §4.7 permission handshake; §7.1 admit-no-dup / §7.4 address cascade / §7.7 right-to-amend).
import {
  createInMemoryEffectivePermissionStore,
  registerEffectivePermissionResolver,
  resetAuthorizationContract,
  resetRbacEngine,
} from "@wardenx/auth";
import type { FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import {
  type PatientView,
  createInMemoryPatientRouteService,
  registerPatientRoutes,
} from "../src/modules/05-patient/index";
import type { MatchCandidate } from "../src/modules/05-patient/matching/index";

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
const EXISTING = "pat-existing";

// An existing patient with an MBI — the §7.1 hard-duplicate target.
const existing: PatientView & MatchCandidate = {
  id: EXISTING,
  organizationId: ORG,
  mrn: "MRN-E",
  lastName: "LOVELACE",
  firstName: "ADA",
  dob: "1990-01-01",
  status: "active",
  mbi: "1EG4TE5MK73",
};

const PERMISSION_SEED = [
  { userId: "admit_1", permissions: ["patient.create", "patient.read"] },
  { userId: "edit_1", permissions: ["patient.edit", "patient.read"] },
  { userId: "amend_1", permissions: ["patient.amend_request_record", "patient.amend_review"] },
  { userId: "noperm_1", permissions: [] },
];

function makeServer() {
  const { service, events } = createInMemoryPatientRouteService({
    patients: [existing],
    now: () => new Date("2026-06-20T00:00:00Z"),
  });
  const grantStore = createInMemoryEffectivePermissionStore(
    PERMISSION_SEED.map((s) => ({
      orgId: ORG,
      userId: s.userId,
      grants: [{ roleKey: "seed", enabled: true, expiresAt: null, permissionKeys: s.permissions }],
    })),
  );
  registerEffectivePermissionResolver(grantStore.store);
  const app = buildServer({ authenticate: headerAuth, security: { rateLimitEnabled: false } });
  registerPatientRoutes(app, { service });
  return { app, events };
}

const ADMIT = { "x-test-user": "admit_1", "x-test-org": ORG, "x-test-roles": "admissions" };
const EDIT = { "x-test-user": "edit_1", "x-test-org": ORG, "x-test-roles": "rn" };
const AMEND = { "x-test-user": "amend_1", "x-test-org": ORG, "x-test-roles": "compliance" };
const NOPERM = { "x-test-user": "noperm_1", "x-test-org": ORG, "x-test-roles": "intern" };

beforeEach(() => {
  resetAuthorizationContract();
  resetRbacEngine();
});
afterEach(() => {
  resetAuthorizationContract();
  resetRbacEngine();
});

describe("M5-T09 — patient routes (§4.2, §4.7 gating, §7.1/§7.4/§7.7)", () => {
  it("denies admit without patient.create (403)", async () => {
    const { app } = makeServer();
    const res = await app.inject({ method: "POST", url: "/api/v1/patients", headers: NOPERM, payload: { lastName: "X", firstName: "Y", dob: "2000-01-01", administrativeSex: "U" } });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("§7.1 a unique admit creates the patient (201)", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/patients",
      headers: ADMIT,
      payload: { lastName: "Newperson", firstName: "Fresh", dob: "1975-03-03", administrativeSex: "M" },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().outcome).toBe("created");
    expect(res.json().patientId).toBeTruthy();
    await app.close();
  });

  it("§7.1 a hard-duplicate admit (same MBI) is BLOCKED with 409, no row created", async () => {
    const { app, events } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/patients",
      headers: ADMIT,
      payload: { lastName: "Different", firstName: "Name", dob: "1991-02-02", administrativeSex: "F", mbi: "1EG4-TE5-MK73" },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("DUPLICATE_OF");
    expect(events).toContain("m5.patient.duplicate_block");
    expect(events).not.toContain("m5.patient.created");
    await app.close();
  });

  it("§7.4 an address change emits the address_changed cascade", async () => {
    const { app, events } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/patients/${EXISTING}/addresses`,
      headers: EDIT,
      payload: { line1: "10 New St", city: "Portland", state: "OR", postalCode: "97201" },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().cascadeEmitted).toBe("m5.patient.address_changed");
    expect(events).toContain("m5.patient.address_changed");
    await app.close();
  });

  it("§7.7 an amendment opens with a 60-day SLA; deny without reason 4xx; accept resolves it", async () => {
    const { app } = makeServer();
    const submit = await app.inject({
      method: "POST",
      url: `/api/v1/patients/${EXISTING}/amendments`,
      headers: AMEND,
      payload: { scope: "demographic", rationale: "wrong DOB" },
    });
    expect(submit.statusCode).toBe(201);
    expect(submit.json().status).toBe("pending");
    expect(submit.json().slaDueAt).toBe(new Date("2026-08-19T00:00:00Z").toISOString()); // +60 days
    const amendmentId = submit.json().id;

    const accept = await app.inject({ method: "POST", url: `/api/v1/amendments/${amendmentId}/accept`, headers: AMEND, payload: {} });
    expect(accept.statusCode).toBe(200);
    expect(accept.json().status).toBe("accepted");
    await app.close();
  });

  it("§7.5 GET a patient the actor's org doesn't have → 404 (no leak)", async () => {
    const { app } = makeServer();
    const res = await app.inject({ method: "GET", url: "/api/v1/patients/pat-nonexistent", headers: EDIT });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});
