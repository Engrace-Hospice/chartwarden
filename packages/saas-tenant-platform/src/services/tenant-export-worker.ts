// @wardenx/saas-tenant-platform · services — the `tenant.export` job handler (M34 §3.7 / §7.6, D9/D19).
//
// THE ORG-SCOPED FAN-OUT (the inverse of the per-patient DSAR path). One `tenant_export_job` row drives
// a whole-tenant NDJSON archive: the worker iterates the registered `TenantExportShard` set (every
// PHI-bearing module + M34's own self-shard, registered through `registerTenantExportShard`,
// seam-bootstrap), calls `streamShardForOrg(orgId, ndjsonSink)` on each, streams one NDJSON file per
// table into the per-tenant MinIO export prefix, then packages a `tar.gz` + a `manifest.json` carrying
// the per-module / per-file sha256 set and the archive sha256, mints a 7-day-object / 24h-URL presigned
// download, and appends the §7.6 audit chain to `tenant_export_job_event` (job requested → per-module
// shard receipts → bundle assembled → bundle uploaded → download URL generated → object deleted at 7d).
//
// PURE-ORCHESTRATION SHAPE (the M40 `eraseTenantMdm` / M40 `runNppesNightlyDelta` precedent): this is a
// function over an injected `TenantExportWorkerPorts` object — the in-memory ports drive the slice/unit
// tests; the app composition root binds the production adapters (MinIO object writer via M1 envelope,
// the M22 cover-letter render via outbox, the M4 audit + M36 alert emitters, the Drizzle-backed
// `TenantExportRepository`). NO BullMQ / MinIO / Drizzle import here — the worker holds policy, the
// composition root holds mechanism (M1-owns-mechanism / module-owns-policy). The whole run executes
// under the worker's `withOrgContext(orgId, …)` (RLS) that the composition root establishes around the
// port calls; the ports issue plain reads/writes (single home for the tenant-scoping rule; F09 guard).
//
// CROSS-MODULE ACCESS GOES THROUGH SEAMS / OUTBOX, NEVER DIRECT IMPORTS (M34 dependsOn = [1,2,3,4,36]):
//   • the per-module shards arrive via the `TenantExportShard` registry (seam fan-out), passed in as
//     `ports.listShards()` — the worker holds NO module-specific schema knowledge (the §4.6 contract).
//   • MinIO object storage + the per-tenant export prefix are M1-owned: the worker writes through the
//     injected `ExportBundleSink` (a thin port the composition root backs with the M1 envelope/MinIO
//     client) — M34 holds no MinIO client code beyond what M1 provides (§ER M22 clause).
//   • the cover-letter PDF goes through M22 via a direct `DocumentRenderer.render()` call (GAP-094,
//     mirroring GAP-048's DSAR precedent — NOT the `m22.document.upload_requested` outbox event an
//     earlier design considered; that event was never cataloged and had no consumer) — the bulk NDJSON
//     archive deliberately does NOT go through M22 (it predates the post-offboarding M22-document
//     retention destruction; it lives in the export prefix with the 7-day presigned-URL TTL and is
//     destroyed on download or expiry, whichever first).
import { createHash } from "node:crypto";
import type { NdjsonSink, TenantExportShard, TenantExportShardResult } from "../seams";

// ── bundle layout constants (D19 §3.7) ──────────────────────────────────────────────────────────────

/** The MinIO object-key prefix template for a tenant export bundle (§3.7):
 *  `tenants/<orgId>/exports/tenant/<job-id>.tar.gz`. The composition root's M1 MinIO client resolves
 *  this against the per-tenant bucket; M34 only NAMES the key. */
export function tenantExportObjectKey(orgId: string, jobId: string): string {
  return `tenants/${orgId}/exports/tenant/${jobId}.tar.gz`;
}

/** The in-bundle path for one module's NDJSON file (§3.7 `modules/<moduleKey>/<table>.ndjson`). The
 *  shard frames each record with its source table; the sink splits per-table files from that framing. */
export function moduleNdjsonPath(moduleKey: string, tableName: string): string {
  return `modules/${moduleKey}/${tableName}.ndjson`;
}

