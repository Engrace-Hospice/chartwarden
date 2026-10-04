// apps/backend/src/modules/32-ai-platform — M32 AI Platform's backend surface.
//
// M32-T02 shipped the §3.7 destruction contract (the two AI-provenance erasers); M32-T03 adds the
// governance layer — the §2.2 capability lifecycle, §3.2.3 calibration publication, §5.3/W4 tenant
// opt-in and §5.4 clinician opt-out — over `@wardenx/ai-platform`'s pure rules. M32-T04 adds the §4.1
// invocation pipeline: the §6 gate order, W8 routing over `ai_model_backend`/`ai_routing_override`, the
// W2 hard token cap over `ai_token_ledger`, and the `ai_invocation` disclosure ledger. M32-T05 adds the
// safety layer — W3's mixed-scope kill switch (which fills the `AiKillSwitchGate` T04 left required and
// unbound), W5's hallucination report → triage → follow-up, §3.2.11's evaluation runs and D10's evidence
// check — plus §4.5's `AIPromptRegistry` over `ai_prompt_template`. M32-T06 adds the seam boundary: the
// eleven §4.2 published seams over that pipeline, the §4.3 consumed-seam accessors, §4.4's registration
// and its five step-6 boot invariants, and D18's AI-prohibited zone registry. M32-T07 adds the HTTP
// surface: the thirty-two §4.1 routes, the twenty-two §4.6 permission keys, the six §4.7 ABAC predicates,
// §4.9's ten typed M36 alert payloads and §4.11's `m32.*` outbox catalog. Phase 1 keeps every capability
// behind `ai.full` OFF, so nothing here executes a model — the routes GOVERN a platform that is not yet
// serving inference, which is the order §2.2 requires (a capability reaches APPROVED only after the
// governance surface that approved it exists).
export * from "./governance/index";
export * from "./invocation/index";
export * from "./safety/index";
export * from "./prompts/index";
export * from "./seams/index";
export * from "./routes/mount";
export {
  type M32RouteServices,
  type M32ReadDeps,
  type M32ReadService,
  type M32WriteActor,
  M32_DEFAULT_SEARCH_WINDOW_DAYS,
  M32_PAGE_SIZES,
  buildDrizzleM32ReadService,
  maskInvocationForActor,
} from "./routes/index";
export {
  type M32AlertPayload,
  type M32AlertType,
  type AiAlertPort,
  M32_ALERT_TYPES,
  M32_SYSTEM_LOCKED_ALERT_TYPES,
  emitAiAlert,
  isAiAlertSuppressible,
} from "./alerts";
export { M32_OUTBOX_EVENTS } from "./events-by-m32";
export {
  type M32PermissionKey,
  M32_CONTRIBUTED_PERMISSIONS,
  M32_PERMISSION_KEY_LIST,
  M32_READ_AUDITED_PERMISSION_KEYS,
  M32_STEP_UP_PERMISSION_KEYS,
} from "./permission-keys";
export {
  type AiPlatformAbacDeps,
  type AiPlatformAbacResolver,
  type M32RegisteredAbacPredicate,
  AI_COMPLIANCE_READER_ROLE_KEYS,
  AI_SAFETY_OWNER_ROLE_KEYS,
  M32_ABAC_PREDICATES,
  buildAiPlatformAbacPredicates,
  denyStubAiPlatformAbacResolver,
  registerAiPlatformAbacPredicates,
} from "./abac-predicates";
export {
  type AiPlatformAbacDrizzleDeps,
  buildDrizzleAiPlatformAbacResolver,
} from "./abac-resolver-drizzle";
export { M32_PLATFORM_JOB_ID, wireM32Tenancy } from "./wiring";
export {
  AI_INTAKE_CAPABILITY_PREFIX,
  AI_PROVENANCE_ERASE_ZERO,
  type AiProvenanceEraseCounts,
  type AiProvenanceEraseOptions,
  type AiProvenanceEraseStore,
  type AiProvenanceEraserDeps,
  type AiProvenanceScope,
  type InMemoryAiProvenanceEraseSeed,
  createAiProvenanceEraser,
  createDrizzleAiProvenanceEraseStore,
  createInMemoryAiProvenanceEraseStore,
  eraseAiProvenance,
  registerAiProvenanceErasers,
} from "./erasers/ai-provenance-eraser";
// F-236 (ADR-0048) — the live AI pipeline: deployment-configured backends (Ollama / Anthropic), their
// health sweep, the per-tenant payload cipher, token budgets, PHI-minimisation rules, the real actor
// resolver, the DocLens output projector and the filesystem prompt reader.
export {
  type AiBackendDeploymentConfig,
  AiBackendConfigError,
  aiBackendConfigFromEnv,
  buildConfiguredModelBackends,
} from "./backends/config";
export { runAiBackendHealthSweep, startAiBackendHealthSweep } from "./backends/health-sweep";
export { buildLiveAiInvocationPipeline } from "./live-pipeline";
export { createAiPayloadCipher, type AiPayloadKeyProvider } from "./invocation/payload-cipher";
export { createOrganizationSettingsAiTokenBudgetResolver } from "./invocation/token-budget-settings";
export { createRuleBasedAiChartContextValidator } from "./invocation/chart-context-rules";
export { createDrizzleAiSeamActorResolver } from "./seams/actor-resolver-drizzle";
export {
  DOCLENS_CLASSIFY_RESPONSE_SCHEMA,
  DOCLENS_DOCUMENT_TYPES,
  DOCLENS_EXTRACT_RESPONSE_SCHEMA,
  createDocLensOutputProjector,
  projectDocLensClassify,
  projectDocLensExtract,
} from "./seams/doclens-projector";
export { composeDocLensExtractPrompt } from "./seams/published";
export { createFilesystemAiPromptArtifactReader } from "./prompts/store";
