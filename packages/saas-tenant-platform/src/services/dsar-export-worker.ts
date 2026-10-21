// @chartwarden/saas-tenant-platform · services — the `tenant.dsar_export` job handler (M34 §7.3, D9/D17/D19).
//
// THE PATIENT-SCOPED DSAR FULFILMENT WORKER (HIPAA §164.524 — "all my data" within 30 days). Given a
// `dsar_export_job` already inserted `status='requested'` (the route did that + emitted
// `m34.dsar_export.requested`), this handler:
//
//   1. Resolves the subject through M5 (`merged_into_id` redirect) so the bundle follows a merged patient.
//   2. FANS OUT across every PHI module's `TenantExportShard` via the seam registry
//      ({@link listTenantExportShards}) — calls `streamDsarShardForPatient(orgId, patientId, sink)` on each.
//      Each shard applies its OWN M39 Part 2 segmentation before emitting resources (M34 inherits, never
//      widens, the M5/M39 redaction-by-default posture — §7.3 / M34-F13 / ADR-0014). M34 holds no
//      module-specific schema knowledge; it owns only the orchestration.
//   3. Assembles a FHIR R4 `Bundle` (type `collection`) from the concatenated per-shard resources.
//   4. Renders the chart PDF + NDJSON manifest THROUGH M22 via the §1.1 handshake — emits
//      `m22.document.upload_requested`; the returned `document_id` is wired back onto
//      `dsar_export_job.bundle_document_id` by the `consumers/m22-document-backref.ts` consumer on the
//      `m22.document.rendered` reply (the downstream half of the handshake).
//   5. Uploads the Bundle archive to the per-tenant MinIO export prefix (M1 envelope), records the
//      sha256 + the 7-day presigned-URL expiry deadline (D19), and flips the job to `review_pending`
//      (the DSAR officer fulfils/extends/denies from there — §7.3 step 4).
//   6. Emits `m34.dsar_export.completed`.
//
// CRITICAL TENANCY POSTURE (F09): this runs under the REQUESTING TENANT'S `withOrgContext` (RLS), NOT a
// platform bypass. The handler never sets RLS GUCs itself — the boot wiring wraps the whole run in
// `withOrgContext(orgId, …)` so every shard read + every M34 repo write is scoped to the tenant. A
// cross-tenant DSAR is structurally impossible: a shard cannot read another org's rows under that GUC.
//
// PURE-PORT SHAPE (the M40 `runNppesNightlyDelta` / M4 / M38 job pattern): this module has NO infra
// import — no MinIO client, no Drizzle, no BullMQ, no `getSeam`. Every cross-module / IO effect is an
// injected port on {@link DsarExportWorkerPorts}. The backend boot wiring binds those ports to the live
// adapters (the M5 resolver seam via `getSeam('PatientReader')`, the M1 envelope MinIO put, the
// `DsarExportRepository`, the M22 outbox publisher, the M36 alert emitter) — so M34 adds NO new manifest
// `dependsOn` edge (M34 dependsOn stays `[1,2,3,4,36]`; the M22/M5 reach is seam/outbox, no-edge per
// ADR-0005). The handler is unit-testable with in-memory ports, deterministic given an injected clock.
import { createHash } from "node:crypto";
import { listTenantExportShards } from "../seam-bootstrap";
import type { FhirResourceSink } from "../seams";

/** The two `m34.dsar_export.*` outbox events this worker emits (§4.9 catalog, verbatim wire names). */
export const M34_DSAR_EXPORT_REQUESTED = "m34.dsar_export.requested" as const;
export const M34_DSAR_EXPORT_COMPLETED = "m34.dsar_export.completed" as const;

/** The 7-day MinIO object lifetime from fulfilment (D19 / §3.7) — the presigned-URL expiry deadline. */
export const DSAR_BUNDLE_PRESIGNED_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** The M22 aggregate-type the DSAR bundle materializes under (no DSAR-specific aggregate exists — the
 *  bundle is a generic compliance artifact back-reffed by the DSAR job id). */
export const DSAR_DOCUMENT_AGGREGATE_TYPE = "other" as const;

/** The §164.528 disclosure-accounting retention class every DSAR artifact carries (D12). */
export const DSAR_DOCUMENT_RETENTION_CLASS = "compliance" as const;

// ── the M5 subject the run resolves (port return) ───────────────────────────────────────────────────

/** The resolved DSAR subject after the M5 `merged_into_id` redirect (the bundle follows the survivor). */
export interface DsarSubject {
  /** The canonical patient id to bundle (post-`merged_into_id` redirect, §7.3 step 3). */
  readonly resolvedPatientId: string;
}

