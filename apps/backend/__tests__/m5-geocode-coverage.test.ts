// apps/backend/__tests__/m5-geocode-coverage.test.ts — GAP-054 rollout dependency: the geofence baseline is the
// patient's geocoded service address, and nothing in the repo populates it yet. The coverage signal makes the
// gap observable (gauge + boot warning) instead of leaving every capture silently `no_geofence_baseline`.
import { Registry } from "prom-client";
import { describe, expect, it, vi } from "vitest";
import {
  registerGeocodeCoverageMetrics,
  sampleGeocodeCoverage,
  warnOnGeocodeCoverageGap,
} from "../src/bootstrap/geocode-coverage";

const ORG_A = "00000000-0000-4000-8000-00000000000a";
const ORG_B = "00000000-0000-4000-8000-00000000000b";

describe("sampleGeocodeCoverage", () => {
  it("sums active and un-geocoded patients across every org", async () => {
    const counts: Record<string, { activePatients: number; ungeocoded: number }> = {
      [ORG_A]: { activePatients: 10, ungeocoded: 4 },
      [ORG_B]: { activePatients: 5, ungeocoded: 0 },
    };
    const sample = await sampleGeocodeCoverage({
      listOrgs: async () => [{ organizationId: ORG_A }, { organizationId: ORG_B }],
      countForOrg: async (orgId) => counts[orgId] as { activePatients: number; ungeocoded: number },
    });
    expect(sample).toEqual({ orgsChecked: 2, orgsFailed: 0, activePatients: 15, ungeocoded: 4 });
  });

  it("counts a failing org as unmeasured, never as zero un-geocoded", async () => {
    const sample = await sampleGeocodeCoverage({
      listOrgs: async () => [{ organizationId: ORG_A }, { organizationId: ORG_B }],
      countForOrg: async (orgId) => {
        if (orgId === ORG_B) throw new Error("db down");
        return { activePatients: 3, ungeocoded: 3 };
      },
    });
    expect(sample).toMatchObject({ orgsChecked: 1, orgsFailed: 1, ungeocoded: 3 });
  });

  it("returns null when the org list itself cannot be read", async () => {
    const sample = await sampleGeocodeCoverage({
      listOrgs: async () => {
        throw new Error("no platform pool");
      },
      countForOrg: async () => ({ activePatients: 0, ungeocoded: 0 }),
    });
    expect(sample).toBeNull();
  });
});

describe("registerGeocodeCoverageMetrics", () => {
  it("exposes the un-geocoded count and -1 when not measured", async () => {
    const registry = new Registry();
    let sample: Awaited<ReturnType<typeof sampleGeocodeCoverage>> = {
      orgsChecked: 1,
      orgsFailed: 0,
      activePatients: 9,
      ungeocoded: 7,
    };
    registerGeocodeCoverageMetrics(registry, async () => sample);
    expect(await registry.metrics()).toContain("wardenx_patient_ungeocoded_active_total 7");
    sample = null;
    expect(await registry.metrics()).toContain("wardenx_patient_ungeocoded_active_total -1");
  });
});

describe("warnOnGeocodeCoverageGap", () => {
  it("warns loudly with the count when active patients have no coordinate", async () => {
    const warn = vi.fn();
    await warnOnGeocodeCoverageGap(
      async () => ({ orgsChecked: 1, orgsFailed: 0, activePatients: 9, ungeocoded: 7 }),
      { warn, info: vi.fn() },
    );
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warn.mock.calls[0])).toContain("no_geofence_baseline");
    expect(JSON.stringify(warn.mock.calls[0])).toContain("7");
  });

  it("stays at info level when every active patient is geocoded", async () => {
    const warn = vi.fn();
    const info = vi.fn();
    await warnOnGeocodeCoverageGap(
      async () => ({ orgsChecked: 1, orgsFailed: 0, activePatients: 9, ungeocoded: 0 }),
      { warn, info },
    );
    expect(warn).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledTimes(1);
  });

  it("warns that coverage is unmeasured when the sample is null, and never throws", async () => {
    const warn = vi.fn();
    await expect(
      warnOnGeocodeCoverageGap(async () => null, { warn, info: vi.fn() }),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
