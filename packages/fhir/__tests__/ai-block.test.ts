// Module 28 — §8.6 / D14 / W-FHIR-11 the AI-prohibited-zone boot validator (M28-T05).
//
// D14: no active M32 prompt may target a FHIR output-entity zone, so FHIR projections stay deterministic
// and the §164.528 disclosure record is reproducible. These lock: a clean registry passes; any active
// prompt targeting the `fhir` zone throws `FhirAIBlockViolation` naming the template (aborting boot); the
// query is the D18 table-only `getActivePromptsTargeting` (never fails open on a paraphrase).

import { describe, expect, it, vi } from "vitest";

import {
  FHIR_PROHIBITED_OUTPUT_ENTITY_PREFIXES,
  FhirAIBlockViolation,
  type FhirAiPromptRegistryPort,
  type FhirAiPromptTarget,
  validateFhirAIBlock,
} from "../src";

/** A fake M32 registry — the D18 slice T06 binds the real `AIPromptRegistry` to. */
function registry(byPrefix: Record<string, FhirAiPromptTarget[]>): FhirAiPromptRegistryPort {
  return {
    async getActivePromptsTargeting(entityPrefix) {
      return byPrefix[entityPrefix] ?? [];
    },
  };
}

describe("validateFhirAIBlock", () => {
  it("passes when no active prompt targets a FHIR output-entity zone", async () => {
    await expect(validateFhirAIBlock(registry({}))).resolves.toBeUndefined();
  });

  it("throws FhirAIBlockViolation naming the offending template (W-FHIR-11)", async () => {
    const reg = registry({
      fhir: [
        {
          promptTemplateId: "tmpl-42",
          templateKey: "fhir_patient_generate",
          outputEntityTargetPrefix: "fhir_patient",
        },
      ],
    });
    await expect(validateFhirAIBlock(reg)).rejects.toBeInstanceOf(FhirAIBlockViolation);
    await expect(validateFhirAIBlock(reg)).rejects.toThrow(/tmpl-42/);
    await expect(validateFhirAIBlock(reg)).rejects.toThrow(/fhir_patient_generate/);
  });

  it("queries every prohibited FHIR zone prefix (the D18 table-only query)", async () => {
    const getActivePromptsTargeting = vi.fn(async () => []);
    await validateFhirAIBlock({ getActivePromptsTargeting });
    expect(getActivePromptsTargeting.mock.calls.map((c) => c[0])).toEqual([
      ...FHIR_PROHIBITED_OUTPUT_ENTITY_PREFIXES,
    ]);
  });

  it("catches a template targeting a sub-entity of the prohibited zone (prefix match)", async () => {
    // M32 prefix-matches, so a template targeting `fhir_encounter` is returned for the queried `fhir`.
    const reg = registry({
      fhir: [
        {
          promptTemplateId: "tmpl-9",
          templateKey: "fhir_encounter_synth",
          outputEntityTargetPrefix: "fhir_encounter",
        },
      ],
    });
    await expect(validateFhirAIBlock(reg)).rejects.toBeInstanceOf(FhirAIBlockViolation);
  });
});
