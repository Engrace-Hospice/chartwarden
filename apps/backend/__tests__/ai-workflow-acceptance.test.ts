// Module 32 — the §7 workflow acceptance criteria W1–W10, walked end to end (M32-T08).
//
// §7's own framing is the reason this file exists separately from the six M32 suites that precede it:
// "a workflow passes only when every post-condition is observable; if any is missing the spec is
// considered un-locked". The other suites prove RULES — the gate order, the FSM edges, the cap
// arithmetic, the seam refusals. Each is scoped to one layer and each mocks the layers around it. A
// workflow is a SEQUENCE ACROSS those layers, and every one of the four defects a sequence can carry is
// invisible to a per-layer test:
//
//   · a kill switch that writes a perfectly correct row the invocation gate never reads (W3.7),
//   · a triage decision whose follow-up plan is computed and then executed against a different store
//     than the one the pipeline's gate consults (W5.8),
//   · an opt-in the governance service records and the SDK gate cannot see (W4.4),
//   · a prompt activation that deprecates the incumbent while the registry keeps serving it (W6.8).
//
// SO THE HARNESS BUILDS ONE COMPOSITION, NOT FOUR MOCKS. `platform()` wires the governance stores, the
// invocation stores, the safety stores and the prompt store into a single object graph — the same graph
// `wiring.ts` assembles at boot, with in-memory stores in place of Drizzle ones — and the capability
// store the pipeline reads is an ADAPTER OVER THE GOVERNANCE REGISTRY, not a frozen row. That one choice
// is what makes W5's "capability demoted ⇒ subsequent invocations blocked" a real assertion rather than
// a restatement of the fixture.
//
// ── THE FLAG IS ON IN THIS FILE, AND THAT IS THE POINT OF IT ─────────────────────────────────────────
//
// `ai.full` is OFF for the whole wave, so in production every workflow below terminates at gate 0 with
// `phase_1_capability_shell`. `ai-invocation-pipeline.test.ts` pins that. Pinning it AGAIN here would
// make this file prove that Phase 1 refuses — which is true and is not what §7 asks. These tests turn
// the flag ON so the workflows behind it are exercised now, while the code is being written, rather than
// on the day somebody flips the flag in production and finds out which of the ten never worked. The one
// exception is W9, whose whole subject is a refusal.
//
// ── TWO WORKFLOWS ARE PARTIAL, AND BOTH SAY SO IN THEIR OWN DESCRIBE ────────────────────────────────
//
// W7 (drift detection) and W10 (prohibited-zone boot failure) cannot be walked whole in Phase 1. W7's
// §7 text depends on an `ai_drift_event` table that is not in M32's thirteen `ownedTables` and on a
// `ai:drift-sweeps` worker no task in this wave builds; W10's failure happens inside M12's boot, which
// this suite cannot start. Each describe walks the half that exists and asserts the boundary of the half
// that does not — an absent table is a fact worth a failing test the day somebody adds it.

import { describe, expect, it, vi } from "vitest";

import {
  type ModelBackend,
  aiTokenBudgetFor,
  createModelBackendRegistry,
} from "@wardenx/ai-platform";
import { MODULES } from "../../../architecture/module-manifest";

import {
  M32_ALERT_TYPES,
  M32_OUTBOX_EVENTS,
  activateAiKillSwitch,
  activateAiPromptTemplate,
  buildAiPlatformAbacPredicates,
  createAiBootValidators,
  createAiInvocationPipeline,
  createAiKillSwitchGate,
  createAiPromptRegistry,
  createDocLensExtractor,
  createInMemoryAiGovernanceStores,
  createInMemoryAiInvocationStores,
  createInMemoryAiPromptTemplateStore,
  createInMemoryAiSafetyStores,
  deactivateAiKillSwitch,
  emitAiAlert,
  executeAiHallucinationFollowUp,
  fileAiHallucinationReport,
  isAiAlertSuppressible,
  publishAiCapabilityCalibration,
  queueAiEvaluationRun,
  recordAiClinicianOptOut,
  recordAiTenantOptIn,
  transitionAiCapability,
  transitionAiEvaluationRun,
  triageAiHallucinationReport,
} from "../src/modules/32-ai-platform/index";
import type {
  AiAlertPort,
  AiCapabilityGovernanceRow,
  AiGovernanceServiceDeps,
  AiInvocationCapabilityRow,
  AiPayloadCipher,
  AiPlatformAbacResolver,
  AiPromptTemplateRowProjection,
  AiSafetyServiceDeps,
  AiSeamActorResolver,
  AiTenantOptInRow,
} from "../src/modules/32-ai-platform/index";

const ORG = "11111111-1111-4111-8111-111111111111";
const OTHER_ORG = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CAP_ID = "cap-hearthnote";
const DOCLENS_CAP_ID = "cap-doclens-extract";
const NURSE = "33333333-3333-4333-8333-333333333333";
const ADMIN = "44444444-4444-4444-8444-444444444444";
const SAFETY_OWNER = "55555555-5555-4555-8555-555555555555";
const PROVIDER_ENTITY = "66666666-6666-4666-8666-666666666666";
const PATIENT = "77777777-7777-4777-8777-777777777777";
const T0 = "2026-08-15T12:00:00.000Z";
const HASH_V1 = "1".repeat(64);
const HASH_V2 = "2".repeat(64);

const CLOUD_KEY = "anthropic-claude-opus-4-7";
const LOCAL_KEY = "local-llama-3.1-8b-instruct";

const HEARTHNOTE: AiCapabilityGovernanceRow = {
  id: CAP_ID,
  capabilityKey: "hearthnote_layer2",
  displayName: "HearthNote Layer 2 Narrative Enhancement",
  riskTier: "high",
  lifecycleState: "APPROVED",
  defaultBackendKey: CLOUD_KEY,
  allowedBackendKeys: [CLOUD_KEY, LOCAL_KEY],
  tenantOptInRequired: true,
  clinicianOptOutSupported: true,
  currentPromptTemplateKey: "hearthnote_enhancement_v1",
  firstApprovedAt: "2026-06-01T00:00:00.000Z",
  lastReapprovedAt: null,
  nextReapprovalDueAt: "2027-06-01T00:00:00.000Z",
};

/** W9's subject: a capability §2.4 registers but §2.2 has not promoted past DESIGN_REVIEW. */
const DOCLENS_EXTRACT: AiCapabilityGovernanceRow = {
  ...HEARTHNOTE,
  id: DOCLENS_CAP_ID,
  capabilityKey: "doclens_extract",
  displayName: "DocLens Structured Extraction",
  riskTier: "medium",
  lifecycleState: "DESIGN_REVIEW",
  currentPromptTemplateKey: null,
  firstApprovedAt: null,
  nextReapprovalDueAt: null,
};

/**
 * The routing columns `AiCapabilityGovernanceRow` does not carry.
 *
 * The governance projection is deliberately narrower than the invocation one (`service.ts`'s own note:
 * "the routing columns a governance gate has no business seeing"), so the composition root supplies
 * them. Keeping them constant here is what makes the ADAPTER below a lifecycle mirror and nothing else.
 */
