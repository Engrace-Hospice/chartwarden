// GAP-141 — M22 D7 AI-boundary boot validator.
import { describe, expect, it } from "vitest";
import {
  DOCUMENTS_PROHIBITED_OUTPUT_ENTITY_PREFIXES,
  type DocumentsAiPromptRegistryPort,
  DocumentsAIBlockViolation,
  validateDocumentsAIBlock,
} from "./ai-block";

const registryTargeting = (zone: string): DocumentsAiPromptRegistryPort => ({
  getActivePromptsTargeting: async (prefix) =>
    zone.startsWith(prefix)
      ? [{ promptTemplateId: "p1", templateKey: "bad.template", outputEntityTargetPrefix: zone }]
      : [],
});

describe("validateDocumentsAIBlock (D7)", () => {
  it("passes with no registry (no-db slice boot)", async () => {
    await expect(validateDocumentsAIBlock(null)).resolves.toBeUndefined();
  });

  it("admits the AI-produced surface: extraction_candidate is a legitimate output", async () => {
    await expect(
      validateDocumentsAIBlock(registryTargeting("extraction_candidate")),
    ).resolves.toBeUndefined();
  });

  it.each(DOCUMENTS_PROHIBITED_OUTPUT_ENTITY_PREFIXES)(
    "refuses boot for a template targeting %s",
    async (prefix) => {
      await expect(
        validateDocumentsAIBlock(registryTargeting(`${prefix}_x`)),
      ).rejects.toBeInstanceOf(DocumentsAIBlockViolation);
    },
  );
});
