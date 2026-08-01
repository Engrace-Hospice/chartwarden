// apps/backend/src/modules/32-ai-platform/prompts/service.ts — R29/R30, M32-T05.
//
// The rule is `evaluateAiPromptActivation` (pure); this file resolves the two facts it needs — the
// capability's current active row and any row already holding the requested version — reads the
// artifact so the submitted hash is checked against BYTES rather than against itself, and invalidates
// the registry cache on success (§4.10: "Cache invalidation triggered ... by direct invalidation when
// POST /api/v1/ai/prompts/:capabilityKey/activate succeeds").
import {
  evaluateAiPromptActivation,
  requireAiGovernance,
  type AiPromptActivationRequest,
} from "@wardenx/ai-platform";

import type { AiPromptArtifactReader, AiPromptTemplateRowProjection, AiPromptTemplateStore } from "./store";

export interface AiPromptServiceDeps {
  readonly store: AiPromptTemplateStore;
  readonly artifacts: AiPromptArtifactReader;
  /** The live registry, so R30's success evicts the entry the next invocation would have read. */
  readonly registry?: { invalidate(capabilityKey?: string): void };
  readonly now?: () => string;
}

/** R30's body, minus the `resolvedContentHash` this service computes. */
export type AiPromptActivationCommand = Omit<AiPromptActivationRequest, "resolvedContentHash">;

/**
 * R30 / W6.8 — activate a prompt template version.
 *
 * THE ARTIFACT IS READ HERE, NOT TRUSTED FROM THE REQUEST. A caller supplying both the file path and
 * its hash is asserting they agree; verifying that assertion against the bytes is the only thing that
 * makes the pin mean anything, and it is why `resolvedContentHash` is a computed field rather than an
 * input. With the Phase-1 unresolvable reader this refuses every activation, which is the correct
 * posture for a wave with no prompt mount: a template pinned to a file nothing can read is a governance
 * record of a prompt nobody can reproduce.
 */
export async function activateAiPromptTemplate(
  deps: AiPromptServiceDeps,
  command: AiPromptActivationCommand,
): Promise<AiPromptTemplateRowProjection> {
  const [current, existing, artifact] = await Promise.all([
    deps.store.findActiveForCapability(command.capabilityKey),
    deps.store.findByCapabilityVersion(command.capabilityKey, command.version),
    deps.artifacts.read(command.templateFilesystemRef),
  ]);

  const decision = requireAiGovernance(
    evaluateAiPromptActivation(
      { ...command, resolvedContentHash: artifact?.contentHash ?? null },
      current,
      existing,
      (deps.now ?? (() => new Date().toISOString()))(),
    ),
  );

  const row = await deps.store.applyActivation(decision.plan);
  deps.registry?.invalidate(command.capabilityKey);
  return row;
}
