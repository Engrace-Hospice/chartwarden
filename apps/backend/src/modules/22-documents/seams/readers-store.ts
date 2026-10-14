// apps/backend/src/modules/22-documents/seams/readers-store.ts — M22-T05 the data PORT the five §4.3 PUBLISHED
// reader seams (RenderedDocumentProvider / DocumentReader / PortalDocumentReader / IntakeMetricsProvider /
// ExtractionProvenanceReader) compose over, plus an in-memory slice for tests / boot-without-DB. The reader
// impls (./readers.ts) are pure orchestration over this port; production injects a Drizzle-backed store that
// reads M22's `document` / `document_version` / `extraction_*` rows under the CONSUMER's `withOrgContext` —
// the impls never switch tenants; RLS scopes every read by `app.org_id` (§4.3). Mirrors the M17 seams/store.ts
// read-seam precedent (one store, many readers). All five seams are READ-only — M22 owns the lifecycle internally.
import type {
  ActiveDocumentVersionLink,
  ChartTargetModule,
  DocumentAggregateType,
  DocumentDigest,
  DocumentId,
  DocumentVersionId,
  IntakeMetrics,
  IsoInstant,
  OrgId,
  PatientId,
  PortalDocumentDigest,
  ProvenanceRecord,
} from "@wardenx/types";
import { resolveSudConsentPresent } from "../outbox-consumers/consent-gate";

/** The render-back-ref shape `RenderedDocumentProvider` returns (the active version per source aggregate). */
export interface RenderedAggregateRow {
  readonly documentId: DocumentId;
  readonly versionId: DocumentVersionId;
  readonly renderedAt: IsoInstant;
}

/**
 * The data port the §4.3 published reader seams compose over. Read methods return read-only DTO shapes
 * (never Drizzle rows); the Drizzle adapter projects rows to these under the consumer's RLS context. The org
 * is already pinned by RLS, so reads key on the tenant-scoped ids and the (already-pinned) `organizationId`.
 */
export interface DocumentReaderStore {
  /** §4.3 RenderedDocumentProvider — the active rendered document for one source aggregate, or null. */
  renderedDocumentForAggregate(args: {
    readonly aggregateType: DocumentAggregateType;
    readonly aggregateId: string;
    readonly organizationId: OrgId;
  }): Promise<RenderedAggregateRow | null>;

  /** §4.3 DocumentReader — the patient's document digests (most-recent first), `sinceCursor`-paged. The
   * cursor is the opaque `createdAt|documentId` of the last row a prior page returned (keyset pagination). */
  documentsForPatient(args: {
    readonly patientId: PatientId;
    readonly organizationId: OrgId;
    readonly aggregateType?: DocumentAggregateType;
    readonly sinceCursor?: string;
    readonly limit: number;
  }): Promise<ReadonlyArray<DocumentDigest>>;

  /** §4.3 DocumentReader — one document's digest by id, or null when not visible under RLS. */
  documentMetadata(args: {
    readonly documentId: DocumentId;
    readonly organizationId: OrgId;
  }): Promise<DocumentDigest | null>;

  /** M36 WP 3.2 — id/patient/status/created_at of one document (NO title). Org-explicit; null when absent. */
  linkSummaryForDocument(args: {
    readonly documentId: DocumentId;
    readonly organizationId: OrgId;
  }): Promise<{
    readonly documentId: DocumentId;
    readonly patientId: PatientId | null;
    readonly status: DocumentDigest["status"];
    readonly createdAt: IsoInstant;
  } | null>;

  /** §4.3 DocumentReader.activeVersionLink — the patient/admission link of a document whose ACTIVE version
   * is `documentVersionId` (the version must belong to the document); null otherwise. */
  activeVersionLink(args: {
    readonly documentId: DocumentId;
    readonly documentVersionId: DocumentVersionId;
    readonly organizationId: OrgId;
  }): Promise<ActiveDocumentVersionLink | null>;

  /** The active version id for one document (the version the portal mint targets), or null. */
  activeVersionForDocument(args: {
    readonly documentVersionId: DocumentVersionId;
    readonly organizationId: OrgId;
  }): Promise<{
    readonly documentId: DocumentId;
    readonly patientId: PatientId | null;
    readonly patientFacing: boolean;
    /** F-197 (#248) — §7.16, `document.metadata.sudRedacted`. Read off this same row rather than a
     *  separately-injected `isSudVersion` lookup function (the portal mint's PRIOR shape) — that function
     *  had no real implementation anywhere and was never actually passed at the one production call site;
     *  reading it here, off data already being loaded, needs no new injection point at all. */
    readonly isSudClass: boolean;
    /** F-225 (#248) — the document lifecycle status; a portal mint only targets a live (non-superseded,
     *  non-destroyed) document. */
    readonly status: DocumentDigest["status"];
    /** F-225 (#248) — the version's REAL (opaque, PHI-free) object key: the URL must presign the stored
     *  bytes, not an invented path (the prior `portal/<versionId>` key named no object). */
    readonly objectKey: string;
  } | null>;

