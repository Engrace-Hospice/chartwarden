// apps/backend/__tests__/m34-provision-dsar.test.ts — M34 workflow-acceptance tests over the
// `tenant.provision` (§7.1) + `tenant.dsar_export` (§7.3) pure workers, driven with in-memory ports
// (the mdm-eraser.test.ts / M40 `runNppesNightlyDelta` convention — no DB / MinIO / queue).
//
// Proves the ORCHESTRATION + IDEMPOTENCY the spec binds:
//   • provision runs the §7.1 step-2 side effects IN ORDER (key-ring → MinIO prefixes → org → onboarding
//     tasks → first-admin invitation → `provisioned` transition + outbox), stamps the 14-day invite TTL,
//     and reports the surveyor summary; on replay (status ≠ provisioning) it short-circuits to a no-op and
//     touches none of the side-effect ports; an empty transition reason / vanished row are refused.
//   • the dsar-export worker resolves the merged subject, fans out the registered `TenantExportShard`s in
//     deterministic (sorted) order recording a per-module receipt, seals + hashes the bundle, renders the
//     §1.1 chart PDF DIRECTLY through M22's DocumentRenderer (GAP-048 — no outbox round-trip; the bundle
//     back-ref = jobId) then emits `m34.dsar_export.completed`, drives requested→generating→review_pending,
//     and is digest-stable across a replay.
import {
  DSAR_BUNDLE_PRESIGNED_TTL_MS,
  type DsarExportJobInput,
  type DsarExportWorkerPorts,
  type DsarShardReceipt,
  FIRST_ADMIN_INVITATION_TTL_DAYS,
  type FhirResourceSink,
  M34_DSAR_EXPORT_COMPLETED,
  PROVISION_MINIO_PREFIXES,
  type ProvisionJob,
  type ProvisionWorkerPorts,
  type TenantExportShard,
  TenantLifecycleError,
  __resetModule34SeamsForTest,
  registerTenantExportShard,
  runDsarExportJob,
  runTenantProvision,
} from "@wardenx/saas-tenant-platform";
import { beforeEach, describe, expect, it } from "vitest";

// ────────────────────────────────────────────────────────────────────────────────────────────────
// §7.1 — tenant provisioning worker
// ────────────────────────────────────────────────────────────────────────────────────────────────

const FIXED_NOW = new Date("2026-06-25T12:00:00.000Z");

const PROVISION_JOB: ProvisionJob = {
  tenantAccountId: "ta_engrace",
  organizationId: "org_engrace",
  legalBusinessName: "Engrace Hospice LLC",
  billingContactEmail: "billing@engrace.example",
  firstAdminEmail: "admin@engrace.example",
  firstAdminFullName: "Ada Admin",
  actorMembershipId: "mem_platform_ops",
  transitionReason: "platform-ops accepted onboarding intent",
};

/** A recording set of provision ports — every port appends its name to `calls` so the test can assert
 *  the §7.1 step ORDER, and captures the inputs the orchestration computes (invite TTL, outbox payload). */
function makeProvisionPorts(status: string | null) {
  const calls: string[] = [];
  const captured: {
    keyRingInput?: { tenantAccountId: string; organizationId: string };
    prefixInput?: { organizationId: string; prefixes: readonly string[] };
    inviteExpiresAt?: Date;
    inviteEmail?: string;
    commit?: {
      tenantAccountId: string;
      actorMembershipId: string;
      transitionReason: string;
      provisionedEvent: {
        tenantAccountId: string;
        orgId: string;
        legalBusinessName: string;
        billingContactEmail: string;
      };
    };
  } = {};

  const ports: ProvisionWorkerPorts = {
    now: () => FIXED_NOW,
    async currentStatus() {
      calls.push("currentStatus");
      return status;
    },
    async ensureTenantKeyRing(input) {
      calls.push("ensureTenantKeyRing");
      captured.keyRingInput = input;
      return { tenantKeyRingId: "kr_v1" };
    },
    async ensureTenantStoragePrefixes(input) {
      calls.push("ensureTenantStoragePrefixes");
      captured.prefixInput = input;
      return { prefixesEnsured: input.prefixes };
    },
    async ensureOrganization(input) {
      calls.push("ensureOrganization");
      return { organizationId: input.organizationId };
    },
    async materializeOnboardingTasks() {
      calls.push("materializeOnboardingTasks");
      return { materialized: 11 };
    },
    async ensureFirstAdminInvitation(input) {
      calls.push("ensureFirstAdminInvitation");
      captured.inviteExpiresAt = input.expiresAt;
      captured.inviteEmail = input.inviteeEmail;
      return { invitationId: "inv_first_admin" };
    },
    async commitProvisionedTransition(input) {
      calls.push("commitProvisionedTransition");
      captured.commit = input;
    },
  };
  return { ports, calls, captured };
}

