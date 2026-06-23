// @wardenx/types — Module 22 (Document Management) leaf contracts (M22-T01).
//
// Per ADR-0005 D1/D3 the cross-module CONTRACTS live in this leaf package: the M22 spec's references to
// the §4.3 published-seam interfaces (`packages/domain/documents/seam-interfaces.ts`) and the §4.10 outbox
// event payloads (`packages/types/events/m22.ts`) resolve their TYPE surface HERE so the downstream
// consumers (M28 FHIR projection, M31 portal, M33/M30 reporting + AI-governance, every source module's
// `m22-document-backref.ts`) import them with no `dependsOn` edge. The runtime seam impls + the M1
// seam-registry wiring land in later M22 tasks (§4.3 publishes five reader seams); the outbox dispatch +
// M36 alert assembly land later still.
//
// M22-T01 ships the type-level surface every later M22 task builds on: the §3.2 pgEnum value mirrors, the
// §4.10 `m22.*` outbox event names, the §3.6 per-table audit denylist (the M4 trigger arguments for
// M22-T03), and the §4.3 published reader-seam interfaces + their read DTOs. The two FEATURE packages
// `@wardenx/forms` (Pillar 2 render + form-template domain) and `@wardenx/intake-extraction` (Pillar 3
// DocLens domain) carry the pure-data domain layout. This file is type-only and importable by everyone
// with no edge.

// ── Leaf-safe shared id aliases (single definition site elsewhere; imported for internal use only so the
// package surface stays unambiguous under `export *` — re-exporting would be a TS2308 collision) ───────
import type { PatientId, AdmissionId, OrgId } from "./admission";
import type { IsoInstant } from "./care-plan";

// ── M22-owned id aliases (mirror the §3.3 uuid PKs; packages/types cannot import @wardenx/db) ──────────
export type DocumentId = string;
export type DocumentVersionId = string;
export type DocumentTagId = string;
export type DocumentAccessLogId = string;
export type DocumentLegalHoldId = string;
export type FormTemplateId = string;
export type FormTemplateVersionId = string;
export type TenantTemplateOverlayId = string;
export type FormFillId = string;
export type IntakeUploadBatchId = string;
export type ClassifiedPageId = string;
export type ExtractionJobId = string;
export type ExtractionCandidateId = string;
export type ExtractionDiscrepancyId = string;
export type ExtractionReviewId = string;
export type ExtractionDecisionId = string;
export type ExtractionProvenanceId = string;

// ── §3.2 pgEnum value mirrors (kept in lock-step with `packages/db/src/enums.ts`) ─────────────────────

/** §3.2 / §2.2.1 — the document retention taxonomy (mirrors `document_retention_class`). */
export type DocumentRetentionClass =
  | "compliance"
  | "clinical_record"
  | "bereavement"
  | "operational"
  | "intake_artifact"
  | "compliance_42cfr_part2";

/** §3.2 — how the document entered the platform (mirrors `document_source_kind`). */
export type DocumentSourceKind =
  | "form_render"
  | "user_upload"
  | "api_ingest"
  | "fax_ingest"
  | "portal_upload"
  | "extraction_writeback"
  | "consent_capture";

/** §3.2 — the owning-module artifact a document materializes (mirrors `document_aggregate_type`). */
export type DocumentAggregateType =
  | "election_statement"
  | "cti"
  | "f2f"
  | "nor"
  | "revocation"
  | "discharge_summary"
  | "nomnc"
  | "abn"
  | "hipaa_privacy_notice"
  | "code_status_directive"
  | "encounter"
  | "order_record"
  | "medication_order"
  | "medication_administration_record"
  | "medication_reconciliation_worksheet"
  | "patient_medication_list"
  | "comfort_kit_receipt"
  | "idg_patient_packet"
  | "idg_minutes"
  | "aide_poc"
  | "msw_plan"
  | "spiritual_plan"
  | "volunteer_plan"
  | "bereavement_letter"
  | "visit_confirmation"
  | "evv_verification"
  | "patient_amendment_statement_of_disagreement"
  | "consent_record"
  | "intake_source"
  | "other";

