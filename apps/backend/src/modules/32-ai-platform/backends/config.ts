// apps/backend/src/modules/32-ai-platform/backends/config.ts — which model backends THIS DEPLOYMENT can
// actually reach, built from its environment (F-236, ADR-0048).
//
// The §2.3 inventory (`AI_PHASE_1_BACKENDS`) says which backend KEYS exist; it deliberately leaves the
// model pin, ZDR status and BAA reference unstated, because only a deployment knows them. This file is
// where a deployment states them, and it binds an adapter ONLY for a key the inventory registers — a
// typo'd or invented key is refused at boot, never served.
//
//   OLLAMA_BASE_URL        e.g. http://host.docker.internal:11434
//   OLLAMA_NUM_CTX         context window sent on every call (default 32768; see ollama.ts on truncation)
//   OLLAMA_MODELS          backendKey=ollamaTag[,…]   e.g. local-llama-3.1-8b-instruct=llama3.1:8b-instruct-q8_0
//   ANTHROPIC_API_KEY      enables the Anthropic adapters (still refused per call without a ZDR contract)
//   ANTHROPIC_MODELS       backendKey=modelId[,…]     default: every `anthropic-*` inventory key → its own
//                          suffix (anthropic-claude-opus-4-7 → claude-opus-4-7) — the key names the model
//   ANTHROPIC_ZDR_CONTRACT_REF / ANTHROPIC_ZDR_VERIFIED_AT / ANTHROPIC_ZDR_EXPIRES_AT
//                          the operator's Zero-Data-Retention contract with Anthropic. Absent or expired ⇒
//                          the Anthropic adapter refuses every call (D19 / §8.4), whatever the key says.
//   AI_MAX_OUTPUT_TOKENS   per-backend output cap advertised to the router (default 8192)
import {
  AI_PHASE_1_BACKENDS_BY_KEY,
  type AnthropicZdrContract,
  type ModelBackend,
  createAnthropicModelBackend,
  createAnthropicSdkTransport,
  createOllamaModelBackend,
} from "@chartwarden/ai-platform";

export interface AiBackendDeploymentConfig {
  readonly ollama: {
    readonly baseUrl: string;
    readonly numCtx: number;
    readonly models: ReadonlyMap<string, string>;
  } | null;
  readonly anthropic: {
    readonly apiKey: string;
    readonly models: ReadonlyMap<string, string>;
    readonly zdr: AnthropicZdrContract | null;
  } | null;
  readonly maxOutputTokens: number;
}

export class AiBackendConfigError extends Error {
  constructor(detail: string) {
    super(`AI backend configuration: ${detail}`);
    this.name = "AiBackendConfigError";
  }
}

function parsePairs(raw: string | undefined, label: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)) {
    const i = part.indexOf("=");
    if (i <= 0 || i === part.length - 1)
      throw new AiBackendConfigError(`${label} entry '${part}' is not key=value`);
    out.set(part.slice(0, i).trim(), part.slice(i + 1).trim());
  }
  return out;
}

function assertInventoryKey(key: string, kind: "local" | "cloud"): void {
  const row = AI_PHASE_1_BACKENDS_BY_KEY.get(key);
  if (!row)
    throw new AiBackendConfigError(`'${key}' is not a backend the §2.3 inventory registers`);
  if (row.kind !== kind)
    throw new AiBackendConfigError(`'${key}' is a ${row.kind} backend, not ${kind}`);
  if (!row.isActive) throw new AiBackendConfigError(`'${key}' is registered inactive`);
}

