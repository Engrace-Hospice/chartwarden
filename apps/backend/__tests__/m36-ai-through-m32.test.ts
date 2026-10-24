// M36 WP 6.5 (ADR-0095): the M36 AI service over M32's REAL invocation pipeline (in-memory stores, a scripted model backend, no network).
//
// Proves the seam end to end: what the model backend actually receives, the one `ai_invocation` row per call, the chart-context allowlist, the
// guarded human-decision write, and that an unseeded capability (the production state) is "AI unavailable". No external vendor is ever called.
import { createModelBackendRegistry } from "@chartwarden/ai-platform";
import type { AiBackendRoutingRow, ModelBackend } from "@chartwarden/ai-platform";
import type { ResolvedMessage } from "@chartwarden/messaging";
import { describe, expect, it } from "vitest";
import { createInMemoryAiGovernanceStores } from "../src/modules/32-ai-platform/governance/store";
import {
  createAiInvocationPipeline,
  createInMemoryAiInvocationStores,
} from "../src/modules/32-ai-platform/invocation";
import type { AiInvocationCapabilityRow } from "../src/modules/32-ai-platform/invocation";
import { createRuleBasedAiChartContextValidator } from "../src/modules/32-ai-platform/invocation/chart-context-rules";
import { createMessagingAiPort } from "../src/modules/32-ai-platform/seams/messaging-ai";
import { createAiService } from "../src/modules/36-messaging/ai/ai-service";

const ORG = "11111111-1111-4111-8111-111111111111";
const MEMBERSHIP = "33333333-3333-4333-8333-333333333333";
const OTHER_MEMBERSHIP = "99999999-9999-4999-8999-999999999999";
const PROVIDER = "44444444-4444-4444-8444-444444444444";
const PATIENT = "55555555-5555-4555-8555-555555555555";
const CHANNEL = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const OTHER_CHANNEL = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const ME = "u-me";
const RITA = "u-rita";
const NOW = new Date("2026-10-23T12:00:00.000Z");

const BACKEND: AiBackendRoutingRow = {
  backendId: "66666666-6666-4666-8666-666666666666",
  backendKey: "bedrock-baa-test",
  kind: "cloud",
  isActive: true,
  lastHealthStatus: "healthy",
  zdrStatus: "enabled",
  modelVersionPin: "test-pin",
  supportedModalities: ["text"],
};

const capability = (id: string, key: string): AiInvocationCapabilityRow => ({
  id,
  capabilityKey: key,
  lifecycleState: "APPROVED", // the test pretends stage 4 passed; production rows are PROPOSED / unseeded
  defaultBackendKey: BACKEND.backendKey,
  allowedBackendKeys: [BACKEND.backendKey],
  fallbackChainKeys: [],
  tenantOverrideAllowed: false,
  tenantOptInRequired: true,
  currentPromptTemplateKey: null,
  requiredModality: null,
});
const CAPS = [
  capability("c0000001-0000-4000-8000-000000000001", "messaging_summarize"),
  capability("c0000002-0000-4000-8000-000000000002", "messaging_draft_reply"),
];

const msg = (id: string, body: string, min: number): ResolvedMessage =>
  ({
    messageId: id,
    channelId: CHANNEL,
    authorUserId: RITA,
    authorDisplayName: "Rita Alvarez",
    body,
    bodyKind: "plain",
    createdAt: new Date(NOW.getTime() - min * 60_000).toISOString(),
    parentMessageId: null,
    references: [],
  }) as ResolvedMessage;

const THREAD = [
  msg("a", "Margaret Hollis has uncontrolled pain since morning", 120),
  msg("b", "Family asked for a call today", 60),
  msg("c", "I will call back", 10),
];

const SUMMARY = JSON.stringify({
  points: [{ text: "Pain reported", sourceMessageRefs: ["m1"], confidence: "high" }],
  openQuestions: [],
  insufficientContext: false,
});

