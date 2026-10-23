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
  IntakeBatchSudStatus,
  OrgId,
} from "@chartwarden/types";
import { NotFoundError, ChartWardenError } from "@chartwarden/types";
import type { DocumentAbacFacts, DocumentAbacResolver } from "../abac-predicates";
import type { ClinicalWritebackSummary } from "../extraction/writeback-commit-clinical-db";
import type { ExtractionWritebackSummary } from "../extraction/writeback-commit-db";
import type { ExtractionDiagnosisWritebackSummary } from "../extraction/writeback-commit-dx-db";
import type { ExternalRecipientRef } from "../outbox-consumers/decide-document-request";
import { type CursorPage, paginate } from "./concurrency";
import type { SignedUrlObjectFacts, SignedUrlObjectResolver } from "./signed-url-service";

// ── route DTOs (in-memory; the Drizzle adapter projects rows to the SAME shapes) ──────────────────────

/** One tag as a CALLER states it (§3.3) — the shape `POST /documents/:id/tags` and the creation
 *  `tags[]` both carry. `tagValue` is null for a bare key; free-kind values may carry PHI (§3.6). */
export interface DocumentTagInput {
  readonly tagKind: string;
  readonly tagKey: string;
  readonly tagValue: string | null;
}

/** GAP-068 — the bytes of one upload. The route decodes them; the service verifies size/MIME/digest. */
export interface UploadedContent {
  readonly bytes: Uint8Array;
  readonly mimeType: string;
  /** Optional caller-declared SHA-256 (lowercase hex); verified against the server-computed digest. */
  readonly sha256Hex?: string;
}

export interface UploadVersionArgs {
  readonly title?: string;
  readonly content: UploadedContent;
}

export interface UploadDocumentArgs {
  readonly patientId: string | null;
  readonly admissionId: string | null;
  readonly retentionClass: DocumentRetentionClass;
  readonly aggregateType: string;
  readonly aggregateId: string | null;
  readonly title: string;
  readonly patientFacing: boolean;
  /** F-060 — `UploadDocumentRequest` has always declared `tags[]`; the route parsed it and passed it
   *  to nothing, so a document could never actually be BORN with the tags its contract accepts. */
  readonly tags: readonly DocumentTagInput[];
  readonly content: UploadedContent;
}

export interface DocumentProvenanceMetadata {
  /** F-197 (#248) — §7.16/D20/D23's render/integrity flag, not provenance, but the same `document.metadata`
   *  jsonb column carries both (`document.ts`'s own comment: "non-PHI render/integrity metadata: {
   *  sudRedacted?, observationId?, ... }"). Written once at render time (`decide-document-request.ts`'s
   *  `sudRedacted: payload.isSudClass === true`, and the two render-variant paths' identical stamp) and
   *  read at signed-URL MINT time (`signed-url-service.ts`'s `mint()`) to re-check 42 CFR Part 2 consent —
   *  the only reliable SUD-class signal that survives past the original render request, which itself is
   *  long gone by the time a later mint happens. */
  readonly sudRedacted?: boolean;
  readonly documentType?: string;
  readonly sourceChannel?:
    | "email"
    | "fax"
    | "scanned_physical"
    | "manual_upload"
    | "portal"
    | "api";
  readonly receivedAt?: string;
  readonly originalFilename?: string;
  readonly externalMessageId?: string;
  readonly sender?: string;
  readonly faxReference?: string;
  readonly notes?: string;
}

export interface DocumentView {
  readonly id: string;
  readonly organizationId: string;
  readonly patientId: string | null;
  readonly admissionId: string | null;
  readonly retentionClass: DocumentRetentionClass;
  readonly aggregateType: string;
  readonly aggregateId: string | null;
  readonly title: string;
  readonly patientFacing: boolean;
  readonly attachToDisclosures: boolean;
  readonly metadata: DocumentProvenanceMetadata | null;
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
  readonly addedAt: string;
  /** The keyset field `paginate` sorts on — the same instant as `addedAt`, under the name every
   *  other M22 list view publishes it (VersionView/IntakeBatchView do the same off one column). */
  readonly createdAt: string;
}

