// Module 32 — the §4.1 invocation pipeline, end to end over the in-memory stores (M32-T04).
//
// The pure gate/route/cap rules are pinned in `packages/ai-platform/__tests__/invocation-rules.test.ts`.
// What THIS file proves is the part only the service can be wrong about: which refusals become
// `ai_invocation` rows, what those rows contain, that a refused call never reaches a backend, and that
// the four Phase-1 unbound ports refuse rather than wave a call through.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  ZdrContractMissingError,
  aiTokenBudgetFor,
  createAnthropicModelBackend,
  createEmptyModelBackendRegistry,
  createModelBackendRegistry,
} from "@chartwarden/ai-platform";
import type { AnthropicDispatch, ModelBackend } from "@chartwarden/ai-platform";
import type { AiConsumerContextRef } from "@chartwarden/types";
import { VENDOR_ADAPTERS } from "../../../architecture/module-manifest";

import { createInMemoryAiGovernanceStores } from "../src/modules/32-ai-platform/governance/store";
import type { AiTenantOptInRow } from "../src/modules/32-ai-platform/governance/store";
import {
  createAiInvocationPipeline,
  createDenyingAiChartContextValidator,
  createInMemoryAiInvocationStores,
  createUnconfiguredAiTokenBudgetResolver,
} from "../src/modules/32-ai-platform/invocation";
import type {
  AiBackendRoutingRow,
  AiInvocationCapabilityRow,
  AiInvocationCapabilityStore,
  AiInvocationPipelineDeps,
  AiInvokeRequest,
  AiPayloadCipher,
} from "../src/modules/32-ai-platform/invocation";

const ORG = "11111111-1111-4111-8111-111111111111";
const CAP_ID = "22222222-2222-4222-8222-222222222222";
const MEMBERSHIP = "33333333-3333-4333-8333-333333333333";
const PROVIDER_ENTITY = "44444444-4444-4444-8444-444444444444";
const PATIENT = "55555555-5555-4555-8555-555555555555";
const T0 = "2026-08-15T12:00:00.000Z";

const CAPABILITY: AiInvocationCapabilityRow = {
  id: CAP_ID,
  capabilityKey: "hearthnote_layer2",
  lifecycleState: "APPROVED",
  defaultBackendKey: "anthropic-claude-opus-4-7",
  allowedBackendKeys: ["anthropic-claude-opus-4-7", "local-llama-3.1-8b-instruct"],
  fallbackChainKeys: ["local-llama-3.1-8b-instruct"],
  tenantOverrideAllowed: true,
  tenantOptInRequired: true,
  currentPromptTemplateKey: "hearthnote_layer2/v1",
  requiredModality: null,
};

const CLOUD: AiBackendRoutingRow = {
  backendId: "66666666-6666-4666-8666-666666666666",
  backendKey: "anthropic-claude-opus-4-7",
  kind: "cloud",
  isActive: true,
  lastHealthStatus: "healthy",
  zdrStatus: "enabled",
  modelVersionPin: "claude-opus-4-7",
  supportedModalities: ["text"],
};

const LOCAL: AiBackendRoutingRow = {
  backendId: "77777777-7777-4777-8777-777777777777",
  backendKey: "local-llama-3.1-8b-instruct",
  kind: "local",
  isActive: true,
  lastHealthStatus: "healthy",
  zdrStatus: "not_applicable",
  modelVersionPin: "llama-3.1-8b-instruct",
  supportedModalities: ["text"],
};

const CONSUMER_CONTEXT: AiConsumerContextRef = {
  module: "m8",
  entityKind: "encounter",
  entityId: "88888888-8888-4888-8888-888888888888",
};

function activeOptIn(overrides: Partial<AiTenantOptInRow> = {}): AiTenantOptInRow {
  return {
    id: "optin-1",
    organizationId: ORG,
    capabilityId: CAP_ID,
    status: "active",
    orgAdminMembershipId: MEMBERSHIP,
    routingPreferenceSnapshot: "prefer_cloud",
    pilotEnrollment: false,
    optedInAt: T0,
    pausedAt: null,
    pausedReason: null,
    optedOutAt: null,
    optedOutReason: null,
    ...overrides,
  };
}

