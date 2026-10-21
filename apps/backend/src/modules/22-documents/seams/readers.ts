import { getRequestContext } from "@chartwarden/tenancy";
// apps/backend/src/modules/22-documents/seams/readers.ts — M22-T05 the five §4.3 PUBLISHED reader seam impls:
// pure orchestration over an injected {@link DocumentReaderStore} (+ the object-store + consent ports for the
// portal mint). Each returns the leaf-typed seam interface (@chartwarden/types) the M1 registry validates and the
// downstream module resolves. The readers add NO tenant logic — RLS scopes every store read by the consumer's
// `app.org_id` (§4.3). All five are READ-only — M22 owns the document lifecycle internally and never mutates
// through a published seam. Mirrors the M17 read-seam provider precedent (one store, many readers).
//
//   • RenderedDocumentProvider — every source module's `m22-document-backref` consumer resolves the rendered
//     document for its aggregate after the W2 render handshake.
//   • DocumentReader            — M28 (FHIR DocumentReference), M31 (portal list), M33 (reporting).
//   • PortalDocumentReader      — M31 portal; strips internal-only tags (the PortalDocumentDigest projection is
//     already tag-free by construction) + filters SUD content per consent + mints a TTL-capped download URL.
//   • IntakeMetricsProvider     — M33 reporting + M30 quality measures (intake throughput, time-to-review).
//   • ExtractionProvenanceReader— M28 (FHIR Provenance) + M30 (HQRP AI-governance): per-chart-field provenance
//     (the rows EXIST even though DocLens is OFF — provenance is written at extraction-commit time, not render).
import type {
  DocumentReader,
  ExtractionProvenanceReader,
  IntakeMetricsProvider,
  PortalDocumentDigest,
  PortalDocumentReader,
  RenderedDocumentProvider,
} from "@chartwarden/types";
import { deriveTenantBucket } from "../lifecycle/storage";
import type { DocumentReaderStore, PortalAccessLogPort, PortalConsentPort } from "./readers-store";
import type { ObjectStorePort } from "./store";

/** The §4.5 default cap for portal documents to page in one call (keyset-paged via `sinceCursor`). */
const DEFAULT_PATIENT_DOC_LIMIT = 50;

/** §11 D11 — the portal download URL TTL cap (60 min; the portal mint never exceeds this, §5.1/§4.3). */
const PORTAL_URL_TTL_SECONDS = 60 * 60;

/**
 * §4.3 RenderedDocumentProvider over the store — resolves the rendered document for one source aggregate.
 * Pure projection; RLS pins the tenant. Used by every source module's `m22-document-backref` consumer.
 */
export function createRenderedDocumentProvider(
  store: DocumentReaderStore,
): RenderedDocumentProvider {
  return {
    async getRenderedDocumentForAggregate({ aggregateType, aggregateId, organizationId }) {
      return store.renderedDocumentForAggregate({ aggregateType, aggregateId, organizationId });
    },
  };
}

/**
 * §4.3 DocumentReader over the store — the patient document-digest list (keyset-paged) + the by-id metadata
 * read. M28 (FHIR DocumentReference), M31 (portal list), M33 (reporting) consume. Pure projection; RLS pins
 * the tenant. The digests carry NO byte payload — the bytes are reached via a separately-audited signed URL.
 */
export function createDocumentReader(store: DocumentReaderStore): DocumentReader {
  return {
    async documentsForPatient({ patientId, organizationId, aggregateType, sinceCursor, limit }) {
      return store.documentsForPatient({
        patientId,
        organizationId,
        aggregateType,
        sinceCursor,
        limit: limit ?? DEFAULT_PATIENT_DOC_LIMIT,
      });
    },
    async documentMetadata({ documentId, organizationId }) {
      return store.documentMetadata({ documentId, organizationId });
    },
    async linkSummary(organizationId, id) {
      // Fail closed: no tenant or no id means no answer, never a guessed one.
      if (!organizationId?.trim()) throw new Error("linkSummary: organizationId required");
      if (!id?.trim()) throw new Error("linkSummary: id required");
      const row = await store.linkSummaryForDocument({ documentId: id, organizationId });
      // A destroyed or legal-hold document is withheld like a missing one: its lifecycle state is itself sensitive and a
      // destroyed record must not be linkable. `active` and `superseded` (still a real, readable record) resolve.
      if (!row || row.status === "destroyed_tombstone" || row.status === "legal_hold") return null;
      return {
        id: row.documentId,
        patientId: row.patientId,
        status: row.status,
        occurredAt: row.createdAt,
      };
    },
    async activeVersionLink({ documentId, documentVersionId, organizationId }) {
      return store.activeVersionLink({ documentId, documentVersionId, organizationId });
    },
  };
}

/**
 * §4.3 PortalDocumentReader over the store + the object-store + consent ports. M31 portal consumes it. The
 * {@link PortalDocumentDigest} projection is already internal-tag-free by construction; this reader additionally
 * FILTERS the list to patient-facing documents and refuses (or filters) SUD content when consent is absent.
 * `mintPortalDownloadUrl` enforces three gates before presigning: the version must belong to a patient-facing
 * document, the requested patient must own it, and (when SUD-class) portal disclosure must be consented — else
 * it returns the typed `{ denied, reason }` shape (never throws, never leaks which gate to a portal session).
 */