export interface IntakeBatchView {
  readonly id: string;
  readonly organizationId: string;
  readonly patientId: string | null;
  /** F-238 — the M6 referral these records are for, when filed against one. */
  readonly referralId?: string | null;
  /** F-238 — the outbound records request this batch answers, when linked. */
  readonly recordsRequestId?: string | null;
  readonly status: IntakeBatchStatus;
  readonly uploadedAt: string;
  readonly pages: number;
  readonly createdAt: string;
}

/**
 * One intake batch (fax / email / scanned upload) FILED AGAINST a referral — the referral page's
 * "Records" tab. Counts and statuses only; no extracted value leaves the server here.
 */
export interface ReferralIntakeBatchView {
  readonly id: string;
  readonly referralId: string;
  readonly patientId: string | null;
  readonly status: IntakeBatchStatus;
  readonly sourceChannel: string;
  /** F-238 — the worst per-document identity verdict, null until the batch has been checked. */
  readonly identityStatus: string | null;
  readonly sudStatus: IntakeBatchSudStatus;
  /** F-238 — a records-request code on the fax names another referral / patient (code + kind only). */
  readonly recordsRequestConflict: {
    readonly code: string;
    readonly kind: "code_names_another_referral" | "code_names_another_patient";
  } | null;
  /** Source pages (page geometry, else the highest classified page). */
  readonly pages: number;
  /** Document segments the fax splitter found (classified_page rows). */
  readonly documents: number;
  /** Extracted field candidates across the batch. */
  readonly candidates: number;
  /** The latest extraction review, with how many decisions it holds. */
  readonly review: {
    readonly id: string;
    readonly status: ExtractionReviewStatus;
    readonly decided: number;
  } | null;
  readonly uploadedAt: string;
  readonly createdAt: string;
}

export interface ReviewView {
  readonly id: string;
  readonly batchId: string;
  readonly status: ExtractionReviewStatus;
  readonly createdAt: string;
}

/**
 * Who performed a write (GAP-039). TWO ids, because M22 records them in two different places and they
 * live in different id spaces:
 *   • `userId` — the `user.id`. It becomes `app.user_id`, which M4's audit triggers read into
 *     `audit_event.actor_user_id` (an FK to `user`). Passing a membership id here does not merely
 *     mislabel the actor, it violates that FK.
 *   • `membershipId` — the `organization_membership.id` the M22 `*_by_membership_id` columns record
 *     (`added_by`, `uploaded_by`, `reviewer`, `resolved_by`, `published_by`). Those are plain uuid with
 *     no SQL FK, so a wrong id there is silent.
 *
 * Every write takes this rather than a bare string: the two ids are structurally interchangeable and
 * were once confused here — `openReview` wrote the raw user id into `reviewer_membership_id`.
 * This is the same shape `verified-upload.ts` already threads through the upload path.
 */
/** §4.1 route 20 — one reviewer decision. `editedValue` is the attested value for `approve_with_edit`
 *  (F-235: the writeback commits THIS, never the unedited extraction). */
export interface RecordDecisionArgs {
  readonly candidateId: string;
  readonly decision: string;
  readonly editedValue?: string;
  readonly editedCode?: string;
  readonly chartOverwriteConfirmed?: boolean;
  readonly reason?: string;
}

/** §4.1 route 23 — the completed review plus the chart-writeback it committed (F-235). `writeback` is
 *  absent on an idempotent re-completion and on the in-memory reference backend. */
export interface CompleteReviewResult {
  readonly reviewId: string;
  readonly status: "complete";
  readonly writeback?: ExtractionWritebackSummary;
  /** F-238 — the diagnosis half (→ M7 proposed problems); absent where `writeback` is. */
  readonly diagnosisWriteback?: ExtractionDiagnosisWritebackSummary;
  /** F-238 — the medication-history (M12) / allergy (M5) half of the commit. */
  readonly clinicalWriteback?: ClinicalWritebackSummary;
}

export interface DocumentWriteActor {
  readonly userId: string;
  readonly membershipId: string;
}

/** The §4.1 route service the handlers compose over. Every method is org-scoped (RLS in prod). */
/** GAP-140 — a reviewer's page-range corrections to the classifier output (`ConfirmClassificationRequest`). */
export interface ConfirmClassificationArgs {
  readonly pageRanges?: readonly {
    readonly fromPage: number;
    readonly toPage: number;
    readonly docType: string;
  }[];
}

