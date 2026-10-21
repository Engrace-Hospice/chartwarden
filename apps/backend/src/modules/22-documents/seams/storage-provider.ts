// apps/backend/src/modules/22-documents/seams/storage-provider.ts — M22-T04 the §4.3 `DocumentStorageProvider`
// impl: the per-tenant object-storage seam (§11 D1). M22 publishes the presign-download + version-aware
// destroy surface every M22 consumer (the lifecycle download path, the D12 eraser) resolves through the M1
// registry — the real MinIO client is injected behind the {@link ObjectStorePort}, never imported here. The
// PHI-free key/presign MATH is the pure T03 ./lifecycle/storage logic (`planSignedUrl`); this impl is the
// thin IO orchestration over the injected port (no MinIO SDK, no network in the slice/tests). The presigned
// URL itself is never logged (§4.12) — the caller receives it and hands it straight to the client.
import type {
  DocumentStorageProvider,
  IsoInstant,
  OrgId,
  SignedUrlDescriptor,
} from "@chartwarden/types";
import type { ObjectStorePort } from "./store";

export interface DocumentStorageProviderDeps {
  readonly objects: ObjectStorePort;
}

/**
 * Build the §4.3 `DocumentStorageProvider` over the injected {@link ObjectStorePort}. `presignDownload`
 * mints a short-TTL GET URL for one object version (the descriptor is the PHI-free T03 plan); the URL is
 * never logged. `destroyAllObjectVersions` performs the D12 / DR-019 version-aware shred (delete EVERY
 * object version + delete-marker), the second physical layer behind the DEK crypto-erase.
 */
export function createDocumentStorageProvider(
  deps: DocumentStorageProviderDeps,
): DocumentStorageProvider {
  return {
    async presignDownload(args: {
      readonly descriptor: SignedUrlDescriptor;
      readonly organizationId: OrgId;
    }): Promise<{ readonly url: string; readonly expiresAt: IsoInstant }> {
      return deps.objects.presign({
        descriptor: args.descriptor,
        organizationId: args.organizationId,
      });
    },
    async destroyAllObjectVersions(args: {
      readonly bucket: string;
      readonly objectKey: string;
      readonly organizationId: OrgId;
    }): Promise<void> {
      await deps.objects.destroyAllVersions({
        bucket: args.bucket,
        objectKey: args.objectKey,
        organizationId: args.organizationId,
      });
    },
  };
}
