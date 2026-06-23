// apps/backend/src/modules/22-documents/routes/service.ts — M22-T07 the §4.1 route service over an in-memory
// backend (the M17-T07 / M18-T06 in-mem-slice precedent; Drizzle in prod under `withOrgContext` so RLS backstops
// every read/write). The service composes the PURE M22 domain (`../domain`): the §2.2.1 aggregate state machine
// (`createDocument` / `addVersion`), the §2.3 retention-class rules, the §7.10 D11 signed-URL TTL clamp
// (`clampSignedUrlTtlSeconds`), and the §3.3 D1 per-tenant object-key model (`tenantBucket` / `renderedObjectKey`).
// It ALSO implements {@link DocumentAbacResolver} (the M17/M18 precedent: the backend is both the route service
// and the §4.7 ABAC resolver) so `document_owner_or_caseload` / `legal_hold_aware` / `extraction_reviewer_eligible`
// / `extraction_high_risk_field_per_field_only` / `document_within_admission_window` resolve over the same dataset
// the routes mutate.
//
// All §4.1 PHI list routes use opaque cursor pagination (SD-052): `(createdAt DESC, id)` encoded into a base64
// cursor; offset-based pagination is forbidden. The signed-URL mint (`mintSignedUrl`) clamps the requested TTL to
// the §7.10 D11 ceiling (5 min non-portal) and presigns through the injected internal-presign port (M22's
// `DocumentStorageProvider` seam in prod). DocLens extraction routes (the 503 `documents.doclens` gate + the real
// pipeline) land in M22-T08 — this service exposes the intake batch / review reads + decision records the routes
// register behind their guards.
import type {
  ChartTargetModule,
  DocumentAccessKind,
  DocumentAccessPurpose,
  DocumentAggregateType,
  DocumentRetentionClass,
  DocumentSourceKind,
  DocumentStatus,
  ExtractionCandidateRiskLevel,
  ExtractionDecisionKind,
  ExtractionReviewStatus,
  IntakeBatchStatus,
} from "@wardenx/types";
import { ConflictError, ForbiddenError, NotFoundError } from "@wardenx/types";
import type { DocumentAbacResolver } from "../abac-predicates";
import { addVersion, clampSignedUrlTtlSeconds, createDocument, renderedObjectKey } from "../domain/index";

// ── §4.4 outbox events the service records (the relay wraps them in the M1 envelope; M22-T08+) ──────────────
export interface RecordedDocumentEvent {
  readonly eventName: string;
  readonly documentId: string | null;
}

// ── the internal-presign port (M22's `DocumentStorageProvider` seam in prod; an in-mem fake in the slice) ────
export interface InternalPresignPort {
  presignDownload(args: {
    tenantId: string;
    objectKey: string;
    downloadFilename: string;
    ttlSeconds: number;
  }): Promise<{ url: string; expiresAt: string }>;
}