function harness(options: { seedCapabilities?: boolean; modelAnswer?: string } = {}) {
  const sent: { system: string | undefined; user: string }[] = [];
  const backend: ModelBackend = {
    backendKey: BACKEND.backendKey,
    kind: "cloud",
    capabilities: () => ({
      backendKey: BACKEND.backendKey,
      kind: "cloud",
      modelVersionPin: BACKEND.modelVersionPin,
      supportedModalities: ["text"],
      contextWindowTokens: 100_000,
      maxOutputTokens: 4_096,
      supportedFeatures: {
        structured_output: true,
        tool_use: false,
        vision: false,
        streaming: false,
      },
    }),
    health: async () => "healthy",
    complete: async (request) => {
      const r = request as unknown as { systemPrompt?: string; prompt?: string; text?: string };
      sent.push({
        system: r.systemPrompt,
        user: String(r.prompt ?? r.text ?? JSON.stringify(request)),
      });
      return {
        text: options.modelAnswer ?? SUMMARY,
        inputTokens: 100,
        outputTokens: 40,
        modelVersionPin: BACKEND.modelVersionPin,
      };
    },
  };
  const stores = createInMemoryAiInvocationStores({ backends: [BACKEND] });
  const governance = createInMemoryAiGovernanceStores({
    optIns: CAPS.map((c) => ({
      id: `optin-${c.id}`,
      organizationId: ORG,
      capabilityId: c.id,
      status: "active" as const,
      orgAdminMembershipId: MEMBERSHIP,
      routingPreferenceSnapshot: "prefer_cloud" as const,
      pilotEnrollment: false,
      optedInAt: NOW.toISOString(),
      pausedAt: null,
      pausedReason: null,
      optedOutAt: null,
      optedOutReason: null,
    })),
  });
  const pipeline = createAiInvocationPipeline({
    capabilities: {
      findByKey: async (key) =>
        options.seedCapabilities === false
          ? null
          : (CAPS.find((c) => c.capabilityKey === key) ?? null),
    },
    consent: governance.consent,
    backends: stores.backends,
    overrides: stores.overrides,
    ledger: stores.ledger,
    flags: { readFlags: async () => ({ "ai.full": true }) },
    cipher: { encrypt: async (_o, plaintext) => Buffer.from(`enc:${plaintext}`) },
    killSwitch: { isActive: async () => false },
    modelBackends: createModelBackendRegistry([backend]),
    tokenBudget: {
      budgetFor: async () => ({ hardCapTokens: 1_000_000, softCapTokens: 800_000 }) as never,
    },
    chartContext: createRuleBasedAiChartContextValidator(),
    now: () => NOW,
  });
  const actors = {
    resolve: async (_org: string, userId: string) => ({
      actorMembershipId: userId === ME ? MEMBERSHIP : OTHER_MEMBERSHIP,
      actorRole: "registered_nurse",
      providerEntityId: PROVIDER,
      locationId: null,
    }),
  };
  const prompts = {
    getActivePromptForCapability: async () => ({
      promptTemplateId: "tmpl-1",
      version: 1,
      promptBody: "SYSTEM PROMPT",
    }),
  };
  const port = createMessagingAiPort({ pipeline, prompts, actors, now: () => NOW });
  const service = createAiService({
    port,
    isEnabled: async () => true,
    canUseAi: async () => true,
    canViewChannel: async () => true,
    channelFacts: async () => ({ patientId: PATIENT, archived: false }),
    isPart2Restricted: async () => false,
    readWindow: async () => THREAD,
    patientNames: async () => ["Margaret Hollis"],
    roleTokens: async () => new Map([[RITA, "[RN]" as const]]),
    withinQuota: async () => true,
    audit: async () => undefined,
    now: () => NOW,
  });
  return { service, stores, sent, port };
}

