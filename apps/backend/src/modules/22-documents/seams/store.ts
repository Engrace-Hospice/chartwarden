// apps/backend/src/modules/22-documents/seams/store.ts — M22-T04 (§4.3 / §7.2 W2).
//
// The data ports the M22 write-side seams run over. Two distinct ports live here and they are injected so the
// pure §2.2 lifecycle domain (M22-T03) stays IO-free and the seam impls stay unit-testable:
//
//   1. {@link DocumentStorageProvider} (the registered seam, §1.3 storage pillar) — the per-tenant MinIO object
//      surface. The in-memory adapter here keys bytes by their internal D1 object key, computes the §2.2.2
//      sha256 integrity hash, and mints a deterministic opaque presigned URL. Production swaps in a real MinIO
//      client with per-tenant bucket scope (M22-T07); the contract is identical.
//
//   2. {@link DocumentRenderStore} — the `document` / `document_version` persistence port the
//      {@link createDocumentRenderer} orchestrates: it appends versions (the §2.2.2 append-only ledger), flips
//      `active_version_id`, and records the §7.2 W2 aggregate → document back-reference index the T05
//      `RenderedDocumentProvider` reads. The in-memory slice here is the test/slice default; the Drizzle store
//      over M22's tables lands with the routes/repos (M22-T07).
//
// Mirrors the M18-T05 seams/store.ts precedent (one injected store backing the published read surface).
import { createHash } from "node:crypto";
import type { DocumentAggregateType, DocumentRetentionClass, DocumentSourceKind, DocumentStorageProvider } from "@wardenx/types";

/** A stored `document` row projection the in-memory render store holds (the fields the seams + T05 read). */
export interface StoredDocument {
  readonly id: string;
  readonly organizationId: string;
  readonly patientId: string | null;
  readonly aggregateType: DocumentAggregateType;
  readonly aggregateId: string | null;
  readonly title: string;
  readonly retentionClass: DocumentRetentionClass;
  readonly sourceKind: DocumentSourceKind;
  /** The current `document.active_version_id` (the single source of "current version", F19). */
  activeVersionId: string;
  activeVersionNumber: number;
  readonly versions: StoredDocumentVersion[];
  readonly renderedAt: string;
}

/** A stored, append-only `document_version` row projection (§2.2.2). */
export interface StoredDocumentVersion {
  readonly id: string;
  readonly versionNumber: number;
  readonly minioObjectKey: string;
  readonly sha256Hex: string;
  readonly mimeType: string;
  readonly byteSize: number;
  readonly renderedAt: string;
}

/** The persistence port {@link createDocumentRenderer} writes the §7.2 W2 handshake result through. */
export interface DocumentRenderStore {
  /** Find the existing document for an aggregate (so a re-render appends a version, not a new document — W2). */
  findByAggregate(args: {
    organizationId: string;
    aggregateType: DocumentAggregateType;
    aggregateId: string | null;
  }): StoredDocument | null;
  /** Create a `document` at its first version (§2.2.1) and index it by aggregate. */
  createDocument(doc: StoredDocument): void;
  /** Append a new version to an existing document and flip `active_version_id` (§2.2.2). */
  appendVersion(documentId: string, version: StoredDocumentVersion): void;
  /** Read a document back by id (test/seam helper). */
  get(documentId: string): StoredDocument | null;
}

/** A handle over the in-memory render store (the Map is exposed for assertions, mirroring M18's createInMemory*). */
export interface InMemoryDocumentRenderStore {
  readonly store: DocumentRenderStore;
  readonly documents: Map<string, StoredDocument>;
}

/** Build the in-memory {@link DocumentRenderStore} (the slice/test default). */
export function createInMemoryDocumentRenderStore(seed: readonly StoredDocument[] = []): InMemoryDocumentRenderStore {
  const documents = new Map<string, StoredDocument>();
  for (const d of seed) documents.set(d.id, d);
  const aggregateKey = (organizationId: string, aggregateType: string, aggregateId: string | null): string =>
    `${organizationId}::${aggregateType}::${aggregateId ?? ""}`;
  const byAggregate = new Map<string, string>();
  for (const d of documents.values()) {
    if (d.aggregateId !== null) byAggregate.set(aggregateKey(d.organizationId, d.aggregateType, d.aggregateId), d.id);
  }
  const store: DocumentRenderStore = {
    findByAggregate({ organizationId, aggregateType, aggregateId }) {
      if (aggregateId === null) return null; // an unbound render is always a new document
      const id = byAggregate.get(aggregateKey(organizationId, aggregateType, aggregateId));
      return id ? (documents.get(id) ?? null) : null;
    },
    createDocument(doc) {
      documents.set(doc.id, doc);
      if (doc.aggregateId !== null) {
        byAggregate.set(aggregateKey(doc.organizationId, doc.aggregateType, doc.aggregateId), doc.id);
      }
    },
    appendVersion(documentId, version) {
      const doc = documents.get(documentId);
      if (!doc) return;
      doc.versions.push(version);
      doc.activeVersionId = version.id;
      doc.activeVersionNumber = version.versionNumber;
    },
    get(documentId) {
      return documents.get(documentId) ?? null;
    },
  };
  return { store, documents };
}

/** A handle over the in-memory storage adapter (the bytes Map is exposed for assertions). */
export interface InMemoryDocumentStorage {
  readonly provider: DocumentStorageProvider;
  readonly objects: Map<string, { bytes: Uint8Array; mimeType: string }>;
}

/**
 * Build the in-memory {@link DocumentStorageProvider} (the slice/test default). It computes the §2.2.2 sha256
 * over the stored bytes and mints a deterministic, opaque presigned URL (the D11 PHI-free `downloadFilename` is
 * the only patient-free string that reaches the URL). Production swaps in a per-tenant-bucket MinIO client.
 */
export function createInMemoryDocumentStorageProvider(): InMemoryDocumentStorage {
  const objects = new Map<string, { bytes: Uint8Array; mimeType: string }>();
  const provider: DocumentStorageProvider = {
    async putRenderedDocument({ objectKey, bytes, mimeType }) {
      objects.set(objectKey, { bytes, mimeType });
      const sha256Hex = createHash("sha256").update(bytes).digest("hex");
      return { sha256Hex, byteSize: bytes.byteLength };
    },
    async presignDownload({ tenantId, downloadFilename, ttlSeconds }) {
      // Deterministic in-memory stand-in: no clock dependency, no patient identifier — only the tenant bucket
      // and the D11 opaque leaf. The real MinIO presign (with the actual `expiresAt`) lands in M22-T07.
      return {
        url: `memory://tenant-${tenantId}/${downloadFilename}?ttl=${ttlSeconds}`,
        expiresAt: `+${ttlSeconds}s`,
      };
    },
  };
  return { provider, objects };
}