// ── view DTOs (the route projections; never the raw Drizzle row) ────────────────────────────────────────────
export interface DocumentView {
  readonly id: string;
  readonly organizationId: string;
  readonly patientId: string | null;
  readonly admissionId: string | null;
  readonly retentionClass: DocumentRetentionClass;
  readonly sourceKind: DocumentSourceKind;
  readonly aggregateType: DocumentAggregateType;
  readonly aggregateId: string | null;
  readonly title: string;
  readonly patientFacing: boolean;
  readonly attachToDisclosures: boolean;
  readonly status: DocumentStatus;
  readonly activeVersion: DocumentVersionView | null;
  readonly versionsCount: number;
  readonly tags: ReadonlyArray<TagView>;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface DocumentVersionView {
  readonly id: string;
  readonly versionNumber: number;
  readonly mimeType: string;
  readonly byteSize: number;
  readonly sha256Hex: string;
  readonly uploadedByKind: string;
  readonly uploadedAt: string;
}

export interface TagView {
  readonly id: string;
  readonly tagKind: "free" | "structured";
  readonly tagKey: string;
  readonly tagValue: string | null;
}

/** An opaque-cursor page (the §4.1 SD-052 list shape: `items` + `next_cursor` + `has_more`). */
export interface Page<T> {
  readonly items: ReadonlyArray<T>;
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
}

export interface IntakeBatchView {
  readonly id: string;
  readonly organizationId: string;
  readonly patientId: string | null;
  readonly status: IntakeBatchStatus;
  readonly pageCount: number;
  readonly createdAt: string;
}

export interface ReviewView {
  readonly id: string;
  readonly intakeBatchId: string;
  readonly status: ExtractionReviewStatus;
  readonly reviewerMembershipId: string;
  readonly decisionsCount: number;
}

export interface ProvenanceView {
  readonly id: string;
  readonly targetModule: ChartTargetModule;
  readonly targetAggregateId: string | null;
  readonly targetFieldPath: string;
  readonly sourceDocumentId: string;
  readonly decisionKind: ExtractionDecisionKind;
  readonly committedAt: string | null;
}

// ── command shapes ──────────────────────────────────────────────────────────────────────────────────────────
export interface UploadDocumentInput {
  readonly patientId: string | null;
  readonly admissionId: string | null;
  readonly retentionClass: DocumentRetentionClass;
  readonly aggregateType: DocumentAggregateType;
  readonly aggregateId: string | null;
  readonly title: string;
  readonly mimeType: string;
  readonly byteSize: number;
  readonly sha256Hex: string;
  readonly patientFacing: boolean;
  readonly tags: ReadonlyArray<{ tagKind: "free" | "structured"; tagKey: string; tagValue?: string }>;
}

export interface UploadVersionInput {
  readonly mimeType: string;
  readonly byteSize: number;
  readonly sha256Hex: string;
}

export interface EditDocumentInput {
  readonly title?: string;
  readonly patientFacing?: boolean;
  readonly attachToDisclosures?: boolean;
}

export interface DocumentListFilters {
  readonly patientId?: string;
  readonly aggregateType?: string;
  readonly retentionClass?: string;
  readonly cursor?: string;
  readonly limit?: number;
}

// ── records (the in-mem rows) ───────────────────────────────────────────────────────────────────────────────
interface VersionRecord {
  id: string;
  versionNumber: number;
  mimeType: string;
  byteSize: number;
  sha256Hex: string;
  minioObjectKey: string;
  uploadedByKind: string;
  uploadedAt: string;
}
interface DocumentRecord {
  id: string;
  organizationId: string;
  patientId: string | null;
  admissionId: string | null;
  retentionClass: DocumentRetentionClass;
  sourceKind: DocumentSourceKind;
  aggregateType: DocumentAggregateType;
  aggregateId: string | null;
  title: string;
  patientFacing: boolean;
  attachToDisclosures: boolean;
  status: DocumentStatus;
  versions: VersionRecord[];
  tags: TagView[];
  createdAt: string;
  updatedAt: string;
}
interface BatchRecord {
  id: string;
  organizationId: string;
  patientId: string | null;
  status: IntakeBatchStatus;
  pageCount: number;
  createdAt: string;
}
interface ReviewRecord {
  id: string;
  organizationId: string;
  intakeBatchId: string;
  status: ExtractionReviewStatus;
  reviewerMembershipId: string;
  decisions: Array<{ candidateId: string; decisionKind: ExtractionDecisionKind }>;
}
interface CandidateRecord {
  id: string;
  organizationId: string;
  reviewId: string;
  riskLevel: ExtractionCandidateRiskLevel;
}
interface ProvenanceRow {
  id: string;
  organizationId: string;
  targetModule: ChartTargetModule;
  targetAggregateId: string | null;
  targetFieldPath: string;
  sourceDocumentId: string;
  decisionKind: ExtractionDecisionKind;
  committedAt: string | null;
}
interface LegalHoldRow {
  organizationId: string;
  documentId: string;
  active: boolean;
}
/** §4.7 post-discharge window facts the `document_within_admission_window` predicate resolves. */
interface AdmissionWindowRow {
  organizationId: string;
  documentId: string;
  postDischarge: boolean;
  withinWindow: boolean;
}

// ── seed (the §9 RLS/ABAC tests + the resolver inject the dataset; default empty = fail-closed) ──────────────
export interface DocumentSeed {
  readonly documents?: ReadonlyArray<Partial<DocumentRecord> & { id: string; organizationId: string }>;
  /** `membershipId|patientId` pairs in caseload (drives `document_owner_or_caseload`). */
  readonly caseload?: readonly string[];
  readonly batches?: ReadonlyArray<BatchRecord>;
  readonly reviews?: ReadonlyArray<ReviewRecord>;
  readonly candidates?: ReadonlyArray<CandidateRecord>;
  readonly provenance?: ReadonlyArray<ProvenanceRow>;
  readonly legalHolds?: ReadonlyArray<LegalHoldRow>;
  readonly admissionWindows?: ReadonlyArray<AdmissionWindowRow>;
}

export interface DocumentServiceDeps {
  readonly now: () => string;
  readonly newId: () => string;
  readonly presign: InternalPresignPort;
  readonly seed?: DocumentSeed;
}

const caseloadKey = (userId: string, patientId: string): string => `${userId}|${patientId}`;
const DEFAULT_PAGE = 50;
const MAX_PAGE = 200;

/** Encode `(createdAt, id)` into an opaque base64 cursor (the §4.1 SD-052 list cursor; HMAC in prod). */
function encodeCursor(createdAt: string, id: string): string {
  return Buffer.from(`${createdAt}|${id}`, "utf8").toString("base64url");
}
/** Decode the opaque cursor → `(createdAt, id)`; null on a malformed value (the route treats it as page 1). */
function decodeCursor(cursor: string | undefined): { createdAt: string; id: string } | null {
  if (!cursor) return null;
  try {
    const [createdAt, id] = Buffer.from(cursor, "base64url").toString("utf8").split("|");
    return createdAt && id ? { createdAt, id } : null;
  } catch {
    return null;
  }
}

/**
 * The in-memory M22 route backend. Org-pinned on every read/write (cross-tenant rows are invisible — the Drizzle
 * prod path leans on RLS for the same guarantee). Implements {@link DocumentAbacResolver} so the §4.7 predicates
 * resolve over the same dataset the routes mutate.
 */
export class DocumentRouteService implements DocumentAbacResolver {
  private readonly now: () => string;
  private readonly newId: () => string;
  private readonly presignPort: InternalPresignPort;
  private readonly caseload: Set<string>;

