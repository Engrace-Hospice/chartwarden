// apps/backend/src/modules/22-documents/routes/service.ts — M22-T07 the DocumentRouteService + an in-memory
// slice (§4.1). The route handlers compose over this; production injects a Drizzle-backed service (writes
// under `withOrgContext` so RLS scopes by `app.org_id`). The slice also exposes a DocumentAbacResolver +
// SignedUrlObjectResolver over the SAME dataset so M22's §4.7 predicates and the signed-URL service resolve
// a document's owner/object facts without a cross-module schema import. Mirrors the M6/M7/M8 routes/service
// precedent: pure-ish (only an injected `now()` so timestamps are deterministic in tests), org-scoped reads
// (a missing/cross-tenant id is a non-leaking 404 — the way RLS behaves in prod), cursor pagination on lists.
import type {
  DocumentRetentionClass,
  DocumentStatus,
  ExtractionReviewStatus,
  IntakeBatchStatus,
  OrgId,
} from "@wardenx/types";
import { NotFoundError, WardenXError } from "@wardenx/types";
import type { ExternalRecipientRef } from "../outbox-consumers/decide-document-request";
import { type CursorPage, paginate } from "./concurrency";
import type {
  DocumentAbacFacts,
  DocumentAbacResolver,
} from "../abac-predicates";
import type {
  SignedUrlObjectFacts,
  SignedUrlObjectResolver,
} from "./signed-url-service";

// ── route DTOs (in-memory; the Drizzle adapter projects rows to the SAME shapes) ──────────────────────

export interface UploadDocumentArgs {
  readonly patientId: string | null;
  readonly admissionId: string | null;
  readonly retentionClass: DocumentRetentionClass;
  readonly aggregateType: string;
  readonly aggregateId: string | null;
  readonly title: string;
  readonly patientFacing: boolean;
}