const cipher: AiPayloadCipher = {
  // A stand-in for M1's per-tenant DEK envelope: the pipeline's contract is that plaintext never reaches
  // the port, which is what this test checks — not the algorithm, which is M1's.
  encrypt: async (organizationId, plaintext) =>
    Buffer.from(`enc:${organizationId}:${plaintext}`, "utf8"),
};

function capabilityStore(row: AiInvocationCapabilityRow | null): AiInvocationCapabilityStore {
  return { findByKey: async () => row };
}

function textBackend(backendKey: string, complete: ModelBackend["complete"]): ModelBackend {
  return {
    backendKey,
    kind: backendKey.startsWith("local-") ? "local" : "cloud",
    capabilities: () => ({
      backendKey,
      kind: backendKey.startsWith("local-") ? "local" : "cloud",
      modelVersionPin: `${backendKey}-pin`,
      supportedModalities: ["text"],
      contextWindowTokens: 200_000,
      maxOutputTokens: 4_096,
      supportedFeatures: {
        structured_output: true,
        tool_use: true,
        vision: false,
        streaming: true,
      },
    }),
    health: async () => "healthy",
    complete,
  };
}

interface HarnessOptions {
  readonly aiFull?: boolean;
  readonly capability?: AiInvocationCapabilityRow | null;
  readonly optIns?: readonly AiTenantOptInRow[];
  readonly backends?: readonly AiBackendRoutingRow[];
  readonly killed?: boolean;
  readonly hardCapTokens?: number | null;
  readonly seededSpend?: number;
  readonly overrides?: AiInvocationPipelineDeps["overrides"] extends never ? never : undefined;
  readonly modelBackends?: AiInvocationPipelineDeps["modelBackends"];
  readonly chartContextPermitted?: boolean;
}

function harness(options: HarnessOptions = {}) {
  const stores = createInMemoryAiInvocationStores({
    backends: options.backends ?? [CLOUD, LOCAL],
    accruals:
      options.seededSpend === undefined
        ? []
        : [
            {
              id: "seed-accrual",
              organizationId: ORG,
              capabilityId: CAP_ID,
              backendId: CLOUD.backendId,
              vendorRateAtInvocation: null,
              inputTokens: options.seededSpend,
              outputTokens: 0,
              cloudCostUsd: null,
              localComputeAttribution: null,
              accruedAt: T0,
            },
          ],
  });
  const governance = createInMemoryAiGovernanceStores({
    optIns: options.optIns ?? [activeOptIn()],
  });

  const pipeline = createAiInvocationPipeline({
    capabilities: capabilityStore(
      options.capability === undefined ? CAPABILITY : options.capability,
    ),
    consent: governance.consent,
    backends: stores.backends,
    overrides: stores.overrides,
    ledger: stores.ledger,
    flags: { readFlags: async () => ({ "ai.full": options.aiFull ?? true }) },
    cipher,
    killSwitch: { isActive: async () => options.killed ?? false },
    modelBackends:
      options.modelBackends ??
      createModelBackendRegistry([
        textBackend(CLOUD.backendKey, async () => ({
          text: "enhanced narrative",
          inputTokens: 120,
          outputTokens: 45,
          modelVersionPin: CLOUD.modelVersionPin,
        })),
        textBackend(LOCAL.backendKey, async () => ({
          text: "local narrative",
          inputTokens: 100,
          outputTokens: 30,
          modelVersionPin: LOCAL.modelVersionPin,
        })),
      ]),
    tokenBudget:
      options.hardCapTokens === undefined
        ? { budgetFor: async () => aiTokenBudgetFor(10_000) }
        : options.hardCapTokens === null
          ? createUnconfiguredAiTokenBudgetResolver()
          : { budgetFor: async () => aiTokenBudgetFor(options.hardCapTokens as number) },
    chartContext: {
      validate: () => ({
        permitted: options.chartContextPermitted ?? true,
        detail: options.chartContextPermitted === false ? "unexpected property 'patientName'" : "",
      }),
    },
    now: () => new Date(T0),
  });

  return { pipeline, stores, governance };
}

const REQUEST: AiInvokeRequest = {
  capabilityKey: "hearthnote_layer2",
  organizationId: ORG,
  providerEntityId: PROVIDER_ENTITY,
  actorMembershipId: MEMBERSHIP,
  actorRole: "registered_nurse",
  patientId: PATIENT,
  consumerContextRef: CONSUMER_CONTEXT,
  prompt: { text: "Patient tolerated the visit well.", templateVersion: "v1" },
  chartContext: { patientAgeYears: 78 },
  invokedAt: T0,
};

