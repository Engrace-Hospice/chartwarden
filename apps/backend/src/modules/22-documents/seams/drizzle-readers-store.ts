// apps/backend/src/modules/22-documents/seams/drizzle-readers-store.ts — the Drizzle-backed
// {@link DocumentReaderStore} + the REFUSING {@link ObjectStorePort} (TASK-002, ARCH-003).
//
// Until this file, the composition root registered all five §4.3 reader seams over an unseeded
// in-memory Map on a db boot — M28's DocumentReference projection, M31's portal document list, M33's
// intake dashboards and every source module's render back-ref read "no documents" about a database
// they never touched.
//
// THE OBJECT STORE REFUSES, DELIBERATELY. There is no production `SignedUrlStoragePort`/MinIO
// adapter in src/ yet; the previous binding was a per-process Map, which meant a "rendered" PDF's
// bytes lived nowhere and a presigned URL pointed at memory. Per the audit's TASK-002 risk note the
// honest binding is a typed refusal (DegradedError) — a render/presign/destroy FAILS LOUDLY until
// the real adapter lands, and no caller can mistake a Map write for durable storage.
//
// TENANCY: reads open the CONSUMER's ambient request context via `withOrgContextFromRequest` (the
// M21 precedent); the `organizationId` the port carries is ASSERTED via the explicit predicate as
// the second wall, never used to switch tenants.
import { type DbClient, schema } from "@wardenx/db";
import { withOrgContextFromRequest } from "@wardenx/tenancy";
import { DegradedError } from "@wardenx/types";
import type { DocumentDigest, IntakeMetrics, ProvenanceRecord } from "@wardenx/types";
import { and, desc, eq, gte, inArray, lt, or, sql } from "drizzle-orm";
import type { DocumentReaderStore } from "./readers-store";
import type { ObjectStorePort } from "./store";

const DOC = schema.documents;
const DV = schema.documentVersions;
const BATCH = schema.intakeUploadBatches;
const ER = schema.extractionReviews;
const ED = schema.extractionDecisions;
const PROV = schema.extractionProvenance;

type SeamTx = Parameters<Parameters<DbClient["transaction"]>[0]>[0];

const DIGEST_COLUMNS = {
  documentId: DOC.id,
  organizationId: DOC.organizationId,
  patientId: DOC.patientId,
  admissionId: DOC.admissionId,
  aggregateType: DOC.aggregateType,
  aggregateId: DOC.aggregateId,
  title: DOC.title,
  retentionClass: DOC.retentionClass,
  status: DOC.status,
  patientFacing: DOC.patientFacing,
  activeVersionId: DOC.activeVersionId,
  createdAt: DOC.createdAt,
  updatedAt: DOC.updatedAt,
} as const;

