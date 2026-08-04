import {
  type AIPromptRegistry,
  AI_PROHIBITED_ZONES,
  type ActivePromptSummary,
  type NarrativeEnhancementProvider,
  aiPromptTargetsPrefix,
  aiTargetPrefixIsProhibited,
  findAiProhibitedZoneViolations,
} from "@wardenx/ai-platform";
// apps/backend/__tests__/ai-platform-seams.test.ts — M32-T06, the §4.2–§4.4 seam boundary.
//
// What these prove, in the order the failures would hurt:
//
//   • the TEN inference deny-stubs REFUSE with a value and never throw, while `AIPromptRegistry` — the
//     D18 safety query six other modules boot on — THROWS. A test that only checked "the seam denies"
//     would pass with those two behaviours swapped, and swapping them is the actual danger: a
//     non-throwing prompt registry hands M12/M13/M18/M21/M27/M28 a clean bill of health minted by an
//     unwired registry.
//   • the deny-stub says `provider_unregistered` and the REGISTERED seam says `phase_1_capability_shell`.
//     Both mean "no AI" in Phase 1, which is exactly why a test has to pin them apart — the day the flag
//     flips, one of them means "the boot forgot to wire M32".
//   • `discipline_plan_goal_rationale` refuses WITHOUT touching the pipeline. §2.4 registers no
//     capability for it; the test asserts the pipeline was never called, because "refused" and "refused
//     after a vendor round trip" are different amounts of money and different §164.528 ledgers.
//   • the D18 prefix direction. `'medication_order'.startsWith('medication_')` is the match that catches
//     contraband; the inverse reads false and fails OPEN. Asserted on a real pair, both ways.
//   • a COMPLETED invocation with no §2.5 projector refuses — and the refusal is
//     `output_validation_failed_after_retry`, not a fabricated payload.
import type { IsoInstant, OrgId, PatientId } from "@wardenx/types";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  REQUIRED_SEAMS,
  __resetSeamsForTest,
  getSeam,
  validateSeams,
} from "../src/bootstrap/seams/registry";
import { createInMemoryAiGovernanceStores } from "../src/modules/32-ai-platform/governance/store";
import {
  AiBootValidationError,
  createAiBootValidators,
  createDocLensClassifier,
  createHospitalizationRiskProvider,
  createNarrativeEnhancementProvider,
  createProtocolSuggestionProvider,
  registerAiPlatformSeams,
} from "../src/modules/32-ai-platform/index";
import type {
  AiInvocationOutcome,
  AiInvocationPipeline,
  AiInvokeRequest,
} from "../src/modules/32-ai-platform/invocation/service";
import { createInMemoryAiInvocationStores } from "../src/modules/32-ai-platform/invocation/store";
import { createInMemoryAiPromptTemplateStore } from "../src/modules/32-ai-platform/prompts/store";

const ORG = "11111111-1111-4111-8111-111111111111";
const ACTOR = "22222222-2222-4222-8222-222222222222";
const PE = "33333333-3333-4333-8333-333333333333";
const MEMBERSHIP = "44444444-4444-4444-8444-444444444444";
const PATIENT = "55555555-5555-4555-8555-555555555555";
const NOW = new Date("2026-08-04T03:00:00.000Z");

/** The eleven seam names M32 publishes under its own contracts, plus the two it registers over M19's. */
const M32_PUBLISHED = [
  "NarrativeEnhancementProvider",
  "DocLensClassifier",
  "DocLensExtractor",
  "DocLensVisionVerifier",
  "DocLensSudDetector",
  "BereavementRiskNarrativeProvider",
  "DenialOutcomePredictionProvider",
  "EmbeddingsProvider",
  "SemanticSearchProvider",
  "CopilotProvider",
  "AIPromptRegistry",
] as const;

/** The ten that must answer with a VALUE. `AIPromptRegistry` is deliberately absent — it throws. */
const M32_INFERENCE_SEAMS = M32_PUBLISHED.filter((n) => n !== "AIPromptRegistry");

/** A pipeline that records what it was asked and answers whatever the test tells it to. */
function fakePipeline(outcome: AiInvocationOutcome): AiInvocationPipeline & {
  calls: AiInvokeRequest[];
} {
  const calls: AiInvokeRequest[] = [];
  return {
    calls,
    async invoke(request) {
      calls.push(request);
      return outcome;
    },
    async recordHitlOutcome() {},
  };
}