// ── the §1.1 render handshake the worker calls DIRECTLY (GAP-048 — no outbox round-trip, see
// `renderBundleDocument` below) ──────────────────────────────────────────────────────────────────────

/** The §1.1-handshake payload the worker hands M22's `DocumentRenderer` seam directly. M22 renders the
 *  chart PDF from the (already-redacted) Bundle, stores it at retention class `compliance` with the
 *  patient back-reference, and returns the `documentId` synchronously — no reply event, no separate
 *  back-ref consumer (mirrors the one genuinely-live render precedent, M39 consent). The Bundle is
 *  passed by its MinIO handle, never inline — M22 reads the archive from the export prefix. */
export interface DsarDocumentUploadRequest {
  readonly organizationId: string;
  readonly patientId: string;
  /** The DSAR job id — the aggregate the rendered document back-refs (`bundle_document_id` target). */
  readonly aggregateId: string;
  readonly aggregateType: typeof DSAR_DOCUMENT_AGGREGATE_TYPE;
  readonly retentionClass: typeof DSAR_DOCUMENT_RETENTION_CLASS;
  /** The MinIO object key of the assembled (encrypted) Bundle archive M22 renders the PDF from. */
  readonly bundleMinioObjectKey: string;
  /** The integrity digest of the assembled Bundle (must match the file the patient downloads, §7.3 step 7). */
  readonly bundleSha256: string;
  /** True so M22 knows the source may carry Part-2 material that the shards already redacted (metadata flag). */
  readonly partTwoRedactionApplied: boolean;
  readonly title: string;
}

// ── the per-shard receipt the worker records on the ledger (the §164.528 trail) ─────────────────────

/** One shard's execution receipt — appended to `dsar_export_job_event` as a `shard_receipt` row so the
 *  audit chain shows every module's contribution (§7.3 step 7 "per-module shard execution receipts"). */
export interface DsarShardReceipt {
  readonly moduleKey: string;
  readonly resourceCount: number;
  readonly sha256: string;
}

/** The terminal report the handler returns (asserted in tests; surfaced to the queue for the run log). */
export interface DsarExportRunResult {
  readonly jobId: string;
  readonly resolvedPatientId: string;
  readonly shardReceipts: readonly DsarShardReceipt[];
  readonly resourceCount: number;
  readonly bundleSha256: string;
  readonly bundleMinioObjectKey: string;
  readonly bundlePresignedUrlExpiresAt: Date;
  /** The M22 document id the chart PDF rendered under (returned synchronously, GAP-048). */
  readonly bundleDocumentId: string;
  /** The status the job was driven to (`review_pending` on the happy path, §7.3 step 3). */
  readonly status: "review_pending";
}

// ── the injected ports (the boot wiring binds these to the live seam/outbox/MinIO adapters) ─────────

/**
 * Everything the `tenant.dsar_export` handler reaches outside its own pure logic, surfaced as ports so
 * the handler stays infra-free and unit-testable (the M40 `NppesNightlyPorts` pattern). The boot wiring
 * binds each to the live adapter, ALL inside the requesting tenant's `withOrgContext` (F09): the M5
 * resolver (via `getSeam('PatientReader')`), the M1 envelope-backed MinIO put + key minting, the
 * `DsarExportRepository` status/ledger writes, M22's `DocumentRenderer` seam (direct call, GAP-048 — NOT
 * an outbox round-trip, see {@link renderBundleDocument}), and the §4.9 `m34.dsar_export.completed` emit.
 */
export interface DsarExportWorkerPorts {
  /** Injected clock — stamps the run + computes the 7-day presigned-URL deadline (deterministic in test). */
  now(): Date;

  /** Resolve the DSAR subject through M5 (`merged_into_id` redirect, §7.3 step 3). Bound to the M5
   *  `PatientReader` seam (`getSeam('PatientReader')`) in the boot wiring — no `@chartwarden/patient` edge. */
  resolveSubject(orgId: string, patientId: string): Promise<DsarSubject>;

  /** Open the encrypted, MinIO-backed {@link FhirResourceSink} the shards stream FHIR resources into, plus
   *  the object key it writes under (`tenants/<orgId>/exports/dsar/<jobId>.ndjson.gz`, §3.7). Backed by
   *  the M1 envelope helper (the worker holds no MinIO client code — M1 owns the primitive). */
  openBundleSink(args: {
    readonly orgId: string;
    readonly jobId: string;
  }): Promise<{ sink: FhirResourceSink; objectKey: string }>;

  /** Finalise the assembled archive in MinIO (close the object / flush the gzip stream) and report its
   *  size. The Bundle envelope framing is the sink's job; this seals it. */
  sealBundle(args: {
    readonly orgId: string;
    readonly objectKey: string;
  }): Promise<{ sizeBytes: number }>;