// ── W1: the happy path ────────────────────────────────────────────────────────────────────────────

describe("aiSdk.invoke — completed dispatch (W1)", () => {
  it("dispatches, returns the output, and writes ONE invocation with ONE accrual", async () => {
    const { pipeline, stores } = harness();
    const outcome = await pipeline.invoke(REQUEST);

    expect(outcome.available).toBe(true);
    if (!outcome.available) return;
    expect(outcome.output.text).toBe("enhanced narrative");
    expect(outcome.route.backendKey).toBe(CLOUD.backendKey);

    expect(stores.invocationRows).toHaveLength(1);
    const row = stores.invocationRows[0]!;
    expect(row.status).toBe("completed");
    expect(row.inputTokenCount).toBe(120);
    expect(row.outputTokenCount).toBe(45);
    expect(row.zdrConfirmed).toBe(true);
    expect(row.providerEntityId).toBe(PROVIDER_ENTITY);
    expect(row.patientId).toBe(PATIENT);
    expect(row.hitlOutcome).toBe("pending");

    expect(stores.accrualRows).toHaveLength(1);
    expect(stores.accrualRows[0]!.inputTokens + stores.accrualRows[0]!.outputTokens).toBe(165);
  });

  it("never hands plaintext to the ledger — all three payloads cross as ciphertext", async () => {
    const { pipeline, stores } = harness();
    await pipeline.invoke(REQUEST);
    const row = stores.invocationRows[0]!;
    for (const buf of [
      row.promptPayloadCipher,
      row.chartContextCipher,
      row.responsePayloadCipher,
    ]) {
      expect(buf).not.toBeNull();
      expect(buf!.toString("utf8").startsWith(`enc:${ORG}:`)).toBe(true);
    }
    // And the clinician's literal text is nowhere in the row outside the ciphertext.
    expect(row.errorMessage).toBeNull();
  });

  it("records the pin the BACKEND echoed, so a drifted model is visible rather than smoothed", async () => {
    const { pipeline, stores } = harness({
      modelBackends: createModelBackendRegistry([
        textBackend(CLOUD.backendKey, async () => ({
          text: "x",
          inputTokens: 1,
          outputTokens: 1,
          modelVersionPin: "claude-opus-4-7-20260901",
        })),
      ]),
    });
    const outcome = await pipeline.invoke(REQUEST);
    expect(outcome.available).toBe(true);
    if (outcome.available) expect(outcome.output.modelVersionPin).toBe("claude-opus-4-7-20260901");
    // The ROUTE keeps the registry's pin; the OUTPUT carries what ran. Both are recorded.
    expect(stores.invocationRows[0]!.modelVersionPin).toBe(CLOUD.modelVersionPin);
  });

  it("W1.7 — reports the soft-cap crossing, and only on the accrual that crosses", async () => {
    const crossing = await harness({ hardCapTokens: 1_000, seededSpend: 700 }).pipeline.invoke(
      REQUEST,
    );
    expect(crossing.available && crossing.softCapCrossed).toBe(true);

    const alreadyOver = await harness({ hardCapTokens: 1_000, seededSpend: 850 }).pipeline.invoke(
      REQUEST,
    );
    expect(alreadyOver.available && alreadyOver.softCapCrossed).toBe(false);
    expect(alreadyOver.available && alreadyOver.tokenCapState).toBe("soft_breached");
  });

  it("records the human's decision — the one legal UPDATE §3.5 admits", async () => {
    const { pipeline, stores } = harness();
    const outcome = await pipeline.invoke(REQUEST);
    if (!outcome.available) throw new Error("expected a dispatch");
    await pipeline.recordHitlOutcome(ORG, outcome.invocationId, outcome.invokedAt, "edited");
    expect(stores.invocationRows[0]!.hitlOutcome).toBe("edited");
  });
});

// ── W2: the hard cap ──────────────────────────────────────────────────────────────────────────────

