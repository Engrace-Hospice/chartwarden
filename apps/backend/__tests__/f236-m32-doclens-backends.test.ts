// apps/backend/__tests__/f236-m32-doclens-backends.test.ts — F-236 (ADR-0048), no DB, no network.
//
// The M32 pieces that make a governed DocLens call possible: the Ollama adapter (and the silent-truncation
// trap it refuses), the Anthropic SDK transport, the deployment config, the payload cipher, the DocLens
// projector, the PHI-minimisation rules, and the seam runner end-to-end through the REAL pipeline over
// in-memory stores — proving the reviewed template rides as the system prompt, the response schema and
// the per-call timeout reach the backend, and a capability with no active template refuses.
import { randomBytes } from "node:crypto";
import {
  type AnthropicZdrContract,
  createModelBackendRegistry,
  createOllamaModelBackend,
} from "@chartwarden/ai-platform";
import { describe, expect, it } from "vitest";
import { createInMemoryAiGovernanceStores } from "../src/modules/32-ai-platform/governance/store";
import {
  AiBackendConfigError,
  aiBackendConfigFromEnv,
  buildConfiguredModelBackends,
  createAiPayloadCipher,
  createDocLensExtractor,
  createDocLensOutputProjector,
  createRuleBasedAiChartContextValidator,
  projectDocLensClassify,
  projectDocLensExtract,
} from "../src/modules/32-ai-platform/index";
import {
  createAiInvocationPipeline,
  createInMemoryAiInvocationStores,
} from "../src/modules/32-ai-platform/invocation";

const OLLAMA_CAPS = {
  modelVersionPin: "ollama/llama3.1",
  supportedModalities: ["text"] as const,
  contextWindowTokens: 8192,
  maxOutputTokens: 2048,
  supportedFeatures: { structured_output: true, tool_use: false, vision: false, streaming: false },
};

function fakeOllama(reply: Record<string, unknown>, seen: unknown[] = []): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).endsWith("/api/tags")) {
      return new Response(JSON.stringify({ models: [{ name: "llama3.1:8b" }] }));
    }
    seen.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify(reply));
  }) as typeof fetch;
}

