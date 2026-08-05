// apps/backend/src/modules/22-documents/seams/store.ts — M22-T04 the data PORT the §4.3 published seams
// compose over, plus an in-memory slice for tests/boot-without-DB. The seam impls (./renderer.ts,
// ./storage.ts) are pure orchestration over this port; production injects a Drizzle-backed store that
// reads/writes M22's `document` / `document_version` tables under the CONSUMER's `withOrgContext` (the
// impls never switch tenants — RLS scopes every read/write by `app.org_id`, §4.3). The OBJECT bytes live
// behind a separate {@link ObjectStorePort} (the real MinIO client in prod; an in-memory map in tests) —
// the storage seam never imports the MinIO SDK here. Mirrors the M7/M8 seams/store.ts precedent.
import { createHash } from "node:crypto";
import type {
  DocumentAggregateType,
  DocumentId,
  DocumentRetentionClass,
  DocumentVersionId,
  IsoInstant,
  OrgId,
  PatientId,
  SignedUrlDescriptor,
} from "@wardenx/types";

/**
 * The render request the store materializes into a `document` (+ genesis `document_version`) row, or a
 * NEW version on an existing document for the addendum/correction case (W2: an addendum is a new VERSION,
 * not a new DOCUMENT). The bytes are written to the object store under the derived key by the renderer;
 * this DTO carries only the metadata the rows need (PHI-free key shaping happens in ./storage helpers).
 */
export interface RenderUpsert {
  readonly organizationId: OrgId;
  readonly aggregateType: DocumentAggregateType;
  readonly aggregateId: string;
  readonly patientId: PatientId | null;
  readonly retentionClass: DocumentRetentionClass;
  readonly title: string;
  /** The opaque per-version object key (PHI-free, D11) the bytes were written under. */
  readonly objectKey: string;
  /** The tenant bucket the bytes were written into (D1). */
  readonly bucket: string;
  /** The content hash of the rendered bytes (immutable per version, §2.3). */
  readonly sha256Hex: string;
  readonly renderedAt: IsoInstant;
}

/** The rows the store returns after an upsert — the back-ref every source module's consumer applies. */
export interface RenderedDocumentRow {
  readonly documentId: DocumentId;
  readonly versionId: DocumentVersionId;
  readonly versionNumber: number;
  /** True when this upsert created the `document` (genesis v1); false when it appended a version. */
  readonly isFirstVersion: boolean;
  readonly renderedAt: IsoInstant;
}

/**
 * The data port the §4.3 published seams compose over. Methods return read-only DTO shapes (never Drizzle
 * rows); the Drizzle adapter projects rows to these under the consumer's RLS context. Reads key on the
 * tenant-pinned id/scope (the org is already pinned by RLS) and return null when nothing is visible.
 */
export interface DocumentSeamStore {
  /**
   * Upsert the W2 render result: create the `document` + genesis `document_version` on first render of an
   * aggregate, OR append a new immutable `document_version` (and flip `active_version_id`) when the
   * aggregate already has a document (the addendum/correction path). Returns the new rows.
   */
  upsertRenderedDocument(input: RenderUpsert): Promise<RenderedDocumentRow>;
  /** The active rendered document for one source aggregate, or null when none has rendered yet. */
  renderedDocumentForAggregate(args: {
    readonly aggregateType: DocumentAggregateType;
    readonly aggregateId: string;
    readonly organizationId: OrgId;
  }): Promise<{
    documentId: DocumentId;
    versionId: DocumentVersionId;
    renderedAt: IsoInstant;
  } | null>;
}

/**
 * The object-storage PORT the {@link DocumentStorageProvider} impl composes over. Pure key/presign math
 * (./storage.ts in T03) computes the descriptor; this port performs the IO. The real impl is the MinIO
 * client (presign + version-aware delete); the in-memory slice records writes/deletes for tests. The
 * presigned URL is never logged (§4.12) — callers receive it and hand it straight to the client.
 */
export interface ObjectStorePort {
  /** Write rendered bytes under `bucket/objectKey` and return the content hash (sha256, hex). */
  putObject(args: {
    readonly bucket: string;
    readonly objectKey: string;
    readonly bytes: Uint8Array;
  }): Promise<{ readonly sha256Hex: string }>;
  /** Presign a checksum-enforced direct PUT. The returned headers MUST accompany the client upload. */
  presignUpload(args: {
    readonly bucket: string;
    readonly objectKey: string;
    readonly mimeType: string;
    readonly sha256Hex: string;
    readonly ttlSeconds: number;
  }): Promise<{
    readonly url: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly expiresAt: IsoInstant;
  }>;
  /** Read authoritative object metadata after upload; null means the object is not present. */
  inspectObject(args: {
    readonly bucket: string;
    readonly objectKey: string;
  }): Promise<{
    readonly byteSize: number;
    readonly mimeType: string;
    readonly sha256Hex: string;
  } | null>;
  /** Mint a short-TTL presigned GET URL for one object version (the URL itself is never logged). */
  presign(args: {
    readonly descriptor: SignedUrlDescriptor;
    readonly organizationId: OrgId;
  }): Promise<{ readonly url: string; readonly expiresAt: IsoInstant }>;
  /** Version-aware destruction: delete EVERY object version + delete-marker for the key (D12 / DR-019). */
  destroyAllVersions(args: {
    readonly bucket: string;
    readonly objectKey: string;
    readonly organizationId: OrgId;
  }): Promise<void>;
}

// ── in-memory slice stores ──────────────────────────────────────────────────────────────────────────

