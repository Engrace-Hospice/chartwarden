// apps/backend/src/modules/22-documents/ai-block.ts — M22 D7 / §8.5 AI-boundary boot validator (GAP-141).
//
// D7: M22 holds no AI capability code; every DocLens AI surface is an M32 capability, and AI output is NEVER an
// autonomous chart write — the pipeline always ends at a human `extraction_decision`. `extraction_candidate`
// is the AI-PRODUCED surface (legitimate); the HUMAN decision / review / commit-provenance rows are the zone
// no prompt template may target. `validateDocumentsAIBlock()` runs at boot against M32's real
// `AIPromptRegistry` (D18 table-only query) and refuses to start if an active template targets that zone.
// The registry is a LOCAL structural port (no @wardenx/ai-platform import); the composition root binds the
// real seam in the db-present onReady hook (the M37 / M21 / M23 precedent).
//
// The spec's NIGHTLY re-run (`ai-block-validator.cron.ts`) is deferred: the registry write path already
// refuses a prohibited target at registration time, so the boot gate is the load-bearing check (see the
// §4.8 deferral note in the M22 spec).

/** Output-entity prefixes an M32 prompt template may NEVER target: the human-decision half of the pipeline. */
export const DOCUMENTS_PROHIBITED_OUTPUT_ENTITY_PREFIXES: readonly string[] = [
  "extraction_decision",
  "extraction_review",
  "extraction_provenance",
];

/** The subset of an M32 active-prompt summary the validator reports on. */
export interface DocumentsAiPromptTarget {
  readonly promptTemplateId: string;
  readonly templateKey: string;
  readonly outputEntityTargetPrefix: string;
}

/** The slice of M32's `AIPromptRegistry` this validator consults (the D18 table-only query). */
export interface DocumentsAiPromptRegistryPort {
  getActivePromptsTargeting(entityPrefix: string): Promise<readonly DocumentsAiPromptTarget[]>;
}

/** Thrown when an active M32 prompt targets an M22 human-decision zone. Aborts boot (D7). */
export class DocumentsAIBlockViolation extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DocumentsAIBlockViolation";
  }
}

/** D7 boot gate. EMPTY-SAFE: no registry (a no-db slice boot) passes. */
export async function validateDocumentsAIBlock(
  registry: DocumentsAiPromptRegistryPort | null | undefined,
): Promise<void> {
  if (!registry) return;
  for (const prefix of DOCUMENTS_PROHIBITED_OUTPUT_ENTITY_PREFIXES) {
    const hits = await registry.getActivePromptsTargeting(prefix);
    const first = hits[0];
    if (first) {
      throw new DocumentsAIBlockViolation(
        `Prompt ${first.promptTemplateId} (templateKey='${first.templateKey}') targets M22 output-entity zone '${first.outputEntityTargetPrefix}' — D7 prohibits AI authorship of extraction decisions, reviews and commit provenance`,
      );
    }
  }
}