  /** Patch `dsar_export_job` (status + bundle-artifact fields) — `DsarExportRepository.update` under RLS. */
  updateJob(
    jobId: string,
    patch: {
      readonly status: "generating" | "review_pending";
      readonly bundleMinioObjectKey?: string;
      readonly bundleSha256?: string;
      readonly bundlePresignedUrlExpiresAt?: Date;
      readonly bundleDocumentId?: string;
    },
  ): Promise<void>;

  /** Append a `dsar_export_job_event` ledger row — `DsarExportRepository.appendEvent` under RLS. The
   *  `shardReceipt` carries the per-module receipt (§7.3 step 7 disclosure-accounting trail). */
  appendEvent(args: {
    readonly orgId: string;
    readonly jobId: string;
    readonly eventKind: string;
    readonly fromStatus?: string | null;
    readonly toStatus?: string | null;
    readonly shardReceipt?: DsarShardReceipt | null;
  }): Promise<void>;

  /** GAP-048: render the chart PDF DIRECTLY through M22's `DocumentRenderer` seam (`getSeam
   *  ('DocumentRenderer').render(...)`) — no outbox round-trip. Returns the rendered document id
   *  synchronously so the caller can record `bundleDocumentId` on the SAME `updateJob` patch that flips
   *  the job to `review_pending`, instead of waiting on a reply event + a separate back-ref consumer. */
  renderBundleDocument(args: DsarDocumentUploadRequest): Promise<{ documentId: string }>;

  /** Publish the §4.9 `m34.dsar_export.completed` outbox event in the run's transaction (the M1 dispatcher,
   *  dedup-keyed by jobId). The ONLY outbox event this worker still emits (§164.524 completion signal for
   *  M36's DSAR-officer queue + M33 throughput) — the render step no longer round-trips through the outbox. */
  publishOutbox(event: string, payload: Record<string, unknown>): Promise<void>;
}

/**
 * The input the queue hands the handler — the `dsar_export_job` row keys (the route inserted the row +
 * emitted `m34.dsar_export.requested`; this picks it up). `tenantAccountId` rides along for the
 * completion event payload (§4.9). The whole call MUST already be inside `withOrgContext(orgId, …)`.
 */
export interface DsarExportJobInput {
  readonly jobId: string;
  readonly orgId: string;
  readonly tenantAccountId: string;
  readonly patientId: string;
}

/**
 * Run the `tenant.dsar_export` job (§7.3, concurrency 4 keyed by jobId). PURE over {@link
 * DsarExportWorkerPorts}; the boot wiring runs this inside the requesting tenant's `withOrgContext`
 * (F09 — never platform bypass). Sequence mirrors §7.3 step 3:
 *
 *   resolve subject → flip `requested → generating` → fan out `streamDsarShardForPatient` across the
 *   `TenantExportShard` registry (recording a per-module receipt) → seal the Bundle archive in MinIO →
 *   compute the bundle sha256 + the 7-day presigned deadline → emit the M22 §1.1 upload-request handshake
 *   → flip `generating → review_pending` → emit `m34.dsar_export.completed`.
 *
 * The per-shard FHIR-resource hashing folds into a single bundle digest (deterministic given fixture
 * input), so the audit-chain sha256 matches the file the patient downloads (§7.3 step 7 acceptance).
 * Each shard applies its OWN M39 Part 2 segmentation before emitting; M34 inherits that posture.
 */