/** The refusal the real pipeline answers with while `ai.full` is off — gate 0, no ledger row. */
const FLAG_OFF: AiInvocationOutcome = {
  available: false,
  unavailable: { status: "capability_unavailable", reason: "phase_1_capability_shell" },
  detail: "the 'ai.full' feature flag is off; WardenX dispatches no AI in Phase 1",
  gate: "ai_full_flag",
  invocationId: null,
  ledgerRecorded: false,
};

/** A completed invocation — the Phase-2 shape, used to prove the projector gate. */
const COMPLETED: AiInvocationOutcome = {
  available: true,
  invocationId: "inv-1",
  invokedAt: NOW.toISOString(),
  route: {
    backendKey: "anthropic-claude-opus-4-7",
    reason: "capability_default",
    isFallback: false,
  } as AiInvocationOutcome extends { available: true; route: infer R } ? R : never,
  output: {
    text: "polished narrative",
    modelVersionPin: "claude-opus-4-7-20260101",
    inputTokens: 120,
    outputTokens: 80,
  },
  tokenCapState: { state: "under_soft_cap" } as never,
  softCapCrossed: false,
};

/** A resolver that DOES answer — the Phase-2 binding, faked. */
const boundActors = {
  resolve: async () => ({
    actorMembershipId: MEMBERSHIP,
    actorRole: "clinical_rn",
    providerEntityId: PE,
    locationId: null,
  }),
};

function narrative(
  pipeline: AiInvocationPipeline,
  extra: Parameters<typeof createNarrativeEnhancementProvider>[0] extends infer D
    ? Partial<D>
    : never = {},
): NarrativeEnhancementProvider {
  return createNarrativeEnhancementProvider({ pipeline, now: () => NOW, ...extra });
}

afterEach(() => {
  __resetSeamsForTest();
  vi.restoreAllMocks();
});

describe("M32-T06 — REQUIRED_SEAMS declares M32's §4.2 surface", () => {
  it("declares all eleven, owned by M32", () => {
    for (const key of M32_PUBLISHED) {
      const entry = REQUIRED_SEAMS.find((r) => r.key === key);
      expect(entry, `${key} must be a REQUIRED_SEAMS entry`).toBeDefined();
      expect(entry?.ownerModule).toBe(32);
      expect(entry?.denyStub).toBeDefined();
    }
  });

  it("keeps M19's two ADVISORY seams owned by M32 and NOT re-declared under a second name", () => {
    // M19-T01 leaf-typed both; M32 registers over them. A second M32-owned name for the same contract
    // would be a permanently unbound seam (the M15/M17 VolunteerComplianceProvider lesson).
    for (const key of ["ProtocolSuggestionProvider", "HospitalizationRiskProvider"] as const) {
      const entries = REQUIRED_SEAMS.filter((r) => r.key === key);
      expect(entries).toHaveLength(1);
      expect(entries[0]?.ownerModule).toBe(32);
    }
  });

  it("marks every patient-touching AI seam phi:true and the prompt registry phi:false", () => {
    for (const key of M32_INFERENCE_SEAMS) {
      expect(REQUIRED_SEAMS.find((r) => r.key === key)?.phi, `${key} crosses PHI to a vendor`).toBe(
        true,
      );
    }
    // §3.2.5 is platform-shared reference data with a platform-floor "no PHI in template" invariant (D3).
    expect(REQUIRED_SEAMS.find((r) => r.key === "AIPromptRegistry")?.phi).toBe(false);
  });
});

