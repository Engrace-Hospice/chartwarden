// @chartwarden/ai-platform — §2.3 Phase-1 backend inventory (M32-T01).
//
// The `ai_model_backend` rows registered at lock time (D1). PURE DATA — spec T56 is what INSERTs them;
// this file is the single place the values are written down, so the seed, the routing config (D4) and
// the health-sweep worker cannot disagree about which backends exist.
//
// §2.3's table has six rows and its closing paragraph adds two more — `local-phi-3.5-mini` registered
// `is_active=false` "for lifecycle continuity" and `local-all-minilm-l6-v2` registered active with no
// capability defaulting to it. Eight rows total; D1's prose counts the six that serve a Phase-1
// capability.
//
// WHERE §2.3 IS SILENT, THIS FILE SAYS `null`. Nine §3.2.4 columns (`model_version_pin`,
// `max_output_tokens`, `supported_features`, `health_endpoint`, `baa_reference`, `zdr_status`,
// `license_terms`, `artifact_storage_ref`, `artifact_checksum`) have no value anywhere in §2.3, and two
// rows additionally have no stated context window. Guessing any of them would be worse than leaving the
// hole visible: a fabricated context window silently truncates a real prompt, and a fabricated
// `zdr_status` would defeat the exact check D19 exists to make unbypassable. See
// `AI_BACKEND_SEED_BLOCKING_FIELDS` in `@chartwarden/types` for which of the nine actually block an INSERT.
//
// MODEL PINS ARE THE SPEC'S. §2.3 keys the two cloud backends `anthropic-claude-opus-4-7` and
// `anthropic-claude-haiku-4-5`. Those keys are the registry's contract and this file reproduces them;
// T13/T56 must reconcile the eventual `model_version_pin` against Anthropic's live model list before
// the row can be seeded, which is precisely why the pin is one of the nine unstated fields rather than
// something derived from the key here.

import type { AiPhase1BackendRegistration } from "@chartwarden/types";

/**
 * The eight backends §2.3 registers at lock time, plus the local vision route ADR-0048 adds (F-237).
 *
 * `servesCapabilityKeys` is §2.3's own "Capabilities served (Phase 1)" column. It is the DEFAULT/opt-in
 * mapping, not a permission: whether a tenant's invocation actually reaches a backend is decided at the
 * routing gate (T17) from the capability's `allowed_backend_keys`, the tenant's `ai_routing_preference`
 * and any `ai_routing_override`.
 */
