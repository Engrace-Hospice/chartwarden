// @wardenx/inpatient — M37-T11 the D16 AI-prohibited-zone boot validator (§8.6, mirrors M28's
// packages/fhir/src/ai-block.ts).
//
// D16: Module 32's LLM may not create, modify, attest, or witness any of M37's safety/attestation zones —
// GIP admission criteria + reassessment, IRC cap-override, restraint application + reassessment, and
// body-release coordination + authorization. (Death recording is M6's `death_event` zone — M37 only consumes
// the trigger.) HearthNote Layer-2 read-only narration AROUND an IPU admission is permitted (its output
// entity is M8's `encounter_narrative`, which does not match any prefix below), so this validator guards the
// specific M37-owned mutation zones, NOT a blanket `ipu_` prefix. `validateIpuAIBlock()` runs at M37 boot
// against M32's prompt registry; a hit aborts startup — the same boot-fitness pattern as M28 D14 / M13 D15.
//
// The real M32 registry (`AIPromptRegistry`) exposes the D18 TABLE-ONLY query `getActivePromptsTargeting`,
// which "answers from the table alone and never returns [] because a lookup failed" — strictly stronger than
// a regex over a template body, which a paraphrase defeats. The registry is injected as a LOCAL port (no
// @wardenx/ai-platform import / no dependsOn edge); the composition root binds the real seam.

/** Thrown when an active M32 prompt targets an M37 output-entity zone. Aborts M37 boot (D16). */
export class IpuAIBlockViolation extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IpuAIBlockViolation";
  }
}

/** The M37 output-entity zones an M32 prompt template may NEVER target (D16). Prefix-matched against each
 *  active template's `output_entity_target_prefix`; each is a specific M37 mutation surface (a blanket
 *  `ipu_` would wrongly block the permitted read-only narration). Mirrored in @wardenx/ai-platform's
 *  central `AI_PROHIBITED_ZONES` table (the R30 registration-time guard). */
export const IPU_PROHIBITED_OUTPUT_ENTITY_PREFIXES: readonly string[] = [
  "gip_criteria_",
  "irc_cap_override_",
  "ipu_restraint_",
  "ipu_body_release_",
];

/** The subset of an M32 active-prompt summary the validator reports on. */
export interface IpuAiPromptTarget {
  readonly promptTemplateId: string;
  readonly templateKey: string;
  readonly outputEntityTargetPrefix: string;
}

/** The slice of M32's `AIPromptRegistry` M37's boot validator consults — the D18 table-only query. */
export interface IpuAiPromptRegistryPort {
  /** Every ACTIVE template whose `output_entity_target_prefix` starts with `entityPrefix`. Never returns
   *  `[]` because a lookup failed — an empty array must mean "no active template targets this zone". */
  getActivePromptsTargeting(entityPrefix: string): Promise<readonly IpuAiPromptTarget[]>;
}

/**
 * D16 boot gate: refuse to start if any active M32 prompt targets an M37 output-entity zone. A hit throws
 * {@link IpuAIBlockViolation} naming the offending template so CI reports which prompt to withdraw. Runs at
 * M37 boot (the composition root's db-present onReady hook), consulting the real `AIPromptRegistry` seam.
 */
export async function validateIpuAIBlock(registry: IpuAiPromptRegistryPort): Promise<void> {
  for (const prefix of IPU_PROHIBITED_OUTPUT_ENTITY_PREFIXES) {
    const hits = await registry.getActivePromptsTargeting(prefix);
    if (hits.length > 0) {
      const h = hits[0]!;
      throw new IpuAIBlockViolation(
        `Prompt ${h.promptTemplateId} (templateKey='${h.templateKey}') targets IPU output-entity zone ` +
          `'${h.outputEntityTargetPrefix}' — D16 prohibits AI synthesis/attestation of GIP criteria, ` +
          `IRC cap-override, restraint, or body-release records`,
      );
    }
  }
}