/** Deterministic, I/O-free seed for the in-memory {@link DocumentSeamStore} (slice + seam tests). */
export interface DocumentSeamSeed {
  /** Pre-existing rendered documents keyed by aggregate (seeds the addendum-as-new-version path). */
  readonly documents?: readonly (RenderedDocumentRow & {
    readonly aggregateType: DocumentAggregateType;
    readonly aggregateId: string;
    readonly organizationId: OrgId;
  })[];
}

/** Pads `n` to mint a uuid-shaped id so created ids round-trip through uuid-validated bodies (M8 slice). */
function uuidFromCounter(prefix: string, n: number): string {
  const hex = n.toString(16).padStart(12, "0");
  return `00000000-0000-4000-${prefix}-${hex}`;
}

interface StoredRendered {
  documentId: DocumentId;
  aggregateType: DocumentAggregateType;
  aggregateId: string;
  organizationId: OrgId;
  versions: {
    versionId: DocumentVersionId;
    versionNumber: number;
    objectKey: string;
    bucket: string;
    renderedAt: IsoInstant;
  }[];
}

/** An in-memory {@link DocumentSeamStore} for the slice/tests — no DB, deterministic, RLS-free. */
export function createInMemoryDocumentSeamStore(seed: DocumentSeamSeed = {}): {
  store: DocumentSeamStore;
} {
  const docs: StoredRendered[] = (seed.documents ?? []).map((d) => ({
    documentId: d.documentId,
    aggregateType: d.aggregateType,
    aggregateId: d.aggregateId,
    organizationId: d.organizationId,
    versions: [
      {
        versionId: d.versionId,
        versionNumber: d.versionNumber,
        objectKey: "",
        bucket: "",
        renderedAt: d.renderedAt,
      },
    ],
  }));
  let docCounter = docs.length;
  let verCounter = docs.reduce((n, d) => n + d.versions.length, 0);

  const find = (
    aggregateType: DocumentAggregateType,
    aggregateId: string,
    organizationId: OrgId,
  ): StoredRendered | undefined =>
    docs.find(
      (d) =>
        d.aggregateType === aggregateType &&
        d.aggregateId === aggregateId &&
        d.organizationId === organizationId,
    );

  return {
    store: {
      async upsertRenderedDocument(input): Promise<RenderedDocumentRow> {
        const existing = find(input.aggregateType, input.aggregateId, input.organizationId);
        const versionId = uuidFromCounter("8001", ++verCounter);
        if (existing) {
          // W2 addendum/correction: a NEW immutable version on the SAME document (never a new document).
          const versionNumber = Math.max(...existing.versions.map((v) => v.versionNumber)) + 1;
          existing.versions.push({
            versionId,
            versionNumber,
            objectKey: input.objectKey,
            bucket: input.bucket,
            renderedAt: input.renderedAt,
          });
          return {
            documentId: existing.documentId,
            versionId,
            versionNumber,
            isFirstVersion: false,
            renderedAt: input.renderedAt,
          };
        }
        const documentId = uuidFromCounter("8000", ++docCounter);
        docs.push({
          documentId,
          aggregateType: input.aggregateType,
          aggregateId: input.aggregateId,
          organizationId: input.organizationId,
          versions: [
            {
              versionId,
              versionNumber: 1,
              objectKey: input.objectKey,
              bucket: input.bucket,
              renderedAt: input.renderedAt,
            },
          ],
        });
        return {
          documentId,
          versionId,
          versionNumber: 1,
          isFirstVersion: true,
          renderedAt: input.renderedAt,
        };
      },
      async renderedDocumentForAggregate(args) {
        const d = find(args.aggregateType, args.aggregateId, args.organizationId);
        if (!d) return null;
        const latest = d.versions.reduce((a, b) => (a.versionNumber >= b.versionNumber ? a : b));
        return {
          documentId: d.documentId,
          versionId: latest.versionId,
          renderedAt: latest.renderedAt,
        };
      },
    },
  };
}

/** An in-memory {@link ObjectStorePort} for the slice/tests — records puts/deletes, no MinIO. */
export function createInMemoryObjectStore(): {
  store: ObjectStorePort;
  /** Test handle: the live object keys per `bucket/objectKey` (after puts, minus destroys). */
  readonly objects: Map<string, Uint8Array>;
} {
  const objects = new Map<string, Uint8Array>();
  const key = (bucket: string, objectKey: string) => `${bucket}/${objectKey}`;
  const hash = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
  return {
    objects,
    store: {
      async putObject({ bucket, objectKey, bytes }) {
        objects.set(key(bucket, objectKey), bytes);
        return { sha256Hex: hash(bytes) };
      },
      async presignUpload({ bucket, objectKey, mimeType, sha256Hex, ttlSeconds }) {
        return {
          url: `memory-upload://${bucket}/${objectKey}`,
          headers: {
            "content-type": mimeType,
            "x-amz-checksum-sha256": Buffer.from(sha256Hex, "hex").toString("base64"),
          },
          expiresAt: new Date(Date.now() + ttlSeconds * 1000).toISOString(),
        };
      },
      async inspectObject({ bucket, objectKey }) {
        const bytes = objects.get(key(bucket, objectKey));
        return bytes
          ? {
              byteSize: bytes.byteLength,
              mimeType: "application/octet-stream",
              sha256Hex: hash(bytes),
            }
          : null;
      },
      async presign({ descriptor }) {
        // PHI-free, deterministic stand-in URL (the real adapter signs against MinIO). The key is opaque
        // (D11); the URL carries no patient identifier. `expiresAt` honours the descriptor TTL.
        const expiresAt = new Date(Date.now() + descriptor.ttlSeconds * 1000).toISOString();
        return { url: `memory://${descriptor.bucket}/${descriptor.objectKey}`, expiresAt };
      },
      async destroyAllVersions({ bucket, objectKey }) {
        objects.delete(key(bucket, objectKey));
      },
    },
  };
}