describe("M34 §7.1 — tenant.provision worker (orchestration + idempotency)", () => {
  it("runs the §7.1 step-2 side effects in order and reports the surveyor summary", async () => {
    const { ports, calls, captured } = makeProvisionPorts("provisioning");
    const result = await runTenantProvision(PROVISION_JOB, ports);

    // The eight ports fire exactly once, in the §7.1 step-2 sequence.
    expect(calls).toEqual([
      "currentStatus",
      "ensureTenantKeyRing",
      "ensureTenantStoragePrefixes",
      "ensureOrganization",
      "materializeOnboardingTasks",
      "ensureFirstAdminInvitation",
      "commitProvisionedTransition",
    ]);

    // The surveyor summary (§7.1 step 3).
    expect(result.ran).toBe(true);
    expect(result.skippedReason).toBeUndefined();
    expect(result.tenantKeyRingId).toBe("kr_v1");
    expect(result.organizationId).toBe("org_engrace");
    expect(result.onboardingTasksMaterialized).toBe(11);
    expect(result.invitationId).toBe("inv_first_admin");
    // The canonical six-prefix MinIO bucket-set is requested + echoed back.
    expect(result.minioPrefixesCreated).toEqual([...PROVISION_MINIO_PREFIXES]);
    expect(captured.prefixInput?.prefixes).toEqual([...PROVISION_MINIO_PREFIXES]);
    expect(captured.keyRingInput).toEqual({
      tenantAccountId: "ta_engrace",
      organizationId: "org_engrace",
    });
  });

  it("stamps the first-admin invitation TTL at NOW()+14d (deterministic clock)", async () => {
    const { ports, captured } = makeProvisionPorts("provisioning");
    await runTenantProvision(PROVISION_JOB, ports);

    const expectedExpiry = new Date(
      FIXED_NOW.getTime() + FIRST_ADMIN_INVITATION_TTL_DAYS * 24 * 60 * 60 * 1000,
    );
    expect(captured.inviteExpiresAt?.toISOString()).toBe(expectedExpiry.toISOString());
    expect(captured.inviteEmail).toBe("admin@engrace.example");
  });

  it("commits the `provisioned` transition with the m34.tenant.provisioned outbox payload", async () => {
    const { ports, captured } = makeProvisionPorts("provisioning");
    await runTenantProvision(PROVISION_JOB, ports);

    expect(captured.commit?.tenantAccountId).toBe("ta_engrace");
    expect(captured.commit?.actorMembershipId).toBe("mem_platform_ops");
    expect(captured.commit?.transitionReason).toBe(PROVISION_JOB.transitionReason);
    // The §4.9 `m34.tenant.provisioned` shape — orgId echoed, PHI-free identity fields.
    expect(captured.commit?.provisionedEvent).toEqual({
      tenantAccountId: "ta_engrace",
      orgId: "org_engrace",
      legalBusinessName: "Engrace Hospice LLC",
      billingContactEmail: "billing@engrace.example",
    });
  });

  it("short-circuits to a no-op replay when the tenant already moved past provisioning (§2.6)", async () => {
    const { ports, calls } = makeProvisionPorts("onboarding");
    const result = await runTenantProvision(PROVISION_JOB, ports);

    expect(result.ran).toBe(false);
    expect(result.skippedReason).toBe("already_provisioned");
    // Idempotent replay: only the precondition read ran — no side-effect port was touched.
    expect(calls).toEqual(["currentStatus"]);
    expect(result.tenantKeyRingId).toBe("");
    expect(result.invitationId).toBe("");
  });

  it("refuses an empty transition reason (§2.4.1) before reading any state", async () => {
    const { ports, calls } = makeProvisionPorts("provisioning");
    await expect(
      runTenantProvision({ ...PROVISION_JOB, transitionReason: "   " }, ports),
    ).rejects.toMatchObject({ code: "TRANSITION_REASON_REQUIRED" });
    // The guard fires before the idempotency read.
    expect(calls).toEqual([]);
  });

  it("raises ILLEGAL_TENANT_TRANSITION when the tenant_account row has vanished", async () => {
    const { ports } = makeProvisionPorts(null);
    await expect(runTenantProvision(PROVISION_JOB, ports)).rejects.toBeInstanceOf(
      TenantLifecycleError,
    );
    await expect(runTenantProvision(PROVISION_JOB, ports)).rejects.toMatchObject({
      code: "ILLEGAL_TENANT_TRANSITION",
    });
  });
});

