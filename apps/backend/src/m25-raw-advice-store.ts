// apps/backend/src/m25-raw-advice-store.ts — the M25 raw-835 stage (#658, #669, #670): the tenant's own bucket
// (same MINIO_* contract and `deriveTenantBucket` as M22) under `m25-835/<adviceId>`. The id is server-generated,
// never the caller's key, so M25 can neither overwrite nor read an M22 object whatever key a caller names.
import type { RawAdviceStore } from "./modules/25-remittance";
import {
  type S3ObjectStoreDeps,
  createS3ObjectStore,
  createS3TenantStorageProvisioner,
  deriveTenantBucket,
  s3ObjectStoreConfigFromEnv,
} from "./modules/22-documents";

/** Largest raw 835 the post path will read back (a real remittance file is well under 1 MiB). */
export const M25_RAW_835_MAX_BYTES = 16 * 1024 * 1024;
const IO_TIMEOUT_MS = 15_000;

/** No object store configured = undefined, and `postAdvice` stays fail-closed (retryable X12_835_RAW_UNAVAILABLE). */
export function buildM25RawAdviceStore(
  env: Record<string, string | undefined> = process.env,
  deps: S3ObjectStoreDeps = {},
): RawAdviceStore | undefined {
  const config = s3ObjectStoreConfigFromEnv(env);
  if (!config) return undefined;
  const store = createS3ObjectStore(config, deps);
  const provisioner = createS3TenantStorageProvisioner(config, deps);
  const keyOf = (adviceId: string): string => `m25-835/${adviceId}`;
  const bucketOf = (organizationId: string): string => deriveTenantBucket(organizationId as never);
  const signal = (): AbortSignal => AbortSignal.timeout(IO_TIMEOUT_MS);
  // Tenants onboarded before bucket provisioning (the dev demo org, older tenants) have none: create it on first
  // stage rather than failing every receive. Memoized per process; a failure is not cached.
  const ensured = new Set<string>();
  return {
    async put(organizationId, adviceId, text) {
      const stage = (): Promise<unknown> =>
        store.putObject({
          bucket: bucketOf(organizationId),
          objectKey: keyOf(adviceId),
          bytes: new TextEncoder().encode(text),
          signal: signal(),
        });
      if (!ensured.has(organizationId)) {
        await provisioner.ensureTenantPrefixes({ organizationId, prefixes: [] });
        ensured.add(organizationId);
      }
      try {
        await stage();
      } catch (err) {
        // The bucket can vanish after it was memoized (tenant erasure/recreation): re-ensure once and retry.
        if (!(err instanceof Error) || !/HTTP 404/.test(err.message)) throw err;
        ensured.delete(organizationId);
        await provisioner.ensureTenantPrefixes({ organizationId, prefixes: [] });
        ensured.add(organizationId);
        await stage();
      }
    },
    async get(organizationId, adviceId) {
      const bytes = await store.getObject({
        bucket: bucketOf(organizationId),
        objectKey: keyOf(adviceId),
        maxBytes: M25_RAW_835_MAX_BYTES,
        signal: signal(),
      });
      // fatal: a corrupt/non-UTF-8 object fails the read instead of posting replacement characters.
      return bytes ? new TextDecoder("utf-8", { fatal: true }).decode(bytes) : null;
    },
    async delete(organizationId, adviceId) {
      await store.destroyAllVersions({
        organizationId,
        bucket: bucketOf(organizationId),
        objectKey: keyOf(adviceId),
        signal: signal(),
      });
    },
  };
}