export function aiBackendConfigFromEnv(
  env: Record<string, string | undefined>,
): AiBackendDeploymentConfig {
  const maxOut = Number(env.AI_MAX_OUTPUT_TOKENS ?? 8192);
  if (!Number.isInteger(maxOut) || maxOut < 256)
    throw new AiBackendConfigError("AI_MAX_OUTPUT_TOKENS is invalid");

  let ollama: AiBackendDeploymentConfig["ollama"] = null;
  const ollamaUrl = env.OLLAMA_BASE_URL?.trim();
  if (ollamaUrl) {
    const models = parsePairs(env.OLLAMA_MODELS, "OLLAMA_MODELS");
    if (models.size === 0)
      throw new AiBackendConfigError("OLLAMA_BASE_URL is set but OLLAMA_MODELS names no model");
    for (const key of models.keys()) assertInventoryKey(key, "local");
    const numCtx = Number(env.OLLAMA_NUM_CTX ?? 32768);
    ollama = { baseUrl: ollamaUrl, numCtx, models };
  }

  let anthropic: AiBackendDeploymentConfig["anthropic"] = null;
  const apiKey = env.ANTHROPIC_API_KEY?.trim();
  if (apiKey) {
    const explicit = parsePairs(env.ANTHROPIC_MODELS, "ANTHROPIC_MODELS");
    const models = explicit.size
      ? explicit
      : new Map(
          [...AI_PHASE_1_BACKENDS_BY_KEY.values()]
            .filter(
              (b) => b.kind === "cloud" && b.isActive && b.backendKey.startsWith("anthropic-"),
            )
            .map((b) => [b.backendKey, b.backendKey.slice("anthropic-".length)] as const),
        );
    for (const key of models.keys()) assertInventoryKey(key, "cloud");
    const ref = env.ANTHROPIC_ZDR_CONTRACT_REF?.trim();
    const zdr =
      ref && env.ANTHROPIC_ZDR_EXPIRES_AT
        ? {
            contractRef: ref,
            verifiedAt: env.ANTHROPIC_ZDR_VERIFIED_AT ?? "",
            expiresAt: env.ANTHROPIC_ZDR_EXPIRES_AT,
          }
        : null;
    anthropic = { apiKey, models, zdr };
  }

  return { ollama, anthropic, maxOutputTokens: maxOut };
}

/** Build one adapter per configured backend key. Pure apart from the adapters' own transports. */
export function buildConfiguredModelBackends(
  config: AiBackendDeploymentConfig,
  deps: { readonly fetchImpl?: typeof fetch } = {},
): ModelBackend[] {
  const out: ModelBackend[] = [];
  if (config.ollama) {
    for (const [backendKey, model] of config.ollama.models) {
      const row = AI_PHASE_1_BACKENDS_BY_KEY.get(backendKey);
      if (!row) continue; // unreachable: asserted at parse
      out.push(
        createOllamaModelBackend({
          backendKey,
          baseUrl: config.ollama.baseUrl,
          model,
          numCtx: config.ollama.numCtx,
          ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
          capabilities: {
            modelVersionPin: `ollama/${model}`,
            supportedModalities: row.supportedModalities,
            contextWindowTokens: config.ollama.numCtx,
            maxOutputTokens: config.maxOutputTokens,
            supportedFeatures: {
              structured_output: true,
              tool_use: false,
              vision: false,
              streaming: false,
            },
          },
        }),
      );
    }
  }
  if (config.anthropic) {
    const zdr = config.anthropic.zdr;
    for (const [backendKey, model] of config.anthropic.models) {
      const row = AI_PHASE_1_BACKENDS_BY_KEY.get(backendKey);
      if (!row) continue;
      const transport = createAnthropicSdkTransport({ apiKey: config.anthropic.apiKey, model });
      out.push(
        createAnthropicModelBackend({
          backendKey,
          // The deployment's contract with Anthropic covers every tenant it routes there; a tenant
          // whose routing forbids the cloud never reaches this adapter (W8 — the routing gate).
          zdrContractResolver: async () => zdr,
          dispatch: transport.dispatch,
          probeHealth: transport.probeHealth,
          capabilities: {
            modelVersionPin: model,
            supportedModalities: row.supportedModalities,
            contextWindowTokens: row.contextWindowTokens ?? 200_000,
            maxOutputTokens: config.maxOutputTokens,
            supportedFeatures: {
              structured_output: true,
              tool_use: true,
              vision: true,
              streaming: true,
            },
          },
        }),
      );
    }
  }
  return out;
}
