// @wardenx/ai-platform/seams — §4.2's published seam CONTRACTS + the §4.4 boot-check rules (M32-T06).
//
// Contracts only: not one line here touches a database, a clock or a model. The implementations live in
// `apps/backend/src/modules/32-ai-platform/seams`, over the M32-T04 invocation pipeline.
//
// ── WHY THE INTERFACES LIVE HERE AND NOT IN `@wardenx/types` ─────────────────────────────────────
//
// The rich-seam pattern (M38 `TerminologyProvider`, M36 `AlertEmitter`, M33 `MetricsProvider`, M26
// `CapAccrualReader`): a seam whose contract is rich enough to carry the producer's own vocabulary keeps
// its interface in the producer's feature package and registers into M1's typed registry as `unknown`.
// Consumers that list `32` in their manifest `dependsOn` import the real type from here and resolve the
// instance through a typed accessor; M1 holds and fail-closed-validates it without knowing its shape.
//
// The alternative — leaf-typing all twelve in `@wardenx/types` — would have dragged `NarrativeSurface`,
// the DocLens bbox tuples, the copilot citation shape and the embeddings namespace enum into the leaf
// every module imports, and `leaves-stay-leaves` (ARCHITECTURE §25.15) is the rule that says no.
//
// TWO SEAMS ARE THE EXCEPTION AND THEY ARE NOT DECLARED HERE. `ProtocolSuggestionProvider` and
// `HospitalizationRiskProvider` were leaf-typed in `@wardenx/types`'s `./oncall` by M19-T01, which
// shipped first and locked their shapes (the M15/M17 `VolunteerComplianceProvider` precedent, in the
// direction that precedent teaches). M32 REGISTERS OVER those names; it does not re-declare them. A
// second interface for the same seam is the failure mode, not the fix.
export {
  type AIWarning,
  type AiSeamRefusal,
  aiSeamRefusal,
  aiSeamUnregistered,
} from "./common";
export type {
  NarrativeEnhancementAvailable,
  NarrativeEnhancementInput,
  NarrativeEnhancementProvider,
  NarrativeEnhancementResult,
  NarrativeParentEntityType,
  NarrativeSurface,
} from "./narrative-enhancement";
export type {
  DocLensClassifier,
  DocLensClassifyResult,
  DocLensExtractResult,
  DocLensExtractor,
  DocLensSourceBBox,
  DocLensSudDetector,
  DocLensSudResult,
  DocLensVerifyResult,
  DocLensVisionVerifier,
} from "./doclens";
export type {
  BereavementNarrativeResult,
  BereavementRiskNarrativeInput,
  BereavementRiskNarrativeProvider,
} from "./bereavement-narrative";
export type {
  DenialOutcomePredictionProvider,
  DenialPredictionClaimFeatures,
  DenialPredictionInput,
  DenialPredictionResult,
} from "./denial-prediction";
export type {
  EmbeddingsInput,
  EmbeddingsNamespace,
  EmbeddingsProvider,
  EmbeddingsResult,
} from "./embeddings";
export type {
  SemanticSearchHit,
  SemanticSearchInput,
  SemanticSearchProvider,
  SemanticSearchResult,
} from "./semantic-search";
export type {
  CopilotAskInput,
  CopilotAskResult,
  CopilotCitation,
  CopilotProvider,
  CopilotScope,
} from "./copilot";
export {
  AI_COPILOT_SCOPE_CAPABILITY,
  AI_DOCLENS_CAPABILITY,
  AI_NARRATIVE_SURFACE_CAPABILITY,
  AI_SEAM_CAPABILITY,
  aiCapabilityKeyForNarrativeSurface,
} from "./surface-map";
export {
  AI_PROHIBITED_PREFIXES,
  AI_PROHIBITED_ZONES,
  type AiProhibitedZone,
  type AiProhibitedZoneViolation,
  aiTargetPrefixIsProhibited,
  findAiProhibitedZoneViolations,
  formatAiProhibitedZoneViolations,
} from "./prohibited-zones";
