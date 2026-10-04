// @wardenx/ai-platform — the Ollama (local model) vendor adapter (F-236, ADR-0048).
//
// One adapter per `ai_model_backend` row of kind `local`, speaking to an Ollama server's `/api/chat`. PHI
// sent here stays on infrastructure the tenant controls — which is the whole point of a `local_only`
// routing preference (W8), so this adapter must never fall back to anything else: a failure is a thrown
// error the invocation pipeline records as `failed`, never a quiet substitution.
//
// Three Ollama behaviours this adapter refuses to inherit silently:
//
//   · CONTEXT TRUNCATION. Ollama's default `num_ctx` is small, and a prompt longer than it is truncated
//     FROM THE FRONT with no error — a twenty-page fax would lose its first pages and the model would
//     answer anyway. `numCtx` is therefore required configuration, and a response whose
//     `prompt_eval_count` reached the window is treated as truncated and thrown.
//   · THINKING. Reasoning models emit a separate `thinking` stream; `think: false` is sent unless the
//     backend is configured otherwise, and only `message.content` is ever returned.
//   · TOKEN COUNTS. `prompt_eval_count` / `eval_count` are the runtime's own counts (model-backend.ts:
//     vendor counts, never estimates). A response without them is rejected rather than ledgered as zero.
//
// The served model is echoed back as `ollama/<model>` so the ledger's `model_version_pin` names the
// model that actually ran, whatever the registry row expected.
import type { AiBackendHealthStatus } from "@wardenx/types";
import type {
  ModelBackend,
  ModelBackendCapabilities,
  ModelBackendCompletionRequest,
  ModelBackendCompletionResult,
} from "./model-backend";

export interface OllamaModelBackendOptions {
  /** The `ai_model_backend.backend_key` this adapter serves, e.g. `local-llama-3.1-8b-instruct`. */
  readonly backendKey: string;
  /** e.g. `http://host.docker.internal:11434` */
  readonly baseUrl: string;
  /** The Ollama model tag, e.g. `llama3.1:8b-instruct-q4_K_M`. */
  readonly model: string;
  /** Required — see the header (silent front-truncation otherwise). */
  readonly numCtx: number;
  readonly capabilities: Omit<ModelBackendCapabilities, "backendKey" | "kind">;
  /** Send `think: true` (default false). Only for models that support it. */
  readonly think?: boolean;
  readonly fetchImpl?: typeof fetch;
  readonly healthTimeoutMs?: number;
}

/** The Ollama server answered, but not with a usable completion. */
export class OllamaBackendError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = "OllamaBackendError";
  }
}

interface OllamaChatResponse {
  readonly model?: string;
  readonly message?: { readonly content?: string };
  readonly prompt_eval_count?: number;
  readonly eval_count?: number;
  readonly done?: boolean;
  readonly done_reason?: string;
}

export function createOllamaModelBackend(options: OllamaModelBackendOptions): ModelBackend {
  if (!Number.isInteger(options.numCtx) || options.numCtx < 2048) {
    throw new OllamaBackendError(
      `ollama backend '${options.backendKey}' needs an explicit numCtx >= 2048 (silent truncation otherwise)`,
    );
  }
  const base = options.baseUrl.replace(/\/+$/, "");
  const doFetch = options.fetchImpl ?? fetch;

  return {
    backendKey: options.backendKey,
    kind: "local",
    capabilities: () => ({
      ...options.capabilities,
      backendKey: options.backendKey,
      kind: "local",
    }),

    async health(): Promise<AiBackendHealthStatus> {
      try {
        const res = await doFetch(`${base}/api/tags`, {
          signal: AbortSignal.timeout(options.healthTimeoutMs ?? 5_000),
        });
        if (!res.ok) return "unhealthy";
        const body = (await res.json()) as { models?: ReadonlyArray<{ name?: string }> };
        // Reachable but the configured model is not pulled: it cannot serve, so it is not healthy.
        return (body.models ?? []).some((m) => m.name === options.model) ? "healthy" : "unhealthy";
      } catch {
        return "unhealthy";
      }
    },

    async complete(request: ModelBackendCompletionRequest): Promise<ModelBackendCompletionResult> {
      const messages = [
        ...(request.systemPrompt ? [{ role: "system", content: request.systemPrompt }] : []),
        {
          role: "user",
          content: request.prompt,
          // F-237 — Ollama's chat API takes raw base64 images on the message (vision models only).
          ...(request.images?.length ? { images: request.images.map((i) => i.dataBase64) } : {}),
        },
      ];
      const res = await doFetch(`${base}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: options.model,
          messages,
          stream: false,
          think: options.think ?? false,
          ...(request.responseSchema ? { format: request.responseSchema } : {}),
          options: {
            num_ctx: options.numCtx,
            num_predict: request.maxOutputTokens,
            temperature: 0,
          },
        }),
      });
      if (!res.ok) {
        // The status only: an Ollama error body can echo the prompt back.
        throw new OllamaBackendError(`ollama /api/chat answered HTTP ${res.status}`);
      }
      const body = (await res.json()) as OllamaChatResponse;
      const text = body.message?.content;
      if (typeof text !== "string")
        throw new OllamaBackendError("ollama response has no message content");
      if (typeof body.prompt_eval_count !== "number" || typeof body.eval_count !== "number") {
        throw new OllamaBackendError("ollama response has no token counts");
      }
      if (body.prompt_eval_count >= options.numCtx) {
        throw new OllamaBackendError(
          `prompt filled the ${options.numCtx}-token context window; ollama truncates silently, so the answer is refused`,
        );
      }
      if (body.done_reason === "length") {
        throw new OllamaBackendError(
          "ollama stopped at the output-token limit; the answer is incomplete",
        );
      }
      return {
        text,
        inputTokens: body.prompt_eval_count,
        outputTokens: body.eval_count,
        modelVersionPin: `ollama/${body.model ?? options.model}`,
      };
    },
  };
}