export async function runDsarExportJob(
  input: DsarExportJobInput,
  ports: DsarExportWorkerPorts,
): Promise<DsarExportRunResult> {
  const { jobId, orgId, tenantAccountId } = input;

  // 1. Resolve the subject through M5 (follow `merged_into_id`) — the bundle follows the survivor.
  const subject = await ports.resolveSubject(orgId, input.patientId);
  const patientId = subject.resolvedPatientId;

  // 2. Move into the generating state (the audit chain opens with the "request → generating" hop).
  await ports.updateJob(jobId, { status: "generating" });
  await ports.appendEvent({
    orgId,
    jobId,
    eventKind: "generation_started",
    fromStatus: "requested",
    toStatus: "generating",
    shardReceipt: null,
  });

  // 3. Fan out across the TenantExportShard registry. Each shard writes its (already Part-2-redacted)
  //    FHIR resources to the encrypted MinIO-backed sink; we fold the per-shard digest into one bundle
  //    digest in stream order so the integrity hash matches the assembled archive byte-for-byte.
  const { sink, objectKey } = await ports.openBundleSink({ orgId, jobId });
  const bundleDigest = createHash("sha256");
  const shardReceipts: DsarShardReceipt[] = [];
  let resourceCount = 0;

  // Deterministic shard order (by moduleKey) so the bundle digest is reproducible for fixture input.
  const shards = [...listTenantExportShards()].sort((a, b) =>
    a.moduleKey < b.moduleKey ? -1 : a.moduleKey > b.moduleKey ? 1 : 0,
  );

  for (const shard of shards) {
    // Wrap the sink so we can fold each emitted resource into the running bundle digest without the
    // shard knowing — the shard returns its own per-shard sha256 for the receipt, we hash the bundle.
    const digestingSink: FhirResourceSink = {
      async write(resource: unknown): Promise<void> {
        bundleDigest.update(canonicalJson(resource));
        bundleDigest.update("\n");
        await sink.write(resource);
      },
    };
    const result = await shard.streamDsarShardForPatient(orgId, patientId, digestingSink);
    const receipt: DsarShardReceipt = {
      moduleKey: shard.moduleKey,
      resourceCount: result.resourceCount,
      sha256: result.sha256,
    };
    shardReceipts.push(receipt);
    resourceCount += result.resourceCount;
    // Per-module shard-execution receipt on the §164.528 ledger (§7.3 step 7).
    await ports.appendEvent({
      orgId,
      jobId,
      eventKind: "shard_received",
      fromStatus: "generating",
      toStatus: "generating",
      shardReceipt: receipt,
    });
  }

  // 4. Seal the archive + compute the bundle integrity digest + the 7-day presigned deadline.
  await ports.sealBundle({ orgId, objectKey });
  const bundleSha256 = bundleDigest.digest("hex");
  const bundlePresignedUrlExpiresAt = new Date(
    ports.now().getTime() + DSAR_BUNDLE_PRESIGNED_TTL_MS,
  );

  await ports.appendEvent({
    orgId,
    jobId,
    eventKind: "bundle_assembled",
    fromStatus: "generating",
    toStatus: "generating",
    shardReceipt: null,
  });

  // 5. §1.1 handshake — render the chart PDF from the assembled Bundle directly through M22's
  //    DocumentRenderer seam (GAP-048; no outbox round-trip — see `renderBundleDocument`'s doc comment).
  //    The document id comes back synchronously, so it lands on the SAME patch as the terminal transition.
  const uploadRequest: DsarDocumentUploadRequest = {
    organizationId: orgId,
    patientId,
    aggregateId: jobId,
    aggregateType: DSAR_DOCUMENT_AGGREGATE_TYPE,
    retentionClass: DSAR_DOCUMENT_RETENTION_CLASS,
    bundleMinioObjectKey: objectKey,
    bundleSha256,
    partTwoRedactionApplied: true,
    title: `DSAR export — patient ${patientId}`,
  };
  const { documentId: bundleDocumentId } = await ports.renderBundleDocument(uploadRequest);

  // 6. Record the bundle artifacts + advance to `review_pending` (the DSAR officer takes it from here).
  await ports.updateJob(jobId, {
    status: "review_pending",
    bundleMinioObjectKey: objectKey,
    bundleSha256,
    bundlePresignedUrlExpiresAt,
    bundleDocumentId,
  });
  await ports.appendEvent({
    orgId,
    jobId,
    eventKind: "bundle_uploaded",
    fromStatus: "generating",
    toStatus: "review_pending",
    shardReceipt: null,
  });

  // 7. The completion event — M36 closes the DSAR-officer queue item; M33 records throughput.
  //    `bundleDocumentId` is already known (step 5 rendered synchronously, no reply-event wait).
  await ports.publishOutbox(M34_DSAR_EXPORT_COMPLETED, {
    jobId,
    orgId,
    tenantAccountId,
    patientId,
    bundleDocumentId,
    bundleSha256,
    fulfilledAt: ports.now().toISOString(),
  });

  return {
    jobId,
    resolvedPatientId: patientId,
    shardReceipts,
    resourceCount,
    bundleSha256,
    bundleMinioObjectKey: objectKey,
    bundlePresignedUrlExpiresAt,
    bundleDocumentId,
    status: "review_pending",
  };
}

/** Stable-key JSON canonicalisation so the bundle sha256 is deterministic for fixture input (matches the
 *  M34 self-shard's canonicaliser so the digests line up across the fan-out). */
function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, val) => {
    if (val && typeof val === "object" && !Array.isArray(val)) {
      return Object.fromEntries(
        Object.entries(val as Record<string, unknown>).sort(([a], [b]) =>
          a < b ? -1 : a > b ? 1 : 0,
        ),
      );
    }
    return val;
  });
}
