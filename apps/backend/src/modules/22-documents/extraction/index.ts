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