/** §3.2 / §2.2.1 — the document lifecycle (mirrors `document_status`). */
export type DocumentStatus = "active" | "superseded" | "legal_hold" | "destroyed_tombstone";

/** §3.2 — the two render backends (mirrors `form_render_engine`). */
export type FormRenderEngine = "react_pdf" | "puppeteer";

/** §3.2 / §2.2.4 — the render-instance lifecycle (mirrors `form_fill_status`). */
export type FormFillStatus = "queued" | "rendering" | "rendered" | "failed" | "delivered";

/** §3.2 / §2.2.5 — the intake-batch lifecycle incl. F19 split/parse-fail states (mirrors `intake_batch_status`). */
export type IntakeBatchStatus =
  | "uploaded"
  | "docling_complete"
  | "classifier_complete"
  | "extraction_complete"
  | "in_review"
  | "writeback_complete"
  | "discarded"
  | "split_into_children"
  | "split_resolved_no_split"
  | "parse_failed";

/** §3.2 — the per-page classifier output document type (mirrors `classified_page_doc_type`). */
export type ClassifiedPageDocType =
  | "discharge_summary"
  | "med_recon"
  | "hp"
  | "lab"
  | "imaging"
  | "consult"
  | "insurance_card"
  | "photo_id"
  | "advance_directive"
  | "dpoa"
  | "transfer_record"
  | "unknown";

/** §3.2 / §2.2.6 — the extraction-job lifecycle incl. F19 capability states (mirrors `extraction_job_status`). */
export type ExtractionJobStatus =
  | "queued"
  | "extracting"
  | "verifying"
  | "discrepancy_check"
  | "ready_for_review"
  | "in_review"
  | "committed"
  | "discarded"
  | "failed"
  | "awaiting_capability"
  | "stalled";

/** §3.2 — the per-field risk tier that gates bulk-approve (mirrors `extraction_candidate_risk_level`). */
export type ExtractionCandidateRiskLevel = "low" | "medium" | "high";

/** §3.2 — the value shape of an extracted field (mirrors `extraction_candidate_field_kind`). */
export type ExtractionCandidateFieldKind =
  | "text"
  | "code"
  | "date"
  | "boolean"
  | "measurement"
  | "enum";

/** §3.2 — the canonical code system a value resolved to (mirrors `extraction_candidate_code_system`). */
export type ExtractionCandidateCodeSystem = "rxnorm" | "icd10" | "loinc" | "snomed" | "ndc" | "none";

/** §3.2 — cross-source vs chart-existing disagreement (mirrors `extraction_discrepancy_kind`). */
export type ExtractionDiscrepancyKind = "cross_source" | "chart_existing";

/** §3.2 — open/resolved (mirrors `extraction_discrepancy_status`). */
export type ExtractionDiscrepancyStatus = "open" | "resolved";

/** §3.2 — the reviewer's per-field action (mirrors `extraction_decision_kind`). */
export type ExtractionDecisionKind = "approve" | "approve_with_edit" | "reject";

/** §3.2 / §2.2.7 — the review-session lifecycle (mirrors `extraction_review_status`). */
export type ExtractionReviewStatus = "in_progress" | "complete" | "abandoned";

/** §3.2 — the owning module a writeback drafts into (mirrors `chart_target_module`). */
export type ChartTargetModule = "m5" | "m7" | "m9" | "m11" | "m12" | "m13" | "m22" | "m40";

/** §3.2 — the `auditRead` / access-log access classification (mirrors `document_access_kind`). */
export type DocumentAccessKind =
  | "metadata_read"
  | "content_download"
  | "signed_url_issued"
  | "signed_url_consumed"
  | "portal_view"
  | "disclosure_export";

/** §3.2 — the §164.528 accounting-of-disclosures purpose (mirrors `document_access_purpose`). */
export type DocumentAccessPurpose =
  | "treatment"
  | "payment"
  | "operations"
  | "disclosure"
  | "patient_access"
  | "amendment_review"
  | "survey_export";

// ── §3.3 owned-table names + §3.6 audit denylist (the M4 trigger arguments for M22-T03) ───────────────