/** GAP-140 — the overlay body a publish persists (`PublishOverlayRequest`); it was parsed and dropped. */
export interface PublishOverlayContent {
  readonly branding: Record<string, unknown>;
  readonly stateAddendum?: { readonly stateCode: string; readonly addendumText: string };
}

export interface DocumentRouteService {
  uploadDocument(
    organizationId: OrgId,
    actor: DocumentWriteActor,
    args: UploadDocumentArgs,
  ): Promise<DocumentView>;
  uploadVersion(
    organizationId: OrgId,
    actor: DocumentWriteActor,
    documentId: string,
    args: UploadVersionArgs,
  ): Promise<VersionView>;
  getDocument(organizationId: OrgId, documentId: string): Promise<DocumentView>;
  listVersions(
    organizationId: OrgId,
    documentId: string,
    cursor: string | undefined,
    limit: number | undefined,
  ): Promise<CursorPage<VersionView>>;
  getVersion(organizationId: OrgId, documentId: string, versionId: string): Promise<VersionView>;
  listDocuments(
    organizationId: OrgId,
    filter: {
      /** F-023 — patients the actor may see; `null`/absent is org-wide, `[]` lists nothing. Org-level
       *  documents (no patient) are visible only on the org-wide arm. */
      patientScope?: readonly string[] | null;
      patientId?: string;
      aggregateType?: string;
      aggregateId?: string;
      retentionClass?: string;
      /** F-060 — the cross-document tag query `document_tag_org_key_idx` was built for and nothing
       *  ever ran. `tagValue` narrows within a key; a `tagValue` without a `tagKey` is ignored. */
      tagKey?: string;
      tagValue?: string;
    },
    cursor: string | undefined,
    limit: number | undefined,
  ): Promise<CursorPage<DocumentView>>;
  patchDocument(
    organizationId: OrgId,
    actor: DocumentWriteActor,
    documentId: string,
    patch: { title?: string; patientFacing?: boolean; attachToDisclosures?: boolean },
  ): Promise<DocumentView>;
  linkDocument(
    organizationId: OrgId,
    actor: DocumentWriteActor,
    documentId: string,
    patch: { patientId?: string | null; admissionId?: string | null },
  ): Promise<DocumentView>;
  /** F-060 — `document_tag` had two writers and no reader: every tag was invisible on write and
   *  undeletable on reload, because the id the DELETE needs was produced once and never readable. */
  listTags(
    organizationId: OrgId,
    documentId: string,
    cursor: string | undefined,
    limit: number | undefined,
  ): Promise<CursorPage<TagView>>;
  addTag(
    organizationId: OrgId,
    actor: DocumentWriteActor,
    documentId: string,
    tag: { tagKind: string; tagKey: string; tagValue: string | null },
  ): Promise<TagView>;
  removeTag(
    organizationId: OrgId,
    actor: DocumentWriteActor,
    documentId: string,
    tagId: string,
  ): Promise<void>;
  exportPhiBundle(
    organizationId: OrgId,
    actor: DocumentWriteActor,
    args: { patientId: string; purpose: string },
  ): Promise<{ documentBundleId: string }>;
  // intake
  uploadBatch(
    organizationId: OrgId,
    actor: DocumentWriteActor,
    args: {
      patientId: string | null;
      sourceChannel: string;
      sourceMetadata?: string;
      /** F-236 — the filed source document (validated in-org); absent ⇒ legacy placeholder ref. */
      documentId?: string;
      /** F-238 — the referral these records are for (the route validated it through M6). */
      referralId?: string | null;
      /** F-238 — the outbound records request these records answer (route-validated: org, open, referral). */
      recordsRequestId?: string | null;
    },
  ): Promise<IntakeBatchView>;
  getBatch(organizationId: OrgId, batchId: string): Promise<IntakeBatchView>;
  /**
   * The intake batches filed against ONE referral (`intake_upload_batch.referral_id`), newest first.
   * Strictly referral-filed: a batch with no referral whose patient happens to be the referral's
   * resolved patient is NOT included — it was never filed as this referral's records. The route
   * checks the caller can read the referral before calling this.
   */
  listReferralBatches(
    organizationId: OrgId,
    referralId: string,
    cursor: string | undefined,
    limit: number | undefined,
  ): Promise<CursorPage<ReferralIntakeBatchView>>;
  listClassification(
    organizationId: OrgId,
    batchId: string,
    cursor: string | undefined,
    limit: number | undefined,
  ): Promise<CursorPage<{ id: string; createdAt: string; docType: string }>>;
  confirmClassification(
    organizationId: OrgId,
    actor: DocumentWriteActor,
    batchId: string,
    args?: ConfirmClassificationArgs,
  ): Promise<{ batchId: string; status: IntakeBatchStatus }>;
  listJobs(
    organizationId: OrgId,
    batchId: string,
    cursor: string | undefined,
    limit: number | undefined,
  ): Promise<CursorPage<{ id: string; createdAt: string; status: string }>>;
  getJob(
    organizationId: OrgId,
    jobId: string,
    cursor: string | undefined,
    limit: number | undefined,
  ): Promise<{
    id: string;
    candidates: CursorPage<{ id: string; createdAt: string; riskLevel: string }>;
  }>;
  openReview(
    organizationId: OrgId,
    actor: DocumentWriteActor,
    batchId: string,
  ): Promise<ReviewView>;
  getReview(
    organizationId: OrgId,
    reviewId: string,
    cursor: string | undefined,
    limit: number | undefined,
  ): Promise<{
    id: string;
    status: ExtractionReviewStatus;
    decisions: CursorPage<{ id: string; createdAt: string }>;
  }>;
  recordDecision(
    organizationId: OrgId,
    actor: DocumentWriteActor,
    reviewId: string,
    args: RecordDecisionArgs,
  ): Promise<{ decisionId: string }>;
  bulkApprove(
    organizationId: OrgId,
    actor: DocumentWriteActor,
    reviewId: string,
    candidateIds: readonly string[],
  ): Promise<{ bulkApproveBatchId: string; decisionsCreated: number }>;
  resolveDiscrepancy(
    organizationId: OrgId,
    actor: DocumentWriteActor,
    reviewId: string,
    discrepancyId: string,
  ): Promise<{ discrepancyId: string; status: "resolved" }>;
  completeReview(
    organizationId: OrgId,
    actor: DocumentWriteActor,
    reviewId: string,
  ): Promise<CompleteReviewResult>;
  abandonReview(
    organizationId: OrgId,
    actor: DocumentWriteActor,
    reviewId: string,
  ): Promise<{ reviewId: string; status: "abandoned" }>;
  discardBatch(
    organizationId: OrgId,
    actor: DocumentWriteActor,
    batchId: string,
  ): Promise<{ batchId: string; status: "discarded" }>;
  // templates / overlays / admin
  listTemplates(
    organizationId: OrgId,
    cursor: string | undefined,
    limit: number | undefined,
  ): Promise<CursorPage<{ id: string; key: string; createdAt: string }>>;
  getTemplate(
    organizationId: OrgId,
    key: string,
  ): Promise<{ key: string; activeVersionId: string }>;
  getTemplateVersion(
    organizationId: OrgId,
    key: string,
    versionId: string,
  ): Promise<{ key: string; versionId: string }>;
  publishTemplateVersion(
    organizationId: OrgId,
    actor: DocumentWriteActor,
    key: string,
    args: { versionLabel: string },
  ): Promise<{ key: string; versionId: string }>;
  listOverlays(
    organizationId: OrgId,
  ): Promise<{ overlays: { templateKey: string; overlayId: string }[] }>;
  publishOverlay(
    organizationId: OrgId,
    actor: DocumentWriteActor,
    templateKey: string,
    ifVersion: number,
    content: PublishOverlayContent,
  ): Promise<{ overlayId: string; version: number }>;
  getFormFill(organizationId: OrgId, fillId: string): Promise<{ id: string; status: string }>;
  retryRender(
    organizationId: OrgId,
    actor: DocumentWriteActor,
    fillId: string,
  ): Promise<{ id: string; status: "queued" }>;
}