  private readonly documents = new Map<string, DocumentRecord>();
  private readonly batches = new Map<string, BatchRecord>();
  private readonly reviews = new Map<string, ReviewRecord>();
  private readonly candidates = new Map<string, CandidateRecord>();
  private readonly provenance = new Map<string, ProvenanceRow>();
  private readonly legalHolds: LegalHoldRow[] = [];
  private readonly admissionWindows = new Map<string, AdmissionWindowRow>();
  private readonly events: RecordedDocumentEvent[] = [];

  constructor(deps: DocumentServiceDeps) {
    this.now = deps.now;
    this.newId = deps.newId;
    this.presignPort = deps.presign;
    this.caseload = new Set(deps.seed?.caseload ?? []);
    for (const d of deps.seed?.documents ?? []) {
      const at = d.createdAt ?? this.now();
      this.documents.set(d.id, {
        organizationId: d.organizationId,
        id: d.id,
        patientId: d.patientId ?? null,
        admissionId: d.admissionId ?? null,
        retentionClass: d.retentionClass ?? "clinical_record",
        sourceKind: d.sourceKind ?? "user_upload",
        aggregateType: d.aggregateType ?? "other",
        aggregateId: d.aggregateId ?? null,
        title: d.title ?? "document",
        patientFacing: d.patientFacing ?? false,
        attachToDisclosures: d.attachToDisclosures ?? false,
        status: d.status ?? "active",
        versions: d.versions ?? [],
        tags: d.tags ?? [],
        createdAt: at,
        updatedAt: d.updatedAt ?? at,
      });
    }
    for (const b of deps.seed?.batches ?? []) this.batches.set(b.id, { ...b });
    for (const r of deps.seed?.reviews ?? []) this.reviews.set(r.id, { ...r, decisions: [...r.decisions] });
    for (const c of deps.seed?.candidates ?? []) this.candidates.set(c.id, { ...c });
    for (const p of deps.seed?.provenance ?? []) this.provenance.set(p.id, { ...p });
    this.legalHolds.push(...(deps.seed?.legalHolds ?? []).map((h) => ({ ...h })));
    for (const w of deps.seed?.admissionWindows ?? []) this.admissionWindows.set(w.documentId, { ...w });
  }

