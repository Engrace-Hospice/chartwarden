// apps/backend/src/modules/22-documents/extraction — M22-T08 DocLens Phase-1 gate + pipeline wiring.
//
// DocLens (Pillar 3) is built but gated OFF behind `documents.doclens` until M32 binds the real AI capabilities.
// This slice exposes (a) the `503 EXTRACTION_DISABLED` route gate (`./doclens-gate`) and (b) the backend's
// consumption of the `@wardenx/intake-extraction` §7.1 W1 pipeline over the M32 deny-stubs (`./pipeline-runner`).
export {
  type DocLensFeatureFlag,
  ExtractionDisabledError,
  assertDocLensEnabled,
  phase1DocLensFlag,
  requireDocLensEnabled,
} from "./doclens-gate";
export {
  type DocLensPipelineRunner,
  type DocLensPipelineRunnerDeps,
  createDocLensPipelineRunner,
} from "./pipeline-runner";
