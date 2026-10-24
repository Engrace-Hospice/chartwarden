// apps/backend/src/m36-attachment-storage.ts — the composition-root binding for M36 WP 1.5 attachment storage + scanning.
//
// M36 does not depend on M22 (module-manifest dependsOn [1,2,3,4]), so it owns two PORTS (`AttachmentStoragePort`,
// `ScanPort`) and this file, which lives at the app root like m23-override-audit.ts, binds them: storage over M22's
// per-tenant MinIO/S3 object store (the same SigV4 adapter and `tenant-<orgId>` bucket the documents module uses),
// the scanner from env. Without MINIO_* the storage port refuses with a typed 503 (nothing is stored); without a
// scanner nothing ever leaves `pending` (fail closed).
//
//   MESSAGING_ATTACHMENT_SCANNER=clamd     CLAMD_HOST (+ CLAMD_PORT, default 3310): a ClamAV sidecar over INSTREAM
//   MESSAGING_ATTACHMENT_SCANNER=builtin   EICAR + type-mismatch only. Dev/CI/demo; NOT an antivirus engine. Refused
//                                          unless ALLOW_BUILTIN_ATTACHMENT_SCANNER=1, and refused outright when
//                                          NODE_ENV=production; warns loudly at boot.
//   (unset)                                no scanner: uploads work, every attachment stays pending, none is delivered
import { DegradedError } from "@chartwarden/types";
import {
  type ObjectStorePort,
  createS3ObjectStore,
  createS3TenantStorageProvisioner,
  deriveTenantBucket,
  s3ObjectStoreConfigFromEnv,
} from "./modules/22-documents";
import type {
  AttachmentStoragePort,
  ScanPort,
} from "./modules/36-messaging/attachments/attachment-ports";
import {
  createBuiltinScanner,
  createClamdScanner,
} from "./modules/36-messaging/attachments/attachment-scanners";

const DEFAULT_CLAMD_PORT = 3310;
/** Backstop for a read with no caller deadline; the service always passes a (shorter) deadline signal. */
const READ_TIMEOUT_MS = 30_000;

function defaultOnError(message: string, error: unknown): void {
  process.stderr.write(
    `${JSON.stringify({ level: "error", msg: message, err: error instanceof Error ? error.message : String(error) })}\n`,
  );
}

function degraded(): DegradedError {
  return new DegradedError(
    "attachment-storage",
    "message attachments need the configured MinIO/S3 object store (MINIO_* is not set)",
  );
}

/** A storage port over M22's object store. `publicStore` signs URLs a browser uses; `internalStore` reads bytes. */
export function createM22BackedAttachmentStorage(stores: {
  readonly publicStore: ObjectStorePort;
  readonly internalStore: ObjectStorePort;
  /** Idempotently creates `tenant-<orgId>` (M34's provisioner). Without it a missing bucket is a bare store 404. */
  readonly ensureTenantBucket?: (organizationId: string) => Promise<unknown>;
  /** Server-side sink for operational detail (default: one JSON line on stderr). */
  readonly onError?: (message: string, error: unknown) => void;
}): AttachmentStoragePort {
  // Orgs onboarded before the bucket was provisioned (the dev demo org, older tenants) have none: create it on first
  // upload instead of answering a bare 404. Memoized per process; a failure is not cached and surfaces as a typed 503,
  // never a silent 404 that looks like "file not found". The bucket name and the operator fix are logged here, server-side;
  // the client only learns the store is unavailable.
  const ensured = new Set<string>();
  const logError = stores.onError ?? defaultOnError;
  const ensureBucket = async (organizationId: string): Promise<void> => {
    if (!stores.ensureTenantBucket || ensured.has(organizationId)) return;
    try {
      await stores.ensureTenantBucket(organizationId);
    } catch (error) {
      logError(
        `attachment storage: tenant bucket ${deriveTenantBucket(organizationId as never)} is missing and could not be created: check MINIO_* credentials allow CreateBucket on tenant-* buckets, or run \`bun run scripts/backfill-tenant-buckets.ts\``,
        error,
      );
      throw new DegradedError("attachment-storage", "attachment storage is temporarily unavailable");
    }
    ensured.add(organizationId);
  };
  const bucketOf = (organizationId: string) => deriveTenantBucket(organizationId as never);
  const descriptor = (organizationId: string, objectKey: string, ttlSeconds: number) => ({
    bucket: bucketOf(organizationId),
    objectKey,
    ttlSeconds,
    accessKind: "signed_url_issued" as const,
  });
  return {
    ensureBucket,
    // Pure signing (no IO): the service calls `ensureBucket` first, outside its transaction.
    async presignUpload({ organizationId, objectKey, mimeType, sha256Hex, byteSize, ttlSeconds }) {
      return stores.publicStore.presignUpload({
        bucket: bucketOf(organizationId),
        objectKey,
        mimeType,
        sha256Hex,
        ttlSeconds,
        // Sign the declared length: the store refuses any other size, so quota (which counts byteSize) is real.
        contentLength: byteSize,
      });
    },
    inspect: ({ organizationId, objectKey, signal }) =>
      stores.internalStore.inspectObject({
        bucket: bucketOf(organizationId),
        objectKey,
        ...(signal ? { signal } : {}),
      }),
    presignDownload: ({ organizationId, objectKey, mimeType, ttlSeconds }) =>
      stores.publicStore.presign({
        descriptor: descriptor(organizationId, objectKey, ttlSeconds),
        organizationId: organizationId as never,
        // Never rendered inline: a download, typed as the stored allowlisted type.
        responseOverrides: { contentDisposition: "attachment", contentType: mimeType },
      }),
    destroyObject: ({ organizationId, objectKey, signal }) =>
      stores.internalStore.destroyAllVersions({
        bucket: bucketOf(organizationId),
        objectKey,
        organizationId: organizationId as never,
        ...(signal ? { signal } : {}),
      }),
    async readBytes({ organizationId, objectKey, maxBytes, signal }) {
      // The store exposes presign, not GET: sign an internal-endpoint URL and fetch it. The signed URL is a bearer
      // credential, so nothing thrown from here may carry it (fetch errors embed it in `cause`): rethrow sanitized.
      const signed = await stores.internalStore.presign({
        descriptor: descriptor(organizationId, objectKey, 60),
        organizationId: organizationId as never,
      });
      let res: Response;
      try {
        // The caller's deadline signal aborts the request AND the body read (the stream errors when it fires).
        const timeout = AbortSignal.timeout(READ_TIMEOUT_MS);
        res = await fetch(signed.url, {
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
          redirect: "error",
        });
      } catch {
        throw new Error("attachment read failed (store unreachable)");
      }
      if (!res.ok) {
        await res.body?.cancel(); // release the connection; an error body is never read
        if (res.status === 404) return null;
        throw new Error(`attachment read failed with HTTP ${res.status}`);
      }
      const declared = Number(res.headers.get("content-length"));
      if (Number.isFinite(declared) && declared > maxBytes) {
        await res.body?.cancel();
        throw new Error("attachment exceeds the scan size limit");
      }
      try {
        return await readCapped(res, maxBytes);
      } catch (error) {
        if (error instanceof Error && error.message.includes("scan size limit")) throw error;
        throw new Error("attachment read failed (body interrupted)");
      }
    },
  };
}