const ROUTING_COLUMNS = {
  fallbackChainKeys: [LOCAL_KEY],
  tenantOverrideAllowed: true,
  requiredModality: null,
} as const;

const CLOUD_BACKEND = {
  backendId: "88888888-8888-4888-8888-888888888888",
  backendKey: CLOUD_KEY,
  kind: "cloud",
  isActive: true,
  lastHealthStatus: "healthy",
  zdrStatus: "enabled",
  modelVersionPin: "claude-opus-4-7-20260601",
  supportedModalities: ["text"],
} as const;

const LOCAL_BACKEND = {
  backendId: "99999999-9999-4999-8999-999999999999",
  backendKey: LOCAL_KEY,
  kind: "local",
  isActive: true,
  lastHealthStatus: "healthy",
  zdrStatus: "not_applicable",
  modelVersionPin: "llama-3.1-8b-instruct-q6",
  supportedModalities: ["text"],
} as const;

const CIPHER: AiPayloadCipher = {
  encrypt: async (organizationId, plaintext) =>
    Buffer.from(`enc:${organizationId}:${plaintext}`, "utf8"),
};

function activeOptIn(overrides: Partial<AiTenantOptInRow> = {}): AiTenantOptInRow {
  return {
    id: "optin-seed",
    organizationId: ORG,
    capabilityId: CAP_ID,
    status: "active",
    orgAdminMembershipId: ADMIN,
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

function template(
  overrides: Partial<AiPromptTemplateRowProjection> = {},
): AiPromptTemplateRowProjection {
  return {
    id: "apt-v1",
    templateKey: "hearthnote_enhancement_v1",
    capabilityKey: "hearthnote_layer2",
    version: 1,
    templateFilesystemRef: "packages/prompts/templates/hearthnote_layer2/v1.md",
    templateContentHash: HASH_V1,
    status: "active",
    approvedByMembershipId: SAFETY_OWNER,
    approvedAt: "2026-06-01T00:00:00.000Z",
    clinicalReviewerAttestation: "Reviewed against the golden set.",
    compatibleBackendKeys: [CLOUD_KEY, LOCAL_KEY],
    inputSchemaRef: "hearthnote_layer2.input.v1",
    outputSchemaRef: "hearthnote_layer2.output.v1",
    outputEntityTargetPrefix: "encounter_narrative",
    outputTypePrefix: "narrative_text",
    createdByMembershipId: SAFETY_OWNER,
    createdAt: "2026-06-01T00:00:00.000Z",
    ...overrides,
  };
}

interface PlatformOptions {
  readonly capabilities?: readonly AiCapabilityGovernanceRow[];
  readonly optIns?: readonly AiTenantOptInRow[];
  readonly seededSpendTokens?: number;
  readonly hardCapTokens?: number;
  readonly templates?: readonly AiPromptTemplateRowProjection[];
  readonly localHealthy?: boolean;
  readonly artifacts?: Record<string, { body: string; contentHash: string }>;
}

/**
 * One M32 composition over in-memory stores — the graph `wiring.ts` builds at boot.
 *
 * The three couplings this exists to make real, and which every per-layer suite has to fake:
 *   1. `capabilities.findByKey` reads THROUGH the governance registry, so a lifecycle demotion changes
 *      what the invocation gate sees.
 *   2. the pipeline's `killSwitch` is `createAiKillSwitchGate` over the SAME safety store the R7 route
 *      writes, so an activation is visible to the next invoke with no cache to prime.
 *   3. the consent store is shared, so an opt-in recorded through the governance service is the row the
 *      SDK's consent gate reads.
 */
function platform(options: PlatformOptions = {}) {
  const governance = createInMemoryAiGovernanceStores({
    capabilities: [...(options.capabilities ?? [HEARTHNOTE])],
    backendKinds: { [CLOUD_KEY]: "cloud", [LOCAL_KEY]: "local" },
    optIns: options.optIns ?? [activeOptIn()],
  });
  const invocation = createInMemoryAiInvocationStores({
    backends: [
      CLOUD_BACKEND,
      {
        ...LOCAL_BACKEND,
        lastHealthStatus: options.localHealthy === false ? "unhealthy" : "healthy",
      },
    ],
    accruals:
      options.seededSpendTokens === undefined
        ? []
        : [
            {
              id: "seed-accrual",
              organizationId: ORG,
              capabilityId: CAP_ID,
              backendId: CLOUD_BACKEND.backendId,
              vendorRateAtInvocation: null,
              inputTokens: options.seededSpendTokens,
              outputTokens: 0,
              cloudCostUsd: null,
              localComputeAttribution: null,
              accruedAt: T0,
            },
          ],
  });
  const safety = createInMemoryAiSafetyStores();
  const prompts = createInMemoryAiPromptTemplateStore(options.templates ?? [template()]);
  const artifacts = {
    read: async (ref: string) => options.artifacts?.[ref] ?? null,
  };
  const promptRegistry = createAiPromptRegistry({ store: prompts, artifacts });

  const cloudComplete = vi.fn(async () => ({
    text: "Mrs. K tolerated the visit well and reported her pain as better controlled.",
    inputTokens: 120,
    outputTokens: 45,
    modelVersionPin: CLOUD_BACKEND.modelVersionPin,
  }));
  const localComplete = vi.fn(async () => ({
    text: "Visit tolerated; pain better controlled.",
    inputTokens: 100,
    outputTokens: 30,
    modelVersionPin: LOCAL_BACKEND.modelVersionPin,
  }));

  const backend = (
    key: string,
    kind: "cloud" | "local",
    complete: ModelBackend["complete"],
  ): ModelBackend => ({
    backendKey: key,
    kind,
    capabilities: () => ({
      backendKey: key,
      kind,
      modelVersionPin:
        key === CLOUD_KEY ? CLOUD_BACKEND.modelVersionPin : LOCAL_BACKEND.modelVersionPin,
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
  });

  const governanceDeps: AiGovernanceServiceDeps & typeof governance = {
    ...governance,
    evidence: {
      resolve: async () => ({
        baaResolved: true,
        baaExpiresAt: "2027-06-01T00:00:00.000Z",
        zdrContractOnRecord: true,
        clinicalReviewerHasSafetyLeadRole: true,
      }),
    },
    now: () => T0,
  };

  const safetyDeps: AiSafetyServiceDeps = {
    killSwitches: safety.killSwitches,
    reports: safety.reports,
    evaluations: safety.evaluations,
    registry: governance.registry,
    now: () => T0,
  };

  const pipeline = createAiInvocationPipeline({
    // Coupling 1 — the lifecycle mirror. See the function header.
    capabilities: {
      findByKey: async (capabilityKey): Promise<AiInvocationCapabilityRow | null> => {
        const row = await governance.registry.findCapabilityByKey(capabilityKey);
        return row === null
          ? null
          : {
              id: row.id,
              capabilityKey: row.capabilityKey,
              lifecycleState: row.lifecycleState,
              defaultBackendKey: row.defaultBackendKey,
              allowedBackendKeys: row.allowedBackendKeys,
              tenantOptInRequired: row.tenantOptInRequired,
              currentPromptTemplateKey: row.currentPromptTemplateKey,
              ...ROUTING_COLUMNS,
            };
      },
    },
    consent: governance.consent,
    backends: invocation.backends,
    overrides: invocation.overrides,
    ledger: invocation.ledger,
    flags: { readFlags: async () => ({ "ai.full": true }) },
    cipher: CIPHER,
    // Coupling 2 — the live gate over the safety store.
    killSwitch: createAiKillSwitchGate(safety.killSwitches),
    modelBackends: createModelBackendRegistry([
      backend(CLOUD_KEY, "cloud", cloudComplete),
      backend(LOCAL_KEY, "local", localComplete),
    ]),
    tokenBudget: { budgetFor: async () => aiTokenBudgetFor(options.hardCapTokens ?? 10_000) },
    // §8.3's schemas do not exist in Phase 1; the acceptance walk supplies a permitting validator so the
    // workflows past the PHI gate are reachable. `ai-platform-stride.test.ts` owns the deny-by-default.
    chartContext: { validate: () => ({ permitted: true, detail: "" }) },
    now: () => new Date(T0),
  });

  const alerts: { eventType: string; organizationId: string | null }[] = [];
  const alertPort: AiAlertPort = {
    emit: async (input) => {
      alerts.push({ eventType: input.eventType, organizationId: input.organizationId });
    },
  };

  return {
    governance,
    governanceDeps,
    invocation,
    safety,
    safetyDeps,
    prompts,
    promptRegistry,
    pipeline,
    cloudComplete,
    localComplete,
    alerts,
    alertPort,
  };
}

/** The clinician's call, as M8's encounter screen makes it. */
function invokeAsNurse(p: ReturnType<typeof platform>, capabilityKey = "hearthnote_layer2") {
  return p.pipeline.invoke({
    capabilityKey,
    organizationId: ORG,
    providerEntityId: PROVIDER_ENTITY,
    actorMembershipId: NURSE,
    actorRole: "registered_nurse",
    patientId: PATIENT,
    consumerContextRef: { module: "m8", entityKind: "encounter", entityId: "enc-1" },
    prompt: { text: "pt tolerated visit well, pain better", templateVersion: "v1" },
    chartContext: { patientAgeYears: 78, lengthOfStayDays: 41 },
    invokedAt: T0,
  });
}

/** Every event name §4.11 publishes — the catalog a workflow's outbox post-condition resolves against. */
const OUTBOX_NAMES = M32_OUTBOX_EVENTS.map((e) => e.eventName);

// ── W1 ────────────────────────────────────────────────────────────────────────────────────────────

describe("W1 — HearthNote Layer 2 narrative enhancement, happy path (§7.W1)", () => {
  it("dispatches, records the disclosure, and lets M8 close the loop with the HITL outcome", async () => {
    const p = platform();
    const outcome = await invokeAsNurse(p);

    // W1.3/W1.4 — the default route is the cloud backend and its ZDR posture rides the row.
    expect(outcome.available).toBe(true);
    if (!outcome.available) return;
    expect(outcome.route.backendKey).toBe(CLOUD_KEY);
    expect(p.cloudComplete).toHaveBeenCalledTimes(1);
    expect(p.localComplete).not.toHaveBeenCalled();

    // W1.6 — ONE invocation row, with the provenance a §164.528 accounting reads.
    expect(p.invocation.invocationRows).toHaveLength(1);
    const row = p.invocation.invocationRows[0]!;
    expect(row).toMatchObject({
      status: "completed",
      organizationId: ORG,
      providerEntityId: PROVIDER_ENTITY,
      patientId: PATIENT,
      capabilityKey: "hearthnote_layer2",
      backendKey: CLOUD_KEY,
      modelVersionPin: CLOUD_BACKEND.modelVersionPin,
      zdrConfirmed: true,
      inputTokenCount: 120,
      outputTokenCount: 45,
      hitlOutcome: "pending",
    });
    // The three payloads reach the row ENCRYPTED — the plaintext prompt is nowhere in it.
    expect(row.promptPayloadCipher.toString("utf8")).toContain("enc:");
    expect(row.promptPayloadCipher.toString("utf8")).not.toBe(
      "pt tolerated visit well, pain better",
    );

    // W1.7 — one accrual, carrying the same two counts §3.5 freezes on the invocation.
    expect(p.invocation.accrualRows).toHaveLength(1);
    expect(p.invocation.accrualRows[0]).toMatchObject({ inputTokens: 120, outputTokens: 45 });

    // W1.9/W1.10 — M8 records the human's decision; §3.5's one permitted post-hoc write.
    await p.pipeline.recordHitlOutcome(ORG, outcome.invocationId, outcome.invokedAt, "edited");
    expect(p.invocation.invocationRows[0]!.hitlOutcome).toBe("edited");
    // …and it moved NOTHING else: the frozen provenance is byte-identical to what was written.
    expect(p.invocation.invocationRows[0]).toMatchObject({
      inputTokenCount: 120,
      outputTokenCount: 45,
      zdrConfirmed: true,
      modelVersionPin: CLOUD_BACKEND.modelVersionPin,
    });

    // W1.11 — the two events the sequence publishes both exist in the §4.11 catalog. `m32.output.edited`
    // is its own event rather than a field on the invocation event (§4.11 decision 3).
    expect(OUTBOX_NAMES).toContain("m32.capability.invoked");
    expect(OUTBOX_NAMES).toContain("m32.output.edited");
    // A cloud route is a DISCLOSURE, and §4.11 decision 2 makes that a separate event M4's §164.528
    // sink subscribes to alone.
    expect(OUTBOX_NAMES).toContain("m32.phi.disclosed");
  });

  it("raises the soft-cap warning on the accrual that CROSSES it, not on every call after", async () => {
    // 7_900 spent against a 10_000 hard cap ⇒ 8_000 soft cap: this call's 165 tokens cross it.
    const p = platform({ seededSpendTokens: 7_900, hardCapTokens: 10_000 });
    const outcome = await invokeAsNurse(p);
    expect(outcome.available).toBe(true);
    if (!outcome.available) return;
    expect(outcome.softCapCrossed).toBe(true);

    await emitAiAlert(
      {
        alertType: "ai.token_soft_cap_warning",
        organizationId: ORG,
        capabilityId: CAP_ID,
        capabilityKey: "hearthnote_layer2",
        spentTokens: 8_065,
        softCap: 8_000,
        windowStart: "2026-08-01T00:00:00.000Z",
        windowEnd: "2026-09-01T00:00:00.000Z",
      },
      p.alertPort,
    );
    expect(p.alerts).toEqual([{ eventType: "ai.token_soft_cap_warning", organizationId: ORG }]);

    // The SECOND call is above the soft cap but crosses nothing — W1.7's alert is dated by the crossing.
    const second = await invokeAsNurse(p);
    expect(second.available).toBe(true);
    if (!second.available) return;
    expect(second.softCapCrossed).toBe(false);
  });
});

// ── W2 ────────────────────────────────────────────────────────────────────────────────────────────

describe("W2 — hard token cap reached, fallback engagement (§7.W2)", () => {
  // §7.W2's persona says "consumed 99% of their monthly hard cap". 99% does NOT breach it and must not:
  // `aiTokenCapStateFor` compares with `>=` because a cap is the figure spend may REACH, so the tenant at
  // 99% still gets their call. The breach is at the cap, which is what this suite seeds.
  it("refuses without dispatching, and still writes the row the accounting needs", async () => {
    const p = platform({ seededSpendTokens: 10_000, hardCapTokens: 10_000 });
    const outcome = await invokeAsNurse(p);

    // W2.2 — no Anthropic call and no Ollama call. Both spies, because "we fell back to local" is the
    // plausible-looking wrong behaviour a cap gate can have.
    expect(outcome.available).toBe(false);
    if (outcome.available) return;
    expect(outcome.unavailable.reason).toBe("token_hard_cap_reached");
    expect(outcome.gate).toBe("token_cap");
    expect(p.cloudComplete).not.toHaveBeenCalled();
    expect(p.localComplete).not.toHaveBeenCalled();

    // W2.4 — the refusal IS a row: "no PHI went to a vendor" is only provable in writing.
    expect(outcome.ledgerRecorded).toBe(true);
    const row = p.invocation.invocationRows[0]!;
    expect(row).toMatchObject({
      status: "capability_unavailable",
      errorClass: "token_hard_cap_reached",
      inputTokenCount: 0,
      outputTokenCount: 0,
      responsePayloadCipher: null,
      chartContextCipher: null,
    });
    expect(row.promptPayloadCipher.byteLength).toBe(0);

    // W2.4 again, the half a row-count assertion misses: a refused call spent nothing, so the SPEND
    // ledger gains nothing beyond the seeded month-to-date row. A zero accrual would be a measurement
    // nobody made.
    expect(p.invocation.accrualRows.map((a) => a.id)).toEqual(["seed-accrual"]);

    // W2.5 — the alert carries `fallbackEngaged: true` as a CLAIM about what M32 did.
    await emitAiAlert(
      {
        alertType: "ai.token_hard_cap_breached",
        organizationId: ORG,
        capabilityId: CAP_ID,
        capabilityKey: "hearthnote_layer2",
        spentTokens: 10_000,
        hardCap: 10_000,
        fallbackEngaged: true,
        windowStart: "2026-08-01T00:00:00.000Z",
        windowEnd: "2026-09-01T00:00:00.000Z",
      },
      p.alertPort,
    );
    expect(p.alerts.map((a) => a.eventType)).toEqual(["ai.token_hard_cap_breached"]);

    // W2.6 — no `completed` event. §4.11 spells the refusal as `m32.capability.invoked` carrying the
    // gate-blocked status rather than inventing a second event name (the enum has no `gate_blocked`).
    expect(OUTBOX_NAMES).toContain("m32.capability.invoked");
    expect(OUTBOX_NAMES.filter((n) => n.endsWith(".completed"))).toEqual([
      "m32.evaluation.completed",
    ]);
  });
});

// ── W3 ────────────────────────────────────────────────────────────────────────────────────────────

describe("W3 — kill switch activation, platform-wide SEV-1 (§7.W3)", () => {
  it("stops the capability for every tenant, plans the D16 demotion, and blocks the next invoke", async () => {
    const p = platform();

    // The capability serves before the switch — otherwise the assertion after it proves nothing.
    expect((await invokeAsNurse(p)).available).toBe(true);

    // W3.1 — `organization_id IS NULL` is the scope, and it comes from the request and nowhere else.
    const activation = await activateAiKillSwitch(p.safetyDeps, {
      organizationId: null,
      capabilityId: CAP_ID,
      reason: "sev1_hallucination",
      actorKind: "ai_safety_owner",
      actorMembershipId: SAFETY_OWNER,
      activationMessage: "fabricated dose observed in a signed note",
    });
    expect(activation.scope).toBe("platform");
    expect(activation.severity).toBe("sev1");
    // A platform row is not writable on the tenant credential (0116 splits the policies BY COMMAND).
    expect(activation.usedPlatformCredential).toBe(true);
    expect(activation.row).toMatchObject({
      organizationId: null,
      active: true,
      reason: "sev1_hallucination",
      activationActorKind: "ai_safety_owner",
      activationActorMembershipId: SAFETY_OWNER,
      activatedAt: T0,
    });

    // W3.5 — D16's demotion is PLANNED here and walked by the worker; activating inline would make a
    // slow lifecycle write hold up the stop.
    expect(activation.demotion).toMatchObject({ required: true, toState: "DEPRECATED" });

    // W3.7 — and the gate reads it on the very next call, with no cache to prime.
    const blocked = await invokeAsNurse(p);
    expect(blocked.available).toBe(false);
    if (blocked.available) return;
    expect(blocked.unavailable.reason).toBe("kill_switch_active");
    expect(blocked.gate).toBe("kill_switch");
    expect(p.cloudComplete).toHaveBeenCalledTimes(1); // the pre-switch call, and nothing since.

    // W3.2/W3.4 — the outbox name and the alert type both exist, and the alert is one a tenant may NOT
    // silence: an agency under cost pressure has an obvious motive to mute exactly this one.
    expect(OUTBOX_NAMES).toContain("m32.kill_switch.activated");
    expect(M32_ALERT_TYPES).toContain("ai.kill_switch_activated");
    expect(isAiAlertSuppressible("ai.kill_switch_activated")).toBe(false);
  });

  it("does not let a tenant lift a platform SEV-1 by deactivating its own row (the disjunction)", async () => {
    const p = platform();
    await activateAiKillSwitch(p.safetyDeps, {
      organizationId: null,
      capabilityId: CAP_ID,
      reason: "sev1_hallucination",
      actorKind: "ai_safety_owner",
      actorMembershipId: SAFETY_OWNER,
      activationMessage: "platform stop",
    });
    // The tenant independently pauses and then un-pauses its own row. Under a "most specific row wins"
    // reading the un-pause would resume dispatching a capability the AI Safety Owner stopped.
    await activateAiKillSwitch(p.safetyDeps, {
      organizationId: ORG,
      capabilityId: CAP_ID,
      reason: "manual_safety_pause",
      actorKind: "incident_commander",
      actorMembershipId: ADMIN,
      activationMessage: "our own caution while we review",
    });
    await deactivateAiKillSwitch(p.safetyDeps, {
      organizationId: ORG,
      capabilityId: CAP_ID,
      actorKind: "incident_commander",
      actorMembershipId: ADMIN,
      resolutionNarrative: "our review found nothing; resuming locally",
    });

    const stillBlocked = await invokeAsNurse(p);
    expect(stillBlocked.available).toBe(false);
    if (stillBlocked.available) return;
    expect(stillBlocked.unavailable.reason).toBe("kill_switch_active");
  });
});

// ── W4 ────────────────────────────────────────────────────────────────────────────────────────────

describe("W4 — tenant opt-in workflow (§7.W4)", () => {
  it("turns the SDK gate from refusing to passing, and freezes the evidence it was decided on", async () => {
    // No opt-in row at all — the state a tenant admin opening the board for the first time is in.
    const p = platform({ optIns: [] });

    const before = await invokeAsNurse(p);
    expect(before.available).toBe(false);
    if (before.available) return;
    expect(before.unavailable.reason).toBe("tenant_not_opted_in");
    expect(p.cloudComplete).not.toHaveBeenCalled();

    // W4.2 — the four acknowledgments, validated server-side against the evidence resolver.
    const optIn = await recordAiTenantOptIn(p.governanceDeps, {
      organizationId: ORG,
      capabilityId: CAP_ID,
      orgAdminMembershipId: ADMIN,
      routingMode: "default",
      pilotEnrollment: false,
      orgRoutingPreference: "prefer_cloud",
      acknowledgments: {
        baaReference: "BAA-2026-014",
        zdrContractReference: "ZDR-ANTHROPIC-88",
        clinicalReviewerMembershipId: "mem-reviewer",
        clinicalReviewerAttestationText: "reviewed; appropriate for our population",
        disclosureAccountingAcknowledged: true,
        calibrationTradeOffAcknowledged: null,
      },
    });
    expect(optIn.status).toBe("active");
    expect(optIn.optedInAt).toBe(T0);
    // W4.2's frozen evidence: the routing posture IN FORCE at the moment of the decision, not today's.
    expect(optIn.routingPreferenceSnapshot).toBe("prefer_cloud");

    // W4.4 — the gate begins passing for the org, with no restart and no cache invalidation.
    const after = await invokeAsNurse(p);
    expect(after.available).toBe(true);
    expect(p.cloudComplete).toHaveBeenCalledTimes(1);

    // W4.3 — the event M35 meters from.
    expect(OUTBOX_NAMES).toContain("m32.tenant_opt_in.recorded");
  });

  it("leaves a clinician who opted out refused inside a tenant that opted IN (§5.4)", async () => {
    const p = platform();
    await recordAiClinicianOptOut(p.governanceDeps, {
      organizationId: ORG,
      membershipId: NURSE,
      capabilityId: CAP_ID,
      reason: "I want my notes to be mine",
    });

    const outcome = await invokeAsNurse(p);
    expect(outcome.available).toBe(false);
    if (outcome.available) return;
    expect(outcome.unavailable.reason).toBe("clinician_opted_out");
    expect(p.cloudComplete).not.toHaveBeenCalled();
    expect(OUTBOX_NAMES).toContain("m32.clinician_opt_out.recorded");
  });
});

// ── W5 ────────────────────────────────────────────────────────────────────────────────────────────

describe("W5 — hallucination report → triage → capability deprecation (§7.W5)", () => {
  it("walks D9's machine and ends with the capability stopped for everyone", async () => {
    const p = platform();

    // W5.1 — the narrative arrives ALREADY encrypted; the filing rule never sees plaintext.
    const filed = await fileAiHallucinationReport(p.safetyDeps, {
      organizationId: ORG,
      providerEntityId: PROVIDER_ENTITY,
      locationId: null,
      invocationId: "ainv-000001",
      capabilityId: CAP_ID,
      reporterMembershipId: NURSE,
      reporterRole: "registered_nurse",
      severity: "high",
      hallucinationKind: "wrong_dose",
      reporterNarrativeCipher: new Uint8Array([9, 9, 9]),
    });
    expect(filed.report.triageStatus).toBe("open");
    // A `high` report does not itself trip D16 — only `critical` short-circuits. The follow-up comes
    // from the TRIAGED disposition, which is the point of having a triage step at all.
    expect(filed.followUp).toMatchObject({ action: "none", killSwitchReason: null });
    expect(OUTBOX_NAMES).toContain("m32.hallucination_report.filed");

    // W5.4/W5.5 — the owner picks it up and walks open → investigating → root_cause_identified.
    await triageAiHallucinationReport(p.safetyDeps, ORG, filed.report.id, {
      toStatus: "investigating",
      triageOwnerMembershipId: SAFETY_OWNER,
      disposition: null,
      mitigationActionRef: null,
      severity: "high",
    });
    const triaged = await triageAiHallucinationReport(p.safetyDeps, ORG, filed.report.id, {
      toStatus: "root_cause_identified",
      triageOwnerMembershipId: SAFETY_OWNER,
      disposition: "model_rollback_required",
      mitigationActionRef: "INC-2026-0042",
      severity: "high",
    });
    expect(triaged.report.triageStatus).toBe("root_cause_identified");
    expect(triaged.report.triagedAt).toBe(T0);
    // W5.6 — the follow-up the disposition implies, computed by the rule and carried on the outcome.
    expect(triaged.followUp).toMatchObject({
      action: "deprecate_capability",
      // NOT sev1: the report was not critical, and paging as one is how a SEV-1 page stops meaning
      // anything.
      killSwitchReason: "sev2_hallucination",
      demotesCapability: true,
    });
    expect(OUTBOX_NAMES).toContain("m32.hallucination_report.triaged");

    // W5.7 — the queue worker executes the plan: a PLATFORM kill, attributed to the automation rather
    // than to the human who triaged the report.
    const executed = await executeAiHallucinationFollowUp(p.safetyDeps, triaged.followUp, CAP_ID);
    expect(executed.killSwitch?.scope).toBe("platform");
    expect(executed.killSwitch?.row.activationActorKind).toBe("automated_lifecycle_demotion");
    expect(executed.killSwitch?.row.activationActorMembershipId).toBeNull();
    expect(executed.demotion).toMatchObject({ required: true, toState: "DEPRECATED" });

    // …and the demotion is WALKED by the route that has a signer to name (the worker returns a plan).
    const demoted = await transitionAiCapability(p.governanceDeps, {
      capabilityId: CAP_ID,
      toState: "DEPRECATED",
      approvalKind: "incident_demotion",
      actorMembershipId: SAFETY_OWNER,
      actorRole: "ai_safety_owner",
      rationaleText: "auto-deprecate following hallucination triage INC-2026-0042",
      linkedEvaluationRunId: null,
    });
    expect(demoted.lifecycleState).toBe("DEPRECATED");

    // W5.8 — every subsequent invocation is stopped. The kill switch decides FIRST (§6.2 puts it above
    // the lifecycle gate), so the reason names the switch even though the capability is also demoted.
    const blocked = await invokeAsNurse(p);
    expect(blocked.available).toBe(false);
    if (blocked.available) return;
    expect(blocked.unavailable.reason).toBe("kill_switch_active");
    expect(p.cloudComplete).not.toHaveBeenCalled();
    expect(OUTBOX_NAMES).toContain("m32.capability.transitioned");
  });

  it("does not fail the follow-up job when a prior incident already stopped the capability", async () => {
    const p = platform();
    await activateAiKillSwitch(p.safetyDeps, {
      organizationId: null,
      capabilityId: CAP_ID,
      reason: "sev1_hallucination",
      actorKind: "ai_safety_owner",
      actorMembershipId: SAFETY_OWNER,
      activationMessage: "first incident",
    });
    // `evaluateAiKillSwitchActivation` refuses a second activation so the first incident's attribution
    // survives — correct for R7, and a retry loop for a worker if it were not handled here.
    const executed = await executeAiHallucinationFollowUp(
      p.safetyDeps,
      {
        action: "deprecate_capability",
        killSwitchReason: "sev2_hallucination",
        demotesCapability: true,
      },
      CAP_ID,
    );
    expect(executed.killSwitchAlreadyActive).toBe(true);
    expect(executed.killSwitch).toBeNull();
    // The demotion is still REPORTED: this may be the first report that finds it demotable.
    expect(executed.demotion).toMatchObject({ required: true, toState: "DEPRECATED" });
  });
});

// ── W6 ────────────────────────────────────────────────────────────────────────────────────────────

describe("W6 — evaluation run → calibration promotion → prompt activation (§7.W6)", () => {
  it("carries the run through to a new active template the registry serves", async () => {
    const v2Ref = "packages/prompts/templates/hearthnote_layer2/v2.md";
    const p = platform({
      artifacts: {
        "packages/prompts/templates/hearthnote_layer2/v1.md": { body: "v1", contentHash: HASH_V1 },
        [v2Ref]: { body: "v2 body", contentHash: HASH_V2 },
      },
    });

    // W6.1 — the run is inserted `pending`; §3.2.11 takes no status from the caller.
    const run = await queueAiEvaluationRun(p.safetyDeps, {
      capabilityId: CAP_ID,
      backendId: CLOUD_BACKEND.backendId,
      datasetVersionRef: "dvc://golden/hearthnote@v7",
      mlflowRunId: "mlflow-8821",
      stage: "reapproval",
      summaryMetrics: {},
      initiatedByMembershipId: SAFETY_OWNER,
    });
    expect(run.status).toBe("pending");
    expect(run.decision).toBe("no_decision");

    // W6.3 — the worker moves it, and the ruling is recorded explicitly.
    await transitionAiEvaluationRun(p.safetyDeps, run.id, {
      toStatus: "in_progress",
      // `no_decision` on every non-terminal move: a run that has not finished has not ruled.
      decision: "no_decision",
      summaryMetrics: null,
    });
    const completed = await transitionAiEvaluationRun(p.safetyDeps, run.id, {
      toStatus: "passed",
      decision: "approve_for_ga",
      summaryMetrics: { faithfulness: 0.94, hallucination_rate: 0.004 },
    });
    expect(completed.status).toBe("passed");
    expect(completed.decision).toBe("approve_for_ga");
    expect(completed.summaryMetrics).toMatchObject({ faithfulness: 0.94 });
    expect(OUTBOX_NAMES).toContain("m32.evaluation.completed");

    // W6.6 — the calibration publication: supersede the incumbent and insert the new current row, in
    // one store call, keyed on (capability, BACKEND).
    const first = await publishAiCapabilityCalibration(p.governanceDeps, {
      capabilityId: CAP_ID,
      backendKey: CLOUD_KEY,
      thresholds: { minFaithfulness: 0.9 },
      baselineMetrics: { faithfulness: 0.92 },
      baselineSetAt: T0,
      baselineEvaluationRunId: run.id,
      supersededReason: null,
    });
    expect(first.isCurrent).toBe(true);
    const second = await publishAiCapabilityCalibration(p.governanceDeps, {
      capabilityId: CAP_ID,
      backendKey: CLOUD_KEY,
      thresholds: { minFaithfulness: 0.93 },
      baselineMetrics: { faithfulness: 0.94 },
      baselineSetAt: T0,
      baselineEvaluationRunId: run.id,
      supersededReason: "re-baselined on mlflow-8821",
    });
    expect(second.isCurrent).toBe(true);
    // Exactly ONE current row per (capability, backend) — the partial unique index, held by the store.
    const current = p.governance.calibrations.filter(
      (c) => c.isCurrent && c.backendKey === CLOUD_KEY,
    );
    expect(current).toHaveLength(1);
    expect(current[0]!.id).toBe(second.id);
    expect(OUTBOX_NAMES).toContain("m32.capability.calibrated");

    // W6.8 — R30 is INSERT-AND-DEPRECATE, not a status flip: the incumbent walks active → deprecated
    // and a NEW row arrives active.
    const activated = await activateAiPromptTemplate(
      {
        store: p.prompts,
        artifacts: {
          read: async (ref) => (ref === v2Ref ? { body: "v2 body", contentHash: HASH_V2 } : null),
        },
        registry: p.promptRegistry,
        now: () => T0,
      },
      {
        capabilityKey: "hearthnote_layer2",
        templateKey: "hearthnote_enhancement_v2",
        version: 2,
        templateFilesystemRef: v2Ref,
        templateContentHash: HASH_V2,
        compatibleBackendKeys: [CLOUD_KEY, LOCAL_KEY],
        inputSchemaRef: "hearthnote_layer2.input.v2",
        outputSchemaRef: "hearthnote_layer2.output.v2",
        outputEntityTargetPrefix: "encounter_narrative",
        outputTypePrefix: "narrative_text",
        createdByMembershipId: SAFETY_OWNER,
        approvedByMembershipId: SAFETY_OWNER,
        clinicalReviewerAttestation: "re-reviewed on the v7 golden set",
      },
    );
    expect(activated.status).toBe("active");
    expect(p.prompts.rows.find((r) => r.version === 1)!.status).toBe("deprecated");

    // …and the registry serves the NEW body, because the activation invalidated the cache. A registry
    // that kept serving v1 here is exactly the W6.8 defect no per-layer test can see.
    const served = await p.promptRegistry.getActivePromptForCapability("hearthnote_layer2");
    expect(served?.version).toBe(2);
    expect(served?.promptBody).toBe("v2 body");
    expect(OUTBOX_NAMES).toContain("m32.prompt_template.activated");

    // W6.9 — the boot validator agrees on the next restart: both artifacts resolve to their pins.
    const validators = createAiBootValidators({
      capabilities: p.governance.registry,
      backends: p.invocation.backends,
      prompts: p.prompts,
      promptRegistry: p.promptRegistry,
      artifacts: {
        read: async (ref) => (ref === v2Ref ? { body: "v2 body", contentHash: HASH_V2 } : null),
      },
    });
    await expect(
      validators.validateAllActivePromptsResolveToGitArtifacts(),
    ).resolves.toBeUndefined();
  });
});

// ── W7 (PARTIAL — see the file header) ────────────────────────────────────────────────────────────

describe("W7 — drift detection → alert → triage (§7.W7, PARTIAL in Phase 1)", () => {
  it("expresses the red-tier AUTO-kill: a monitor may stop a capability with no human in the loop", async () => {
    const p = platform();
    // W7.3 — the sweep raises the switch itself. `automated_drift_monitor` carries NO membership id:
    // §3.2.12 refuses a machine trip wearing a person's name, and the whole point of AI-025 is that this
    // is a mandatory gate rather than human discretion.
    const activation = await activateAiKillSwitch(p.safetyDeps, {
      organizationId: null,
      capabilityId: CAP_ID,
      reason: "bias_drift_severe",
      actorKind: "automated_drift_monitor",
      actorMembershipId: null,
      activationMessage: null,
    });
    expect(activation.scope).toBe("platform");
    // W7.3 — and it is a SEV-1, which `bias_drift_severe` is in the reason table for exactly this reason.
    expect(activation.severity).toBe("sev1");

    // W7.7 — the burden is to RE-ENABLE. The switch is already on when the owner starts investigating.
    const blocked = await invokeAsNurse(p);
    expect(blocked.available).toBe(false);
    if (blocked.available) return;
    expect(blocked.unavailable.reason).toBe("kill_switch_active");

    // W7.4/W7.5 — both the event and the alert exist, and the alert carries the TIER, so a dashboard
    // and the switch that already fired cannot disagree about what happened.
    expect(OUTBOX_NAMES).toContain("m32.drift.detected");
    await emitAiAlert(
      {
        alertType: "ai.drift_threshold_breached",
        capabilityId: CAP_ID,
        capabilityKey: "hearthnote_layer2",
        organizationId: null,
        metric: "output_length_p50",
        observedValue: 148,
        baselineValue: 110,
        deltaPercent: 34.5,
        severityTier: "red",
        suggestedAction: "capability killed automatically; investigate before lifting",
      },
      p.alertPort,
    );
    expect(p.alerts).toEqual([{ eventType: "ai.drift_threshold_breached", organizationId: null }]);
  });

  it("STATES the Phase-1 gap: W7.2's `ai_drift_event` evidence table is not an M32 owned table", () => {
    // The kill and the alert above are expressible today; the EVIDENCE ROW behind them is not. §7.W7.2
    // (spec remediation M32-F10) requires a real `ai_drift_event` table "not undefined JSONB", and the
    // Wave H plan's thirteen `ownedTables` do not include it — so a drift sweep in Phase 1 could raise
    // the switch but could not record the metric that justified it, and no `ai:drift-sweeps` worker is
    // built in this wave. This assertion fails the day the table is added, which is the day this
    // workflow becomes walkable end to end.
    const owned = MODULES.find((m) => m.id === 32)!.ownedTables;
    expect(owned).toHaveLength(13);
    expect(owned).not.toContain("ai_drift_event");
  });
});

// ── W8 ────────────────────────────────────────────────────────────────────────────────────────────

describe("W8 — local-only routing override (§7.W8)", () => {
  it("routes to the local backend and never contacts the cloud one", async () => {
    const p = platform({ optIns: [activeOptIn({ routingPreferenceSnapshot: "local_only" })] });
    const outcome = await invokeAsNurse(p);

    expect(outcome.available).toBe(true);
    if (!outcome.available) return;
    // W8.3/W8.4 — the local backend served and the invocation row names it.
    expect(outcome.route.backendKey).toBe(LOCAL_KEY);
    expect(p.localComplete).toHaveBeenCalledTimes(1);
    expect(p.cloudComplete).not.toHaveBeenCalled();
    expect(p.invocation.invocationRows[0]).toMatchObject({
      backendKey: LOCAL_KEY,
      backendId: LOCAL_BACKEND.backendId,
      // A local inference is not a disclosure to a vendor, so there is no ZDR claim to make.
      zdrConfirmed: false,
    });
  });

  it("refuses rather than falling back to cloud when the local backend is unhealthy", async () => {
    // W8.3's explicit test: "mocks Ollama as unhealthy and asserts the SDK returns unavailable rather
    // than reaching the Anthropic API". Data residency is not a preference that degrades.
    const p = platform({
      optIns: [activeOptIn({ routingPreferenceSnapshot: "local_only" })],
      localHealthy: false,
    });
    const outcome = await invokeAsNurse(p);

    expect(outcome.available).toBe(false);
    if (outcome.available) return;
    expect(outcome.unavailable.reason).toBe("backend_unhealthy");
    expect(p.cloudComplete).not.toHaveBeenCalled();
    expect(p.localComplete).not.toHaveBeenCalled();
  });

  it("W8.2 — refuses a local_only opt-in for a capability with no local backend in its allowed list", async () => {
    const cloudOnlyCapability: AiCapabilityGovernanceRow = {
      ...HEARTHNOTE,
      allowedBackendKeys: [CLOUD_KEY],
    };
    const p = platform({ capabilities: [cloudOnlyCapability], optIns: [] });
    await expect(
      recordAiTenantOptIn(p.governanceDeps, {
        organizationId: ORG,
        capabilityId: CAP_ID,
        orgAdminMembershipId: ADMIN,
        routingMode: "local_only",
        pilotEnrollment: false,
        orgRoutingPreference: "prefer_cloud",
        acknowledgments: {
          baaReference: "BAA-2026-014",
          zdrContractReference: "ZDR-ANTHROPIC-88",
          clinicalReviewerMembershipId: "mem-reviewer",
          clinicalReviewerAttestationText: "reviewed",
          disclosureAccountingAcknowledged: true,
          calibrationTradeOffAcknowledged: "we accept the smaller model's lower faithfulness",
        },
      }),
    ).rejects.toThrow(/AI_OPT_IN_ROUTING_MODE_UNSUPPORTED|local/i);
    expect(p.governance.optIns).toHaveLength(0);
  });
});

// ── W9 ────────────────────────────────────────────────────────────────────────────────────────────

describe("W9 — a Phase-1 deny-stub returns `unavailable` (§7.W9)", () => {
  it("refuses a below-APPROVED capability through the seam, records the row, and pages nobody", async () => {
    const p = platform({ capabilities: [HEARTHNOTE, DOCLENS_EXTRACT] });
    const actors: AiSeamActorResolver = {
      resolve: async () => ({
        actorMembershipId: NURSE,
        actorRole: "registered_nurse",
        providerEntityId: PROVIDER_ENTITY,
        locationId: null,
      }),
    };
    const extractor = createDocLensExtractor({
      pipeline: p.pipeline,
      actors,
      now: () => new Date(T0),
    });

    const result = await extractor.extract({
      organizationId: ORG,
      actorUserId: "user-1",
      documentId: "doc-1",
      documentType: "face_sheet",
      schemaKey: "intake.face_sheet.v1",
      extractedText: "…",
      pageCount: 2,
    });

    // W9.1/W9.2 — gate 1 refuses, and absence reaches M22 as a VALUE it can branch on.
    expect(result.available).toBe(false);
    if (result.available) return;
    expect(result.unavailable.reason).toBe("lifecycle_state_below_approved");
    expect(p.cloudComplete).not.toHaveBeenCalled();
    expect(p.localComplete).not.toHaveBeenCalled();

    // W9.3 — the refusal is recorded: "no PHI went to a vendor" has to be provable.
    expect(p.invocation.invocationRows).toHaveLength(1);
    expect(p.invocation.invocationRows[0]).toMatchObject({
      capabilityKey: "doclens_extract",
      status: "capability_unavailable",
      errorClass: "lifecycle_state_below_approved",
    });

    // W9.5 — no alert. §4.9 declares no alert type for an expected deny-stub refusal, and inventing one
    // would page an operator every time a Phase-1 consumer asks a Phase-2 question.
    expect(M32_ALERT_TYPES.filter((t) => t.includes("unavailable") || t.includes("deny"))).toEqual(
      [],
    );
  });

  it("answers an UNKNOWN capability key as retired, so the registry cannot be enumerated by probing", async () => {
    const p = platform();
    const outcome = await invokeAsNurse(p, "capability_that_does_not_exist");
    expect(outcome.available).toBe(false);
    if (outcome.available) return;
    expect(outcome.unavailable.reason).toBe("lifecycle_state_retired");
    // No capability id exists, so no row can: `ai_invocation.capability_id` is NOT NULL with a real FK.
    expect(outcome.ledgerRecorded).toBe(false);
    expect(p.invocation.invocationRows).toHaveLength(0);
  });
});

// ── W10 (PARTIAL — see the file header) ───────────────────────────────────────────────────────────

describe("W10 — AI-prohibited-zone violation detected at boot (§7.W10, PARTIAL in Phase 1)", () => {
  const contraband = template({
    id: "apt-contraband",
    templateKey: "med_reconcile_v1",
    capabilityKey: "medication_reconciliation",
    version: 1,
    outputEntityTargetPrefix: "medication_order",
    outputTypePrefix: "structured_extraction",
  });

  it("surfaces the contraband to M12's own boot query (W10.2)", async () => {
    const p = platform({ templates: [template(), contraband] });
    // The §4.5 pattern each protected module runs at its own boot. One entry ⇒ M12 throws BootError.
    const hits = await p.promptRegistry.getActivePromptsTargeting("medication_");
    expect(hits.map((h) => h.templateKey)).toEqual(["med_reconcile_v1"]);
  });

  it("evaluates the §4.7 `ai_prohibited_zone_respected` predicate to FALSE (W10.4)", async () => {
    const p = platform({ templates: [template(), contraband] });
    const resolver: AiPlatformAbacResolver = {
      roleKeysOf: async () => null,
      resolveCapabilityId: async () => null,
      loadTenantOptIn: async () => null,
      clinicianOptedOut: async () => null,
      killSwitchActive: async () => null,
      loadInvocation: async () => null,
      activePromptsTargeting: (prefix) => p.promptRegistry.getActivePromptsTargeting(prefix),
    };
    const predicates = buildAiPlatformAbacPredicates({ resolver });
    await expect(
      predicates.ai_prohibited_zone_respected({ roles: [], organizationId: ORG } as never, {
        consumerModulePrefix: "medication_",
      }),
    ).resolves.toBe(false);
    // The clean zone still answers true — otherwise the predicate would deny universally and prove
    // nothing.
    await expect(
      predicates.ai_prohibited_zone_respected({ roles: [], organizationId: ORG } as never, {
        consumerModulePrefix: "evv_",
      }),
    ).resolves.toBe(true);
  });

  it("DEVIATES from W10.1: M32's own boot refuses too, rather than completing (T06 / §8.5 leg 1)", async () => {
    // §7.W10.1 says "M32 boot completes; M32's own validators do not enforce other modules' prohibited
    // zones". §8.5 leg 1 says the boot-time registry query is one of three independent layers, and
    // M32-T06 chose the producer-side check deliberately: the six consumer validators only fire in a
    // boot that MOUNTS those six modules, so a worker sidecar or a tenant without prescribing would run
    // zero of them while the contraband template stayed active. The architecture-wins rule (§8.5 over
    // §7) is why this test asserts the stricter behaviour rather than the spec's literal text.
    const p = platform({ templates: [template(), contraband] });
    const validators = createAiBootValidators({
      capabilities: p.governance.registry,
      backends: p.invocation.backends,
      prompts: p.prompts,
      promptRegistry: p.promptRegistry,
    });
    await expect(validators.validateAiProhibitedZoneRegistry()).rejects.toThrow(
      /AI_PROHIBITED_ZONE_VIOLATION/,
    );

    // W10.5 — the operator's fix is to retire the template. With it deprecated, boot passes again.
    const cleaned = platform({ templates: [template(), { ...contraband, status: "deprecated" }] });
    const after = createAiBootValidators({
      capabilities: cleaned.governance.registry,
      backends: cleaned.invocation.backends,
      prompts: cleaned.prompts,
      promptRegistry: cleaned.promptRegistry,
    });
    await expect(after.validateAiProhibitedZoneRegistry()).resolves.toBeUndefined();
  });
});

// ── the §8.2 in-process half of cross-tenant isolation ────────────────────────────────────────────

describe("§8.2.2 — in-process scope tagging (the half RLS cannot enforce)", () => {
  it("carries the caller's org into every write, so one tenant's spend is never another's", async () => {
    const p = platform({
      optIns: [activeOptIn(), activeOptIn({ id: "optin-other", organizationId: OTHER_ORG })],
    });
    await invokeAsNurse(p);

    // Every row the call wrote names ORG and nothing else. §8.2's point 2: the tenant tag rides the
    // invocation into the ledger and the accrual, so a cap evaluated for OTHER_ORG cannot see it.
    expect(p.invocation.invocationRows.map((r) => r.organizationId)).toEqual([ORG]);
    expect(p.invocation.accrualRows.map((r) => r.organizationId)).toEqual([ORG]);
    await expect(
      p.invocation.ledger.sumTokensInWindow(OTHER_ORG, CAP_ID, {
        start: "2026-08-01T00:00:00.000Z",
        end: "2026-09-01T00:00:00.000Z",
      }),
    ).resolves.toBe(0);
    await expect(
      p.invocation.ledger.sumTokensInWindow(ORG, CAP_ID, {
        start: "2026-08-01T00:00:00.000Z",
        end: "2026-09-01T00:00:00.000Z",
      }),
    ).resolves.toBe(165);
  });

  it("refuses a HITL write aimed at another tenant's invocation row", async () => {
    const p = platform();
    const outcome = await invokeAsNurse(p);
    expect(outcome.available).toBe(true);
    if (!outcome.available) return;
    // The store keys on (id, org, invokedAt) — the same triple RLS + the composite PK enforce in
    // Postgres, so a cross-tenant HITL write finds no row rather than silently updating one.
    await expect(
      p.pipeline.recordHitlOutcome(OTHER_ORG, outcome.invocationId, outcome.invokedAt, "accepted"),
    ).rejects.toThrow(/not found/);
    expect(p.invocation.invocationRows[0]!.hitlOutcome).toBe("pending");
  });
});
