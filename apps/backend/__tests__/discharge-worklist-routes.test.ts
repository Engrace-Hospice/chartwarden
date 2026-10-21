// apps/backend/__tests__/discharge-worklist-routes.test.ts — GET /api/v1/discharges/worklist (the end-of-episode
// worklist behind the web "Discharge / transfer" hub) through the full M1 chain (Fastify inject): permission gating
// (admission.read for every bucket, + discharge.cosign_for_cause for awaiting_cosign), query validation, the caseload
// narrowing handed to the service (org-wide role vs clinician caseload), and a 503 when the service is unbound.
import {
  createInMemoryEffectivePermissionStore,
  createPredicateRegistry,
  registerAbacRegistry,
  registerEffectivePermissionResolver,
  resetAuthorizationContract,
  resetRbacEngine,
} from "@chartwarden/auth";
import type { FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import {
  type DischargeWorklistService,
  buildAdmissionAbacPredicates,
  createInMemoryAdmissionBackend,
  registerAdmissionRoutes,
} from "../src/modules/06-admission/index";

const ORG = "org_a";

function headerAuth(request: FastifyRequest): void {
  const user = request.headers["x-test-user"];
  if (typeof user !== "string" || user.length === 0) return;
  request.context.userId = user;
  request.context.organizationId = String(request.headers["x-test-org"] ?? "");
  const list = (h: string) => {
    const v = request.headers[h];
    return typeof v === "string" && v.length > 0 ? v.split(",") : [];
  };
  request.context.roles = list("x-test-roles");
  request.context.providerEntityIds = list("x-test-pe");
  request.context.locationIds = list("x-test-loc");
}

const ITEM = {
  admissionId: "adm_1",
  patientId: "pat_1",
  admissionState: "discharged",
  admissionAt: "2026-04-01T00:00:00.000Z",
  dischargedAt: "2026-05-01T00:00:00.000Z",
  missing: "place_of_death" as const,
  dischargeEventId: "de_1",
  transferEventId: null,
  dischargeType: "death",
  effectiveDate: "2026-05-01",
};

function makeServer(opts: { bound?: boolean; caseload?: readonly string[] } = {}) {
  const backend = createInMemoryAdmissionBackend({ records: [] });
  const grants = (userId: string, permissionKeys: string[]) => ({
    orgId: ORG,
    userId,
    grants: [{ roleKey: "seed", enabled: true, expiresAt: null, permissionKeys }],
  });
  registerEffectivePermissionResolver(
    createInMemoryEffectivePermissionStore([
      grants("reader_1", ["admission.read"]),
      grants("creator_1", ["admission.read", "admission.create"]),
      grants("md_1", ["admission.read", "discharge.cosign_for_cause"]),
      grants("nobody_1", []),
    ]).store,
  );
  const registry = createPredicateRegistry();
  for (const [name, fn] of Object.entries(
    buildAdmissionAbacPredicates({ resolver: backend.resolver, isInCaseload: async () => true }),
  )) {
    registry.register(name, fn);
  }
  registerAbacRegistry(registry);
  const list = vi.fn<DischargeWorklistService["list"]>(async () => ({
    items: [ITEM],
    nextCursor: null,
  }));
  const app = buildServer({ authenticate: headerAuth, security: { rateLimitEnabled: false } });
  registerAdmissionRoutes(app, {
    service: backend.service,
    caseloadPatientIds: async () => opts.caseload ?? ["pat_1"],
    ...(opts.bound === false ? {} : { dischargeWorklist: { list } }),
  });
  return { app, list };
}

const as = (user: string, roles = "rn") => ({
  "x-test-user": user,
  "x-test-org": ORG,
  "x-test-roles": roles,
});

beforeEach(() => {
  resetAuthorizationContract();
  resetRbacEngine();
});
afterEach(() => {
  resetAuthorizationContract();
  resetRbacEngine();
});

describe("GET /api/v1/discharges/worklist", () => {
  it("returns the bucket page and hands the service the parsed query + caseload scope", async () => {
    const { app, list } = makeServer({ caseload: ["pat_1", "pat_2"] });
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/discharges/worklist?bucket=needs_details&limit=25",
      headers: as("reader_1"),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ items: [ITEM], nextCursor: null });
    expect(list).toHaveBeenCalledWith(
      ORG,
      { bucket: "needs_details", limit: 25 },
      { patientIds: ["pat_1", "pat_2"] },
    );
  });

  it("is org-wide (no caseload narrowing) for an org-wide scope role", async () => {
    const { app, list } = makeServer();
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/discharges/worklist?bucket=ready",
      headers: as("reader_1", "medical_director"),
    });
    expect(res.statusCode).toBe(200);
    expect(list.mock.calls[0]?.[2]).toEqual({ patientIds: null });
  });

  it("refuses a caller without admission.read", async () => {
    const { app, list } = makeServer();
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/discharges/worklist?bucket=ready",
      headers: as("nobody_1"),
    });
    expect(res.statusCode).toBe(403);
    expect(list).not.toHaveBeenCalled();
  });

  it("requires discharge.cosign_for_cause for the awaiting_cosign bucket only", async () => {
    const { app, list } = makeServer();
    const denied = await app.inject({
      method: "GET",
      url: "/api/v1/discharges/worklist?bucket=awaiting_cosign",
      headers: as("reader_1"),
    });
    expect(denied.statusCode).toBe(403);
    const allowed = await app.inject({
      method: "GET",
      url: "/api/v1/discharges/worklist?bucket=awaiting_cosign",
      headers: as("md_1"),
    });
    expect(allowed.statusCode).toBe(200);
    expect(list).toHaveBeenCalledTimes(1);
  });

  it("rejects a missing or unknown bucket with a 4xx validation error", async () => {
    const { app, list } = makeServer();
    for (const url of [
      "/api/v1/discharges/worklist",
      "/api/v1/discharges/worklist?bucket=everything",
      "/api/v1/discharges/worklist?bucket=ready&limit=500",
    ]) {
      const res = await app.inject({ method: "GET", url, headers: as("reader_1") });
      expect(res.statusCode).toBeGreaterThanOrEqual(400);
      expect(res.statusCode).toBeLessThan(500);
    }
    expect(list).not.toHaveBeenCalled();
  });

  it("answers 503 when the worklist service is not bound", async () => {
    const { app } = makeServer({ bound: false });
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/discharges/worklist?bucket=ready",
      headers: as("reader_1"),
    });
    expect(res.statusCode).toBe(503);
  });
});