  /** Drain the recorded outbox events (the M22-T08 relay / tests consume these). */
  drainEvents(): RecordedDocumentEvent[] {
    return this.events.splice(0, this.events.length);
  }

  // ── documents ───────────────────────────────────────────────────────────────────────────────────────────
  uploadDocument(orgId: string, userId: string, input: UploadDocumentInput): DocumentView {
    const id = this.newId();
    const versionId = this.newId();
    const at = this.now();
    // D1 per-tenant key (patient-prefixed; `org-level` sentinel for org-scoped documents with no patient binding).
    const objectKey = renderedObjectKey({
      patientId: input.patientId ?? "org-level",
      documentType: input.aggregateType,
      documentId: id,
      versionId,
    });
    // The pure §2.2.1 machine validates the v1 shape (monotonicity, sha256, uploader-shape) before any row lands.
    const result = createDocument({
      retentionClass: input.retentionClass,
      sourceKind: "user_upload",
      firstVersion: {
        versionNumber: 1,
        minioObjectKey: objectKey,
        sha256Hex: input.sha256Hex,
        mimeType: input.mimeType,
        uploadedByKind: "user",
        uploadedByMembershipId: userId,
      },
    });
    const record: DocumentRecord = {
      id,
      organizationId: orgId,
      patientId: input.patientId,
      admissionId: input.admissionId,
      retentionClass: input.retentionClass,
      sourceKind: "user_upload",
      aggregateType: input.aggregateType,
      aggregateId: input.aggregateId,
      title: input.title,
      patientFacing: input.patientFacing,
      attachToDisclosures: false,
      status: result.status,
      versions: [
        {
          id: versionId,
          versionNumber: 1,
          mimeType: input.mimeType,
          byteSize: input.byteSize,
          sha256Hex: input.sha256Hex,
          minioObjectKey: objectKey,
          uploadedByKind: "user",
          uploadedAt: at,
        },
      ],
      tags: input.tags.map((t) => ({
        id: this.newId(),
        tagKind: t.tagKind,
        tagKey: t.tagKey,
        tagValue: t.tagValue ?? null,
      })),
      createdAt: at,
      updatedAt: at,
    };
    this.documents.set(id, record);
    this.events.push({ eventName: "m22.document.created", documentId: id });
    return toDocumentView(record);
  }

