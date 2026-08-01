// @wardenx/ai-platform — the pluggable `ModelBackend` port (D1, architecture §10.7.3) (M32-T04).
//
// One interface, six Phase-1 implementations eventually behind it (§2.3): two Anthropic models, two
// Ollama-hosted local LLMs, one sentence-transformers embedder, one custom classifier. The invocation
// pipeline knows only this shape — which is what makes "route this tenant to a local model" a registry
// decision rather than a code path.
//
// ── EVERY IMPLEMENTATION IS A VENDOR ADAPTER, AND THE MANIFEST SAYS SO ─────────────────────────────
//
// `VENDOR_ADAPTERS['@anthropic-ai/sdk'] = 'packages/ai-platform'` (architecture §25.14) means the SDK
// import may appear nowhere else in the monorepo; dependency-cruiser fails the build on any other site.
// The same applies to the eventual Ollama and ml-worker HTTP clients. So the consumer-facing surface of
// an AI call — M8's Layer-2 enhance, M22's DocLens extract — is this interface and the §4.2 seams, and
// no consumer ever holds a vendor client.
//
// ── TOKENS COME BACK FROM THE BACKEND, NOT FROM AN ESTIMATOR ──────────────────────────────────────
//
// `inputTokens` / `outputTokens` on every result are the VENDOR'S counts, because they are what the
// vendor bills and what §3.2.9's ledger has to reconcile against an invoice. A local backend that
// cannot report a count reports what its runtime says, never a `text.length / 4` guess — an estimate in
// a ledger column that reads as a measurement is how a cost report becomes fiction.
import type {
  AiBackendHealthStatus,
  AiModelBackendFeatures,
  AiModelBackendKind,
  AiModelModality,
} from "@wardenx/types";

/** What a backend advertises about itself, for the routing gate and the §5.1 admin console. */
export interface ModelBackendCapabilities {
  readonly backendKey: string;
  readonly kind: AiModelBackendKind;
  readonly modelVersionPin: string;
  readonly supportedModalities: readonly AiModelModality[];
  readonly contextWindowTokens: number;
  readonly maxOutputTokens: number;
  readonly supportedFeatures: AiModelBackendFeatures;
}

/** The token counts every dispatch reports back (see the header — vendor counts, never estimates). */
export interface ModelBackendTokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

/** A text-completion dispatch. `organizationId` rides along because §8.4's ZDR resolution is per-org. */
export interface ModelBackendCompletionRequest {
  readonly organizationId: string;
  readonly systemPrompt: string | null;
  readonly prompt: string;
  /** Already §8.3-minimised by the pipeline — a backend must not be the thing that decides this. */
  readonly chartContext: Record<string, unknown>;
  readonly maxOutputTokens: number;
}

export interface ModelBackendCompletionResult extends ModelBackendTokenUsage {
  readonly text: string;
  /** The pin that actually served, echoed back so the ledger records the model that ran rather than
   *  the model the registry expected to run. A drifted pin is a finding, not a mismatch to smooth. */
  readonly modelVersionPin: string;
}

export interface ModelBackendEmbeddingRequest {
  readonly organizationId: string;
  readonly inputs: readonly string[];
}

export interface ModelBackendEmbeddingResult extends ModelBackendTokenUsage {
  readonly vectors: readonly (readonly number[])[];
  readonly modelVersionPin: string;
}

export interface ModelBackendClassificationRequest {
  readonly organizationId: string;
  readonly input: string;
  readonly labels: readonly string[];
}

export interface ModelBackendClassificationResult extends ModelBackendTokenUsage {
  readonly label: string;
  readonly confidence: number;
  readonly modelVersionPin: string;
}

/**
 * The pluggable backend (D1).
 *
 * `complete` / `embed` / `classify` are OPTIONAL methods rather than four required ones that throw:
 * `local-bge-small-en` embeds and does nothing else, and a required `complete()` that throws
 * `NotImplemented` is indistinguishable at the call site from a vendor outage. The routing gate already
 * filters on `supported_modalities`; an absent method is the same fact, in the type system.
 */
export interface ModelBackend {
  readonly backendKey: string;
  readonly kind: AiModelBackendKind;
  capabilities(): ModelBackendCapabilities;
  health(): Promise<AiBackendHealthStatus>;
  complete?(request: ModelBackendCompletionRequest): Promise<ModelBackendCompletionResult>;
  embed?(request: ModelBackendEmbeddingRequest): Promise<ModelBackendEmbeddingResult>;
  classify?(
    request: ModelBackendClassificationRequest,
  ): Promise<ModelBackendClassificationResult>;
}

/** Resolves a `backend_key` from `ai_model_backend` to the adapter that speaks to it. */
export interface ModelBackendRegistry {
  get(backendKey: string): ModelBackend | null;
  keys(): readonly string[];
}

/** Build a registry over a fixed set of adapters. */
export function createModelBackendRegistry(
  backends: readonly ModelBackend[],
): ModelBackendRegistry {
  const byKey = new Map<string, ModelBackend>();
  for (const backend of backends) {
    if (byKey.has(backend.backendKey)) {
      // A duplicate key means two adapters claim one registry row and which one serves is load order.
      throw new Error(`ModelBackendRegistry: duplicate backend key '${backend.backendKey}'`);
    }
    byKey.set(backend.backendKey, backend);
  }
  return {
    get: (backendKey) => byKey.get(backendKey) ?? null,
    keys: () => [...byKey.keys()],
  };
}

/**
 * The Phase-1 registry: EMPTY.
 *
 * `ai.full` is off for the whole wave, so no adapter is constructed and none is bound. This is a value
 * rather than an omission so the composition root can hold a registry that resolves nothing and the
 * pipeline's "the routed backend has no bound adapter" path is reachable in a test — an unbound
 * registry must refuse the call, not crash the request.
 */
export function createEmptyModelBackendRegistry(): ModelBackendRegistry {
  return createModelBackendRegistry([]);
}
