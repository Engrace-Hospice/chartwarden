// @wardenx/types — Module 22 (Document Management) leaf contracts (M22-T01).
//
// Per ADR-0005 D1/D3 the cross-module CONTRACTS live in this leaf package: the M22 spec's
// `packages/domain/documents/{seam-interfaces,document-kind,render-payload-types}.ts` resolve their TYPE
// surface HERE so the downstream consumers (every source module's `m22-document-backref.ts` render
// handshake; M28 FHIR DocumentReference/Provenance projection; M30 HQRP AI-governance provenance signal;
// M31 portal document list; M33 reporting) import them with no `dependsOn` edge. The runtime impls + the
// M1 seam-registry wiring land in M22-T04/T05 (the five published reader seams); the outbox dispatch + M36
// alert assembly land in M22-T06. The form-render adapters live in `@wardenx/forms`; the DocLens extraction
// schemas in `@wardenx/intake-extraction` (the §25.14 adapter-mandate boundaries), not here.
//
// M22-T01 ships the type-level surface every later M22 task builds on: the §3.2 pgEnum value mirrors, the
// §4.10 `m22.*` outbox event names, the §3.6 audit denylists (the M4 trigger arguments for M22-T02), the §3.7
// eraser data-class keys, the §4.9 typed M36 alert payloads, the §4.3 published-seam interfaces + their read
// DTOs. This file is type-only and importable by everyone with no edge.

// ── Leaf-safe shared id aliases (single definition site elsewhere; imported for internal use only so the
// package surface stays unambiguous under `export *` — re-exporting would be a TS2308 collision) ───────
import type { PatientId, OrgId } from "./admission";
import type { MembershipId, IsoInstant } from "./care-plan";

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

/** §2.3 retention anchor (mirrors `document_retention_class`). `compliance_42cfr_part2` is M4-0035-owned. */
export type DocumentRetentionClass =
  | "compliance"
  | "clinical_record"
  | "bereavement"
  | "operational"
  | "intake_artifact"
  | "compliance_42cfr_part2";

/** §2.1 provenance of a stored document (mirrors `document_source_kind`). */
export type DocumentSourceKind =
  | "form_render"
  | "user_upload"
  | "api_ingest"
  | "fax_ingest"
  | "portal_upload"
  | "extraction_writeback"
  | "consent_capture";

/** §4.5 form-template / chart-artifact taxonomy (mirrors `document_aggregate_type`). */
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

/** §2.2.1 document lifecycle (mirrors `document_status`). */
export type DocumentStatus = "active" | "superseded" | "legal_hold" | "destroyed_tombstone";

/** §3.3 render adapter selector (mirrors `form_render_engine`). */
export type FormRenderEngine = "react_pdf" | "puppeteer";

/** §2.2.4 D6 render lifecycle (mirrors `form_fill_status`). */
export type FormFillStatus = "queued" | "rendering" | "rendered" | "failed" | "delivered";

/** §2.2.5 multi-doc intake-pipeline machine (mirrors `intake_batch_status`). */
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

/** §2.1 per-page classifier output (mirrors `classified_page_doc_type`). */
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

/** §2.2.6 DocLens job machine (mirrors `extraction_job_status`). */
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

/** §2.3 high-risk-field gate (mirrors `extraction_candidate_risk_level`). */
export type ExtractionCandidateRiskLevel = "low" | "medium" | "high";

/** §2.1 typed-value discriminator (mirrors `extraction_candidate_field_kind`). */
export type ExtractionCandidateFieldKind = "text" | "code" | "date" | "boolean" | "measurement" | "enum";

/** §2.1 coding system for a `code`-kind candidate (mirrors `extraction_candidate_code_system`). */
export type ExtractionCandidateCodeSystem = "rxnorm" | "icd10" | "loinc" | "snomed" | "ndc" | "none";

/** §2.3 discrepancy classifier (mirrors `extraction_discrepancy_kind`). */
export type ExtractionDiscrepancyKind = "cross_source" | "chart_existing";

/** §2.1 discrepancy resolution flag (mirrors `extraction_discrepancy_status`). */
export type ExtractionDiscrepancyStatus = "open" | "resolved";

/** §2.3 per-candidate reviewer disposition (mirrors `extraction_decision_kind`). */
export type ExtractionDecisionKind = "approve" | "approve_with_edit" | "reject";

/** §2.2.7 single-reviewer-per-batch session machine (mirrors `extraction_review_status`). */
export type ExtractionReviewStatus = "in_progress" | "complete" | "abandoned";

/** §4.10 writeback discriminator (mirrors `chart_target_module`). */
export type ChartTargetModule = "m5" | "m7" | "m9" | "m11" | "m12" | "m13" | "m22" | "m40";

