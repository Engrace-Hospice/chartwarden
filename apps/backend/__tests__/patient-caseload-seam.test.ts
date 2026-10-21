// apps/backend/__tests__/patient-caseload-seam.test.ts — M5-T07 CaseloadProvider seam (§4.1, §7.5).
//
// Proves M5 closes the M3 boot-gate `CaseloadProvider` deny-stub: it registers over the M1 deny-stub,
// validateSeams() passes with the real impl, and the resolver enforces §7.5 caseload narrowing
// (an RN sees ONLY her assigned patients; a third patient is not in caseload). Fail-closed baseline
// (unregistered ⇒ deny-stub throws) is asserted too.
import { abacRegistry } from "@chartwarden/auth";
import { beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import { NotImplementedError } from "../src/bootstrap/seams/providers";
import {
  REQUIRED_SEAMS,
  __resetSeamsForTest,
  validateSeams,
} from "../src/bootstrap/seams/registry";
import { wireModuleSeams } from "../src/index";
import {
  getCaseloadProvider,
  createInMemoryCaseloadStore as makeStore,
  registerPatientSeams,
} from "../src/modules/05-patient/index";

const ORG = "org_a";
const RN = "rn_1";
const P1 = "patient-1";
const P2 = "patient-2";
const P3 = "patient-3";

function seededStore() {
  return makeStore([
    { organizationId: ORG, userId: RN, patientId: P1 },
    { organizationId: ORG, userId: RN, patientId: P2 },
  ]).store;
}

describe("M5-T07 — CaseloadProvider closes the M3 boot-gate (§4.1, §7.5)", () => {
  beforeEach(() => __resetSeamsForTest());

  it("declares the seam in REQUIRED_SEAMS owned by M5 (PHI) with a deny-stub", () => {
    const entry = REQUIRED_SEAMS.find((r) => r.key === "CaseloadProvider");
    expect(entry?.ownerModule).toBe(5);
    expect(entry?.phi).toBe(true);
    expect(entry?.denyStub).toBeDefined();
  });

  it("registers the real provider so validateSeams() passes and the getter resolves it", () => {
    registerPatientSeams({ caseload: { store: seededStore() } });
    expect(() => validateSeams()).not.toThrow();
    expect(getCaseloadProvider()).toBeDefined();
  });

  it("§7.5 caseloadPatientIds returns ONLY the actor's assigned patients", async () => {
    registerPatientSeams({ caseload: { store: seededStore() } });
    validateSeams();
    const ids = await getCaseloadProvider().caseloadPatientIds({ organizationId: ORG, userId: RN });
    expect([...ids].sort()).toEqual([P1, P2]);
  });

  it("§7.5 isInCaseload gates per-chart: true for assigned, false for a third patient", async () => {
    registerPatientSeams({ caseload: { store: seededStore() } });
    validateSeams();
    const p = getCaseloadProvider();
    expect(await p.isInCaseload({ organizationId: ORG, userId: RN, patientId: P1 })).toBe(true);
    expect(await p.isInCaseload({ organizationId: ORG, userId: RN, patientId: P3 })).toBe(false);
  });

  it("a different user has an empty caseload (no cross-actor leak)", async () => {
    registerPatientSeams({ caseload: { store: seededStore() } });
    validateSeams();
    const ids = await getCaseloadProvider().caseloadPatientIds({
      organizationId: ORG,
      userId: "other",
    });
    expect(ids).toEqual([]);
  });

  it("without registration the seam boots FAIL-CLOSED (deny-stub throws)", () => {
    validateSeams();
    expect(() =>
      getCaseloadProvider().isInCaseload({ organizationId: ORG, userId: RN, patientId: P1 }),
    ).toThrow(NotImplementedError);
  });

  it("the composition-root wireModuleSeams hook registers M5's seam during buildServer() boot", async () => {
    const app = buildServer({ registerModuleSeams: wireModuleSeams });
    // Boot completed AND it's the real impl (the default in-memory store has no assignments → false,
    // not the deny-stub throw).
    expect(
      await getCaseloadProvider().isInCaseload({ organizationId: ORG, userId: RN, patientId: P1 }),
    ).toBe(false);
    await app.close();
  });

  it("GAP-001 the registered caseload_membership predicate accepts {id} AND {patientId} targets", async () => {
    registerPatientSeams({ caseload: { store: seededStore() } });
    validateSeams();
    const ctx = { organizationId: ORG, userId: RN } as never;
    expect(await abacRegistry.evaluate("caseload_membership", ctx, { id: P1 })).toBe(true);
    expect(await abacRegistry.evaluate("caseload_membership", ctx, { patientId: P1 })).toBe(true);
    expect(await abacRegistry.evaluate("caseload_membership", ctx, { patientId: P3 })).toBe(false);
    expect(await abacRegistry.evaluate("caseload_membership", ctx, {})).toBe(false);
  });
});
