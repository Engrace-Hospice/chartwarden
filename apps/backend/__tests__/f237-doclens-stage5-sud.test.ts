// apps/backend/__tests__/f237-doclens-stage5-sud.test.ts — F-237, no DB, no network.
//
// The pieces of DocLens stage 5 (vision double-check) and SUD detection that do not need a database:
//   · the vision reading comparison and the SUD privacy-flag decision (pure),
//   · the F-235 planner honouring a reviewer's false-positive rejection,
//   · the vision/SUD projectors and PHI-minimisation rules,
//   · images through the Ollama and Anthropic adapters,
//   · the vision verifier seam through the REAL pipeline: a request carrying images is routed past a
//     text-only backend to the vision one, the model is never shown the extracted value, and the ledger's
//     encrypted prompt carries image digests, not image bytes.
import { createHash } from "node:crypto";
import {
  createAnthropicSdkTransport,
  createModelBackendRegistry,
  createOllamaModelBackend,
} from "@chartwarden/ai-platform";
import { describe, expect, it } from "vitest";
import { restrictionOf } from "../src/modules/05-patient/admission-clearance-reader";
import { decideSudFlag } from "../src/modules/05-patient/index";
import {
  closestReading,
  visionReadingAgrees,
} from "../src/modules/22-documents/extraction/intake-job";
import { visionStatusOf } from "../src/modules/22-documents/extraction/review-workspace";
import { planDocLensWriteback } from "../src/modules/22-documents/extraction/writeback-plan";
import { createInMemoryAiGovernanceStores } from "../src/modules/32-ai-platform/governance/store";
import {
  createDocLensOutputProjector,
  createDocLensVisionVerifier,
  createRuleBasedAiChartContextValidator,
  projectDocLensSudDetect,
  projectDocLensVisionVerify,
} from "../src/modules/32-ai-platform/index";
import {
  createAiInvocationPipeline,
  createInMemoryAiInvocationStores,
} from "../src/modules/32-ai-platform/invocation";

const out = (text: string) => ({
  text,
  modelVersionPin: "p",
  inputTokens: 1,
  outputTokens: 1,
});

describe("F-237 — stage 5 reading comparison", () => {
  it.each([
    ["(503) 555-0142", "503-555-0142", true],
    ["Penicillin", "penicillin.", true],
    ["03/14/1941", "03/14/1941", true],
    ["Penicillin", "Penicillin - anaphylaxis to IV dose", false],
    ["Lisinopril 10 mg", "Lisinopril 20 mg", false],
    ["Smith", "", false],
    ["AB", "ABC", false], // too short to accept containment
  ])("%s vs %s → %s", (extracted, observed, agrees) => {
    expect(visionReadingAgrees(extracted, observed)).toBe(agrees);
  });

  it("shows the reviewer the reading closest to the extracted value", () => {
    expect(
      closestReading("Methadone 10 mg PO q8h", [
        "Furosemide 40 mg PO daily",
        "Methadone 20 mg PO q8h",
        "Lorazepam 0.5 mg SL",
      ]),
    ).toBe("Methadone 20 mg PO q8h");
  });

  it("derives the vision status the screen shows", () => {
    expect(
      visionStatusOf({ riskLevel: "low", visionVerified: false, visionDisagreement: null }),
    ).toBe("not_required");
    expect(
      visionStatusOf({ riskLevel: "high", visionVerified: true, visionDisagreement: null }),
    ).toBe("verified");
    expect(
      visionStatusOf({ riskLevel: "high", visionVerified: false, visionDisagreement: "v1.x" }),
    ).toBe("disagreed");
    expect(
      visionStatusOf({ riskLevel: "medium", visionVerified: false, visionDisagreement: null }),
    ).toBe("unverified");
  });
});