describe("aiSdk.invoke — W2 hard token cap", () => {
  it("refuses without contacting ANY backend, and records the refusal", async () => {
    const dispatch = vi.fn();
    const { pipeline, stores } = harness({
      hardCapTokens: 1_000,
      seededSpend: 1_000,
      modelBackends: createModelBackendRegistry([
        textBackend(CLOUD.backendKey, dispatch as unknown as ModelBackend["complete"]),
      ]),
    });

    const outcome = await pipeline.invoke(REQUEST);
    expect(outcome.available).toBe(false);
    if (outcome.available) return;
    expect(outcome.unavailable.reason).toBe("token_hard_cap_reached");
    // W2.2 — no Anthropic call, no Ollama call.
    expect(dispatch).not.toHaveBeenCalled();

    // W2.4 — the row exists, with no payload and zero deltas.
    expect(stores.invocationRows).toHaveLength(1);
    const row = stores.invocationRows[0]!;
    expect(row.status).toBe("capability_unavailable");
    expect(row.errorClass).toBe("token_hard_cap_reached");
    expect(row.promptPayloadCipher.byteLength).toBe(0);
    expect(row.responsePayloadCipher).toBeNull();
    expect(row.chartContextCipher).toBeNull();
    expect(row.inputTokenCount).toBe(0);
    expect(row.outputTokenCount).toBe(0);
    // D7's ledger distinction: a cap fallback is not a vendor outage.
    expect(row.routingReason).toBe("cost_cap_fallback");
    expect(row.backendKey).toBe(CLOUD.backendKey);

    // And it spent nothing, so the SPEND ledger gains no row beyond the seeded one.
    expect(stores.accrualRows).toHaveLength(1);
    expect(stores.accrualRows[0]!.id).toBe("seed-accrual");
    expect(outcome.ledgerRecorded).toBe(true);
  });

  it("an unconfigured budget refuses too — an absent bound is not an unbounded one", async () => {
    const { pipeline } = harness({ hardCapTokens: null });
    const outcome = await pipeline.invoke(REQUEST);
    expect(outcome.available).toBe(false);
    if (!outcome.available) {
      expect(outcome.gate).toBe("token_cap");
      expect(outcome.detail).toContain("no monthly token budget is configured");
    }
  });

  it("the default Phase-1 budget resolver answers null for everything", async () => {
    expect(await createUnconfiguredAiTokenBudgetResolver().budgetFor(ORG, "anything")).toBeNull();
  });

  it("sums only the org's own accruals inside the month", async () => {
    const { stores } = harness({ seededSpend: 500 });
    expect(
      await stores.ledger.sumTokensInWindow(ORG, CAP_ID, {
        start: "2026-08-01T00:00:00.000Z",
        end: "2026-09-01T00:00:00.000Z",
      }),
    ).toBe(500);
    // The next month's window sees none of it — the cap resets at the partition boundary.
    expect(
      await stores.ledger.sumTokensInWindow(ORG, CAP_ID, {
        start: "2026-09-01T00:00:00.000Z",
        end: "2026-10-01T00:00:00.000Z",
      }),
    ).toBe(0);
    // Another tenant's spend is not this tenant's.
    expect(
      await stores.ledger.sumTokensInWindow("other-org", CAP_ID, {
        start: "2026-08-01T00:00:00.000Z",
        end: "2026-09-01T00:00:00.000Z",
      }),
    ).toBe(0);
  });
});

// ── W8: the local-only override ───────────────────────────────────────────────────────────────────

