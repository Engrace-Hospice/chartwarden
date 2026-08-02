// @wardenx/fhir — the D14 AI-prohibited-zone boot validator (§8.6, W-FHIR-11, M28-T05).
//
// D14: Module 32's LLM may not synthesize, modify, redact, or decide on a FHIR resource — projections
// must be DETERMINISTIC mappings from authoritative module data so the §164.528 disclosure record is
// reproducible (an LLM's output is not). `validateFhirAIBlock()` runs at M28 boot against M32's prompt
// registry; a violation aborts startup (W-FHIR-11), the same boot-fitness pattern as M12 D12 / M13 D15 /
// M22 D-pattern.
//
// ── DEPARTURE FROM §8.6's ILLUSTRATIVE SNIPPET, AND WHY ─────────────────────────────────────────────
// §8.6 sketches `promptRegistry.all()` returning `{ id, kind, template }` and scans `kind` against a
// PROHIBITED_PROMPT_KINDS list + regexes over `template`. The REAL M32 registry (`AIPromptRegistry`,
// `packages/ai-platform/src/prompts/prompt-registry.ts`) exposes neither a `kind` nor a cheap template
// BODY on its summary rows — and that file EXPLICITLY names M28 as a consumer: "M12, M13, M18, M21, M27
// and M28 each call `getActivePromptsTargeting(<prefix>)` at their OWN boot and refuse to start if any
// active prompt template targets their prohibited entity." Architecture/real-registry authority wins over
// a spec proposal, so the validator binds the REAL contract: it asks the D18 table-only query whether any
// ACTIVE prompt declares a FHIR output-entity zone as its target. That query "answers from the table
// alone" and "must never fail open" (registry departure 3) — strictly stronger than a regex over free
// text, which a paraphrase defeats. Keeping a parallel `{kind, template}` shape M32 does not serve is the
// exact registry-drift trap to avoid.
//
// The registry is INJECTED as a LOCAL port (T03/T04 idiom); T06 binds the real `@wardenx/ai-platform`
// `AIPromptRegistry`. No `@wardenx/ai-platform` import, no `dependsOn` edge, ahead of that bind.

/** Thrown when an active M32 prompt targets a FHIR output-entity zone. Aborts M28 boot (W-FHIR-11). */
export class FhirAIBlockViolation extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FhirAIBlockViolation";
  }
}

/** The FHIR output-entity zones an M32 prompt template may NEVER target (D14). M32 prefix-matches the
 *  query against each active template's `output_entity_target_prefix` (a template targeting `fhir_patient`
 *  is returned for the queried `fhir` prefix), so a single `fhir` zone covers the whole FHIR-resource
 *  surface. Each module guards only its OWN entity zone; this is M28's. */
export const FHIR_PROHIBITED_OUTPUT_ENTITY_PREFIXES: readonly string[] = ["fhir"];

/** The subset of an M32 `ActivePromptSummary` the validator reports on. */
export interface FhirAiPromptTarget {
  readonly promptTemplateId: string;
  readonly templateKey: string;
  readonly outputEntityTargetPrefix: string;
}

/** The slice of M32's `AIPromptRegistry` M28's boot validator consults — the D18 table-only query. */
export interface FhirAiPromptRegistryPort {
  /** Every ACTIVE template whose `output_entity_target_prefix` starts with `entityPrefix`. Never returns
   *  `[]` because a lookup failed — an empty array must mean "no active template targets this zone". */
  getActivePromptsTargeting(entityPrefix: string): Promise<readonly FhirAiPromptTarget[]>;
}

/**
 * D14 boot gate: refuse to start if any active M32 prompt targets a FHIR output-entity zone (W-FHIR-11).
 * Runs at `bootstrapModule28` (wired T06/T08); a hit throws `FhirAIBlockViolation` naming the offending
 * template so CI reports which prompt to withdraw.
 */
export async function validateFhirAIBlock(registry: FhirAiPromptRegistryPort): Promise<void> {
  for (const prefix of FHIR_PROHIBITED_OUTPUT_ENTITY_PREFIXES) {
    const hits = await registry.getActivePromptsTargeting(prefix);
    if (hits.length > 0) {
      const h = hits[0]!;
      throw new FhirAIBlockViolation(
        `Prompt ${h.promptTemplateId} (templateKey='${h.templateKey}') targets FHIR output-entity zone ` +
          `'${h.outputEntityTargetPrefix}' — D14 prohibits AI synthesis/modification/redaction of FHIR resources`,
      );
    }
  }
}
