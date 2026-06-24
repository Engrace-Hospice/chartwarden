// @wardenx/intake-extraction — Module 22 Pillar 3 (DocLens) FEATURE package (M22-T01 domain/layout).
//
// The structured extraction pipeline for inbound patient referral documents. M22-T01 ships the DOMAIN-only
// surface: the ExtractionSchema contract + the 11 v1 document-type registry (§3.1) with the chart-writeback
// dividing line (D5), and the SUD-detection suggested-kind taxonomy (§1.1 / D8). The per-type TypeBox
// schemas, LangExtract prompt templates, the docling client, the discrepancy detector, the SUD flagger,
// the M32 deny-stub adapters, and the seam-registration boot all land in later M22 tasks. Leaf-import only
// (`@wardenx/types`) — no app/db import on the contract surface; the M32 AI capabilities are reached via
// the M1 seam registry (deny-stubbed until M32 lands), never an Anthropic/Ollama import here (§1.2).

export type {
  ExtractionSchemaDescriptor,
  ExtractionFieldDescriptor,
  IntakeDocumentType,
} from "./schemas/interface";
export {
  INTAKE_DOCUMENT_TYPES,
  EXTRACTION_SCHEMA_REGISTRY,
  findExtractionSchema,
} from "./schemas/registry";
export { SUD_SUGGESTED_KINDS } from "./sud-detection/domain";
export type { SudSuggestedKind } from "./sud-detection/domain";

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
} from "./pipeline/index";
