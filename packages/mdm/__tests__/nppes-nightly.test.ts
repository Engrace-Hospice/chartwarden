// @wardenx/mdm — M40-T08 NPPES drift detection + the nightly-delta processor (§4.3, §7.5).
//
// The §7.5 headline: a deactivated NPI is caught by the nightly delta → the canonical flips to
// `deactivated`, every tenant with that physician preferred/active is alerted via M36, and the run
// is logged `outcome='success'`. Also locks the §4.3 fallback gate (skip when M29 synced < 25h ago),
// the pure drift engine's classification, and the §3.8 seed shape. Pure ports — no live infra.
import { describe, expect, it } from "vitest";
import {
  MDM_PAYER_SEED,
  MEDICARE_SEED,
  type NppesFreshRecord,
  type NppesKnownPhysician,
  type NppesNightlyPorts,
  type NppesSyncLogEntry,
  US_STATES,
  detectNppesDrift,
  runNppesNightlyDelta,
  toPayerCanonicalSeed,
} from "../src/index";

const NOW = new Date("2026-06-19T02:00:00Z");

const known: NppesKnownPhysician[] = [
  {
    npi: "1111111111",
    canonicalId: "c-active",
    status: "active",
    lastName: "Roe",
    specialtyTaxonomy: "207Q00000X",
  },
  {
    npi: "2222222222",
    canonicalId: "c-rename",
    status: "active",
    lastName: "Old",
    specialtyTaxonomy: "207Q00000X",
  },
  {
    npi: "3333333333",
    canonicalId: "c-dead",
    status: "deactivated",
    lastName: "Gone",
    specialtyTaxonomy: null,
  },
];

function freshMap(records: NppesFreshRecord[]): Map<string, NppesFreshRecord> {
  return new Map(records.map((r) => [r.npi, r]));
}

describe("detectNppesDrift (§7.5)", () => {
  it("flags an active→deactivated NPI as `deactivated`", () => {
    const drift = detectNppesDrift(
      known,
      freshMap([
        {
          npi: "1111111111",
          status: "deactivated",
          lastName: "Roe",
          specialtyTaxonomy: "207Q00000X",
        },
      ]),
    );
    expect(drift).toEqual([
      { npi: "1111111111", canonicalId: "c-active", kind: "deactivated", changedFields: [] },
    ]);
  });

  it("flags a changed surname as `attribute_changed` with the field list", () => {
    const drift = detectNppesDrift(
      known,
      freshMap([
        { npi: "2222222222", status: "active", lastName: "New", specialtyTaxonomy: "207Q00000X" },
      ]),
    );
    expect(drift).toEqual([
      {
        npi: "2222222222",
        canonicalId: "c-rename",
        kind: "attribute_changed",
        changedFields: ["lastName"],
      },
    ]);
  });

  it("flags a deactivated→active NPI as `reactivated`", () => {
    const drift = detectNppesDrift(
      known,
      freshMap([
        { npi: "3333333333", status: "active", lastName: "Gone", specialtyTaxonomy: null },
      ]),
    );
    expect(drift[0]?.kind).toBe("reactivated");
  });

  it("an NPI absent from the delta is not drift, and unchanged records are not drift", () => {
    const drift = detectNppesDrift(
      known,
      freshMap([
        { npi: "1111111111", status: "active", lastName: "Roe", specialtyTaxonomy: "207Q00000X" },
      ]),
    );
    expect(drift).toEqual([]);
  });
});

