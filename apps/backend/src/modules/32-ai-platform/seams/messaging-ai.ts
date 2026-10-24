// apps/backend/src/modules/32-ai-platform/seams/messaging-ai.ts - ADR-0095 (M36 WP 6.5): M32's implementation of the `MessagingAiPort` that M36
// consumes. A thin adapter over the ONE governed pipeline: it adds no gate and decides no rule (flag, lifecycle, kill switch, opt-in, opt-out, token
// cap, PHI minimisation and routing all run inside `pipeline.invoke`). What it adds is the translation M36 must not know about: which capability
// key serves which call, the reviewed system prompt from the prompt registry, the actor's membership / provider entity (ARCH-011), and the
// consumer context that proves what the ledger row covered.
//
// EVERY REFUSAL COLLAPSES TO `{ available: false }`. M36 shows one sentence ("AI unavailable"); the gate that said no, and why, stays in the
// operator-facing `warn` (never PHI, never the prompt). There is no fallback to another capability, backend or path.
//
// It returns TEXT. It has no tool, function-calling or write capability, and the M36 side validates the text before any of it is shown.
import {
  MESSAGING_AI_CAPABILITY_DRAFT_REPLY,
  MESSAGING_AI_CAPABILITY_SUMMARIZE,
  type MessagingAiCompletion,
  type MessagingAiOutcomeInput,
  type MessagingAiPort,
  type MessagingAiRequest,
} from "@chartwarden/types";
import type { AiInvocationPipeline } from "../invocation/service";
import type { AiSeamActorResolver, AiSeamPromptSource } from "./published";

/** The consumer module id recorded on the ledger row (never M32's own, §3.2.8). */
const CONSUMER_MODULE = "m36";
const CONSUMER_ENTITY_KIND = "channel";

export interface MessagingAiPortDeps {
  readonly pipeline: AiInvocationPipeline;
  /** The reviewed, hash-pinned template for the capability; a capability with none REFUSES. */
  readonly prompts: AiSeamPromptSource;
  readonly actors: AiSeamActorResolver;
  readonly warn?: (message: string, context: Record<string, string>) => void;
  readonly now?: () => Date;
}

export function createMessagingAiPort(deps: MessagingAiPortDeps): MessagingAiPort {
  const clock = deps.now ?? (() => new Date());
  const refuse = (
    reason: string,
    request: MessagingAiRequest,
    capabilityKey: string,
  ): MessagingAiCompletion => {
    deps.warn?.("messaging AI call refused", {
      organizationId: request.organizationId,
      capabilityKey,
      reason,
    });
    return { available: false };
  };

  async function run(
    capabilityKey: string,
    request: MessagingAiRequest,
  ): Promise<MessagingAiCompletion> {
    const actor = await deps.actors.resolve(request.organizationId, request.actorUserId);
    if (actor === null) return refuse("no actor / provider entity", request, capabilityKey);
    let template: Awaited<ReturnType<AiSeamPromptSource["getActivePromptForCapability"]>>;
    try {
      template = await deps.prompts.getActivePromptForCapability(capabilityKey);
    } catch {
      return refuse("prompt template unreadable or hash drift", request, capabilityKey);
    }
    if (template === null) return refuse("no active prompt template", request, capabilityKey);

    const outcome = await deps.pipeline.invoke({
      capabilityKey,
      organizationId: request.organizationId,
      providerEntityId: actor.providerEntityId,
      locationId: actor.locationId ?? null,
      actorMembershipId: actor.actorMembershipId,
      actorRole: actor.actorRole,
      patientId: request.patientId,
      consumerContextRef: {
        module: CONSUMER_MODULE,
        entityKind: CONSUMER_ENTITY_KIND,
        entityId: request.channelId,
        messageRange: request.messageRange,
      },
      prompt: {
        text: request.promptText,
        systemPrompt: template.promptBody,
        templateId: template.promptTemplateId,
        templateVersion: String(template.version),
      },
      // The allowlist (`chart-context-rules.ts`) admits exactly these two keys for the messaging capabilities.
      chartContext: { channelId: request.channelId, messageCount: request.messageRange.count },
      responseSchema: { ...request.responseSchema },
      maxOutputTokens: request.maxOutputTokens,
      dispatchTimeoutMs: request.dispatchTimeoutMs,
      invokedAt: clock().toISOString(),
    });
    if (!outcome.available)
      return refuse(`${outcome.gate}: ${outcome.detail}`, request, capabilityKey);
    return {
      available: true,
      invocationId: outcome.invocationId,
      invokedAt: outcome.invokedAt,
      text: outcome.output.text,
    };
  }

  return {
    summarize: (request) => run(MESSAGING_AI_CAPABILITY_SUMMARIZE, request),
    draftReply: (request) => run(MESSAGING_AI_CAPABILITY_DRAFT_REPLY, request),

    async recordOutcome(input: MessagingAiOutcomeInput) {
      const actor = await deps.actors.resolve(input.organizationId, input.actorUserId);
      if (actor === null) return "not_found";
      try {
        // Guarded: the row must be this actor's, a messaging capability's, about this channel, and still open.
        await deps.pipeline.recordHitlOutcome(
          input.organizationId,
          input.invocationId,
          input.invokedAt,
          input.outcome,
          {
            actorMembershipId: actor.actorMembershipId,
            capabilityKeys: [
              MESSAGING_AI_CAPABILITY_SUMMARIZE,
              MESSAGING_AI_CAPABILITY_DRAFT_REPLY,
            ],
            consumerEntityId: input.channelId,
          },
        );
        return "recorded";
      } catch {
        return "not_found";
      }
    },
  };
}