describe("M32-T06 — the deny-stubs, and the one that behaves the opposite way", () => {
  it("makes the ten inference seams REFUSE with a value, never throw", async () => {
    validateSeams();
    for (const key of M32_INFERENCE_SEAMS) {
      const seam = getSeam(key) as Record<string, (...a: unknown[]) => Promise<unknown>>;
      // The proxy answers on any method name, so the contract's own verb is what a consumer would call.
      const answer = (await seam.enhance({})) as {
        available: boolean;
        unavailable: { reason: string };
      };
      expect(answer.available, `${key} must answer, not throw`).toBe(false);
      expect(answer.unavailable.reason).toBe("provider_unregistered");
    }
  });

  it("makes AIPromptRegistry THROW, because [] would read as 'no contraband found'", () => {
    validateSeams();
    const registry = getSeam("AIPromptRegistry") as AIPromptRegistry;
    // SYNCHRONOUSLY, not as a rejected promise — `denyingSeamProxy` throws out of the call itself. A
    // `.rejects.toThrow()` here would false-FAIL rather than pass (the M20-T01 finding), and the
    // consumer-side consequence is the important half: `await registry.x()` inside a try/catch still
    // catches it, but a bare `.catch()` chain does not.
    expect(() => registry.getActivePromptsTargeting("medication_")).toThrow(/AIPromptRegistry/);
  });

  it("separates 'M32 was never wired' from 'M32 is wired and Phase-1 off'", async () => {
    validateSeams();
    const unwired = (await (
      getSeam("NarrativeEnhancementProvider") as NarrativeEnhancementProvider
    ).enhance({} as never)) as { unavailable: { reason: string } };
    expect(unwired.unavailable.reason).toBe("provider_unregistered");

    const wired = await narrative(fakePipeline(FLAG_OFF), { actors: boundActors }).enhance({
      organizationId: ORG,
      actorUserId: ACTOR,
      surface: "encounter_note",
      draftText: "draft",
      chartContext: {},
      parentEntityType: "encounter",
      parentEntityId: "enc-1",
      patientId: PATIENT,
    });
    expect(wired.available).toBe(false);
    if (wired.available) return;
    expect(wired.unavailable.reason).toBe("phase_1_capability_shell");
  });
});

describe("M32-T06 — registerAiPlatformSeams (§4.4 steps 4–5)", () => {
  const promptRegistry = {
    getActivePromptsTargeting: async () => [],
    getActivePromptsWithOutputType: async () => [],
    getActivePromptForCapability: async () => null,
    enumerateAllActive: async () => [],
  } satisfies AIPromptRegistry;

  it("registers NOTHING with neither a pipeline nor a registry", () => {
    registerAiPlatformSeams({});
    expect(() => getSeam("NarrativeEnhancementProvider")).toThrow(/before registration/);
    expect(() => getSeam("AIPromptRegistry")).toThrow(/before registration/);
  });

  it("registers the prompt registry INDEPENDENTLY of the pipeline", async () => {
    // The asymmetry that matters: six other modules boot on this query, and its deny-stub throws. It
    // must not be held hostage by an unwired AI pipeline.
    registerAiPlatformSeams({ promptRegistry });
    await expect(
      (getSeam("AIPromptRegistry") as AIPromptRegistry).getActivePromptsTargeting("evv_"),
    ).resolves.toEqual([]);
    expect(() => getSeam("NarrativeEnhancementProvider")).toThrow(/before registration/);
  });

  it("registers all twelve seam names when a pipeline is supplied", () => {
    registerAiPlatformSeams({ pipeline: fakePipeline(FLAG_OFF), promptRegistry });
    for (const key of M32_PUBLISHED) expect(() => getSeam(key)).not.toThrow();
    expect(() => getSeam("ProtocolSuggestionProvider")).not.toThrow();
    expect(() => getSeam("HospitalizationRiskProvider")).not.toThrow();
  });
});