describe("aiSdk.invoke — W8 local-only routing", () => {
  it("routes a local_only tenant to the local backend", async () => {
    const { pipeline, stores } = harness({
      optIns: [activeOptIn({ routingPreferenceSnapshot: "local_only" })],
    });
    const outcome = await pipeline.invoke(REQUEST);
    expect(outcome.available).toBe(true);
    if (outcome.available) expect(outcome.route.backendKey).toBe(LOCAL.backendKey);
    expect(stores.invocationRows[0]!.backendKey).toBe(LOCAL.backendKey);
    // A local route is not an Anthropic disclosure, so `zdr_confirmed` is false and §3.2.8's CHECK is
    // satisfied by the `NOT LIKE 'anthropic-%'` arm rather than by a claim nobody verified.
    expect(stores.invocationRows[0]!.zdrConfirmed).toBe(false);
  });

  it("W8.3 — an unhealthy local backend does NOT fall back to Anthropic", async () => {
    const dispatch = vi.fn();
    const { pipeline, stores } = harness({
      optIns: [activeOptIn({ routingPreferenceSnapshot: "local_only" })],
      backends: [CLOUD, { ...LOCAL, lastHealthStatus: "unhealthy" }],
      modelBackends: createModelBackendRegistry([
        textBackend(CLOUD.backendKey, dispatch as unknown as ModelBackend["complete"]),
      ]),
    });
    const outcome = await pipeline.invoke(REQUEST);
    expect(outcome.available).toBe(false);
    if (!outcome.available) expect(outcome.unavailable.reason).toBe("backend_unhealthy");
    expect(dispatch).not.toHaveBeenCalled();
    // The row names the LOCAL backend it was aimed at, never the cloud one it was forbidden to reach.
    expect(stores.invocationRows[0]!.backendKey).toBe(LOCAL.backendKey);
  });

  it("honours a live tenant routing override and ignores an expired one", async () => {
    const { pipeline, stores } = harness();
    await stores.overrides.insertOverride({
      organizationId: ORG,
      capabilityId: CAP_ID,
      backendKeyPreference: LOCAL.backendKey,
      overrideReason: "tenant_sovereignty",
      setByMembershipId: MEMBERSHIP,
      effectiveAt: "2026-08-01T00:00:00.000Z",
      expiresAt: null,
    });
    const live = await pipeline.invoke(REQUEST);
    expect(live.available && live.route.backendKey).toBe(LOCAL.backendKey);
    expect(stores.invocationRows[0]!.routingReason).toBe("tenant_override");

    const expired = harness();
    await expired.stores.overrides.insertOverride({
      organizationId: ORG,
      capabilityId: CAP_ID,
      backendKeyPreference: LOCAL.backendKey,
      overrideReason: "tenant_sovereignty",
      setByMembershipId: MEMBERSHIP,
      effectiveAt: "2026-07-01T00:00:00.000Z",
      expiresAt: "2026-08-01T00:00:00.000Z",
    });
    const after = await expired.pipeline.invoke(REQUEST);
    // Expiry is a query predicate at the routing gate — the row still exists, it is just not in force.
    expect(after.available && after.route.backendKey).toBe(CLOUD.backendKey);
  });

  it("another tenant's override does not reach this tenant's routing", async () => {
    const { pipeline, stores } = harness();
    await stores.overrides.insertOverride({
      organizationId: "other-org",
      capabilityId: CAP_ID,
      backendKeyPreference: LOCAL.backendKey,
      overrideReason: "tenant_sovereignty",
      setByMembershipId: MEMBERSHIP,
      effectiveAt: "2026-08-01T00:00:00.000Z",
      expiresAt: null,
    });
    const outcome = await pipeline.invoke(REQUEST);
    expect(outcome.available && outcome.route.backendKey).toBe(CLOUD.backendKey);
  });
});

// ── W9 + the consent gates ────────────────────────────────────────────────────────────────────────

