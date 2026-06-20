// M38-T10 — the §4.3 background jobs: pure processors over in-memory ports.
//
// Accept: refresh_expansions recomputes the materialized expansion for the loaded system's value
// sets via the T07 engine (§7.5); tenant_deprecation_scan rolls a tenant's records up by deprecated
// code (T07 §7.3) and emits the M36 alert only when records are affected (§8.1); the queue catalog
// names the nine §4.3 queues.
import { describe, expect, it } from "vitest";
import {
  TERMINOLOGY_QUEUES,
  createInMemoryRefreshExpansionsPorts,
  createInMemoryTenantDeprecationScanPorts,
  runRefreshExpansions,
  runTenantDeprecationScan,
} from "../src/jobs/index";
import type { ValueSetMemberRow } from "../src/expansion/index";
import type { TenantCodeRecord } from "../src/remediation/index";
import type { ScanDeprecation } from "../src/jobs/processors";

describe("M38-T10 jobs — refresh_expansions (§7.5)", () => {
  it("recomputes the expansion for the loaded system's value sets and reports them", async () => {
    const members: ValueSetMemberRow[] = [
      { valueSetId: "vs_b", systemId: "icd10cm", code: "I50.21", memberEffective: "2024-01-01", memberEnd: null },
      { valueSetId: "vs_a", systemId: "icd10cm", code: "G30.9", memberEffective: "2024-01-01", memberEnd: null },
      { valueSetId: "vs_a", systemId: "icd10cm", code: "I50.22", memberEffective: "2024-01-01", memberEnd: null },
    ];
    const { ports, written } = createInMemoryRefreshExpansionsPorts({ membersBySystem: { icd10cm: members } });

    const result = await runRefreshExpansions("icd10cm", ports);

    expect(result.rowsWritten).toBe(3);
    expect(result.valueSetIds).toEqual(["vs_a", "vs_b"]); // distinct + sorted
    expect(written()).toHaveLength(3);
  });

  it("writes nothing for a system with no value-set members", async () => {
    const { ports, written } = createInMemoryRefreshExpansionsPorts({});
    const result = await runRefreshExpansions("rxnorm", ports);
    expect(result).toEqual({ valueSetIds: [], rowsWritten: 0 });
    expect(written()).toHaveLength(0);
  });
});

describe("M38-T10 jobs — tenant_deprecation_scan (§7.3 / §8.1)", () => {
  const deprecations: ScanDeprecation[] = [
    {
      systemId: "icd10cm",
      deprecatedCode: "I50.0",
      deprecationEffective: "2024-10-01",
      successorCodes: ["I50.21"],
      mappingKind: "equivalent",
      guidance: "Use the systolic/diastolic split.",
    },
  ];

  it("builds the rollup and emits the M36 alert when records are affected", async () => {
    const records: TenantCodeRecord[] = [
      { recordId: "p1", recordType: "problem_list", systemId: "icd10cm", code: "I50.0" },
      { recordId: "p2", recordType: "claim_line", systemId: "icd10cm", code: "I50.0" },
      { recordId: "p3", recordType: "problem_list", systemId: "icd10cm", code: "G30.9" }, // active → not remediation
    ];
    const { ports, alerts } = createInMemoryTenantDeprecationScanPorts({
      recordsByOrg: { org_1: records },
      deprecations,
    });

    const result = await runTenantDeprecationScan("org_1", ports);

    expect(result.report.totalAffected).toBe(2);
    expect(result.report.affectedCodeCount).toBe(1);
    expect(alerts()).toHaveLength(1);
    expect(alerts()[0].orgId).toBe("org_1");
  });

  it("emits no alert for a tenant with no affected records", async () => {
    const { ports, alerts } = createInMemoryTenantDeprecationScanPorts({
      recordsByOrg: { org_1: [{ recordId: "p1", recordType: "problem_list", systemId: "icd10cm", code: "G30.9" }] },
      deprecations,
    });
    const result = await runTenantDeprecationScan("org_1", ports);
    expect(result.report.totalAffected).toBe(0);
    expect(alerts()).toHaveLength(0);
  });
});

describe("M38-T10 jobs — queue catalog (§4.3)", () => {
  it("names the nine §4.3 queues", () => {
    expect(Object.values(TERMINOLOGY_QUEUES)).toEqual([
      "terminology.load_version",
      "terminology.refresh_expansions",
      "terminology.refresh_embeddings",
      "terminology.tenant_deprecation_scan",
      "terminology.scheduled_icd10cm",
      "terminology.scheduled_snomed",
      "terminology.scheduled_rxnorm",
      "terminology.scheduled_loinc",
      "terminology.scheduled_other",
    ]);
  });
});
