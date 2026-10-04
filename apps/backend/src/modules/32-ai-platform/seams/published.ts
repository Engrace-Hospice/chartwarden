// apps/backend/src/modules/32-ai-platform/seams/published.ts — §4.2's seam IMPLEMENTATIONS (M32-T06).
//
// Eleven thin adapters over the ONE M32-T04 invocation pipeline. Not one of them re-decides a gate:
// `aiSdk.invoke` owns the §6 order (flag → lifecycle → kill switch → tenant opt-in → clinician opt-out →
// token cap → PHI minimisation → routing), and an adapter that short-circuited any of them would be a
// second, divergent policy engine with the same eight names. What an adapter DOES own is exactly three
// things: which capability serves its surface, how its input becomes an `AiInvokeRequest`, and how a
// completed invocation becomes its contract's payload.
//
// ── PHASE 1: EVERY ONE OF THEM REFUSES, AND THE REFUSAL COMES FROM THE PIPELINE ──────────────────
//
// `ai.full` is off for every tenant this wave, so the pipeline short-circuits at gate 0 and answers
// `phase_1_capability_shell` — writing NO `ai_invocation` row, by design (the flag gate is the one
// refusal §3.5's ledger does not record, because nothing was disclosed to anyone). The adapters still
// route through it rather than returning a canned literal, so that the day the flag flips there is no
// second code path to remember: the gate chain is already live and already tested.
//
// ── THREE PORTS ARE DELIBERATELY UNBOUND, AND EACH REFUSES RATHER THAN GUESSING ─────────────────
//
//   · `actors`     — §4.2's inputs carry `organizationId` + `actorUserId`; `ai_invocation` needs a
//                    membership, a role and (NOT NULL, ARCH-011) a `provider_entity_id`. Nothing on the
//                    platform maps one to the other today, and §164.528 disclosure accounting has to
//                    name WHICH certified provider entity disclosed the PHI — "the tenant" is not an
//                    answer a surveyor takes. Unbound ⇒ the seam refuses; it does not invent an entity.
//   · `projector`  — §2.5's per-capability typed output schemas are a later task. Until one exists,
//                    turning `output.text` into DocLens `fields` or a copilot's `citations` would be
//                    parsing by hope. Unbound ⇒ a COMPLETED invocation refuses with
//                    `output_validation_failed_after_retry`, which is the literal truth: the model
//                    answered and M32 could not validate the answer into the contract. Note the ledger
//                    row SURVIVES that refusal — the disclosure happened whether or not we could read
//                    the reply, and §8.8 counts disclosures, not successes.
import {
  AI_COPILOT_SCOPE_CAPABILITY,
  AI_DOCLENS_CAPABILITY,
  AI_SEAM_CAPABILITY,
  type AiSeamRefusal,
  type BereavementRiskNarrativeInput,
  type BereavementRiskNarrativeProvider,
  type CopilotAskInput,
  type CopilotProvider,
  type DenialOutcomePredictionProvider,
  type DenialPredictionInput,
  type DocLensClassifier,
  type DocLensExtractor,
  type DocLensSudDetector,
  type DocLensVisionVerifier,
  type EmbeddingsInput,
  type EmbeddingsProvider,
  type NarrativeEnhancementInput,
  type NarrativeEnhancementProvider,
  type NarrativeEnhancementResult,
  type SemanticSearchInput,
  type SemanticSearchProvider,
  aiCapabilityKeyForNarrativeSurface,
  aiSeamRefusal,
} from "@wardenx/ai-platform";
import type {
  AiConsumerContextRef,
  HospitalizationRiskProvider,
  IsoInstant,
  OrgId,
  PatientId,
  ProtocolSuggestionProvider,
  TriageHospitalizationRiskResult,
  TriageProtocolSuggestionInput,
  TriageProtocolSuggestionResult,
} from "@wardenx/types";
import type { AiInvocationOutput, AiInvocationPipeline } from "../invocation/service";
import {
  DOCLENS_CLASSIFY_RESPONSE_SCHEMA,
  DOCLENS_EXTRACT_RESPONSE_SCHEMA,
} from "./doclens-projector";

// ── the three ports ────────────────────────────────────────────────────────────────────────────────

/** The `ai_invocation` actor columns a seam call cannot supply from §4.2's input alone. */
export interface AiSeamActorContext {
  readonly actorMembershipId: string;
  readonly actorRole: string;
  /** ARCH-011 — NOT NULL on `ai_invocation`. The certified provider entity that disclosed the PHI. */
  readonly providerEntityId: string;
  readonly locationId?: string | null;
}

