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
// and its five step-6 boot invariants, and D18's AI-prohibited zone registry. Routes (§4.1), the
// permission keys (§4.6), the ABAC predicates (§4.7), §4.9's alerts and §4.11's outbox events land in
// M32-T07; Phase 1 keeps every capability behind `ai.full` OFF, so nothing here executes a model.
export * from "./governance/index";
export * from "./invocation/index";
export * from "./safety/index";
export * from "./prompts/index";
export * from "./seams/index";
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