  /** §4.3 IntakeMetricsProvider — the intake-throughput counts for an org over a window. */
  intakeMetrics(args: {
    readonly organizationId: OrgId;
    readonly from: IsoInstant;
    readonly to: IsoInstant;
  }): Promise<IntakeMetrics>;

  /** §4.3 ExtractionProvenanceReader — the provenance records for one chart-target aggregate. */
  provenanceForTargetAggregate(args: {
    readonly targetModule: ChartTargetModule;
    readonly targetAggregateId: string;
    readonly organizationId: OrgId;
  }): Promise<ReadonlyArray<ProvenanceRecord>>;
}

// ── in-memory slice ───────────────────────────────────────────────────────────────────────────────────

/** Deterministic, I/O-free seed for the in-memory {@link DocumentReaderStore} (slice + seam tests). */
export interface DocumentReaderSeed {
  /** The rendered documents per source aggregate (RenderedDocumentProvider). */
  readonly rendered?: readonly (RenderedAggregateRow & {
    readonly aggregateType: DocumentAggregateType;
    readonly aggregateId: string;
    readonly organizationId: OrgId;
  })[];
  /** The full document digests (DocumentReader / PortalDocumentReader project these). */
  readonly documents?: readonly DocumentDigest[];
  /** The portal `consentByPatient` map — true when SUD-class portal content is consented (per-patient). */
  readonly sudConsentByPatient?: Readonly<Record<string, boolean>>;
  /** The intake-throughput counts per org. */
  readonly intakeMetrics?: readonly IntakeMetrics[];
  /** The provenance records (ExtractionProvenanceReader). */
  readonly provenance?: readonly ProvenanceRecord[];
}

/** Compare two digests by (createdAt desc, documentId desc) — the keyset order the cursor pages over. */
function digestAfterCursor(d: DocumentDigest, cursor: string): boolean {
  // cursor = `${createdAt}|${documentId}` of the last row of the prior page; return rows strictly older.
  const [cAt, cId] = cursor.split("|");
  if (d.createdAt < (cAt ?? "")) return true;
  if (d.createdAt > (cAt ?? "")) return false;
  return d.documentId < (cId ?? "");
}

/** An in-memory {@link DocumentReaderStore} for the slice/tests — no DB, deterministic, RLS-free. */
export function createInMemoryDocumentReaderStore(seed: DocumentReaderSeed = {}): {
  store: DocumentReaderStore;
} {
  const rendered = [...(seed.rendered ?? [])];
  const documents = [...(seed.documents ?? [])];
  // `consent` is read by the PortalDocumentReader impl through the dedicated consent port (below), not here.
  const consent = seed.sudConsentByPatient ?? {};
  void consent;
  const metrics = [...(seed.intakeMetrics ?? [])];
  const provenance = [...(seed.provenance ?? [])];

  const sortedForPatient = (
    patientId: PatientId,
    organizationId: OrgId,
    aggregateType?: DocumentAggregateType,
  ) =>
    documents
      .filter(
        (d) =>
          d.patientId === patientId &&
          d.organizationId === organizationId &&
          (aggregateType === undefined || d.aggregateType === aggregateType),
      )
      // (createdAt desc, documentId desc) — newest first, stable on ties.
      .sort((a, b) =>
        a.createdAt === b.createdAt
          ? b.documentId.localeCompare(a.documentId)
          : b.createdAt.localeCompare(a.createdAt),
      );

  return {
    store: {
      async renderedDocumentForAggregate({ aggregateType, aggregateId, organizationId }) {
        const r = rendered.find(
          (x) =>
            x.aggregateType === aggregateType &&
            x.aggregateId === aggregateId &&
            x.organizationId === organizationId,
        );
        return r
          ? { documentId: r.documentId, versionId: r.versionId, renderedAt: r.renderedAt }
          : null;
      },
      async documentsForPatient({ patientId, organizationId, aggregateType, sinceCursor, limit }) {
        let rows = sortedForPatient(patientId, organizationId, aggregateType);
        if (sinceCursor) rows = rows.filter((d) => digestAfterCursor(d, sinceCursor));
        return rows.slice(0, limit);
      },
      async documentMetadata({ documentId, organizationId }) {
        return (
          documents.find(
            (d) => d.documentId === documentId && d.organizationId === organizationId,
          ) ?? null
        );
      },
      async linkSummaryForDocument({ documentId, organizationId }) {
        const d = documents.find(
          (x) => x.documentId === documentId && x.organizationId === organizationId,
        );
        return d
          ? {
              documentId: d.documentId,
              patientId: d.patientId,
              status: d.status,
              createdAt: d.createdAt,
            }
          : null;
      },
      async activeVersionLink({ documentId, documentVersionId, organizationId }) {
        const d = documents.find(
          (x) =>
            x.documentId === documentId &&
            x.organizationId === organizationId &&
            x.activeVersionId === documentVersionId,
        );
        return d
          ? {
              documentId: d.documentId,
              documentVersionId,
              patientId: d.patientId,
              admissionId: d.admissionId,
            }
          : null;
      },
      async activeVersionForDocument({ documentVersionId, organizationId }) {
        const d = documents.find(
          (x) => x.activeVersionId === documentVersionId && x.organizationId === organizationId,
        );
        return d
          ? {
              documentId: d.documentId,
              patientId: d.patientId,
              patientFacing: d.patientFacing,
              // F-197 (#248) — the seed's own `retentionClass` is the SUD signal here (no separate
              // metadata field on `DocumentDigest`); a test seeds `compliance_42cfr_part2` to simulate one.
              isSudClass: d.retentionClass === "compliance_42cfr_part2",
              status: d.status,
              objectKey: `rendered/${documentVersionId}.pdf`,
            }
          : null;
      },
      async intakeMetrics({ organizationId }) {
        return (
          metrics.find((m) => m.organizationId === organizationId) ?? {
            organizationId,
            bundlesProcessed: 0,
            bundlesInReview: 0,
            avgTimeToReviewMinutes: 0,
            candidatesApproved: 0,
            candidatesRejected: 0,
          }
        );
      },
      async provenanceForTargetAggregate({ targetModule, targetAggregateId, organizationId }) {
        void organizationId; // RLS-enforced in prod; the slice's provenance rows are already tenant-scoped by seed
        return provenance.filter(
          (p) => p.targetModule === targetModule && p.targetAggregateId === targetAggregateId,
        );
      },
    },
  };
}