/**
 * Resolves a seam caller into the actor columns the ledger needs.
 *
 * `actorUserId: null` means "resolve from the ambient request context" — the M19 pair's signatures
 * (`suggestProtocol(orgId, input)`) carry no actor at all, so that arm is the only way they could ever
 * dispatch. Returning `null` REFUSES the call.
 */
export interface AiSeamActorResolver {
  resolve(organizationId: string, actorUserId: string | null): Promise<AiSeamActorContext | null>;
}

/**
 * The Phase-1 resolver: refuses everything.
 *
 * No seam on the platform maps a user to a provider entity, and M32 will not guess one — a §164.528
 * accounting that named the wrong certified provider is worse than one that could not be produced.
 */
export function createDenyingAiSeamActorResolver(): AiSeamActorResolver {
  return { resolve: async () => null };
}

/**
 * Shapes a completed invocation's raw output into a seam contract's payload. `null` = "cannot".
 *
 * ONE port for all eleven seams rather than eleven ports, keyed on the seam name, because §2.5's
 * schemas do not exist yet and the shape of the eventual projector is the shape of those schemas. A
 * per-seam port set now would be eleven interfaces designed against nothing.
 */
export interface AiSeamOutputProjector {
  project(seam: string, output: AiInvocationOutput): unknown | null;
}

/** The slice of `AIPromptRegistry` a seam needs: the capability's active, hash-verified template. */
export interface AiSeamPromptSource {
  getActivePromptForCapability(capabilityKey: string): Promise<{
    readonly promptTemplateId: string;
    readonly version: number;
    readonly promptBody: string;
  } | null>;
}

/** Deps every §4.2 adapter shares. */
export interface AiPublishedSeamDeps {
  readonly pipeline: AiInvocationPipeline;
  /**
   * F-236 — the §4.5 registry. BOUND ⇒ every seam call sends its capability's active, reviewed,
   * hash-pinned template as the system prompt, and REFUSES when the capability has none (or its file no
   * longer matches its pin). Unbound ⇒ the legacy posture (no system prompt) — which every seam reached
   * only with `ai.full` off, i.e. never.
   */
  readonly prompts?: AiSeamPromptSource;
  /** Absent ⇒ {@link createDenyingAiSeamActorResolver}. */
  readonly actors?: AiSeamActorResolver;
  /** Absent ⇒ a completed invocation refuses with `output_validation_failed_after_retry`. */
  readonly projector?: AiSeamOutputProjector;
  readonly now?: () => Date;
}

// ── the shared invoke path ────────────────────────────────────────────────────────────────────────

interface SeamInvokeArgs {
  readonly seam: string;
  /** `null` when the surface maps to no registered capability — refuse without touching the pipeline. */
  readonly capabilityKey: string | null;
  readonly organizationId: string;
  readonly actorUserId: string;
  readonly patientId?: string | null;
  readonly consumerContextRef: AiConsumerContextRef;
  readonly promptText: string;
  readonly chartContext: Record<string, unknown>;
  readonly responseSchema?: Record<string, unknown>;
  readonly maxOutputTokens?: number;
  readonly dispatchTimeoutMs?: number;
}

type SeamInvokeOutcome =
  | { readonly ok: true; readonly invocationId: string; readonly output: AiInvocationOutput }
  | ({ readonly ok: false } & AiSeamRefusal);

function refuse(refusal: AiSeamRefusal): { readonly ok: false } & AiSeamRefusal {
  return { ok: false, ...refusal };
}

/** Strip the internal `ok` discriminator back off, so the refusal matches the published union. */
function asRefusal(outcome: { readonly ok: false } & AiSeamRefusal): AiSeamRefusal {
  const { ok: _ok, ...refusal } = outcome;
  return refusal;
}

