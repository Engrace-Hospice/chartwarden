// apps/backend/src/modules/38-terminology/jobs/platform-objects.ts — the PLATFORM terminology bucket (GAP-108).
//
// Release files live in ONE platform bucket (`TERMINOLOGY_PLATFORM_BUCKET`, default `wardenx-platform-terminology`),
// never in a tenant bucket: they are reference data, and the licensed ones (SNOMED CT, LOINC, the RxNorm full
// release) must not be copied around. M38 may not import M22's S3 client (architecture §25.15), so the SigV4 store is
// declared STRUCTURALLY here and the composition root passes M22's real adapter. The bucket itself is an ops
// prerequisite: nothing here creates it, and a missing bucket surfaces as an upload/read failure, not a silent skip.
import { SourceNotFoundError } from "@chartwarden/terminology-loader";
import type { PlatformObjectPort } from "@chartwarden/terminology-loader";
import type { PlatformUploadSigner } from "../jobs-ports";

/** The subset of M22's `ObjectStorePort` this adapter calls (structurally compatible with it). */
export interface PlatformS3Slice {
  putObject(args: {
    readonly bucket: string;
    readonly objectKey: string;
    readonly bytes: Uint8Array;
    readonly mimeType?: string;
  }): Promise<{ readonly sha256Hex: string }>;
  presign(args: {
    readonly descriptor: {
      readonly bucket: string;
      readonly objectKey: string;
      readonly ttlSeconds: number;
      readonly accessKind: "content_download";
    };
    readonly organizationId: never;
  }): Promise<{ readonly url: string; readonly expiresAt: string }>;
  presignUpload(args: {
    readonly bucket: string;
    readonly objectKey: string;
    readonly mimeType: string;
    readonly sha256Hex: string;
    readonly ttlSeconds: number;
  }): Promise<{
    readonly url: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly expiresAt: string;
  }>;
}

export const DEFAULT_PLATFORM_BUCKET = "wardenx-platform-terminology";
const READ_URL_TTL_SECONDS = 120;
const OCTET_STREAM = "application/octet-stream";

/** Reads and writes the platform bucket (the loader's source files and fetched releases). */
export function createPlatformObjectPort(
  s3: PlatformS3Slice,
  bucket: string = DEFAULT_PLATFORM_BUCKET,
  fetchImpl: typeof fetch = fetch,
): PlatformObjectPort {
  return {
    async read(objectKey) {
      const { url } = await s3.presign({
        // No organization: the platform bucket is not tenant-scoped (the slice's `never` is satisfied by omission).
        organizationId: undefined as never,
        descriptor: {
          bucket,
          objectKey,
          ttlSeconds: READ_URL_TTL_SECONDS,
          accessKind: "content_download",
        },
      });
      const res = await fetchImpl(url);
      if (res.status === 404) throw new SourceNotFoundError(objectKey);
      if (!res.ok) throw new Error(`platform bucket read failed with HTTP ${res.status}`);
      return new Uint8Array(await res.arrayBuffer());
    },
    async write(objectKey, bytes) {
      await s3.putObject({ bucket, objectKey, bytes, mimeType: OCTET_STREAM });
    },
  };
}

/** Presign checksum-enforced uploads into the platform bucket (`POST /admin/terminology/uploads`). */
export function createPlatformUploadSigner(
  s3: PlatformS3Slice,
  bucket: string = DEFAULT_PLATFORM_BUCKET,
): PlatformUploadSigner {
  return {
    presignUpload: ({ objectKey, sha256Hex, ttlSeconds }) =>
      s3.presignUpload({ bucket, objectKey, mimeType: OCTET_STREAM, sha256Hex, ttlSeconds }),
  };
}