describe("F-237 — M5's SUD privacy-flag decision (W4 steps 4 and 6)", () => {
  const D = "m22.intake.sud_detected";
  const C = "m22.intake.sud_confirmed";
  const R = "m22.intake.sud_rejected";
  const snap = (
    flags: string[],
    origin: "m22_intake_unconfirmed" | "m22_intake_confirmed" | null,
    consentGoverned = false,
  ) => ({ flags: flags as never[], origin, consentGoverned });

  it("a detection adds an interim flag, keeping the patient's other flags", () => {
    expect(decideSudFlag(D, null)).toEqual({
      change: true,
      flags: ["sud"],
      origin: "m22_intake_unconfirmed",
    });
    expect(decideSudFlag(D, snap(["hiv"], null))).toEqual({
      change: true,
      flags: ["hiv", "sud"],
      origin: "m22_intake_unconfirmed",
    });
  });

  it("a detection never re-imposes a restriction a §2.31 consent lifted, nor duplicates one", () => {
    expect(decideSudFlag(D, snap([], null, true))).toEqual({ change: false });
    expect(decideSudFlag(D, snap(["sud"], null, true))).toEqual({ change: false });
    expect(decideSudFlag(D, snap(["sud"], "m22_intake_unconfirmed"))).toEqual({ change: false });
  });

  it("confirm promotes the interim flag; a redelivery is a no-op", () => {
    expect(decideSudFlag(C, snap(["sud"], "m22_intake_unconfirmed"))).toEqual({
      change: true,
      flags: ["sud"],
      origin: "m22_intake_confirmed",
    });
    expect(decideSudFlag(C, snap(["sud"], "m22_intake_confirmed"))).toEqual({ change: false });
  });

  it("reject retires ONLY a DocLens-set flag — never a consent-derived one", () => {
    expect(decideSudFlag(R, snap(["hiv", "sud"], "m22_intake_unconfirmed"))).toEqual({
      change: true,
      flags: ["hiv"],
      origin: null,
    });
    expect(decideSudFlag(R, snap(["sud"], null, true))).toEqual({ change: false });
    expect(decideSudFlag(R, snap([], null))).toEqual({ change: false });
  });
});

describe("F-237 — the writeback planner and a reviewed SUD detection", () => {
  const fact = {
    candidateId: "c1",
    decisionId: "d1",
    fieldPath: "patient.phoneHome",
    riskLevel: "low" as const,
    sudDetected: true,
    extractedValue: "(503) 555-0142",
    decision: "approve" as const,
    editedValue: null,
    sourceDocumentId: "doc",
  };
  it.each([
    [undefined, false],
    ["detected", false],
    ["confirmed", false],
    ["rejected", true],
  ] as const)("batch SUD status %s → committed: %s", (status, committed) => {
    const plan = planDocLensWriteback({
      batchPatientId: "p1",
      facts: [fact],
      ...(status ? { batchSudStatus: status } : {}),
    });
    expect(plan.committed.length === 1).toBe(committed);
    if (!committed) expect(plan.excluded[0]?.reason).toBe("sud_detected");
  });
});

describe("F-237 — projectors and PHI-minimisation rules", () => {
  it("vision: a legible reading passes with the value; an illegible one is uncertain with none", () => {
    expect(
      projectDocLensVisionVerify(
        out('{"legible":true,"observedValues":["Penicillin"],"confidence":0.9}'),
      ),
    ).toEqual({
      verdict: "pass",
      confidence: 0.9,
      evidence: [],
      warnings: [],
      observedValue: "Penicillin",
      observedValues: ["Penicillin"],
    });
    expect(
      projectDocLensVisionVerify(out('{"legible":false,"observedValues":[],"confidence":0.2}')),
    ).toMatchObject({ verdict: "uncertain" });
    expect(projectDocLensVisionVerify(out('{"legible":"yes"}'))).toBeNull();
  });

  it("sud: categories are closed; one malformed indicator fails the reply", () => {
    expect(
      projectDocLensSudDetect(
        out(
          '{"indicators":[{"page":2,"quote":"on Suboxone","category":"medication"}],"confidence":0.8}',
        ),
      ),
    ).toEqual({
      sudIndicatorsDetected: true,
      confidence: 0.8,
      indicators: [{ pageNumber: 2, snippet: "on Suboxone", category: "medication" }],
      warnings: [],
    });
    expect(
      projectDocLensSudDetect(
        out('{"indicators":[{"page":2,"quote":"x","category":"opinion"}],"confidence":0.8}'),
      ),
    ).toBeNull();
    expect(createDocLensOutputProjector().project("DocLensSudDetector", out("nope"))).toBeNull();
  });

  it("chart context: stage 5 may name a field path and page; never a value", async () => {
    const v = createRuleBasedAiChartContextValidator();
    expect(
      await v.validate("doclens_vision_verify", {
        documentId: "d",
        verificationKey: "field_value",
        pageNumber: 2,
        fieldPath: "allergies[0].substance",
      }),
    ).toMatchObject({ permitted: true });
    expect(
      await v.validate("doclens_vision_verify", { documentId: "d", value: "Penicillin" }),
    ).toMatchObject({ permitted: false });
    expect(await v.validate("doclens_sud_detect", { documentId: "d", pageCount: 3 })).toMatchObject(
      { permitted: true },
    );
  });
});

const IMG = Buffer.from("fake-png-bytes").toString("base64");