/** The §3.7 SEC-052 bundle cap: bundles above EITHER bound stay held for platform-ops `approve-oversized`
 *  co-sign before a download URL is issued (the worker reports `oversizedHold`, never auto-publishes). */
export const TENANT_EXPORT_MAX_RECORDS = 10_000;
export const TENANT_EXPORT_MAX_BYTES = 50 * 1024 * 1024 * 1024; // 50 GB

/** The MinIO object lives 7 days from fulfilment (§3.7 — `bundle_presigned_url_expires_at`); the
 *  download URL itself is re-minted at 24h TTL per call (enforced in the route, not stored here). */
export const TENANT_EXPORT_OBJECT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// ── manifest shape (D19 §3.7) ─────────────────────────────────────────────────────────────────────

/** One module's section in `manifest.json` — the per-module shard receipt the §7.6 acceptance validates
 *  the archive against (loading the NDJSON into a fresh schema reconstructs the tenant's data). */
export interface TenantExportModuleManifestEntry {
  readonly moduleKey: string;
  readonly rowCount: number;
  readonly tableCount: number;
  /** The per-module sha256 the shard returned (over the canonical NDJSON it wrote, in stream order). */
  readonly sha256: string;
}

/** The `manifest.json` written at the bundle root (§3.7 D19). */
export interface TenantExportManifest {
  readonly bundleId: string;
  readonly orgId: string;
  readonly generatedAt: string;
  /** sha256 over the assembled archive bytes (the integrity anchor the manifest is validated against). */
  readonly sha256OfArchive: string;
  readonly modules: readonly TenantExportModuleManifestEntry[];
}

// ── the bundle sink (M1-backed; the worker only writes) ──────────────────────────────────────────────

/**
 * The narrow write surface the worker assembles the bundle through (the composition root backs it with
 * the M1 envelope / MinIO client). The worker NEVER holds a MinIO client — it opens a per-module table
 * NDJSON file, streams records, finalises the manifest, and asks the sink to package + upload the
 * `tar.gz` to the per-tenant export prefix. Every method is idempotent on the `(orgId, jobId)` key so a
 * crashed run re-assembles cleanly (§7.7 — the worker is idempotent; partial objects are overwritten).
 */
export interface ExportBundleSink {
  /** Open (or truncate) the per-module/table NDJSON file in the bundle and return its append sink.
   *  The returned {@link NdjsonSink} is exactly the shard's write surface (§4.6). */
  openModuleTable(moduleKey: string, tableName: string): Promise<NdjsonSink>;
  /** Write `manifest.json` at the bundle root (the per-module + archive sha256 set, §3.7 D19). */
  writeManifest(manifest: TenantExportManifest): Promise<void>;
  /** Package the staged files into `tar.gz`, upload to the per-tenant MinIO export prefix at
   *  {@link tenantExportObjectKey}, and report the object key + archive sha256 + byte size (§7.6 step 3-4). */
  packageAndUpload(input: {
    orgId: string;
    jobId: string;
    objectKey: string;
  }): Promise<{ objectKey: string; archiveSha256: string; sizeBytes: number }>;
}

// ── a per-table re-framing NDJSON sink ───────────────────────────────────────────────────────────────

/**
 * A {@link NdjsonSink} that routes the shard's `{ table, row }`-framed records into the right per-table
 * file in the bundle. The §4.6 shards write `{ table: <tableName>, row: <plain row> }` records (see
 * `createTenantExportShardForM34`); this sink un-frames them, opens (lazily, once) the
 * `modules/<moduleKey>/<table>.ndjson` file via {@link ExportBundleSink.openModuleTable}, and writes the
 * bare row. This is how M34 lays "one NDJSON file per table" (§7.6 step 3) without the shard needing to
 * know the bundle's file layout — the shard streams a flat record stream; M34 demultiplexes by table.
 */
class PerTableRoutingSink implements NdjsonSink {
  private readonly tableSinks = new Map<string, NdjsonSink>();
  constructor(
    private readonly bundle: ExportBundleSink,
    private readonly moduleKey: string,
  ) {}