function createSeamRunner(deps: AiPublishedSeamDeps) {
  const actors = deps.actors ?? createDenyingAiSeamActorResolver();
  const clock = deps.now ?? (() => new Date());

  return async function run(args: SeamInvokeArgs): Promise<SeamInvokeOutcome> {
    if (args.capabilityKey === null) {
      // §2.4 registers no capability for this surface. NOT `lifecycle_state_retired` (the pipeline's
      // anti-enumeration answer for a probed key): nothing was probed, the surface is one of ours and
      // it maps to nothing. Naming the surface in `detail` is what turns this from a mystery into a
      // one-line fix the day somebody registers the capability.
      return refuse(
        aiSeamRefusal(
          "provider_unregistered",
          `no AI capability is registered for the '${args.seam}' surface requested`,
        ),
      );
    }

    const actor = await actors.resolve(args.organizationId, args.actorUserId);
    if (actor === null) {
      return refuse(
        aiSeamRefusal(
          "provider_unregistered",
          `no actor resolver is bound, so '${args.seam}' cannot name the provider entity ai_invocation requires (ARCH-011)`,
        ),
      );
    }

    let template: { promptTemplateId: string; version: number; promptBody: string } | null = null;
    if (deps.prompts) {
      try {
        template = await deps.prompts.getActivePromptForCapability(args.capabilityKey);
      } catch {
        return refuse(
          aiSeamRefusal(
            "provider_unregistered",
            `'${args.seam}': the active prompt template for '${args.capabilityKey}' could not be loaded or no longer matches its pinned hash`,
          ),
        );
      }
      if (template === null) {
        return refuse(
          aiSeamRefusal(
            "provider_unregistered",
            `'${args.seam}': capability '${args.capabilityKey}' has no active prompt template`,
          ),
        );
      }
    }

    const outcome = await deps.pipeline.invoke({
      capabilityKey: args.capabilityKey,
      organizationId: args.organizationId,
      providerEntityId: actor.providerEntityId,
      locationId: actor.locationId ?? null,
      actorMembershipId: actor.actorMembershipId,
      actorRole: actor.actorRole,
      patientId: args.patientId ?? null,
      consumerContextRef: args.consumerContextRef,
      prompt: template
        ? {
            text: args.promptText,
            systemPrompt: template.promptBody,
            templateId: template.promptTemplateId,
            templateVersion: String(template.version),
          }
        : { text: args.promptText },
      chartContext: args.chartContext,
      ...(args.responseSchema ? { responseSchema: args.responseSchema } : {}),
      ...(args.maxOutputTokens ? { maxOutputTokens: args.maxOutputTokens } : {}),
      ...(args.dispatchTimeoutMs ? { dispatchTimeoutMs: args.dispatchTimeoutMs } : {}),
      invokedAt: clock().toISOString(),
    });

    if (!outcome.available) {
      // The pipeline's own gate decision, handed straight through. `detail` names the gate, so a
      // consumer that logs it can tell a kill switch from a hard cap without a second lookup.
      return refuse({
        available: false,
        unavailable: outcome.unavailable,
        detail: `${outcome.gate}: ${outcome.detail}`,
      });
    }

    return { ok: true, invocationId: outcome.invocationId, output: outcome.output };
  };
}

/** Project a completed output, or refuse because nothing can shape it (see the header on `projector`). */
function projectOr<T>(
  deps: AiPublishedSeamDeps,
  seam: string,
  output: AiInvocationOutput,
): T | AiSeamRefusal {
  const projected = deps.projector?.project(seam, output) ?? null;
  if (projected === null) {
    return aiSeamRefusal(
      "output_validation_failed_after_retry",
      `'${seam}' has no §2.5 output projector bound; the invocation completed and is recorded, but its output cannot be validated into the seam contract`,
    );
  }
  return projected as T;
}

// ── §4.2.1 NarrativeEnhancementProvider ───────────────────────────────────────────────────────────

/** M32's §4.2.1 implementation. Hot Phase-1 seam (M8 locked); refuses while `ai.full` is off. */
export function createNarrativeEnhancementProvider(
  deps: AiPublishedSeamDeps,
): NarrativeEnhancementProvider {
  const run = createSeamRunner(deps);
  return {
    async enhance(input: NarrativeEnhancementInput): Promise<NarrativeEnhancementResult> {
      const outcome = await run({
        seam: `NarrativeEnhancementProvider.${input.surface}`,
        capabilityKey: aiCapabilityKeyForNarrativeSurface(input.surface),
        organizationId: input.organizationId,
        actorUserId: input.actorUserId,
        patientId: input.patientId ?? null,
        consumerContextRef: {
          // The CONSUMER's module id, never M32's own (§3.2.8). The parent entity type is what says
          // whose handling of PHI this disclosure belongs to.
          module: consumerModuleForParent(input.parentEntityType),
          entityKind: input.parentEntityType,
          entityId: input.parentEntityId,
        },
        promptText: input.draftText,
        chartContext: input.chartContext,
      });
      if (!outcome.ok) return asRefusal(outcome);

      const enhanced = projectOr<{
        text: string;
        confidence: number;
        warnings: never[];
        modelVersionPin: string;
      }>(deps, "NarrativeEnhancementProvider", outcome.output);
      if ("available" in enhanced) return enhanced;
      return { available: true, invocationId: outcome.invocationId, enhanced };
    },
  };
}

