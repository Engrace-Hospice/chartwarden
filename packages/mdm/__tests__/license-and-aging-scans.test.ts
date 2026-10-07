// GAP-173 — the pure license-expiration and provisional-aging planners, and the NPPES weekly-full sweep.
import { describe, expect, it } from "vitest";
import { planLicenseExpiryAlerts } from "../src/jobs/license-scan";
import {
  type NppesNightlyPorts,
  runNppesNightlyDelta,
  runNppesWeeklyFull,
} from "../src/jobs/processors";
import { PROVISIONAL_AGING_MAX_IDS, planProvisionalAging } from "../src/jobs/provisional-aging";

const TODAY = "2026-10-06";

describe("planLicenseExpiryAlerts", () => {
  const rec = (id: string, expiresOn: string) => ({
    id,
    organizationId: "org-1",
    entityKind: "physician",
    canonicalId: `phys-${id}`,
    licenseState: "OR",
    expiresOn,
  });

  it("plans the 90 / 30 / 0-day ladder with escalating severity and the spec'd payload fields", () => {
    const plans = planLicenseExpiryAlerts(
      [rec("a", "2027-01-01"), rec("b", "2026-10-20"), rec("c", "2026-10-01")],
      TODAY,
    );
    expect(plans.map((p) => [p.licenseRecordId, p.window, p.severity])).toEqual([
      ["a", "90_days", "info"],
      ["b", "30_days", "warn"],
      ["c", "expired", "critical"],
    ]);
    expect(plans[1]).toMatchObject({
      canonicalId: "phys-b",
      licenseState: "OR",
      daysUntilExpiry: 14,
    });
  });

  it("raises nothing for a license more than 90 days out, and keys windows idempotently", () => {
    expect(planLicenseExpiryAlerts([rec("far", "2027-06-01")], TODAY)).toEqual([]);
    const [d1] = planLicenseExpiryAlerts([rec("x", "2026-10-20")], TODAY);
    const [d2] = planLicenseExpiryAlerts([rec("x", "2026-10-20")], "2026-10-08");
    expect(d1?.correlationId).toBe(d2?.correlationId);
  });
});

describe("planProvisionalAging", () => {
  const NOW = new Date("2026-10-06T00:00:00Z");
  const row = (id: string, daysOld: number, kind = "facility") => ({
    id,
    organizationId: "org-1",
    entityKind: kind,
    createdAt: new Date(NOW.getTime() - daysOld * 86_400_000),
  });

  it("escalates only rows pending longer than 14 days, as one digest per org", () => {
    const plan = planProvisionalAging(
      "org-1",
      [row("fresh", 3), row("edge", 14), row("old", 30), row("older", 45, "payer")],
      NOW,
    );
    expect(plan).toMatchObject({
      organizationId: "org-1",
      agedCount: 2,
      oldestAgeDays: 45,
      byKind: { facility: 1, payer: 1 },
      sampleIds: ["older", "old"],
    });
  });

  it("returns null when nothing is past the threshold, and caps the quoted ids", () => {
    expect(planProvisionalAging("org-1", [row("a", 14), row("b", 1)], NOW)).toBeNull();
    const many = Array.from({ length: PROVISIONAL_AGING_MAX_IDS + 5 }, (_, i) =>
      row(`r${i}`, 20 + i),
    );
    const plan = planProvisionalAging("org-1", many, NOW);
    expect(plan?.agedCount).toBe(PROVISIONAL_AGING_MAX_IDS + 5);
    expect(plan?.sampleIds).toHaveLength(PROVISIONAL_AGING_MAX_IDS);
  });
});

describe("runNppesWeeklyFull", () => {
  function ports(overrides: Partial<NppesNightlyPorts> = {}) {
    const logged: unknown[] = [];
    const deactivated: string[] = [];
    const base: NppesNightlyPorts = {
      now: () => new Date("2026-10-06T00:00:00Z"),
      m29LastSyncCompletedAt: async () => new Date("2026-10-05T23:00:00Z"), // 1h ago: delta would skip
      loadKnownPhysicians: async () => [
        { npi: "1", canonicalId: "c1", status: "active", lastName: "Roe", specialtyTaxonomy: null },
      ],
      fetchNppesDelta: async () => [
        { npi: "1", status: "deactivated", lastName: "Roe", specialtyTaxonomy: null },
      ],
      applyDeactivation: async (id) => {
        deactivated.push(id);
      },
      applyAttributeUpdate: async () => undefined,
      tenantsToAlert: async () => [],
      emitDeactivationAlert: async () => undefined,
      recordSyncLog: async (entry) => {
        logged.push(entry);
      },
      ...overrides,
    };
    return { base, logged, deactivated };
  }

  it("runs even when M29 synced an hour ago (the nightly delta would skip) and logs mode weekly_full", async () => {
    const { base, logged, deactivated } = ports();
    expect((await runNppesNightlyDelta(base)).ran).toBe(false);
    const result = await runNppesWeeklyFull(base);
    expect(result).toMatchObject({ ran: true, deactivations: 1 });
    expect(deactivated).toEqual(["c1"]);
    expect(logged).toEqual([
      { mode: "weekly_full", outcome: "success", driftCount: 1, deactivations: 1 },
    ]);
  });
});