describe("F-237 — images through the adapters", () => {
  it("Ollama puts base64 images on the user message", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const b = createOllamaModelBackend({
      backendKey: "local-qwen2.5-vl-7b-instruct",
      baseUrl: "http://o",
      model: "qwen2.5vl:7b",
      numCtx: 8192,
      capabilities: {
        modelVersionPin: "ollama/qwen2.5vl:7b",
        supportedModalities: ["text", "vision"],
        contextWindowTokens: 8192,
        maxOutputTokens: 512,
        supportedFeatures: {
          structured_output: true,
          tool_use: false,
          vision: true,
          streaming: false,
        },
      },
      fetchImpl: (async (_url: string | URL | Request, init?: RequestInit) => {
        seen.push(JSON.parse(String(init?.body)));
        return new Response(
          JSON.stringify({
            model: "qwen2.5vl:7b",
            message: { content: "{}" },
            prompt_eval_count: 5,
            eval_count: 2,
            done_reason: "stop",
          }),
        );
      }) as typeof fetch,
    });
    await b.complete?.({
      organizationId: "o",
      systemPrompt: null,
      prompt: "FIELD: x",
      chartContext: {},
      maxOutputTokens: 64,
      images: [{ mediaType: "image/png", dataBase64: IMG }],
    });
    const messages = (seen[0] as { messages: Array<Record<string, unknown>> }).messages;
    expect(messages.at(-1)).toEqual({ role: "user", content: "FIELD: x", images: [IMG] });
  });

  it("Anthropic sends image blocks first, then the instruction text", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const client = {
      messages: {
        create: async (body: Record<string, unknown>) => {
          calls.push(body);
          return {
            model: "claude-opus-4-7",
            stop_reason: "end_turn",
            content: [{ type: "text", text: "{}" }],
            usage: { input_tokens: 3, output_tokens: 1 },
          };
        },
      },
    };
    const { dispatch } = createAnthropicSdkTransport({
      apiKey: "k",
      model: "claude-opus-4-7",
      client: client as never,
    });
    await dispatch(
      {
        organizationId: "o",
        systemPrompt: "S",
        prompt: "FIELD: x",
        chartContext: {},
        maxOutputTokens: 64,
        images: [{ mediaType: "image/png", dataBase64: IMG }],
      },
      { contractRef: "z", verifiedAt: "2026-01-01", expiresAt: "2099-01-01" } as never,
    );
    expect((calls[0]?.messages as unknown[])[0]).toEqual({
      role: "user",
      content: [
        { type: "image", source: { type: "base64", media_type: "image/png", data: IMG } },
        { type: "text", text: "FIELD: x" },
      ],
    });
  });
});