/** §3.6 / §164.528 access classifier (mirrors `document_access_kind`). */
export type DocumentAccessKind =
  | "metadata_read"
  | "content_download"
  | "signed_url_issued"
  | "signed_url_consumed"
  | "portal_view"
  | "disclosure_export";

/** §4.2 access-purpose taxonomy (mirrors `document_access_purpose`). */
export type DocumentAccessPurpose =
  | "treatment"
  | "payment"
  | "operations"
  | "disclosure"
  | "patient_access"
  | "amendment_review"
  | "survey_export";

// ── §3.3 owned-table names + §3.6 audit denylist (the M4 trigger arguments for M22-T02) ───────────────

/** The seventeen §3.3 owned tables (the manifest `ownedTables` set). */
export type M22TableName =
  | "classified_page"
  | "document"
  | "document_access_log"
  | "document_legal_hold"
  | "document_tag"
  | "document_version"
  | "extraction_candidate"
  | "extraction_decision"
  | "extraction_discrepancy"
  | "extraction_job"
  | "extraction_provenance"
  | "extraction_review"
  | "form_fill"
  | "form_template"
  | "form_template_version"
  | "intake_upload_batch"
  | "tenant_template_overlay";

/** Per-table audit denylist (§3.6, M11 D11 / M22 §3.6 pattern). Free-text PHI / encrypted ciphertext /
 * structural-PHI columns that must NOT enter `audit_event.before/after` values — the M4 trigger records a
 * `<scrubbed:N chars>` marker instead. The original lives in-row, encrypted at rest (M1 §17). Tables with
 * no PHI/ciphertext columns carry an empty denylist. */
export const M22_AUDIT_DENYLIST: { readonly [K in M22TableName]: readonly string[] } = {
  document: ["title"],
  document_version: ["byte_payload_cipher", "minio_object_key"],
  document_tag: ["tag_value"],
  document_access_log: ["purpose", "recipient_class"],
  form_fill: ["render_payload"],
  intake_upload_batch: ["source_metadata"],
  extraction_candidate: ["value_text", "value_cipher", "vision_disagreement", "source_bounding_box"],
  extraction_discrepancy: ["chart_existing_value", "resolution_value"],
  extraction_decision: ["edited_value", "reason"],
  extraction_provenance: ["source_bounding_box", "target_field_path"],
  tenant_template_overlay: ["branding", "state_addendum"],
  form_template_version: ["payload_schema"],
  classified_page: [],
  document_legal_hold: [],
  extraction_job: [],
  extraction_review: [],
  form_template: [],
} as const;

/** The two M4 destruction-workflow data classes M22 registers at boot (§3.7, ARCH-234 boot-validated keys).
 * `documents` erases stored documents + versions (cryptographic-shred per-tenant DEK; tombstone the row;
 * §164.528 access-log floor preserved per ADR-0013). `intake_extraction` drops raw-upload / DocLens
 * byproducts for `intake_artifact`-class batches past disposition+30d (provenance rows survive). */
export const M22_DATA_CLASSES = ["documents", "intake_extraction"] as const;

/** An M22 eraser data-class key (§3.7). */
export type M22DataClass = (typeof M22_DATA_CLASSES)[number];

// ── §4.10 outbox event names (the canonical wire identifiers the dispatcher + arch:gaps validate) ─────

/** The full §4.10 M22 outbox taxonomy, in canonical `m22.<resource>.<verb>` form. `m22.document.rendered`
 * is the single canonical render-handshake return signal every source module's `m22-document-backref.ts`
 * consumes (closing the M6/M9/M11/M12/M13 PDF stubs + M39's Wave-C deny-stub); the critical-results lane
 * additionally emits `m22.document.rendered_critical_results` (D22). Full publication + subscription wiring
 * lands in M22-T06. */
export const M22_EVENT_NAMES = [
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
  "m22.eraser.legal_hold_skip",
  "m22.eraser.completed",
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
  "m22.extraction.job_ready_for_review",
  "m22.extraction.review_required",
  "m22.extraction.discrepancy_detected",
  "m22.extraction.review_opened",
  "m22.extraction.review_completed",
  "m22.extraction.commit_requested",
  "m22.extraction.commit_completed",
  "m22.extraction.commit_failed",
  "m22.form_template.published",
  "m22.tenant_overlay.published",
  "m22.signed_url.issued",
  "m22.signed_url.consumed",
  "m22.phi_bundle.exported",
  "m22.media.disclosure_restricted",
] as const;

/** An M22 outbox event name (§4.10). */
export type M22EventName = (typeof M22_EVENT_NAMES)[number];

