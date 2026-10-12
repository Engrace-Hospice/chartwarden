// apps/backend/src/modules/36-messaging/attachments/attachment-ports.ts — WP 1.5: the two ports the attachment
// service composes over. M36 does not depend on M22 (module-manifest `dependsOn: [1,2,3,4]`), so it never imports
// M22 code: the composition root binds `AttachmentStoragePort` over M22's tenant object store
// (`apps/backend/src/m36-attachment-storage.ts`), and `ScanPort` over a scanner.

export interface AttachmentStoragePort {
  /**
   * Idempotently make sure the tenant's bucket exists. Network IO: the service calls it BEFORE any transaction, under a
   * deadline. Throws a typed 503 (`DegradedError`) with a client-safe message; operational detail is logged server-side.
   */
  ensureBucket?(organizationId: string): Promise<void>;
  /** A checksum-enforced presigned PUT into the tenant bucket. The returned headers MUST accompany the upload. */
  presignUpload(args: {
    readonly organizationId: string;
    readonly objectKey: string;
    readonly mimeType: string;
    readonly sha256Hex: string;
    /** The declared size; the PUT is signed for exactly this many bytes (quota counts it, so it must be true). */
    readonly byteSize: number;
    readonly ttlSeconds: number;
  }): Promise<{
    readonly url: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly expiresAt: string;
  }>;
  /** Authoritative object metadata; null when nothing was uploaded. */
  inspect(args: {
    readonly organizationId: string;
    readonly objectKey: string;
    /** Aborts the store call at the service's deadline. A port MUST stop on it (the service backstops one that does not). */
    readonly signal?: AbortSignal;
  }): Promise<{
    readonly byteSize: number;
    readonly mimeType: string;
    readonly sha256Hex: string;
  } | null>;
  /** The object's bytes, for the scanner. Null when the object is gone. Throws when the store is unreachable. */
  readBytes(args: {
    readonly organizationId: string;
    readonly objectKey: string;
    readonly maxBytes: number;
    /** Aborts the fetch and the body read at the service's deadline. */
    readonly signal?: AbortSignal;
  }): Promise<Uint8Array | null>;
  /**
   * A short-lived presigned GET. The URL is never logged. The store is asked to answer it as a download
   * (`Content-Disposition: attachment`) with the stored, allowlisted `mimeType`, so a browser never renders the bytes.
   */
  presignDownload(args: {
    readonly organizationId: string;
    readonly objectKey: string;
    readonly mimeType: string;
    readonly ttlSeconds: number;
  }): Promise<{ readonly url: string; readonly expiresAt: string }>;
  /**
   * Permanently destroy the object (every version). Idempotent: an already-gone object resolves. THROWS when the store
   * cannot do it (unbound, unreachable) - callers (the eraser, the orphan reaper) keep the row so the work is retryable.
   */
  destroyObject(args: {
    readonly organizationId: string;
    readonly objectKey: string;
    /** Aborts the list/delete calls at the caller's deadline (the reaper and the eraser bound every destroy). */
    readonly signal?: AbortSignal;
  }): Promise<void>;
}

export type ScanVerdict =
  | { readonly verdict: "clean" }
  | { readonly verdict: "infected"; readonly signature: string };

/**
 * A malware scanner. It RESOLVES a verdict or THROWS (unreachable, timed out, over its size limit): a throw leaves the
 * attachment `pending`, it is never read as "clean". `name` is recorded in the audit row and the event.
 */
export interface ScanPort {
  readonly name: string;
  /** Identifies the backing service (host:port) for diagnostics. Nothing keys shared state on it (no cross-org breaker). */
  readonly endpoint?: string;
  /** `signal` aborts at the service's deadline: the adapter MUST destroy its socket / stop its work and reject. */
  scan(input: {
    readonly bytes: Uint8Array;
    readonly mimeType: string;
    readonly signal?: AbortSignal;
  }): Promise<ScanVerdict>;
}
