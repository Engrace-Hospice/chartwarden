// apps/backend/src/modules/22-documents/extraction — M22-T08 the DocLens extraction pipeline wiring,
// BUILT-NOT-ACTIVE behind `documents.doclens` (OFF → 503 EXTRACTION_DISABLED). The pure §7.1 W1 pipeline
// lives in @wardenx/intake-extraction; this dir is the backend composition: the feature-flag gate, the M32
// deny-stub seam consumer, the gated pipeline service, and the gated extraction-trigger routes.
export {
  type DocumentFeatureFlagReader,
  DOCLENS_FLAG,
  EXTRACTION_DISABLED_CODE,
  isDocLensEnabled,
} from "./feature-flag";
export {
  DOCLENS_CAPABILITY_SEAM,
  resolveDocLensCapability,
} from "./doclens-capability";
export {
  type CommitPlan,
  type DocLensPipelineDeps,
  type DocLensPipelineService,
  createDocLensPipelineService,
  extractionDisabled,
} from "./pipeline-service";
export {
  type DocLensCommitReviewBody,
  type DocLensRouteDeps,
  type DocLensRunBatchBody,
  registerDocLensExtractionRoutes,
} from "./extraction-routes";
// F-235 (#248) — the §7.1 W1 steps 11–13 chart writeback (DocLens → M5 demographics; A1 + B).
export {
  type CandidateValueCipher,
  type CandidateValueKeyProvider,
  createCandidateValueCipher,
} from "./candidate-value-cipher";
// F-238 — the coding checks' ICD-10-CM port over M38's TerminologyProvider seam.
export {
  type CodingTerminologyAdapter,
  type M38CodingReader,
  createCodingTerminology,
} from "./coding-terminology";
export {
  type PlannedCommitField,
  type WritebackCandidateFact,
  type WritebackExclusion,
  type WritebackExclusionReason,
  type WritebackPlan,
  planDocLensWriteback,
} from "./writeback-plan";
export {
  type ExtractionOutboxPort,
  type ExtractionWritebackDeps,
  type ExtractionWritebackSummary,
  commitReviewWriteback,
} from "./writeback-commit-db";
export {
  M22_EXTRACTION_BACKREF_CONSUMER,
  buildM22ExtractionBackrefConsumer,
} from "./extraction-backref-consumer";
// F-238 dx-writeback — approved diagnoses → M7 problem PROPOSALS, and the back-ref from M7's reply.
export {
  type DiagnosisCandidateFact,
  type DiagnosisWritebackExclusion,
  type DiagnosisWritebackExclusionReason,
  type DiagnosisWritebackPlan,
  type PlannedDiagnosisCommitField,
  descriptionHasSudWording,
  isDiagnosisFieldPath,
  planDiagnosisWriteback,
} from "./writeback-plan-dx";
export {
  type ExtractionDiagnosisWritebackSummary,
  commitReviewDiagnosisWriteback,
} from "./writeback-commit-dx-db";
export {
  M22_EXTRACTION_DX_BACKREF_CONSUMER,
  buildM22ExtractionDiagnosisBackrefConsumer,
  parseDiagnosisItemKey,
} from "./extraction-dx-backref-consumer";
// F-238 — the medication-history (→ M12) and allergy (→ M5) clinical writeback: pure planner, commit,
// and the back-ref consumer for both replies.
export {
  type ClinicalCandidateFact,
  type ClinicalWritebackExclusion,
  type ClinicalWritebackExclusionReason,
  type ClinicalWritebackPlan,
  type ClinicalWritebackTarget,
  clinicalWritebackTargetOf,
  planDocLensClinicalWriteback,
} from "./writeback-plan-clinical";
export {
  type ClinicalWritebackSummary,
  commitClinicalWriteback,
} from "./writeback-commit-clinical-db";
export {
  M22_EXTRACTION_CLINICAL_BACKREF_CONSUMER,
  buildM22ExtractionClinicalBackrefConsumer,
  parseClinicalReply,
} from "./extraction-clinical-backref-consumer";
// F-236 (ADR-0048) — DocLens stages 2–4 as a background job: Docling client, intake job, its queue.
export {
  type DoclingClient,
  DoclingParseError,
  createHttpDoclingClient,
  createUnboundDoclingClient,
  doclingConfigFromEnv,
  parseDoclingResponse,
} from "./docling-client";
export {
  type DocLensClassifierPort,
  type DocLensExtractorPort,
  type DocLensIntakeDeps,
  type DocLensSudDetectorPort,
  type DocLensVisionVerifierPort,
  VISION_VERIFIED_RISK_LEVELS,
  visionReadingAgrees,
  type DocLensIntakeJob,
  type DocLensIntakeSummary,
  runDocLensIntake,
} from "./intake-job";
export {
  type DocLensIntakeEnqueue,
  M22_DOCLENS_INTAKE_QUEUE,
  createDocLensIntakeEnqueue,
  registerDocLensIntakeWorker,
} from "./intake-queue";
export {
  type ReviewQueueItem,
  type ReviewWorkspace,
  type ReviewWorkspaceDeps,
  type ReviewWorkspaceService,
  type WorkspaceCandidate,
  createReviewWorkspaceService,
  visionStatusOf,
} from "./review-workspace";
export {
  ReviewQueueQuerySchema,
  ReviewQueueResponseSchema,
  ReviewWorkspaceResponseSchema,
  SudReviewRequest,
  SudReviewResponseSchema,
  registerDocLensReviewWorkspaceRoutes,
} from "./review-workspace-routes";
// F-238 — the prospect summary of a completed review (pure builder + DB reader + route).
export {
  type ProspectSummary,
  type ProspectSummaryInput,
  PROSPECT_SUMMARY_NOT_CAPTURED,
  buildProspectSummary,
  formatCitations,
  renderProspectSummaryText,
} from "./prospect-summary";
export {
  type ProspectSummaryDeps,
  type ProspectSummaryService,
  createProspectSummaryService,
} from "./prospect-summary-db";
export {
  PatientIntakeSummariesResponseSchema,
  ProspectSummaryResponseSchema,
  registerDocLensProspectSummaryRoutes,
} from "./prospect-summary-routes";
// F-238 — "an address is waiting in intake review" (counts + batch ids only; never a value).
export {
  DOCLENS_ADDRESS_FIELD_PATHS,
  PENDING_ADDRESS_BATCH_LIMIT,
  type PendingAddressBatch,
  type PendingAddressResult,
  type PendingAddressService,
  createPendingAddressService,
} from "./pending-address-db";
export {
  PendingAddressResponseSchema,
  registerDocLensPendingAddressRoutes,
} from "./pending-address-routes";

// F-238 — per-document identity check (does each document belong to the batch's patient / referral).
export {
  type BatchIdentityResult,
  type BatchIdentityStatus,
  type IdentityTargetPorts,
  createIdentityTargetPorts,
  refreshBatchIdentity,
} from "./batch-identity";