// ── in-memory records + slice ─────────────────────────────────────────────────────────────────────────

interface DocumentRecord {
  id: string;
  organizationId: string;
  patientId: string | null;
  admissionId: string | null;
  retentionClass: DocumentRetentionClass;
  aggregateType: string;
  aggregateId: string | null;
  title: string;
  patientFacing: boolean;
  attachToDisclosures: boolean;
  metadata: DocumentProvenanceMetadata | null;
  status: DocumentStatus;
  version: number;
  createdAt: string;
  updatedAt: string;
  versions: {
    id: string;
    versionNumber: number;
    objectKey: string;
    externalRecipient: ExternalRecipientRef | null;
    createdAt: string;
  }[];
  tags: Map<string, TagView>;
  legalHoldActive: boolean;
}

interface BatchRecord {
  id: string;
  organizationId: string;
  patientId: string | null;
  /** F-238 — the referral the batch was filed against (null ⇒ not referral-filed). */
  referralId: string | null;
  sourceChannel: string;
  sudStatus: IntakeBatchSudStatus;
  identityStatus: string | null;
  status: IntakeBatchStatus;
  pages: number;
  createdAt: string;
  reviews: Map<string, { id: string; status: ExtractionReviewStatus; createdAt: string }>;
}

/** Deterministic, I/O-free seed for the in-memory route service (slice + smoke tests). */
export interface DocumentRouteSeed {
  readonly documents?: ReadonlyArray<
    Partial<DocumentRecord> & { id: string; organizationId: string }
  >;
  readonly batches?: ReadonlyArray<Partial<BatchRecord> & { id: string; organizationId: string }>;
  /** F-237 — extraction candidates' stored risk tiers (candidate id → tier), visible to every review of
   *  the candidate's batch. The slice has no candidate rows otherwise. */
  readonly candidates?: ReadonlyArray<{
    id: string;
    batchId: string;
    riskLevel: "low" | "medium" | "high";
  }>;
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
  aggregateId: r.aggregateId,
  title: r.title,
  patientFacing: r.patientFacing,
  attachToDisclosures: r.attachToDisclosures,
  metadata: r.metadata,
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
      aggregateId: null,
      title: "seed",
      patientFacing: false,
      attachToDisclosures: false,
      metadata: null,
      status: "active",
      version: 0,
      createdAt: now(),
      updatedAt: now(),
      versions: [
        {
          id: uuidFromCounter("d", 1),
          versionNumber: 1,
          objectKey: `documents/seed/${d.id}/v1.pdf`,
          externalRecipient: null,
          createdAt: now(),
        },
      ],
      tags: new Map(),
      legalHoldActive: false,
      ...d,
    } as DocumentRecord);
  }
  for (const b of seed.batches ?? []) {
    batches.set(b.id, {
      patientId: null,
      referralId: null,
      sourceChannel: "fax",
      sudStatus: "not_detected",
      identityStatus: null,
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
  function loadReview(
    organizationId: OrgId,
    reviewId: string,
  ): {
    batch: BatchRecord;
    review: { id: string; status: ExtractionReviewStatus; createdAt: string };
  } {
    const batchId = reviewIndex.get(reviewId);
    const batch = batchId ? batches.get(batchId) : undefined;
    if (!batch || batch.organizationId !== organizationId) throw new NotFoundError("review");
    const review = batch.reviews.get(reviewId);
    if (!review) throw new NotFoundError("review");
    return { batch, review };
  }

  /** Rows already DESC-sorted by `(createdAt, id)` for keyset pagination. */
  const desc = <T extends { createdAt: string; id: string }>(rows: T[]): T[] =>
    [...rows].sort((a, b) =>
      a.createdAt === b.createdAt ? (a.id < b.id ? 1 : -1) : a.createdAt < b.createdAt ? 1 : -1,
    );

  let overlayVersion = 0;

  const service: DocumentRouteService = {
    async uploadDocument(organizationId, _actor, args) {
      const id = uuidFromCounter("c", ++created);
      const rec: DocumentRecord = {
        id,
        organizationId,
        patientId: args.patientId,
        admissionId: args.admissionId,
        retentionClass: args.retentionClass,
        aggregateType: args.aggregateType,
        aggregateId: args.aggregateId,
        title: args.title,
        patientFacing: args.patientFacing,
        attachToDisclosures: false,
        metadata: null,
        status: "active",
        version: 0,
        createdAt: now(),
        updatedAt: now(),
        versions: [
          {
            id: subId(),
            versionNumber: 1,
            objectKey: `documents/${args.patientId ?? "unbound"}/${args.aggregateType}/${id}/v1.pdf`,
            externalRecipient: null,
            createdAt: now(),
          },
        ],
        tags: new Map(),
        legalHoldActive: false,
      };
      // F-060 — a document born with tags is born with REAL ones (previously parsed and dropped).
      for (const t of args.tags) {
        const tagId = subId();
        rec.tags.set(tagId, {
          id: tagId,
          tagKind: t.tagKind,
          tagKey: t.tagKey,
          tagValue: t.tagValue,
          addedAt: rec.createdAt,
          createdAt: rec.createdAt,
        });
      }
      docs.set(id, rec);
      return toDocView(rec);
    },
    async uploadVersion(organizationId, _actor, documentId, _args) {
      const r = loadDoc(organizationId, documentId);
      const versionNumber = r.versions.length + 1;
      const v = {
        id: subId(),
        versionNumber,
        objectKey: `documents/${r.patientId ?? "unbound"}/${r.aggregateType}/${r.id}/v${versionNumber}.pdf`,
        externalRecipient: null,
        createdAt: now(),
      };
      r.versions.push(v);
      r.version += 1;
      r.updatedAt = now();
      return {
        id: v.id,
        documentId: r.id,
        versionNumber,
        mimeType: "application/pdf",
        byteSize: 0,
        uploadedAt: now(),
        createdAt: now(),
      };
    },
    async getDocument(organizationId, documentId) {
      return toDocView(loadDoc(organizationId, documentId));
    },
    async listVersions(organizationId, documentId, cursor, limit) {
      const r = loadDoc(organizationId, documentId);
      const rows = desc(
        r.versions.map((v) => ({
          id: v.id,
          documentId: r.id,
          versionNumber: v.versionNumber,
          mimeType: "application/pdf",
          byteSize: 0,
          uploadedAt: v.createdAt,
          createdAt: v.createdAt,
        })),
      );
      return paginate(rows, cursor, limit);
    },
    async getVersion(organizationId, documentId, versionId) {
      const r = loadDoc(organizationId, documentId);
      const v = r.versions.find((x) => x.id === versionId);
      if (!v) throw new NotFoundError("document version");
      return {
        id: v.id,
        documentId: r.id,
        versionNumber: v.versionNumber,
        mimeType: "application/pdf",
        byteSize: 0,
        uploadedAt: v.createdAt,
        createdAt: v.createdAt,
      };
    },
    async listDocuments(organizationId, filter, cursor, limit) {
      const rows = desc(
        [...docs.values()]
          .filter((r) => r.organizationId === organizationId)
          .filter((r) =>
            filter.patientScope ? r.patientId !== null && filter.patientScope.includes(r.patientId) : true,
          )
          .filter((r) => (filter.patientId ? r.patientId === filter.patientId : true))
          .filter((r) => (filter.aggregateType ? r.aggregateType === filter.aggregateType : true))
          .filter((r) => (filter.aggregateId ? r.aggregateId === filter.aggregateId : true))
          .filter((r) =>
            filter.retentionClass ? r.retentionClass === filter.retentionClass : true,
          )
          .filter((r) =>
            filter.tagKey
              ? [...r.tags.values()].some(
                  (t) =>
                    t.tagKey === filter.tagKey &&
                    (filter.tagValue === undefined || t.tagValue === filter.tagValue),
                )
              : true,
          )
          .map(toDocView),
      );
      return paginate(rows, cursor, limit);
    },
    async patchDocument(organizationId, _actor, documentId, patch) {
      const r = loadDoc(organizationId, documentId);
      if (r.legalHoldActive)
        throw new ChartWardenError(
          "LEGAL_HOLD_ACTIVE",
          "the document is under an active legal hold",
          409,
        );
      if (patch.title !== undefined) r.title = patch.title;
      if (patch.patientFacing !== undefined) r.patientFacing = patch.patientFacing;
      if (patch.attachToDisclosures !== undefined)
        r.attachToDisclosures = patch.attachToDisclosures;
      r.version += 1;
      r.updatedAt = now();
      return toDocView(r);
    },
    async linkDocument(organizationId, _actor, documentId, patch) {
      const r = loadDoc(organizationId, documentId);
      if (r.legalHoldActive)
        throw new ChartWardenError(
          "LEGAL_HOLD_ACTIVE",
          "the document is under an active legal hold",
          409,
        );
      if (patch.patientId === undefined && patch.admissionId === undefined) {
        throw new ChartWardenError("VALIDATION_FAILED", "at least one link field is required", 422);
      }
      if (patch.patientId !== undefined) r.patientId = patch.patientId;
      if (patch.admissionId !== undefined) r.admissionId = patch.admissionId;
      r.version += 1;
      r.updatedAt = now();
      return toDocView(r);
    },
    async listTags(organizationId, documentId, cursor, limit) {
      const r = loadDoc(organizationId, documentId);
      const rows = [...r.tags.values()].sort((a, b) =>
        a.createdAt === b.createdAt
          ? b.id.localeCompare(a.id)
          : b.createdAt.localeCompare(a.createdAt),
      );
      return paginate(rows, cursor, limit);
    },
    async addTag(organizationId, _actor, documentId, tag) {
      const r = loadDoc(organizationId, documentId);
      if (r.legalHoldActive)
        throw new ChartWardenError(
          "LEGAL_HOLD_ACTIVE",
          "the document is under an active legal hold",
          409,
        );
      const id = subId();
      const at = now();
      const view: TagView = {
        id,
        tagKind: tag.tagKind,
        tagKey: tag.tagKey,
        tagValue: tag.tagValue,
        addedAt: at,
        createdAt: at,
      };
      r.tags.set(id, view);
      return view;
    },
    async removeTag(organizationId, _actor, documentId, tagId) {
      const r = loadDoc(organizationId, documentId);
      if (r.legalHoldActive)
        throw new ChartWardenError(
          "LEGAL_HOLD_ACTIVE",
          "the document is under an active legal hold",
          409,
        );
      if (!r.tags.delete(tagId)) throw new NotFoundError("tag");
    },
    async exportPhiBundle(organizationId, _actor, _args) {
      void organizationId;
      return { documentBundleId: subId() };
    },
    async uploadBatch(organizationId, _actor, args) {
      void args.sourceMetadata;
      const id = uuidFromCounter("b", ++created);
      const rec: BatchRecord = {
        id,
        organizationId,
        patientId: args.patientId,
        referralId: args.referralId ?? null,
        sourceChannel: args.sourceChannel,
        sudStatus: "not_detected",
        identityStatus: null,
        status: "uploaded",
        pages: 1,
        createdAt: now(),
        reviews: new Map(),
      };
      batches.set(id, rec);
      return {
        id: rec.id,
        organizationId,
        patientId: rec.patientId,
        referralId: args.referralId ?? null,
        recordsRequestId: args.recordsRequestId ?? null,
        status: rec.status,
        uploadedAt: rec.createdAt,
        pages: rec.pages,
        createdAt: rec.createdAt,
      };
    },
    async getBatch(organizationId, batchId) {
      const r = loadBatch(organizationId, batchId);
      return {
        id: r.id,
        organizationId: r.organizationId,
        patientId: r.patientId,
        status: r.status,
        uploadedAt: r.createdAt,
        pages: r.pages,
        createdAt: r.createdAt,
      };
    },
    async listReferralBatches(organizationId, referralId, cursor, limit) {
      // Strictly referral-filed (see the interface): no patient-id fallback.
      const rows: ReferralIntakeBatchView[] = [...batches.values()]
        .filter((b) => b.organizationId === organizationId && b.referralId === referralId)
        .map((b) => {
          const latest = [...b.reviews.values()].sort((x, y) =>
            y.createdAt.localeCompare(x.createdAt),
          )[0];
          return {
            id: b.id,
            referralId,
            patientId: b.patientId,
            status: b.status,
            sourceChannel: b.sourceChannel,
            identityStatus: b.identityStatus,
            sudStatus: b.sudStatus,
            recordsRequestConflict: null,
            pages: b.pages,
            documents: 0,
            candidates: (seed.candidates ?? []).filter((c) => c.batchId === b.id).length,
            review: latest ? { id: latest.id, status: latest.status, decided: 0 } : null,
            uploadedAt: b.createdAt,
            createdAt: b.createdAt,
          };
        });
      return paginate(desc(rows), cursor, limit);
    },
    async listClassification(organizationId, batchId, cursor, limit) {
      loadBatch(organizationId, batchId);
      const rows = desc([{ id: subId(), createdAt: now(), docType: "discharge_summary" }]);
      return paginate(rows, cursor, limit);
    },
    async confirmClassification(organizationId, _actor, batchId) {
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
    async openReview(organizationId, _actor, batchId) {
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
    async recordDecision(organizationId, _actor, reviewId, _args) {
      loadReview(organizationId, reviewId);
      return { decisionId: subId() };
    },
    async bulkApprove(organizationId, _actor, reviewId, candidateIds) {
      loadReview(organizationId, reviewId);
      return { bulkApproveBatchId: subId(), decisionsCreated: candidateIds.length };
    },
    async resolveDiscrepancy(organizationId, _actor, reviewId, discrepancyId) {
      loadReview(organizationId, reviewId);
      return { discrepancyId, status: "resolved" };
    },
    async completeReview(organizationId, _actor, reviewId) {
      const { batch, review } = loadReview(organizationId, reviewId);
      review.status = "complete";
      batch.status = "writeback_complete";
      return { reviewId: review.id, status: "complete" };
    },
    async abandonReview(organizationId, _actor, reviewId) {
      const { review } = loadReview(organizationId, reviewId);
      review.status = "abandoned";
      return { reviewId: review.id, status: "abandoned" };
    },
    async discardBatch(organizationId, _actor, batchId) {
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
    async publishTemplateVersion(organizationId, _actor, key, _args) {
      void organizationId;
      return { key, versionId: subId() };
    },
    async listOverlays(organizationId) {
      void organizationId;
      return { overlays: [] };
    },
    async publishOverlay(organizationId, _actor, templateKey, ifVersion, _content) {
      void organizationId;
      // §2.5 optimistic concurrency — the caller's If-Match version must match the current.
      if (ifVersion !== overlayVersion) {
        throw new ChartWardenError(
          "VERSION_MISMATCH",
          "the overlay was modified since you read it",
          412,
        );
      }
      overlayVersion += 1;
      void templateKey;
      return { overlayId: subId(), version: overlayVersion };
    },
    async getFormFill(organizationId, fillId) {
      void organizationId;
      return { id: fillId, status: "rendered" };
    },
    async retryRender(organizationId, _actor, fillId) {
      void organizationId;
      return { id: fillId, status: "queued" };
    },
  };

  const candidateRisk = (organizationId: string, reviewId: string, candidateId: string) => {
    const batchId = reviewIndex.get(reviewId);
    const batch = batchId ? batches.get(batchId) : undefined;
    if (!batch || batch.organizationId !== organizationId) return undefined;
    return (seed.candidates ?? []).find((c) => c.id === candidateId && c.batchId === batch.id)
      ?.riskLevel;
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
    async loadReviewCandidateRisks(organizationId, reviewId, candidateIds) {
      const out = new Map<string, "low" | "medium" | "high">();
      for (const id of candidateIds) {
        const risk = candidateRisk(organizationId, reviewId, id);
        if (risk) out.set(id, risk);
      }
      return out;
    },
    async loadDiscrepancyRisk() {
      return null; // the slice models no discrepancy rows
    },
  };

  const objectResolver: SignedUrlObjectResolver = {
    async loadObject({
      organizationId,
      documentId,
      versionId,
    }): Promise<SignedUrlObjectFacts | null> {
      const r = docs.get(documentId);
      if (!r || r.organizationId !== organizationId) return null;
      const v = r.versions.find((x) => x.id === versionId);
      if (!v) return null;
      return {
        objectKey: v.objectKey,
        externalRecipient: v.externalRecipient,
        // F-197 (#248) — §7.16 mint-time SUD-consent re-check facts.
        patientId: r.patientId,
        isSudClass: r.metadata?.sudRedacted === true,
      };
    },
  };

  const inspect: DocumentBackendInspect = {
    documentCount: (organizationId) =>
      [...docs.values()].filter((r) => r.organizationId === organizationId).length,
    legalHoldActive: (documentId) => docs.get(documentId)?.legalHoldActive ?? false,
  };

  return { service, abacResolver, objectResolver, inspect };
}
