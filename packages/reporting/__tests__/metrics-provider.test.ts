// #107 item 2 — M33's published MetricsProvider: with no MV executor bound it returns the FORWARD-SEAM
// empty value (value:null, isForwardSeamDenyStub:true) over the authoritative catalog unit — never a
// fabricated number (D6/D13). This is the state the seam is registered in today (MVs not yet materialized).
import type { ReadReplicaSessionPort } from "@wardenx/reporting";
import { MetricsProviderImpl } from "@wardenx/reporting";
import { describe, expect, it } from "vitest";

/** A fake replica session whose `withSession` hands the body a db returning the seeded metric-catalog row. */
function replicaWithMetric(row: { metricKey: string; unit: string } | null): ReadReplicaSessionPort {
  const limit = () => Promise.resolve(row ? [row] : []);
  const db = { select: () => ({ from: () => ({ where: () => ({ limit }) }) }) };
  return { withSession: (_req, fn) => fn(db as never) };
}

describe("MetricsProviderImpl — forward-seam (no executor)", () => {
  it("returns value:null + the catalog unit + isForwardSeamDenyStub for a known metric", async () => {
    const provider = new MetricsProviderImpl({
      replica: replicaWithMetric({ metricKey: "late_sign_rate_pct", unit: "rate_pct" }),
    });

    const r = await provider.getDashboardMetric({
      metricKey: "late_sign_rate_pct",
      organizationId: "org-1",
    });

    expect(r.value).toBeNull();
    expect(r.unit).toBe("rate_pct");
    expect(r.isForwardSeamDenyStub).toBe(true);
    expect(r.rowCount).toBe(0);
  });

  it("falls back to unit 'count' + forward-seam for an unknown metric key", async () => {
    const provider = new MetricsProviderImpl({ replica: replicaWithMetric(null) });

    const r = await provider.getDashboardMetric({ metricKey: "nope", organizationId: "org-1" });

    expect(r.value).toBeNull();
    expect(r.unit).toBe("count");
    expect(r.isForwardSeamDenyStub).toBe(true);
  });

  it("bulk read returns a value:null entry per key", async () => {
    const provider = new MetricsProviderImpl({
      replica: replicaWithMetric({ metricKey: "x", unit: "ratio" }),
    });

    const rows = await provider.getDashboardMetricsBulk({
      metricKeys: ["a", "b"],
      organizationId: "org-1",
    });

    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.value === null)).toBe(true);
  });
});