/** The 17 §3.3 owned tables (the manifest `ownedTables` set). */
export type M22TableName =
  | "document"
  | "document_version"
  | "document_tag"
  | "document_access_log"
  | "document_legal_hold"
  | "form_template"
  | "form_template_version"
  | "tenant_template_overlay"
  | "form_fill"
  | "intake_upload_batch"
  | "classified_page"
  | "extraction_job"
  | "extraction_candidate"
  | "extraction_discrepancy"
  | "extraction_review"
  | "extraction_decision"
  | "extraction_provenance";

/** Per-table audit denylist (§3.6, M11 D11 pattern). Free-text PHI / tenant-confidential / structural
 * columns that must NOT enter `audit_event.before/after` values — the M4 trigger substitutes a
 * `<scrubbed:N chars>` marker instead. Empty array = structural fields only (the table has no denylisted
 * column). Tables absent from the §3.6 table — `classified_page`, `extraction_job` — denylist nothing. */
export const M22_AUDIT_DENYLIST: { readonly [K in M22TableName]: readonly string[] } = {
  document: ["title"],
  document_version: ["byte_payload_cipher", "minio_object_key"],
  document_tag: ["tag_value"],
  document_access_log: ["purpose", "recipient_class"],
  document_legal_hold: [],
  form_template: [],
  form_template_version: ["payload_schema"],
  tenant_template_overlay: ["branding", "state_addendum"],
  form_fill: ["render_payload"],
  intake_upload_batch: ["source_metadata"],
  classified_page: [],
  extraction_job: [],
  extraction_candidate: ["value_text", "value_cipher", "vision_disagreement", "source_bounding_box"],
  extraction_discrepancy: ["chart_existing_value", "resolution_value"],
  extraction_review: [],
  extraction_decision: ["edited_value", "reason"],
  extraction_provenance: ["source_bounding_box", "target_field_path"],
} as const;

// ── §4.10 outbox event names (the canonical wire identifiers the dispatcher + arch:gaps validate) ─────

/** The full §4.10 M22 outbox taxonomy, in canonical `m22.<entity>.<verb>` form. `m22.document.rendered`
 * is the single render-handshake return signal every source module's `m22-document-backref.ts` consumes;
 * `m22.document.rendered_critical_results` is the parallel M36 high-priority push (ADR-0024);
 * `m22.intake.sud_detected` opens M5's interim PrivacyFlag (D8); `m22.extraction.commit_requested` drives
 * the per-candidate chart writeback to M5/M7/M9/M11/M12/M13 (D5). Full publication + subscription wiring
 * lands in later M22 tasks. */
export const M22_EVENT_NAMES = [
  // document spine
  "m22.document.created",
  "m22.document.versioned",
  "m22.document.rendered",
  "m22.document.rendered_critical_results",
  "m22.document.render_failed",
  "m22.document.delivered",
  "m22.document.legal_hold_applied",
  "m22.document.legal_hold_released",
  "m22.document.tombstoned",
  "m22.document.deferred",
  "m22.document.statement_of_disagreement_published",
  // eraser
  "m22.eraser.legal_hold_skip",
  "m22.eraser.completed",
  // intake pipeline
  "m22.intake.uploaded",
  "m22.intake.docling_complete",
  "m22.intake.page_classified",
  "m22.intake.classification_confirmed",
  "m22.intake.multidoc_detected",
  "m22.intake.split_completed",
  "m22.intake.sud_detected",
  "m22.intake.sud_confirmed",
  "m22.intake.sud_rejected",
  "m22.intake.completed",
  "m22.intake.rejected",
  // extraction
  "m22.extraction.job_ready_for_review",
  "m22.extraction.review_required",
  "m22.extraction.discrepancy_detected",
  "m22.extraction.review_opened",
  "m22.extraction.review_completed",
  "m22.extraction.commit_requested",
  "m22.extraction.commit_completed",
  "m22.extraction.commit_failed",
  // templates / overlays
  "m22.form_template.published",
  "m22.tenant_overlay.published",
  // signed URLs / PHI bundle / media
  "m22.signed_url.issued",
  "m22.signed_url.consumed",
  "m22.phi_bundle.exported",
  "m22.media.disclosure_restricted",
] as const;