/** A capturing in-memory port set for the nightly processor. */
function makePorts(
  over: Partial<NppesNightlyPorts> & {
    fresh: NppesFreshRecord[];
    m29Last: Date | null;
    alertTargets?: Record<string, string[]>;
  },
): {
  ports: NppesNightlyPorts;
  deactivated: string[];
  alerts: Array<[string, string]>;
  log: NppesSyncLogEntry[];
} {
  const deactivated: string[] = [];
  const alerts: Array<[string, string]> = [];
  const log: NppesSyncLogEntry[] = [];
  const ports: NppesNightlyPorts = {
    now: () => NOW,
    m29LastSyncCompletedAt: async () => over.m29Last,
    loadKnownPhysicians: async () => known,
    fetchNppesDelta: async () => over.fresh,
    applyDeactivation: async (id) => void deactivated.push(id),
    applyAttributeUpdate: async () => undefined,
    tenantsToAlert: async (id) => over.alertTargets?.[id] ?? [],
    emitDeactivationAlert: async (orgId, canonicalId) => void alerts.push([orgId, canonicalId]),
    recordSyncLog: async (e) => void log.push(e),
    ...over,
  };
  return { ports, deactivated, alerts, log };
}

describe("runNppesNightlyDelta (§4.3 fallback gate, §7.5)", () => {
  it("§7.5 a deactivated NPI flips the canonical, alerts affected tenants, logs success", async () => {
    const { ports, deactivated, alerts, log } = makePorts({
      m29Last: null, // M29 never synced → the nightly is the authoritative path
      fresh: [
        {
          npi: "1111111111",
          status: "deactivated",
          lastName: "Roe",
          specialtyTaxonomy: "207Q00000X",
        },
      ],
      alertTargets: { "c-active": ["org_a", "org_b"] },
    });
    const result = await runNppesNightlyDelta(ports);

    expect(result.ran).toBe(true);
    expect(result.deactivations).toBe(1);
    expect(deactivated).toEqual(["c-active"]);
    expect(alerts).toEqual([
      ["org_a", "c-active"],
      ["org_b", "c-active"],
    ]);
    expect(log).toEqual([
      { mode: "nightly_delta", outcome: "success", driftCount: 1, deactivations: 1 },
    ]);
  });

  it("§4.3 skips (fallback-only) when M29 synced < 25h ago — no writes, no log", async () => {
    const { ports, deactivated, log } = makePorts({
      m29Last: new Date("2026-06-18T10:00:00Z"), // 16h before NOW
      fresh: [
        {
          npi: "1111111111",
          status: "deactivated",
          lastName: "Roe",
          specialtyTaxonomy: "207Q00000X",
        },
      ],
      alertTargets: { "c-active": ["org_a"] },
    });
    const result = await runNppesNightlyDelta(ports);

    expect(result.ran).toBe(false);
    expect(result.skippedReason).toBe("m29_recent");
    expect(deactivated).toEqual([]);
    expect(log).toEqual([]);
  });

  it("§4.3 fires as fallback when M29's last sync is > 25h old", async () => {
    const { ports, log } = makePorts({
      m29Last: new Date("2026-06-17T23:00:00Z"), // ~27h before NOW
      fresh: [
        {
          npi: "1111111111",
          status: "deactivated",
          lastName: "Roe",
          specialtyTaxonomy: "207Q00000X",
        },
      ],
      alertTargets: { "c-active": [] },
    });
    const result = await runNppesNightlyDelta(ports);
    expect(result.ran).toBe(true);
    expect(log[0]?.outcome).toBe("success");
  });
});

describe("§3.8 payer seed", () => {
  it("seeds Medicare + one Medicaid placeholder per state/DC (52 total)", () => {
    expect(MDM_PAYER_SEED).toHaveLength(US_STATES.length + 1);
    expect(MDM_PAYER_SEED).toContainEqual(MEDICARE_SEED);
    const medicaid = MDM_PAYER_SEED.filter((p) => p.kind === "medicaid");
    expect(medicaid).toHaveLength(US_STATES.length);
    expect(medicaid.every((p) => p.x12PayerId === null)).toBe(true);
  });

  it("projects to canonical payer rows with deterministic ids", () => {
    const rows = toPayerCanonicalSeed();
    const medicare = rows.find((r) => r.id === "payer_medicare");
    expect(medicare?.x12PayerId).toBe("MEDICARE");
    expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length); // unique ids
  });
});