  async write(record: unknown): Promise<void> {
    // The shards emit `{ table, row }` frames; un-frame to land the bare row in the per-table file.
    if (record !== null && typeof record === "object" && "table" in record && "row" in record) {
      const framed = record as { table: unknown; row: unknown };
      const tableName = typeof framed.table === "string" ? framed.table : "_unframed";
      let sink = this.tableSinks.get(tableName);
      if (sink === undefined) {
        sink = await this.bundle.openModuleTable(this.moduleKey, tableName);
        this.tableSinks.set(tableName, sink);
      }
      await sink.write(framed.row);
      return;
    }
    // A shard that emits unframed rows lands them in a single fallback file (defensive — M34's own
    // shard always frames; this keeps an off-contract module's rows in the archive rather than dropped).
    let sink = this.tableSinks.get("_unframed");
    if (sink === undefined) {
      sink = await this.bundle.openModuleTable(this.moduleKey, "_unframed");
      this.tableSinks.set("_unframed", sink);
    }
    await sink.write(record);
  }
}

// ── worker ports (the M40 jobs/eraseFn injected-port precedent) ──────────────────────────────────────

/** The job body the `tenant.export` queue carries — keyed by the export job id (idempotent replay). */
export interface TenantExportJobBody {
  readonly jobId: string;
  readonly orgId: string;
}

/** The §3.7 / §7.6 ports the worker composes over. Real adapters bind at the composition root (the
 *  Drizzle-backed `TenantExportRepository`, the M1 MinIO/envelope-backed {@link ExportBundleSink}, the
 *  M22 cover-letter render via outbox, the M4 audit + M36 alert emitters, the injected clock). */
export interface TenantExportWorkerPorts {
  /** Injected clock — stamps `fulfilledAt` + the 7-day object-expiry deadline + manifest `generatedAt`. */
  now(): Date;

  /** The registered `TenantExportShard` set (the fan-out registry — `listTenantExportShards()`). The
   *  worker iterates these and never holds module-specific schema knowledge (the §4.6 contract). */
  listShards(): readonly TenantExportShard[];

  /** Mark the job `generating` (status flip + ledger row), before the first shard runs (§7.6 step 2). */
  markGenerating(jobId: string): Promise<void>;

  /** Append one per-module shard-receipt ledger row to `tenant_export_job_event` (§7.6 step 3 — the
   *  M4 audit chain "per-module shard receipts"). `shardReceipt` carries the row/table tally + sha256. */
  recordShardReceipt(input: {
    jobId: string;
    moduleKey: string;
    receipt: TenantExportShardResult;
  }): Promise<void>;

  /** The MinIO/envelope-backed bundle sink for THIS job (the composition root scopes it to the job's
   *  export prefix; the worker writes per-table NDJSON + the manifest through it). */
  bundleSink(input: { orgId: string; jobId: string }): ExportBundleSink;

  /** Render the COVER-LETTER PDF for this export (a direct `DocumentRenderer.render()` call — GAP-094,
   *  mirroring GAP-048's DSAR precedent — NOT the `m22.document.upload_requested` outbox event an earlier
   *  design considered; that event was never cataloged and had no consumer). The BULK archive does NOT
   *  go through M22. Returns the rendered document id (recorded on the manifest-assembled ledger for the
   *  §7.6 audit chain). */
  requestCoverLetterPdf(input: {
    jobId: string;
    orgId: string;
    bundleSha256: string;
  }): Promise<{ documentId: string }>;

  /** Persist the assembled-bundle artifact handles + flip the job to `fulfilled` (status + ledger +
   *  the `m34.dsar_export`-style audit; here the tenant-export `bundle_*` columns, §7.6 step 4). The
   *  presigned-URL MINTING + `bundle_downloaded_*` capture live in the download ROUTE, not here. */
  markFulfilled(input: {
    jobId: string;
    bundleMinioObjectKey: string;
    bundleSha256: string;
    bundleSizeBytes: number;
    bundleModuleInventory: TenantExportManifest;
    bundlePresignedUrlExpiresAt: Date;
  }): Promise<void>;

  /** Hold an oversized bundle (§3.7 SEC-052) — the bundle is assembled + uploaded but NO download URL is
   *  issued until a second platform-ops actor `approve-oversized` co-signs. The worker records the hold
   *  (ledger row + M36 alert to platform-ops); it does NOT flip to `fulfilled`. */
  holdForOversizedApproval(input: {
    jobId: string;
    bundleMinioObjectKey: string;
    bundleSha256: string;
    bundleSizeBytes: number;
    recordCount: number;
  }): Promise<void>;
}