/** Which module's handling a narrative surface belongs to — the `consumer_context_ref.module` value. */
function consumerModuleForParent(parent: NarrativeEnhancementInput["parentEntityType"]): string {
  switch (parent) {
    case "encounter":
      return "m8";
    case "idg_session":
      return "m14";
    case "bereavement_event":
      return "m16";
    case "discipline_care_plan":
      return "m15";
  }
}

// ── §4.2.2 the four DocLens seams ─────────────────────────────────────────────────────────────────

/** The `consumer_context_ref` every DocLens arm writes: M22's document, by id. */
function docLensContextRef(documentId: string): AiConsumerContextRef {
  return { module: "m22", entityKind: "document", entityId: documentId };
}

/**
 * F-236 — the extractor's user message: the FIELDS M22 asks for, then the DOCUMENT page by page with the
 * `=== PAGE n ===` markers the `doclens_extract` template's rules refer to. Deterministic (same input,
 * same bytes), so the ledger's encrypted prompt is reproducible from the document.
 */
export function composeDocLensExtractPrompt(input: {
  readonly extractedText: string;
  readonly fieldSpecs?: readonly { readonly fieldPath: string; readonly description: string }[];
  readonly pages?: readonly { readonly page: number; readonly text: string }[];
}): string {
  const fields = (input.fieldSpecs ?? [])
    .map((f) => `- ${f.fieldPath}: ${f.description}`)
    .join("\n");
  const document = input.pages?.length
    ? input.pages.map((p) => `=== PAGE ${p.page} ===\n${p.text}`).join("\n\n")
    : `=== PAGE 1 ===\n${input.extractedText}`;
  return `FIELDS:\n${fields}\n\nDOCUMENT:\n${document}`;
}

/** M32's §4.2.2 classifier. `doclens_classify` sits at DESIGN_REVIEW, so even flag-on refuses. */
export function createDocLensClassifier(deps: AiPublishedSeamDeps): DocLensClassifier {
  const run = createSeamRunner(deps);
  return {
    async classify(input) {
      const outcome = await run({
        seam: "DocLensClassifier",
        capabilityKey: AI_DOCLENS_CAPABILITY.classify,
        organizationId: input.organizationId,
        actorUserId: input.actorUserId,
        consumerContextRef: docLensContextRef(input.documentId),
        promptText: input.extractedText,
        chartContext: {
          documentId: input.documentId,
          pageCount: input.pageCount,
          ...(input.pageNumber === undefined ? {} : { pageNumber: input.pageNumber }),
        },
        responseSchema: DOCLENS_CLASSIFY_RESPONSE_SCHEMA,
        maxOutputTokens: 256,
        // Background work (the M22 intake job), not a clinician waiting on a keystroke.
        dispatchTimeoutMs: 120_000,
      });
      if (!outcome.ok) return asRefusal(outcome);
      const projected = projectOr<{
        documentType: string;
        confidence: number;
        alternates: never[];
        warnings: never[];
      }>(deps, "DocLensClassifier", outcome.output);
      if ("available" in projected) return projected;
      return { available: true, invocationId: outcome.invocationId, ...projected };
    },
  };
}

/** M32's §4.2.2 extractor. */
export function createDocLensExtractor(deps: AiPublishedSeamDeps): DocLensExtractor {
  const run = createSeamRunner(deps);
  return {
    async extract(input) {
      const outcome = await run({
        seam: "DocLensExtractor",
        capabilityKey: AI_DOCLENS_CAPABILITY.extract,
        organizationId: input.organizationId,
        actorUserId: input.actorUserId,
        consumerContextRef: docLensContextRef(input.documentId),
        promptText: composeDocLensExtractPrompt(input),
        chartContext: {
          documentId: input.documentId,
          documentType: input.documentType,
          schemaKey: input.schemaKey,
        },
        responseSchema: DOCLENS_EXTRACT_RESPONSE_SCHEMA,
        maxOutputTokens: 4096,
        dispatchTimeoutMs: 300_000,
      });
      if (!outcome.ok) return asRefusal(outcome);
      const projected = projectOr<{ fields: Record<string, never>; warnings: never[] }>(
        deps,
        "DocLensExtractor",
        outcome.output,
      );
      if ("available" in projected) return projected;
      return { available: true, invocationId: outcome.invocationId, ...projected };
    },
  };
}

