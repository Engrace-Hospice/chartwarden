// apps/backend/src/modules/21-supplies/ai-block.ts — M21 D15 AI-prohibited-zone boot validator (§8.6, GAP-137).
//
// D15: Module 32's LLM may not create, modify, witness, or attest to any supplies / controlled-substance
// dispatch row. `validateSupplyAIBlock()` runs at boot against M32's real `AIPromptRegistry` (the D18
// table-only query) and REFUSES to start if an active prompt targets an M21 zone. The registry is injected
// as a LOCAL structural port (no @wardenx/ai-platform import, no dependsOn edge); the composition root binds
// the real seam in a db-present onReady hook (the M37 `validateIpuAIBlock` precedent).
//
// Per-route layer: `rejectAiActor` in ./routes/actor.ts rejects an `actor_kind='ai_*'` principal on every
// mutating M21 route (mounted in routes/mount.ts).

/** Output-entity prefixes an M32 prompt template may NEVER target (D15 + the central AI_PROHIBITED_ZONES). */
export const SUPPLY_PROHIBITED_OUTPUT_ENTITY_PREFIXES: readonly string[] = [
  "supply_",
  "controlled_substance_dispatch_",
  "comfort_kit",
  "vendor_routing",
  "par_stock",
];

/** The subset of an M32 active-prompt summary the validator reports on. */
export interface SupplyAiPromptTarget {
  readonly promptTemplateId: string;
  readonly templateKey: string;
  readonly outputEntityTargetPrefix: string;
}

/** The slice of M32's `AIPromptRegistry` this validator consults (the D18 table-only query). */
export interface SupplyAiPromptRegistryPort {
  getActivePromptsTargeting(entityPrefix: string): Promise<readonly SupplyAiPromptTarget[]>;
}

/** Thrown when an active M32 prompt targets an M21 zone. Aborts boot (D15). */
export class SupplyAIBlockViolation extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SupplyAIBlockViolation";
  }
}

/** D15 boot gate. EMPTY-SAFE: no registry (a no-db slice boot) passes. */
export async function validateSupplyAIBlock(
  registry: SupplyAiPromptRegistryPort | null | undefined,
): Promise<void> {
  if (!registry) return;
  for (const prefix of SUPPLY_PROHIBITED_OUTPUT_ENTITY_PREFIXES) {
    const hits = await registry.getActivePromptsTargeting(prefix);
    const first = hits[0];
    if (first) {
      throw new SupplyAIBlockViolation(
        `Prompt ${first.promptTemplateId} (templateKey='${first.templateKey}') targets supplies output-entity zone '${first.outputEntityTargetPrefix}' — M21 D15 prohibits AI authorship of supply requests, comfort-kit custody and controlled-substance dispatch records`,
      );
    }
  }
}
