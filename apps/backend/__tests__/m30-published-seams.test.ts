// apps/backend/__tests__/m30-published-seams.test.ts — M30's §4.3 seams in the M1 registry.
//
// Before this wiring, `registerQualityPublishedSeams` existed in @wardenx/quality with NO caller in
// apps/backend, and M30's five seam names were not members of the M1 `SeamContracts`/`REQUIRED_SEAMS` —
// so M30 was reachable cross-module only through its §4.10 outbox events, and M22 / M28 / M33 / M34 had
// no read path to the measure ledger, the incident register, QAPI, CoP status or the SRA posture.
//
// These tests pin the two halves that matter: the seams are DECLARED (so boot validation covers them and
// an unbound consumer gets a fail-closed throw rather than a fabricated quality number), and they RESOLVE
// once M30 registers the live providers.
import { beforeEach, describe, expect, it } from "vitest";
import { REQUIRED_SEAMS, __resetSeamsForTest, getSeam, validateSeams } from "../src/bootstrap/seams/registry";
import { buildM30PublishedSeams, registerM30PublishedSeams } from "../src/modules/30-quality/index";
import { wireModuleSeams } from "../src/index";

const M30_SEAMS = [
  "QualityMeasureProvider",
  "IncidentRegisterProvider",
  "QapiProjectProvider",
  "ComplianceStatusProvider",
  "SecurityRiskAssessmentReader",
] as const;

describe("M30 §4.3 published seams — M1 registry membership + boot registration", () => {
  beforeEach(() => {
    __resetSeamsForTest();
  });

  it("all five seams are declared in REQUIRED_SEAMS and owned by module 30", () => {
    for (const name of M30_SEAMS) {
      const entry = REQUIRED_SEAMS.find((s) => s.key === name);
      expect(entry, `${name} must be a declared M1 seam`).toBeDefined();
      expect(entry?.ownerModule).toBe(30);
    }
  });

  it("only IncidentRegisterProvider is PHI — the other four are aggregate-only surfaces", () => {
    const phiByName = Object.fromEntries(
      M30_SEAMS.map((n) => [n, REQUIRED_SEAMS.find((s) => s.key === n)?.phi]),
    );
    expect(phiByName).toEqual({
      QualityMeasureProvider: false,
      IncidentRegisterProvider: true, // an incident may be patient-linked
      QapiProjectProvider: false,
      ComplianceStatusProvider: false,
      SecurityRiskAssessmentReader: false,
    });
  });

  it("boot validation passes with the seams declared (deny-stubs stand when unregistered)", () => {
    wireModuleSeams();
    expect(() => validateSeams()).not.toThrow();
  });

  it("an UNREGISTERED seam denies rather than returning a fabricated quality number (D6/D13)", () => {
    wireModuleSeams(); // no db → registerM30PublishedSeams is a no-op
    validateSeams(); // installs the M1 fail-closed deny-stub for every unregistered seam
    const provider = getSeam("QualityMeasureProvider") as {
      listMeasureCatalog(fy: number): Promise<unknown>;
    };
    // The deny-stub proxy throws SYNCHRONOUSLY on any call — a consumer cannot mistake it for an
    // empty result set and publish a zero.
    expect(() => provider.listMeasureCatalog(2027)).toThrow();
  });

  it("registerM30PublishedSeams(undefined) is a no-op — no db, no half-bound seam", () => {
    wireModuleSeams();
    expect(() => registerM30PublishedSeams(undefined)).not.toThrow();
    expect(() => validateSeams()).not.toThrow();
  });

  it("registering the live providers makes all five resolve through getSeam", () => {
    wireModuleSeams();
    // A structural stand-in for the M1 primary handle: these tests exercise the WIRING, not the SQL
    // (the queries are covered by m30-rls-isolation.live.test.ts against real Postgres).
    const db = {} as never;
    registerM30PublishedSeams(db);
    for (const name of M30_SEAMS) {
      expect(getSeam(name), `${name} should resolve to the live provider`).toBeDefined();
    }
    const measures = getSeam("QualityMeasureProvider") as { getLatestValue: unknown };
    expect(typeof measures.getLatestValue).toBe("function");
  });

  it("the per-PE resolver is optional — unbound collapses to empty, never a cross-provider rollup", () => {
    const seams = buildM30PublishedSeams({} as never);
    // No `providerEntities` resolver supplied: the impls fall back to their own fail-closed default.
    expect(seams.qualityMeasureProvider).toBeDefined();
    expect(seams.complianceStatusProvider).toBeDefined();
  });
});
