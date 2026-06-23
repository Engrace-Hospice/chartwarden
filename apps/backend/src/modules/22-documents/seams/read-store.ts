// apps/backend/src/modules/22-documents/seams/read-store.ts — M22-T05 (§4.3 published reader seams).
//
// The READ data port the five §4.3 reader seams run over. Like the M18-T05 `EvvSeamStore`, this is a read-only
// surface: M22 owns the document/extraction lifecycle internally (the write path is the T04 render store) and the
// reader seams NEVER mutate. The in-memory adapter here is the slice/test default; the Drizzle adapter over M22's
// `document` / `document_version` / `extraction_provenance` / `intake_upload_batch` / `extraction_*` tables lands
// with the routes/repos (M22-T07), reading under the consumer's `app.org_id` RLS (§3.6) — the providers add NO
// tenant logic of their own. Mirrors the M9..M18 read-seam store precedents (one injected store backing the surface).
import type {
  DocumentAggregateType,
  DocumentDigest,
  DocumentRetentionClass,
  DocumentSourceKind,
  DocumentStatus,
  IntakeMetrics,
  PortalDocumentDigest,
  ProvenanceRecord,
  ChartTargetModule,
} from "@wardenx/types";

/** A seeded `document` + active-version projection (the fields the three document readers + the portal reader read). */
export interface DocumentSeamRow {
  readonly id: string;
  readonly organizationId: string;
  readonly patientId: string | null;
  readonly aggregateType: DocumentAggregateType;
  readonly aggregateId: string | null;
  readonly title: string;
  readonly retentionClass: DocumentRetentionClass;
  readonly sourceKind: DocumentSourceKind;
  readonly status: DocumentStatus;
  readonly patientFacing: boolean;
  readonly activeVersionId: string | null;
  readonly versionNumber: number | null;
  readonly mimeType: string | null;
  readonly byteSize: number | null;
  readonly sha256Hex: string | null;
  readonly versionsCount: number;
  /** D20 — the active version carries SUD-class content (drives the portal SUD consent gate, T06). */
  readonly sudClass: boolean;
  /** The §7.10 D11 opaque, PHI-free download leaf for the active version (the only storage string allowed into a URL). */
  readonly downloadFilename: string;
  readonly renderedAt: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** What the portal reader needs to gate + mint a download URL for one version (resolved by `document_version` id). */
export interface PortalVersionRow {
  readonly documentId: string;
  readonly documentVersionId: string;
  readonly organizationId: string;
  readonly patientId: string | null;
  readonly patientFacing: boolean;
  readonly sudClass: boolean;
  readonly downloadFilename: string;
}

/** The read port the five §4.3 reader seams resolve through (Drizzle in prod under consumer RLS; in-memory in tests). */
export interface DocumentSeamReadStore {
  /** RenderedDocumentProvider — the W2 back-ref: the latest rendered document for an aggregate (or null). */
  renderedForAggregate(args: {
    organizationId: string;
    aggregateType: DocumentAggregateType;
    aggregateId: string;
  }): { documentId: string; versionId: string; renderedAt: string } | null;
  /** DocumentReader — the metadata digests for a patient (cursor-paginated by document id; ascending). */
  documentsForPatient(args: {
    organizationId: string;
    patientId: string;
    aggregateType?: DocumentAggregateType;
    sinceCursor?: string;
    limit?: number;
  }): DocumentDigest[];
  /** DocumentReader — a single document's metadata digest (or null). */
  documentMetadata(args: { organizationId: string; documentId: string }): DocumentDigest | null;
  /** PortalDocumentReader — the patient-facing, portal-safe digests for a patient (non-patient-facing stripped). */
  portalDocumentsForPatient(args: {
    organizationId: string;
    patientId: string;
    aggregateType?: DocumentAggregateType;
    sinceCursor?: string;
  }): PortalDocumentDigest[];
  /** PortalDocumentReader — resolve one version for the mint-URL gate (ownership + patient-facing + SUD flags). */
  portalVersion(args: { organizationId: string; documentVersionId: string }): PortalVersionRow | null;
  /** IntakeMetricsProvider — the org-level intake throughput aggregate over a window. */
  intakeMetrics(args: { organizationId: string; from: string; to: string }): IntakeMetrics;
  /** ExtractionProvenanceReader — the per-chart-field provenance for a write-back target aggregate. */
  provenanceForTarget(args: {
    organizationId: string;
    targetModule: ChartTargetModule;
    targetAggregateId: string;
  }): ProvenanceRecord[];
}

/** Project a seeded row down to the §4.3 `DocumentDigest` read DTO (never a Drizzle row). */
function toDigest(row: DocumentSeamRow): DocumentDigest {
  return {
    id: row.id,
    organizationId: row.organizationId,
    patientId: row.patientId,
    aggregateType: row.aggregateType,
    aggregateId: row.aggregateId,
    title: row.title,
    retentionClass: row.retentionClass,
    sourceKind: row.sourceKind,
    status: row.status,
    patientFacing: row.patientFacing,
    activeVersionId: row.activeVersionId,
    versionNumber: row.versionNumber,
    mimeType: row.mimeType,
    byteSize: row.byteSize,
    sha256Hex: row.sha256Hex,
    versionsCount: row.versionsCount,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** Project a seeded row down to the portal-safe `PortalDocumentDigest` (only non-null active versions are eligible). */
function toPortalDigest(row: DocumentSeamRow): PortalDocumentDigest | null {
  if (row.activeVersionId === null || row.mimeType === null || row.byteSize === null) return null;
  return {
    id: row.id,
    aggregateType: row.aggregateType,
    title: row.title,
    activeVersionId: row.activeVersionId,
    mimeType: row.mimeType,
    byteSize: row.byteSize,
    renderedAt: row.renderedAt,
  };
}

/** The seed an in-memory read store is built from (documents + per-chart-field provenance + per-org intake metrics). */
export interface DocumentSeamSeed {
  readonly documents?: readonly DocumentSeamRow[];
  readonly provenance?: readonly ProvenanceRecord[];
  /** Per-org intake throughput aggregate (the slice returns it verbatim; the Drizzle store computes it, T07). */
  readonly intakeMetricsByOrg?: Readonly<Record<string, IntakeMetrics>>;
}

const EMPTY_METRICS: IntakeMetrics = {
  batchesProcessed: 0,
  batchesInReview: 0,
  batchesWritebackComplete: 0,
  batchesDiscarded: 0,
  candidatesTotal: 0,
  candidatesApproved: 0,
  candidatesRejected: 0,
  discrepanciesOpen: 0,
  averageTimeToReviewMinutes: 0,
};

/** A handle over the in-memory read store (the row arrays are exposed for assertions, mirroring M18's createInMemory*). */
export interface InMemoryDocumentReadStore {
  readonly store: DocumentSeamReadStore;
  readonly documents: readonly DocumentSeamRow[];
}

/**
 * Build the in-memory {@link DocumentSeamReadStore} (the slice/test default). Every read is scoped by
 * `organizationId` in-process (in prod, RLS does this and the provider stays tenant-logic-free). Cursor pagination
 * is document-id-ascending and opaque (`sinceCursor` is the last id seen); the real keyset cursor lands in M22-T07.
 */
export function createInMemoryDocumentReadStore(seed: DocumentSeamSeed = {}): InMemoryDocumentReadStore {
  const documents = [...(seed.documents ?? [])];
  const provenance = [...(seed.provenance ?? [])];
  const metricsByOrg = seed.intakeMetricsByOrg ?? {};

  const inOrg = (orgId: string) => documents.filter((d) => d.organizationId === orgId);
  const afterCursor = (rows: DocumentSeamRow[], cursor?: string) =>
    (cursor ? rows.filter((d) => d.id > cursor) : rows).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const store: DocumentSeamReadStore = {
    renderedForAggregate({ organizationId, aggregateType, aggregateId }) {
      const matches = inOrg(organizationId).filter(
        (d) => d.aggregateType === aggregateType && d.aggregateId === aggregateId && d.activeVersionId !== null,
      );
      if (matches.length === 0) return null;
      // The latest render (highest version) is the W2 current document for the aggregate.
      const latest = matches.reduce((a, b) => ((b.versionNumber ?? 0) >= (a.versionNumber ?? 0) ? b : a));
      return { documentId: latest.id, versionId: latest.activeVersionId as string, renderedAt: latest.renderedAt };
    },
    documentsForPatient({ organizationId, patientId, aggregateType, sinceCursor, limit }) {
      const rows = inOrg(organizationId).filter(
        (d) => d.patientId === patientId && (aggregateType ? d.aggregateType === aggregateType : true),
      );
      return afterCursor(rows, sinceCursor)
        .slice(0, limit ?? 50)
        .map(toDigest);
    },
    documentMetadata({ organizationId, documentId }) {
      const row = inOrg(organizationId).find((d) => d.id === documentId);
      return row ? toDigest(row) : null;
    },
    portalDocumentsForPatient({ organizationId, patientId, aggregateType, sinceCursor }) {
      const rows = inOrg(organizationId).filter(
        (d) =>
          d.patientId === patientId &&
          d.patientFacing &&
          d.status === "active" &&
          (aggregateType ? d.aggregateType === aggregateType : true),
      );
      return afterCursor(rows, sinceCursor)
        .map(toPortalDigest)
        .filter((d): d is PortalDocumentDigest => d !== null);
    },
    portalVersion({ organizationId, documentVersionId }) {
      const row = inOrg(organizationId).find((d) => d.activeVersionId === documentVersionId);
      if (!row || row.activeVersionId === null) return null;
      return {
        documentId: row.id,
        documentVersionId: row.activeVersionId,
        organizationId: row.organizationId,
        patientId: row.patientId,
        patientFacing: row.patientFacing,
        sudClass: row.sudClass,
        downloadFilename: row.downloadFilename,
      };
    },
    intakeMetrics({ organizationId }) {
      return metricsByOrg[organizationId] ?? EMPTY_METRICS;
    },
    provenanceForTarget({ organizationId, targetModule, targetAggregateId }) {
      void organizationId; // in-process slice has no per-row org tag on provenance seeds; RLS scopes it in prod
      return provenance.filter(
        (p) => p.targetModule === targetModule && p.targetAggregateId === targetAggregateId,
      );
    },
  };

  return { store, documents };
}
