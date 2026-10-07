// apps/backend/src/modules/28-fhir/jobs/object-store-adapter.ts — adapts the platform's SigV4 MinIO/S3 client
// (M22's `ObjectStorePort`) to the narrow {@link FhirExportObjectStore} slice the bulk-export worker needs.
//
// M28 may not import M22's code (architecture §25.15), so the S3 client is declared here STRUCTURALLY (the
// subset of methods used) and the composition root passes M22's real adapter and its `deriveTenantBucket`.
// EVERY call resolves the bucket from the `organizationId` argument, so an export object can only ever be
// written to, presigned from, or destroyed in the owning tenant's bucket — a wrong object key cannot reach
// another tenant's bucket.
import type { FhirExportObjectStore } from "./ports";

/** The subset of M22's `ObjectStorePort` this adapter calls (structurally compatible with it). */
export interface S3ClientSlice {
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
      readonly accessKind: "disclosure_export";
    };
    readonly organizationId: never;
  }): Promise<{ readonly url: string; readonly expiresAt: string }>;
  destroyAllVersions(args: {
    readonly bucket: string;
    readonly objectKey: string;
    readonly organizationId: never;
  }): Promise<void>;
}

const NDJSON_MIME = "application/fhir+ndjson";

export function buildFhirExportObjectStore(
  s3: S3ClientSlice,
  bucketFor: (organizationId: string) => string,
): FhirExportObjectStore {
  return {
    async put({ organizationId, objectKey, bytes }) {
      return s3.putObject({
        bucket: bucketFor(organizationId),
        objectKey,
        bytes,
        mimeType: NDJSON_MIME,
      });
    },
    async presignGet({ organizationId, objectKey, ttlSeconds }) {
      return s3.presign({
        descriptor: {
          bucket: bucketFor(organizationId),
          objectKey,
          ttlSeconds,
          accessKind: "disclosure_export",
        },
        organizationId: organizationId as never,
      });
    },
    async destroy({ organizationId, objectKey }) {
      await s3.destroyAllVersions({
        bucket: bucketFor(organizationId),
        objectKey,
        organizationId: organizationId as never,
      });
    },
  };
}
