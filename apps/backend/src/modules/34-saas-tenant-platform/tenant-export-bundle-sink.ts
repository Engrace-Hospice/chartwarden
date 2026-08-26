// apps/backend/src/modules/34-saas-tenant-platform/tenant-export-bundle-sink.ts — GAP-094.
//
// The production `ExportBundleSink` (§3.7 D19 / §7.6) the tenant-export worker writes each shard's rows
// + the manifest into. Buffers per-table NDJSON content in memory (the SAME accepted shape the package's
// own `createInMemoryExportBundleSink` test fixture already uses — real streaming-to-S3 is a further
// optimization the SEC-052 oversized-hold path already exists to bound, not a gap this fix introduces),
// packages a REAL ustar tar.gz via `buildUstarTarball` (tenant-export-tar.ts) of the per-module NDJSON
// tables, and PUTs it as one object — mirroring GAP-048's single-PUT DSAR pattern, just over a real
// multi-file archive instead of a single logical document.
//
// `manifest.json` is a SEPARATE sidecar object next to the archive, not a file inside the tar: the
// package's own `runTenantExportJob` calls `packageAndUpload` BEFORE `writeManifest` (the manifest needs
// `sha256OfArchive`, which is only known once the archive is uploaded — see tenant-export-worker.ts's
// §3.7 D19 comment), so a manifest-inside-the-tar design is structurally impossible under this ordering.
import { gzipSync } from "node:zlib";
import type {
  ExportBundleSink,
  NdjsonSink,
  TenantExportManifest,
} from "@wardenx/saas-tenant-platform";
import { moduleNdjsonPath, tenantExportObjectKey } from "@wardenx/saas-tenant-platform";
import { type TarEntry, buildUstarTarball } from "./tenant-export-tar";

export type TenantExportBundlePutObject = (args: {
  readonly organizationId: string;
  readonly objectKey: string;
  readonly bytes: Uint8Array;
}) => Promise<{
  readonly sha256Hex: string;
}>;

/** Injected clock (seconds since epoch) — overridable for deterministic tests; defaults to real time. */
export type NowSecondsClock = () => number;

/** The sidecar manifest object key next to `tenantExportObjectKey`'s `.tar.gz` (same prefix, same job). */
export function tenantExportManifestObjectKey(orgId: string, jobId: string): string {
  return `${tenantExportObjectKey(orgId, jobId).replace(/\.tar\.gz$/, "")}/manifest.json`;
}

export function createTenantExportBundleSink(input: {
  readonly putObject: TenantExportBundlePutObject;
  readonly nowSeconds?: NowSecondsClock;
}): ExportBundleSink {
  const nowSeconds = input.nowSeconds ?? (() => Math.floor(Date.now() / 1000));
  const files = new Map<string, Buffer[]>();

  return {
    async openModuleTable(moduleKey, tableName): Promise<NdjsonSink> {
      const path = moduleNdjsonPath(moduleKey, tableName);
      let chunks = files.get(path);
      if (chunks === undefined) {
        chunks = [];
        files.set(path, chunks);
      }
      const target = chunks;
      return {
        async write(row: unknown): Promise<void> {
          target.push(Buffer.from(`${JSON.stringify(row)}\n`, "utf8"));
        },
      };
    },

    async writeManifest(manifest: TenantExportManifest): Promise<void> {
      const objectKey = tenantExportManifestObjectKey(manifest.orgId, manifest.bundleId);
      const bytes = Buffer.from(JSON.stringify(manifest, null, 2), "utf8");
      await input.putObject({ organizationId: manifest.orgId, objectKey, bytes });
    },

    async packageAndUpload({ orgId, objectKey }): Promise<{
      objectKey: string;
      archiveSha256: string;
      sizeBytes: number;
    }> {
      const entries: TarEntry[] = [...files.entries()]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([path, chunks]) => ({ path, content: Buffer.concat(chunks) }));
      const tarball = buildUstarTarball(entries, nowSeconds());
      const bytes = gzipSync(tarball);
      const { sha256Hex } = await input.putObject({ organizationId: orgId, objectKey, bytes });
      return { objectKey, archiveSha256: sha256Hex, sizeBytes: bytes.byteLength };
    },
  };
}