/** Buffer a response body, aborting as soon as it exceeds `maxBytes` (a missing/lying content-length cannot bypass it). */
async function readCapped(res: Response, maxBytes: number): Promise<Uint8Array> {
  const reader = res.body?.getReader();
  if (!reader) return new Uint8Array();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error("attachment exceeds the scan size limit");
    }
    parts.push(value);
  }
  return Buffer.concat(parts);
}

/** The refusing storage port: every call is a typed 503 (MINIO_* unset). */
export function createRefusingAttachmentStorage(): AttachmentStoragePort {
  return {
    presignUpload: () => Promise.reject(degraded()),
    inspect: () => Promise.reject(degraded()),
    readBytes: () => Promise.reject(degraded()),
    presignDownload: () => Promise.reject(degraded()),
    destroyObject: () => Promise.reject(degraded()),
  };
}

export function attachmentScannerFromEnv(
  env: Record<string, string | undefined>,
  onWarn?: (message: string) => void,
): ScanPort | undefined {
  const mode = env.MESSAGING_ATTACHMENT_SCANNER?.trim().toLowerCase();
  if (mode === "builtin") {
    // Not an antivirus engine: a deployment (docker-compose sets NODE_ENV=development for them too) must never end up
    // with a type check standing in for malware scanning by accident. Refuse unless the operator says so explicitly.
    if (env.ALLOW_BUILTIN_ATTACHMENT_SCANNER !== "1") {
      throw new Error(
        "MESSAGING_ATTACHMENT_SCANNER=builtin is refused: it is NOT an antivirus engine. Use clamd, or set " +
          "ALLOW_BUILTIN_ATTACHMENT_SCANNER=1 for dev/CI/demo only",
      );
    }
    // Never in production, flag or no flag: a type check must not stand in for malware scanning on a real deployment.
    if (env.NODE_ENV === "production") {
      throw new Error(
        "MESSAGING_ATTACHMENT_SCANNER=builtin is refused in production: it is NOT an antivirus engine. Use clamd",
      );
    }
    onWarn?.(
      "MESSAGING_ATTACHMENT_SCANNER=builtin is active (ALLOW_BUILTIN_ATTACHMENT_SCANNER=1): attachments are checked for " +
        "EICAR and content-type only, NOT scanned for malware. Never use this with real PHI.",
    );
    return createBuiltinScanner();
  }
  if (mode === "clamd") {
    const host = env.CLAMD_HOST?.trim();
    if (!host) return undefined; // misconfigured => no scanner => nothing becomes deliverable
    const port = Number.parseInt(env.CLAMD_PORT ?? "", 10);
    return createClamdScanner({ host, port: Number.isInteger(port) ? port : DEFAULT_CLAMD_PORT });
  }
  return undefined;
}

export interface M36AttachmentBinding {
  readonly storage: AttachmentStoragePort;
  readonly scanner: ScanPort | undefined;
}

/** The storage port from MINIO_* (the refusing port when unset). Shared by the routes, the sweep and the eraser. */
export function buildM36AttachmentStorage(
  env: Record<string, string | undefined>,
): AttachmentStoragePort {
  const config = s3ObjectStoreConfigFromEnv(env);
  if (!config) return createRefusingAttachmentStorage();
  const provisioner = createS3TenantStorageProvisioner(config);
  return createM22BackedAttachmentStorage({
    publicStore: createS3ObjectStore(config),
    internalStore: createS3ObjectStore({ ...config, publicEndpoint: config.endpoint }),
    ensureTenantBucket: (organizationId) =>
      provisioner.ensureTenantPrefixes({ organizationId, prefixes: [] }),
  });
}

export function buildM36AttachmentBinding(
  env: Record<string, string | undefined>,
  onWarn?: (message: string) => void,
): M36AttachmentBinding {
  return {
    storage: buildM36AttachmentStorage(env),
    scanner: attachmentScannerFromEnv(env, onWarn),
  };
}
