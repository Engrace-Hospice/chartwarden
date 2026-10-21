// apps/backend/__tests__/cop27-hospice-coverage.test.ts — COP27 workstream B (42 CFR 418.24(c)): the hospice
// coverage determination on M12 medication orders and M21 dme/supply requests.
//
// Non-live: the shared validation rule (reason required when not covered), M21's kind rule, the two seam
// snapshot projections, the catalog payload schemas, and M12's route through the full M1 middleware chain over
// the in-memory backend (RBAC on `prescribing.coverage_determine`, caseload scope, 422, event emission, no-op
// re-save, carry-forward on correction). The DB paths + RLS are proven by `cop27-hospice-coverage.live.test.ts`.
import { Value } from "@sinclair/typebox/value";
import {
  createInMemoryEffectivePermissionStore,
  createPredicateRegistry,
  registerAbacRegistry,
  registerEffectivePermissionResolver,
  resetAbacRegistry,
  resetAuthorizationContract,
  resetRbacEngine,
} from "@chartwarden/auth";
import {
  ValidationError,
  assertCoverageDetermination,
  isNotCovered,
  validateCoverageDetermination,
} from "@chartwarden/types";
import type { FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import { M12_OUTBOX_EVENTS } from "../src/modules/12-dosespot/events-by-m12";
import {
  buildDoseSpotAbacPredicates,
  createInMemoryDoseSpotBackend,
  registerDoseSpotRoutes,
} from "../src/modules/12-dosespot/index";
import { medicationSnapshotOf } from "../src/modules/12-dosespot/seams/non-covered-medications";
import { M21_OUTBOX_EVENTS } from "../src/modules/21-supplies/events-by-m21";
import {
  SupplyStateError,
  decideCoverageDetermination,
} from "../src/modules/21-supplies/lifecycle/index";
import { supplySnapshotOf } from "../src/modules/21-supplies/seams/non-covered-dme-supplies";

const ORG = "org_cov";
const PATIENT = "11111111-1111-4111-8111-1111111111c1";
const ADMISSION = "33333333-3333-4333-8333-3333333333c1";
const ORDER = "00000000-0000-4000-8000-0000000c0001";
const NOW = "2026-10-06T12:00:00.000Z";

describe("validateCoverageDetermination (42 CFR 418.24(c)(6))", () => {
  it("requires a reason when the item is not covered (unrelated)", () => {
    const r = validateCoverageDetermination({ hospiceCoverage: "not_covered_unrelated" });
    expect(r).toMatchObject({ ok: false, code: "COVERAGE_REASON_REQUIRED" });
  });

  it("requires a reason when the item is not covered (other), and treats whitespace as missing", () => {
    const r = validateCoverageDetermination({
      hospiceCoverage: "not_covered_other",
      reason: "   ",
    });
    expect(r).toMatchObject({ ok: false, code: "COVERAGE_REASON_REQUIRED" });
  });

  it("accepts a covered determination with no reason and normalises blanks to null", () => {
    expect(validateCoverageDetermination({ hospiceCoverage: "covered_related" })).toEqual({
      ok: true,
      reason: null,
    });
    expect(
      validateCoverageDetermination({ hospiceCoverage: "covered_related", reason: "  " }),
    ).toEqual({ ok: true, reason: null });
  });

  it("trims the reason on a not-covered determination", () => {
    expect(
      validateCoverageDetermination({
        hospiceCoverage: "not_covered_unrelated",
        reason: "  Statin for cholesterol; not needed for comfort.  ",
      }),
    ).toEqual({ ok: true, reason: "Statin for cholesterol; not needed for comfort." });
  });

  it("refuses a reason longer than 2000 characters", () => {
    const r = validateCoverageDetermination({
      hospiceCoverage: "not_covered_other",
      reason: "x".repeat(2001),
    });
    expect(r).toMatchObject({ ok: false, code: "COVERAGE_REASON_TOO_LONG" });
  });

  it("assertCoverageDetermination throws the 422 ValidationError with a `reason` field detail", () => {
    expect(() => assertCoverageDetermination({ hospiceCoverage: "not_covered_unrelated" })).toThrow(
      ValidationError,
    );
    try {
      assertCoverageDetermination({ hospiceCoverage: "not_covered_unrelated", reason: "" });
    } catch (e) {
      expect((e as ValidationError).details?.[0]).toMatchObject({
        field: "reason",
        code: "COVERAGE_REASON_REQUIRED",
      });
    }
  });

  it("isNotCovered is true only for the two not-covered values", () => {
    expect(isNotCovered("covered_related")).toBe(false);
    expect(isNotCovered("not_covered_unrelated")).toBe(true);
    expect(isNotCovered("not_covered_other")).toBe(true);
  });
});

describe("M21 decideCoverageDetermination", () => {
  it("accepts dme and supply kinds", () => {
    expect(
      decideCoverageDetermination({
        kind: "dme",
        hospiceCoverage: "not_covered_unrelated",
        reason: "CPAP for sleep apnea, unrelated to the terminal diagnosis.",
      }),
    ).toBe("CPAP for sleep apnea, unrelated to the terminal diagnosis.");
    expect(
      decideCoverageDetermination({ kind: "supply", hospiceCoverage: "covered_related" }),
    ).toBe(null);
  });

  it("refuses the comfort-kit kinds with M21_COVERAGE_NOT_APPLICABLE_TO_KIND (422)", () => {
    for (const kind of ["comfort_kit_deploy", "comfort_kit_replenish"] as const) {
      try {
        decideCoverageDetermination({ kind, hospiceCoverage: "covered_related" });
        expect.unreachable();
      } catch (e) {
        expect(e).toBeInstanceOf(SupplyStateError);
        expect((e as SupplyStateError).code).toBe("M21_COVERAGE_NOT_APPLICABLE_TO_KIND");
        expect((e as SupplyStateError).statusCode).toBe(422);
      }
    }
  });

  it("still requires the reason on a goods kind", () => {
    expect(() =>
      decideCoverageDetermination({ kind: "supply", hospiceCoverage: "not_covered_other" }),
    ).toThrow(ValidationError);
  });
});

describe("seam snapshot projections (NonCoveredItemSnapshot)", () => {
  const at = new Date("2026-10-02T09:30:00.000Z");

  it("medicationSnapshotOf builds a drug row with a readable description", () => {
    expect(
      medicationSnapshotOf({
        id: ORDER,
        drugName: "Atorvastatin",
        strength: "40 mg",
        doseForm: "tablet",
        route: "oral",
        coverageReason: "Cholesterol therapy is unrelated to the terminal illness.",
        coverageDeterminedAt: at,
        coverageDeterminedByMembershipId: "m-1",
        updatedAt: new Date(0),
      }),
    ).toEqual({
      source: "medication",
      sourceId: ORDER,
      category: "drug",
      description: "Atorvastatin 40 mg tablet oral",
      reason: "Cholesterol therapy is unrelated to the terminal illness.",
      determinedAt: at.toISOString(),
      determinedByUserId: "m-1",
    });
  });

  it("supplySnapshotOf names the catalog item, else falls back to the HCPCS code", () => {
    const row = {
      id: "sr-1",
      kind: "dme",
      data: { hcpcs: "E0601", skuId: "sku-1" },
      coverageReason: "Pre-existing sleep apnea equipment.",
      coverageDeterminedAt: at,
      coverageDeterminedByMembershipId: null,
      updatedAt: new Date(0),
    };
    expect(supplySnapshotOf(row, "CPAP device")).toMatchObject({
      source: "dme",
      category: "item",
      description: "CPAP device",
      determinedByUserId: null,
    });
    expect(supplySnapshotOf(row, null).description).toBe("Durable medical equipment (HCPCS E0601)");
    expect(supplySnapshotOf({ ...row, kind: "supply", data: {} }, null)).toMatchObject({
      source: "supply",
      description: "Medical supply",
    });
  });
});

describe("catalog payload schemas", () => {
  const payload = {
    orgId: ORG,
    admissionId: ADMISSION,
    patientId: PATIENT,
    sourceId: ORDER,
    hospiceCoverage: "not_covered_unrelated",
    previousHospiceCoverage: "covered_related",
    reason: "Unrelated to the terminal illness.",
    changedAt: NOW,
  };
  for (const [name, catalog] of [
    ["m12.medication_order.coverage_determination_changed", M12_OUTBOX_EVENTS],
    ["m21.supply_request.coverage_determination_changed", M21_OUTBOX_EVENTS],
  ] as const) {
    it(`${name} is catalogued with M6 as the declared consumer and validates the payload`, () => {
      const entry = catalog.find((e) => e.eventName === name);
      expect(entry).toBeDefined();
      expect(entry?.declaredConsumers).toEqual(["m6"]);
      expect(Value.Check(entry!.payloadSchema, payload)).toBe(true);
      expect(Value.Check(entry!.payloadSchema, { ...payload, reason: null })).toBe(true);
      expect(Value.Check(entry!.payloadSchema, { ...payload, hospiceCoverage: "maybe" })).toBe(
        false,
      );
    });
  }
});

// ── M12 route through the full middleware chain ─────────────────────────────────────────────────────
function headerAuth(request: FastifyRequest): void {
  const user = request.headers["x-test-user"];
  if (typeof user !== "string" || user.length === 0) return;
  request.context.userId = user;
  request.context.attributes.membershipId = user;
  request.context.organizationId = ORG;
  request.context.roles = ["hospice_physician"];
}

function makeServer() {
  const backend = createInMemoryDoseSpotBackend({
    now: () => NOW,
    orders: [
      {
        id: ORDER,
        organizationId: ORG,
        patientId: PATIENT,
        admissionId: ADMISSION,
        medClass: "standard",
        status: "active",
        prescriberMembershipId: "md_cov",
        drugName: "Atorvastatin",
        strength: "40 mg",
        doseForm: "tablet",
        route: "oral",
      },
    ],
    caseloadPatientIds: [{ organizationId: ORG, userId: "md_cov", patientId: PATIENT }],
  });
  registerEffectivePermissionResolver(
    createInMemoryEffectivePermissionStore([
      {
        orgId: ORG,
        userId: "md_cov",
        grants: [
          {
            roleKey: "seed",
            enabled: true,
            expiresAt: null,
            permissionKeys: ["prescribing.read", "prescribing.coverage_determine"],
          },
        ],
      },
      {
        orgId: ORG,
        userId: "md_nocov",
        grants: [
          {
            roleKey: "seed",
            enabled: true,
            expiresAt: null,
            permissionKeys: ["prescribing.read", "prescribing.draft"],
          },
        ],
      },
    ]).store,
  );
  const reg = createPredicateRegistry();
  for (const [name, predicate] of Object.entries(
    buildDoseSpotAbacPredicates({ resolver: backend }),
  ))
    reg.register(name, predicate);
  reg.register(
    "caseload_or_scope",
    async (context, target) => context.userId === "md_cov" && target.patientId === PATIENT,
  );
  registerAbacRegistry(reg);
  const app = buildServer({ authenticate: headerAuth, security: { rateLimitEnabled: false } });
  registerDoseSpotRoutes(app, { service: backend });
  return { app, backend };
}

const URL = `/api/v1/medication-orders/${ORDER}/coverage-determination`;
const MD = { "x-test-user": "md_cov" };

describe("PUT /api/v1/medication-orders/:id/coverage-determination (in-memory backend)", () => {
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

  it("422 when not covered without a reason; nothing changes, nothing is emitted", async () => {
    const { app, backend } = makeServer();
    const res = await app.inject({
      method: "PUT",
      url: URL,
      headers: MD,
      payload: { hospiceCoverage: "not_covered_unrelated" },
    });
    expect(res.statusCode).toBe(422);
    expect(backend.drainEvents()).toEqual([]);
    const order = await backend.getOrder(ORG, ORDER);
    expect(order.hospiceCoverage).toBe("covered_related");
  });

  it("403 without prescribing.coverage_determine", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "PUT",
      url: URL,
      headers: { "x-test-user": "md_nocov" },
      payload: { hospiceCoverage: "covered_related" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("sets the determination from the SESSION membership and emits the M6-bound event once", async () => {
    const { app, backend } = makeServer();
    const res = await app.inject({
      method: "PUT",
      url: URL,
      headers: MD,
      payload: {
        hospiceCoverage: "not_covered_unrelated",
        reason: "Cholesterol therapy is unrelated to the terminal illness.",
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      hospiceCoverage: "not_covered_unrelated",
      coverageReason: "Cholesterol therapy is unrelated to the terminal illness.",
      coverageDeterminedAt: NOW,
      coverageDeterminedBy: "md_cov",
      status: "active", // not a lifecycle transition
      version: 1,
    });
    const events = backend.drainEvents();
    expect(events.map((e) => e.eventName)).toEqual([
      "m12.medication_order.coverage_determination_changed",
    ]);
    expect(events[0]?.payload).toMatchObject({
      orgId: ORG,
      admissionId: ADMISSION,
      patientId: PATIENT,
      sourceId: ORDER,
      hospiceCoverage: "not_covered_unrelated",
      previousHospiceCoverage: "covered_related",
      changedAt: NOW,
    });

    // An identical re-save is a no-op: no event.
    const again = await app.inject({
      method: "PUT",
      url: URL,
      headers: MD,
      payload: {
        hospiceCoverage: "not_covered_unrelated",
        reason: "Cholesterol therapy is unrelated to the terminal illness.",
      },
    });
    expect(again.statusCode).toBe(200);
    expect(backend.drainEvents()).toEqual([]);
  });

  it("a corrected order inherits the predecessor's determination", async () => {
    const { backend } = makeServer();
    await backend.setCoverageDetermination(ORG, "md_cov", ORDER, {
      hospiceCoverage: "not_covered_other",
      reason: "Not reasonable and necessary for palliation.",
    });
    const { newOrderId } = await backend.correctOrder(ORG, "md_cov", ORDER, {
      patientId: PATIENT,
      admissionId: ADMISSION,
      medClass: "standard",
      rxnormRxcui: "83367",
      ndc: null,
      drugName: "Atorvastatin",
      strength: "20 mg",
      doseForm: "tablet",
      route: "oral",
      data: {},
      prescriberDiscipline: "hospice_physician",
      prescribingPhysicianMdmId: "44444444-4444-4444-8444-4444444444c1",
      refillsAuthorized: 0,
    });
    const corrected = await backend.getOrder(ORG, newOrderId);
    expect(corrected).toMatchObject({
      hospiceCoverage: "not_covered_other",
      coverageReason: "Not reasonable and necessary for palliation.",
      coverageDeterminedBy: "md_cov",
    });
  });
});
