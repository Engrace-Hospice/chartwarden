// apps/backend/src/modules/25-remittance/ai/ai-block.ts - M25 AI-prohibited-zone boot validator (milestone 8a-1; the
// `22-documents/ai-block.ts` precedent).
//
// AI output is ADVISORY and sits beside the human record. No M32 prompt template may name an M25 case, packet, checklist
// or submission entity as its output target, so a template can never write the human record. `adr_readiness_*` (the
// advisory surface itself) is deliberately NOT in this list: that is where AI output legitimately lands.
// `validateRemittanceAIBlock()` runs at boot against M32's real `AIPromptRegistry` (D18 table-only query) and refuses to
// start if an active template targets the zone. The registry is a LOCAL structural port (no @chartwarden/ai-platform
// import); the composition root binds the real seam in the db-present onReady hook (the M22 / M23 / M37 precedent).

/** Output-entity prefixes an M32 prompt template may NEVER target. Prefix match: the template's target is the haystack. */
export const REMITTANCE_PROHIBITED_OUTPUT_ENTITY_PREFIXES: readonly string[] = [
  "adr_case",
  "appeal_case",
  "denial_case",
  "reopening_case",
  "audit_request",
  "submission_attempt",
  "remittance_",
  "recorded_deadline",
];

/** The subset of an M32 active-prompt summary the validator reports on. */
export interface RemittanceAiPromptTarget {
  readonly promptTemplateId: string;
  readonly templateKey: string;
  readonly outputEntityTargetPrefix: string;
}

/** The slice of M32's `AIPromptRegistry` this validator consults (the D18 table-only query). */
export interface RemittanceAiPromptRegistryPort {
  getActivePromptsTargeting(entityPrefix: string): Promise<readonly RemittanceAiPromptTarget[]>;
}

/** Thrown when an active M32 prompt targets an M25 human-record zone. Aborts boot. */
export class RemittanceAIBlockViolation extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RemittanceAIBlockViolation";
  }
}

/** Boot gate. EMPTY-SAFE: no registry (a no-db slice boot) passes. */
export async function validateRemittanceAIBlock(
  registry: RemittanceAiPromptRegistryPort | null | undefined,
): Promise<void> {
  if (!registry) return;
  for (const prefix of REMITTANCE_PROHIBITED_OUTPUT_ENTITY_PREFIXES) {
    const hits = await registry.getActivePromptsTargeting(prefix);
    const first = hits[0];
    if (first) {
      throw new RemittanceAIBlockViolation(
        `Prompt ${first.promptTemplateId} (templateKey='${first.templateKey}') targets M25 output-entity zone '${first.outputEntityTargetPrefix}' - AI is advisory and may not author cases, packets, checklists, deadlines or submissions`,
      );
    }
  }
}