// ────────────────────────────────────────────────────────────────────────────────────────────────
// §7.3 — DSAR export worker (fan-out + lifecycle)
// ────────────────────────────────────────────────────────────────────────────────────────────────

const DSAR_INPUT: DsarExportJobInput = {
  jobId: "dsar_1",
  orgId: "org_engrace",
  tenantAccountId: "ta_engrace",
  patientId: "pat_requested", // resolves through merged_into_id to the survivor below
};

const RESOLVED_PATIENT = "pat_survivor";

/** A fake `TenantExportShard` that writes `n` deterministic FHIR resources for the DSAR path and reports
 *  its own resource tally + a stable per-shard sha256 (the NDJSON full-export path is never exercised). */
function fakeShard(moduleKey: string, n: number): TenantExportShard {
  return {
    moduleKey,
    async streamShardForOrg() {
      return { rowCount: 0, tableCount: 0, sha256: "unused" };
    },
    async streamDsarShardForPatient(_orgId: string, patientId: string, sink: FhirResourceSink) {
      for (let i = 0; i < n; i++) {
        await sink.write({
          resourceType: "Observation",
          id: `${moduleKey}-${i}`,
          subject: patientId,
        });
      }
      return { resourceCount: n, sha256: `sha-${moduleKey}` };
    },
  };
}

/** A recording set of DSAR ports — captures the lifecycle (updateJob), the §164.528 ledger (appendEvent),
 *  the direct M22 render call, the outbox emissions, and the resolved subject; backs the sink with an
 *  in-memory resource array. */
function makeDsarPorts() {
  const sinkResources: unknown[] = [];
  const jobPatches: Array<{
    status: string;
    bundleSha256?: string;
    bundleMinioObjectKey?: string;
    bundleDocumentId?: string;
  }> = [];
  const ledger: Array<{
    eventKind: string;
    fromStatus?: string | null;
    toStatus?: string | null;
    shardReceipt?: DsarShardReceipt | null;
  }> = [];
  const outbox: Array<{ event: string; payload: Record<string, unknown> }> = [];
  const renderCalls: Array<{ aggregateId: string; bundleMinioObjectKey: string }> = [];
  let sealedKey: string | undefined;

  const ports: DsarExportWorkerPorts = {
    now: () => FIXED_NOW,
    async resolveSubject() {
      return { resolvedPatientId: RESOLVED_PATIENT };
    },
    async openBundleSink({ jobId }) {
      const objectKey = `exports/dsar/${jobId}.ndjson.gz`;
      const sink: FhirResourceSink = {
        async write(resource: unknown) {
          sinkResources.push(resource);
        },
      };
      return { sink, objectKey };
    },
    async sealBundle({ objectKey }) {
      sealedKey = objectKey;
      return { sizeBytes: 4096 };
    },
    async updateJob(_jobId, patch) {
      jobPatches.push(patch);
    },
    async appendEvent(args) {
      ledger.push({
        eventKind: args.eventKind,
        fromStatus: args.fromStatus,
        toStatus: args.toStatus,
        shardReceipt: args.shardReceipt,
      });
    },
    async renderBundleDocument(args) {
      renderCalls.push({
        aggregateId: args.aggregateId,
        bundleMinioObjectKey: args.bundleMinioObjectKey,
      });
      return { documentId: `doc_${args.aggregateId}` };
    },
    async publishOutbox(event, payload) {
      outbox.push({ event, payload });
    },
  };
  return { ports, sinkResources, jobPatches, ledger, outbox, renderCalls, sealed: () => sealedKey };
}