// ── §4.9 M36 typed alert payloads (the deterministic messages M22 emits; M36 owns delivery per ADR-0024) ─
// Out-of-band channels carry NO PHI; the in-app render resolves recipient PHI per permission scope. The
// `kind` discriminator is the §4.9 alert key.

/** The §4.9 discriminated union of every typed alert M22 emits to M36. */
export type DocumentAlertPayload =
  | {
      readonly kind: "m22.document.render_failed";
      readonly severity: "critical";
      readonly aggregateType: DocumentAggregateType;
      readonly aggregateId: string;
      readonly formFillId: FormFillId;
      readonly failureReason: string;
      readonly retryCount: number;
    }
  | {
      readonly kind: "m22.extraction.review_required";
      readonly severity: "info";
      readonly intakeBatchId: IntakeUploadBatchId;
      readonly candidatesTotal: number;
      readonly patientId: PatientId | null;
    }
  | {
      readonly kind: "extraction.review_overdue_8h";
      readonly severity: "warn";
      readonly intakeBatchId: IntakeUploadBatchId;
      readonly hoursOpen: number;
      readonly patientId: PatientId | null;
    }
  | {
      readonly kind: "m22.extraction.discrepancy_detected";
      readonly severity: "warn";
      readonly intakeBatchId: IntakeUploadBatchId;
      readonly discrepancyId: ExtractionDiscrepancyId;
      readonly discrepancyKind: ExtractionDiscrepancyKind;
      readonly fieldPath: string;
    }
  | {
      readonly kind: "m22.extraction.chart_overwrite_required";
      readonly severity: "warn";
      readonly intakeBatchId: IntakeUploadBatchId;
      readonly discrepancyId: ExtractionDiscrepancyId;
      readonly fieldPath: string;
      readonly targetModule: ChartTargetModule;
    }
  | {
      readonly kind: "extraction.sud_detected";
      readonly severity: "warn";
      readonly intakeBatchId: IntakeUploadBatchId;
      readonly patientId: PatientId;
      readonly candidateCount: number;
      readonly suggestedSudKind: string;
    }
  | {
      readonly kind: "extraction.high_risk_field_failed_verification";
      readonly severity: "warn";
      readonly intakeBatchId: IntakeUploadBatchId;
      readonly candidateId: ExtractionCandidateId;
      readonly fieldPath: string;
      readonly visionDisagreement: string;
    }
  | {
      readonly kind: "m22.document.legal_hold_applied";
      readonly severity: "info";
      readonly documentId: DocumentId;
      readonly legalHoldEventId: string;
    }
  | {
      readonly kind: "document.retention_destruction_pending";
      readonly severity: "info";
      readonly documentId: DocumentId;
      readonly retentionClass: DocumentRetentionClass;
      readonly scheduledFor: IsoInstant;
    }
  | {
      readonly kind: "document.phi_bundle_exported";
      readonly severity: "warn";
      readonly documentBundleId: string;
      readonly patientId: PatientId;
      readonly exportedByMembershipId: MembershipId;
      readonly recipientClass: string;
    }
  | {
      readonly kind: "intake.classifier_uncertain";
      readonly severity: "warn";
      readonly intakeBatchId: IntakeUploadBatchId;
      readonly pagesWithUnknownType: number;
      readonly lowestConfidence: number;
    }
  | {
      readonly kind: "intake.classifier_unsupported_type";
      readonly severity: "info";
      readonly intakeBatchId: IntakeUploadBatchId;
      readonly pagesWithUnsupportedType: number;
    }
  | {
      readonly kind: "m22.form_template.published";
      readonly severity: "info";
      readonly templateKey: string;
      readonly versionLabel: string;
    }
  | {
      readonly kind: "m22.tenant_overlay.published";
      readonly severity: "info";
      readonly templateKey: string;
      readonly overlayId: TenantTemplateOverlayId;
    };

// ── §4.3 published-seam read DTOs (read-only projections; never Drizzle rows) ──────────────────────────

/** §4.3 — the document metadata projection M28 (FHIR DocumentReference), M31 (portal list), and M33
 * (reporting) read via `DocumentReader`. Carries no document bytes — content fetch is a separate
 * signed-URL path gated by `documents.download` + read-audit. */
export interface DocumentDigest {
  readonly id: DocumentId;
  readonly organizationId: OrgId;
  readonly patientId: PatientId | null;
  readonly aggregateType: DocumentAggregateType;
  readonly aggregateId: string | null;
  readonly title: string;
  readonly retentionClass: DocumentRetentionClass;
  readonly sourceKind: DocumentSourceKind;
  readonly status: DocumentStatus;
  readonly patientFacing: boolean;
  readonly activeVersionId: DocumentVersionId | null;
  readonly versionNumber: number | null;
  readonly mimeType: string | null;
  readonly byteSize: number | null;
  readonly sha256Hex: string | null;
  readonly versionsCount: number;
  readonly createdAt: IsoInstant;
  readonly updatedAt: IsoInstant;
}

