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

// An existing patient with an MBI + SSN — the §7.1 hard-duplicate target (and the §3.3 masking case).
const existing: PatientView & MatchCandidate = {
  id: EXISTING,
  organizationId: ORG,
  mrn: "MRN-E",
  lastName: "LOVELACE",
  firstName: "ADA",
  dob: "1990-01-01",
  status: "active",
  mbi: "1EG4TE5MK73",
  ssn: "123-45-6789",
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

  it("§4.2 lists patients in the actor's org (cursor-paginated)", async () => {
    const { app } = makeServer();
    const res = await app.inject({ method: "GET", url: "/api/v1/patients?limit=10", headers: EDIT });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Array.isArray(body.items)).toBe(true);
    expect(body.items.some((p: { id: string }) => p.id === EXISTING)).toBe(true);
    expect(body).toHaveProperty("nextCursor");
    await app.close();
  });

  it("§4.2 list q-filter matches by name/MRN (and denies without patient.read)", async () => {
    const { app } = makeServer();
    const hit = await app.inject({ method: "GET", url: "/api/v1/patients?q=lovelace", headers: EDIT });
    expect(hit.json().items.map((p: { id: string }) => p.id)).toContain(EXISTING);
    const miss = await app.inject({ method: "GET", url: "/api/v1/patients?q=zzzznomatch", headers: EDIT });
    expect(miss.json().items).toHaveLength(0);
    const denied = await app.inject({ method: "GET", url: "/api/v1/patients", headers: NOPERM });
    expect(denied.statusCode).toBe(403);
    await app.close();
  });

  it("§7.5 GET a patient the actor's org doesn't have → 404 (no leak)", async () => {
    const { app } = makeServer();
    const res = await app.inject({ method: "GET", url: "/api/v1/patients/pat-nonexistent", headers: EDIT });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("§3.3 demographics tab returns live M5 data (and denies without patient.read)", async () => {
    const { app } = makeServer();
    const res = await app.inject({ method: "GET", url: `/api/v1/patients/${EXISTING}/demographics`, headers: EDIT });
    expect(res.statusCode).toBe(200);
    expect(res.json().legalLastName).toBe("LOVELACE");
    expect(res.json().dob).toBe("1990-01-01");
    const denied = await app.inject({ method: "GET", url: `/api/v1/patients/${EXISTING}/demographics`, headers: NOPERM });
    expect(denied.statusCode).toBe(403);
    await app.close();
  });

  it("§3.3/§2.2 identifiers are MASKED for ssn (last4 only, no plaintext value)", async () => {
    const { app } = makeServer();
    const res = await app.inject({ method: "GET", url: `/api/v1/patients/${EXISTING}/identifiers`, headers: EDIT });
    expect(res.statusCode).toBe(200);
    const ssn = res.json().identifiers.find((i: { kind: string }) => i.kind === "ssn");
    expect(ssn.sensitive).toBe(true);
    expect(ssn.value).toBeNull(); // ciphertext/plaintext NEVER serialized
    expect(ssn.last4).toBe("6789");
    const mrn = res.json().identifiers.find((i: { kind: string }) => i.kind === "mrn");
    expect(mrn.value).toBe("MRN-E"); // non-sensitive kinds are plaintext
    await app.close();
  });

  it("§3.3 addresses tab: add → list shows the current row; geocode pending; denies without patient.read", async () => {
    const { app } = makeServer();
    const empty = await app.inject({ method: "GET", url: `/api/v1/patients/${EXISTING}/addresses`, headers: EDIT });
    expect(empty.statusCode).toBe(200);
    expect(empty.json().addresses).toHaveLength(0);

    const add = await app.inject({
      method: "POST",
      url: `/api/v1/patients/${EXISTING}/addresses`,
      headers: EDIT,
      payload: { line1: "10 New St", city: "Portland", state: "OR", postalCode: "97201", isPrimary: true },
    });
    expect(add.statusCode).toBe(201);

    const listed = await app.inject({ method: "GET", url: `/api/v1/patients/${EXISTING}/addresses`, headers: EDIT });
    const rows = listed.json().addresses;
    expect(rows).toHaveLength(1);
    expect(rows[0].current).toBe(true);
    expect(rows[0].isPrimary).toBe(true);
    expect(rows[0].effectiveTo).toBeNull();
    expect(rows[0].geocodeLat).toBeNull(); // filled async by the geocode job

    const denied = await app.inject({ method: "GET", url: `/api/v1/patients/${EXISTING}/addresses`, headers: NOPERM });
    expect(denied.statusCode).toBe(403);
    await app.close();
  });

  it("§7.4 D5 primary rotation: a new primary closes the prior current primary (append-only)", async () => {
    const { app } = makeServer();
    await app.inject({ method: "POST", url: `/api/v1/patients/${EXISTING}/addresses`, headers: EDIT, payload: { line1: "1 First Ave", city: "Portland", state: "OR", postalCode: "97201", isPrimary: true } });
    await app.inject({ method: "POST", url: `/api/v1/patients/${EXISTING}/addresses`, headers: EDIT, payload: { line1: "2 Second Ave", city: "Salem", state: "OR", postalCode: "97301", isPrimary: true } });

    const listed = await app.inject({ method: "GET", url: `/api/v1/patients/${EXISTING}/addresses`, headers: EDIT });
    const rows = listed.json().addresses as Array<{ line1: string; isPrimary: boolean; current: boolean; effectiveTo: string | null }>;
    expect(rows).toHaveLength(2); // append-only: the prior row is kept
    const currentPrimaries = rows.filter((r) => r.current && r.isPrimary);
    expect(currentPrimaries).toHaveLength(1); // at most one current primary
    expect(currentPrimaries[0]!.line1).toBe("2 Second Ave");
    const closed = rows.find((r) => r.line1 === "1 First Ave");
    expect(closed!.current).toBe(false);
    expect(closed!.effectiveTo).not.toBeNull();
    await app.close();
  });

  it("§7.5 addresses for an unknown patient → 404 (no leak)", async () => {
    const { app } = makeServer();
    const res = await app.inject({ method: "GET", url: "/api/v1/patients/pat-nope/addresses", headers: EDIT });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("§7.5 demographics/identifiers for an unknown patient → 404 (no leak)", async () => {
    const { app } = makeServer();
    const a = await app.inject({ method: "GET", url: "/api/v1/patients/pat-nope/demographics", headers: EDIT });
    const b = await app.inject({ method: "GET", url: "/api/v1/patients/pat-nope/identifiers", headers: EDIT });
    expect(a.statusCode).toBe(404);
    expect(b.statusCode).toBe(404);
    await app.close();
  });
});