  uploadVersion(orgId: string, userId: string, documentId: string, input: UploadVersionInput): DocumentView {
    const doc = this.requireDocument(orgId, documentId);
    const versionId = this.newId();
    const at = this.now();
    const objectKey = renderedObjectKey({
      patientId: doc.patientId ?? "org-level",
      documentType: doc.aggregateType,
      documentId,
      versionId,
    });
    const current = doc.versions[doc.versions.length - 1];
    // The pure §2.2.2 machine enforces strict monotonicity + versionable-status before the row lands.
    addVersion({
      currentStatus: doc.status,
      currentActiveVersionNumber: current?.versionNumber ?? 0,
      newVersion: {
        versionNumber: (current?.versionNumber ?? 0) + 1,
        minioObjectKey: objectKey,
        sha256Hex: input.sha256Hex,
        mimeType: input.mimeType,
        uploadedByKind: "user",
        uploadedByMembershipId: userId,
      },
    });
    doc.versions.push({
      id: versionId,
      versionNumber: (current?.versionNumber ?? 0) + 1,
      mimeType: input.mimeType,
      byteSize: input.byteSize,
      sha256Hex: input.sha256Hex,
      minioObjectKey: objectKey,
      uploadedByKind: "user",
      uploadedAt: at,
    });
    doc.updatedAt = at;
    this.events.push({ eventName: "m22.document.versioned", documentId });
    return toDocumentView(doc);
  }

  getDocument(orgId: string, documentId: string): DocumentView {
    return toDocumentView(this.requireDocument(orgId, documentId));
  }

  listVersions(orgId: string, documentId: string): ReadonlyArray<DocumentVersionView> {
    return this.requireDocument(orgId, documentId).versions.map(toVersionView);
  }

  getVersion(orgId: string, documentId: string, versionId: string): DocumentVersionView {
    const doc = this.requireDocument(orgId, documentId);
    const v = doc.versions.find((x) => x.id === versionId);
    if (!v) throw new NotFoundError("document version not found");
    return toVersionView(v);
  }

  listDocuments(orgId: string, filters: DocumentListFilters): Page<DocumentView> {
    const limit = Math.min(Math.max(filters.limit ?? DEFAULT_PAGE, 1), MAX_PAGE);
    const after = decodeCursor(filters.cursor);
    const sorted = [...this.documents.values()]
      .filter((d) => d.organizationId === orgId)
      .filter((d) => (filters.patientId ? d.patientId === filters.patientId : true))
      .filter((d) => (filters.aggregateType ? d.aggregateType === filters.aggregateType : true))
      .filter((d) => (filters.retentionClass ? d.retentionClass === filters.retentionClass : true))
      // (createdAt DESC, id) — newest first, id as the stable tiebreak.
      .sort((a, b) => (a.createdAt === b.createdAt ? (a.id < b.id ? 1 : -1) : a.createdAt < b.createdAt ? 1 : -1));
    const start = after
      ? sorted.findIndex((d) => d.createdAt < after.createdAt || (d.createdAt === after.createdAt && d.id < after.id))
      : 0;
    const from = start < 0 ? sorted.length : start;
    const slice = sorted.slice(from, from + limit);
    const hasMore = from + limit < sorted.length;
    const last = slice[slice.length - 1];
    return {
      items: slice.map(toDocumentView),
      nextCursor: hasMore && last ? encodeCursor(last.createdAt, last.id) : null,
      hasMore,
    };
  }

  editDocument(orgId: string, documentId: string, input: EditDocumentInput): DocumentView {
    const doc = this.requireDocument(orgId, documentId);
    if (input.title !== undefined) doc.title = input.title;
    if (input.patientFacing !== undefined) doc.patientFacing = input.patientFacing;
    if (input.attachToDisclosures !== undefined) doc.attachToDisclosures = input.attachToDisclosures;
    doc.updatedAt = this.now();
    return toDocumentView(doc);
  }

  addTag(orgId: string, documentId: string, tag: { tagKind: "free" | "structured"; tagKey: string; tagValue?: string }): DocumentView {
    const doc = this.requireDocument(orgId, documentId);
    doc.tags.push({ id: this.newId(), tagKind: tag.tagKind, tagKey: tag.tagKey, tagValue: tag.tagValue ?? null });
    doc.updatedAt = this.now();
    return toDocumentView(doc);
  }

  removeTag(orgId: string, documentId: string, tagId: string): DocumentView {
    const doc = this.requireDocument(orgId, documentId);
    const idx = doc.tags.findIndex((t) => t.id === tagId);
    if (idx < 0) throw new NotFoundError("document tag not found");
    doc.tags.splice(idx, 1);
    doc.updatedAt = this.now();
    return toDocumentView(doc);
  }