/**
 * F-225 (#248) — the append-only `document_access_log` writer the portal mint appends its §164.528 row
 * through. M22 owns the table; the Drizzle adapter (`./drizzle-access-log-store.ts`) inserts under the
 * tenant's RLS context, the in-memory one records for the slice/tests. Ids only — no PHI, no free text.
 */
export interface PortalAccessLogEntry {
  readonly organizationId: OrgId;
  readonly documentId: DocumentId;
  readonly documentVersionId: DocumentVersionId;
  readonly patientId: PatientId;
  readonly portalAccountId: string;
  readonly portalSessionId: string;
  readonly correlationId: string;
  readonly accessedAt: IsoInstant;
}
export interface PortalAccessLogPort {
  /** Append ONE row (access_kind 'portal_view', purpose 'patient_access'). Throws on failure — the caller
   *  must not release the URL when this rejects. */
  appendPortalDownload(entry: PortalAccessLogEntry): Promise<void>;
}

/** An in-memory {@link PortalAccessLogPort}; `rows` is exposed for assertions. */
export function createInMemoryPortalAccessLog(): PortalAccessLogPort & {
  readonly rows: PortalAccessLogEntry[];
} {
  const rows: PortalAccessLogEntry[] = [];
  return {
    rows,
    async appendPortalDownload(entry) {
      rows.push(entry);
    },
  };
}

/**
 * The per-patient SUD-portal-consent gate the {@link PortalDocumentReader} consults before exposing SUD-class
 * content or minting a download URL (§4.3 — "filters SUD content per consent"). In prod this resolves through
 * M39's ConsentEvaluator seam; the slice models it as a pure map so the portal reader is testable with no M39.
 *
 * F-197 (#248) — ASYNC, and takes `organizationId`: originally synchronous and org-implicit, which made a
 * real M39-backed implementation impossible to wire at all (the doc comment above always said "in prod this
 * resolves through M39's ConsentEvaluator seam," but no real implementation, and no production call site
 * passing one, ever existed — confirmed by a full repo grep before this fix). Widened to match
 * `resolveSudConsentPresent`'s own (org-scoped, async) shape exactly, since that is the real seam call this
 * port now delegates to in production (see {@link createSudConsentEvaluatorPortalConsentPort} below).
 */
export interface PortalConsentPort {
  /** Is SUD-class portal disclosure consented for this patient right now? */
  isSudPortalDisclosureConsented(patientId: PatientId, organizationId: OrgId): Promise<boolean>;
}

/** An in-memory {@link PortalConsentPort} from a per-patient consent map (default: not consented). */
export function createInMemoryPortalConsentPort(
  consentByPatient: Readonly<Record<string, boolean>> = {},
): PortalConsentPort {
  return {
    async isSudPortalDisclosureConsented(patientId: PatientId): Promise<boolean> {
      return consentByPatient[patientId] === true;
    },
  };
}

/**
 * F-197 (#248) — the REAL {@link PortalConsentPort}: delegates to M39's `ConsentEvaluator` via
 * `resolveSudConsentPresent` (`../outbox-consumers/consent-gate`), the SAME fail-closed seam call the
 * render-time gate and the F-197 mint-time staff-path gate both already use — one consent check, three
 * call sites, never three re-implementations of the M39 seam call. Import is safe: `consent-gate.ts`
 * depends only on the M1 `getSeam` bootstrap registry, no cycle back through `seams/`.
 */
export function createSudConsentEvaluatorPortalConsentPort(): PortalConsentPort {
  return {
    isSudPortalDisclosureConsented(patientId: PatientId, organizationId: OrgId): Promise<boolean> {
      return resolveSudConsentPresent({ organizationId, patientId });
    },
  };
}