/** M32's §4.2.2 vision verifier — the one capability whose backend must carry the `vision` modality. */
export function createDocLensVisionVerifier(deps: AiPublishedSeamDeps): DocLensVisionVerifier {
  const run = createSeamRunner(deps);
  return {
    async verify(input) {
      const outcome = await run({
        seam: "DocLensVisionVerifier",
        capabilityKey: AI_DOCLENS_CAPABILITY.visionVerify,
        organizationId: input.organizationId,
        actorUserId: input.actorUserId,
        consumerContextRef: docLensContextRef(input.documentId),
        // The page IMAGES are storage keys, not bytes: the prompt names what to look at and the
        // adapter fetches nothing. Keys are PHI-free by construction (M22 D11).
        promptText: input.verificationKey,
        chartContext: {
          documentId: input.documentId,
          verificationKey: input.verificationKey,
          pageImages: input.pageImages,
        },
      });
      if (!outcome.ok) return asRefusal(outcome);
      const projected = projectOr<{
        verdict: "pass" | "fail" | "uncertain";
        confidence: number;
        evidence: never[];
        warnings: never[];
      }>(deps, "DocLensVisionVerifier", outcome.output);
      if ("available" in projected) return projected;
      return { available: true, invocationId: outcome.invocationId, ...projected };
    },
  };
}

/** M32's §4.2.2 SUD detector — 42 CFR Part 2, and the one DocLens capability with no catalog entry. */
export function createDocLensSudDetector(deps: AiPublishedSeamDeps): DocLensSudDetector {
  const run = createSeamRunner(deps);
  return {
    async detect(input) {
      const outcome = await run({
        seam: "DocLensSudDetector",
        capabilityKey: AI_DOCLENS_CAPABILITY.sudDetect,
        organizationId: input.organizationId,
        actorUserId: input.actorUserId,
        consumerContextRef: docLensContextRef(input.documentId),
        promptText: input.extractedText,
        chartContext: { documentId: input.documentId },
      });
      if (!outcome.ok) return asRefusal(outcome);
      const projected = projectOr<{
        sudIndicatorsDetected: boolean;
        confidence: number;
        indicators: never[];
        warnings: never[];
      }>(deps, "DocLensSudDetector", outcome.output);
      if ("available" in projected) return projected;
      return { available: true, invocationId: outcome.invocationId, ...projected };
    },
  };
}

// ── §4.2.4 BereavementRiskNarrativeProvider ───────────────────────────────────────────────────────

/** M32's §4.2.4 implementation. M16 augments its deterministic score with this; it never replaces it. */
export function createBereavementRiskNarrativeProvider(
  deps: AiPublishedSeamDeps,
): BereavementRiskNarrativeProvider {
  const run = createSeamRunner(deps);
  return {
    async composeNarrative(input: BereavementRiskNarrativeInput) {
      const outcome = await run({
        seam: "BereavementRiskNarrativeProvider",
        capabilityKey: AI_SEAM_CAPABILITY.BereavementRiskNarrativeProvider,
        organizationId: input.organizationId,
        actorUserId: input.actorUserId,
        consumerContextRef: {
          module: "m16",
          entityKind: "bereavement_event",
          entityId: input.bereavementEventId,
        },
        // The prompt is the FACTS, not free text: D5 puts the bounded snapshot in the caller's hands and
        // §8.3 checks it. There is no draft narrative to enhance here — this seam composes one.
        promptText: "",
        chartContext: {
          survivorRoleSnapshot: input.survivorRoleSnapshot,
          riskFactors: input.riskFactors,
        },
      });
      if (!outcome.ok) return asRefusal(outcome);
      const projected = projectOr<{
        narrative: string;
        confidence: number;
        warnings: never[];
      }>(deps, "BereavementRiskNarrativeProvider", outcome.output);
      if ("available" in projected) return projected;
      return { available: true, invocationId: outcome.invocationId, ...projected };
    },
  };
}

// ── §4.2.5 DenialOutcomePredictionProvider ────────────────────────────────────────────────────────