export const AI_PHASE_1_BACKENDS: readonly AiPhase1BackendRegistration[] = [
  {
    backendKey: "anthropic-claude-opus-4-7",
    kind: "cloud",
    vendor: "anthropic",
    modelFamily: "claude",
    supportedModalities: ["text", "vision"],
    // 1M, not the 200K §2.3's table states. `claude-opus-4-7` is a 1M-context / 128K-output model;
    // the spec table was written against an earlier Opus generation and has been corrected alongside
    // this. Understating it is not harmless in the "safe direction" — it truncates prompts the model
    // could serve, which is the failure this file's header warns about.
    contextWindowTokens: 1_000_000,
    isActive: true,
    servesCapabilityKeys: [
      "hearthnote_layer2",
      "idg_layer2_polish",
      "doclens_extract",
      "doclens_vision_verify",
      "doclens_sud_detect",
      "copilot_clinical",
      "protocol_suggestion_oncall",
      "bereavement_risk_narrative",
    ],
    additionalSeedBlockers: [],
    note: "The single hot Phase-1 cloud route. §2.3 lists hearthnote_layer2 / doclens_extract / doclens_vision_verify / copilot_clinical; §2.4 additionally defaults idg_layer2_polish, doclens_sud_detect, protocol_suggestion_oncall and bereavement_risk_narrative here, and the §2.4 column is the per-capability authority.",
  },
  {
    backendKey: "anthropic-claude-haiku-4-5",
    kind: "cloud",
    vendor: "anthropic",
    modelFamily: "claude",
    supportedModalities: ["text"],
    contextWindowTokens: 200_000,
    isActive: true,
    servesCapabilityKeys: ["copilot_admin", "doclens_classify"],
    additionalSeedBlockers: [],
    note: "Cost-optimized cloud route. Serves doclens_classify only as the CLOUD FALLBACK — §2.4 defaults that capability to local-distilbert-classifier.",
  },
  {
    backendKey: "local-llama-3.1-8b-instruct",
    kind: "local",
    vendor: "meta",
    modelFamily: "llama",
    supportedModalities: ["text"],
    contextWindowTokens: 128_000,
    isActive: true,
    servesCapabilityKeys: [
      "hearthnote_layer2",
      "doclens_extract",
      // ADR-0048 (F-236): DocLens page classification runs on the same LLM path as extraction.
      "doclens_classify",
      // ADR-0048 (F-237): the optional model pass of DocLens SUD detection, for local_only tenants.
      "doclens_sud_detect",
      "copilot_clinical",
      "copilot_admin",
    ],
    additionalSeedBlockers: [],
    note: "M32-F02 (BLOCKER): this does NOT ship hot. The local route for hearthnote_layer2 is gated behind a passed Stage-3 eval plus an ai_capability_calibration row (ADR-0012 D2); until then a local_only / prefer_local tenant is told unavailable rather than silently served an uncalibrated model.",
  },
  {
    backendKey: "local-mistral-7b-instruct",
    kind: "local",
    vendor: "mistral",
    modelFamily: "mistral",
    supportedModalities: ["text"],
    contextWindowTokens: 32_000,
    isActive: true,
    servesCapabilityKeys: [
      "hearthnote_layer2",
      "doclens_extract",
      // ADR-0048 (F-236): DocLens page classification runs on the same LLM path as extraction.
      "doclens_classify",
      "copilot_clinical",
      "copilot_admin",
    ],
    additionalSeedBlockers: [],
    note: "Per-tenant alternative to Llama over the same capability set. Its 32K window is a quarter of Llama's — the routing gate cannot treat the two as interchangeable for a long chart context.",
  },
  {
    // ADR-0048 (F-237) — DocLens stage 5 for tenants whose PHI may not leave the host. §2.3 gave vision
    // verification exactly one home (Opus), which left a `local_only` tenant no stage 5 at all.
    backendKey: "local-qwen2.5-vl-7b-instruct",
    kind: "local",
    vendor: "alibaba",
    modelFamily: "qwen",
    supportedModalities: ["text", "vision"],
    // Qwen2.5-VL's native window; the YaRN-extended 128K is not what Ollama serves by default, and a
    // stage-5 prompt is one field name plus one image crop.
    contextWindowTokens: 32_768,
    isActive: true,
    servesCapabilityKeys: ["doclens_vision_verify"],
    additionalSeedBlockers: [],
    note: "Local vision route for doclens_vision_verify (ADR-0048, F-237). Apache-2.0. Reads one field from an image crop; M22 compares the reading with the extracted value, so the model is never shown the answer it is checking.",
  },
  {
    backendKey: "local-bge-small-en",
    kind: "local",
    vendor: "baai",
    modelFamily: "bge",
    supportedModalities: ["embedding"],
    contextWindowTokens: 512,
    isActive: true,
    servesCapabilityKeys: ["embeddings_clinical", "semantic_search_chart"],
    additionalSeedBlockers: [],
    note: "Embedding default. Per D20 every embedding index it writes is per-tenant with organization_id leading the HNSW key.",
  },
  {
    backendKey: "local-distilbert-classifier",
    kind: "local",
    vendor: "wardenx",
    modelFamily: "distilbert",
    supportedModalities: ["classification"],
    contextWindowTokens: 512,
    isActive: true,
    servesCapabilityKeys: ["doclens_classify"],
    additionalSeedBlockers: [],
    note: "ChartWarden-trained document-type classifier; the local default for doclens_classify with Haiku as the cloud fallback.",
  },
  {
    backendKey: "local-phi-3.5-mini",
    kind: "local",
    vendor: "microsoft",
    modelFamily: "phi",
    supportedModalities: ["text"],
    contextWindowTokens: null,
    isActive: false,
    servesCapabilityKeys: [],
    additionalSeedBlockers: ["contextWindowTokens"],
    note: "Registered is_active=false for lifecycle continuity (§2.3). D1 counts it among the six Phase-1 backends; §2.3's table does not list it, so it has no stated context window and serves nothing. Vendor/family follow the §2.1 ERD's own enumerations ('microsoft', 'phi').",
  },
  {
    backendKey: "local-all-minilm-l6-v2",
    kind: "local",
    vendor: null,
    modelFamily: null,
    supportedModalities: ["embedding"],
    contextWindowTokens: null,
    isActive: true,
    servesCapabilityKeys: [],
    additionalSeedBlockers: ["contextWindowTokens"],
    note: "The alternative embedding model — active, but no capability defaults to it Phase 1 (§2.3). Vendor and model_family are null because the §2.1 ERD's enumerations name neither, and both columns are NOT NULL: seeding this row needs both supplied.",
  },
];

/** Index by `backend_key` — the join key every other M32 table uses (`ai_capability.default_backend_key`,
 *  `ai_capability_calibration.backend_key`, `ai_invocation.backend_key`, `ai_routing_override`). */
export const AI_PHASE_1_BACKENDS_BY_KEY: ReadonlyMap<string, AiPhase1BackendRegistration> = new Map(
  AI_PHASE_1_BACKENDS.map((b) => [b.backendKey, b]),
);

/** The backends a routing decision may actually reach — §3.2.4's `activeIdx` set. */
export const AI_PHASE_1_ACTIVE_BACKEND_KEYS: readonly string[] = AI_PHASE_1_BACKENDS.filter(
  (b) => b.isActive,
).map((b) => b.backendKey);

/** True when a backend key is one §2.3 registers. Fails CLOSED — an unregistered key is not a backend,
 *  which is what keeps a typo'd `default_backend_key` from becoming a permanently dead capability. */
export function isAiPhase1BackendKey(key: string): boolean {
  return AI_PHASE_1_BACKENDS_BY_KEY.has(key);
}