  /**
   * §1.3 / §4.12 — mint a short-lived presigned download URL for a version. The requested TTL is clamped to the
   * §7.10 D11 non-portal ceiling (5 min) by the pure domain, then presigned through the injected object store. A
   * `signed_url_issued` access-log row is the §164.528 disclosure footprint (the route records it via `audit()`).
   */
  async mintSignedUrl(
    orgId: string,
    documentId: string,
    versionId: string,
    _purpose: DocumentAccessPurpose,
    ttlSeconds: number,
  ): Promise<{ url: string; expiresAt: string; accessKind: DocumentAccessKind }> {
    const doc = this.requireDocument(orgId, documentId);
    const v = doc.versions.find((x) => x.id === versionId);
    if (!v) throw new NotFoundError("document version not found");
    const clamped = clampSignedUrlTtlSeconds(ttlSeconds, false);
    const presigned = await this.presignPort.presignDownload({
      tenantId: orgId,
      objectKey: v.minioObjectKey,
      downloadFilename: `${doc.aggregateType}-${versionId.slice(0, 12)}`,
      ttlSeconds: clamped,
    });
    this.events.push({ eventName: "m22.signed_url.issued", documentId });
    return { url: presigned.url, expiresAt: presigned.expiresAt, accessKind: "signed_url_issued" };
  }

  /** §164.524 — record a right-of-access bulk export request (the SEC-052 §8.9 workflow; step-up at the route). */
  exportPhiBundle(orgId: string, documentId: string): { bundleId: string; status: "queued" } {
    this.requireDocument(orgId, documentId);
    this.events.push({ eventName: "m22.document.export_requested", documentId });
    return { bundleId: this.newId(), status: "queued" };
  }

  // ── intake batches (reads; the DocLens pipeline + 503 flag land in M22-T08) ──────────────────────────────
  getBatch(orgId: string, batchId: string): IntakeBatchView {
    const b = this.batches.get(batchId);
    if (!b || b.organizationId !== orgId) throw new NotFoundError("intake batch not found");
    return toBatchView(b);
  }

  getReview(orgId: string, reviewId: string): ReviewView {
    const r = this.requireReview(orgId, reviewId);
    return toReviewView(r);
  }

  recordDecision(
    orgId: string,
    reviewId: string,
    decision: { candidateId: string; decisionKind: ExtractionDecisionKind },
  ): ReviewView {
    const r = this.requireReview(orgId, reviewId);
    if (r.status !== "in_progress") throw new ConflictError("review session is not in progress");
    r.decisions.push({ candidateId: decision.candidateId, decisionKind: decision.decisionKind });
    this.events.push({ eventName: "m22.extraction.decision_recorded", documentId: null });
    return toReviewView(r);
  }

  provenanceForTarget(orgId: string, targetModule: ChartTargetModule, targetAggregateId: string): ReadonlyArray<ProvenanceView> {
    return [...this.provenance.values()]
      .filter((p) => p.organizationId === orgId)
      .filter((p) => p.targetModule === targetModule && p.targetAggregateId === targetAggregateId)
      .map(toProvenanceView);
  }