export function createPortalDocumentReader(deps: {
  readonly store: DocumentReaderStore;
  readonly objects: ObjectStorePort;
  readonly consent: PortalConsentPort;
  /** F-225 (#248) — the §164.528 `document_access_log` appender; REQUIRED so a mint can never skip the ledger. */
  readonly accessLog: PortalAccessLogPort;
  /** Injectable clock (tests). */
  readonly now?: () => Date;
}): PortalDocumentReader {
  const now = deps.now ?? (() => new Date());
  return {
    async resolvePortalDocumentVersion({ documentId, patientId, organizationId }) {
      // F-225 — the governed version a portal session may download = the document's ACTIVE version, only
      // for the session patient's own, patient-facing, live document. Every failure is the same `null`.
      const d = await deps.store.documentMetadata({ documentId, organizationId });
      if (
        d === null ||
        d.organizationId !== organizationId ||
        d.patientId !== patientId ||
        !d.patientFacing ||
        d.activeVersionId === null ||
        d.status === "superseded" ||
        d.status === "destroyed_tombstone"
      ) {
        return null;
      }
      return { documentVersionId: d.activeVersionId };
    },
    async documentsForPatient({ patientId, organizationId, aggregateType, sinceCursor }) {
      const digests = await deps.store.documentsForPatient({
        patientId,
        organizationId,
        aggregateType,
        sinceCursor,
        limit: DEFAULT_PATIENT_DOC_LIMIT,
      });
      // Portal only ever sees patient-facing documents (information-blocking-free per §1.1; no "hold for
      // review" pattern). Project the full digest down to the portal-safe shape (internal tags never present).
      return digests
        .filter((d) => d.patientFacing && d.activeVersionId !== null)
        .map(
          (d): PortalDocumentDigest => ({
            documentId: d.documentId,
            aggregateType: d.aggregateType,
            title: d.title,
            activeVersionId: d.activeVersionId,
            createdAt: d.createdAt,
          }),
        );
    },
    async mintPortalDownloadUrl({
      documentVersionId,
      portalSessionId,
      portalAccountId,
      patientId,
      organizationId,
    }) {
      const owner = await deps.store.activeVersionForDocument({
        documentVersionId,
        organizationId,
      });
      if (owner === null || owner.patientId !== patientId) {
        return { denied: true, reason: "not_owner" } as const;
      }
      if (!owner.patientFacing) {
        return { denied: true, reason: "not_patient_facing" } as const;
      }
      if (owner.status === "superseded" || owner.status === "destroyed_tombstone") {
        return { denied: true, reason: "not_active" } as const;
      }
      // F-197 (#248) — `owner.isSudClass` (D20/D23, `document.metadata.sudRedacted`) replaces the PRIOR
      // `isSudVersion` deps-injected lookup function, which had no real implementation anywhere and was
      // never actually passed at the one production call site (`seams/index.ts`'s
      // `createPortalDocumentReader` call) — this SUD-class fact is already loaded on `owner` above, off
      // the exact same row, so no separate injection point is needed at all.
      if (
        owner.isSudClass &&
        !(await deps.consent.isSudPortalDisclosureConsented(patientId, organizationId))
      ) {
        return { denied: true, reason: "sud_consent_absent" } as const;
      }
      // The presigned URL is never logged. It targets the version's REAL stored object in the tenant bucket.
      const { url, expiresAt } = await deps.objects.presign({
        descriptor: {
          bucket: deriveTenantBucket(organizationId),
          objectKey: owner.objectKey,
          ttlSeconds: PORTAL_URL_TTL_SECONDS,
          accessKind: "portal_view",
        },
        organizationId,
      });
      // F-225 (#248) — the §164.528 disclosure-accounting append. It happens AFTER every gate passed and
      // the URL exists, and BEFORE the URL is returned: a failed append throws (no URL leaves un-logged); a
      // denial above returned early, so a refusal never writes a 'disclosed' row. If the process dies
      // between append and delivery the ledger over-reports by one row, never under-reports.
      await deps.accessLog.appendPortalDownload({
        organizationId,
        documentId: owner.documentId,
        documentVersionId,
        patientId,
        portalAccountId,
        portalSessionId,
        correlationId: getRequestContext()?.correlationId ?? `portal-mint:${portalSessionId}`,
        accessedAt: now().toISOString(),
      });
      return { url, expiresAt };
    },
  };
}

/**
 * §4.3 IntakeMetricsProvider over the store — the intake-throughput counts for an org over a window. M33
 * reporting + M30 quality measures consume. Pure projection; RLS pins the tenant.
 */
export function createIntakeMetricsProvider(store: DocumentReaderStore): IntakeMetricsProvider {
  return {
    async metricsForOrg({ organizationId, from, to }) {
      return store.intakeMetrics({ organizationId, from, to });
    },
  };
}

/**
 * §4.3 ExtractionProvenanceReader over the store — the per-chart-field provenance records for one chart-target
 * aggregate. M28 (FHIR Provenance) + M30 (HQRP AI-governance) consume. The rows EXIST even though DocLens is
 * OFF — provenance is written at extraction-commit time. Pure projection; RLS pins the tenant.
 */
export function createExtractionProvenanceReader(
  store: DocumentReaderStore,
): ExtractionProvenanceReader {
  return {
    async provenanceForTargetAggregate({ targetModule, targetAggregateId, organizationId }) {
      return store.provenanceForTargetAggregate({
        targetModule,
        targetAggregateId,
        organizationId,
      });
    },
  };
}