// The Readmit list (`bucket=recently_discharged`): a readmission candidate's caseload assignment has usually ENDED, so
// caseload narrowing alone would show a nurse nothing. An `admission.create` holder additionally sees the bucket's
// rows at their own site (an admitting clinician — the `admission_clinical_site_scope` rule) or org-wide (an intake
// role — the `admission_intake_scope` rule; every row of the bucket is a patient with no ongoing stay). Every other
// bucket, and every caller without `admission.create`, keeps the caseload narrowing.
describe("GET /api/v1/discharges/worklist?bucket=recently_discharged — the readmission scope", () => {
  const RECENT = "/api/v1/discharges/worklist?bucket=recently_discharged";
  const hdr = (user: string, roles: string, pe = "", loc = "") => ({
    ...as(user, roles),
    "x-test-pe": pe,
    "x-test-loc": loc,
  });

  it("an admitting clinician with admission.create: caseload OR their own site", async () => {
    const { app, list } = makeServer({ caseload: ["pat_1"] });
    const res = await app.inject({
      method: "GET",
      url: RECENT,
      headers: hdr("creator_1", "rn", "pe_a", "loc_a1"),
    });
    expect(res.statusCode).toBe(200);
    expect(list).toHaveBeenCalledWith(
      ORG,
      { bucket: "recently_discharged" },
      { patientIds: ["pat_1"], sites: { providerEntityIds: ["pe_a"], locationIds: ["loc_a1"] } },
    );
  });

  it("an intake role with admission.create: org-wide", async () => {
    const { app, list } = makeServer({ caseload: [] });
    await app.inject({
      method: "GET",
      url: RECENT,
      headers: hdr("creator_1", "intake_supervisor"),
    });
    expect(list).toHaveBeenCalledWith(ORG, { bucket: "recently_discharged" }, { patientIds: null });
  });

  it("without admission.create the clinician keeps the caseload narrowing", async () => {
    const { app, list } = makeServer({ caseload: ["pat_1"] });
    await app.inject({ method: "GET", url: RECENT, headers: hdr("reader_1", "rn", "pe_a") });
    expect(list).toHaveBeenCalledWith(
      ORG,
      { bucket: "recently_discharged" },
      { patientIds: ["pat_1"] },
    );
  });

  it("an external / non-admitting role keeps the caseload narrowing even with admission.create", async () => {
    const { app, list } = makeServer({ caseload: [] });
    for (const roles of ["physician_office", "msw", "billing_specialist"]) {
      list.mockClear();
      await app.inject({ method: "GET", url: RECENT, headers: hdr("creator_1", roles, "pe_a") });
      expect(list, roles).toHaveBeenCalledWith(
        ORG,
        { bucket: "recently_discharged" },
        { patientIds: [] },
      );
    }
  });

  it("the other buckets never widen to the site", async () => {
    const { app, list } = makeServer({ caseload: ["pat_1"] });
    await app.inject({
      method: "GET",
      url: "/api/v1/discharges/worklist?bucket=ready",
      headers: hdr("creator_1", "rn", "pe_a"),
    });
    expect(list).toHaveBeenCalledWith(ORG, { bucket: "ready" }, { patientIds: ["pat_1"] });
  });
});