/** M32's §4.2.5 implementation. Advisory: M25 submits the claim whichever way this answers. */
export function createDenialOutcomePredictionProvider(
  deps: AiPublishedSeamDeps,
): DenialOutcomePredictionProvider {
  const run = createSeamRunner(deps);
  return {
    async predict(input: DenialPredictionInput) {
      const outcome = await run({
        seam: "DenialOutcomePredictionProvider",
        capabilityKey: AI_SEAM_CAPABILITY.DenialOutcomePredictionProvider,
        organizationId: input.organizationId,
        actorUserId: input.actorUserId,
        consumerContextRef: { module: "m25", entityKind: "claim", entityId: input.claimId },
        promptText: "",
        chartContext: { ...input.claimFeatures },
      });
      if (!outcome.ok) return asRefusal(outcome);
      const projected = projectOr<{ denialProbability: number; topFactors: never[] }>(
        deps,
        "DenialOutcomePredictionProvider",
        outcome.output,
      );
      if ("available" in projected) return projected;
      return {
        available: true,
        invocationId: outcome.invocationId,
        modelVersionPin: outcome.output.modelVersionPin,
        ...projected,
      };
    },
  };
}

// ── §4.2.6 EmbeddingsProvider / SemanticSearchProvider / CopilotProvider ─────────────────────────

/** M32's §4.2.6 embeddings implementation. D20: the namespace partitions WITHIN a tenant, never across. */
export function createEmbeddingsProvider(deps: AiPublishedSeamDeps): EmbeddingsProvider {
  const run = createSeamRunner(deps);
  return {
    async embed(input: EmbeddingsInput) {
      const outcome = await run({
        seam: "EmbeddingsProvider",
        capabilityKey: AI_SEAM_CAPABILITY.EmbeddingsProvider,
        organizationId: input.organizationId,
        actorUserId: input.actorUserId,
        consumerContextRef: {
          module: "m32",
          entityKind: input.sourceEntityType,
          entityId: input.sourceEntityId,
        },
        promptText: input.text,
        chartContext: { namespace: input.namespace },
      });
      if (!outcome.ok) return asRefusal(outcome);
      const projected = projectOr<{ vector: number[]; dimensions: number }>(
        deps,
        "EmbeddingsProvider",
        outcome.output,
      );
      if ("available" in projected) return projected;
      return {
        available: true,
        invocationId: outcome.invocationId,
        modelVersionPin: outcome.output.modelVersionPin,
        ...projected,
      };
    },
  };
}

/** M32's §4.2.6 semantic search. Hits are REFERENCES; the caller re-reads each under its own authz. */
export function createSemanticSearchProvider(deps: AiPublishedSeamDeps): SemanticSearchProvider {
  const run = createSeamRunner(deps);
  return {
    async search(input: SemanticSearchInput) {
      const outcome = await run({
        seam: "SemanticSearchProvider",
        capabilityKey: AI_SEAM_CAPABILITY.SemanticSearchProvider,
        organizationId: input.organizationId,
        actorUserId: input.actorUserId,
        patientId: input.patientId ?? null,
        consumerContextRef: {
          module: "m32",
          entityKind: "semantic_search",
          entityId: input.namespace,
        },
        promptText: input.queryText,
        chartContext: { namespace: input.namespace, limit: input.limit ?? null },
      });
      if (!outcome.ok) return asRefusal(outcome);
      const projected = projectOr<{ hits: never[] }>(
        deps,
        "SemanticSearchProvider",
        outcome.output,
      );
      if ("available" in projected) return projected;
      return {
        available: true,
        invocationId: outcome.invocationId,
        modelVersionPin: outcome.output.modelVersionPin,
        ...projected,
      };
    },
  };
}