  // ── DocumentAbacResolver (§4.7 — resolves over the same dataset) ─────────────────────────────────────────
  async documentPatient(orgId: string, documentId: string): Promise<{ patientId: string | null } | null> {
    const doc = this.documents.get(documentId);
    if (!doc || doc.organizationId !== orgId) return null;
    return { patientId: doc.patientId };
  }
  async isInCaseload(_orgId: string, userId: string, patientId: string): Promise<boolean> {
    return this.caseload.has(caseloadKey(userId, patientId));
  }
  async hasActiveLegalHold(orgId: string, documentId: string): Promise<boolean> {
    return this.legalHolds.some((h) => h.organizationId === orgId && h.documentId === documentId && h.active);
  }
  async admissionWindow(
    orgId: string,
    documentId: string,
  ): Promise<{ postDischarge: boolean; withinWindow: boolean } | null> {
    const w = this.admissionWindows.get(documentId);
    if (!w || w.organizationId !== orgId) {
      // No window fact recorded → treat as a non-post-discharge document (the predicate then passes through).
      return this.documents.has(documentId) ? { postDischarge: false, withinWindow: true } : null;
    }
    return { postDischarge: w.postDischarge, withinWindow: w.withinWindow };
  }
  async candidateRiskLevel(orgId: string, candidateId: string): Promise<ExtractionCandidateRiskLevel | null> {
    const c = this.candidates.get(candidateId);
    if (!c || c.organizationId !== orgId) return null;
    return c.riskLevel;
  }
  async reviewScopeHasHighRisk(orgId: string, reviewId: string): Promise<boolean | null> {
    const r = this.reviews.get(reviewId);
    if (!r || r.organizationId !== orgId) return null;
    return [...this.candidates.values()].some(
      (c) => c.organizationId === orgId && c.reviewId === reviewId && c.riskLevel === "high",
    );
  }

  // ── internals ───────────────────────────────────────────────────────────────────────────────────────────
  private requireDocument(orgId: string, documentId: string): DocumentRecord {
    const doc = this.documents.get(documentId);
    if (!doc || doc.organizationId !== orgId) throw new NotFoundError("document not found");
    if (doc.status === "destroyed_tombstone") throw new ForbiddenError("document has been destroyed");
    return doc;
  }
  private requireReview(orgId: string, reviewId: string): ReviewRecord {
    const r = this.reviews.get(reviewId);
    if (!r || r.organizationId !== orgId) throw new NotFoundError("review session not found");
    return r;
  }
}

// ── projections ───────────────────────────────────────────────────────────────────────────────────────────
function toVersionView(v: VersionRecord): DocumentVersionView {
  return {
    id: v.id,
    versionNumber: v.versionNumber,
    mimeType: v.mimeType,
    byteSize: v.byteSize,
    sha256Hex: v.sha256Hex,
    uploadedByKind: v.uploadedByKind,
    uploadedAt: v.uploadedAt,
  };
}
function toDocumentView(d: DocumentRecord): DocumentView {
  const active = d.versions[d.versions.length - 1];
  return {
    id: d.id,
    organizationId: d.organizationId,
    patientId: d.patientId,
    admissionId: d.admissionId,
    retentionClass: d.retentionClass,
    sourceKind: d.sourceKind,
    aggregateType: d.aggregateType,
    aggregateId: d.aggregateId,
    title: d.title,
    patientFacing: d.patientFacing,
    attachToDisclosures: d.attachToDisclosures,
    status: d.status,
    activeVersion: active ? toVersionView(active) : null,
    versionsCount: d.versions.length,
    tags: d.tags.map((t) => ({ ...t })),
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
  };
}
function toBatchView(b: BatchRecord): IntakeBatchView {
  return {
    id: b.id,
    organizationId: b.organizationId,
    patientId: b.patientId,
    status: b.status,
    pageCount: b.pageCount,
    createdAt: b.createdAt,
  };
}
function toReviewView(r: ReviewRecord): ReviewView {
  return {
    id: r.id,
    intakeBatchId: r.intakeBatchId,
    status: r.status,
    reviewerMembershipId: r.reviewerMembershipId,
    decisionsCount: r.decisions.length,
  };
}
function toProvenanceView(p: ProvenanceRow): ProvenanceView {
  return {
    id: p.id,
    targetModule: p.targetModule,
    targetAggregateId: p.targetAggregateId,
    targetFieldPath: p.targetFieldPath,
    sourceDocumentId: p.sourceDocumentId,
    decisionKind: p.decisionKind,
    committedAt: p.committedAt,
  };
}
