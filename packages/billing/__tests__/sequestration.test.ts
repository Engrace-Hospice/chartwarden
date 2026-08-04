import {
  DEFAULT_SEQUESTRATION_PERCENT,
  applySequestration,
  applySequestrationPolicy,
} from "@wardenx/billing";
// @wardenx/billing — M23 sequestration applier (D11, spec §1.1 / §3.3 `sequestration_policy`)
// pure-domain tests.
//
// The applier resolves WHICH percentage to apply — an active `sequestration_policy` snapshot for the
// claim's service period, or the platform-default constant (2% per the CMS-announced rate). The percentage
// is a decimal STRING end-to-end (never a float); the net + the reduction sum back to the gross EXACTLY,
// and the result records which percentage was applied and from where (so the service can snapshot it for
// reproducible, forward-only audit math). Pure: no DB/Fastify/BullMQ.
import { describe, expect, it } from "vitest";

describe("DEFAULT_SEQUESTRATION_PERCENT — the 2% platform-default constant", () => {
  it("is the CMS-announced 2.0% rate as a decimal string", () => {
    expect(DEFAULT_SEQUESTRATION_PERCENT).toBe("2.0");
  });
});

describe("applySequestrationPolicy — percentage resolution + provenance", () => {
  it("falls back to the platform default when no policy snapshot is supplied", () => {
    const r = applySequestrationPolicy(100_000);
    expect(r.source).toBe("platform_default");
    expect(r.percentApplied).toBe("2.0");
    expect(r.reductionCents).toBe(2_000);
    expect(r.netCents).toBe(98_000);
  });

  it("falls back to the platform default when policy is explicitly null", () => {
    const r = applySequestrationPolicy(100_000, null);
    expect(r.source).toBe("platform_default");
    expect(r.percentApplied).toBe("2.0");
  });

  it("uses the snapshot percentage when a policy is supplied (source: policy)", () => {
    const r = applySequestrationPolicy(100_000, { percentage: "1.0" });
    expect(r.source).toBe("policy");
    expect(r.percentApplied).toBe("1.0");
    expect(r.reductionCents).toBe(1_000);
    expect(r.netCents).toBe(99_000);
  });

  it("echoes the snapshot percentage string verbatim (preserving its precision)", () => {
    const r = applySequestrationPolicy(100_000, { percentage: "2.00" });
    expect(r.percentApplied).toBe("2.00");
    expect(r.reductionCents).toBe(2_000);
  });

  it("a 0% snapshot withholds nothing (net equals the gross)", () => {
    const r = applySequestrationPolicy(50_000, { percentage: "0" });
    expect(r.reductionCents).toBe(0);
    expect(r.netCents).toBe(50_000);
  });

  it("snapshot application overrides the default for a historical (forward-only) period", () => {
    // The same gross under two different period snapshots yields two different reductions — the snapshot,
    // not the live default, drives historical math.
    const covidEra = applySequestrationPolicy(100_000, { percentage: "1.0" });
    const current = applySequestrationPolicy(100_000, { percentage: "2.0" });
    expect(covidEra.reductionCents).toBe(1_000);
    expect(current.reductionCents).toBe(2_000);
    expect(covidEra.percentApplied).not.toBe(current.percentApplied);
  });
});

describe("applySequestrationPolicy — sum-preservation (net + reduction === gross)", () => {
  const grosses = [0, 1, 25, 99, 100, 10_001, 123_457, 999_999, 100_000_000];
  for (const gross of grosses) {
    it(`net + reduction === ${gross} exactly (default 2%)`, () => {
      const r = applySequestrationPolicy(gross);
      expect(r.netCents + r.reductionCents).toBe(gross);
    });
  }

  it("preserves the sum for a negative gross (an apportioned credit/adjustment)", () => {
    const r = applySequestrationPolicy(-100, { percentage: "2.0" });
    expect(r.netCents + r.reductionCents).toBe(-100);
  });
});

describe("applySequestration / applySequestrationPolicy — money rounding (HALF-UP)", () => {
  it("rounds a half-cent reduction HALF-UP (25 × 2% = 0.5 → 1)", () => {
    const r = applySequestration(25, "2.0");
    expect(r.reductionCents).toBe(1);
    expect(r.netCents).toBe(24);
  });

  it("rounds a sub-half reduction down (10001 × 2% = 200.02 → 200)", () => {
    const r = applySequestrationPolicy(10_001);
    expect(r.reductionCents).toBe(200);
    expect(r.netCents).toBe(9_801);
  });

  it("the withheld figure is itself a clean rounded cent value the remittance can reconcile", () => {
    const r = applySequestration(12_345, "2.0");
    // 12345 × 2% = 246.9 → 247.
    expect(r.reductionCents).toBe(247);
    expect(r.netCents).toBe(12_345 - 247);
  });
});

describe("applySequestration — percent range validation", () => {
  it("throws on a percentage above 100", () => {
    expect(() => applySequestration(100_000, "150")).toThrow(RangeError);
  });

  it("throws on a negative percentage", () => {
    expect(() => applySequestration(100_000, "-1")).toThrow(RangeError);
  });

  it("propagates the throw through the policy applier for an out-of-range snapshot", () => {
    expect(() => applySequestrationPolicy(100_000, { percentage: "101" })).toThrow(RangeError);
  });

  it("accepts the boundary 0% and 100%", () => {
    expect(applySequestration(100, "0").reductionCents).toBe(0);
    expect(applySequestration(100, "100").reductionCents).toBe(100);
    expect(applySequestration(100, "100").netCents).toBe(0);
  });
});
