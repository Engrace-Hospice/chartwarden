// GAP-137 — M21 D15 AI-prohibited-zone: boot validator + the AI-actor reject on mutating routes.
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import {
  SUPPLY_PROHIBITED_OUTPUT_ENTITY_PREFIXES,
  type SupplyAiPromptRegistryPort,
  SupplyAIBlockViolation,
  validateSupplyAIBlock,
} from "./ai-block";
import { mountM21Routes } from "./routes/mount";

const registryTargeting = (zone: string): SupplyAiPromptRegistryPort => ({
  getActivePromptsTargeting: async (prefix) =>
    zone.startsWith(prefix)
      ? [{ promptTemplateId: "p1", templateKey: "bad.template", outputEntityTargetPrefix: zone }]
      : [],
});

describe("validateSupplyAIBlock (D15)", () => {
  it("passes with no registry (no-db slice boot)", async () => {
    await expect(validateSupplyAIBlock(undefined)).resolves.toBeUndefined();
  });

  it("passes when no active template targets an M21 zone", async () => {
    await expect(validateSupplyAIBlock(registryTargeting("encounter_narrative"))).resolves.toBe(
      undefined,
    );
  });

  it.each(SUPPLY_PROHIBITED_OUTPUT_ENTITY_PREFIXES)(
    "refuses boot for a template targeting %s",
    async (prefix) => {
      await expect(validateSupplyAIBlock(registryTargeting(`${prefix}x`))).rejects.toBeInstanceOf(
        SupplyAIBlockViolation,
      );
    },
  );
});

describe("mountM21Routes — AI principals cannot mutate", () => {
  const url = "/api/v1/supplies/vendor-routing-rules/11111111-1111-4111-8111-111111111111";
  const build = async (actorKind: string) => {
    const app = Fastify();
    app.addHook("onRequest", async (request) => {
      (request as unknown as { context: unknown }).context = {
        organizationId: "o",
        userId: "u",
        roles: [],
        locationIds: [],
        attributes: { actorKind },
      };
    });
    mountM21Routes(app, { readService: {} as never, writeService: {} as never });
    await app.ready();
    return app;
  };

  it("403s an ai_* actor on a mutating route before any handler runs", async () => {
    const app = await build("ai_agent");
    const res = await app.inject({ method: "DELETE", url });
    expect(res.statusCode).toBe(403);
    expect(res.body).toMatch(/AI principals cannot/);
    await app.close();
  });

  it("does not short-circuit a human actor with the AI reject", async () => {
    const app = await build("user");
    const res = await app.inject({ method: "DELETE", url });
    expect(res.body).not.toMatch(/AI principals cannot/);
    await app.close();
  });
});