/** What a `tenant.export` run reported (asserted by the slice/unit tests; logged for §8.5 observability). */
export interface TenantExportWorkerResult {
  readonly jobId: string;
  readonly orgId: string;
  /** `'fulfilled'` when a download URL is issuable; `'oversized_hold'` when SEC-052 co-sign is required. */
  readonly outcome: "fulfilled" | "oversized_hold";
  readonly moduleCount: number;
  readonly totalRowCount: number;
  readonly bundleSha256: string;
  readonly bundleSizeBytes: number;
  readonly bundleMinioObjectKey: string;
  /** The per-module manifest receipts (the §7.6 acceptance: manifest validates against per-file sha256). */
  readonly modules: readonly TenantExportModuleManifestEntry[];
}

/**
 * Run the `tenant.export` job (§7.6, concurrency 2 — set at the queue, not here). DETERMINISTIC + pure
 * over the injected ports: iterate the registered shards in `moduleKey` order, stream each module's
 * NDJSON into the bundle's per-table files, fold the per-module sha256 receipts into the manifest,
 * package + upload the `tar.gz`, then either fulfil (issue the 7-day object) or hold for SEC-052
 * oversized co-sign. Idempotent on the `(orgId, jobId)` key — a crashed run overwrites the staged
 * objects and the ledger carries the receipts (§7.7). RLS is the composition root's `withOrgContext`
 * around this call; every port read/write is org-scoped (F09 cross-tenant regression guard).
 *
 * @returns the fulfil/hold outcome + the manifest the §7.6 acceptance validates the archive against.
 */
