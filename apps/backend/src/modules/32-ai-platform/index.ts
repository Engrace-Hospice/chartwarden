// apps/backend/src/modules/32-ai-platform — M32 AI Platform's backend surface.
//
// M32-T02 shipped the §3.7 destruction contract (the two AI-provenance erasers); M32-T03 adds the
// governance layer — the §2.2 capability lifecycle, §3.2.3 calibration publication, §5.3/W4 tenant
// opt-in and §5.4 clinician opt-out — over `@wardenx/ai-platform`'s pure rules. M32-T04 adds the §4.1
// invocation pipeline: the §6 gate order, W8 routing over `ai_model_backend`/`ai_routing_override`, the
// W2 hard token cap over `ai_token_ledger`, and the `ai_invocation` disclosure ledger. Routes (§4.1),
// the published/consumed seams (§4.2–§4.4), the permission keys (§4.6) and the ABAC predicates (§4.7)
// land in M32-T06/T07; Phase 1 keeps every capability behind `ai.full` OFF, so nothing here executes a
// model.
export * from "./governance/index";
export * from "./invocation/index";
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
