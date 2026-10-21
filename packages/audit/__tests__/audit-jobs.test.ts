// @chartwarden/audit — M4-T11 audit job processor tests (M4 spec §4.4, §6, §12.2).
//
// The pure processors each BullMQ worker runs, exercised against the in-memory ports: the daily
// retention scan (skips held + not-yet-erasable Part 2), the on-approval destruction run, the
// quarterly integrity sample, the on-request export build, and the Phase-2 (flag-gated) seal.
import { describe, expect, it } from "vitest";
import {
  AUDIT_QUEUES,
  type AuditEventRecord,
  type DestructionRun,
  type RetentionCandidate,
  auditJobDescriptors,
  createInMemoryBuildExportPorts,
  createInMemoryExecuteDestructionPorts,
  createInMemoryIntegritySamplePorts,
  createInMemoryRetentionScanPorts,
  createInMemorySealPartitionPorts,
  planRetentionScan,
  runBuildExport,
  runExecuteDestruction,
  runIntegritySample,
  runRetentionScan,
  runSealPartition,
} from "../src/index";

const NOW = new Date("2026-06-15T00:00:00.000Z");

function candidate(over: Partial<RetentionCandidate>): RetentionCandidate {
  return {
    partition: "audit_event_2019_01",
    organizationId: "org_1",
    dataClass: "audit_event",
    retentionClass: "compliance",
    expiresAt: "2026-01-01T00:00:00.000Z", // already past NOW
    ...over,
  };
}

describe("planRetentionScan (§4.4, §6)", () => {
  it("opens a certificate for an expired compliance partition", () => {
    const [d] = planRetentionScan([candidate({})], NOW);
    expect(d).toMatchObject({ action: "open_certificate" });
  });

  it("skips a partition that has not yet expired", () => {
    const [d] = planRetentionScan([candidate({ expiresAt: "2030-01-01T00:00:00.000Z" })], NOW);
    expect(d).toMatchObject({ action: "skip", reason: "not_expired" });
  });

  it("never destroys a legal_hold partition", () => {
    const [d] = planRetentionScan([candidate({ retentionClass: "legal_hold" })], NOW);
    expect(d).toMatchObject({ action: "skip", reason: "legal_hold" });
  });

  it("skips a Part 2 partition whose patient is still alive", () => {
    const [d] = planRetentionScan(
      [candidate({ retentionClass: "compliance_42cfr_part2", patient: { status: "active" } })],
      NOW,
    );
    expect(d).toMatchObject({ action: "skip", reason: "part_two_lifetime" });
  });

  it("skips a Part 2 partition within 6 years post-death, opens one past it", () => {
    const within = planRetentionScan(
      [
        candidate({
          retentionClass: "compliance_42cfr_part2",
          patient: { status: "deceased", deceasedDate: "2025-01-01" },
        }),
      ],
      NOW,
    );
    expect(within[0]).toMatchObject({ action: "skip", reason: "part_two_lifetime" });

    const past = planRetentionScan(
      [
        candidate({
          retentionClass: "compliance_42cfr_part2",
          patient: { status: "deceased", deceasedDate: "2015-01-01" },
        }),
      ],
      NOW,
    );
    expect(past[0]).toMatchObject({ action: "open_certificate" });
  });

  it("skips a Part 2 partition with no resolvable patient (conservative)", () => {
    const [d] = planRetentionScan(
      [candidate({ retentionClass: "compliance_42cfr_part2", patient: null })],
      NOW,
    );
    expect(d).toMatchObject({ action: "skip", reason: "part_two_lifetime" });
  });
});

describe("runRetentionScan (§4.4)", () => {
  it("opens certs for eligible candidates and records every skip with its reason", async () => {
    const { ports, opened } = createInMemoryRetentionScanPorts({
      candidates: [
        candidate({ partition: "p_eligible" }),
        candidate({ partition: "p_held", retentionClass: "legal_hold" }),
        candidate({ partition: "p_fresh", expiresAt: "2030-01-01T00:00:00.000Z" }),
      ],
      now: NOW.toISOString(),
    });
    const result = await runRetentionScan(ports);
    expect(result.opened).toEqual([{ partition: "p_eligible", certificateId: "cert_1" }]);
    expect(opened().map((c) => c.partition)).toEqual(["p_eligible"]);
    expect(result.skipped).toContainEqual({ partition: "p_held", reason: "legal_hold" });
    expect(result.skipped).toContainEqual({ partition: "p_fresh", reason: "not_expired" });
  });
});

describe("runExecuteDestruction (§6, §10.5)", () => {
  function run(rows: DestructionRun["rows"]): DestructionRun {
    return { certificateId: "cert_1", dataClass: "audit_event", organizationId: "org_1", rows };
  }

  it("erases eligible rows, refuses an alive-patient Part 2 row, and lands partial_refused", async () => {
    const { ports, emitted, statuses } = createInMemoryExecuteDestructionPorts({
      patients: { pt_alive: { status: "active" } },
      now: NOW.toISOString(),
    });
    const result = await runExecuteDestruction(
      run([
        {
          retentionClass: "compliance",
          resourceKind: "audit_event",
          resourceId: "e1",
          organizationId: "org_1",
          destructionCertificateId: "cert_1",
        },
        {
          retentionClass: "compliance_42cfr_part2",
          resourceKind: "audit_event",
          resourceId: "e2",
          organizationId: "org_1",
          destructionCertificateId: "cert_1",
          patientId: "pt_alive",
        },
      ]),
      ports,
    );
    expect(result.status).toBe("partial_refused");
    expect(result.rowsErased).toBe(1);
    expect(result.refusedPartTwo).toBe(1);
    // Both the Part 2 refusal and the certification are emitted through the writer.
    const actions = emitted().map((e) => e.action);
    expect(actions).toContain("audit.destruction_refused_part_two");
    expect(actions).toContain("data.destruction_certified");
    expect(statuses()).toEqual([{ certificateId: "cert_1", status: "partial_refused" }]);
  });
});