describe("aiSdk.invoke — refusals", () => {
  it("W9 — a PROPOSED capability answers `unavailable` and still writes the ledger row", async () => {
    const { pipeline, stores } = harness({
      capability: { ...CAPABILITY, lifecycleState: "PROPOSED" },
    });
    const outcome = await pipeline.invoke(REQUEST);
    expect(outcome.available).toBe(false);
    if (!outcome.available) {
      expect(outcome.unavailable.reason).toBe("lifecycle_state_below_approved");
      expect(outcome.ledgerRecorded).toBe(true);
    }
    expect(stores.invocationRows[0]!.status).toBe("capability_unavailable");
    expect(stores.invocationRows[0]!.errorClass).toBe("lifecycle_state_below_approved");
  });

  it("`ai.full` off refuses everything, reads no capability, and writes NO row", async () => {
    const capabilities = { findByKey: vi.fn(async () => CAPABILITY) };
    const stores = createInMemoryAiInvocationStores({ backends: [CLOUD, LOCAL] });
    const governance = createInMemoryAiGovernanceStores({ optIns: [activeOptIn()] });
    const pipeline = createAiInvocationPipeline({
      capabilities,
      consent: governance.consent,
      backends: stores.backends,
      overrides: stores.overrides,
      ledger: stores.ledger,
      flags: { readFlags: async () => ({ "ai.full": false }) },
      cipher,
      killSwitch: { isActive: async () => false },
      modelBackends: createEmptyModelBackendRegistry(),
    });

    const outcome = await pipeline.invoke(REQUEST);
    expect(outcome.available).toBe(false);
    if (!outcome.available) {
      expect(outcome.unavailable.reason).toBe("phase_1_capability_shell");
      expect(outcome.gate).toBe("ai_full_flag");
      // The one refusal that deliberately leaves no §164.528 row — and it says so rather than
      // silently dropping it.
      expect(outcome.ledgerRecorded).toBe(false);
      expect(outcome.invocationId).toBeNull();
    }
    expect(capabilities.findByKey).not.toHaveBeenCalled();
    expect(stores.invocationRows).toHaveLength(0);
  });

  it("an unreachable flag store reads as OFF", async () => {
    const stores = createInMemoryAiInvocationStores({ backends: [CLOUD] });
    const governance = createInMemoryAiGovernanceStores({ optIns: [activeOptIn()] });
    const pipeline = createAiInvocationPipeline({
      capabilities: capabilityStore(CAPABILITY),
      consent: governance.consent,
      backends: stores.backends,
      overrides: stores.overrides,
      ledger: stores.ledger,
      flags: {
        readFlags: async () => {
          throw new Error("valkey unreachable");
        },
      },
      cipher,
      killSwitch: { isActive: async () => false },
      modelBackends: createEmptyModelBackendRegistry(),
    });
    const outcome = await pipeline.invoke(REQUEST);
    expect(outcome.available).toBe(false);
    if (!outcome.available) expect(outcome.unavailable.reason).toBe("phase_1_capability_shell");
  });

  it("an unknown capability answers as RETIRED, so the registry cannot be enumerated", async () => {
    const { pipeline, stores } = harness({ capability: null });
    const outcome = await pipeline.invoke(REQUEST);
    expect(outcome.available).toBe(false);
    if (!outcome.available) {
      expect(outcome.unavailable.reason).toBe("lifecycle_state_retired");
      // No capability id exists, so `ai_invocation.capability_id` (NOT NULL, real FK) cannot be filled.
      expect(outcome.ledgerRecorded).toBe(false);
    }
    expect(stores.invocationRows).toHaveLength(0);
  });

  it("a kill switch refuses before the consent gates are consulted", async () => {
    const consent = createInMemoryAiGovernanceStores({ optIns: [] });
    const findOptIn = vi.spyOn(consent.consent, "findOptIn");
    const stores = createInMemoryAiInvocationStores({ backends: [CLOUD] });
    const pipeline = createAiInvocationPipeline({
      capabilities: capabilityStore(CAPABILITY),
      consent: consent.consent,
      backends: stores.backends,
      overrides: stores.overrides,
      ledger: stores.ledger,
      flags: { readFlags: async () => ({ "ai.full": true }) },
      cipher,
      killSwitch: { isActive: async () => true },
      modelBackends: createEmptyModelBackendRegistry(),
      tokenBudget: { budgetFor: async () => aiTokenBudgetFor(10_000) },
      chartContext: { validate: () => ({ permitted: true, detail: "" }) },
    });
    const outcome = await pipeline.invoke(REQUEST);
    expect(outcome.available).toBe(false);
    if (!outcome.available) expect(outcome.unavailable.reason).toBe("kill_switch_active");
    // The lookup may run (the facts are gathered concurrently) but the ANSWER must not depend on it:
    // a tenant with no opt-in row still gets `kill_switch_active`, never `tenant_not_opted_in`.
    findOptIn.mockRestore();
  });

  it("a tenant that has not opted in is refused, and the clinician is not blamed", async () => {
    const { pipeline } = harness({ optIns: [] });
    const outcome = await pipeline.invoke(REQUEST);
    expect(outcome.available).toBe(false);
    if (!outcome.available) expect(outcome.unavailable.reason).toBe("tenant_not_opted_in");
  });

  it("the unbound PHI-minimisation validator refuses rather than forwarding chart context", async () => {
    const validator = createDenyingAiChartContextValidator();
    const verdict = await validator.validate("hearthnote_layer2", { patientName: "Ada" });
    expect(verdict.permitted).toBe(false);

    const { pipeline } = harness({ chartContextPermitted: false });
    const outcome = await pipeline.invoke(REQUEST);
    expect(outcome.available).toBe(false);
    if (!outcome.available) expect(outcome.unavailable.reason).toBe("phi_minimization_failure");
  });

  it("a registered backend with no bound adapter refuses instead of crashing the request", async () => {
    const { pipeline, stores } = harness({ modelBackends: createEmptyModelBackendRegistry() });
    const outcome = await pipeline.invoke(REQUEST);
    expect(outcome.available).toBe(false);
    if (!outcome.available) {
      expect(outcome.unavailable.reason).toBe("backend_unhealthy");
      expect(outcome.detail).toContain("no model adapter is bound");
      expect(outcome.ledgerRecorded).toBe(true);
    }
    expect(stores.invocationRows[0]!.status).toBe("capability_unavailable");
  });
});