export async function runTenantExportJob(
  body: TenantExportJobBody,
  ports: TenantExportWorkerPorts,
): Promise<TenantExportWorkerResult> {
  const { jobId, orgId } = body;

  // §7.6 step 2 — flip the job to `generating` before the first shard runs.
  await ports.markGenerating(jobId);

  const bundle = ports.bundleSink({ orgId, jobId });

  // §7.6 step 2-3 — fan out across the registered shards in stable `moduleKey` order (deterministic
  // archive layout + manifest ordering). Each shard streams its NDJSON into the bundle's per-table
  // files via the routing sink and returns its tally + content hash for the manifest.
  const shards = [...ports.listShards()].sort((a, b) =>
    a.moduleKey < b.moduleKey ? -1 : a.moduleKey > b.moduleKey ? 1 : 0,
  );

  const moduleEntries: TenantExportModuleManifestEntry[] = [];
  let totalRowCount = 0;
  for (const shard of shards) {
    const sink = new PerTableRoutingSink(bundle, shard.moduleKey);
    const receipt = await shard.streamShardForOrg(orgId, sink);
    await ports.recordShardReceipt({ jobId, moduleKey: shard.moduleKey, receipt });
    moduleEntries.push({
      moduleKey: shard.moduleKey,
      rowCount: receipt.rowCount,
      tableCount: receipt.tableCount,
      sha256: receipt.sha256,
    });
    totalRowCount += receipt.rowCount;
  }

  // §7.6 step 3-4 — package + upload the tar.gz to the per-tenant MinIO export prefix, get the archive
  // sha256 + byte size. The object key is the canonical §3.7 path.
  const objectKey = tenantExportObjectKey(orgId, jobId);
  const uploaded = await bundle.packageAndUpload({ orgId, jobId, objectKey });

  // §3.7 D19 — assemble the manifest with the per-module receipts + the archive sha256, write it at the
  // bundle root. `sha256OfArchive` is the integrity anchor the §7.6 acceptance validates against.
  const manifest: TenantExportManifest = {
    bundleId: jobId,
    orgId,
    generatedAt: ports.now().toISOString(),
    sha256OfArchive: uploaded.archiveSha256,
    modules: moduleEntries,
  };
  await bundle.writeManifest(manifest);

  // §3.7 / §ER M22 clause — the COVER-LETTER PDF goes through M22 (outbox handshake); the bulk archive
  // stays in the export prefix (NOT M22). Emit the render request; the back-ref consumer wires the
  // resulting `document_id` later. Fire-and-record (the manifest already carries the bundle hash).
  await ports.requestCoverLetterPdf({ jobId, orgId, bundleSha256: uploaded.archiveSha256 });

  // §3.7 SEC-052 — bundles above EITHER cap hold for platform-ops `approve-oversized` co-sign before a
  // download URL is issued. The bundle IS assembled + uploaded; only the URL is gated.
  const oversized =
    totalRowCount > TENANT_EXPORT_MAX_RECORDS || uploaded.sizeBytes > TENANT_EXPORT_MAX_BYTES;
  if (oversized) {
    await ports.holdForOversizedApproval({
      jobId,
      bundleMinioObjectKey: uploaded.objectKey,
      bundleSha256: uploaded.archiveSha256,
      bundleSizeBytes: uploaded.sizeBytes,
      recordCount: totalRowCount,
    });
    return {
      jobId,
      orgId,
      outcome: "oversized_hold",
      moduleCount: moduleEntries.length,
      totalRowCount,
      bundleSha256: uploaded.archiveSha256,
      bundleSizeBytes: uploaded.sizeBytes,
      bundleMinioObjectKey: uploaded.objectKey,
      modules: moduleEntries,
    };
  }

  // §7.6 step 4 — persist the bundle artifact handles + flip to `fulfilled`. The MinIO object auto-deletes
  // 7 days from fulfilment; `bundle_presigned_url_expires_at` records that object-level deadline. The
  // 24h presigned DOWNLOAD URL is minted per-call in the download route (single-download starts the
  // deletion timer — that timer ticks from `fulfilled_at`, set here), NOT in this worker.
  const objectExpiresAt = new Date(ports.now().getTime() + TENANT_EXPORT_OBJECT_TTL_MS);
  await ports.markFulfilled({
    jobId,
    bundleMinioObjectKey: uploaded.objectKey,
    bundleSha256: uploaded.archiveSha256,
    bundleSizeBytes: uploaded.sizeBytes,
    bundleModuleInventory: manifest,
    bundlePresignedUrlExpiresAt: objectExpiresAt,
  });

  return {
    jobId,
    orgId,
    outcome: "fulfilled",
    moduleCount: moduleEntries.length,
    totalRowCount,
    bundleSha256: uploaded.archiveSha256,
    bundleSizeBytes: uploaded.sizeBytes,
    bundleMinioObjectKey: uploaded.objectKey,
    modules: moduleEntries,
  };
}

// ── in-memory ports for the slice / unit tests (the M40 in-memory-store precedent) ────────────────────

/** A captured per-table NDJSON file in the in-memory bundle (the table path + the rows written to it). */
export interface InMemoryBundleFile {
  readonly path: string;
  readonly rows: unknown[];
}

/** What the in-memory bundle sink captured for a run (the test asserts the per-table layout + manifest). */
export interface InMemoryBundleCapture {
  readonly files: Map<string, InMemoryBundleFile>;
  manifest?: TenantExportManifest;
  packaged?: { objectKey: string; archiveSha256: string; sizeBytes: number };
}

/**
 * Build an in-memory {@link ExportBundleSink} + the capture it writes into. `packageAndUpload` derives a
 * deterministic archive sha256 from the staged file contents (so the §7.6 "bundle sha256 deterministic
 * for fixture input" acceptance holds without a real tar.gz), and reports a byte size from the JSON
 * length. Seed `sizeBytesOverride` to exercise the SEC-052 oversized-hold branch.
 */
