// M25 milestone 8a-1 - the deny-stubbed assistant port and the AI prohibited-zone boot validator.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { denyStubAdrReadinessAssist, resolveAdrReadinessAssist } from "../adr-readiness-capability";
import {
  REMITTANCE_PROHIBITED_OUTPUT_ENTITY_PREFIXES,
  RemittanceAIBlockViolation,
  type RemittanceAiPromptRegistryPort,
  validateRemittanceAIBlock,
} from "../ai-block";

const HERE = dirname(fileURLToPath(import.meta.url));

describe("deny-stubbed readiness assistant", () => {
  it("resolves to the deny-stub in 8a-1 and reports the capability unavailable, never throwing", async () => {
    expect(resolveAdrReadinessAssist()).toBe(denyStubAdrReadinessAssist);
    const out = await resolveAdrReadinessAssist().review({
      organizationId: "o",
      adrCaseId: "a",
      documents: [],
      requirementKeys: [],
    });
    expect(out).toEqual({ available: false, reason: "capability_unavailable" });
  });

  it("imports nothing from the AI platform (M25 does not depend on M32)", () => {
    for (const file of ["adr-readiness-capability.ts", "ai-block.ts"]) {
      const source = readFileSync(join(HERE, "..", file), "utf8");
      expect(source).not.toMatch(/from\s+["']@chartwarden\/ai-platform/);
      expect(source).not.toMatch(/32-ai-platform/);
    }
  });
});

describe("validateRemittanceAIBlock", () => {
  const registryTargeting = (hit: string | null): RemittanceAiPromptRegistryPort => ({
    getActivePromptsTargeting: async (prefix) =>
      hit === null || !hit.startsWith(prefix)
        ? []
        : [{ promptTemplateId: "p1", templateKey: "t", outputEntityTargetPrefix: hit }],
  });

  it("passes with no registry (a no-db slice boot) and with no offending template", async () => {
    await expect(validateRemittanceAIBlock(null)).resolves.toBeUndefined();
    await expect(validateRemittanceAIBlock(registryTargeting(null))).resolves.toBeUndefined();
  });

  it.each(REMITTANCE_PROHIBITED_OUTPUT_ENTITY_PREFIXES)(
    "refuses a template targeting %s",
    async (prefix) => {
      await expect(
        validateRemittanceAIBlock(registryTargeting(`${prefix}_x`)),
      ).rejects.toBeInstanceOf(RemittanceAIBlockViolation);
    },
  );

  it("protects the human record but not the advisory surface itself", () => {
    expect(REMITTANCE_PROHIBITED_OUTPUT_ENTITY_PREFIXES).toEqual(
      expect.arrayContaining(["adr_case", "submission_attempt", "appeal_case"]),
    );
    expect(
      REMITTANCE_PROHIBITED_OUTPUT_ENTITY_PREFIXES.some((p) =>
        "adr_readiness_finding".startsWith(p),
      ),
    ).toBe(false);
  });
});
