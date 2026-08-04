// apps/backend/src/modules/32-ai-platform/seams — M32's seam boundary (§4.2–§4.4, M32-T06).
//
//   · ./consumed        the §4.3 accessors for the seams M32 READS
//   · ./published       the §4.2 seam implementations, over the M32-T04 invocation pipeline
//   · ./boot-validators the five §4.4 step-6 boot invariants
//
// `registerAiPlatformSeams` is §4.4's step 4 + 5: it stands M32's eleven real implementations and the
// §4.5 `AIPromptRegistry` over their boot deny-stubs, driven from the composition root's
// `wireModuleSeams()` and therefore before `validateSeams()`.
//
// ── WITHOUT AN INVOCATION PIPELINE THIS REGISTERS ONLY THE PROMPT REGISTRY ───────────────────────
//
// The M19/M20 precedent is "no store ⇒ register nothing", and the reason there was that an in-memory
// slice would manufacture a reassuring answer ("nobody is uncovered") out of a missing database. M32's
// direction is the same but the split is finer, because its eleven seams do not all have that failure
// mode:
//
//   · the ten INFERENCE seams register only with a pipeline. Without one there is no gate chain, no
//     `ai_invocation` ledger and no way to record a disclosure — and a seam that answered without
//     recording would be the §164.528 hole §3.5 is built to prevent. The deny-stubs already refuse with
//     a value, so nothing downstream breaks; M8 falls back to Layer 1 exactly as it would have.
//   · the `AIPromptRegistry` registers whenever a registry instance is supplied, INDEPENDENTLY of the
//     pipeline, and this asymmetry is the point. It is not an inference surface: it is the D18 query six
//     other modules' boot validators run to prove no contraband prompt exists. Its deny-stub THROWS, so
//     leaving it unregistered because the AI pipeline happens to be unwired would take down M12, M13,
//     M18, M21, M27 and M28 at boot over a fact none of them asked about.
import type { AIPromptRegistry } from "@wardenx/ai-platform";

import { registerSeam } from "../../../bootstrap/index";
import type { AiInvocationPipeline } from "../invocation/service";
import {
  type AiPublishedSeamDeps,
  type AiSeamActorResolver,
  type AiSeamOutputProjector,
  createBereavementRiskNarrativeProvider,
  createCopilotProvider,
  createDenialOutcomePredictionProvider,
  createDocLensClassifier,
  createDocLensExtractor,
  createDocLensSudDetector,
  createDocLensVisionVerifier,
  createEmbeddingsProvider,
  createHospitalizationRiskProvider,
  createNarrativeEnhancementProvider,
  createProtocolSuggestionProvider,
  createSemanticSearchProvider,
} from "./published";

export {
  type AiAlertBusView,
  type AiTerminologyView,
  getAiAlertBus,
  getAiTerminologyProvider,
  getBereavementRiskFactorsProvider,
  getHopeJ2051Provider,
  getSafetyIncidentReader,
  getScaleSeriesProvider,
  getSessionContextResolver,
} from "./consumed";
export {
  AiBootValidationError,
  type AiBootValidatorDeps,
  type AiBootValidators,
  createAiBootValidators,
} from "./boot-validators";
export {
  type AiPublishedSeamDeps,
  type AiSeamActorContext,
  type AiSeamActorResolver,
  type AiSeamOutputProjector,
  createBereavementRiskNarrativeProvider,
  createCopilotProvider,
  createDenialOutcomePredictionProvider,
  createDenyingAiSeamActorResolver,
  createDocLensClassifier,
  createDocLensExtractor,
  createDocLensSudDetector,
  createDocLensVisionVerifier,
  createEmbeddingsProvider,
  createHospitalizationRiskProvider,
  createNarrativeEnhancementProvider,
  createProtocolSuggestionProvider,
  createSemanticSearchProvider,
} from "./published";

/** Deps for M32's §4.4 step-4/5 seam registration. */
export interface AiPlatformSeamDeps {
  /** The §4.1 `aiSdk.invoke` pipeline. Absent ⇒ the ten inference seams keep their deny-stubs. */
  pipeline?: AiInvocationPipeline;
  /** The §4.5 registry. Absent ⇒ `AIPromptRegistry` keeps its THROWING deny-stub (see the header). */
  promptRegistry?: AIPromptRegistry;
  /** ARCH-011 — resolves a seam caller to the provider entity `ai_invocation` requires. Unbound ⇒ refuse. */
  actors?: AiSeamActorResolver;
  /** §2.5 output shaping. Unbound ⇒ a completed invocation refuses rather than guessing a shape. */
  projector?: AiSeamOutputProjector;
  now?: () => Date;
}

/**
 * §4.4 steps 4 + 5 — publish M32's seams into the M1 registry over their boot deny-stubs.
 *
 * Called by the composition root's `wireModuleSeams()`, before `validateSeams()`. Idempotent: a second
 * call replaces the registrations with equivalent ones.
 */
export function registerAiPlatformSeams(deps: AiPlatformSeamDeps = {}): void {
  if (deps.promptRegistry !== undefined) {
    registerSeam("AIPromptRegistry", deps.promptRegistry);
  }

  const pipeline = deps.pipeline;
  if (pipeline === undefined) return;

  const seamDeps: AiPublishedSeamDeps = {
    pipeline,
    ...(deps.actors === undefined ? {} : { actors: deps.actors }),
    ...(deps.projector === undefined ? {} : { projector: deps.projector }),
    ...(deps.now === undefined ? {} : { now: deps.now }),
  };

  registerSeam("NarrativeEnhancementProvider", createNarrativeEnhancementProvider(seamDeps));
  registerSeam("DocLensClassifier", createDocLensClassifier(seamDeps));
  registerSeam("DocLensExtractor", createDocLensExtractor(seamDeps));
  registerSeam("DocLensVisionVerifier", createDocLensVisionVerifier(seamDeps));
  registerSeam("DocLensSudDetector", createDocLensSudDetector(seamDeps));
  registerSeam(
    "BereavementRiskNarrativeProvider",
    createBereavementRiskNarrativeProvider(seamDeps),
  );
  registerSeam("DenialOutcomePredictionProvider", createDenialOutcomePredictionProvider(seamDeps));
  registerSeam("EmbeddingsProvider", createEmbeddingsProvider(seamDeps));
  registerSeam("SemanticSearchProvider", createSemanticSearchProvider(seamDeps));
  registerSeam("CopilotProvider", createCopilotProvider(seamDeps));
  // The two M19-owned contract names. M32 registers OVER the leaf-typed deny-stubs M19-T01 declared;
  // it does not publish a second interface for the same seam.
  registerSeam("ProtocolSuggestionProvider", createProtocolSuggestionProvider(seamDeps));
  registerSeam("HospitalizationRiskProvider", createHospitalizationRiskProvider(seamDeps));
}
