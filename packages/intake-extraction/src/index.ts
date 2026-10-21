// @chartwarden/intake-extraction — Module 22 Pillar 3 (DocLens) FEATURE package (M22-T01 domain/layout).
//
// The structured extraction pipeline for inbound patient referral documents. M22-T01 ships the DOMAIN-only
// surface: the ExtractionSchema contract + the 11 v1 document-type registry (§3.1) with the chart-writeback
// dividing line (D5), and the SUD-detection suggested-kind taxonomy (§1.1 / D8). The per-type TypeBox
// schemas, LangExtract prompt templates, the docling client, the discrepancy detector, the SUD flagger,
// the M32 deny-stub adapters, and the seam-registration boot all land in later M22 tasks. Leaf-import only
// (`@chartwarden/types`) — no app/db import on the contract surface; the M32 AI capabilities are reached via
// the M1 seam registry (deny-stubbed until M32 lands), never an Anthropic/Ollama import here (§1.2).

export type {
  ExtractionSchemaDescriptor,
  ExtractionFieldDescriptor,
  IntakeDocumentType,
} from "./schemas/interface";
export {
  INTAKE_DOCUMENT_TYPES,
  EXTRACTION_SCHEMA_REGISTRY,
  findExtractionField,
  findExtractionSchema,
} from "./schemas/registry";
export { SUD_SUGGESTED_KINDS } from "./sud-detection/domain";
export type { SudSuggestedKind } from "./sud-detection/domain";
export {
  SUD_RULES,
  SUD_RULESET_VERSION,
  detectSudIndicators,
  dominantSudCategory,
  lineNamesSudTreatmentMedication,
} from "./sud-detection/flagger";
export type {
  SudIndicator,
  SudIndicatorCategory,
  SudPageInput,
  SudTextBlock,
} from "./sud-detection/flagger";

// §7.1 W1 (M22-T08) — the DocLens extraction pipeline (classify → extract → discrepancy → review →
// decide → provenance) as pure domain + the M32 capability port + Phase-1 deny-stub. Built-not-active:
// the backend gates every entry point behind `documents.doclens` (default OFF → 503 EXTRACTION_DISABLED).
export {
  type CapabilityResult,
  type ChartValue,
  type ClassifiedPage,
  type ClassifiedPageResult,
  type CommitIntent,
  type Discrepancy,
  type DocLensCapabilityPort,
  type ExtractedCandidate,
  type PageRun,
  type PipelineCandidate,
  type PipelineRunInput,
  type PipelineRunResult,
  type ProvenanceRecord,
  type ReviewSession,
  type ReviewerDecision,
  type VisionVerificationResult,
  CAPABILITY_UNAVAILABLE,
  DEFAULT_CLASSIFIER_CONFIDENCE_FLOOR,
  buildProvenance,
  buildReviewSession,
  classifyPages,
  denyStubDocLensCapability,
  detectDiscrepancies,
  groupContiguousRuns,
  mergeVisionVerification,
  planCommitIntents,
  runExtractionPipeline,
  type GroundingBBox,
  type GroundingPage,
  type GroundingResult,
  groundQuote,
  normalizeForMatch,
  type PacketSegment,
  type SegmentBoundary,
  type SplitterBlock,
  type SplitterPage,
  DUPLICATE_THRESHOLD,
  headerDate,
  splitPacket,
} from "./pipeline/index";
// F-238 — ICD-10-CM code scanner + deterministic coding checks.
export {
  type CodeInDocument,
  type CodeToken,
  type CodingCheckInput,
  type CodingFlag,
  type CodingFlagKind,
  type CodingTerminology,
  type IcdCodeFacts,
  type IcdDeprecation,
  type ScanBlock,
  type ScanPage,
  type ScannedCode,
  UNACCEPTABLE_HOSPICE_PRINCIPAL,
  type CodeOnPage,
  type DiagnosisCandidate,
  type GroundedDiagnosis,
  attachCodesToDiagnoses,
  flagsFor,
  findCodeTokens,
  resolveCodeTokens,
  runCodingChecks,
  titleAgreement,
} from "./coding/index";
// F-238 — does each document in a fax belong to the patient it is filed under (two identifiers).
export {
  IDENTITY_SEVERITY,
  compareIdentity,
  identityBlocks,
  normaliseDob,
  normaliseName,
  splitFullName,
  worstIdentity,
  type DocumentIdentity,
  type IdentityField,
  type IdentityStatus,
  type IdentityTarget,
  type IdentityVerdict,
} from "./identity/index";
// F-238 — records requested for a prospect: the cover-sheet code and the inbound matcher.
export {
  RECORDS_REQUEST_ALPHABET,
  RECORDS_REQUEST_PAYLOAD_LENGTH,
  RECORDS_REQUEST_PREFIX,
  findRecordsRequestCodes,
  generateRecordsRequestCode,
  isValidRecordsRequestCode,
  normaliseRecordsRequestCode,
  recordsRequestCheckChar,
} from "./records-request/index";