export function createInMemoryExportBundleSink(opts?: { sizeBytesOverride?: number }): {
  sink: ExportBundleSink;
  capture: InMemoryBundleCapture;
} {
  const capture: InMemoryBundleCapture = { files: new Map() };
  const sink: ExportBundleSink = {
    async openModuleTable(moduleKey, tableName): Promise<NdjsonSink> {
      const path = moduleNdjsonPath(moduleKey, tableName);
      let file = capture.files.get(path);
      if (file === undefined) {
        file = { path, rows: [] };
        capture.files.set(path, file);
      }
      const target = file;
      return {
        async write(row: unknown): Promise<void> {
          target.rows.push(row);
        },
      };
    },
    async writeManifest(manifest): Promise<void> {
      capture.manifest = manifest;
    },
    async packageAndUpload({ objectKey }): Promise<{
      objectKey: string;
      archiveSha256: string;
      sizeBytes: number;
    }> {
      // Deterministic archive digest over every staged file's contents, in path order.
      const digest = createHash("sha256");
      let bytes = 0;
      for (const path of [...capture.files.keys()].sort()) {
        const file = capture.files.get(path);
        if (file === undefined) continue;
        const serialized = JSON.stringify({ path: file.path, rows: file.rows });
        digest.update(serialized);
        digest.update("\n");
        bytes += serialized.length;
      }
      const archiveSha256 = digest.digest("hex");
      const sizeBytes = opts?.sizeBytesOverride ?? bytes;
      capture.packaged = { objectKey, archiveSha256, sizeBytes };
      return { objectKey, archiveSha256, sizeBytes };
    },
  };
  return { sink, capture };
}

/** What the in-memory worker ports recorded across a run (the test asserts the §7.6 ledger chain). */
export interface InMemoryTenantExportCapture {
  generatingFlipped: string[];
  shardReceipts: { jobId: string; moduleKey: string; receipt: TenantExportShardResult }[];
  coverLetterRequests: { jobId: string; orgId: string; bundleSha256: string }[];
  fulfilled: {
    jobId: string;
    bundleMinioObjectKey: string;
    bundleSha256: string;
    bundleSizeBytes: number;
    bundlePresignedUrlExpiresAt: Date;
  }[];
  oversizedHolds: { jobId: string; recordCount: number; bundleSizeBytes: number }[];
  readonly bundle: InMemoryBundleCapture;
}

/**
 * Build in-memory {@link TenantExportWorkerPorts} + the capture they record into, over a fixed shard set
 * and a frozen clock. Used by `tenant-export-multi-module.test.ts` (§9 — register fake shards for m5,
 * m6, m7; the worker collects all; the manifest sha256 validates per-module). The Drizzle/MinIO-backed
 * ports land at the composition root (the production worker wiring).
 */
export function createInMemoryTenantExportPorts(input: {
  shards: readonly TenantExportShard[];
  now?: Date;
  sizeBytesOverride?: number;
}): { ports: TenantExportWorkerPorts; capture: InMemoryTenantExportCapture } {
  const { sink, capture: bundleCapture } = createInMemoryExportBundleSink({
    sizeBytesOverride: input.sizeBytesOverride,
  });
  const frozenNow = input.now ?? new Date("2026-06-25T00:00:00.000Z");
  const capture: InMemoryTenantExportCapture = {
    generatingFlipped: [],
    shardReceipts: [],
    coverLetterRequests: [],
    fulfilled: [],
    oversizedHolds: [],
    bundle: bundleCapture,
  };
  let documentSeq = 0;
  const ports: TenantExportWorkerPorts = {
    now: () => frozenNow,
    listShards: () => input.shards,
    async markGenerating(jobId): Promise<void> {
      capture.generatingFlipped.push(jobId);
    },
    async recordShardReceipt({ jobId, moduleKey, receipt }): Promise<void> {
      capture.shardReceipts.push({ jobId, moduleKey, receipt });
    },
    bundleSink: () => sink,
    async requestCoverLetterPdf({ jobId, orgId, bundleSha256 }): Promise<{ documentId: string }> {
      capture.coverLetterRequests.push({ jobId, orgId, bundleSha256 });
      documentSeq += 1;
      return { documentId: `document-${documentSeq}` };
    },
    async markFulfilled(args): Promise<void> {
      capture.fulfilled.push({
        jobId: args.jobId,
        bundleMinioObjectKey: args.bundleMinioObjectKey,
        bundleSha256: args.bundleSha256,
        bundleSizeBytes: args.bundleSizeBytes,
        bundlePresignedUrlExpiresAt: args.bundlePresignedUrlExpiresAt,
      });
    },
    async holdForOversizedApproval(args): Promise<void> {
      capture.oversizedHolds.push({
        jobId: args.jobId,
        recordCount: args.recordCount,
        bundleSizeBytes: args.bundleSizeBytes,
      });
    },
  };
  return { ports, capture };
}