describe("M32-T06 — §4.2.1 surface → capability resolution", () => {
  const input = {
    organizationId: ORG,
    actorUserId: ACTOR,
    draftText: "draft",
    chartContext: {},
    parentEntityId: "x-1",
  } as const;

  it("routes encounter_note to hearthnote_layer2 and idg_summary to idg_layer2_polish", async () => {
    const pipeline = fakePipeline(FLAG_OFF);
    const seam = narrative(pipeline, { actors: boundActors });
    await seam.enhance({ ...input, surface: "encounter_note", parentEntityType: "encounter" });
    await seam.enhance({ ...input, surface: "idg_summary", parentEntityType: "idg_session" });
    expect(pipeline.calls.map((c) => c.capabilityKey)).toEqual([
      "hearthnote_layer2",
      "idg_layer2_polish",
    ]);
    // `consumer_context_ref.module` is the CONSUMER's id, never M32's own (§3.2.8).
    expect(pipeline.calls.map((c) => c.consumerContextRef.module)).toEqual(["m8", "m14"]);
  });

  it("refuses discipline_plan_goal_rationale WITHOUT reaching the pipeline", async () => {
    // §2.4 registers no capability for M15's surface. Inventing a key would have made a dead registry
    // row; routing it to hearthnote_layer2 would put it under another capability's kill switch.
    const pipeline = fakePipeline(FLAG_OFF);
    const result = await narrative(pipeline, { actors: boundActors }).enhance({
      ...input,
      surface: "discipline_plan_goal_rationale",
      parentEntityType: "discipline_care_plan",
    });
    expect(result.available).toBe(false);
    if (result.available) return;
    expect(result.unavailable.reason).toBe("provider_unregistered");
    expect(result.detail).toMatch(/discipline_plan_goal_rationale/);
    expect(pipeline.calls).toHaveLength(0);
  });

  it("refuses when no actor resolver is bound, rather than guessing a provider entity", async () => {
    // ARCH-011: `ai_invocation.provider_entity_id` is NOT NULL because a §164.528 accounting has to name
    // WHICH certified provider entity disclosed the PHI.
    const pipeline = fakePipeline(FLAG_OFF);
    const result = await narrative(pipeline).enhance({
      ...input,
      surface: "encounter_note",
      parentEntityType: "encounter",
    });
    expect(result.available).toBe(false);
    if (result.available) return;
    expect(result.detail).toMatch(/provider entity/);
    expect(pipeline.calls).toHaveLength(0);
  });

  it("passes the resolved provider entity and the patient id through to the ledger request", async () => {
    const pipeline = fakePipeline(FLAG_OFF);
    await narrative(pipeline, { actors: boundActors }).enhance({
      ...input,
      surface: "encounter_note",
      parentEntityType: "encounter",
      patientId: PATIENT,
    });
    expect(pipeline.calls[0]?.providerEntityId).toBe(PE);
    expect(pipeline.calls[0]?.actorMembershipId).toBe(MEMBERSHIP);
    expect(pipeline.calls[0]?.patientId).toBe(PATIENT);
    expect(pipeline.calls[0]?.invokedAt).toBe(NOW.toISOString());
  });
});

describe("M32-T06 — a COMPLETED invocation with no §2.5 output projector", () => {
  it("refuses with output_validation_failed_after_retry rather than inventing a payload", async () => {
    const result = await narrative(fakePipeline(COMPLETED), { actors: boundActors }).enhance({
      organizationId: ORG,
      actorUserId: ACTOR,
      surface: "encounter_note",
      draftText: "draft",
      chartContext: {},
      parentEntityType: "encounter",
      parentEntityId: "enc-1",
    });
    expect(result.available).toBe(false);
    if (result.available) return;
    expect(result.unavailable.reason).toBe("output_validation_failed_after_retry");
  });

  it("answers available once a projector is bound", async () => {
    const result = await narrative(fakePipeline(COMPLETED), {
      actors: boundActors,
      projector: {
        project: (_seam, output) => ({
          text: output.text,
          confidence: 0.9,
          warnings: [],
          modelVersionPin: output.modelVersionPin,
        }),
      },
    }).enhance({
      organizationId: ORG,
      actorUserId: ACTOR,
      surface: "encounter_note",
      draftText: "draft",
      chartContext: {},
      parentEntityType: "encounter",
      parentEntityId: "enc-1",
    });
    expect(result.available).toBe(true);
    if (!result.available) return;
    expect(result.invocationId).toBe("inv-1");
    expect(result.enhanced.text).toBe("polished narrative");
  });

  it("applies the same projector gate to a DocLens arm", async () => {
    const result = await createDocLensClassifier({
      pipeline: fakePipeline(COMPLETED),
      actors: boundActors,
      now: () => NOW,
    }).classify({
      organizationId: ORG,
      actorUserId: ACTOR,
      documentId: "doc-1",
      extractedText: "text",
      pageCount: 3,
    });
    expect(result.available).toBe(false);
    if (result.available) return;
    expect(result.unavailable.reason).toBe("output_validation_failed_after_retry");
  });
});

describe("M32-T06 — §4.2.3, on M19's own leaf-typed contracts", () => {
  it("answers `unavailable` as a VALUE on both advisories", async () => {
    const deps = { pipeline: fakePipeline(FLAG_OFF), actors: boundActors };
    const protocol = await createProtocolSuggestionProvider(deps).suggestProtocol(ORG as OrgId, {
      triageCallId: "call-1" as never,
      patientId: PATIENT as PatientId,
      chiefComplaintText: "shortness of breath",
      candidateProtocolKeys: ["dyspnea"],
    });
    expect(protocol).toEqual({ kind: "unavailable", reason: "provider_unregistered" });

    const risk = await createHospitalizationRiskProvider(deps).hospitalizationRiskForPatient(
      ORG as OrgId,
      PATIENT as PatientId,
      NOW.toISOString() as IsoInstant,
    );
    expect(risk).toEqual({ kind: "unavailable", reason: "provider_unregistered" });
  });
});