/** M32's §4.2.6 copilot. Two capabilities behind one seam; `scope` picks, the caller never names a key. */
export function createCopilotProvider(deps: AiPublishedSeamDeps): CopilotProvider {
  const run = createSeamRunner(deps);
  return {
    async ask(input: CopilotAskInput) {
      const outcome = await run({
        seam: "CopilotProvider",
        capabilityKey: AI_COPILOT_SCOPE_CAPABILITY[input.scope],
        organizationId: input.organizationId,
        actorUserId: input.actorUserId,
        patientId: input.patientId ?? null,
        consumerContextRef: {
          // A direct UI surface with no consumer module — §2.4 says so, and it is why `caseload_or_scope`
          // is the only chart-scope enforcement on this path. The context ref names M32 because M32's own
          // handling is what disclosed the PHI.
          module: "m32",
          entityKind: input.patientId == null ? "copilot_session" : "patient",
          entityId: input.patientId ?? input.scope,
        },
        promptText: input.question,
        chartContext: input.chartContext,
      });
      if (!outcome.ok) return asRefusal(outcome);
      const projected = projectOr<{
        answer: string;
        confidence: number;
        citations: never[];
        warnings: never[];
      }>(deps, "CopilotProvider", outcome.output);
      if ("available" in projected) return projected;
      return {
        available: true,
        invocationId: outcome.invocationId,
        modelVersionPin: outcome.output.modelVersionPin,
        ...projected,
      };
    },
  };
}

// ── §4.2.3 the two M19 ADVISORY seams, on M19's OWN leaf-typed contracts ─────────────────────────
//
// THESE DO NOT RE-DECLARE ANYTHING. `ProtocolSuggestionProvider` and `HospitalizationRiskProvider` were
// leaf-typed in `@wardenx/types`'s `./oncall` by M19-T01, which shipped first and locked their shapes.
// §4.2.3 sketches different signatures (`suggest(...)`, `predict(...)`, an `available` union); the
// REGISTERED contract wins, because a second interface for one seam is a permanently unbound seam — the
// M15/M17 `VolunteerComplianceProvider` lesson, applied in the direction it teaches.
//
// THEY BYPASS THE PIPELINE, AND THIS IS A STATED PHASE-1 GAP. M19's signatures carry no actor:
// `suggestProtocol(orgId, input)` where `input` is a triage call, a patient and a chief complaint.
// `ai_invocation` needs an `actor_membership_id` and a NOT-NULL `provider_entity_id`, and ARCH-011 is
// explicit that M32 will not guess the latter. So these two read the `ai.full` flag and refuse; wiring
// them to the ledger needs either an actor on M19's contract or an ambient-context resolver, and both
// are M19-facing changes outside this task. With the flag off — the whole of Phase 1 — the observable
// behaviour is identical either way: `unavailable`, and §8.6's AI block renders visibly disabled.
//
// THE REASON THEY REPORT IS `provider_unregistered`, AND THAT IS THE HONEST FIT, NOT THE CONVENIENT
// ONE. M19's union has three members: `provider_unregistered` ("the pre-M32 default"), `tenant_opted_out`
// (M19's own `tenant_oncall_policy.ai_*_enabled` flag, which is M19's fact and not M32's to assert) and
// `provider_error` ("a live M32 that failed" — nothing failed). There is no word in it for "M32 is
// registered and shut off". `provider_unregistered` is what M19 already renders as the disabled AI block
// and what `m19_ai_block_disabled_total` already counts; widening M19's union to add a fourth member
// would ripple through M19's UI and tests for a distinction no M19 surface makes.

/**
 * M32's implementation of M19's D12 protocol-suggestion advisory.
 *
 * `_deps` is accepted and unused, on purpose: the Phase-2 binding is a change to this body, not to the
 * registration site or to M19, and a factory that took no deps would have to grow a signature the day
 * the actor gap closes.
 */
export function createProtocolSuggestionProvider(
  _deps: AiPublishedSeamDeps,
): ProtocolSuggestionProvider {
  return {
    async suggestProtocol(
      _orgId: OrgId,
      _input: TriageProtocolSuggestionInput,
    ): Promise<TriageProtocolSuggestionResult> {
      // NO `ai.full` READ HERE, deliberately. The flag cannot change this answer: with it off M32
      // dispatches nothing, and with it on M32 still has no actor to write the ledger row with. Reading
      // a flag whose two values produce one result would be a branch that documents an intention rather
      // than a behaviour, and the next reader would trust it.
      return { kind: "unavailable", reason: "provider_unregistered" };
    },
  };
}

/** M32's implementation of M19's D11 30-day hospitalization-risk advisory. Same posture as its sibling. */
export function createHospitalizationRiskProvider(
  _deps: AiPublishedSeamDeps,
): HospitalizationRiskProvider {
  return {
    async hospitalizationRiskForPatient(
      _orgId: OrgId,
      _patientId: PatientId,
      _asOfIso: IsoInstant,
    ): Promise<TriageHospitalizationRiskResult> {
      return { kind: "unavailable", reason: "provider_unregistered" };
    },
  };
}
