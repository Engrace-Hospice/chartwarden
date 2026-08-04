// M23 ← M26 cap-projection adapter unit test (D8). Exercises buildM23CapProjectionAdapter over a stub M26
// seam — no M1 registry / no DB — proving the cap-year→service-date map, the band→withinCap/ipuWithinCap
// derivation, and the DEGRADE contract (deny-stub throw / null → status:"unavailable", warn not block).
import { describe, expect, it, vi } from "vitest";
import { buildM23CapProjectionAdapter } from "../services/cap-projection-adapter";

type Agency = { totalAllocatedCap: string; utilizationPct: number; band: string } | null;
type Inpatient = { band: string } | null;

function seam(agency: Agency, inpatient: Inpatient, patient: Agency = agency) {
  return {
    getProjectionForServiceDate: vi.fn(async (_o: string, _d: string, scope: string) =>
      scope === "patient_aggregate" ? patient : agency,
    ),
    getInpatientProjectionForServiceDate: vi.fn(async () => inpatient),
  };
}

describe("buildM23CapProjectionAdapter (M23 §11.A cap projection)", () => {
  it("maps the org projection: pctOfCap from utilization; ipuWithinCap from the inpatient band", async () => {
    const s = seam(
      { totalAllocatedCap: "6893068", utilizationPct: 92.3, band: "watch" },
      { band: "watch" },
    );
    const adapter = buildM23CapProjectionAdapter(() => s);
    const r = await adapter.projectionForOrg("org-1", "pe-1", 2025);
    // cap year 2025 → the seam is queried at the cap-year service date 2025-09-30.
    expect(s.getProjectionForServiceDate).toHaveBeenCalledWith(
      "org-1",
      "2025-09-30",
      "agency_aggregate",
    );
    expect(r).toEqual({
      status: "ok",
      aggregateProjectedCents: Math.round((92.3 / 100) * 6_893_068),
      aggregateCapCents: 6_893_068,
      pctOfCap: 92.3,
      ipuWithinCap: true,
    });
  });

  it("inpatient band 'breach' → ipuWithinCap false; absent inpatient → within cap (true)", async () => {
    const breach = buildM23CapProjectionAdapter(() =>
      seam({ totalAllocatedCap: "100", utilizationPct: 50, band: "safe" }, { band: "breach" }),
    );
    expect((await breach.projectionForOrg("o", "p", 2025)).ipuWithinCap).toBe(false);
    const none = buildM23CapProjectionAdapter(() =>
      seam({ totalAllocatedCap: "100", utilizationPct: 50, band: "safe" }, null),
    );
    expect((await none.projectionForOrg("o", "p", 2025)).ipuWithinCap).toBe(true);
  });

  it("patient projection: withinCap from the band; cap-year service date keyed", async () => {
    const s = seam(null, null, { totalAllocatedCap: "3446534", utilizationPct: 80, band: "warn" });
    const r = await buildM23CapProjectionAdapter(() => s).projectionForPatient(
      "org-1",
      "pat-1",
      2026,
    );
    expect(s.getProjectionForServiceDate).toHaveBeenCalledWith(
      "org-1",
      "2026-09-30",
      "patient_aggregate",
      "pat-1",
    );
    expect(r).toEqual({
      status: "ok",
      projectedCapCents: Math.round((80 / 100) * 3_446_534),
      capLimitCents: 3_446_534,
      withinCap: true,
    });
    const breach = seam(null, null, {
      totalAllocatedCap: "100",
      utilizationPct: 130,
      band: "breach",
    });
    expect(
      (await buildM23CapProjectionAdapter(() => breach).projectionForPatient("o", "p", 2026))
        .withinCap,
    ).toBe(false);
  });

  it("degrades to status:'unavailable' on a null projection (M26 has no cap period)", async () => {
    const adapter = buildM23CapProjectionAdapter(() => seam(null, null, null));
    expect((await adapter.projectionForOrg("o", "p", 2025)).status).toBe("unavailable");
    expect((await adapter.projectionForPatient("o", "p", 2025)).status).toBe("unavailable");
  });

  it("degrades (never throws) when the seam itself throws — the M1 deny-stub (D8)", async () => {
    const denyStub = {
      getProjectionForServiceDate: () => {
        throw new Error("NotImplemented: CapProjectionProvider");
      },
      getInpatientProjectionForServiceDate: () => {
        throw new Error("NotImplemented: CapProjectionProvider");
      },
    };
    const adapter = buildM23CapProjectionAdapter(() => denyStub as never);
    expect(await adapter.projectionForOrg("o", "p", 2025)).toMatchObject({
      status: "unavailable",
      ipuWithinCap: null,
    });
    expect(await adapter.projectionForPatient("o", "p", 2025)).toMatchObject({
      status: "unavailable",
      withinCap: null,
    });
  });
});