describe("M32-T06 — D18's prohibited-zone registry", () => {
  const template = (target: string): ActivePromptSummary => ({
    capabilityKey: "cap",
    promptTemplateId: "tpl-1",
    templateKey: "k",
    version: 1,
    outputEntityTargetPrefix: target,
    outputTypePrefix: "narrative_text",
    gitArtifactPath: "packages/prompts/templates/cap/v1.txt",
    contentHash: "a".repeat(64),
    approvedAt: null,
  });

  it("declares all seven D18 zones", () => {
    expect(AI_PROHIBITED_ZONES.map((z) => z.module)).toEqual([
      "m12",
      "m13",
      "m18",
      "m21",
      "m27",
      "m28",
      "m37",
    ]);
  });

  it("matches template-target-startsWith-zone-prefix and NOT the inverse", () => {
    // The direction is the whole check. The inverse reads false on real contraband and fails OPEN.
    expect(aiPromptTargetsPrefix("medication_order", "medication_")).toBe(true);
    expect(aiPromptTargetsPrefix("medication_", "medication_order")).toBe(false);
    expect(aiPromptTargetsPrefix("patient_demographics", "medication_")).toBe(false);
  });

  it("catches a template targeting M12's zone and names the decision", () => {
    const found = findAiProhibitedZoneViolations([template("medication_order")]);
    expect(found).toHaveLength(1);
    expect(found[0]?.zoneModule).toBe("m12");
    expect(found[0]?.zoneDecision).toBe("M12 D12");
  });

  it("passes a template targeting a legitimate zone-adjacent prefix", () => {
    // `encounter_narrative` is §3.2.5's own example and belongs to nobody's prohibited zone.
    expect(findAiProhibitedZoneViolations([template("encounter_narrative")])).toHaveLength(0);
    expect(aiTargetPrefixIsProhibited("encounter_narrative")).toBeNull();
    expect(aiTargetPrefixIsProhibited("cost_report_worksheet_a")?.module).toBe("m27");
  });
});