/** An M22 outbox event name (§4.10). */
export type M22EventName = (typeof M22_EVENT_NAMES)[number];

// ── §4.3 published-seam read DTOs (read-only projections; never Drizzle rows) ──────────────────────────

/** §4.3 — the document digest M28 (FHIR `DocumentReference`), M31 (portal), M33 (reporting) read. No
 * binary; never the byte payload — the bytes are reached via a separately-audited signed URL. */
export interface DocumentDigest {
  readonly documentId: DocumentId;
  readonly organizationId: OrgId;
  readonly patientId: PatientId | null;
  readonly admissionId: AdmissionId | null;
  readonly aggregateType: DocumentAggregateType;
  readonly aggregateId: string | null;
  readonly title: string;
  readonly retentionClass: DocumentRetentionClass;
  readonly status: DocumentStatus;
  readonly patientFacing: boolean;
  readonly activeVersionId: DocumentVersionId | null;
  readonly createdAt: IsoInstant;
  readonly updatedAt: IsoInstant;
}

/** §4.3 — the portal-safe digest (internal-only tags stripped; SUD content filtered per consent by the
 * reader). M31 only ever sees this projection, never {@link DocumentDigest}. */
export interface PortalDocumentDigest {
  readonly documentId: DocumentId;
  readonly aggregateType: DocumentAggregateType;
  readonly title: string;
  readonly activeVersionId: DocumentVersionId | null;
  readonly createdAt: IsoInstant;
}

/** §4.3 — the intake-throughput metrics M33 reporting + M30 quality measures read. */
export interface IntakeMetrics {
  readonly organizationId: OrgId;
  readonly bundlesProcessed: number;
  readonly bundlesInReview: number;
  readonly avgTimeToReviewMinutes: number;
  readonly candidatesApproved: number;
  readonly candidatesRejected: number;
}

/** §4.3 — one per-chart-field provenance record M28 (FHIR Provenance) + M30 (HQRP AI-governance) read. */
export interface ProvenanceRecord {
  readonly provenanceId: ExtractionProvenanceId;
  readonly extractionDecisionId: ExtractionDecisionId;
  readonly extractionCandidateId: ExtractionCandidateId;
  readonly sourceDocumentId: DocumentId;
  readonly sourceDocumentVersionId: DocumentVersionId;
  readonly sourcePage: number;
  readonly targetModule: ChartTargetModule;
  readonly targetFieldPath: string;
  readonly targetAggregateId: string | null;
  readonly classifierModelVersionRef: string;
  readonly extractorModelVersionRef: string;
  readonly visionVerifierModelVersionRef: string | null;
  readonly committedAt: IsoInstant;
}

// ── §4.3 the five seams this module publishes (impls injected at boot in a later M22 task; type-checked
// at boot via the M1 SeamRegistry `validateSeams()` gate) ──────────────────────────────────────────────

/** §4.3 — used by every source module's `m22-document-backref.ts` consumer to resolve the rendered
 * document for one of its aggregates after the render handshake. */
export interface RenderedDocumentProvider {
  getRenderedDocumentForAggregate(args: {
    readonly aggregateType: DocumentAggregateType;
    readonly aggregateId: string;
    readonly organizationId: OrgId;
  }): Promise<{ documentId: DocumentId; versionId: DocumentVersionId; renderedAt: IsoInstant } | null>;
}

/** §4.3 — used by M28 (FHIR `DocumentReference`), M31 (portal list), M33 (reporting). */
export interface DocumentReader {
  documentsForPatient(args: {
    readonly patientId: PatientId;
    readonly organizationId: OrgId;
    readonly aggregateType?: DocumentAggregateType;
    readonly sinceCursor?: string;
    readonly limit?: number;
  }): Promise<ReadonlyArray<DocumentDigest>>;

  documentMetadata(args: {
    readonly documentId: DocumentId;
    readonly organizationId: OrgId;
  }): Promise<DocumentDigest | null>;
}