describe("M34 §7.3 — tenant.dsar_export worker (fan-out + lifecycle)", () => {
  beforeEach(() => __resetModule34SeamsForTest());

  it("resolves the merged subject, fans out the shards in sorted order, and drives requested→review_pending", async () => {
    // Register out of order to prove the worker sorts by moduleKey for a reproducible bundle digest.
    registerTenantExportShard(fakeShard("m22", 1));
    registerTenantExportShard(fakeShard("m05", 2));
    registerTenantExportShard(fakeShard("m09", 1));

    const { ports, jobPatches, ledger, outbox, sinkResources, sealed } = makeDsarPorts();
    const result = await runDsarExportJob(DSAR_INPUT, ports);

    // Subject followed `merged_into_id` to the survivor.
    expect(result.resolvedPatientId).toBe(RESOLVED_PATIENT);

    // Fan-out: a receipt per registered shard, in sorted moduleKey order; resourceCount = sum.
    expect(result.shardReceipts.map((r) => r.moduleKey)).toEqual(["m05", "m09", "m22"]);
    expect(result.resourceCount).toBe(4);
    expect(sinkResources).toHaveLength(4);

    // Lifecycle: generating then review_pending, carrying the bundle artifacts on the terminal patch.
    expect(jobPatches.map((p) => p.status)).toEqual(["generating", "review_pending"]);
    const finalPatch = jobPatches[1];
    expect(finalPatch?.bundleSha256).toBe(result.bundleSha256);
    expect(finalPatch?.bundleMinioObjectKey).toBe(result.bundleMinioObjectKey);
    expect(result.status).toBe("review_pending");
    expect(sealed()).toBe(result.bundleMinioObjectKey);

    // §164.528 ledger: open hop, one shard receipt per module, assembly, upload-to-review hop.
    expect(ledger.map((e) => e.eventKind)).toEqual([
      "generation_started",
      "shard_received",
      "shard_received",
      "shard_received",
      "bundle_assembled",
      "bundle_uploaded",
    ]);
    expect(ledger.at(-1)?.toStatus).toBe("review_pending");
    // Each shard_received row carries the per-module receipt for disclosure accounting.
    const receiptModules = ledger
      .filter((e) => e.eventKind === "shard_received")
      .map((e) => e.shardReceipt?.moduleKey);
    expect(receiptModules).toEqual(["m05", "m09", "m22"]);
  });

  it("renders the bundle document directly through M22 (bundle back-ref = jobId), then emits m34.dsar_export.completed", async () => {
    registerTenantExportShard(fakeShard("m05", 1));
    const { ports, outbox, renderCalls, jobPatches } = makeDsarPorts();
    const result = await runDsarExportJob(DSAR_INPUT, ports);

    // GAP-048: the render is a DIRECT call (no outbox round-trip) — exactly one M22 render, before the
    // single remaining outbox event.
    expect(renderCalls).toHaveLength(1);
    expect(renderCalls[0]?.aggregateId).toBe("dsar_1");
    expect(renderCalls[0]?.bundleMinioObjectKey).toBe(result.bundleMinioObjectKey);
    expect(result.bundleDocumentId).toBe("doc_dsar_1");
    // The terminal job patch already carries the rendered document id (synchronous, no backref consumer).
    expect(jobPatches.at(-1)?.bundleDocumentId).toBe("doc_dsar_1");

    expect(outbox.map((o) => o.event)).toEqual([M34_DSAR_EXPORT_COMPLETED]);
    const completed = outbox[0]?.payload;
    expect(completed).toMatchObject({
      jobId: "dsar_1",
      orgId: "org_engrace",
      tenantAccountId: "ta_engrace",
      bundleDocumentId: "doc_dsar_1",
      bundleSha256: result.bundleSha256,
    });
  });

  it("computes the 7-day presigned-URL deadline from the injected clock (D19)", async () => {
    registerTenantExportShard(fakeShard("m05", 1));
    const { ports } = makeDsarPorts();
    const result = await runDsarExportJob(DSAR_INPUT, ports);

    expect(result.bundlePresignedUrlExpiresAt.toISOString()).toBe(
      new Date(FIXED_NOW.getTime() + DSAR_BUNDLE_PRESIGNED_TTL_MS).toISOString(),
    );
  });

  it("is digest-stable across a replay (same shards + fixture → same bundle sha256)", async () => {
    registerTenantExportShard(fakeShard("m05", 2));
    registerTenantExportShard(fakeShard("m22", 1));

    const first = await runDsarExportJob(DSAR_INPUT, makeDsarPorts().ports);
    const second = await runDsarExportJob(DSAR_INPUT, makeDsarPorts().ports);

    expect(second.bundleSha256).toBe(first.bundleSha256);
    expect(first.bundleSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("produces an empty-but-valid bundle when no shard is registered", async () => {
    const { ports, ledger, outbox } = makeDsarPorts();
    const result = await runDsarExportJob(DSAR_INPUT, ports);

    expect(result.shardReceipts).toEqual([]);
    expect(result.resourceCount).toBe(0);
    expect(result.status).toBe("review_pending");
    // Still a full lifecycle: no shard_received rows, but the open/assemble/upload hops + both outbox events.
    expect(ledger.map((e) => e.eventKind)).toEqual([
      "generation_started",
      "bundle_assembled",
      "bundle_uploaded",
    ]);
    expect(outbox.map((o) => o.event)).toEqual([M34_DSAR_EXPORT_COMPLETED]);
  });
});