type DigestRow = {
  documentId: string;
  organizationId: string;
  patientId: string | null;
  admissionId: string | null;
  aggregateType: string;
  aggregateId: string | null;
  title: string;
  retentionClass: string;
  status: string;
  patientFacing: boolean;
  activeVersionId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

const toDigest = (r: DigestRow): DocumentDigest => ({
  documentId: r.documentId,
  organizationId: r.organizationId,
  patientId: r.patientId,
  admissionId: r.admissionId,
  aggregateType: r.aggregateType as DocumentDigest["aggregateType"],
  aggregateId: r.aggregateId,
  title: r.title,
  retentionClass: r.retentionClass as DocumentDigest["retentionClass"],
  status: r.status as DocumentDigest["status"],
  patientFacing: r.patientFacing,
  activeVersionId: r.activeVersionId,
  createdAt: r.createdAt.toISOString(),
  updatedAt: r.updatedAt.toISOString(),
});

/** Build the Drizzle {@link DocumentReaderStore} over document / version / intake / provenance rows. */
export function createDrizzleDocumentReaderStore(db: DbClient): DocumentReaderStore {
  return {
    async renderedDocumentForAggregate(args) {
      return withOrgContextFromRequest(db, async (tx: SeamTx) => {
        const rows = await tx
          .select({
            documentId: DOC.id,
            activeVersionId: DOC.activeVersionId,
          })
          .from(DOC)
          .where(
            and(
              eq(DOC.organizationId, args.organizationId),
              eq(DOC.aggregateType, args.aggregateType as typeof DOC.$inferSelect.aggregateType),
              eq(DOC.aggregateId, args.aggregateId),
              eq(DOC.status, "active"),
            ),
          )
          .orderBy(desc(DOC.updatedAt))
          .limit(1);
        const doc = rows[0];
        if (!doc || doc.activeVersionId === null) return null;
        const versions = await tx
          .select({ id: DV.id, createdAt: DV.createdAt })
          .from(DV)
          .where(eq(DV.id, doc.activeVersionId))
          .limit(1);
        if (!versions[0]) return null;
        return {
          documentId: doc.documentId,
          versionId: versions[0].id,
          renderedAt: versions[0].createdAt.toISOString(),
        };
      });
    },

    async documentsForPatient(args) {
      return withOrgContextFromRequest(db, async (tx: SeamTx) => {
        // Keyset pagination on (createdAt, documentId) desc — the cursor is `createdAtIso|documentId`
        // of the last row of the previous page (the readers-store contract).
        const cursorClauses = [];
        if (args.sinceCursor) {
          const [createdAtIso, documentId] = args.sinceCursor.split("|");
          if (createdAtIso && documentId) {
            const cursorAt = new Date(createdAtIso);
            cursorClauses.push(
              or(
                lt(DOC.createdAt, cursorAt),
                and(eq(DOC.createdAt, cursorAt), lt(DOC.id, documentId)),
              ),
            );
          }
        }
        const rows = await tx
          .select(DIGEST_COLUMNS)
          .from(DOC)
          .where(
            and(
              eq(DOC.organizationId, args.organizationId),
              eq(DOC.patientId, args.patientId),
              ...(args.aggregateType
                ? [
                    eq(
                      DOC.aggregateType,
                      args.aggregateType as typeof DOC.$inferSelect.aggregateType,
                    ),
                  ]
                : []),
              ...cursorClauses,
            ),
          )
          .orderBy(desc(DOC.createdAt), desc(DOC.id))
          .limit(args.limit);
        return rows.map(toDigest);
      });
    },

    async documentMetadata(args) {
      return withOrgContextFromRequest(db, async (tx: SeamTx) => {
        const rows = await tx
          .select(DIGEST_COLUMNS)
          .from(DOC)
          .where(and(eq(DOC.organizationId, args.organizationId), eq(DOC.id, args.documentId)))
          .limit(1);
        return rows[0] ? toDigest(rows[0]) : null;
      });
    },

    async activeVersionForDocument(args) {
      return withOrgContextFromRequest(db, async (tx: SeamTx) => {
        const rows = await tx
          .select({
            documentId: DV.documentId,
            patientId: DOC.patientId,
            patientFacing: DOC.patientFacing,
            activeVersionId: DOC.activeVersionId,
          })
          .from(DV)
          .innerJoin(DOC, eq(DOC.id, DV.documentId))
          .where(and(eq(DV.organizationId, args.organizationId), eq(DV.id, args.documentVersionId)))
          .limit(1);
        const row = rows[0];
        // The mint targets the ACTIVE version only — a superseded version resolves to nothing.
        if (!row || row.activeVersionId !== args.documentVersionId) return null;
        return {
          documentId: row.documentId,
          patientId: row.patientId,
          patientFacing: row.patientFacing,
        };
      });
    },

    async intakeMetrics(args) {
      return withOrgContextFromRequest(db, async (tx: SeamTx) => {
        const from = new Date(args.from);
        const to = new Date(args.to);
        const [batchRow] = await tx
          .select({
            processed: sql<number>`count(*) filter (where ${BATCH.status} = 'writeback_complete')::int`,
            inReview: sql<number>`count(*) filter (where ${BATCH.status} in ('extraction_complete','in_review'))::int`,
            avgReviewMinutes: sql<number>`coalesce(avg(extract(epoch from (${BATCH.dispositionAt} - ${BATCH.uploadedAt})) / 60.0) filter (where ${BATCH.dispositionAt} is not null), 0)`,
          })
          .from(BATCH)
          .where(
            and(
              eq(BATCH.organizationId, args.organizationId),
              gte(BATCH.uploadedAt, from),
              lt(BATCH.uploadedAt, to),
            ),
          );
        const [decisionRow] = await tx
          .select({
            approved: sql<number>`count(*) filter (where ${ED.decision} in ('approve','approve_with_edit'))::int`,
            rejected: sql<number>`count(*) filter (where ${ED.decision} = 'reject')::int`,
          })
          .from(ED)
          .where(
            and(
              eq(ED.organizationId, args.organizationId),
              gte(ED.decidedAt, from),
              lt(ED.decidedAt, to),
            ),
          );
        const metrics: IntakeMetrics = {
          organizationId: args.organizationId,
          bundlesProcessed: Number(batchRow?.processed) || 0,
          bundlesInReview: Number(batchRow?.inReview) || 0,
          avgTimeToReviewMinutes: Number(batchRow?.avgReviewMinutes) || 0,
          candidatesApproved: Number(decisionRow?.approved) || 0,
          candidatesRejected: Number(decisionRow?.rejected) || 0,
        };
        return metrics;
      });
    },

    async provenanceForTargetAggregate(args) {
      return withOrgContextFromRequest(db, async (tx: SeamTx) => {
        const rows = await tx
          .select({
            provenanceId: PROV.id,
            extractionDecisionId: PROV.extractionDecisionId,
            extractionCandidateId: PROV.extractionCandidateId,
            sourceDocumentId: PROV.sourceDocumentId,
            sourceDocumentVersionId: PROV.sourceDocumentVersionId,
            sourcePage: PROV.sourcePage,
            targetModule: PROV.targetModule,
            targetFieldPath: PROV.targetFieldPath,
            targetAggregateId: PROV.targetAggregateId,
            classifierModelVersionRef: PROV.classifierModelVersionRef,
            extractorModelVersionRef: PROV.extractorModelVersionRef,
            visionVerifierModelVersionRef: PROV.visionVerifierModelVersionRef,
            committedAt: PROV.committedAt,
          })
          .from(PROV)
          .where(
            and(
              eq(PROV.organizationId, args.organizationId),
              eq(PROV.targetModule, args.targetModule as typeof PROV.$inferSelect.targetModule),
              eq(PROV.targetAggregateId, args.targetAggregateId),
            ),
          );
        return rows.map(
          (r): ProvenanceRecord => ({
            provenanceId: r.provenanceId,
            extractionDecisionId: r.extractionDecisionId,
            extractionCandidateId: r.extractionCandidateId,
            sourceDocumentId: r.sourceDocumentId,
            sourceDocumentVersionId: r.sourceDocumentVersionId,
            sourcePage: r.sourcePage,
            targetModule: r.targetModule as ProvenanceRecord["targetModule"],
            targetFieldPath: r.targetFieldPath,
            targetAggregateId: r.targetAggregateId,
            classifierModelVersionRef: r.classifierModelVersionRef,
            extractorModelVersionRef: r.extractorModelVersionRef,
            visionVerifierModelVersionRef: r.visionVerifierModelVersionRef,
            committedAt: r.committedAt.toISOString(),
          }),
        );
      });
    },
  };
}

/**
 * The refusing {@link ObjectStorePort} for a db boot with no MinIO adapter: every operation throws
 * `DegradedError` naming the missing adapter. Never a Map — a caller must not mistake a per-process
 * write for durable storage (audit TASK-002 risk note).
 */
export function createRefusingObjectStore(): ObjectStorePort {
  const refuse = (op: string): never => {
    throw new DegradedError(
      "m22.object_store",
      `'${op}' refused — no production SignedUrlStoragePort/MinIO adapter is bound (TASK-002 risk note); binding a Map here would fake durable storage`,
    );
  };
  return {
    async putObject() {
      return refuse("putObject");
    },
    async presign() {
      return refuse("presign");
    },
    async destroyAllVersions() {
      refuse("destroyAllVersions");
    },
  };
}
