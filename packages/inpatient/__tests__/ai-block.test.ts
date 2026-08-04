// @wardenx/inpatient — M37-T11 unit tests for the D16 AI-prohibited-zone boot validator.
import { describe, expect, it } from "vitest";
import {
  IPU_PROHIBITED_OUTPUT_ENTITY_PREFIXES,
  IpuAIBlockViolation,
  type IpuAiPromptRegistryPort,
  type IpuAiPromptTarget,
  validateIpuAIBlock,
} from "../src/ai-block";

const registry = (hits: Record<string, IpuAiPromptTarget[]>): IpuAiPromptRegistryPort => ({
  async getActivePromptsTargeting(prefix) {
    return hits[prefix] ?? [];
  },
});

describe("validateIpuAIBlock (D16)", () => {
  it("passes when no active prompt targets an IPU zone", async () => {
    await expect(validateIpuAIBlock(registry({}))).resolves.toBeUndefined();
  });

  it("aborts boot when a prompt targets the restraint zone", async () => {
    const reg = registry({
      ipu_restraint_: [
        {
          promptTemplateId: "p1",
          templateKey: "restraint-justifier",
          outputEntityTargetPrefix: "ipu_restraint_event",
        },
      ],
    });
    await expect(validateIpuAIBlock(reg)).rejects.toBeInstanceOf(IpuAIBlockViolation);
    await expect(validateIpuAIBlock(reg)).rejects.toThrow(/restraint-justifier|D16/);
  });

  it("guards every declared prohibited prefix (GIP / IRC override / restraint / body-release)", async () => {
    expect(IPU_PROHIBITED_OUTPUT_ENTITY_PREFIXES).toEqual([
      "gip_criteria_",
      "irc_cap_override_",
      "ipu_restraint_",
      "ipu_body_release_",
    ]);
    for (const prefix of IPU_PROHIBITED_OUTPUT_ENTITY_PREFIXES) {
      const reg = registry({
        [prefix]: [{ promptTemplateId: "x", templateKey: "k", outputEntityTargetPrefix: prefix }],
      });
      await expect(validateIpuAIBlock(reg)).rejects.toBeInstanceOf(IpuAIBlockViolation);
    }
  });

  it("propagates a fail-closed registry throw (the deny-stub direction)", async () => {
    const throwing: IpuAiPromptRegistryPort = {
      async getActivePromptsTargeting() {
        throw new Error("AIPromptRegistry unwired");
      },
    };
    await expect(validateIpuAIBlock(throwing)).rejects.toThrow(/unwired/);
  });
});