describe("runIntegritySample (§4.4, §12.3)", () => {
  it("reports a clean sample with no alert", async () => {
    const rows = [{ id: "e1", hash: "h1" }];
    const { ports, alerts } = createInMemoryIntegritySamplePorts({ live: rows, backup: rows });
    const result = await runIntegritySample(ports);
    expect(result).toMatchObject({ checked: 1, alerted: false });
    expect(result.mismatches).toEqual([]);
    expect(alerts()).toEqual([]);
  });

  it("alerts when the backup diverges from the live sample", async () => {
    const { ports, alerts } = createInMemoryIntegritySamplePorts({
      live: [{ id: "e1", hash: "h1" }],
      backup: [{ id: "e1", hash: "TAMPERED" }],
    });
    const result = await runIntegritySample(ports);
    expect(result.alerted).toBe(true);
    expect(result.mismatches[0]).toMatchObject({ id: "e1", kind: "altered" });
    expect(alerts()).toEqual([["e1"]]);
  });
});

describe("runBuildExport (§4.3, §4.4)", () => {
  function record(id: string): AuditEventRecord {
    return {
      id,
      createdAt: "2026-06-15T12:00:00.000Z",
      organizationId: "org_1",
      actorUserId: "user_7",
      actorKind: "user",
      actorRole: "compliance_officer",
      eventType: "patient.viewed",
      resourceKind: "patient",
      resourceId: "pt_9",
      outcome: "success",
      severity: "info",
      before: null,
      after: null,
      context: {},
      retentionClass: "compliance",
    };
  }

  it("renders the watermarked artifact and stores it, returning the object ref", async () => {
    const { ports, stored } = createInMemoryBuildExportPorts({
      records: [record("e1"), record("e2")],
    });
    const result = await runBuildExport(
      "exp_1",
      { format: "ndjson", watermark: "wm" },
      ports,
    );
    expect(result).toMatchObject({ exportId: "exp_1", recordCount: 2, format: "ndjson" });
    const artifact = stored().get(result.fileRef);
    expect(artifact?.watermark).toBe("wm");
    expect(artifact?.recordCount).toBe(2);
  });
});

describe("runSealPartition (§3.5, Phase 2 flag gate)", () => {
  it("is inert (flag_disabled) when the hash-chain flag is off", async () => {
    const { ports, sealed } = createInMemorySealPartitionPorts({
      enabled: false,
      events: [{ id: "e1", hash: "h1" }],
    });
    const result = await runSealPartition("p1", "org_1", ports);
    expect(result).toEqual({ sealed: false, reason: "flag_disabled" });
    expect(sealed()).toEqual([]);
  });

  it("skips an empty partition when the flag is on", async () => {
    const { ports } = createInMemorySealPartitionPorts({ enabled: true, events: [] });
    expect(await runSealPartition("p1", "org_1", ports)).toEqual({ sealed: false, reason: "empty" });
  });

  it("seals and stores a checkpoint when the flag is on and events exist", async () => {
    const { ports, sealed } = createInMemorySealPartitionPorts({
      enabled: true,
      events: [{ id: "e1", hash: "h1" }, { id: "e2", hash: "h2" }],
      prevChainHash: null,
    });
    const result = await runSealPartition("p1", "org_1", ports);
    expect(result.sealed).toBe(true);
    expect(result.seal).toMatchObject({ partition: "p1", fromId: "e1", toId: "e2", eventCount: 2 });
    expect(sealed()).toHaveLength(1);
  });
});

describe("auditJobDescriptors (§4.4 queue→processor mapping)", () => {
  it("maps every M4 queue (archive is M1-owned, omitted) to a processor", () => {
    const adapters = {
      retentionScan: createInMemoryRetentionScanPorts({}).ports,
      executeDestruction: createInMemoryExecuteDestructionPorts().ports,
      integritySample: createInMemoryIntegritySamplePorts({ live: [], backup: [] }).ports,
      buildExport: createInMemoryBuildExportPorts({ records: [] }).ports,
      sealPartition: createInMemorySealPartitionPorts({ enabled: false }).ports,
    };
    const queues = auditJobDescriptors(adapters).map((d) => d.queue);
    expect(queues).toEqual([
      AUDIT_QUEUES.retentionScan,
      AUDIT_QUEUES.executeDestruction,
      AUDIT_QUEUES.integritySample,
      AUDIT_QUEUES.buildExport,
      AUDIT_QUEUES.sealPartition,
    ]);
    expect(queues).not.toContain(AUDIT_QUEUES.archive);
  });

  it("routes a seal_partition job's data through runSealPartition (flag off → inert)", async () => {
    const adapters = {
      retentionScan: createInMemoryRetentionScanPorts({}).ports,
      executeDestruction: createInMemoryExecuteDestructionPorts().ports,
      integritySample: createInMemoryIntegritySamplePorts({ live: [], backup: [] }).ports,
      buildExport: createInMemoryBuildExportPorts({ records: [] }).ports,
      sealPartition: createInMemorySealPartitionPorts({ enabled: false }).ports,
    };
    const sealDescriptor = auditJobDescriptors(adapters).find(
      (d) => d.queue === AUDIT_QUEUES.sealPartition,
    )!;
    const result = await sealDescriptor.process({ partition: "p1", organizationId: "org_1" });
    expect(result).toEqual({ sealed: false, reason: "flag_disabled" });
  });
});
