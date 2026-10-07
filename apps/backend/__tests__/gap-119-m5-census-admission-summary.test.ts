// GAP-119 — the census KPI strip's admission-owned figures come from an injected M6-published summary port
// (org-explicit, counts only). A failing or absent port degrades to `admissions: null`; it never fails the
// census and never fabricates a number.
import type { DbClient } from "@wardenx/db";
import { describe, expect, it, vi } from "vitest";
import { createDbPatientRouteService } from "../src/modules/05-patient/patient-route-service-db";

const ORG = "org-1";

function db(rows: unknown) {
  const chain = (): unknown => {
    const node: Record<string, unknown> = new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === "then") return (resolve: (v: unknown) => void) => resolve(rows);
          return () => node;
        },
      },
    );
    return node;
  };
  const tx = { execute: async () => undefined, select: () => chain() };
  return {
    transaction: async (fn: (t: unknown) => Promise<unknown>) => fn(tx),
  } as unknown as DbClient;
}

const SUMMARY = {
  admissionsToday: 4,
  dischargesToday: 2,
  gipActive: 1,
  recertsDue: 7,
  asOfDate: "2026-10-06",
};

describe("GAP-119 — census metrics carry the M6 admission summary", () => {
  it("merges the summary beside the status counts, org-explicit", async () => {
    const summary = vi.fn(async () => SUMMARY);
    const service = createDbPatientRouteService(db([{ status: "active", n: 3 }]), undefined, {
      admissionSummary: summary,
    });
    const out = await service.censusMetrics(ORG);
    expect(out).toMatchObject({ total: 3, byStatus: { active: 3 }, admissions: SUMMARY });
    expect(summary).toHaveBeenCalledWith(ORG);
  });

  it("a failing summary port degrades to admissions: null — the census still answers", async () => {
    const service = createDbPatientRouteService(db([{ status: "active", n: 3 }]), undefined, {
      admissionSummary: async () => {
        throw new Error("m6 unavailable");
      },
    });
    const out = await service.censusMetrics(ORG);
    expect(out.total).toBe(3);
    expect(out.admissions).toBeNull();
  });

  it("no port bound -> admissions: null", async () => {
    const service = createDbPatientRouteService(db([{ status: "active", n: 3 }]));
    expect((await service.censusMetrics(ORG)).admissions).toBeNull();
  });
});