export interface DocumentView {
  readonly id: string;
  readonly organizationId: string;
  readonly patientId: string | null;
  readonly admissionId: string | null;
  readonly retentionClass: DocumentRetentionClass;
  readonly aggregateType: string;
  readonly title: string;
  readonly patientFacing: boolean;
  readonly attachToDisclosures: boolean;
  readonly status: DocumentStatus;
  readonly version: number;
  readonly versionsCount: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface VersionView {
  readonly id: string;
  readonly documentId: string;
  readonly versionNumber: number;
  readonly mimeType: string;
  readonly byteSize: number;
  readonly uploadedAt: string;
  readonly createdAt: string;
}

export interface TagView {
  readonly id: string;
  readonly tagKind: string;
  readonly tagKey: string;
  readonly tagValue: string | null;
}

export interface IntakeBatchView {
  readonly id: string;
  readonly organizationId: string;
  readonly patientId: string | null;
  readonly status: IntakeBatchStatus;
  readonly uploadedAt: string;
  readonly pages: number;
  readonly createdAt: string;
}

export interface ReviewView {
  readonly id: string;
  readonly batchId: string;
  readonly status: ExtractionReviewStatus;
  readonly createdAt: string;
}

/** The §4.1 route service the handlers compose over. Every method is org-scoped (RLS in prod). */
export interface DocumentRouteService {
  uploadDocument(organizationId: OrgId, actorUserId: string, args: UploadDocumentArgs): Promise<DocumentView>;
  uploadVersion(organizationId: OrgId, documentId: string): Promise<VersionView>;
  getDocument(organizationId: OrgId, documentId: string): Promise<DocumentView>;
  listVersions(organizationId: OrgId, documentId: string, cursor: string | undefined, limit: number | undefined): Promise<CursorPage<VersionView>>;
  getVersion(organizationId: OrgId, documentId: string, versionId: string): Promise<VersionView>;
  listDocuments(
    organizationId: OrgId,
    filter: { patientId?: string; aggregateType?: string; retentionClass?: string },
    cursor: string | undefined,
    limit: number | undefined,
  ): Promise<CursorPage<DocumentView>>;
  patchDocument(
    organizationId: OrgId,
    documentId: string,
    patch: { title?: string; patientFacing?: boolean; attachToDisclosures?: boolean },
  ): Promise<DocumentView>;
  addTag(organizationId: OrgId, documentId: string, tag: { tagKind: string; tagKey: string; tagValue: string | null }): Promise<TagView>;
  removeTag(organizationId: OrgId, documentId: string, tagId: string): Promise<void>;
  exportPhiBundle(organizationId: OrgId, args: { patientId: string; purpose: string }): Promise<{ documentBundleId: string }>;
  // intake
  uploadBatch(organizationId: OrgId, args: { patientId: string | null; sourceChannel: string }): Promise<IntakeBatchView>;
  getBatch(organizationId: OrgId, batchId: string): Promise<IntakeBatchView>;
  listClassification(organizationId: OrgId, batchId: string, cursor: string | undefined, limit: number | undefined): Promise<CursorPage<{ id: string; createdAt: string; docType: string }>>;
  confirmClassification(organizationId: OrgId, batchId: string): Promise<{ batchId: string; status: IntakeBatchStatus }>;
  listJobs(organizationId: OrgId, batchId: string, cursor: string | undefined, limit: number | undefined): Promise<CursorPage<{ id: string; createdAt: string; status: string }>>;
  getJob(organizationId: OrgId, jobId: string, cursor: string | undefined, limit: number | undefined): Promise<{ id: string; candidates: CursorPage<{ id: string; createdAt: string; riskLevel: string }> }>;
  openReview(organizationId: OrgId, batchId: string, actorUserId: string): Promise<ReviewView>;
  getReview(organizationId: OrgId, reviewId: string, cursor: string | undefined, limit: number | undefined): Promise<{ id: string; status: ExtractionReviewStatus; decisions: CursorPage<{ id: string; createdAt: string }> }>;
  recordDecision(organizationId: OrgId, reviewId: string, args: { candidateId: string; decision: string }): Promise<{ decisionId: string }>;
  bulkApprove(organizationId: OrgId, reviewId: string, candidateIds: readonly string[]): Promise<{ bulkApproveBatchId: string; decisionsCreated: number }>;
  resolveDiscrepancy(organizationId: OrgId, reviewId: string, discrepancyId: string): Promise<{ discrepancyId: string; status: "resolved" }>;
  completeReview(organizationId: OrgId, reviewId: string): Promise<{ reviewId: string; status: "complete" }>;
  abandonReview(organizationId: OrgId, reviewId: string): Promise<{ reviewId: string; status: "abandoned" }>;
  discardBatch(organizationId: OrgId, batchId: string): Promise<{ batchId: string; status: "discarded" }>;
  // templates / overlays / admin
  listTemplates(organizationId: OrgId, cursor: string | undefined, limit: number | undefined): Promise<CursorPage<{ id: string; key: string; createdAt: string }>>;
  getTemplate(organizationId: OrgId, key: string): Promise<{ key: string; activeVersionId: string }>;
  getTemplateVersion(organizationId: OrgId, key: string, versionId: string): Promise<{ key: string; versionId: string }>;
  publishTemplateVersion(organizationId: OrgId, key: string, args: { versionLabel: string }): Promise<{ key: string; versionId: string }>;
  listOverlays(organizationId: OrgId): Promise<{ overlays: { templateKey: string; overlayId: string }[] }>;
  publishOverlay(organizationId: OrgId, templateKey: string, ifVersion: number): Promise<{ overlayId: string; version: number }>;
  getFormFill(organizationId: OrgId, fillId: string): Promise<{ id: string; status: string }>;
  retryRender(organizationId: OrgId, fillId: string): Promise<{ id: string; status: "queued" }>;
}

// ── in-memory records + slice ─────────────────────────────────────────────────────────────────────────

interface DocumentRecord {
  id: string;
  organizationId: string;
  patientId: string | null;
  admissionId: string | null;
  retentionClass: DocumentRetentionClass;
  aggregateType: string;
  title: string;
  patientFacing: boolean;
  attachToDisclosures: boolean;
  status: DocumentStatus;
  version: number;
  createdAt: string;
  updatedAt: string;
  versions: { id: string; versionNumber: number; objectKey: string; externalRecipient: ExternalRecipientRef | null; createdAt: string }[];
  tags: Map<string, TagView>;
  legalHoldActive: boolean;
}

interface BatchRecord {
  id: string;
  organizationId: string;
  patientId: string | null;
  status: IntakeBatchStatus;
  pages: number;
  createdAt: string;
  reviews: Map<string, { id: string; status: ExtractionReviewStatus; createdAt: string }>;
}

/** Deterministic, I/O-free seed for the in-memory route service (slice + smoke tests). */
export interface DocumentRouteSeed {
  readonly documents?: ReadonlyArray<Partial<DocumentRecord> & { id: string; organizationId: string }>;
  readonly batches?: ReadonlyArray<Partial<BatchRecord> & { id: string; organizationId: string }>;
}

/** Pads `n` to a uuid-shaped id so created ids round-trip through uuid-validated bodies (M6/M8 slice). */
function uuidFromCounter(prefixNibble: string, n: number): string {
  const hex = n.toString(16).padStart(12, "0");
  return `${prefixNibble}0000000-0000-4000-8000-${hex}`;
}

const toDocView = (r: DocumentRecord): DocumentView => ({
  id: r.id,
  organizationId: r.organizationId,
  patientId: r.patientId,
  admissionId: r.admissionId,
  retentionClass: r.retentionClass,
  aggregateType: r.aggregateType,
  title: r.title,
  patientFacing: r.patientFacing,
  attachToDisclosures: r.attachToDisclosures,
  status: r.status,
  version: r.version,
  versionsCount: r.versions.length,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
});

/** Read-only inspection surface over the slice (the §7 route tests assert against it). */
export interface DocumentBackendInspect {
  documentCount(organizationId: OrgId): number;
  legalHoldActive(documentId: string): boolean;
}

export function createInMemoryDocumentBackend(seed: DocumentRouteSeed = {}): {
  service: DocumentRouteService;
  abacResolver: DocumentAbacResolver;
  objectResolver: SignedUrlObjectResolver;
  inspect: DocumentBackendInspect;
} {
  const docs = new Map<string, DocumentRecord>();
  const batches = new Map<string, BatchRecord>();
  const reviewIndex = new Map<string, string>(); // reviewId → batchId
  let created = 0;
  let sub = 0;
  const now = () => "2026-06-21T12:00:00.000Z";
  const subId = () => uuidFromCounter("a", ++sub);

  for (const d of seed.documents ?? []) {
    docs.set(d.id, {
      patientId: null,
      admissionId: null,
      retentionClass: "clinical_record",
      aggregateType: "other",
      title: "seed",
      patientFacing: false,
      attachToDisclosures: false,
      status: "active",
      version: 0,
      createdAt: now(),
      updatedAt: now(),
      versions: [
        { id: uuidFromCounter("d", 1), versionNumber: 1, objectKey: `documents/seed/${d.id}/v1.pdf`, externalRecipient: null, createdAt: now() },
      ],
      tags: new Map(),
      legalHoldActive: false,
      ...d,
    } as DocumentRecord);
  }
  for (const b of seed.batches ?? []) {
    batches.set(b.id, {
      patientId: null,
      status: "uploaded",
      pages: 1,
      createdAt: now(),
      reviews: new Map(),
      ...b,
    } as BatchRecord);
  }

  function loadDoc(organizationId: OrgId, id: string): DocumentRecord {
    const r = docs.get(id);
    if (!r || r.organizationId !== organizationId) throw new NotFoundError("document");
    return r;
  }
  function loadBatch(organizationId: OrgId, id: string): BatchRecord {
    const r = batches.get(id);
    if (!r || r.organizationId !== organizationId) throw new NotFoundError("intake batch");
    return r;
  }
  function loadReview(organizationId: OrgId, reviewId: string): { batch: BatchRecord; review: { id: string; status: ExtractionReviewStatus; createdAt: string } } {
    const batchId = reviewIndex.get(reviewId);
    const batch = batchId ? batches.get(batchId) : undefined;
    if (!batch || batch.organizationId !== organizationId) throw new NotFoundError("review");
    const review = batch.reviews.get(reviewId);
    if (!review) throw new NotFoundError("review");
    return { batch, review };
  }

  /** Rows already DESC-sorted by `(createdAt, id)` for keyset pagination. */
  const desc = <T extends { createdAt: string; id: string }>(rows: T[]): T[] =>
    [...rows].sort((a, b) => (a.createdAt === b.createdAt ? (a.id < b.id ? 1 : -1) : a.createdAt < b.createdAt ? 1 : -1));

  let overlayVersion = 0;

  const service: DocumentRouteService = {
    async uploadDocument(organizationId, _actorUserId, args) {
      const id = uuidFromCounter("c", ++created);
      const rec: DocumentRecord = {
        id,
        organizationId,
        patientId: args.patientId,
        admissionId: args.admissionId,
        retentionClass: args.retentionClass,
        aggregateType: args.aggregateType,
        title: args.title,
        patientFacing: args.patientFacing,
        attachToDisclosures: false,
        status: "active",
        version: 0,
        createdAt: now(),
        updatedAt: now(),
        versions: [{ id: subId(), versionNumber: 1, objectKey: `documents/${args.patientId ?? "unbound"}/${args.aggregateType}/${id}/v1.pdf`, externalRecipient: null, createdAt: now() }],
        tags: new Map(),
        legalHoldActive: false,
      };
      docs.set(id, rec);
      return toDocView(rec);
    },
    async uploadVersion(organizationId, documentId) {
      const r = loadDoc(organizationId, documentId);
      const versionNumber = r.versions.length + 1;
      const v = { id: subId(), versionNumber, objectKey: `documents/${r.patientId ?? "unbound"}/${r.aggregateType}/${r.id}/v${versionNumber}.pdf`, externalRecipient: null, createdAt: now() };
      r.versions.push(v);
      r.version += 1;
      r.updatedAt = now();
      return { id: v.id, documentId: r.id, versionNumber, mimeType: "application/pdf", byteSize: 0, uploadedAt: now(), createdAt: now() };
    },
    async getDocument(organizationId, documentId) {
      return toDocView(loadDoc(organizationId, documentId));
    },
    async listVersions(organizationId, documentId, cursor, limit) {
      const r = loadDoc(organizationId, documentId);
      const rows = desc(r.versions.map((v) => ({ id: v.id, documentId: r.id, versionNumber: v.versionNumber, mimeType: "application/pdf", byteSize: 0, uploadedAt: v.createdAt, createdAt: v.createdAt })));
      return paginate(rows, cursor, limit);
    },
    async getVersion(organizationId, documentId, versionId) {
      const r = loadDoc(organizationId, documentId);
      const v = r.versions.find((x) => x.id === versionId);
      if (!v) throw new NotFoundError("document version");
      return { id: v.id, documentId: r.id, versionNumber: v.versionNumber, mimeType: "application/pdf", byteSize: 0, uploadedAt: v.createdAt, createdAt: v.createdAt };
    },
    async listDocuments(organizationId, filter, cursor, limit) {
      const rows = desc(
        [...docs.values()]
          .filter((r) => r.organizationId === organizationId)
          .filter((r) => (filter.patientId ? r.patientId === filter.patientId : true))
          .filter((r) => (filter.aggregateType ? r.aggregateType === filter.aggregateType : true))
          .filter((r) => (filter.retentionClass ? r.retentionClass === filter.retentionClass : true))
          .map(toDocView),
      );
      return paginate(rows, cursor, limit);
    },
    async patchDocument(organizationId, documentId, patch) {
      const r = loadDoc(organizationId, documentId);
      if (r.legalHoldActive) throw new WardenXError("LEGAL_HOLD_ACTIVE", "the document is under an active legal hold", 409);
      if (patch.title !== undefined) r.title = patch.title;
      if (patch.patientFacing !== undefined) r.patientFacing = patch.patientFacing;
      if (patch.attachToDisclosures !== undefined) r.attachToDisclosures = patch.attachToDisclosures;
      r.version += 1;
      r.updatedAt = now();
      return toDocView(r);
    },
    async addTag(organizationId, documentId, tag) {
      const r = loadDoc(organizationId, documentId);
      if (r.legalHoldActive) throw new WardenXError("LEGAL_HOLD_ACTIVE", "the document is under an active legal hold", 409);
      const id = subId();
      const view: TagView = { id, tagKind: tag.tagKind, tagKey: tag.tagKey, tagValue: tag.tagValue };
      r.tags.set(id, view);
      return view;
    },
    async removeTag(organizationId, documentId, tagId) {
      const r = loadDoc(organizationId, documentId);
      if (r.legalHoldActive) throw new WardenXError("LEGAL_HOLD_ACTIVE", "the document is under an active legal hold", 409);
      if (!r.tags.delete(tagId)) throw new NotFoundError("tag");
    },
    async exportPhiBundle(organizationId, _args) {
      void organizationId;
      return { documentBundleId: subId() };
    },
    async uploadBatch(organizationId, args) {
      const id = uuidFromCounter("b", ++created);
      const rec: BatchRecord = { id, organizationId, patientId: args.patientId, status: "uploaded", pages: 1, createdAt: now(), reviews: new Map() };
      batches.set(id, rec);
      return { id: rec.id, organizationId, patientId: rec.patientId, status: rec.status, uploadedAt: rec.createdAt, pages: rec.pages, createdAt: rec.createdAt };
    },
    async getBatch(organizationId, batchId) {
      const r = loadBatch(organizationId, batchId);
      return { id: r.id, organizationId: r.organizationId, patientId: r.patientId, status: r.status, uploadedAt: r.createdAt, pages: r.pages, createdAt: r.createdAt };
    },
    async listClassification(organizationId, batchId, cursor, limit) {
      loadBatch(organizationId, batchId);
      const rows = desc([{ id: subId(), createdAt: now(), docType: "discharge_summary" }]);
      return paginate(rows, cursor, limit);
    },
    async confirmClassification(organizationId, batchId) {
      const r = loadBatch(organizationId, batchId);
      r.status = "classifier_complete";
      return { batchId: r.id, status: r.status };
    },
    async listJobs(organizationId, batchId, cursor, limit) {
      loadBatch(organizationId, batchId);
      const rows = desc([{ id: subId(), createdAt: now(), status: "ready_for_review" }]);
      return paginate(rows, cursor, limit);
    },
    async getJob(organizationId, jobId, cursor, limit) {
      void organizationId;
      const rows = desc([{ id: subId(), createdAt: now(), riskLevel: "low" }]);
      return { id: jobId, candidates: paginate(rows, cursor, limit) };
    },
    async openReview(organizationId, batchId, _actorUserId) {
      const b = loadBatch(organizationId, batchId);
      const id = subId();
      const review = { id, status: "in_progress" as ExtractionReviewStatus, createdAt: now() };
      b.reviews.set(id, review);
      reviewIndex.set(id, b.id);
      b.status = "in_review";
      return { id, batchId: b.id, status: review.status, createdAt: review.createdAt };
    },
    async getReview(organizationId, reviewId, cursor, limit) {
      const { review } = loadReview(organizationId, reviewId);
      const rows = desc<{ id: string; createdAt: string }>([]);
      return { id: review.id, status: review.status, decisions: paginate(rows, cursor, limit) };
    },
    async recordDecision(organizationId, reviewId, _args) {
      loadReview(organizationId, reviewId);
      return { decisionId: subId() };
    },
    async bulkApprove(organizationId, reviewId, candidateIds) {
      loadReview(organizationId, reviewId);
      return { bulkApproveBatchId: subId(), decisionsCreated: candidateIds.length };
    },
    async resolveDiscrepancy(organizationId, reviewId, discrepancyId) {
      loadReview(organizationId, reviewId);
      return { discrepancyId, status: "resolved" };
    },
    async completeReview(organizationId, reviewId) {
      const { batch, review } = loadReview(organizationId, reviewId);
      review.status = "complete";
      batch.status = "writeback_complete";
      return { reviewId: review.id, status: "complete" };
    },
    async abandonReview(organizationId, reviewId) {
      const { review } = loadReview(organizationId, reviewId);
      review.status = "abandoned";
      return { reviewId: review.id, status: "abandoned" };
    },
    async discardBatch(organizationId, batchId) {
      const r = loadBatch(organizationId, batchId);
      r.status = "discarded";
      return { batchId: r.id, status: "discarded" };
    },
    async listTemplates(organizationId, cursor, limit) {
      void organizationId;
      const rows = desc([{ id: subId(), key: "election_statement", createdAt: now() }]);
      return paginate(rows, cursor, limit);
    },
    async getTemplate(organizationId, key) {
      void organizationId;
      return { key, activeVersionId: subId() };
    },
    async getTemplateVersion(organizationId, key, versionId) {
      void organizationId;
      return { key, versionId };
    },
    async publishTemplateVersion(organizationId, key, _args) {
      void organizationId;
      return { key, versionId: subId() };
    },
    async listOverlays(organizationId) {
      void organizationId;
      return { overlays: [] };
    },
    async publishOverlay(organizationId, templateKey, ifVersion) {
      void organizationId;
      // §2.5 optimistic concurrency — the caller's If-Match version must match the current.
      if (ifVersion !== overlayVersion) {
        throw new WardenXError("VERSION_MISMATCH", "the overlay was modified since you read it", 412);
      }
      overlayVersion += 1;
      void templateKey;
      return { overlayId: subId(), version: overlayVersion };
    },
    async getFormFill(organizationId, fillId) {
      void organizationId;
      return { id: fillId, status: "rendered" };
    },
    async retryRender(organizationId, fillId) {
      void organizationId;
      return { id: fillId, status: "queued" };
    },
  };

  const abacResolver: DocumentAbacResolver = {
    async loadDocument(organizationId, documentId): Promise<DocumentAbacFacts | null> {
      const r = docs.get(documentId);
      if (!r || r.organizationId !== organizationId) return null;
      return {
        documentId: r.id,
        patientId: r.patientId,
        retentionClass: r.retentionClass,
        legalHoldActive: r.legalHoldActive,
        patientDischargedAt: null,
      };
    },
  };

  const objectResolver: SignedUrlObjectResolver = {
    async loadObject({ organizationId, documentId, versionId }): Promise<SignedUrlObjectFacts | null> {
      const r = docs.get(documentId);
      if (!r || r.organizationId !== organizationId) return null;
      const v = r.versions.find((x) => x.id === versionId);
      if (!v) return null;
      return { objectKey: v.objectKey, externalRecipient: v.externalRecipient };
    },
  };

  const inspect: DocumentBackendInspect = {
    documentCount: (organizationId) => [...docs.values()].filter((r) => r.organizationId === organizationId).length,
    legalHoldActive: (documentId) => docs.get(documentId)?.legalHoldActive ?? false,
  };

  return { service, abacResolver, objectResolver, inspect };
}