/** §4.3 — used by M31 portal; strips internal-only tags + filters SUD content per consent. */
export interface PortalDocumentReader {
  documentsForPatient(args: {
    readonly patientId: PatientId;
    readonly organizationId: OrgId;
    readonly aggregateType?: DocumentAggregateType;
    readonly sinceCursor?: string;
  }): Promise<ReadonlyArray<PortalDocumentDigest>>;

  mintPortalDownloadUrl(args: {
    readonly documentVersionId: DocumentVersionId;
    readonly portalSessionId: string;
    readonly patientId: PatientId;
    readonly organizationId: OrgId;
  }): Promise<
    | { url: string; expiresAt: IsoInstant }
    | { denied: true; reason: "sud_consent_absent" | "not_patient_facing" | "not_owner" }
  >;
}

/** §4.3 — used by M33 reporting + M30 quality measures (intake throughput, time-to-review). */
export interface IntakeMetricsProvider {
  metricsForOrg(args: {
    readonly organizationId: OrgId;
    readonly from: IsoInstant;
    readonly to: IsoInstant;
  }): Promise<IntakeMetrics>;
}

/** §4.3 — used by M28 (FHIR Provenance) + M30 (HQRP AI-governance signal): per-chart-field provenance. */
export interface ExtractionProvenanceReader {
  provenanceForTargetAggregate(args: {
    readonly targetModule: ChartTargetModule;
    readonly targetAggregateId: string;
    readonly organizationId: OrgId;
  }): Promise<ReadonlyArray<ProvenanceRecord>>;
}

// ── §2.2 / D1 per-tenant object storage PORT (interface only; the real MinIO client is injected at boot
// in a later M22 task). M22-T03 models storage as a pure planning surface: the lifecycle machines derive
// the per-tenant object key + presign descriptor as DATA; no network IO, no MinIO SDK import here. ───────

/** §11 D11 — the opaque presigned-download descriptor a lifecycle plan returns as data. The object key and
 * filename are PHI-free by construction (`{documentType}-{shortVersionId}.pdf`, the short id a random 12-char
 * token); the human-readable name is applied client-side via `Content-Disposition`, never in the key/URL. */
export interface SignedUrlDescriptor {
  readonly bucket: string;
  readonly objectKey: string;
  readonly ttlSeconds: number;
  readonly accessKind: DocumentAccessKind;
}

/** §11 D1 — the per-tenant object-storage seam. The lifecycle machines compute keys + presign descriptors
 * purely (see {@link deriveTenantBucket} / {@link deriveObjectKey}); the runtime impl (MinIO presign +
 * version-aware delete) is injected at boot. Modeled as a PORT so M22-T03 stays IO-free and unit-testable. */
export interface DocumentStorageProvider {
  /** Mint a short-TTL presigned GET URL for one object version (§4.12; the URL itself is never logged). */
  presignDownload(args: {
    readonly descriptor: SignedUrlDescriptor;
    readonly organizationId: OrgId;
  }): Promise<{ readonly url: string; readonly expiresAt: IsoInstant }>;
  /** Version-aware destruction: delete EVERY object version + delete-marker for the key (D12 / DR-019). */
  destroyAllObjectVersions(args: {
    readonly bucket: string;
    readonly objectKey: string;
    readonly organizationId: OrgId;
  }): Promise<void>;
}

// ── A render-handshake back-ref shape reused across consumers (the §4.10 `m22.document.rendered` payload
// core that every source module's `m22-document-backref.ts` applies to its own row) ────────────────────

/** §2 / §4.10 — the back-ref every source module applies on `m22.document.rendered`. */
export interface DocumentBackRef {
  readonly aggregateType: DocumentAggregateType;
  readonly aggregateId: string;
  readonly documentId: DocumentId;
  readonly versionId: DocumentVersionId;
}

// Shared ids (`MembershipId` reviewer/accessor identity, etc.) are owned + re-exported by the
// `admission.ts` / `care-plan.ts` leaves; M22 DTOs that need them import-not-redefine to avoid a TS2308
// `export *` collision.
