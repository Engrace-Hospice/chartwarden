// M27 cap-context resolver unit test (the M26 cost-report cap bind, D13). Exercises resolveCapContext over a
// stub seam — no M1 registry / no DB — proving the map (cents-as-string → integer Cents) and the fail-closed
// contract (deny-stub throw / null → capProviderBound:false so the cap rules SKIP).
import { describe, expect, it } from "vitest";
import { type CapAggregateSeam, resolveCapContext } from "../routes/cap-context";

describe("resolveCapContext (M27 ← M26 CapAccrualReader)", () => {
  it("maps the live cap aggregate to CapContext (string cents → integer Cents) + binds", async () => {
    const seam: CapAggregateSeam = {
      async aggregateForCostReport(orgId, capYear) {
        expect(orgId).toBe("org-1");
        expect(capYear).toBe("FY2025");
        return {
          aggregateCapCents: "6893068",
          aggregatePaymentsCents: "7000000",
          inpatientDays: 7,
          totalMedicareDays: 100,
        };
      },
    };
    const r = await resolveCapContext(() => seam, "org-1", "FY2025");
    expect(r.capProviderBound).toBe(true);
    expect(r.capContext).toEqual({
      aggregateCapCents: 6_893_068,
      aggregatePaymentsCents: 7_000_000,
      inpatientDays: 7,
      totalMedicareDays: 100,
    });
  });

  it("no cap period for the year (null) → unbound, fail-closed (rules skip)", async () => {
    const seam: CapAggregateSeam = { async aggregateForCostReport() { return null; } };
    const r = await resolveCapContext(() => seam, "org-1", "FY2099");
    expect(r).toEqual({ capContext: null, capProviderBound: false });
  });

  it("the M1 deny-stub (throws SEAM_NOT_BOUND) → unbound, never fabricates", async () => {
    const denyStub: CapAggregateSeam = {
      async aggregateForCostReport() {
        throw new Error("NotImplemented: CapAccrualReader");
      },
    };
    const r = await resolveCapContext(() => denyStub, "org-1", "FY2025");
    expect(r).toEqual({ capContext: null, capProviderBound: false });
  });
});
