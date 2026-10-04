// apps/backend/src/modules/22-documents — PRODUCTION Document backend (M22L reads + the write lifecycle over
// Drizzle+RLS). No route is left at 501.
//
// The screen-driving READS (document library + detail, version ledger, intake batch/classification/
// extraction-job/candidate/review surfaces, the platform form-template catalog + tenant overlays + form
// fills) run as real Drizzle queries over the M22-owned `documents/*` tables inside `withOrgContext`, so
// RLS scopes every row by `app.org_id` as the unprivileged `wardenx_app` role (`form_template` /
// `form_template_version` are NON_ORG_SCOPED platform reference — the dual-grant read-all RLS lets any
// tenant read them). The metadata/review WRITE lifecycle is live: tag / patch (legal-hold-aware, 409),
// intake batch upload + classify-confirm + the extraction review machine
// (open / record-decision / bulk-approve / resolve-discrepancy / complete / abandon / discard), tenant overlay
// publish (§2.5 optimistic concurrency, 412), and render retry. Binary upload/version creation returns a typed
// 503 until object bytes + verified size/hash can commit safely. One route write emits a producer outbox
// event: review completion publishes `m22.extraction.commit_requested` (F-235, ./extraction/
// writeback-commit-db.ts), so this backend takes an OPTIONAL publisher + candidate-value cipher; without them a
// review whose approved fields would write back refuses (503) instead of completing with nothing written.
//
// Documented compromises: `form_template*` is platform reference (SELECT only for wardenx_app), so
// `publishTemplateVersion` is a platform-admin op with no tenant-layer persistence (returns the current active
// version / a synthetic id); the `exportPhiBundle` bundle is materialized by the async export worker (the route
// returns its tracking id). The in-memory `createInMemoryDocumentBackend` (`routes/service.ts`) stays the
// reference. Every WRITE now carries its `DocumentWriteActor` (GAP-039): `actor.userId` reaches the M4
// audit triggers through `app.user_id`, and `actor.membershipId` fills the `*_by_membership_id` columns
// that used to take a hardcoded sentinel.
//
// The signed-URL STORAGE PRESIGNER is deliberately NOT built here — the M22 storage adapter is unwired;
// the barrel (`index.ts`) binds the throwing `DegradedError` stub. This module supplies only the read
// resolvers (`abacResolver` over document owner-facts, `objectResolver` over version object-keys).
import { randomUUID } from "node:crypto";
import { type DbClient, schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import { DegradedError, NotFoundError, type OrgId, WardenXError } from "@wardenx/types";
import { and, desc, eq, exists, inArray, isNull } from "drizzle-orm";
import type { DocumentAbacFacts, DocumentAbacResolver } from "./abac-predicates";
import { commitClinicalWriteback } from "./extraction/writeback-commit-clinical-db";
import {
  type ExtractionWritebackDeps,
  commitReviewWriteback,
} from "./extraction/writeback-commit-db";
import { commitReviewDiagnosisWriteback } from "./extraction/writeback-commit-dx-db";
import { isDiagnosisFieldPath } from "./extraction/writeback-plan-dx";
import { markReceivedOnArrival, recordsRequestConflicts } from "./records-request/inbound-match";
import { type CursorPage, paginate } from "./routes/concurrency";
import type {
  DocumentRouteService,
  DocumentView,
  DocumentWriteActor,
  IntakeBatchView,
  ReferralIntakeBatchView,
  TagView,
  VersionView,
} from "./routes/service";
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
const TAG = schema.documentTags;
const DISC = schema.extractionDiscrepancies;

/** A read-wire fetch cap for the in-memory `paginate` keyset slicer (TODO: push the cursor into SQL). */
const READ_WINDOW = 1000;

const iso = (v: Date | string): string => (v instanceof Date ? v.toISOString() : String(v));

/**
 * A READ, org-scoped under RLS. `userId` is empty because M4's audit triggers fire on writes only, and
 * a read leaves no trigger-written row to attribute — the §2.5 read trail is emitted separately by the
 * host's read-audit hook, under the requesting user's own `withOrgContext`.
 */
const withOrg = <T>(
  db: DbClient,
  organizationId: OrgId,
  fn: (tx: DbClient) => Promise<T>,
): Promise<T> => withOrgContext(db, { organizationId, userId: "" }, (tx) => fn(tx as DbClient));

/**
 * A WRITE, org-scoped under RLS AND attributed to the acting user (GAP-039). `actor.userId` becomes
 * `app.user_id`, which every M4 audit trigger on these tables reads into `audit_event.actor_user_id`.
 *
 * Until GAP-039 every write here went through the read helper above, so `app.user_id` was the empty
 * string, which the trigger's NULLIF-then-cast turns into a NULL actor: the whole M22 write history
 * recorded that SOMETHING changed a document, tag, overlay or review, and nothing about who. The actor
 * was available at the route the entire time and was destructured away.
 */
const withOrgAs = <T>(
  db: DbClient,
  organizationId: OrgId,
  actor: DocumentWriteActor,
  fn: (tx: DbClient) => Promise<T>,
): Promise<T> =>
  withOrgContext(db, { organizationId, userId: actor.userId }, (tx) => fn(tx as DbClient));

/**
 * The production, RLS-backed DocumentRouteService. Reads and metadata/review writes are real; binary
 * upload/version creation fails closed with 503 until object storage is bound.
 * Org is bound from the request context by the caller and passed as `organizationId` — never the body.
 */
export function createDbDocumentRouteService(
  db: DbClient,
  writeback: ExtractionWritebackDeps = {},
): DocumentRouteService {
  async function loadDocRow(
    tx: DbClient,
    organizationId: OrgId,
    documentId: string,
  ): Promise<DocumentView> {
    const [d] = await tx
      .select({
        id: DOC.id,
        organizationId: DOC.organizationId,
        patientId: DOC.patientId,
        admissionId: DOC.admissionId,
        retentionClass: DOC.retentionClass,
        aggregateType: DOC.aggregateType,
        aggregateId: DOC.aggregateId,
        title: DOC.title,
        patientFacing: DOC.patientFacing,
        attachToDisclosures: DOC.attachToDisclosures,
        metadata: DOC.metadata,
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
      aggregateId: d.aggregateId,
      title: d.title,
      patientFacing: d.patientFacing,
      attachToDisclosures: d.attachToDisclosures,
      metadata: (d.metadata ?? null) as DocumentView["metadata"],
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

  /** Load the review's id + parent batch (RLS-scoped) or the non-leaking 404. */
  async function requireReview(
    tx: DbClient,
    reviewId: string,
  ): Promise<{ id: string; batchId: string; status: string }> {
    const [r] = await tx
      .select({ id: ER.id, batchId: ER.intakeUploadBatchId, status: ER.status })
      .from(ER)
      .where(eq(ER.id, reviewId))
      .limit(1);
    if (!r) throw new NotFoundError("review");
    return r;
  }

  /** F-237 — a decision may only be written into a review that is still open. */
  async function requireOpenReview(
    tx: DbClient,
    reviewId: string,
  ): Promise<{ id: string; batchId: string; status: string }> {
    const r = await requireReview(tx, reviewId);
    if (r.status !== "in_progress") {
      throw new WardenXError(
        "REVIEW_NOT_IN_PROGRESS",
        `review is ${r.status}; decisions can only be recorded on an in-progress review`,
        409,
      );
    }
    return r;
  }

  /** §4.7 — a document under an active legal hold (released_at IS NULL) refuses mutation (409). */
  async function assertNoHold(tx: DbClient, documentId: string): Promise<void> {
    const [h] = await tx
      .select({ id: LH.id })
      .from(LH)
      .where(and(eq(LH.documentId, documentId), isNull(LH.releasedAt)))
      .limit(1);
    if (h)
      throw new WardenXError(
        "LEGAL_HOLD_ACTIVE",
        "the document is under an active legal hold",
        409,
      );
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
          filter.aggregateId ? eq(DOC.aggregateId, filter.aggregateId) : undefined,
          filter.retentionClass
            ? eq(DOC.retentionClass, filter.retentionClass as never)
            : undefined,
          // F-060 — the query `document_tag_org_key_idx` (organization_id, tag_key, tag_value) was
          // designed for. EXISTS rather than a join so a document matching two tags stays one row;
          // RLS scopes both sides, and the org column is in the predicate so the index is usable.
          filter.tagKey
            ? exists(
                tx
                  .select({ one: TAG.id })
                  .from(TAG)
                  .where(
                    and(
                      eq(TAG.documentId, DOC.id),
                      eq(TAG.organizationId, organizationId),
                      eq(TAG.tagKey, filter.tagKey),
                      ...(filter.tagValue === undefined ? [] : [eq(TAG.tagValue, filter.tagValue)]),
                    ),
                  ),
              )
            : undefined,
        ].filter(Boolean);
        const rows = await tx
          .select({
            id: DOC.id,
            organizationId: DOC.organizationId,
            patientId: DOC.patientId,
            admissionId: DOC.admissionId,
            retentionClass: DOC.retentionClass,
            aggregateType: DOC.aggregateType,
            aggregateId: DOC.aggregateId,
            title: DOC.title,
            patientFacing: DOC.patientFacing,
            attachToDisclosures: DOC.attachToDisclosures,
            metadata: DOC.metadata,
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
          aggregateId: d.aggregateId,
          title: d.title,
          patientFacing: d.patientFacing,
          attachToDisclosures: d.attachToDisclosures,
          metadata: (d.metadata ?? null) as DocumentView["metadata"],
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
    async listVersions(
      organizationId,
      documentId,
      cursor,
      limit,
    ): Promise<CursorPage<VersionView>> {
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
    async listReferralBatches(organizationId, referralId, cursor, limit) {
      // Strictly referral-filed (`referral_id = :referralId`, served by intake_batch_org_referral_idx).
      // A batch with no referral whose patient is the referral's resolved patient is deliberately NOT
      // included: it was never filed as this referral's records, and the route's access check is the
      // referral's, not the patient's.
      return withOrg(db, organizationId, async (tx) => {
        const batches = await tx
          .select({
            id: BATCH.id,
            patientId: BATCH.patientId,
            status: BATCH.status,
            sourceChannel: BATCH.sourceChannel,
            identityStatus: BATCH.identityStatus,
            sudStatus: BATCH.sudStatus,
            pageGeometry: BATCH.pageGeometry,
            uploadedAt: BATCH.uploadedAt,
            conflictId: BATCH.recordsRequestConflictId,
            conflictKind: BATCH.recordsRequestConflictKind,
          })
          .from(BATCH)
          .where(eq(BATCH.referralId, referralId))
          .orderBy(desc(BATCH.uploadedAt), desc(BATCH.id))
          .limit(READ_WINDOW);
        if (batches.length === 0) return paginate([], cursor, limit);
        const ids = batches.map((b) => b.id);
        const conflicts = await recordsRequestConflicts(tx, batches);
        const segments = await tx
          .select({ batchId: CP.intakeUploadBatchId, pageTo: CP.pageRangeEnd })
          .from(CP)
          .where(inArray(CP.intakeUploadBatchId, ids));
        const cands = await tx
          .select({ batchId: CP.intakeUploadBatchId })
          .from(EC)
          .innerJoin(EJ, eq(EJ.id, EC.extractionJobId))
          .innerJoin(CP, eq(CP.id, EJ.classifiedPageId))
          .where(inArray(CP.intakeUploadBatchId, ids));
        const reviews = await tx
          .select({
            id: ER.id,
            batchId: ER.intakeUploadBatchId,
            status: ER.status,
            openedAt: ER.openedAt,
          })
          .from(ER)
          .where(inArray(ER.intakeUploadBatchId, ids))
          .orderBy(desc(ER.openedAt));
        const decisions = reviews.length
          ? await tx
              .select({ reviewId: ED.extractionReviewId })
              .from(ED)
              .where(
                inArray(
                  ED.extractionReviewId,
                  reviews.map((r) => r.id),
                ),
              )
          : [];
        const items: ReferralIntakeBatchView[] = batches.map((b) => {
          const segs = segments.filter((c) => c.batchId === b.id);
          const geometry = Array.isArray(b.pageGeometry) ? b.pageGeometry.length : 0;
          const review = reviews.find((r) => r.batchId === b.id) ?? null;
          return {
            id: b.id,
            referralId,
            patientId: b.patientId,
            status: b.status,
            sourceChannel: b.sourceChannel,
            identityStatus: b.identityStatus,
            sudStatus: b.sudStatus,
            recordsRequestConflict: conflicts.get(b.id) ?? null,
            pages: geometry || segs.reduce((n, c) => Math.max(n, Number(c.pageTo)), 0),
            documents: segs.length,
            candidates: cands.filter((c) => c.batchId === b.id).length,
            review: review
              ? {
                  id: review.id,
                  status: review.status,
                  decided: decisions.filter((d) => d.reviewId === review.id).length,
                }
              : null,
            uploadedAt: iso(b.uploadedAt),
            createdAt: iso(b.uploadedAt),
          };
        });
        return paginate(items, cursor, limit);
      });
    },
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
        const pages = await tx
          .select({ id: CP.id })
          .from(CP)
          .where(eq(CP.intakeUploadBatchId, batchId));
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
          rows.map((r) => ({
            id: r.id,
            createdAt: iso(r.createdAt),
            riskLevel: String(r.riskLevel),
          })),
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
        return {
          overlays: rows.map((r) => ({ templateKey: r.templateKey, overlayId: r.overlayId })),
        };
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

    // ── Document writes (append-only version ledger; no producer outbox) ─────────────────────────────
    async uploadDocument() {
      throw new DegradedError(
        "document-storage",
        "uploads are unavailable until object bytes, verified byte size, and SHA-256 persistence are bound",
      );
    },
    async uploadVersion() {
      throw new DegradedError(
        "document-storage",
        "new versions are unavailable until object bytes, verified byte size, and SHA-256 persistence are bound",
      );
    },
    async patchDocument(organizationId, actor, documentId, patch) {
      return withOrgAs(db, organizationId, actor, async (tx) => {
        await loadDocRow(tx, organizationId, documentId); // 404
        await assertNoHold(tx, documentId);
        const set: Record<string, unknown> = { updatedAt: new Date() };
        if (patch.title !== undefined) set.title = patch.title;
        if (patch.patientFacing !== undefined) set.patientFacing = patch.patientFacing;
        if (patch.attachToDisclosures !== undefined)
          set.attachToDisclosures = patch.attachToDisclosures;
        await tx.update(DOC).set(set).where(eq(DOC.id, documentId));
        return loadDocRow(tx, organizationId, documentId);
      });
    },
    async linkDocument(organizationId, actor, documentId, patch) {
      return withOrgAs(db, organizationId, actor, async (tx) => {
        await loadDocRow(tx, organizationId, documentId); // 404
        await assertNoHold(tx, documentId);
        if (patch.patientId === undefined && patch.admissionId === undefined) {
          throw new WardenXError("VALIDATION_FAILED", "at least one link field is required", 422);
        }
        const set: Record<string, unknown> = { updatedAt: new Date() };
        if (patch.patientId !== undefined) set.patientId = patch.patientId;
        if (patch.admissionId !== undefined) set.admissionId = patch.admissionId;
        await tx.update(DOC).set(set).where(eq(DOC.id, documentId));
        return loadDocRow(tx, organizationId, documentId);
      });
    },
    async listTags(organizationId, documentId, cursor, limit): Promise<CursorPage<TagView>> {
      return withOrg(db, organizationId, async (tx) => {
        await loadDocRow(tx, organizationId, documentId); // 404 before an empty page
        const rows = await tx
          .select({
            id: TAG.id,
            tagKind: TAG.tagKind,
            tagKey: TAG.tagKey,
            tagValue: TAG.tagValue,
            addedAt: TAG.addedAt,
          })
          .from(TAG)
          .where(eq(TAG.documentId, documentId))
          .orderBy(desc(TAG.addedAt), desc(TAG.id))
          .limit(READ_WINDOW);
        return paginate(
          rows.map((t) => ({
            id: t.id,
            tagKind: t.tagKind,
            tagKey: t.tagKey,
            tagValue: t.tagValue,
            addedAt: iso(t.addedAt),
            createdAt: iso(t.addedAt),
          })),
          cursor,
          limit,
        );
      });
    },
    async addTag(organizationId, actor, documentId, tag) {
      return withOrgAs(db, organizationId, actor, async (tx) => {
        await loadDocRow(tx, organizationId, documentId); // 404
        await assertNoHold(tx, documentId);
        const [t] = await tx
          .insert(TAG)
          .values({
            organizationId,
            documentId,
            tagKind: tag.tagKind,
            tagKey: tag.tagKey,
            tagValue: tag.tagValue,
            addedByMembershipId: actor.membershipId,
          })
          .returning({ id: TAG.id, addedAt: TAG.addedAt });
        if (!t) throw new Error("document_tag insert returned no row");
        return {
          id: t.id,
          tagKind: tag.tagKind,
          tagKey: tag.tagKey,
          tagValue: tag.tagValue,
          addedAt: iso(t.addedAt),
          createdAt: iso(t.addedAt),
        };
      });
    },
    async removeTag(organizationId, actor, documentId, tagId) {
      return withOrgAs(db, organizationId, actor, async (tx) => {
        await loadDocRow(tx, organizationId, documentId); // 404
        await assertNoHold(tx, documentId);
        const del = await tx
          .delete(TAG)
          .where(and(eq(TAG.id, tagId), eq(TAG.documentId, documentId)))
          .returning({ id: TAG.id });
        if (del.length === 0) throw new NotFoundError("tag");
      });
    },
    async exportPhiBundle(_organizationId, _actor, _args) {
      // §4.1 — the PHI export bundle is materialized by the async export worker; the route returns the tracking
      // id it will render under (the in-mem posture — no synchronous bundle table on the write path).
      return { documentBundleId: randomUUID() };
    },

    // ── Intake writes ────────────────────────────────────────────────────────────────────────────────
    async uploadBatch(organizationId, actor, args) {
      return withOrgAs(db, organizationId, actor, async (tx) => {
        // F-236 — a batch that names its source document must name one this tenant actually filed (RLS:
        // another org's id is simply not found → the non-leaking 404).
        if (args.documentId) {
          const [d] = await tx
            .select({ id: DOC.id })
            .from(DOC)
            .where(eq(DOC.id, args.documentId))
            .limit(1);
          if (!d) throw new NotFoundError("document");
        }
        const [b] = await tx
          .insert(BATCH)
          .values({
            organizationId,
            patientId: args.patientId,
            referralId: args.referralId ?? null,
            recordsRequestId: args.recordsRequestId ?? null,
            // No SQL FK (app-validated above). Without a documentId the ref is a placeholder the ingest
            // pipeline would replace; an extraction run against it refuses (parse_failed), never guesses.
            initialDocumentId: args.documentId ?? randomUUID(),
            sourceChannel: args.sourceChannel,
            sourceMetadata: args.sourceMetadata,
            uploadedByMembershipId: actor.membershipId,
            correlationId: randomUUID(),
          })
          .returning({ id: BATCH.id, status: BATCH.status, uploadedAt: BATCH.uploadedAt });
        if (!b) throw new Error("intake_upload_batch insert returned no row");
        // F-238 — records arrived for an outbound request: it moves to `received` with the batch.
        if (args.recordsRequestId)
          await markReceivedOnArrival(tx, args.recordsRequestId, new Date());
        return {
          id: b.id,
          organizationId,
          patientId: args.patientId,
          referralId: args.referralId ?? null,
          recordsRequestId: args.recordsRequestId ?? null,
          status: b.status,
          uploadedAt: iso(b.uploadedAt),
          pages: 0,
          createdAt: iso(b.uploadedAt),
        };
      });
    },
    async confirmClassification(organizationId, actor, batchId) {
      return withOrgAs(db, organizationId, actor, async (tx) => {
        await requireBatch(tx, batchId);
        await tx.update(BATCH).set({ status: "classifier_complete" }).where(eq(BATCH.id, batchId));
        return { batchId, status: "classifier_complete" };
      });
    },
    async openReview(organizationId, actor, batchId) {
      return withOrgAs(db, organizationId, actor, async (tx) => {
        await requireBatch(tx, batchId);
        const [r] = await tx
          .insert(ER)
          .values({
            organizationId,
            intakeUploadBatchId: batchId,
            reviewerMembershipId: actor.membershipId,
            status: "in_progress",
            correlationId: randomUUID(),
          })
          .returning({ id: ER.id, status: ER.status, openedAt: ER.openedAt });
        if (!r) throw new Error("extraction_review insert returned no row");
        await tx.update(BATCH).set({ status: "in_review" }).where(eq(BATCH.id, batchId));
        return { id: r.id, batchId, status: r.status, createdAt: iso(r.openedAt) };
      });
    },
    async recordDecision(organizationId, actor, reviewId, args) {
      return withOrgAs(db, organizationId, actor, async (tx) => {
        const review = await requireOpenReview(tx, reviewId);
        // F-237 — the candidate must be this review's batch's (the ABAC guard already denied any other).
        const [cand] = await tx
          .select({
            id: EC.id,
            visionDisagreement: EC.visionDisagreement,
            identityResolution: CP.identityResolution,
          })
          .from(EC)
          .innerJoin(EJ, eq(EJ.id, EC.extractionJobId))
          .innerJoin(CP, eq(CP.id, EJ.classifiedPageId))
          .where(and(eq(EC.id, args.candidateId), eq(CP.intakeUploadBatchId, review.batchId)))
          .limit(1);
        if (!cand) throw new NotFoundError("extraction candidate");
        // F-238 — a field from a document the reviewer marked as another patient's cannot be approved for
        // this one (the commit excludes it regardless). Relinking the batch clears that resolution.
        if (args.decision !== "reject" && cand.identityResolution === "other_patient") {
          throw new WardenXError(
            "DOCUMENT_IS_OTHER_PATIENT",
            "this field comes from a document marked as another patient's; it cannot be approved here",
            409,
          );
        }
        // F-237 — stage 5 read the page differently. Approving the extraction as-is over that
        // disagreement is allowed, but only with the reviewer's stated reason (an edit is a correction).
        if (args.decision === "approve" && cand.visionDisagreement !== null && !args.reason) {
          throw new WardenXError(
            "VISION_DISAGREEMENT_REASON_REQUIRED",
            "the vision check read this field differently; approving it unchanged needs a reason",
            422,
          );
        }
        const values = {
          decision: args.decision as never,
          // F-235 — the edited value IS the attestation for `approve_with_edit`; the writeback commit
          // reads it from here. It used to be parsed off the request and dropped.
          editedValue: args.editedValue ?? null,
          editedCode: args.editedCode ?? null,
          chartOverwriteConfirmed: args.chartOverwriteConfirmed ?? null,
          reason: args.reason ?? null,
          sourceViewConfirmed: true,
          partOfBulkApprove: false,
          bulkApproveBatchId: null,
          decidedAt: new Date(),
        };
        // F-237 — a reviewer may change their mind before completing: one decision per candidate per
        // review (the unique index), revised in place — the M4 trigger audits the before/after.
        const [d] = await tx
          .insert(ED)
          .values({
            organizationId,
            extractionCandidateId: args.candidateId,
            extractionReviewId: reviewId,
            ...values,
          })
          .onConflictDoUpdate({
            target: [ED.extractionCandidateId, ED.extractionReviewId],
            set: values,
          })
          .returning({ id: ED.id });
        if (!d) throw new Error("extraction_decision insert returned no row");
        return { decisionId: d.id };
      });
    },
    async bulkApprove(organizationId, actor, reviewId, candidateIds) {
      return withOrgAs(db, organizationId, actor, async (tx) => {
        const review = await requireOpenReview(tx, reviewId);
        // F-237 — every id must be this review's batch's candidate (defense in depth behind the ABAC guard).
        const owned = await tx
          .select({ id: EC.id })
          .from(EC)
          .innerJoin(EJ, eq(EJ.id, EC.extractionJobId))
          .innerJoin(CP, eq(CP.id, EJ.classifiedPageId))
          .where(
            and(inArray(EC.id, [...candidateIds]), eq(CP.intakeUploadBatchId, review.batchId)),
          );
        if (new Set(owned.map((o) => o.id)).size !== new Set(candidateIds).size) {
          throw new NotFoundError("extraction candidate");
        }
        const bulkApproveBatchId = randomUUID();
        for (const candidateId of candidateIds) {
          const values = {
            decision: "approve" as const,
            editedValue: null,
            editedCode: null,
            reason: null,
            sourceViewConfirmed: true,
            partOfBulkApprove: true,
            bulkApproveBatchId,
            decidedAt: new Date(),
          };
          await tx
            .insert(ED)
            .values({
              organizationId,
              extractionCandidateId: candidateId,
              extractionReviewId: reviewId,
              ...values,
            })
            .onConflictDoUpdate({
              target: [ED.extractionCandidateId, ED.extractionReviewId],
              set: values,
            });
        }
        return { bulkApproveBatchId, decisionsCreated: candidateIds.length };
      });
    },
    async resolveDiscrepancy(organizationId, actor, reviewId, discrepancyId) {
      return withOrgAs(db, organizationId, actor, async (tx) => {
        await requireReview(tx, reviewId);
        const upd = await tx
          .update(DISC)
          .set({
            status: "resolved",
            resolvedByMembershipId: actor.membershipId,
            resolvedAt: new Date(),
          })
          .where(eq(DISC.id, discrepancyId))
          .returning({ id: DISC.id });
        if (upd.length === 0) throw new NotFoundError("discrepancy");
        return { discrepancyId, status: "resolved" };
      });
    },
    async completeReview(organizationId, actor, reviewId) {
      return withOrgAs(db, organizationId, actor, async (tx) => {
        await requireReview(tx, reviewId);
        // Serialize concurrent completions of one review: the second waits, then sees `complete`.
        const [r] = await tx
          .select({ id: ER.id, batchId: ER.intakeUploadBatchId, status: ER.status })
          .from(ER)
          .where(eq(ER.id, reviewId))
          .for("update");
        if (!r) throw new NotFoundError("review");
        // Idempotent re-completion (a retried request with the same Idempotency-Key, or a double click):
        // the writeback was committed by the first one — never emit it twice.
        if (r.status === "complete") return { reviewId, status: "complete" as const };
        if (r.status !== "in_progress") {
          throw new WardenXError(
            "REVIEW_NOT_IN_PROGRESS",
            `review is ${r.status}; only an in-progress review can be completed`,
            409,
          );
        }
        const [batch] = await tx
          .select({
            patientId: BATCH.patientId,
            sudStatus: BATCH.sudStatus,
            identityStatus: BATCH.identityStatus,
          })
          .from(BATCH)
          .where(eq(BATCH.id, r.batchId))
          .limit(1);
        if (!batch) throw new NotFoundError("intake batch");
        // F-237 — §7.4 W4: a SUD detection must be confirmed or rejected before anything is committed.
        if (batch.sudStatus === "detected") {
          throw new WardenXError(
            "SUD_DETECTION_UNRESOLVED",
            "possible substance-use content was detected; confirm or reject it before completing the review",
            409,
          );
        }
        // F-238 — a document that may be another patient's must be resolved (same patient / other patient)
        // before anything from this fax reaches a chart.
        if (batch.identityStatus === "possible" || batch.identityStatus === "mismatch") {
          throw new WardenXError(
            "IDENTITY_UNRESOLVED",
            "a document in this fax may belong to another patient; resolve it before completing the review",
            409,
          );
        }
        // §7.1 W1 steps 11–12 (F-235) — provenance + `m22.extraction.commit_requested`, in THIS transaction.
        const m5Summary = await commitReviewWriteback(tx, writeback, {
          organizationId,
          reviewId,
          batchId: r.batchId,
          batchPatientId: batch.patientId,
          reviewerMembershipId: actor.membershipId,
          batchSudStatus: batch.sudStatus,
        });
        // F-238 — the diagnosis half: approved `diagnoses[n].*` → `m22.extraction.diagnosis_commit_requested`
        // (M7 lands them as PROPOSED problems a clinician must accept). Its candidates are reported by its
        // own summary, so they are not also listed as M5 `not_a_writeback_target` exclusions.
        const diagnosisWriteback = await commitReviewDiagnosisWriteback(tx, writeback, {
          organizationId,
          reviewId,
          batchId: r.batchId,
          batchPatientId: batch.patientId,
          reviewerMembershipId: actor.membershipId,
          batchSudStatus: batch.sudStatus,
        });
        // F-238 — approved medication lines → M12 reconciliation-only history; allergy lines → M5
        // unverified allergies. Same transaction, same server-side-only inputs.
        const clinicalWriteback = await commitClinicalWriteback(tx, writeback, {
          organizationId,
          reviewId,
          batchId: r.batchId,
          batchPatientId: batch.patientId,
          reviewerMembershipId: actor.membershipId,
          batchSudStatus: batch.sudStatus,
        });
        const summary = {
          ...m5Summary,
          excluded: m5Summary.excluded.filter((e) => !isDiagnosisFieldPath(e.fieldPath)),
        };
        await tx
          .update(ER)
          .set({ status: "complete", closedAt: new Date() })
          .where(eq(ER.id, reviewId));
        // The batch reaches a terminal disposition — the `disposition_shape` CHECK ties a
        // writeback_complete/discarded status to a non-null `disposition_at`.
        await tx
          .update(BATCH)
          .set({ status: "writeback_complete", dispositionAt: new Date() })
          .where(eq(BATCH.id, r.batchId));
        return {
          reviewId,
          status: "complete" as const,
          writeback: summary,
          diagnosisWriteback,
          clinicalWriteback,
        };
      });
    },
    async abandonReview(organizationId, actor, reviewId) {
      return withOrgAs(db, organizationId, actor, async (tx) => {
        await requireReview(tx, reviewId);
        await tx
          .update(ER)
          .set({ status: "abandoned", closedAt: new Date() })
          .where(eq(ER.id, reviewId));
        return { reviewId, status: "abandoned" };
      });
    },
    async discardBatch(organizationId, actor, batchId) {
      return withOrgAs(db, organizationId, actor, async (tx) => {
        await requireBatch(tx, batchId);
        await tx
          .update(BATCH)
          .set({ status: "discarded", dispositionAt: new Date() })
          .where(eq(BATCH.id, batchId));
        return { batchId, status: "discarded" };
      });
    },

    // ── Template / overlay / render writes ───────────────────────────────────────────────────────────
    async publishTemplateVersion(organizationId, actor, key, _args) {
      // `form_template_version` is PLATFORM reference (wardenx_app has SELECT only) — a version publish is a
      // platform-admin op, not a tenant write. Return the template's current active version if resolvable,
      // else a synthetic id (no tenant-layer persistence; the in-mem posture).
      return withOrg(db, organizationId, async (tx) => {
        const [t] = await tx
          .select({ active: FT.publishedActiveVersionId })
          .from(FT)
          .where(eq(FT.templateKey, key))
          .limit(1);
        return { key, versionId: t?.active ?? randomUUID() };
      });
    },
    async publishOverlay(organizationId, actor, templateKey, ifVersion) {
      return withOrgAs(db, organizationId, actor, async (tx) => {
        const [t] = await tx
          .select({ id: FT.id })
          .from(FT)
          .where(eq(FT.templateKey, templateKey))
          .limit(1);
        if (!t) throw new NotFoundError("form template");
        // §2.5 optimistic concurrency: the current version is the count of overlay rows for this template;
        // the caller's If-Match `ifVersion` must match it, else 412.
        const existing = await tx.select({ id: OVL.id }).from(OVL).where(eq(OVL.templateId, t.id));
        const current = existing.length;
        if (ifVersion !== current) {
          throw new WardenXError(
            "VERSION_MISMATCH",
            "the overlay was modified since you read it",
            412,
          );
        }
        await tx
          .update(OVL)
          .set({ isActive: false })
          .where(and(eq(OVL.templateId, t.id), eq(OVL.isActive, true)));
        const [o] = await tx
          .insert(OVL)
          .values({
            organizationId,
            templateId: t.id,
            branding: {},
            isActive: true,
            publishedByMembershipId: actor.membershipId,
            publishedAt: new Date(),
          })
          .returning({ id: OVL.id });
        if (!o) throw new Error("tenant_template_overlay insert returned no row");
        return { overlayId: o.id, version: current + 1 };
      });
    },
    async retryRender(organizationId, actor, fillId) {
      return withOrgAs(db, organizationId, actor, async (tx) => {
        const [f] = await tx.select({ id: FF.id }).from(FF).where(eq(FF.id, fillId)).limit(1);
        if (!f) throw new NotFoundError("form fill");
        await tx.update(FF).set({ status: "queued" }).where(eq(FF.id, fillId));
        return { id: fillId, status: "queued" };
      });
    },
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
    // F-237 — risk tiers come from the candidate rows, joined through job → classified page to the
    // review's own batch, so a candidate of another batch (or tenant) is never authorized against this one.
    async loadReviewCandidateRisks(organizationId, reviewId, candidateIds) {
      if (candidateIds.length === 0) return new Map();
      return withOrg(db, organizationId, async (tx) => {
        const rows = await tx
          .select({ id: EC.id, risk: EC.riskLevel })
          .from(EC)
          .innerJoin(EJ, eq(EJ.id, EC.extractionJobId))
          .innerJoin(CP, eq(CP.id, EJ.classifiedPageId))
          .innerJoin(ER, eq(ER.intakeUploadBatchId, CP.intakeUploadBatchId))
          .where(and(eq(ER.id, reviewId), inArray(EC.id, [...candidateIds])));
        return new Map(rows.map((r) => [r.id, r.risk]));
      });
    },
    async loadDiscrepancyRisk(organizationId, reviewId, discrepancyId) {
      return withOrg(db, organizationId, async (tx) => {
        const [row] = await tx
          .select({ risk: EC.riskLevel })
          .from(DISC)
          .innerJoin(ER, eq(ER.intakeUploadBatchId, DISC.intakeUploadBatchId))
          .innerJoin(EC, eq(EC.id, DISC.candidateAId))
          .where(and(eq(ER.id, reviewId), eq(DISC.id, discrepancyId)))
          .limit(1);
        return row?.risk ?? null;
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
    async loadObject({
      organizationId,
      documentId,
      versionId,
    }): Promise<SignedUrlObjectFacts | null> {
      return withOrg(db, organizationId, async (tx) => {
        const [v] = await tx
          .select({
            objectKey: DV.minioObjectKey,
            // F-197 (#248) — §7.16 mint-time SUD-consent re-check facts, joined off `document`: the
            // version row itself carries neither the patient nor the render-time SUD flag.
            patientId: DOC.patientId,
            metadata: DOC.metadata,
          })
          .from(DV)
          .innerJoin(DOC, eq(DOC.id, DV.documentId))
          .where(and(eq(DV.id, versionId), eq(DV.documentId, documentId)))
          .limit(1);
        if (!v) return null;
        // `document_version` carries no external-recipient column — the disclosure gate's recipient is
        // resolved at request time from the access purpose, not the row; the read wire supplies none.
        const metadata = (v.metadata ?? null) as { sudRedacted?: boolean } | null;
        return {
          objectKey: v.objectKey,
          externalRecipient: null,
          patientId: v.patientId,
          isSudClass: metadata?.sudRedacted === true,
        };
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
export function createDbDocumentBackend(
  db: DbClient,
  writeback: ExtractionWritebackDeps = {},
): {
  service: DocumentRouteService;
  abacResolver: DocumentAbacResolver;
  objectResolver: SignedUrlObjectResolver;
} {
  return {
    service: createDbDocumentRouteService(db, writeback),
    abacResolver: createDbDocumentAbacResolver(db),
    objectResolver: createDbSignedUrlObjectResolver(db),
  };
}
