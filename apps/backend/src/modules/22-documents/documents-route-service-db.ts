// apps/backend/src/modules/22-documents — PRODUCTION Document backend, READ-first (M22L-T01).
//
// The screen-driving READS (document library + detail, version ledger, intake batch/classification/
// extraction-job/candidate/review surfaces, the platform form-template catalog + tenant overlays + form
// fills) run as real Drizzle queries over the M22-owned `documents/*` tables inside `withOrgContext`, so
// RLS scopes every row by `app.org_id` as the unprivileged `wardenx_app` role (`form_template` /
// `form_template_version` are NON_ORG_SCOPED platform reference — the dual-grant read-all RLS lets any
// tenant read them). The full WRITE lifecycle (upload/version/tag/patch, intake confirm/review/decision,
// template + overlay publish, render retry) is the M22L-T02+ follow-up; every write here fail-closes 501
// (`NOT_IMPLEMENTED`) so the interface is satisfied and the mount is real. The in-memory
// `createInMemoryDocumentBackend` (`routes/service.ts`) stays the behavioral reference for those writes.
//
// The signed-URL STORAGE PRESIGNER is deliberately NOT built here — the M22 storage adapter is unwired;
// the barrel (`index.ts`) binds the throwing `DegradedError` stub. This module supplies only the read
// resolvers (`abacResolver` over document owner-facts, `objectResolver` over version object-keys).
import { type DbClient, schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import { NotFoundError, type OrgId, WardenXError } from "@wardenx/types";
import { and, desc, eq, isNull } from "drizzle-orm";
import type { DocumentAbacFacts, DocumentAbacResolver } from "./abac-predicates";
import { type CursorPage, paginate } from "./routes/concurrency";
import type { DocumentRouteService, DocumentView, IntakeBatchView, VersionView } from "./routes/service";
import type { SignedUrlObjectFacts, SignedUrlObjectResolver } from "./routes/signed-url-service";

const DOC = schema.documents;
const DV = schema.documentVersions;
const BATCH = schema.intakeUploadBatches;
const CP = schema.classifiedPages;
const EJ = schema.extractionJobs;
const ER = schema.extractionReviews;
const ED = schema.extractionDecisions;
const EC = schema.extractionCandidates;
const FT = schema.formTemplates;
const FTV = schema.formTemplateVersions;
const FF = schema.formFills;
const OVL = schema.tenantTemplateOverlays;
const LH = schema.documentLegalHold;

/** A read-wire fetch cap for the in-memory `paginate` keyset slicer (TODO: push the cursor into SQL). */
const READ_WINDOW = 1000;

const iso = (v: Date | string): string => (v instanceof Date ? v.toISOString() : String(v));

/** A never-returning stub for the write lifecycle still owed by M22L-T02+. */
const notImpl = (): never => {
  throw new WardenXError(
    "NOT_IMPLEMENTED",
    "document writes arrive in M22L-T02+ (the Drizzle write lifecycle)",
    501,
  );
};

const withOrg = <T>(db: DbClient, organizationId: OrgId, fn: (tx: DbClient) => Promise<T>): Promise<T> =>
  withOrgContext(db, { organizationId, userId: "" }, (tx) => fn(tx as DbClient));

/**
 * The production, RLS-backed DocumentRouteService. Reads are real; writes fail-closed 501.
 * Org is bound from the request context by the caller and passed as `organizationId` — never the body.
 */
export function createDbDocumentRouteService(db: DbClient): DocumentRouteService {
  async function loadDocRow(tx: DbClient, organizationId: OrgId, documentId: string): Promise<DocumentView> {
    const [d] = await tx
      .select({
        id: DOC.id,
        organizationId: DOC.organizationId,
        patientId: DOC.patientId,
        admissionId: DOC.admissionId,
        retentionClass: DOC.retentionClass,
        aggregateType: DOC.aggregateType,
        title: DOC.title,
        patientFacing: DOC.patientFacing,
        attachToDisclosures: DOC.attachToDisclosures,
        status: DOC.status,
        createdAt: DOC.createdAt,
        updatedAt: DOC.updatedAt,
      })
      .from(DOC)
      .where(eq(DOC.id, documentId))
      .limit(1);
    if (!d) throw new NotFoundError("document");
    const vers = await tx.select({ id: DV.id }).from(DV).where(eq(DV.documentId, documentId));
    return {
      id: d.id,
      organizationId: d.organizationId,
      patientId: d.patientId,
      admissionId: d.admissionId,
      retentionClass: d.retentionClass,
      aggregateType: d.aggregateType,
      title: d.title,
      patientFacing: d.patientFacing,
      attachToDisclosures: d.attachToDisclosures,
      status: d.status,
      // `document` carries no version counter — the version number IS the count of the append-only ledger.
      version: vers.length,
      versionsCount: vers.length,
      createdAt: iso(d.createdAt),
      updatedAt: iso(d.updatedAt),
    };
  }

  async function requireBatch(tx: DbClient, batchId: string): Promise<void> {
    const [b] = await tx.select({ id: BATCH.id }).from(BATCH).where(eq(BATCH.id, batchId)).limit(1);
    if (!b) throw new NotFoundError("intake batch");
  }

  return {
    // ── Document reads ─────────────────────────────────────────────────────────────────────────────
    async getDocument(organizationId, documentId) {
      return withOrg(db, organizationId, (tx) => loadDocRow(tx, organizationId, documentId));
    },
    async listDocuments(organizationId, filter, cursor, limit): Promise<CursorPage<DocumentView>> {
      return withOrg(db, organizationId, async (tx) => {
        const conds = [
          filter.patientId ? eq(DOC.patientId, filter.patientId) : undefined,
          filter.aggregateType ? eq(DOC.aggregateType, filter.aggregateType as never) : undefined,
          filter.retentionClass ? eq(DOC.retentionClass, filter.retentionClass as never) : undefined,
        ].filter(Boolean);
        const rows = await tx
          .select({
            id: DOC.id,
            organizationId: DOC.organizationId,
            patientId: DOC.patientId,
            admissionId: DOC.admissionId,
            retentionClass: DOC.retentionClass,
            aggregateType: DOC.aggregateType,
            title: DOC.title,
            patientFacing: DOC.patientFacing,
            attachToDisclosures: DOC.attachToDisclosures,
            status: DOC.status,
            createdAt: DOC.createdAt,
            updatedAt: DOC.updatedAt,
          })
          .from(DOC)
          .where(conds.length ? and(...(conds as never[])) : undefined)
          .orderBy(desc(DOC.createdAt), desc(DOC.id))
          .limit(READ_WINDOW);
        const items: DocumentView[] = rows.map((d) => ({
          id: d.id,
          organizationId: d.organizationId,
          patientId: d.patientId,
          admissionId: d.admissionId,
          retentionClass: d.retentionClass,
          aggregateType: d.aggregateType,
          title: d.title,
          patientFacing: d.patientFacing,
          attachToDisclosures: d.attachToDisclosures,
          status: d.status,
          version: 0,
          versionsCount: 0,
          createdAt: iso(d.createdAt),
          updatedAt: iso(d.updatedAt),
        }));
        return paginate(items, cursor, limit);
      });
    },

    // ── Version reads ──────────────────────────────────────────────────────────────────────────────
    async listVersions(organizationId, documentId, cursor, limit): Promise<CursorPage<VersionView>> {
      return withOrg(db, organizationId, async (tx) => {
        await loadDocRow(tx, organizationId, documentId); // 404 for a missing/cross-tenant document
        const rows = await tx
          .select({
            id: DV.id,
            documentId: DV.documentId,
            versionNumber: DV.versionNumber,
            mimeType: DV.mimeType,
            byteSize: DV.byteSize,
            createdAt: DV.createdAt,
          })
          .from(DV)
          .where(eq(DV.documentId, documentId))
          .orderBy(desc(DV.createdAt), desc(DV.id))
          .limit(READ_WINDOW);
        const items: VersionView[] = rows.map((v) => ({
          id: v.id,
          documentId: v.documentId,
          versionNumber: Number(v.versionNumber),
          mimeType: v.mimeType,
          byteSize: Number(v.byteSize),
          uploadedAt: iso(v.createdAt),
          createdAt: iso(v.createdAt),
        }));
        return paginate(items, cursor, limit);
      });
    },
    async getVersion(organizationId, documentId, versionId) {
      return withOrg(db, organizationId, async (tx) => {
        const [v] = await tx
          .select({
            id: DV.id,
            documentId: DV.documentId,
            versionNumber: DV.versionNumber,
            mimeType: DV.mimeType,
            byteSize: DV.byteSize,
            createdAt: DV.createdAt,
          })
          .from(DV)
          .where(and(eq(DV.id, versionId), eq(DV.documentId, documentId)))
          .limit(1);
        if (!v) throw new NotFoundError("document version");
        return {
          id: v.id,
          documentId: v.documentId,
          versionNumber: Number(v.versionNumber),
          mimeType: v.mimeType,
          byteSize: Number(v.byteSize),
          uploadedAt: iso(v.createdAt),
          createdAt: iso(v.createdAt),
        };
      });
    },

    // ── Intake reads ───────────────────────────────────────────────────────────────────────────────
    async getBatch(organizationId, batchId): Promise<IntakeBatchView> {
      return withOrg(db, organizationId, async (tx) => {
        const [b] = await tx
          .select({
            id: BATCH.id,
            organizationId: BATCH.organizationId,
            patientId: BATCH.patientId,
            status: BATCH.status,
            uploadedAt: BATCH.uploadedAt,
          })
          .from(BATCH)
          .where(eq(BATCH.id, batchId))
          .limit(1);
        if (!b) throw new NotFoundError("intake batch");
        const pages = await tx.select({ id: CP.id }).from(CP).where(eq(CP.intakeUploadBatchId, batchId));
        return {
          id: b.id,
          organizationId: b.organizationId,
          patientId: b.patientId,
          status: b.status,
          uploadedAt: iso(b.uploadedAt),
          pages: pages.length,
          createdAt: iso(b.uploadedAt),
        };
      });
    },
    async listClassification(organizationId, batchId, cursor, limit) {
      return withOrg(db, organizationId, async (tx) => {
        await requireBatch(tx, batchId);
        const rows = await tx
          .select({ id: CP.id, createdAt: CP.classifiedAt, docType: CP.documentType })
          .from(CP)
          .where(eq(CP.intakeUploadBatchId, batchId))
          .orderBy(desc(CP.classifiedAt), desc(CP.id))
          .limit(READ_WINDOW);
        return paginate(
          rows.map((r) => ({ id: r.id, createdAt: iso(r.createdAt), docType: String(r.docType) })),
          cursor,
          limit,
        );
      });
    },
    async listJobs(organizationId, batchId, cursor, limit) {
      return withOrg(db, organizationId, async (tx) => {
        await requireBatch(tx, batchId);
        const rows = await tx
          .select({ id: EJ.id, createdAt: EJ.queuedAt, status: EJ.status })
          .from(EJ)
          .innerJoin(CP, eq(EJ.classifiedPageId, CP.id))
          .where(eq(CP.intakeUploadBatchId, batchId))
          .orderBy(desc(EJ.queuedAt), desc(EJ.id))
          .limit(READ_WINDOW);
        return paginate(
          rows.map((r) => ({ id: r.id, createdAt: iso(r.createdAt), status: String(r.status) })),
          cursor,
          limit,
        );
      });
    },
    async getJob(organizationId, jobId, cursor, limit) {
      return withOrg(db, organizationId, async (tx) => {
        const rows = await tx
          .select({ id: EC.id, createdAt: EC.extractedAt, riskLevel: EC.riskLevel })
          .from(EC)
          .where(eq(EC.extractionJobId, jobId))
          .orderBy(desc(EC.extractedAt), desc(EC.id))
          .limit(READ_WINDOW);
        const candidates = paginate(
          rows.map((r) => ({ id: r.id, createdAt: iso(r.createdAt), riskLevel: String(r.riskLevel) })),
          cursor,
          limit,
        );
        return { id: jobId, candidates };
      });
    },
    async getReview(organizationId, reviewId, cursor, limit) {
      return withOrg(db, organizationId, async (tx) => {
        const [r] = await tx
          .select({ id: ER.id, status: ER.status })
          .from(ER)
          .where(eq(ER.id, reviewId))
          .limit(1);
        if (!r) throw new NotFoundError("review");
        const rows = await tx
          .select({ id: ED.id, createdAt: ED.decidedAt })
          .from(ED)
          .where(eq(ED.extractionReviewId, reviewId))
          .orderBy(desc(ED.decidedAt), desc(ED.id))
          .limit(READ_WINDOW);
        const decisions = paginate(
          rows.map((d) => ({ id: d.id, createdAt: iso(d.createdAt) })),
          cursor,
          limit,
        );
        return { id: r.id, status: r.status, decisions };
      });
    },

    // ── Template / overlay / form-fill reads (form_template* is platform reference) ──────────────────
    async listTemplates(organizationId, cursor, limit) {
      return withOrg(db, organizationId, async (tx) => {
        const rows = await tx
          .select({ id: FT.id, key: FT.templateKey, createdAt: FT.createdAt })
          .from(FT)
          .orderBy(desc(FT.createdAt), desc(FT.id))
          .limit(READ_WINDOW);
        return paginate(
          rows.map((r) => ({ id: r.id, key: r.key, createdAt: iso(r.createdAt) })),
          cursor,
          limit,
        );
      });
    },
    async getTemplate(organizationId, key) {
      return withOrg(db, organizationId, async (tx) => {
        const [t] = await tx
          .select({ activeVersionId: FT.publishedActiveVersionId })
          .from(FT)
          .where(eq(FT.templateKey, key))
          .limit(1);
        if (!t) throw new NotFoundError("form template");
        return { key, activeVersionId: t.activeVersionId ?? "" };
      });
    },
    async getTemplateVersion(organizationId, key, versionId) {
      return withOrg(db, organizationId, async (tx) => {
        const [v] = await tx
          .select({ key: FT.templateKey, versionId: FTV.id })
          .from(FTV)
          .innerJoin(FT, eq(FTV.templateId, FT.id))
          .where(and(eq(FTV.id, versionId), eq(FT.templateKey, key)))
          .limit(1);
        if (!v) throw new NotFoundError("form template version");
        return { key: v.key, versionId: v.versionId };
      });
    },
    async listOverlays(organizationId) {
      return withOrg(db, organizationId, async (tx) => {
        const rows = await tx
          .select({ overlayId: OVL.id, templateKey: FT.templateKey })
          .from(OVL)
          .innerJoin(FT, eq(OVL.templateId, FT.id))
          .where(eq(OVL.isActive, true))
          .orderBy(desc(OVL.publishedAt), desc(OVL.id))
          .limit(READ_WINDOW);
        return { overlays: rows.map((r) => ({ templateKey: r.templateKey, overlayId: r.overlayId })) };
      });
    },
    async getFormFill(organizationId, fillId) {
      return withOrg(db, organizationId, async (tx) => {
        const [f] = await tx
          .select({ id: FF.id, status: FF.status })
          .from(FF)
          .where(eq(FF.id, fillId))
          .limit(1);
        if (!f) throw new NotFoundError("form fill");
        return { id: f.id, status: String(f.status) };
      });
    },

    // ── Writes — the M22L-T02+ Drizzle lifecycle. Fail-closed 501 until then. ────────────────────────
    uploadDocument: async () => notImpl(),
    uploadVersion: async () => notImpl(),
    patchDocument: async () => notImpl(),
    addTag: async () => notImpl(),
    removeTag: async () => notImpl(),
    exportPhiBundle: async () => notImpl(),
    uploadBatch: async () => notImpl(),
    confirmClassification: async () => notImpl(),
    openReview: async () => notImpl(),
    recordDecision: async () => notImpl(),
    bulkApprove: async () => notImpl(),
    resolveDiscrepancy: async () => notImpl(),
    completeReview: async () => notImpl(),
    abandonReview: async () => notImpl(),
    discardBatch: async () => notImpl(),
    publishTemplateVersion: async () => notImpl(),
    publishOverlay: async () => notImpl(),
    retryRender: async () => notImpl(),
  };
}

/**
 * The production, RLS-backed DocumentAbacResolver — the §4.7 owner-fact predicates
 * (`document_owner_or_caseload`, `legal_hold_aware`, `document_within_admission_window`) load a
 * document's owner facts through it. Each load is org-scoped under `withOrgContext` (RLS backstops),
 * returning `null` when the row is absent/cross-tenant so the predicate fails closed.
 */
export function createDbDocumentAbacResolver(db: DbClient): DocumentAbacResolver {
  return {
    async loadDocument(organizationId, documentId): Promise<DocumentAbacFacts | null> {
      return withOrg(db, organizationId, async (tx) => {
        const [d] = await tx
          .select({ id: DOC.id, patientId: DOC.patientId, retentionClass: DOC.retentionClass })
          .from(DOC)
          .where(eq(DOC.id, documentId))
          .limit(1);
        if (!d) return null;
        // An active hold (released_at IS NULL) blocks document mutations (§4.7).
        const [hold] = await tx
          .select({ id: LH.id })
          .from(LH)
          .where(and(eq(LH.documentId, documentId), isNull(LH.releasedAt)))
          .limit(1);
        return {
          documentId: d.id,
          patientId: d.patientId,
          retentionClass: d.retentionClass,
          legalHoldActive: !!hold,
          // The patient discharge instant is an M6 cross-module fact (no seam bound in the read wire);
          // the care-team read window stays open (null) until M22L binds the AdmissionStatus reader.
          patientDischargedAt: null,
        };
      });
    },
  };
}

/**
 * The production, RLS-backed SignedUrlObjectResolver — the §4.1 content route's signed-URL service
 * loads a version's object-key facts through it (the presigner itself stays the unwired DegradedError
 * stub). Org-scoped under RLS; a missing/cross-tenant version returns `null` → non-leaking 404.
 */
export function createDbSignedUrlObjectResolver(db: DbClient): SignedUrlObjectResolver {
  return {
    async loadObject({ organizationId, documentId, versionId }): Promise<SignedUrlObjectFacts | null> {
      return withOrg(db, organizationId, async (tx) => {
        const [v] = await tx
          .select({ objectKey: DV.minioObjectKey })
          .from(DV)
          .where(and(eq(DV.id, versionId), eq(DV.documentId, documentId)))
          .limit(1);
        if (!v) return null;
        // `document_version` carries no external-recipient column — the disclosure gate's recipient is
        // resolved at request time from the access purpose, not the row; the read wire supplies none.
        return { objectKey: v.objectKey, externalRecipient: null };
      });
    },
  };
}

/**
 * Build the M22 Drizzle read backend: the production DocumentRouteService (reads real, writes 501), the
 * ABAC owner-fact resolver, and the signed-URL object resolver — the same trio the in-memory
 * `createInMemoryDocumentBackend` exposes, so the barrel wires them identically. The presigner is bound
 * by the caller (the throwing DegradedError stub — M22's storage adapter is unwired).
 */
export function createDbDocumentBackend(db: DbClient): {
  service: DocumentRouteService;
  abacResolver: DocumentAbacResolver;
  objectResolver: SignedUrlObjectResolver;
} {
  return {
    service: createDbDocumentRouteService(db),
    abacResolver: createDbDocumentAbacResolver(db),
    objectResolver: createDbSignedUrlObjectResolver(db),
  };
}
