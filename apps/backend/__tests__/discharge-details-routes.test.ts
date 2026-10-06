// apps/backend/__tests__/discharge-details-routes.test.ts — the after-the-fact discharge details: the pure decision
// rules (discharge/discharge-details.ts) and the three routes through the full M1 chain (Fastify inject):
//   GET  /api/v1/admissions/:id/discharge-details
//   POST /api/v1/discharges/:id/place-of-death
//   POST /api/v1/transfers/:id/receiving-care-setting
// Covers: permission gating (discharge.death / transfer.out / admission.read), admission.scope on the OWNING
// admission (404 on deny and for an unknown id), body validation, the service result passthrough, and a 503 when the
// service is unbound. The Drizzle behaviour (RLS, version guard, correction reason, outbox) is proven live in
// m6-claim-discharge-seam.live.test.ts.
import {
  createInMemoryEffectivePermissionStore,
  createPredicateRegistry,
  registerAbacRegistry,
  registerEffectivePermissionResolver,
  resetAuthorizationContract,
  resetRbacEngine,
} from "@wardenx/auth";
import type { FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import {
  RECEIVING_CARE_SETTING_REQUIRED_MESSAGE,
  checkPlaceOfDeathBody,
  checkTransferOutCareSettingBody,
  correctionReasonRequiredMessage,
  decideDetailUpdate,
  missingDischargeDetail,
} from "../src/modules/06-admission/discharge";
import {
  type DischargeDetailsService,
  buildAdmissionAbacPredicates,
  createInMemoryAdmissionBackend,
  registerAdmissionRoutes,
} from "../src/modules/06-admission/index";

const ORG = "org_a";
const ADMISSION = "adm_1";
const DISCHARGE = "de_1";
const TRANSFER = "te_1";

describe("decideDetailUpdate", () => {
  it("fills a never-recorded value without a reason", () => {
    expect(
      decideDetailUpdate({ current: null, requested: "home", correctionReason: undefined }),
    ).toEqual({ kind: "set" });
  });
  it("is a no-op for the same value", () => {
    expect(
      decideDetailUpdate({ current: "home", requested: "home", correctionReason: undefined }),
    ).toEqual({ kind: "noop" });
  });
  it("refuses to replace a recorded value without a reason of at least 20 characters", () => {
    expect(
      decideDetailUpdate({ current: "home", requested: "facility", correctionReason: "typo" }),
    ).toEqual({ kind: "reason_required" });
  });
  it("replaces a recorded value with a trimmed reason", () => {
    expect(
      decideDetailUpdate({
        current: "home",
        requested: "facility",
        correctionReason: "  death certificate lists the nursing facility  ",
      }),
    ).toEqual({ kind: "correct", reason: "death certificate lists the nursing facility" });
  });
  it("explains the correction requirement", () => {
    expect(correctionReasonRequiredMessage("place_of_death", "home")).toMatch(
      /place of death is already recorded as "home".*correctionReason \(at least 20/,
    );
  });
});

describe("missingDischargeDetail", () => {
  it("flags a completed death without a place of death", () => {
    expect(
      missingDischargeDetail({
        discharge: { reason: "death", placeOfDeath: null },
        transferOut: null,
      }),
    ).toBe("place_of_death");
  });
  it("flags a transfer-out without a receiving care setting", () => {
    expect(
      missingDischargeDetail({ discharge: null, transferOut: { receivingCareSetting: null } }),
    ).toBe("receiving_care_setting");
  });
  it("flags nothing when both are recorded or the discharge is not a death", () => {
    expect(
      missingDischargeDetail({
        discharge: { reason: "no_longer_terminal", placeOfDeath: null },
        transferOut: null,
      }),
    ).toBeNull();
    expect(
      missingDischargeDetail({
        discharge: { reason: "death", placeOfDeath: "unknown" },
        transferOut: null,
      }),
    ).toBeNull();
  });
});

describe("body prechecks", () => {
  it("transfer-out: missing or invalid receivingCareSetting → RECEIVING_CARE_SETTING_REQUIRED", () => {
    expect(checkTransferOutCareSettingBody({})?.code).toBe("RECEIVING_CARE_SETTING_REQUIRED");
    expect(checkTransferOutCareSettingBody({ receivingCareSetting: "hospital" })?.message).toBe(
      RECEIVING_CARE_SETTING_REQUIRED_MESSAGE,
    );
    expect(checkTransferOutCareSettingBody({ receivingCareSetting: "home" })).toBeNull();
  });
  it("discharge: only an INVALID place of death on a death is caught here", () => {
    expect(checkPlaceOfDeathBody({ reason: "death", placeOfDeath: "hospital" })?.field).toBe(
      "placeOfDeath",
    );
    expect(checkPlaceOfDeathBody({ reason: "death" })).toBeNull(); // the service refuses the missing case
    expect(checkPlaceOfDeathBody({ reason: "other", placeOfDeath: "x" })).toBeNull();
  });
});

// ── routes ─────────────────────────────────────────────────────────────────────────────────────────

function headerAuth(request: FastifyRequest): void {
  const user = request.headers["x-test-user"];
  if (typeof user !== "string" || user.length === 0) return;
  request.context.userId = user;
  request.context.organizationId = String(request.headers["x-test-org"] ?? "");
  const roles = request.headers["x-test-roles"];
  request.context.roles = typeof roles === "string" && roles.length > 0 ? roles.split(",") : [];
}

function fakeService(): DischargeDetailsService & { calls: unknown[] } {
  const calls: unknown[] = [];
  return {
    calls,
    getForAdmission: vi.fn(async (_org, id) =>
      id === ADMISSION
        ? {
            admissionId: ADMISSION,
            patientId: "pat_1",
            admissionState: "discharged",
            discharge: {
              dischargeEventId: DISCHARGE,
              reason: "death",
              status: "completed",
              effectiveDate: "2026-05-01",
              placeOfDeath: null,
              placeOfDeathCorrectionReason: null,
              version: 2,
            },
            transferOut: null,
            missing: "place_of_death" as const,
          }
        : null,
    ),
    admissionIdForDischarge: vi.fn(async (_org, id) => (id === DISCHARGE ? ADMISSION : null)),
    admissionIdForTransfer: vi.fn(async (_org, id) => (id === TRANSFER ? ADMISSION : null)),
    recordPlaceOfDeath: vi.fn(async (org, id, input, actor) => {
      calls.push({ org, id, input, actor });
      return {
        id,
        admissionId: ADMISSION,
        detail: "place_of_death" as const,
        value: input.value,
        previousValue: null,
        changed: true,
        version: input.ifVersion + 1,
        claimPatientStatus: "40",
      };
    }),
    recordReceivingCareSetting: vi.fn(async (org, id, input, actor) => {
      calls.push({ org, id, input, actor });
      return {
        id,
        admissionId: ADMISSION,
        detail: "receiving_care_setting" as const,
        value: input.value,
        previousValue: null,
        changed: true,
        version: input.ifVersion + 1,
        claimPatientStatus: "51",
      };
    }),
  };
}

function makeServer(opts: { inScope?: boolean; bound?: boolean } = {}) {
  const backend = createInMemoryAdmissionBackend({
    records: [
      {
        id: ADMISSION,
        organizationId: ORG,
        kind: "admission",
        state: "discharged",
        patientId: "pat_1",
      },
    ],
  });
  const grants = (userId: string, permissionKeys: string[]) => ({
    orgId: ORG,
    userId,
    grants: [{ roleKey: "seed", enabled: true, expiresAt: null, permissionKeys }],
  });
  registerEffectivePermissionResolver(
    createInMemoryEffectivePermissionStore([
      grants("clin_1", ["admission.read", "discharge.death", "transfer.out"]),
      grants("reader_1", ["admission.read"]),
    ]).store,
  );
  const registry = createPredicateRegistry();
  const predicates = buildAdmissionAbacPredicates({
    resolver: backend.resolver,
    isInCaseload: async () => opts.inScope ?? true,
  });
  for (const [name, fn] of Object.entries(predicates)) registry.register(name, fn);
  registerAbacRegistry(registry);
  const service = fakeService();
  const app = buildServer({ authenticate: headerAuth, security: { rateLimitEnabled: false } });
  registerAdmissionRoutes(app, {
    service: backend.service,
    ...(opts.bound === false ? {} : { dischargeDetails: service }),
  });
  return { app, service };
}

const CLIN = { "x-test-user": "clin_1", "x-test-org": ORG, "x-test-roles": "rn" };
const READER = { "x-test-user": "reader_1", "x-test-org": ORG, "x-test-roles": "biller" };

beforeEach(() => {
  resetAuthorizationContract();
  resetRbacEngine();
});
afterEach(() => {
  resetAuthorizationContract();
  resetRbacEngine();
});

describe("discharge-details routes", () => {
  it("GET returns what the stay-ending record lacks", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/admissions/${ADMISSION}/discharge-details`,
      headers: READER,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ missing: "place_of_death", discharge: { version: 2 } });
    await app.close();
  });

  it("POST place-of-death records through the service with the acting user", async () => {
    const { app, service } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/discharges/${DISCHARGE}/place-of-death`,
      headers: CLIN,
      payload: { placeOfDeath: "home", ifVersion: 2 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ value: "home", changed: true, claimPatientStatus: "40" });
    expect(service.calls).toEqual([
      { org: ORG, id: DISCHARGE, input: { value: "home", ifVersion: 2 }, actor: "clin_1" },
    ]);
    await app.close();
  });

  it("POST receiving-care-setting passes the correction reason", async () => {
    const { app, service } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/transfers/${TRANSFER}/receiving-care-setting`,
      headers: CLIN,
      payload: {
        receivingCareSetting: "facility",
        ifVersion: 0,
        correctionReason: "receiving hospice confirmed a nursing facility admission",
      },
    });
    expect(res.statusCode).toBe(200);
    expect(service.calls[0]).toMatchObject({
      input: {
        value: "facility",
        correctionReason: "receiving hospice confirmed a nursing facility admission",
      },
    });
    await app.close();
  });

  it("refuses an invalid value and a missing ifVersion (VALIDATION_FAILED)", async () => {
    const { app } = makeServer();
    const bad = await app.inject({
      method: "POST",
      url: `/api/v1/discharges/${DISCHARGE}/place-of-death`,
      headers: CLIN,
      payload: { placeOfDeath: "hospital", ifVersion: 2 },
    });
    expect(bad.json().error.code).toBe("VALIDATION_FAILED");
    const noVersion = await app.inject({
      method: "POST",
      url: `/api/v1/transfers/${TRANSFER}/receiving-care-setting`,
      headers: CLIN,
      payload: { receivingCareSetting: "home" },
    });
    expect(noVersion.json().error.code).toBe("VALIDATION_FAILED");
    await app.close();
  });

  it("403 without discharge.death / transfer.out (a read-only biller)", async () => {
    const { app, service } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/discharges/${DISCHARGE}/place-of-death`,
      headers: READER,
      payload: { placeOfDeath: "home", ifVersion: 2 },
    });
    expect(res.statusCode).toBe(403);
    expect(service.calls).toHaveLength(0);
    await app.close();
  });

  it("404 for an unknown discharge id and when the owning admission is out of scope", async () => {
    const unknown = makeServer();
    const res = await unknown.app.inject({
      method: "POST",
      url: "/api/v1/discharges/de_unknown/place-of-death",
      headers: CLIN,
      payload: { placeOfDeath: "home", ifVersion: 0 },
    });
    expect(res.statusCode).toBe(404);
    await unknown.app.close();

    resetAuthorizationContract();
    resetRbacEngine();
    const outOfScope = makeServer({ inScope: false });
    const denied = await outOfScope.app.inject({
      method: "POST",
      url: `/api/v1/transfers/${TRANSFER}/receiving-care-setting`,
      headers: CLIN,
      payload: { receivingCareSetting: "home", ifVersion: 0 },
    });
    expect(denied.statusCode).toBe(404);
    expect(outOfScope.service.calls).toHaveLength(0);
    await outOfScope.app.close();
  });

  it("503 DEGRADED when the service is not bound", async () => {
    const { app } = makeServer({ bound: false });
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/admissions/${ADMISSION}/discharge-details`,
      headers: READER,
    });
    expect(res.statusCode).toBe(503);
    await app.close();
  });
});
