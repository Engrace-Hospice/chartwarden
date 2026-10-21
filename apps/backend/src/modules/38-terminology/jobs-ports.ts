// apps/backend/src/modules/38-terminology/jobs-ports.ts — the narrow surfaces the admin routes need from the §4.3
// job layer and the platform bucket, injected by the composition root so the routes stay unit-testable without
// Valkey or MinIO (and so a deployment without them answers 503, never a silent success).
import type { LoadableSystemId } from "@chartwarden/terminology-loader";

/** Producer side of the §4.3 queues, as the admin routes use it. */
export interface TerminologyJobProducer {
  /** Queue `terminology.load_version` for a registered version. Deduplicated by version id. */
  enqueueLoadVersion(versionId: string, activate: boolean): Promise<void>;
  /** Queue `terminology.refresh_embeddings` for a system's active version. */
  enqueueRefreshEmbeddings(system: LoadableSystemId, versionId: string): Promise<void>;
}

/** Presigns a checksum-enforced PUT into the PLATFORM terminology bucket (never a tenant bucket). */
export interface PlatformUploadSigner {
  presignUpload(args: {
    readonly objectKey: string;
    readonly sha256Hex: string;
    readonly ttlSeconds: number;
  }): Promise<{
    readonly url: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly expiresAt: string;
  }>;
}