describe("M36 AI service over M32's real pipeline", () => {
  it("writes exactly one ai_invocation row that names the channel, the message range and the patient, and the backend never sees a name", async () => {
    const { service, stores, sent } = harness();
    const out = await service.summarize({ orgId: ORG, userId: ME }, CHANNEL, null);
    expect(out.status).toBe("ok");
    expect(stores.invocationRows).toHaveLength(1);
    const row = stores.invocationRows[0]!;
    expect(row.capabilityKey).toBe("messaging_summarize");
    expect(row.status).toBe("completed");
    expect(row.patientId).toBe(PATIENT);
    expect(row.actorMembershipId).toBe(MEMBERSHIP);
    expect(row.consumerContextRef).toMatchObject({
      module: "m36",
      entityKind: "channel",
      entityId: CHANNEL,
      messageRange: { firstMessageId: "a", lastMessageId: "c", count: 3 },
    });
    expect(row.hitlOutcome).toBe("pending");
    const everythingSent = JSON.stringify(sent);
    for (const leak of ["Margaret", "Hollis", "Rita", "Alvarez", PATIENT, CHANNEL, ME]) {
      expect(everythingSent).not.toContain(leak);
    }
    expect(everythingSent).toContain("[PATIENT]");
    expect(everythingSent).toContain("SYSTEM PROMPT");
  });

  it("a draft is one ledger row too, and records the human decision only for its own actor, channel and capability", async () => {
    const { service, stores } = harness({
      modelAnswer: JSON.stringify({ drafts: [{ text: "I will call the family." }] }),
    });
    const draft = await service.draftReply({ orgId: ORG, userId: ME }, CHANNEL, null);
    expect(stores.invocationRows.map((r) => r.capabilityKey)).toEqual(["messaging_draft_reply"]);

    const base = { invocationId: draft.invocation_id, invokedAt: draft.invoked_at };
    // another user's decision, another channel's decision: both refused, row unchanged
    await expect(
      service.recordOutcome({ orgId: ORG, userId: "u-someone-else" }, CHANNEL, {
        ...base,
        outcome: "accepted",
      }),
    ).rejects.toMatchObject({ statusCode: 404 });
    await expect(
      service.recordOutcome({ orgId: ORG, userId: ME }, OTHER_CHANNEL, {
        ...base,
        outcome: "accepted",
      }),
    ).rejects.toMatchObject({ statusCode: 404 });
    expect(stores.invocationRows[0]!.hitlOutcome).toBe("pending");
    // the owner records accepted, then may refine it to edited, then it is final
    await service.recordOutcome({ orgId: ORG, userId: ME }, CHANNEL, {
      ...base,
      outcome: "accepted",
    });
    expect(stores.invocationRows[0]!.hitlOutcome).toBe("accepted");
    await service.recordOutcome({ orgId: ORG, userId: ME }, CHANNEL, {
      ...base,
      outcome: "edited",
    });
    expect(stores.invocationRows[0]!.hitlOutcome).toBe("edited");
    await expect(
      service.recordOutcome({ orgId: ORG, userId: ME }, CHANNEL, { ...base, outcome: "rejected" }),
    ).rejects.toMatchObject({ statusCode: 404 });
    expect(stores.invocationRows[0]!.hitlOutcome).toBe("edited");
  });

  it("an unseeded capability (the production state: PROPOSED, no backend) is AI unavailable and nothing reaches a backend", async () => {
    const { service, stores, sent } = harness({ seedCapabilities: false });
    await expect(
      service.summarize({ orgId: ORG, userId: ME }, CHANNEL, null),
    ).rejects.toMatchObject({ code: "AI_UNAVAILABLE", statusCode: 503 });
    expect(sent).toHaveLength(0);
    expect(stores.invocationRows).toHaveLength(0);
  });

  it("the chart-context allowlist refuses any key beyond channelId and messageCount (the adapter sends only those)", async () => {
    const validator = createRuleBasedAiChartContextValidator();
    expect(
      (await validator.validate("messaging_summarize", { channelId: CHANNEL, messageCount: 3 }))
        .permitted,
    ).toBe(true);
    for (const key of ["patientName", "mrn", "body", "authorUserId"]) {
      expect(
        (await validator.validate("messaging_summarize", { channelId: CHANNEL, [key]: "x" }))
          .permitted,
      ).toBe(false);
    }
    expect(
      (await validator.validate("messaging_draft_reply", { channelId: { nested: true } }))
        .permitted,
    ).toBe(false);
  });

  it("an injection payload inside a message changes nothing but the one scripted answer: output is parsed, nothing else is executed", async () => {
    const { service, stores } = harness({
      modelAnswer: JSON.stringify({
        points: [
          {
            text: "ok",
            sourceMessageRefs: ["m1"],
            confidence: "high",
            tool: "send_message",
            args: { channel: "all" },
          },
        ],
        openQuestions: [],
        insufficientContext: false,
        actions: [{ send: "everyone" }],
      }),
    });
    const out = await service.summarize({ orgId: ORG, userId: ME }, CHANNEL, null);
    expect(JSON.stringify(out)).not.toMatch(/send_message|everyone|actions/);
    expect(stores.invocationRows).toHaveLength(1);
  });
});