// ── dispatch failures ─────────────────────────────────────────────────────────────────────────────

describe("aiSdk.invoke — a backend that throws or hangs", () => {
  it("records a failed dispatch with the error CLASS and no message, and no accrual", async () => {
    const { pipeline, stores } = harness({
      modelBackends: createModelBackendRegistry([
        textBackend(CLOUD.backendKey, async () => {
          throw new ZdrContractMissingError("no ZDR contract for org …");
        }),
      ]),
    });
    const outcome = await pipeline.invoke(REQUEST);
    expect(outcome.available).toBe(false);
    if (!outcome.available) expect(outcome.unavailable.reason).toBe("backend_unhealthy");

    const row = stores.invocationRows[0]!;
    expect(row.status).toBe("failed");
    expect(row.errorClass).toBe("ZdrContractMissingError");
    // A vendor error string can echo the prompt back; §3.4 denylists the column for that reason and the
    // pipeline stores nothing rather than asserting it stripped it.
    expect(row.errorMessage).toBeNull();
    // Token counts are UNKNOWN, not zero, so no fabricated accrual lands in the spend ledger.
    expect(stores.accrualRows).toHaveLength(0);
  });

  it("a dispatch that outlives the budget is `timed_out`, not lumped in with `failed`", async () => {
    const stores = createInMemoryAiInvocationStores({ backends: [CLOUD] });
    const governance = createInMemoryAiGovernanceStores({ optIns: [activeOptIn()] });
    const pipeline = createAiInvocationPipeline({
      capabilities: capabilityStore(CAPABILITY),
      consent: governance.consent,
      backends: stores.backends,
      overrides: stores.overrides,
      ledger: stores.ledger,
      flags: { readFlags: async () => ({ "ai.full": true }) },
      cipher,
      killSwitch: { isActive: async () => false },
      modelBackends: createModelBackendRegistry([
        textBackend(
          CLOUD.backendKey,
          () =>
            new Promise(() => {
              /* never settles */
            }),
        ),
      ]),
      tokenBudget: { budgetFor: async () => aiTokenBudgetFor(10_000) },
      chartContext: { validate: () => ({ permitted: true, detail: "" }) },
      dispatchTimeoutMs: 5,
    });

    const outcome = await pipeline.invoke(REQUEST);
    expect(outcome.available).toBe(false);
    expect(stores.invocationRows[0]!.status).toBe("timed_out");
    expect(stores.invocationRows[0]!.errorClass).toBe("dispatch_timeout");
    // The attempt is recorded even though the vendor may yet answer — which is what §164.528 needs.
    expect(stores.invocationRows).toHaveLength(1);
  });
});

// ── the vendor-adapter mandate + D19 ──────────────────────────────────────────────────────────────