/** §4.3 — the portal-safe document projection (internal-only tags stripped; SUD content consent-filtered). */
export interface PortalDocumentDigest {
  readonly id: DocumentId;
  readonly aggregateType: DocumentAggregateType;
  readonly title: string;
  readonly activeVersionId: DocumentVersionId;
  readonly mimeType: string;
  readonly byteSize: number;
  readonly renderedAt: IsoInstant;
}

/** §4.3 — the intake-pipeline throughput aggregate M33 reporting + M30 quality measures read. */
export interface IntakeMetrics {
  readonly batchesProcessed: number;
  readonly batchesInReview: number;
  readonly batchesWritebackComplete: number;
  readonly batchesDiscarded: number;
  readonly candidatesTotal: number;
  readonly candidatesApproved: number;
  readonly candidatesRejected: number;
  readonly discrepanciesOpen: number;
  readonly averageTimeToReviewMinutes: number;
}

/** §4.3 — a single per-chart-field extraction provenance projection M28 (FHIR Provenance) + M30 (HQRP
 * AI-governance signal) read. Provenance is itself a compliance-class record (AI Governance §8.3). */
export interface ProvenanceRecord {
  readonly id: ExtractionProvenanceId;
  readonly targetModule: ChartTargetModule;
  readonly targetAggregateId: string | null;
  readonly targetFieldPath: string;
  readonly sourceDocumentId: DocumentId;
  readonly sourceDocumentVersionId: DocumentVersionId | null;
  readonly decisionKind: ExtractionDecisionKind;
  readonly reviewerMembershipId: MembershipId;
  readonly extractedAt: IsoInstant;
  readonly committedAt: IsoInstant | null;
}

// ── §4.3 seams this module publishes (impls injected at boot in M22-T04/T05; type-checked at boot) ─────

/** §4.3 — the render-handshake return read every source module's `m22-document-backref.ts` consumes to
 * apply the back-ref `document_id` to its own row. */
export interface RenderedDocumentProvider {
  getRenderedDocumentForAggregate(args: {
    aggregateType: DocumentAggregateType;
    aggregateId: string;
    organizationId: OrgId;
  }): Promise<{ documentId: DocumentId; versionId: DocumentVersionId; renderedAt: IsoInstant } | null>;
}

/** §4.3 — the document-metadata reader M28 (FHIR DocumentReference), M31 (portal), M33 (reporting) use. */
export interface DocumentReader {
  documentsForPatient(args: {
    patientId: PatientId;
    organizationId: OrgId;
    aggregateType?: DocumentAggregateType;
    sinceCursor?: string;
    limit?: number;
  }): Promise<ReadonlyArray<DocumentDigest>>;
  documentMetadata(args: {
    documentId: DocumentId;
    organizationId: OrgId;
  }): Promise<DocumentDigest | null>;
}

/** §4.3 — the M31-portal reader: strips internal-only tags + filters SUD content per consent; mints a
 * consent- and ownership-checked portal download URL. */
export interface PortalDocumentReader {
  documentsForPatient(args: {
    patientId: PatientId;
    organizationId: OrgId;
    aggregateType?: DocumentAggregateType;
    sinceCursor?: string;
  }): Promise<ReadonlyArray<PortalDocumentDigest>>;
  mintPortalDownloadUrl(args: {
    documentVersionId: DocumentVersionId;
    portalSessionId: string;
    patientId: PatientId;
    organizationId: OrgId;
  }): Promise<
    | { url: string; expiresAt: IsoInstant }
    | { denied: true; reason: "sud_consent_absent" | "not_patient_facing" | "not_owner" }
  >;
}

/** §4.3 — the intake-throughput metrics M33 reporting + M30 quality measures read. */
export interface IntakeMetricsProvider {
  metricsForOrg(args: {
    organizationId: OrgId;
    from: IsoInstant;
    to: IsoInstant;
  }): Promise<IntakeMetrics>;
}

/** §4.3 — the per-chart-field provenance reader M28 (FHIR Provenance) + M30 (HQRP) read. */
export interface ExtractionProvenanceReader {
  provenanceForTargetAggregate(args: {
    targetModule: ChartTargetModule;
    targetAggregateId: string;
    organizationId: OrgId;
  }): Promise<ReadonlyArray<ProvenanceRecord>>;
}
