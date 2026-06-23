// apps/backend/src/modules/22-documents/seams/readers.ts — M22-T05 the §4.3 published reader-seam implementations.
//
// Five leaf-typed READ surfaces (@wardenx/types) downstream modules resolve through the M1 registry instead of
// importing M22's schema (architecture §25.15 blocks the schema import). Each is pure orchestration over an injected
// {@link DocumentSeamReadStore}: it projects store rows to the §4.3 read DTOs and adds NO tenant logic — RLS scopes
// every read by the consumer's `app.org_id` (§3.6). Mirrors the M9..M18 read-seam provider precedents.
//
//   • RenderedDocumentProvider — the §7.2 W2 back-ref (aggregate → {documentId, versionId, renderedAt}); every
//     source module's `m22-document-backref` path consumes it to stamp `document_id` on its own row.
//   • DocumentReader — document-metadata reads M28 (FHIR DocumentReference), M31 (portal list), M33 (reporting) use.
//   • PortalDocumentReader — the M31 portal read (Phase 2): internal-only tags stripped + a consent- and
//     ownership-checked download URL. The SUD consent gate is wired in M22-T06 (consume M39's `ConsentEvaluator`);
//     this slice enforces the structural gates (`not_owner` / `not_patient_facing`) the mint path always applies.
//   • IntakeMetricsProvider — the org-level intake-pipeline throughput aggregate M33/M30 read.
//   • ExtractionProvenanceReader — the per-chart-field provenance M28 (FHIR Provenance) + M30 (HQRP) read.
import type {
  ChartTargetModule,
  DocumentReader,
  ExtractionProvenanceReader,
  IntakeMetricsProvider,
  OrgScope,
  PortalDocumentReader,
  RenderedDocumentProvider,
} from "@wardenx/types";
import type { DocumentSeamReadStore } from "./read-store";

/** The §1.3 presign port the portal reader mints a download URL through (the storage provider's presign in prod). */
export interface PortalPresignPort {
  presignDownload(args: {
    scope: OrgScope;
    tenantId: string;
    downloadFilename: string;
    ttlSeconds: number;
  }): Promise<{ url: string; expiresAt: string }>;
}

/** The portal download-URL TTL floor (§1.3 ≤60min platform-floor; M22-T07 binds the real MinIO presign). */
const PORTAL_DOWNLOAD_TTL_SECONDS = 15 * 60;

/**
 * The §2.31 / 42 CFR Part 2 SUD-consent gate the portal reader checks before minting a download URL for a
 * SUD-class version (M22-T06). A NARROW structural port — M22 consumes M39's `ConsentEvaluator` through it
 * (the composition root adapts the real evaluator, resolved lazily at call time; M22's manifest `dependsOn` is
 * `[1, 5]`, so M22 code never imports `@wardenx/consent`). When no gate is injected (the M22-T05 slice default)
 * the portal reader fails CLOSED for SUD content (`sud_consent_absent`), exactly as before T06.
 */
export interface PortalSudConsentGate {
  /** True when the patient's active 42 CFR Part 2 consent permits portal disclosure of SUD-class content. */
  evaluateSudPortalAccess(args: {
    organizationId: string;
    patientId: string;
    portalSessionId: string;
  }): Promise<boolean>;
}

/** §4.3 RenderedDocumentProvider over the read store (the W2 back-ref read). Pure projection; RLS pins the tenant. */
export function createRenderedDocumentProvider(store: DocumentSeamReadStore): RenderedDocumentProvider {
  return {
    async getRenderedDocumentForAggregate({ aggregateType, aggregateId, organizationId }) {
      return store.renderedForAggregate({ organizationId, aggregateType, aggregateId });
    },
  };
}