describe("the Anthropic adapter (D19 / §8.4)", () => {
  const options = {
    backendKey: "anthropic-claude-opus-4-7",
    capabilities: {
      modelVersionPin: "claude-opus-4-7",
      supportedModalities: ["text"] as const,
      contextWindowTokens: 200_000,
      maxOutputTokens: 4_096,
      supportedFeatures: {
        structured_output: true,
        tool_use: true,
        vision: false,
        streaming: true,
      },
    },
    probeHealth: async () => "healthy" as const,
  };

  // Typed as the real `AnthropicDispatch`, so `transport.mock.calls[0][1]` is the resolved ZDR
  // contract rather than an element of an empty tuple.
  const dispatch: AnthropicDispatch = async () => ({
    text: "ok",
    inputTokens: 1,
    outputTokens: 1,
    modelVersionPin: "claude-opus-4-7",
  });

  const request = {
    organizationId: ORG,
    systemPrompt: null,
    prompt: "p",
    chartContext: {},
    maxOutputTokens: 100,
  };

  it("cannot be constructed without a ZDR resolver or without a transport", () => {
    expect(() =>
      createAnthropicModelBackend({
        ...options,
        zdrContractResolver: undefined as never,
        dispatch,
      }),
    ).toThrow(ZdrContractMissingError);
    expect(() =>
      createAnthropicModelBackend({
        ...options,
        zdrContractResolver: async () => null,
        dispatch: undefined as never,
      }),
    ).toThrow(ZdrContractMissingError);
  });

  it("refuses the call when no ZDR contract resolves, and never reaches the transport", async () => {
    const transport = vi.fn(dispatch);
    const backend = createAnthropicModelBackend({
      ...options,
      zdrContractResolver: async () => null,
      dispatch: transport,
    });
    await expect(backend.complete!(request)).rejects.toBeInstanceOf(ZdrContractMissingError);
    expect(transport).not.toHaveBeenCalled();
  });

  it("treats an expired — and an unparseable — contract exactly as an absent one", async () => {
    const transport = vi.fn(dispatch);
    const expired = createAnthropicModelBackend({
      ...options,
      zdrContractResolver: async () => ({
        contractRef: "zdr-1",
        verifiedAt: "2026-01-01T00:00:00.000Z",
        expiresAt: "2026-06-01T00:00:00.000Z",
      }),
      dispatch: transport,
      now: () => new Date(T0),
    });
    await expect(expired.complete!(request)).rejects.toBeInstanceOf(ZdrContractMissingError);

    const unparseable = createAnthropicModelBackend({
      ...options,
      zdrContractResolver: async () => ({
        contractRef: "zdr-1",
        verifiedAt: "2026-01-01T00:00:00.000Z",
        expiresAt: "not-a-date",
      }),
      dispatch: transport,
      now: () => new Date(T0),
    });
    await expect(unparseable.complete!(request)).rejects.toBeInstanceOf(ZdrContractMissingError);
    expect(transport).not.toHaveBeenCalled();
  });

  it("dispatches only with a live contract, and hands the RESOLVED contract to the transport", async () => {
    const transport = vi.fn(dispatch);
    const backend = createAnthropicModelBackend({
      ...options,
      zdrContractResolver: async () => ({
        contractRef: "zdr-1",
        verifiedAt: "2026-01-01T00:00:00.000Z",
        expiresAt: "2027-01-01T00:00:00.000Z",
      }),
      dispatch: transport,
      now: () => new Date(T0),
    });
    await backend.complete!(request);
    expect(transport).toHaveBeenCalledOnce();
    // The transport receives the contract rather than the org id, so it cannot choose not to ask.
    expect(transport.mock.calls[0]![1].contractRef).toBe("zdr-1");
  });

  it("the vendor-adapter mandate points at this package — and the SDK is installed ONLY here (F-236)", () => {
    expect(VENDOR_ADAPTERS["@anthropic-ai/sdk"]).toBe("packages/ai-platform");
    // F-236 (ADR-0048) bound the real transport (`backends/anthropic-sdk.ts`), so the confinement rule is
    // no longer vacuous: the SDK is a dependency of `@chartwarden/ai-platform` and of nothing else — not the
    // root, not the backend app. dependency-cruiser enforces the import side.
    const root = JSON.parse(
      readFileSync(join(import.meta.dirname, "../../../package.json"), "utf8"),
    ) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    const app = JSON.parse(readFileSync(join(import.meta.dirname, "../package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
    };
    const pkg = JSON.parse(
      readFileSync(join(import.meta.dirname, "../../../packages/ai-platform/package.json"), "utf8"),
    ) as { dependencies?: Record<string, string> };
    expect(root.dependencies?.["@anthropic-ai/sdk"]).toBeUndefined();
    expect(root.devDependencies?.["@anthropic-ai/sdk"]).toBeUndefined();
    expect(app.dependencies?.["@anthropic-ai/sdk"]).toBeUndefined();
    expect(pkg.dependencies?.["@anthropic-ai/sdk"]).toBeDefined();
  });
});