describe("F-237 — the stage-5 seam through the REAL pipeline", () => {
  const ORG = "11111111-1111-4111-8111-111111111111";
  const CAP_ID = "33333333-3333-4333-8333-333333333333";
  const caps = (vision: boolean) => ({
    modelVersionPin: vision ? "ollama/qwen2.5vl:7b" : "ollama/llama3.1:8b",
    supportedModalities: (vision ? ["text", "vision"] : ["text"]) as never,
    contextWindowTokens: 8192,
    maxOutputTokens: 512,
    supportedFeatures: { structured_output: true, tool_use: false, vision, streaming: false },
  });

  function build() {
    const sent: Array<{ backend: string; body: Record<string, unknown> }> = [];
    const ollama = (backendKey: string, model: string, vision: boolean) =>
      createOllamaModelBackend({
        backendKey,
        baseUrl: "http://o",
        model,
        numCtx: 8192,
        capabilities: caps(vision),
        fetchImpl: (async (_url: string | URL | Request, init?: RequestInit) => {
          sent.push({ backend: backendKey, body: JSON.parse(String(init?.body)) });
          return new Response(
            JSON.stringify({
              model,
              message: {
                content: JSON.stringify({
                  legible: true,
                  observedValues: ["Penicillin"],
                  confidence: 0.93,
                }),
              },
              prompt_eval_count: 40,
              eval_count: 9,
              done_reason: "stop",
            }),
          );
        }) as typeof fetch,
      });
    const row = (backendKey: string, vision: boolean) => ({
      backendId: backendKey,
      backendKey,
      kind: "local" as const,
      isActive: true,
      lastHealthStatus: "healthy" as const,
      zdrStatus: "not_applicable" as const,
      modelVersionPin: backendKey,
      supportedModalities: (vision ? ["text", "vision"] : ["text"]) as never,
    });
    const stores = createInMemoryAiInvocationStores({
      backends: [
        row("local-llama-3.1-8b-instruct", false),
        row("local-qwen2.5-vl-7b-instruct", true),
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
    const encrypted: string[] = [];
    const pipeline = createAiInvocationPipeline({
      capabilities: {
        findByKey: async () => ({
          id: CAP_ID,
          capabilityKey: "doclens_vision_verify",
          lifecycleState: "APPROVED",
          defaultBackendKey: "anthropic-claude-opus-4-7",
          allowedBackendKeys: [
            "anthropic-claude-opus-4-7",
            "local-llama-3.1-8b-instruct",
            "local-qwen2.5-vl-7b-instruct",
          ],
          // The text-only model FIRST: an image-carrying request must still skip it.
          fallbackChainKeys: ["local-llama-3.1-8b-instruct", "local-qwen2.5-vl-7b-instruct"],
          tenantOverrideAllowed: true,
          tenantOptInRequired: true,
          currentPromptTemplateKey: "doclens_vision_verify/v1",
          requiredModality: null,
        }),
      },
      consent: governance.consent,
      backends: stores.backends,
      overrides: stores.overrides,
      ledger: stores.ledger,
      flags: { readFlags: async () => ({ "ai.full": true }) },
      cipher: {
        encrypt: async (_o, p) => {
          encrypted.push(p);
          return Buffer.from(`enc:${p.length}`);
        },
      },
      killSwitch: { isActive: async () => false },
      modelBackends: createModelBackendRegistry([
        ollama("local-llama-3.1-8b-instruct", "llama3.1:8b", false),
        ollama("local-qwen2.5-vl-7b-instruct", "qwen2.5vl:7b", true),
      ]),
      tokenBudget: { budgetFor: async () => ({ hardCapTokens: 100_000, softCapTokens: 80_000 }) },
      chartContext: createRuleBasedAiChartContextValidator(),
    });
    const verifier = createDocLensVisionVerifier({
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
      prompts: {
        getActivePromptForCapability: async () => ({
          promptTemplateId: "tpl-v",
          version: 1,
          promptBody: "REVIEWED VISION PROMPT",
        }),
      },
    });
    return { verifier, sent, encrypted };
  }

  it("routes images to the vision model, never shows it the extracted value, ledgers digests not bytes", async () => {
    const { verifier, sent, encrypted } = build();
    const r = await verifier.verify({
      organizationId: ORG,
      actorUserId: "u",
      documentId: "d",
      verificationKey: "field_value",
      images: [{ pageNumber: 2, mediaType: "image/png", dataBase64: IMG }],
      field: { fieldPath: "allergies[0].substance", description: "allergen" },
    });
    expect(r).toMatchObject({ available: true, verdict: "pass", observedValue: "Penicillin" });
    expect(sent.map((s) => s.backend)).toEqual(["local-qwen2.5-vl-7b-instruct"]);
    const messages = (sent[0]?.body as { messages: Array<Record<string, unknown>> }).messages;
    expect(messages[0]).toEqual({ role: "system", content: "REVIEWED VISION PROMPT" });
    expect(messages[1]).toEqual({
      role: "user",
      content: "FIELD: allergies[0].substance\nDESCRIPTION: allergen",
      images: [IMG],
    });
    const prompt = JSON.parse(encrypted[0] as string) as { images: unknown[] };
    expect(prompt.images).toEqual([
      {
        mediaType: "image/png",
        sha256: createHash("sha256").update(Buffer.from(IMG, "base64")).digest("hex"),
      },
    ]);
    expect(encrypted.join("")).not.toContain(IMG);
  });

  it("refuses a field read with no image, without dispatching", async () => {
    const { verifier, sent } = build();
    const r = await verifier.verify({
      organizationId: ORG,
      actorUserId: "u",
      documentId: "d",
      verificationKey: "field_value",
      field: { fieldPath: "x", description: "y" },
    });
    expect(r).toMatchObject({ available: false });
    expect(sent).toHaveLength(0);
  });
});

describe("M5 admission clearance — which workflow lifts the restriction", () => {
  it("routes a DocLens interim flag to intake review and any other sud flag to consent", () => {
    expect(restrictionOf(["sud"], "m22_intake_unconfirmed")).toBe("INTAKE_DETECTION_UNREVIEWED");
    expect(restrictionOf(["sud"], "m22_intake_confirmed")).toBe("CONSENT_REQUIRED");
    // M39 consent state (no §2.31 release on file) has no DocLens origin.
    expect(restrictionOf(["sud"], null)).toBe("CONSENT_REQUIRED");
    // F-238: the interim flag is advisory to M6 only when it is the sole flag — another flag binds.
    expect(restrictionOf(["hiv", "sud"], "m22_intake_unconfirmed")).toBe("RESTRICTED");
    expect(restrictionOf(["hiv", "sud"], "m22_intake_confirmed")).toBe("CONSENT_REQUIRED");
    expect(restrictionOf(["hiv"], null)).toBe("RESTRICTED");
  });
});