describe("F-236 — Ollama adapter", () => {
  const base = {
    backendKey: "local-llama-3.1-8b-instruct",
    baseUrl: "http://o:11434",
    model: "llama3.1:8b",
  };

  it("refuses to construct without an explicit context window (silent truncation otherwise)", () => {
    expect(() =>
      createOllamaModelBackend({ ...base, numCtx: 0, capabilities: OLLAMA_CAPS }),
    ).toThrow(/numCtx/);
  });

  it("sends system+user, the schema as `format`, num_ctx, temperature 0, think false; returns vendor counts", async () => {
    const seen: unknown[] = [];
    const b = createOllamaModelBackend({
      ...base,
      numCtx: 8192,
      capabilities: OLLAMA_CAPS,
      fetchImpl: fakeOllama(
        { model: "llama3.1:8b", message: { content: "{}" }, prompt_eval_count: 10, eval_count: 3 },
        seen,
      ),
    });
    const r = await b.complete?.({
      organizationId: "o",
      systemPrompt: "SYS",
      prompt: "USER",
      chartContext: {},
      maxOutputTokens: 100,
      responseSchema: { type: "object" },
    });
    expect(r).toEqual({
      text: "{}",
      inputTokens: 10,
      outputTokens: 3,
      modelVersionPin: "ollama/llama3.1:8b",
    });
    expect(seen[0]).toMatchObject({
      model: "llama3.1:8b",
      stream: false,
      think: false,
      format: { type: "object" },
      messages: [
        { role: "system", content: "SYS" },
        { role: "user", content: "USER" },
      ],
      options: { num_ctx: 8192, num_predict: 100, temperature: 0 },
    });
  });

  it("refuses a reply whose prompt filled the window, one cut at the output limit, or one without counts", async () => {
    const make = (reply: Record<string, unknown>) =>
      createOllamaModelBackend({
        ...base,
        numCtx: 8192,
        capabilities: OLLAMA_CAPS,
        fetchImpl: fakeOllama(reply),
      });
    const req = {
      organizationId: "o",
      systemPrompt: null,
      prompt: "p",
      chartContext: {},
      maxOutputTokens: 10,
    };
    await expect(
      make({ message: { content: "x" }, prompt_eval_count: 8192, eval_count: 1 }).complete?.(req),
    ).rejects.toThrow(/context window/);
    await expect(
      make({
        message: { content: "x" },
        prompt_eval_count: 5,
        eval_count: 10,
        done_reason: "length",
      }).complete?.(req),
    ).rejects.toThrow(/output-token limit/);
    await expect(make({ message: { content: "x" } }).complete?.(req)).rejects.toThrow(
      /token counts/,
    );
  });

  it("lifts Bun's hidden 300 s fetch timeout but still bounds the request (F-238 E2E)", async () => {
    let init: (RequestInit & { timeout?: boolean }) | undefined;
    const backend = createOllamaModelBackend({
      backendKey: "local-llama-3.1-8b-instruct",
      baseUrl: "http://ollama:11434",
      model: "llama3.1:8b",
      numCtx: 8192,
      capabilities: OLLAMA_CAPS,
      fetchImpl: (async (_url: string | URL | Request, i?: RequestInit) => {
        init = i;
        return new Response(
          JSON.stringify({
            message: { content: "{}" },
            prompt_eval_count: 1,
            eval_count: 1,
            done_reason: "stop",
          }),
        );
      }) as typeof fetch,
    });
    await backend.complete?.({
      organizationId: "o",
      systemPrompt: null,
      prompt: "p",
      chartContext: {},
      maxOutputTokens: 16,
    } as never);
    expect(init?.timeout).toBe(false);
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("is healthy only when the configured tag is pulled", async () => {
    const ok = createOllamaModelBackend({
      ...base,
      numCtx: 8192,
      capabilities: OLLAMA_CAPS,
      fetchImpl: fakeOllama({}),
    });
    expect(await ok.health()).toBe("healthy");
    const missing = createOllamaModelBackend({
      ...base,
      model: "other:1b",
      numCtx: 8192,
      capabilities: OLLAMA_CAPS,
      fetchImpl: fakeOllama({}),
    });
    expect(await missing.health()).toBe("unhealthy");
  });
});

describe("F-236 — deployment config", () => {
  it("binds only inventory-registered keys of the right kind", () => {
    expect(() =>
      aiBackendConfigFromEnv({ OLLAMA_BASE_URL: "http://o", OLLAMA_MODELS: "local-made-up=x" }),
    ).toThrow(AiBackendConfigError);
    expect(() =>
      aiBackendConfigFromEnv({
        OLLAMA_BASE_URL: "http://o",
        OLLAMA_MODELS: "anthropic-claude-opus-4-7=x",
      }),
    ).toThrow(/cloud backend, not local/);
    expect(() => aiBackendConfigFromEnv({ OLLAMA_BASE_URL: "http://o" })).toThrow(/names no model/);
  });

  it("nothing configured ⇒ no backends (the previous posture)", () => {
    expect(buildConfiguredModelBackends(aiBackendConfigFromEnv({}))).toEqual([]);
  });

  it("an Anthropic backend's model id defaults to the one its registry key names", () => {
    const cfg = aiBackendConfigFromEnv({ ANTHROPIC_API_KEY: "sk-test" });
    expect(cfg.anthropic?.models.get("anthropic-claude-opus-4-7")).toBe("claude-opus-4-7");
    expect(cfg.anthropic?.zdr).toBeNull();
  });

  it("an Anthropic adapter with no ZDR contract refuses every call (D19)", async () => {
    const [b] = buildConfiguredModelBackends(
      aiBackendConfigFromEnv({
        ANTHROPIC_API_KEY: "sk-test",
        ANTHROPIC_MODELS: "anthropic-claude-opus-4-7=claude-opus-4-7",
      }),
    );
    await expect(
      b?.complete?.({
        organizationId: "o",
        systemPrompt: null,
        prompt: "p",
        chartContext: {},
        maxOutputTokens: 10,
      }),
    ).rejects.toMatchObject({ code: "AI_ZDR_CONTRACT_MISSING" });
  });
});

describe("F-236 — payload cipher", () => {
  const keys = new Map([
    ["v1", randomBytes(32)],
    ["v2", randomBytes(32)],
  ]);
  let active = "v1";
  const cipher = createAiPayloadCipher({
    dekForOrg: async () => ({ version: active, key: keys.get(active) as Buffer }),
    dekForOrgVersion: async (_o, v) => ({ version: v, key: keys.get(v) as Buffer }),
  });
  it("round-trips across rotation, never stores plaintext, and is bound to the org", async () => {
    const env = await cipher.encrypt("org-a", "Mae Doclens DOB 1938");
    expect(env.toString("utf8")).not.toContain("Doclens");
    active = "v2";
    expect(await cipher.decrypt("org-a", env)).toBe("Mae Doclens DOB 1938");
    await expect(cipher.decrypt("org-b", env)).rejects.toThrow();
  });
});

describe("F-236 — DocLens projector and PHI-minimisation rules", () => {
  const out = (text: string) => ({ text, modelVersionPin: "p", inputTokens: 1, outputTokens: 1 });

  it("classify: only a known type and a 0..1 confidence project", () => {
    expect(
      projectDocLensClassify(out('{"documentType":"med_recon","confidence":0.9}')),
    ).toMatchObject({
      documentType: "med_recon",
    });
    expect(projectDocLensClassify(out('{"documentType":"recipe","confidence":0.9}'))).toBeNull();
    expect(projectDocLensClassify(out('{"documentType":"lab","confidence":4}'))).toBeNull();
    expect(projectDocLensClassify(out("not json"))).toBeNull();
  });

  it("extract: one malformed entry fails the reply; empties are omitted; duplicates keep the higher confidence", () => {
    const good = projectDocLensExtract(
      out(
        JSON.stringify({
          fields: [
            { fieldPath: "patient.phoneHome", value: "1", quote: "a 1", page: 1, confidence: 0.4 },
            { fieldPath: "patient.phoneHome", value: "2", quote: "b 2", page: 1, confidence: 0.8 },
            { fieldPath: "patient.email", value: "", quote: "", page: 1, confidence: 0.1 },
            {
              fieldPath: "medications[0].name",
              value: "Furosemide",
              quote: "Furosemide 40",
              page: 2,
              confidence: 0.9,
            },
          ],
        }),
      ),
    );
    expect(good?.fields).toEqual({
      "patient.phoneHome": { value: "2", confidence: 0.8, sourceQuote: { page: 1, text: "b 2" } },
      "medications[0].name": {
        value: "Furosemide",
        confidence: 0.9,
        sourceQuote: { page: 2, text: "Furosemide 40" },
      },
    });
    expect(
      projectDocLensExtract(
        out(
          JSON.stringify({
            fields: [{ fieldPath: "x; DROP", value: "1", quote: "1", page: 1, confidence: 1 }],
          }),
        ),
      ),
    ).toBeNull();
    expect(
      projectDocLensExtract(
        out(
          JSON.stringify({
            fields: [{ fieldPath: "a", value: "1", quote: "1", page: 0, confidence: 1 }],
          }),
        ),
      ),
    ).toBeNull();
    expect(createDocLensOutputProjector().project("CopilotProvider", out("{}"))).toBeNull();
  });

  it("extract (F-238 E2E): a 'not present' entry with placeholder page 0 is omitted, not a refusal", () => {
    // What llama3.1:8b actually answered for 4 of 18 packet documents: absent fields as {value:"", page:0}.
    const p = projectDocLensExtract(
      out(
        JSON.stringify({
          fields: [
            {
              fieldPath: "patient.dateOfBirth",
              value: "03/02/1941",
              quote: "DOB: 03/02/1941",
              page: 2,
              confidence: 1,
            },
            { fieldPath: "patient.email", value: "", quote: "", page: 0, confidence: 0 },
            { fieldPath: "allergies[0].substance", value: " ", quote: "", page: 0, confidence: 0 },
          ],
        }),
      ),
    );
    expect(Object.keys(p?.fields ?? {})).toEqual(["patient.dateOfBirth"]);
    // A real value on page 0 is still malformed.
    expect(
      projectDocLensExtract(
        out(
          JSON.stringify({
            fields: [{ fieldPath: "a", value: "x", quote: "x", page: 0, confidence: 1 }],
          }),
        ),
      ),
    ).toBeNull();
  });

  it("extract (F-238 E2E): unnumbered `[]` entries are numbered by order when every subfield agrees", () => {
    // llama3.1:8b's real answer for the wound note (page numbers kept): the template path, unnumbered.
    const e = (fieldPath: string, value: string) => ({
      fieldPath,
      value,
      quote: value,
      page: 1,
      confidence: 0.9,
    });
    const p = projectDocLensExtract(
      out(
        JSON.stringify({
          fields: [
            e("patient.dateOfBirth", "03/02/1941"),
            e("medications[].name", "foam dressing"),
            e("medications[].name", "low-air-loss mattress"),
            e("diagnoses[].description", "Pressure ulcer of sacral region, stage 2"),
            e("diagnoses[].role", "principal"),
          ],
        }),
      ),
    );
    expect(Object.keys(p?.fields ?? {}).sort()).toEqual([
      "diagnoses[0].description",
      "diagnoses[0].role",
      "medications[0].name",
      "medications[1].name",
      "patient.dateOfBirth",
    ]);
    expect(p?.fields["medications[1].name"]?.value).toBe("low-air-loss mattress");
    expect(p?.warnings).toEqual([]);
    // Numbered entries keep their index; unnumbered ones continue after them.
    const q = projectDocLensExtract(
      out(
        JSON.stringify({ fields: [e("medications[0].name", "a"), e("medications[].name", "b")] }),
      ),
    );
    expect(q?.fields["medications[1].name"]?.value).toBe("b");
  });

  it("extract (F-238 E2E): a lopsided unnumbered group is dropped with a warning, the rest of the reply kept", () => {
    const e = (fieldPath: string, value: string) => ({
      fieldPath,
      value,
      quote: value,
      page: 1,
      confidence: 0.9,
    });
    const p = projectDocLensExtract(
      out(
        JSON.stringify({
          fields: [
            e("patient.dateOfBirth", "03/02/1941"),
            e("diagnoses[].description", "COPD"),
            e("diagnoses[].description", "CKD"),
            e("diagnoses[].role", "principal"),
          ],
        }),
      ),
    );
    expect(Object.keys(p?.fields ?? {})).toEqual(["patient.dateOfBirth"]);
    expect(p?.warnings).toEqual(["unnumbered_diagnoses_dropped"]);
  });

  it("chart context: DocLens allowlists ids/counts only; every other capability still refuses", async () => {
    const v = createRuleBasedAiChartContextValidator();
    expect(
      (await v.validate("doclens_extract", { documentId: "d", schemaKey: "s", pageCount: 2 }))
        .permitted,
    ).toBe(true);
    expect(
      (await v.validate("doclens_extract", { documentId: "d", patientName: "Mae" })).permitted,
    ).toBe(false);
    expect((await v.validate("doclens_extract", { documentId: { nested: true } })).permitted).toBe(
      false,
    );
    expect((await v.validate("hearthnote_layer2", {})).permitted).toBe(false);
  });
});

describe("F-236 — the DocLens extractor seam through the REAL pipeline", () => {
  const ORG = "11111111-1111-4111-8111-111111111111";
  const CAP_ID = "22222222-2222-4222-8222-222222222222";

  function build(opts: {
    prompt: { promptTemplateId: string; version: number; promptBody: string } | null;
  }) {
    const seen: Array<Record<string, unknown>> = [];
    const backend = createOllamaModelBackend({
      backendKey: "local-llama-3.1-8b-instruct",
      baseUrl: "http://o",
      model: "llama3.1:8b",
      numCtx: 8192,
      capabilities: OLLAMA_CAPS,
      fetchImpl: fakeOllama(
        {
          model: "llama3.1:8b",
          message: {
            content: JSON.stringify({
              fields: [
                {
                  fieldPath: "patient.phoneHome",
                  value: "(503) 555-0142",
                  quote: "Home phone: (503) 555-0142",
                  page: 1,
                  confidence: 0.9,
                },
              ],
            }),
          },
          prompt_eval_count: 50,
          eval_count: 20,
        },
        seen as unknown[],
      ),
    });
    const stores = createInMemoryAiInvocationStores({
      backends: [
        {
          backendId: "b1",
          backendKey: "local-llama-3.1-8b-instruct",
          kind: "local",
          isActive: true,
          lastHealthStatus: "healthy",
          zdrStatus: "not_applicable",
          modelVersionPin: "ollama/llama3.1:8b",
          supportedModalities: ["text"],
        },
      ],
    });
    const governance = createInMemoryAiGovernanceStores({
      optIns: [
        {
          id: "o1",
          organizationId: ORG,
          capabilityId: CAP_ID,
          status: "active",
          orgAdminMembershipId: "m",
          routingPreferenceSnapshot: "local_only",
          pilotEnrollment: false,
          optedInAt: "2026-10-01T00:00:00.000Z",
          pausedAt: null,
          pausedReason: null,
          optedOutAt: null,
          optedOutReason: null,
        },
      ],
    });
    const pipeline = createAiInvocationPipeline({
      capabilities: {
        findByKey: async () => ({
          id: CAP_ID,
          capabilityKey: "doclens_extract",
          lifecycleState: "APPROVED",
          defaultBackendKey: "anthropic-claude-opus-4-7",
          allowedBackendKeys: ["anthropic-claude-opus-4-7", "local-llama-3.1-8b-instruct"],
          fallbackChainKeys: ["local-llama-3.1-8b-instruct"],
          tenantOverrideAllowed: true,
          tenantOptInRequired: true,
          currentPromptTemplateKey: "doclens_extract/v1",
          requiredModality: null,
        }),
      },
      consent: governance.consent,
      backends: stores.backends,
      overrides: stores.overrides,
      ledger: stores.ledger,
      flags: { readFlags: async () => ({ "ai.full": true }) },
      cipher: { encrypt: async (_o, p) => Buffer.from(`enc:${p.length}`) },
      killSwitch: { isActive: async () => false },
      modelBackends: createModelBackendRegistry([backend]),
      tokenBudget: { budgetFor: async () => ({ hardCapTokens: 100_000, softCapTokens: 80_000 }) },
      chartContext: createRuleBasedAiChartContextValidator(),
    });
    const extractor = createDocLensExtractor({
      pipeline,
      actors: {
        resolve: async () => ({
          actorMembershipId: "m",
          actorRole: "rn",
          providerEntityId: "pe",
          locationId: null,
        }),
      },
      projector: createDocLensOutputProjector(),
      prompts: { getActivePromptForCapability: async () => opts.prompt },
    });
    return { extractor, seen };
  }
  const input = {
    organizationId: ORG,
    actorUserId: "u",
    documentId: "d",
    documentType: "transfer_record",
    extractedText: "",
    schemaKey: "doclens_v1",
    fieldSpecs: [{ fieldPath: "patient.phoneHome", description: "home phone" }],
    pages: [{ page: 1, text: "Home phone: (503) 555-0142" }],
  };

  it("routes a local_only tenant to the local model with the reviewed template, schema and page-marked document", async () => {
    const { extractor, seen } = build({
      prompt: { promptTemplateId: "tpl-1", version: 1, promptBody: "REVIEWED EXTRACT PROMPT" },
    });
    const r = await extractor.extract(input);
    expect(r).toMatchObject({
      available: true,
      fields: { "patient.phoneHome": { value: "(503) 555-0142", sourceQuote: { page: 1 } } },
    });
    const sent = seen[0] as { messages: Array<{ role: string; content: string }>; format: unknown };
    expect(sent.messages[0]).toEqual({ role: "system", content: "REVIEWED EXTRACT PROMPT" });
    expect(sent.messages[1]?.content).toBe(
      "FIELDS:\n- patient.phoneHome: home phone\n\nDOCUMENT:\n=== PAGE 1 ===\nHome phone: (503) 555-0142",
    );
    expect(sent.format).toMatchObject({ type: "object", required: ["fields"] });
  });

  it("refuses — and never dispatches — when the capability has no active prompt template", async () => {
    const { extractor, seen } = build({ prompt: null });
    const r = await extractor.extract(input);
    expect(r).toMatchObject({ available: false });
    expect(seen).toHaveLength(0);
  });
});

// Type-only guard: the ZDR contract shape the config produces is the adapter's.
const _zdr: AnthropicZdrContract | null = aiBackendConfigFromEnv({}).anthropic?.zdr ?? null;
void _zdr;
