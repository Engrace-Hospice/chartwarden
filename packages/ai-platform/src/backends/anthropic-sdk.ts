// @wardenx/ai-platform — the `@anthropic-ai/sdk` TRANSPORT behind the Anthropic adapter (F-236, ADR-0048).
//
// `./anthropic.ts` owns the D19 / §8.4 invariant (no dispatch without a resolved, unexpired ZDR contract)
// and takes the transport as a port. This file is that port's one real binding: `messages.create` on the
// official SDK. It is the only file in the monorepo that imports the SDK (the vendor-adapter mandate,
// architecture §25.14), and it is reachable ONLY through `createAnthropicModelBackend`, so there is no
// way to call it around the ZDR gate.
//
// What it refuses to smooth over:
//   · `stop_reason: "refusal"` and `"max_tokens"` THROW — a declined or cut-off answer is not a
//     completion, and the pipeline records a throw as `failed` (with the error CLASS, never its message).
//   · token counts are the vendor's `usage`, and the pin echoed back is `response.model` — the model that
//     actually served, which the ledger records even if it differs from the registry's expectation.
//   · a `responseSchema` is sent as `output_config.format` (structured outputs); the caller still parses.
import Anthropic from "@anthropic-ai/sdk";
import type { AiBackendHealthStatus } from "@wardenx/types";
import type { AnthropicDispatch } from "./anthropic";

/** The vendor answered, but not with a usable completion. Its `name` is what the ledger records. */
export class AnthropicDispatchError extends Error {
  constructor(
    readonly reason: "refusal" | "max_tokens" | "no_text",
    detail: string,
  ) {
    super(detail);
    this.name = `AnthropicDispatchError:${reason}`;
  }
}

export interface AnthropicSdkTransportOptions {
  readonly apiKey: string;
  /** The Messages API model id this backend row serves, e.g. `claude-opus-4-7`. */
  readonly model: string;
  readonly timeoutMs?: number;
  /** Injected in tests; built from `apiKey` otherwise. */
  readonly client?: Anthropic;
}

export function createAnthropicSdkTransport(options: AnthropicSdkTransportOptions): {
  dispatch: AnthropicDispatch;
  probeHealth: () => Promise<AiBackendHealthStatus>;
} {
  const client =
    options.client ??
    new Anthropic({ apiKey: options.apiKey, timeout: options.timeoutMs ?? 300_000, maxRetries: 1 });

  const dispatch: AnthropicDispatch = async (request) => {
    const response = await client.messages.create({
      model: options.model,
      max_tokens: request.maxOutputTokens,
      ...(request.systemPrompt ? { system: request.systemPrompt } : {}),
      messages: [{ role: "user", content: request.prompt }],
      ...(request.responseSchema
        ? {
            output_config: {
              format: { type: "json_schema" as const, schema: request.responseSchema },
            },
          }
        : {}),
    });
    if (response.stop_reason === "refusal") {
      throw new AnthropicDispatchError("refusal", "the model declined the request");
    }
    if (response.stop_reason === "max_tokens") {
      throw new AnthropicDispatchError("max_tokens", "the answer hit max_tokens and is incomplete");
    }
    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
    if (text.length === 0)
      throw new AnthropicDispatchError("no_text", "the response carried no text");
    return {
      text,
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      modelVersionPin: response.model,
    };
  };

  const probeHealth = async (): Promise<AiBackendHealthStatus> => {
    try {
      await client.models.retrieve(options.model);
      return "healthy";
    } catch (err) {
      // Rate-limited or overloaded still means the vendor and the model exist: degraded, not down.
      if (err instanceof Anthropic.RateLimitError || err instanceof Anthropic.InternalServerError) {
        return "degraded";
      }
      return "unhealthy";
    }
  };

  return { dispatch, probeHealth };
}