/** §4.3 DocumentReader over the read store (document-metadata reads; cursor-paginated by document id). */
export function createDocumentReader(store: DocumentSeamReadStore): DocumentReader {
  return {
    async documentsForPatient({ patientId, organizationId, aggregateType, sinceCursor, limit }) {
      return store.documentsForPatient({ organizationId, patientId, aggregateType, sinceCursor, limit });
    },
    async documentMetadata({ documentId, organizationId }) {
      return store.documentMetadata({ organizationId, documentId });
    },
  };
}

/**
 * §4.3 PortalDocumentReader over the read store (M31 portal, Phase 2). The list strips non-patient-facing documents
 * (the store filter). `mintPortalDownloadUrl` enforces the structural gates the mint path ALWAYS applies — the
 * version must exist, belong to the requesting patient (`not_owner`), and be patient-facing (`not_patient_facing`)
 * — then mints a short-lived URL over the §7.10 D11 opaque, PHI-free leaf. The SUD-consent gate (`sud_consent_absent`)
 * is wired in M22-T06 when M39's `ConsentEvaluator` is consumed; until then a SUD-class version denies for consent.
 */
export function createPortalDocumentReader(
  store: DocumentSeamReadStore,
  presign: PortalPresignPort,
  consentGate?: PortalSudConsentGate,
): PortalDocumentReader {
  return {
    async documentsForPatient({ patientId, organizationId, aggregateType, sinceCursor }) {
      return store.portalDocumentsForPatient({ organizationId, patientId, aggregateType, sinceCursor });
    },
    async mintPortalDownloadUrl({ documentVersionId, portalSessionId, patientId, organizationId }) {
      const row = store.portalVersion({ organizationId, documentVersionId });
      if (!row || row.patientId !== patientId) return { denied: true, reason: "not_owner" } as const;
      if (!row.patientFacing) return { denied: true, reason: "not_patient_facing" } as const;
      // SUD content requires an explicit §2.31 / 42 CFR Part 2 consent. M22-T06 consumes M39's REAL
      // `ConsentEvaluator` through the injected {@link PortalSudConsentGate}: a SUD-class version mints only when
      // the evaluator allows it. With no gate wired (the slice default) we fail CLOSED rather than presign it.
      if (row.sudClass) {
        const allowed = consentGate
          ? await consentGate.evaluateSudPortalAccess({ organizationId, patientId, portalSessionId })
          : false;
        if (!allowed) return { denied: true, reason: "sud_consent_absent" } as const;
      }
      const { url, expiresAt } = await presign.presignDownload({
        scope: { orgId: organizationId },
        tenantId: organizationId,
        downloadFilename: row.downloadFilename,
        ttlSeconds: PORTAL_DOWNLOAD_TTL_SECONDS,
      });
      return { url, expiresAt };
    },
  };
}

/** §4.3 IntakeMetricsProvider over the read store (the org-level intake throughput aggregate). */
export function createIntakeMetricsProvider(store: DocumentSeamReadStore): IntakeMetricsProvider {
  return {
    async metricsForOrg({ organizationId, from, to }) {
      return store.intakeMetrics({ organizationId, from, to });
    },
  };
}

/** §4.3 ExtractionProvenanceReader over the read store (per-chart-field provenance for a write-back target). */
export function createExtractionProvenanceReader(store: DocumentSeamReadStore): ExtractionProvenanceReader {
  return {
    async provenanceForTargetAggregate({ targetModule, targetAggregateId, organizationId }) {
      return store.provenanceForTarget({
        organizationId,
        targetModule: targetModule as ChartTargetModule,
        targetAggregateId,
      });
    },
  };
}

/** A deterministic, clock-free presign port for the slice/tests (no patient identifier — only tenant + D11 leaf). */
export const inMemoryPortalPresign: PortalPresignPort = {
  async presignDownload({ tenantId, downloadFilename, ttlSeconds }) {
    return {
      url: `memory://tenant-${tenantId}/portal/${downloadFilename}?ttl=${ttlSeconds}`,
      expiresAt: `+${ttlSeconds}s`,
    };
  },
};