describe("M32-T06 — §4.4 step-6 boot validators", () => {
  const capability = (over: Record<string, unknown> = {}) => ({
    id: "cap-1",
    capabilityKey: "hearthnote_layer2",
    displayName: "HearthNote Layer 2",
    riskTier: "high" as const,
    lifecycleState: "APPROVED" as const,
    defaultBackendKey: "anthropic-claude-opus-4-7",
    allowedBackendKeys: ["anthropic-claude-opus-4-7"],
    tenantOptInRequired: true,
    clinicianOptOutSupported: true,
    currentPromptTemplateKey: null,
    firstApprovedAt: null,
    lastReapprovedAt: null,
    nextReapprovalDueAt: null,
    ...over,
  });

  const backendRow = {
    backendKey: "anthropic-claude-opus-4-7",
    kind: "cloud" as const,
    supportedModalities: ["text"] as const,
    isActive: true,
  };

  function validators(opts: {
    capabilities?: ReturnType<typeof capability>[];
    backends?: unknown[];
    prompts?: ActivePromptSummary[];
    registryActive?: ActivePromptSummary[];
    backendKinds?: Record<string, "cloud" | "local">;
  }) {
    const gov = createInMemoryAiGovernanceStores({
      capabilities: (opts.capabilities ?? [capability()]) as never,
      backendKinds: (opts.backendKinds ?? {
        "anthropic-claude-opus-4-7": "cloud",
      }) as never,
    });
    const inv = createInMemoryAiInvocationStores({
      backends: (opts.backends ?? [backendRow]) as never,
    });
    const promptStore = createInMemoryAiPromptTemplateStore([]);
    const registryActive = opts.registryActive ?? [];
    const promptRegistry: AIPromptRegistry = {
      getActivePromptsTargeting: async (p) =>
        registryActive.filter((t) => t.outputEntityTargetPrefix.startsWith(p)),
      getActivePromptsWithOutputType: async () => [],
      getActivePromptForCapability: async () => null,
      enumerateAllActive: async () => registryActive,
    };
    return {
      gov,
      validators: createAiBootValidators({
        capabilities: gov.registry,
        backends: inv.backends,
        prompts: promptStore,
        promptRegistry,
      }),
    };
  }

  it("passes when every referenced backend has a row", async () => {
    await expect(
      validators({}).validators.validateAllCapabilitiesHaveBackend(),
    ).resolves.toBeUndefined();
  });

  it("fails when a capability defaults to a backend with no ai_model_backend row", async () => {
    await expect(
      validators({ backends: [] }).validators.validateAllCapabilitiesHaveBackend(),
    ).rejects.toThrow(AiBootValidationError);
  });

  it("exempts the service-routed prediction family, and only it", async () => {
    // §2.4 routes these to the local-ml-worker; they legitimately have no ai_model_backend row.
    await expect(
      validators({
        capabilities: [
          capability({
            id: "cap-2",
            capabilityKey: "hospitalization_risk_30d",
            defaultBackendKey: "",
            allowedBackendKeys: [],
            lifecycleState: "DESIGN_REVIEW",
          }),
        ],
        backends: [],
      }).validators.validateAllCapabilitiesHaveBackend(),
    ).resolves.toBeUndefined();

    await expect(
      validators({
        capabilities: [capability({ defaultBackendKey: "", allowedBackendKeys: [] })],
        backends: [],
      }).validators.validateAllCapabilitiesHaveBackend(),
    ).rejects.toThrow(/not service-routed/);
  });

  it("fails an APPROVED capability with no current calibration row (D12)", async () => {
    await expect(
      validators({}).validators.validateNoApprovedCapabilityWithoutCalibration(),
    ).rejects.toThrow(/no current ai_capability_calibration row/);
  });

  it("passes a capability below APPROVED without a calibration", async () => {
    await expect(
      validators({
        capabilities: [capability({ lifecycleState: "DESIGN_REVIEW" })],
      }).validators.validateNoApprovedCapabilityWithoutCalibration(),
    ).resolves.toBeUndefined();
  });

  it("fails boot on a contraband prompt template, naming the zone", async () => {
    const contraband: ActivePromptSummary = {
      capabilityKey: "hearthnote_layer2",
      promptTemplateId: "tpl-9",
      templateKey: "contraband",
      version: 2,
      outputEntityTargetPrefix: "evv_event",
      outputTypePrefix: "structured_extraction",
      gitArtifactPath: "packages/prompts/templates/x/v2.txt",
      contentHash: "b".repeat(64),
      approvedAt: null,
    };
    await expect(
      validators({ registryActive: [contraband] }).validators.validateAiProhibitedZoneRegistry(),
    ).rejects.toThrow(/AI_PROHIBITED_ZONE_VIOLATION.*m18/s);
  });

  it("passes the prohibited-zone check when nothing is active", async () => {
    await expect(
      validators({}).validators.validateAiProhibitedZoneRegistry(),
    ).resolves.toBeUndefined();
  });

  it("refuses when active templates exist but no artifact reader is bound", async () => {
    const store = createInMemoryAiPromptTemplateStore([
      {
        id: "tpl-1",
        templateKey: "k",
        capabilityKey: "hearthnote_layer2",
        version: 1,
        templateFilesystemRef: "packages/prompts/templates/hearthnote_layer2/v1.txt",
        templateContentHash: "c".repeat(64),
        status: "active",
        approvedByMembershipId: null,
        approvedAt: null,
        clinicalReviewerAttestation: null,
        outputEntityTargetPrefix: "encounter_narrative",
        outputTypePrefix: "narrative_text",
        compatibleBackendKeys: [],
        inputSchemaRef: "in",
        outputSchemaRef: "out",
        createdAt: NOW.toISOString(),
      } as never,
    ]);
    const gov = createInMemoryAiGovernanceStores({});
    const inv = createInMemoryAiInvocationStores({});
    const v = createAiBootValidators({
      capabilities: gov.registry,
      backends: inv.backends,
      prompts: store,
      promptRegistry: {
        getActivePromptsTargeting: async () => [],
        getActivePromptsWithOutputType: async () => [],
        getActivePromptForCapability: async () => null,
        enumerateAllActive: async () => [],
      },
    });
    // "we could not open the file" lands on the same side of the line as "the file did not match".
    await expect(v.validateAllActivePromptsResolveToGitArtifacts()).rejects.toThrow(
      /no artifact reader is bound/,
    );
  });
});
